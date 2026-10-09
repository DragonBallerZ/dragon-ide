/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { sentByChat } from '../chat/deliveries';
import { DragonChat, permissionMode, SessionRecord, TeamStarter } from '../chat/participant';
import { describePermission } from '../chat/toolPresentation';
import { TurnReducer } from '../chat/turn';
import { READ_ONLY_PERMISSIONS, sessionPermissions } from '../dragonConfig';
import { DRAGON_VENDOR } from '../models';
import { formatModelRef, OpenCodeClient, parseModelRef } from '../opencode/client';
import type { OpenCodeServer } from '../opencode/server';
import type { SessionBridge } from '../opencode/sessionBridge';
import type { ModelRef, OpenCodeEvent, PermissionDecision, PermissionRequest } from '../opencode/types';
import { AgentHub, agentName, AgentRecord, Delivery, HubError, HubHost, MessagingMode, TeamRecord } from './hub';
import { DeliveryGate } from './deliveryGate';
import { lastAssistantReply } from './message';
import { createAgentWorktree, listAgentWorktrees, mergeAgentWorktree } from './worktree';

/** How long a chat has to start the turn that delivers a message before the message goes in without it. */
const CHAT_DELIVERY_TIMEOUT = 10_000;
const SHOWN_MESSAGE_CHARS = 4000;
const TEAM_SIZES = [2, 3, 4, 6];
/** The most panes a team's layout gets; more teammates share them as tabs. */
const MAX_PANES = 6;
const NEXT_MODE: Record<MessagingMode, MessagingMode> = { off: 'on', on: 'muted', muted: 'off' };

/** What the composer's Messages chip shows for one chat. */
interface MessagingState {
	readonly mode: MessagingMode;
	readonly name?: string;
	readonly role?: string;
	readonly team?: string;
}

/**
 * Agents that message each other, in the IDE: it runs the agent hub, delivers messages into the
 * chats that show the agents, opens teammates as editor panes, and answers permission requests
 * for agents that are working with no chat turn to ask in.
 */
export class DragonAgents implements vscode.Disposable, TeamStarter {
	private readonly disposables: vscode.Disposable[] = [];
	readonly hub: AgentHub;
	/** One reducer per agent, to find the permission requests and forms of agents working outside a chat turn. */
	private readonly reducers = new Map<string, TurnReducer>();
	/** The sync running now: two agents asking at once must not each start a session for the same chat. */
	private syncing: Promise<void> | undefined;
	/** Holds a message to a chat starting a turn for an earlier one, which would otherwise not show it. */
	private readonly gate = new DeliveryGate(CHAT_DELIVERY_TIMEOUT);

