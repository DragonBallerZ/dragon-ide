/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DragonChat, permissionMode } from '../chat/participant';
import { describePermission } from '../chat/toolPresentation';
import { TurnReducer } from '../chat/turn';
import { READ_ONLY_PERMISSIONS } from '../dragonConfig';
import { formatModelRef, OpenCodeClient, parseModelRef } from '../opencode/client';
import type { OpenCodeServer } from '../opencode/server';
import type { SessionBridge } from '../opencode/sessionBridge';
import type { OpenCodeEvent, PermissionDecision, PermissionRequest } from '../opencode/types';
import { AgentHub, AgentRecord, Delivery, HubHost, MessagingMode } from './hub';
import { lastAssistantText } from './message';
import { createAgentWorktree } from './worktree';

/** How long a chat has to start the turn that delivers a message before the message goes in without it. */
const CHAT_DELIVERY_TIMEOUT = 10_000;
const SHOWN_MESSAGE_CHARS = 4000;
const TEAM_SIZES = [2, 3, 4, 6];
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
export class DragonAgents implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	readonly hub: AgentHub;
	/** One reducer per agent, to find the permission requests and forms of agents working outside a chat turn. */
	private readonly reducers = new Map<string, TurnReducer>();

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
			lastReply: async sessionID => lastAssistantText(await (await this.server.ensure()).messages(sessionID)),
		};
		this.hub = new AgentHub(host, path.join(storage, 'agents.json'));
		this.applyLimits();
		chat.hub = this.hub;
		this.disposables.push(
			bridge.subscribe(event => this.onEvent(event)),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('dragon.agents')) {
					this.applyLimits();
				}
			}),
			vscode.commands.registerCommand('dragon.agents.messagingState', (args?: { sessionResource?: string }) => this.messagingState(args?.sessionResource)),
			vscode.commands.registerCommand('dragon.agents.cycleMessaging', (args?: { sessionResource?: string }) => this.cycleMessaging(args?.sessionResource)),
			vscode.commands.registerCommand('dragon.newTeam', () => this.newTeam()),
			vscode.commands.registerCommand('dragon.agents.directory', (args?: { sessionResource?: string }) => args?.sessionResource ? this.chat.recordFor(args.sessionResource)?.directory : undefined),
			vscode.commands.registerCommand('dragon.newAgent', () => this.newAgent()),
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
		this.hub.dispose();
		void vscode.workspace.fs.delete(vscode.Uri.file(this.addressFile)).then(undefined, () => undefined);
	}

	private applyLimits(): void {
		const config = vscode.workspace.getConfiguration('dragon.agents');
		this.hub.setLimits({ maxWakes: Math.max(1, config.get<number>('maxWakes', 25)), maxTeammates: Math.max(1, config.get<number>('maxTeammates', 16)) });
	}

	/**
	 * Puts a message in the recipient's inbox. An idle agent whose chat is open gets it as a turn
	 * in that chat, labelled with the sender; otherwise OpenCode takes it directly, and a running
	 * turn shows it when it arrives.
	 */
	private async deliver(delivery: Delivery): Promise<void> {
		const client = await this.server.ensure();
		const recipient = delivery.recipient.id;
		const send = () => client.synthetic(recipient, { text: delivery.text, description: delivery.description, metadata: delivery.metadata, resume: delivery.wake ? undefined : false });
		const chatResource = delivery.wake && delivery.idle && !this.chat.isActive(recipient) ? this.chat.chatFor(recipient) : undefined;
		if (chatResource) {
			const pending = this.chat.queueDelivery(chatResource, { from: delivery.sender.name, text: delivery.body }, send);
			const accepted = await vscode.commands.executeCommand<boolean>('_dragon.chat.sendSystemRequest', {
				sessionResource: chatResource,
				message: delivery.body,
				// Markdown: the sender, then the message quoted, in place of a message the user typed.
				label: `**${vscode.l10n.t('From {0}', delivery.sender.name)}**\n\n${quote(delivery.body)}`,
				agentId: 'dragon.agent',
			}).then(result => result === true, err => {
				this.log.warn(`[agents] the chat for ${delivery.recipient.name} refused the message: ${message(err)}`);
				return false;
			});
			if (accepted) {
				let timer: NodeJS.Timeout | undefined;
				const taken = await Promise.race([
					pending.sent.then(() => true),
					new Promise<boolean>(resolve => timer = setTimeout(() => resolve(false), CHAT_DELIVERY_TIMEOUT)),
				]).finally(() => clearTimeout(timer));
				if (taken || !pending.cancel()) {
					// The chat has the message (or is sending it right now): sending again would deliver it twice.
					return taken ? undefined : pending.sent;
				}
				this.log.warn(`[agents] the chat for ${delivery.recipient.name} did not start a turn; delivering without it`);
			} else {
				pending.cancel();
			}
		}
		await send();
	}

	/** A teammate's OpenCode session, under the lead's model and permission ceiling, shown in its own editor. */
	private async createTeammate(lead: AgentRecord, name: string, agent: string | undefined): Promise<{ id: string; directory: string }> {
		const client = await this.server.ensure();
		const leadChat = this.chat.chatFor(lead.id);
		const leadRecord = leadChat ? this.chat.recordFor(leadChat) : undefined;
		const model = leadRecord?.model ? parseModelRef(leadRecord.model) : undefined;
		const runs = lead.readOnly ? 'plan' : agent === 'plan' ? 'plan' : 'build';
		const session = await client.createSession({ directory: lead.directory, title: name, agent: runs, model, permissions: lead.readOnly ? READ_ONLY_PERMISSIONS : undefined });
		try {
			const team = this.hub.team(lead.team);
			const panes = team ? this.context.workspaceState.get<Record<string, number>>('dragon.teams.panes', {})[team.id] : undefined;
			// Teammates fill the panes the team was opened with, then share them as tabs.
			const group = panes ? 1 + (team!.members.length % panes) : undefined;
			const chatResource = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.openAgentEditor', { title: name, group, toSide: true, preserveFocus: true });
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
			return { mode: this.chat.pendingMessagingFor(chatResource) ?? 'off' };
		}
		return { mode: agent.messaging, name: agent.name, role: agent.role, team: this.hub.team(agent.team)?.name };
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
			// A session from before agents had a registry: name it after its OpenCode title.
			const title = await this.server.ensure().then(client => client.session(record.id)).then(session => session.title, () => undefined);
			await this.hub.register(record.id, { name: title, directory: record.directory, readOnly: record.readOnly, messaging: next });
		}
		return this.messagingState(chatResource);
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
		const { readOnly, model, agent } = sessionDefaults();
		const session = await client.createSession({ directory, title: vscode.l10n.t('Lead of {0}', name || 'team'), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });

		await vscode.commands.executeCommand('vscode.setEditorLayout', teamLayout(picked.size));
		const chatResource = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.openAgentEditor', { title: vscode.l10n.t('Lead: {0}', name || 'team'), group: 0 });
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
	 * Dragon: New Agent. Opens a chat for a new agent with messaging on. In a Git repository the
	 * agent gets a worktree and branch of its own, so agents working side by side do not change
	 * each other's files; elsewhere, and in Read-Only mode, it works in the shared folder.
	 */
	private async newAgent(): Promise<void> {
		const client = await this.server.ensure();
		const shared = DragonChat.directory();
		const { readOnly, model, agent } = sessionDefaults();
		let worktree: Awaited<ReturnType<typeof createAgentWorktree>>;
		if (!readOnly) {
			try {
				worktree = await createAgentWorktree(shared, vscode.workspace.getConfiguration('dragon.agents').get<string>('worktreesFolder')?.trim() || path.join(os.homedir(), '.dragon', 'worktrees'));
			} catch (err) {
				this.log.warn(`[agents] no worktree for a new agent: ${message(err)}`);
				void vscode.window.showWarningMessage(vscode.l10n.t('A worktree could not be made for the new agent, so it works in {0}: {1}', shared, message(err)));
			}
		}
		const directory = worktree?.directory ?? shared;
		const session = await client.createSession({ directory, title: worktree?.name ?? vscode.l10n.t('agent'), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });
		const record = await this.hub.register(session.id, { name: worktree?.name ?? 'agent', directory, readOnly, messaging: 'on' });
		const chatResource = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.openAgentEditor', { title: record.name });
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
		} else if (mode === 'full-access') {
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

/** What a session started from a command runs as: the configured model, and the plan agent in Read-Only mode. */
function sessionDefaults(): { readOnly: boolean; model: ReturnType<typeof parseModelRef> | undefined; agent: string } {
	const readOnly = permissionMode() === 'read-only';
	const configured = vscode.workspace.getConfiguration('dragon').get<string>('model')?.trim();
	return { readOnly, model: configured ? parseModelRef(configured) : undefined, agent: readOnly ? 'plan' : 'build' };
}

/** The lead on the left, and `panes` groups for teammates in a grid on the right. */
export function teamLayout(panes: number): { orientation: number; groups: object[] } {
	const columns = panes > 3 ? 2 : 1;
	const rows = Math.ceil(panes / columns);
	const column = () => ({ groups: Array.from({ length: rows }, () => ({})), size: 0.6 / columns });
	return { orientation: 0, groups: [{ size: 0.4 }, ...Array.from({ length: columns }, column)] };
}

/** A message as a markdown quote, cut where a chat row stops being readable. */
function quote(body: string): string {
	const shown = body.length > SHOWN_MESSAGE_CHARS ? `${body.slice(0, SHOWN_MESSAGE_CHARS)}…` : body;
	return shown.split('\n').map(line => `> ${line}`).join('\n');
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