	constructor(
		private readonly server: OpenCodeServer,
		bridge: SessionBridge,
		private readonly chat: DragonChat,
		private readonly context: vscode.ExtensionContext,
		private readonly log: vscode.LogOutputChannel,
		/** Where the hub's address and token are written for the OpenCode plugin (`DRAGON_AGENTS_HUB`). */
		readonly addressFile: string,
	) {
		const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
		const host: HubHost = {
			deliver: delivery => this.deliver(delivery),
			createTeammate: input => this.createTeammate(input.lead, input.name, input.agent),
			lastReply: async (sessionID, since) => lastAssistantReply(await (await this.server.ensure()).messages(sessionID), since),
			sync: () => this.syncing ??= this.syncOpenChats().finally(() => this.syncing = undefined),
		};
		this.hub = new AgentHub(host, path.join(storage, 'agents.json'));
		this.applyLimits();
		chat.hub = this.hub;
		chat.teams = this;
		this.disposables.push(
			bridge.subscribe(event => this.onEvent(event)),
			// An agent's name, messaging mode or team shows on its chat's Messages chip.
			this.hub.onDidChange(() => chat.refreshChips()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('dragon.agents')) {
					this.applyLimits();
				}
			}),
			vscode.commands.registerCommand('dragon.agents.messagingState', (args?: { sessionResource?: string }) => this.messagingState(args?.sessionResource)),
			vscode.commands.registerCommand('dragon.agents.cycleMessaging', (args?: { sessionResource?: string }) => this.cycleMessaging(args?.sessionResource)),
			vscode.commands.registerCommand('dragon.newTeam', () => this.newTeam()),
			// The chat's Lead a Team button: `/team` in its input, for the task and how many teammates.
			vscode.commands.registerCommand('dragon.leadTeam', () => vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent', query: '/team ', isPartialQuery: true })),
			vscode.commands.registerCommand('dragon.agents.directory', (args?: { sessionResource?: string }) => args?.sessionResource ? this.chat.recordFor(args.sessionResource)?.directory : undefined),
			// A chat editor's plus gives its editor's resource; the Chat view's has a command of its own,
			// as the extension host drops what the Chat view gives its buttons.
			vscode.commands.registerCommand('dragon.newAgent', async (editor?: unknown) => this.newAgent(editor instanceof vscode.Uri ? await vscode.commands.executeCommand<string | undefined>('_dragon.chat.editorSession', editor) : undefined)),
			vscode.commands.registerCommand('dragon.newAgentFromChatView', async () => this.newAgent(await vscode.commands.executeCommand<string | undefined>('_dragon.chat.viewSession'))),
			vscode.commands.registerCommand('dragon.agents.mergeWorktree', () => this.mergeWorktree()),
			vscode.commands.registerCommand('dragon.agents.stopAll', () => this.stopAll()),
		);
	}

	/** Loads the registry and starts the endpoint. Call before the OpenCode server starts. */
	async start(): Promise<void> {
		await this.hub.load();
		const url = await this.hub.listen(this.addressFile);
		this.log.info(`[agents] hub listening at ${url}`);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.chat.hub = undefined;
		this.chat.teams = undefined;
		this.hub.dispose();
		void vscode.workspace.fs.delete(vscode.Uri.file(this.addressFile)).then(undefined, () => undefined);
	}

	private applyLimits(): void {
		const config = vscode.workspace.getConfiguration('dragon.agents');
		this.hub.setLimits({ maxWakes: Math.max(1, config.get<number>('maxWakes', 25)), maxTeammates: Math.max(1, config.get<number>('maxTeammates', 16)) });
	}

	/**
	 * Puts a message in the recipient's inbox. A message that wakes an agent whose chat is open
	 * reaches it through that chat, so the chat shows the message and the agent's answer: through
	 * the turn showing the agent at work, if one is, else as a turn of its own, labelled with the
	 * sender, once the chat is free. Otherwise OpenCode takes it directly, and a running turn shows
	 * it when it arrives.
	 */
	private async deliver(delivery: Delivery): Promise<void> {
		const client = await this.server.ensure();
		const recipient = delivery.recipient.id;
		const send = () => client.synthetic(recipient, { text: delivery.text, description: delivery.description, metadata: delivery.metadata, resume: delivery.wake ? undefined : false });
		const route = `[agents] ${delivery.sender.name} > ${delivery.recipient.name}:`;
		// A turn the chat is starting for an earlier message shows the agent once it has sent that message.
		await this.gate.ready(recipient);
		const chatResource = delivery.wake ? this.chat.chatFor(recipient) : undefined;
		if (chatResource) {
			if (await this.chat.sendThroughTurn(recipient, send, CHAT_DELIVERY_TIMEOUT)) {
				this.log.debug(`${route} through the chat turn showing it`);
				return;
			}
			const pending = this.chat.queueDelivery(chatResource, { from: delivery.sender.name, text: delivery.body }, send);
			const started = this.gate.starts(recipient, pending.sent);
			const accepted = await vscode.commands.executeCommand<boolean>('_dragon.chat.sendSystemRequest', {
				sessionResource: chatResource,
				message: delivery.body,
				// Markdown: the sender, then the message quoted, in place of a message the user typed.
				label: `**${vscode.l10n.t('From {0}', delivery.sender.name)}**\n\n${quote(delivery.body)}`,
				agentId: 'dragon.agent',
				// A turn that just ended may still be finishing in the chat.
				waitMs: CHAT_DELIVERY_TIMEOUT,
			}).then(result => result === true, err => {
				this.log.warn(`[agents] the chat for ${delivery.recipient.name} refused the message: ${message(err)}`);
				return false;
			});
			if (await sentByChat(pending, accepted, CHAT_DELIVERY_TIMEOUT)) {
				this.log.debug(`${route} as a turn of its own in its chat`);
				return;
			}
			if (accepted) {
				this.log.warn(`[agents] the chat for ${delivery.recipient.name} did not send the message; delivering without it`);
			}
			started();
			// A turn the chat started meanwhile, for a message the user typed, shows the agent.
			if (await this.chat.sendThroughTurn(recipient, send, CHAT_DELIVERY_TIMEOUT)) {
				this.log.debug(`${route} through the chat turn showing it, which started meanwhile`);
				return;
			}
		}
		this.log.debug(`${route} directly${delivery.wake ? chatResource ? ', as its chat did not take it' : ', as it has no chat' : ', without waking it'}`);
		await send();
	}

	/** A teammate's OpenCode session, under the lead's model and permission ceiling, shown in its own editor. */
	private async createTeammate(lead: AgentRecord, name: string, agent: string | undefined): Promise<{ id: string; directory: string }> {
		const client = await this.server.ensure();
		const leadChat = this.chat.chatFor(lead.id);
		const leadRecord = leadChat ? this.chat.recordFor(leadChat) : undefined;
		const model = leadRecord?.model ? parseModelRef(leadRecord.model) : undefined;
		const runs = lead.readOnly ? 'plan' : agent === 'plan' ? 'plan' : 'build';
		const session = await client.createSession({ directory: lead.directory, title: name, agent: runs, model, permissions: sessionPermissions(!!lead.readOnly, true) });
		try {
			const team = this.hub.team(lead.team);
			const panes = team ? this.context.workspaceState.get<Record<string, number>>('dragon.teams.panes', {})[team.id] : undefined;
			// Teammates fill the panes the team was opened with, then share them as tabs.
			const group = panes ? 1 + (team!.members.length % panes) : undefined;
			const chatResource = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.openAgentEditor', { title: name, group, toSide: true, preserveFocus: true, model: pickerModel(model) });
			if (chatResource) {
				await this.chat.bindSession(chatResource, { id: session.id, directory: lead.directory, model: model && formatModelRef(model), agent: runs, readOnly: !!lead.readOnly });
			}
		} catch (err) {
			// The teammate still works without an editor; its report reaches the lead either way.
			this.log.warn(`[agents] could not open an editor for ${name}: ${message(err)}`);
		}
		return { id: session.id, directory: lead.directory };
	}

	private messagingState(chatResource: string | undefined): MessagingState | undefined {
		if (!chatResource) {
			return undefined;
		}
		const record = this.chat.recordFor(chatResource);
		const agent = record ? this.hub.get(record.id) : undefined;
		if (!agent) {
			return { mode: this.chat.pendingMessagingFor(chatResource) ?? 'on' };
		}
		// Off only by an earlier default: this open chat's agent is turned on when the hub next syncs.
		const mode = agent.messaging === 'off' && !agent.messagingChosen ? 'on' : agent.messaging;
		return { mode, name: agent.name, role: agent.role, team: this.hub.team(agent.team)?.name };
	}

	/** Off, on, muted, and off again. */
	private async cycleMessaging(chatResource: string | undefined): Promise<MessagingState | undefined> {
		if (!chatResource) {
			return undefined;
		}
		const next = NEXT_MODE[this.messagingState(chatResource)?.mode ?? 'off'];
		const record = this.chat.recordFor(chatResource);
		if (!record) {
			// No session until the first message: remember the choice for it.
			this.chat.setPendingMessaging(chatResource, next);
		} else if (this.hub.get(record.id)) {
			await this.hub.setMessaging(record.id, next);
		} else {
			await this.registerOlder(record, next, true);
		}
		return this.messagingState(chatResource);
	}

	/** Registers a session from before agents had a registry, named after its OpenCode title. */
	private async registerOlder(record: SessionRecord, messaging: MessagingMode, messagingChosen: boolean): Promise<void> {
		const title = await this.server.ensure().then(client => client.session(record.id)).then(session => session.title, () => undefined);
		await this.hub.register(record.id, { name: title, directory: record.directory, readOnly: record.readOnly, messaging, messagingChosen });
	}

	/**
	 * Tells the hub which chats are open in this window, so agents are told about them and may
	 * message them. A chat the user opened and has not typed in is given its session now.
	 */
	private async syncOpenChats(): Promise<void> {
		const chats = await vscode.commands.executeCommand<string[] | undefined>('_dragon.chat.openChats') ?? [];
		const open: string[] = [];
		for (const chat of chats) {
			const record = this.chat.recordFor(chat) ?? await this.adopt(chat).catch(err => {
				this.log.warn(`[agents] no session for the open chat ${chat}: ${message(err)}`);
				return undefined;
			});
			// A merged agent's worktree is gone, and the agent with it.
			if (!record || !fs.existsSync(record.directory)) {
				continue;
			}
			if (!this.hub.get(record.id)) {
				await this.registerOlder(record, 'on', false);
			}
			open.push(record.id);
		}
		await this.hub.setOpen(open);
	}

	/**
	 * Gives a chat the user opened and has not typed in an OpenCode session, as `/team` gives a
	 * teammate's, so other agents can message it, and names its tab after its agent. None when the
	 * user turned its messaging off.
	 */
	private async adopt(chat: string): Promise<SessionRecord | undefined> {
		const chosen = this.chat.pendingMessagingFor(chat);
		if (chosen === 'off') {
			return undefined;
		}
		const client = await this.server.ensure();
		const directory = DragonChat.directory();
		const { readOnly, model, agent } = sessionDefaults(this.chat.lastPickedModel());
		const session = await client.createSession({ directory, title: vscode.l10n.t('agent'), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });
		const typed = this.chat.recordFor(chat);
		if (typed) {
			// The user's first message got there first and made the chat a session of its own.
			return typed;
		}
		const record: SessionRecord = { id: session.id, directory, model: model && formatModelRef(model), agent, readOnly };
		await this.chat.bindSession(chat, record);
		const registered = await this.hub.register(session.id, { name: await this.chat.agentNameFor(chat, 'agent'), directory, readOnly, messaging: chosen ?? 'on', messagingChosen: chosen !== undefined });
		await vscode.commands.executeCommand('_dragon.chat.setTitle', chat, registered.name);
		return record;
	}

	/** Dragon: New Team. Opens the lead's chat beside a grid of panes its teammates will open in. */
	private async newTeam(): Promise<void> {
		const picked = await vscode.window.showQuickPick(TEAM_SIZES.map(size => ({ label: vscode.l10n.t('{0} teammate panes', size), size })), {
			title: vscode.l10n.t('New Team'),
			placeHolder: vscode.l10n.t('How many teammates should be visible at once? The lead can start more; they share the panes as tabs.'),
		});
		if (!picked) {
			return;
		}
		const name = await vscode.window.showInputBox({ title: vscode.l10n.t('New Team'), prompt: vscode.l10n.t('A name for the team'), value: 'team' });
		if (name === undefined) {
			return;
		}
		const client = await this.server.ensure();
		const directory = DragonChat.directory();
		const { readOnly, model, agent } = sessionDefaults(this.chat.lastPickedModel());
		const session = await client.createSession({ directory, title: vscode.l10n.t('Lead of {0}', name || 'team'), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });

		await vscode.commands.executeCommand('vscode.setEditorLayout', teamLayout(picked.size));
		const chatResource = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.openAgentEditor', { title: vscode.l10n.t('Lead: {0}', name || 'team'), group: 0, model: pickerModel(model) });
		if (!chatResource) {
			throw new Error(vscode.l10n.t('The lead\'s chat could not be opened.'));
		}
		await this.chat.bindSession(chatResource, { id: session.id, directory, model: model && formatModelRef(model), agent, readOnly });
		await this.hub.register(session.id, { name: 'lead', directory, readOnly, messaging: 'on' });
		const team = await this.hub.createTeam(session.id, name);
		await this.context.workspaceState.update('dragon.teams.panes', { ...this.context.workspaceState.get<Record<string, number>>('dragon.teams.panes', {}), [team.id]: picked.size });
		// Kept in the lead's inbox until the user's first message, which it then reads first.
		await client.synthetic(session.id, {
			text: `You are "${this.hub.get(session.id)?.name ?? 'lead'}", the lead of the team "${team.name}". For work that splits into independent parts, start teammates with spawn_teammate, one self-contained task each, and tell each which files are its to change. Their reports arrive as messages; use wait_agent when you have nothing else to do. Do small tasks yourself.`,
			description: vscode.l10n.t('Team {0}', team.name),
			metadata: { source: 'dragon.team' },
			resume: false,
		});
	}

	/**
	 * `/team`: makes a chat's agent the lead of a team named after its folder, and starts `size`
	 * teammates in panes beside it, on its model and in its folder. They are idle until the lead
	 * sends them work. A chat that already leads a team gets more teammates.
	 */
	async startTeam(sessionResource: string, size: number): Promise<{ team: string; teammates: string[] }> {
		const { lead, team } = await this.lead(sessionResource, size);
		const teammates: string[] = [];
		while (teammates.length < size) {
			teammates.push((await this.hub.addTeammate(lead, this.nextTeammateName())).name);
		}
		return { team: team.name, teammates };
	}

	/** The first `teammate-N` no agent has. */
	private nextTeammateName(): string {
		let i = 1;
		while (this.hub.nameTaken(`teammate-${i}`)) {
			i++;
		}
		return `teammate-${i}`;
	}

	/**
	 * `/create-agent`: adds a teammate named after `role` to the team a chat's agent leads, making it
	 * the lead first if it leads none. The teammate and its team are told `purpose` with every request.
	 */
	async createAgent(sessionResource: string, role: string, purpose: string): Promise<{ team: string; teammate: string }> {
		// Checked before the chat becomes a lead, which a refusal would leave it.
		if (!agentName(role)) {
			throw new HubError(vscode.l10n.t('Name the role with letters or digits, for example "artist".'));
		}
		const { lead, team } = await this.lead(sessionResource, 1);
		return { team: team.name, teammate: (await this.hub.addRole(lead, role, purpose)).name };
	}

	/**
	 * Makes a chat's agent the lead of a team named after its folder, unless it leads one already,
	 * and lays out panes for `adding` more teammates beside it.
	 */
	private async lead(sessionResource: string, adding: number): Promise<{ lead: string; team: TeamRecord }> {
		const record = this.chat.recordFor(sessionResource);
		if (!record) {
			throw new Error(vscode.l10n.t('This chat has no OpenCode session yet.'));
		}
		let team = this.hub.team(this.hub.get(record.id)?.team);
		if (team && team.lead !== record.id) {
			throw new HubError(vscode.l10n.t('This agent is a teammate on the team "{0}", so it cannot lead one.', team.name));
		}
		if (!team) {
			await this.hub.register(record.id, { name: 'lead', directory: record.directory, readOnly: record.readOnly, messaging: 'on' });
			team = await this.hub.createTeam(record.id, path.basename(record.directory) || 'team');
		}
		await this.layOutPanes(team, adding);
		return { lead: record.id, team };
	}

	/** Lays out panes beside the lead for the team's teammates and `adding` more. */
	private async layOutPanes(team: TeamRecord, adding: number): Promise<void> {
		const panes = Math.min(team.members.length + adding, MAX_PANES);
		await vscode.commands.executeCommand('vscode.setEditorLayout', teamLayout(panes));
		await this.context.workspaceState.update('dragon.teams.panes', { ...this.context.workspaceState.get<Record<string, number>>('dragon.teams.panes', {}), [team.id]: panes });
	}

	/**
	 * Dragon: New Agent. Opens a chat for a new agent with messaging on. From the title of a `chat`
	 * whose agent is on a team, the new agent joins that team as one of its lead's teammates, in the
	 * team's folder and on the lead's model, as `/team` starts them. Otherwise, in a Git repository,
	 * the agent gets a worktree and branch of its own, so agents working side by side do not change
	 * each other's files; elsewhere, and in Read-Only mode, it works in the shared folder.
	 */
	private async newAgent(chat: string | undefined): Promise<void> {
		const from = chat ? this.chat.sessionFor(chat) : undefined;
		const lead = from ? this.hub.leadOf(from) : undefined;
		const team = lead && this.hub.team(lead.team);
		if (lead && team) {
			try {
				await this.layOutPanes(team, 1);
				const teammate = await this.hub.addTeammate(lead.id, this.nextTeammateName());
				const opened = this.chat.chatFor(teammate.id);
				if (opened) {
					await vscode.commands.executeCommand('_dragon.chat.reveal', opened);
				}
			} catch (err) {
				void vscode.window.showErrorMessage(vscode.l10n.t('The new agent could not join the team "{0}": {1}', team.name, message(err)));
			}
			return;
		}
		const client = await this.server.ensure();
		const shared = DragonChat.directory();
		const { readOnly, model, agent } = sessionDefaults(this.chat.lastPickedModel());
		let worktree: Awaited<ReturnType<typeof createAgentWorktree>>;
		if (!readOnly) {
			try {
				worktree = await createAgentWorktree(shared, worktreesHome());
			} catch (err) {
				this.log.warn(`[agents] no worktree for a new agent: ${message(err)}`);
				void vscode.window.showWarningMessage(vscode.l10n.t('A worktree could not be made for the new agent, so it works in {0}: {1}', shared, message(err)));
			}
		}
		const directory = worktree?.directory ?? shared;
		const session = await client.createSession({ directory, title: worktree?.name ?? vscode.l10n.t('agent'), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });
		const record = await this.hub.register(session.id, { name: worktree?.name ?? 'agent', directory, readOnly, messaging: 'on', branch: worktree?.branch });
		const chatResource = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.openAgentEditor', { title: record.name, model: pickerModel(model) });
		if (!chatResource) {
			throw new Error(vscode.l10n.t('The agent\'s chat could not be opened.'));
		}
		await this.chat.bindSession(chatResource, { id: session.id, directory, model: model && formatModelRef(model), agent, readOnly });
		if (worktree) {
			// Kept in the agent's inbox until the user's first message, which it then reads first.
			await client.synthetic(session.id, {
				text: `You are "${record.name}". You work in a Git worktree of your own at ${worktree.root}, on the branch ${worktree.branch} of the repository at ${worktree.repository}. Other agents work in other worktrees of it. Change files only inside your worktree; your changes reach the main working tree when your branch is merged.`,
				description: vscode.l10n.t('Worktree {0}', worktree.branch),
				metadata: { source: 'dragon.worktree' },
				resume: false,
			});
			vscode.window.setStatusBarMessage(vscode.l10n.t('{0} works on the branch {1}', record.name, worktree.branch), 8000);
		} else if (!readOnly) {
			vscode.window.setStatusBarMessage(vscode.l10n.t('{0} works in {1}, which other agents share', record.name, directory), 8000);
		}
	}

	/**
	 * Dragon: Merge Agent's Work and Remove Its Worktree. Lists the worktrees New Agent made in this
	 * repository; the chosen agent's work is committed, merged into the main working tree's branch,
	 * and its worktree and branch are removed.
	 */
	private async mergeWorktree(): Promise<void> {
		const worktrees = await listAgentWorktrees(DragonChat.directory());
		if (!worktrees.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('No agent has a worktree in this project.'));
			return;
		}
		const picked = await vscode.window.showQuickPick(worktrees.map(worktree => ({
			label: worktree.name,
			description: worktree.branch,
			detail: [
				worktree.ahead === 1 ? vscode.l10n.t('1 commit to merge') : vscode.l10n.t('{0} commits to merge', worktree.ahead),
				worktree.dirty ? vscode.l10n.t('changes not committed yet') : undefined,
			].filter(Boolean).join(', '),
			worktree,
		})), { title: vscode.l10n.t('Merge Agent\'s Work and Remove Its Worktree'), placeHolder: vscode.l10n.t('Whose work should be merged into {0}?', worktrees[0].target ?? vscode.l10n.t('the main working tree')) });
		if (!picked) {
			return;
		}
		const worktree = picked.worktree;
		// The agents whose sessions work in this worktree.
		const agents = this.hub.list().filter(agent => {
			// Git lists real paths; an agent's directory may reach the same folder through a symlink.
			const directory = fs.existsSync(agent.directory) ? fs.realpathSync(agent.directory) : agent.directory;
			return directory === worktree.root || directory.startsWith(worktree.root + path.sep);
		});
		if (agents.some(agent => this.hub.statusOf(agent.id) !== 'idle')) {
			vscode.window.showWarningMessage(vscode.l10n.t('{0} is still working. Stop it or wait for it to finish, then merge.', worktree.name));
			return;
		}
		const merge = vscode.l10n.t('Merge and Remove');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t('Merge the work of {0} into {1} and remove its worktree?', worktree.name, worktree.target ?? vscode.l10n.t('the main working tree')),
			{ modal: true, detail: vscode.l10n.t('Changes it has not committed are committed to {0} first. The folder {1} and the branch are then removed, and its chat can no longer work. If the merge has a conflict, it is undone and the worktree is kept.', worktree.branch, worktree.root) },
			merge,
		);
		if (answer !== merge) {
			return;
		}
		try {
			const merged = await mergeAgentWorktree(worktree);
			for (const agent of agents) {
				// Its folder is gone: other agents should no longer see it or wake it.
				await this.hub.setMessaging(agent.id, 'off');
			}
			vscode.window.showInformationMessage(merged === 0
				? vscode.l10n.t('{0} had nothing to merge. Its worktree is removed.', worktree.name)
				: merged === 1
					? vscode.l10n.t('Merged 1 commit from {0} and removed its worktree.', worktree.name)
					: vscode.l10n.t('Merged {0} commits from {1} and removed its worktree.', merged, worktree.name));
		} catch (err) {
			this.log.warn(`[agents] merging ${worktree.branch} failed: ${message(err)}`);
			vscode.window.showErrorMessage(vscode.l10n.t('The work of {0} was not merged, and its worktree is kept: {1}', worktree.name, message(err)));
		}
	}

	/** Stops every agent that is working, including those with no chat turn to stop them from. */
	private async stopAll(): Promise<void> {
		const client = await this.server.ensure();
		const working = this.hub.list().filter(agent => this.hub.statusOf(agent.id) !== 'idle');
		for (const agent of working) {
			await this.hub.stop(agent.id);
			await client.interrupt(agent.id).catch(err => this.log.warn(`[agents] could not stop ${agent.name}: ${message(err)}`));
		}
		vscode.window.showInformationMessage(working.length ? vscode.l10n.t('Stopped {0} agents. Each one stays stopped until you message it.', working.length) : vscode.l10n.t('No agents are working.'));
	}

	private onEvent(event: OpenCodeEvent): void {
		this.hub.observe(event);
		if (event.type !== 'permission.asked' && event.type !== 'form.created' && event.type !== 'session.created') {
			return;
		}
		for (const agent of this.hub.list()) {
			let reducer = this.reducers.get(agent.id);
			if (!reducer) {
				reducer = new TurnReducer(agent.id, this.chat.childrenOf(agent.id));
				this.reducers.set(agent.id, reducer);
			}
			for (const op of reducer.reduce(event)) {
				// A chat turn shows these itself; only an agent working without one needs them answered here.
				if (this.chat.isActive(agent.id)) {
					continue;
				}
				if (op.kind === 'permission') {
					void this.answerPermission(agent, op.request);
				} else if (op.kind === 'form') {
					// There is nowhere to ask: the agent continues without an answer rather than waiting forever.
					void this.server.ensure().then(client => client.cancelForm(agent.id, op.formID)).catch(err => this.log.warn(`[agents] form ${op.formID}: ${message(err)}`));
				}
			}
		}
	}

	/** A permission request from an agent that no chat turn is showing, answered as the permission mode says. */
	private async answerPermission(agent: AgentRecord, request: PermissionRequest): Promise<void> {
		const mode = permissionMode();
		let decision: PermissionDecision = 'reject';
		if (agent.readOnly || mode === 'read-only') {
			decision = 'reject';
		} else if (mode === 'full-access' || mode === 'project') {
			decision = 'once';
		} else {
			const allow = vscode.l10n.t('Allow Once');
			const deny = vscode.l10n.t('Deny');
			const show = vscode.l10n.t('Show Agent');
			const description = request.message || describePermission(request.action, request.resources);
			for (; ;) {
				const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Agent "{0}" asks: {1}', agent.name, description), allow, deny, show);
				if (answer === show) {
					const chatResource = this.chat.chatFor(agent.id);
					if (chatResource) {
						await vscode.commands.executeCommand('_dragon.chat.reveal', chatResource);
					}
					continue;
				}
				decision = answer === allow ? 'once' : 'reject';
				break;
			}
		}
		const client: OpenCodeClient = await this.server.ensure();
		await client.replyPermission(request.sessionID, request.id, decision).catch(err => this.log.warn(`[agents] permission reply failed: ${message(err)}`));
	}
}

/** `dragon.agents.worktreesFolder`: where New Agent makes agents' worktrees. */
export function worktreesHome(): string {
	return vscode.workspace.getConfiguration('dragon.agents').get<string>('worktreesFolder')?.trim() || path.join(os.homedir(), '.dragon', 'worktrees');
}

/**
 * What a session started from a command runs as: the model the user last chatted with (else the
 * configured one), and the plan agent in Read-Only mode.
 */
function sessionDefaults(picked: ReturnType<typeof parseModelRef>): { readOnly: boolean; model: ReturnType<typeof parseModelRef> | undefined; agent: string } {
	const readOnly = permissionMode() === 'read-only';
	const configured = vscode.workspace.getConfiguration('dragon').get<string>('model')?.trim();
	return { readOnly, model: picked ?? (configured ? parseModelRef(configured) : undefined), agent: readOnly ? 'plan' : 'build' };
}

/** The lead on the left, and `panes` groups for teammates in a grid on the right. */
export function teamLayout(panes: number): { orientation: number; groups: object[] } {
	const columns = panes > 3 ? 2 : 1;
	const rows = Math.ceil(panes / columns);
	const column = () => ({ groups: Array.from({ length: rows }, () => ({})), size: 0.6 / columns });
	return { orientation: 0, groups: [{ size: 0.4 }, ...Array.from({ length: columns }, column)] };
}

/**
 * A session's model as `_dragon.chat.openAgentEditor` takes it, so the agent's chat picker shows the
 * model it runs on: messages to the agent run on the model its picker shows.
 */
function pickerModel(model: ModelRef | undefined): { vendor: string; id: string } | undefined {
	return model && { vendor: DRAGON_VENDOR, id: formatModelRef(model) };
}

/** A message as a markdown quote, cut where a chat row stops being readable. */
function quote(body: string): string {
	const shown = body.length > SHOWN_MESSAGE_CHARS ? `${body.slice(0, SHOWN_MESSAGE_CHARS)}…` : body;
	return shown.split('\n').map(line => `> ${line}`).join('\n');
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
