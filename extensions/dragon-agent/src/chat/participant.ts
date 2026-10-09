/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isNotFound, OpenCodeClient, parseModelRef, formatModelRef } from '../opencode/client';
import type { OpenCodeServer } from '../opencode/server';
import { DEFAULT_AUTO_COMPACT_AT, parseAutoCompactAt, PermissionMode, READ_ONLY_PERMISSIONS, sessionPermissions } from '../dragonConfig';
import type { FormField, ModelRef, PermissionDecision, PermissionRequest } from '../opencode/types';
import { DRAGON_VENDOR } from '../models';
import { Deliveries, PendingDelivery } from './deliveries';
import { buildInlinePrompt, extractCode, reindent, runInlineEdit } from './inline';
import { OpenQuestions } from './openQuestions';
import { FileReference, filesToSend, isInstructionReference } from './references';
import { RunningCommands } from './runningCommands';
import { answerValue, describePermission, permissionDecision, presentTool, skippedMessage } from './toolPresentation';
import { ChangedFile, failureMessage, reversePatch, ShownMessages, TurnNotes, TurnOp, TurnReducer, TurnYield } from './turn';
import type { AgentHub, MessagingMode } from '../agents/hub';
import { quotedMessage } from '../agents/message';
import { formatTokens } from '../usage/usage';

/** Chat modes the composer offers, and the OpenCode primary agent each one runs. */
export const MODE_AGENTS = {
	agent: 'build',
	edit: 'build',
	ask: 'plan',
} as const;
export type ChatModeId = keyof typeof MODE_AGENTS;

export const ORIGINAL_SCHEME = 'dragon-original';

/** Global state: the model the user last sent a chat message with, as `provider/model`. */
/** Teammates `/team` starts when no number is given. */
const DEFAULT_TEAM_SIZE = 4;
const LAST_MODEL_KEY = 'dragon.lastPickedModel';
/** How long a turn asked to yield to the user's next message lets the text the model is writing end first. */
const YIELD_TEXT_WAIT = 10_000;

export interface SessionRecord {
	readonly id: string;
	readonly directory: string;
	model?: string;
	agent?: string;
	/** Whether the session has the Read-Only rules; unknown for a session this chat did not create. */
	readOnly?: boolean;
	/** The session was made before the chat's first message (a team's lead or a teammate), so an empty chat keeps it. */
	bound?: boolean;
}

/** Starts teams for `/team`; `DragonAgents` provides it once agent messaging is set up. */
export interface TeamStarter {
	/** Makes the chat's agent the lead of a team and starts `size` teammates, idle until the lead sends them work. */
	startTeam(sessionResource: string, size: number): Promise<{ team: string; teammates: string[] }>;
	/** Adds a teammate named after `role`, which it and its team are told `purpose` with, to the team the chat's agent leads, making it the lead first. */
	createAgent(sessionResource: string, role: string, purpose: string): Promise<{ team: string; teammate: string }>;
}

/** A message from another agent, as the chat shows it. */
export interface AgentMessage {
	readonly from: string;
	readonly text: string;
}

/** A chat turn that messages to its session can be sent through (see `DragonChat.sendThroughTurn`). */
interface TurnListener {
	/** Resolves true once the turn follows the session's events, false if it ended first. */
	readonly listening: Promise<boolean>;
	/** Holds the turn open for a message about to be sent (see `TurnReducer.expect`); undefined once it ended. */
	expect(): { sent(inboxID: string | undefined): void; failed(): void } | undefined;
}

/**
 * The `@dragon` chat participants. The chat view is only the display: every message goes to
 * the OpenCode server, which runs the agent loop, the tools and the edits.
 */
export class DragonChat implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly originals = new Map<string, string>();
	/** Each OpenCode session's subagent sessions, whose permission requests come to its chat. */
	private readonly children = new Map<string, Set<string>>();
	/** Each OpenCode session's tool calls in progress, which a turn after a yield finishes showing. */
	private readonly tools = new Map<string, Map<string, { name: string; input: Record<string, unknown> }>>();
	private readonly originalsChanged = new vscode.EventEmitter<vscode.Uri>();
	private readonly turnCompleted = new vscode.EventEmitter<void>();
	/** Fires after an agent turn finishes successfully. */
	readonly onDidCompleteTurn = this.turnCompleted.event;
	/** The agent hub, once messaging is set up. Agents register with it and it is told about stops. */
	hub: AgentHub | undefined;
	/** Starts teams for `/team`, once messaging is set up. */
	teams: TeamStarter | undefined;
	/** Sessions with a chat turn running, which shows their events and answers their permission requests. */
	private readonly activeTurns = new Map<string, number>();
	/** Each session's chat turns, the newest last, that messages to the session can be sent through. */
	private readonly listeners = new Map<string, TurnListener[]>();
	/** Messages from other agents, by chat, each waiting for the turn that delivers it. */
	private readonly deliveries = new Deliveries<AgentMessage>();
	/** Messaging modes chosen with the composer chip before the chat had a session. */
	private readonly pendingMessaging = new Map<string, MessagingMode>();
	private chipsTimer: ReturnType<typeof setTimeout> | undefined;
	/** The instruction files each OpenCode session has been sent since it last compacted (see `filesToSend`). */
	private readonly sentInstructions = new Map<string, Set<string>>();

	constructor(
		private readonly server: OpenCodeServer,
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.LogOutputChannel,
	) {
		for (const mode of Object.keys(MODE_AGENTS) as ChatModeId[]) {
			const participant = vscode.chat.createChatParticipant(`dragon.${mode}`, (request, chatContext, response, token) =>
				this.handle(mode, request, chatContext, response, token));
			participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dragon.png');
			this.disposables.push(participant);
		}
		// Inline edits in the editor (Ctrl/Cmd+I): the reply becomes an inline diff to accept or discard.
		const inline = vscode.chat.createChatParticipant('dragon.inline', (request, _chatContext, response, token) => this.handleInline(request, response, token));
		inline.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dragon.png');
		this.disposables.push(inline);
		this.disposables.push(vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
			onDidChange: this.originalsChanged.event,
			provideTextDocumentContent: uri => this.originals.get(uri.toString()) ?? '',
		}));
	}

	dispose(): void {
		clearTimeout(this.chipsTimer);
		this.disposables.forEach(d => d.dispose());
		this.originalsChanged.dispose();
		this.turnCompleted.dispose();
	}

	/**
	 * The directory OpenCode works in: the `dragon.workingDirectory` override, else the first folder.
	 * With no folder open it is an empty folder of Dragon's, as agents are kept to the folder they
	 * work in and the home folder holds everything else.
	 */
	static directory(): string {
		const configured = vscode.workspace.getConfiguration('dragon').get<string>('workingDirectory')?.trim();
		const folder = configured || vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri.fsPath;
		if (folder) {
			return folder;
		}
		const scratch = path.join(os.homedir(), '.dragon', 'scratch');
		mkdirSync(scratch, { recursive: true });
		return scratch;
	}

	private sessionKey(request: vscode.ChatRequest): string {
		return request.sessionResource?.toString() ?? request.sessionId ?? 'default';
	}

	private getSession(key: string): SessionRecord | undefined {
		return this.context.workspaceState.get<Record<string, SessionRecord>>('dragon.sessions', {})[key];
	}

	private async setSession(key: string, record: SessionRecord | undefined): Promise<void> {
		const all = { ...this.context.workspaceState.get<Record<string, SessionRecord>>('dragon.sessions', {}) };
		if (record) {
			all[key] = record;
		} else {
			delete all[key];
		}
		await this.context.workspaceState.update('dragon.sessions', all);
		this.refreshChips();
	}

	/**
	 * Has the composer chips read their state again, soon: a chat's session or its agent changed. A
	 * chat New Agent opened is tied to its session only once its editor is open, after its chips asked.
	 */
	refreshChips(): void {
		clearTimeout(this.chipsTimer);
		this.chipsTimer = setTimeout(() => void vscode.commands.executeCommand('_dragon.chat.refreshChips').then(undefined, () => undefined), 50);
	}

	/** The chat (by session resource) showing this OpenCode session, if one does. */
	chatFor(sessionID: string): string | undefined {
		const all = this.context.workspaceState.get<Record<string, SessionRecord>>('dragon.sessions', {});
		return Object.keys(all).find(key => all[key].id === sessionID);
	}

	/** The OpenCode session record of a chat. */
	recordFor(sessionResource: string): SessionRecord | undefined {
		return this.getSession(sessionResource);
	}

	/** Ties a chat that has no messages yet to an OpenCode session made for it. */
	bindSession(sessionResource: string, record: SessionRecord): Promise<void> {
		return this.setSession(sessionResource, { ...record, bound: true });
	}

	/** Whether a chat turn is running for this session. */
	isActive(sessionID: string): boolean {
		return this.activeTurns.has(sessionID);
	}

	/**
	 * Sends a message to a session through the chat turn showing it, so the turn shows the message
	 * as it arrives and stays open until the agent has answered it. A turn that is starting gets
	 * `timeoutMs` to begin following the session. False, with nothing sent, when no turn shows the
	 * session or the one that did has ended: sent then, the message would run with no chat showing it.
	 */
	async sendThroughTurn(sessionID: string, send: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
		const turn = this.listeners.get(sessionID)?.at(-1);
		if (!turn) {
			return false;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const listening = await Promise.race([turn.listening, new Promise<false>(resolve => timer = setTimeout(() => resolve(false), timeoutMs))]).finally(() => clearTimeout(timer));
		const expectation = listening ? turn.expect() : undefined;
		if (!expectation) {
			return false;
		}
		let sent: { data?: { id?: unknown } } | undefined;
		try {
			sent = await send() as { data?: { id?: unknown } } | undefined;
		} catch (err) {
			expectation.failed();
			throw err;
		}
		expectation.sent(typeof sent?.data?.id === 'string' ? sent.data.id : undefined);
		return true;
	}

	/** The session's subagent sessions seen so far. */
	childrenOf(sessionID: string): Set<string> {
		let children = this.children.get(sessionID);
		if (!children) {
			children = new Set();
			this.children.set(sessionID, children);
		}
		return children;
	}

	/** The messaging mode the composer chip chose for a chat that has no session yet. */
	pendingMessagingFor(sessionResource: string): MessagingMode | undefined {
		return this.pendingMessaging.get(sessionResource);
	}

	setPendingMessaging(sessionResource: string, mode: MessagingMode): void {
		this.pendingMessaging.set(sessionResource, mode);
	}

	/**
	 * The name a chat's agent starts with: "main" for the Chat view's chat, the one the user talks
	 * to and the others hear from, and `fallback` for any other chat.
	 */
	async agentNameFor(sessionResource: string, fallback: string): Promise<string> {
		const view = await vscode.commands.executeCommand<string | undefined>('_dragon.chat.viewSession').then(undefined, () => undefined);
		return view === sessionResource ? 'main' : fallback;
	}

	/**
	 * Hands a message to a chat. The chat's next system-initiated turn calls `send` and then shows
	 * the agent's reply, so the message and the answer appear where the user watches the agent.
	 */
	queueDelivery(sessionResource: string, message: AgentMessage, send: () => Promise<unknown>): PendingDelivery {
		return this.deliveries.add(sessionResource, message, send);
	}

	/** A session chosen with "Continue in Chat": the next new chat continues it instead of starting one. */
	private adopted: { id: string; title: string; until: number } | undefined;

	/**
	 * "Continue in Chat": picks an OpenCode session (for example one started in the TUI) and
	 * opens a new chat whose first message continues it.
	 */
	async continueInChat(): Promise<void> {
		const client = await this.server.ensure();
		const directory = DragonChat.directory();
		const sessions = (await client.sessions(directory)).filter(s => !s.parentID).slice(0, 50);
		if (!sessions.length) {
			vscode.window.showInformationMessage(vscode.l10n.t('There are no OpenCode sessions in {0} yet.', directory));
			return;
		}
		const picked = await vscode.window.showQuickPick(sessions.map(s => ({
			label: s.title || vscode.l10n.t('Untitled session'),
			description: s.time ? new Date(s.time.updated).toLocaleString() : undefined,
			detail: s.id,
			session: s,
		})), { title: vscode.l10n.t('Continue an OpenCode session in the chat'), matchOnDetail: true });
		if (!picked) {
			return;
		}
		this.adopted = { id: picked.session.id, title: picked.label, until: Date.now() + 10 * 60_000 };
		await vscode.commands.executeCommand('workbench.action.chat.newChat');
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: '', isPartialQuery: true });
		vscode.window.showInformationMessage(vscode.l10n.t('Your next message in this chat continues "{0}".', picked.label));
	}

	/** The OpenCode session backing the chat with this session resource (as the workbench names it). */
	sessionFor(sessionResource: string): string | undefined {
		return this.getSession(sessionResource)?.id;
	}

	/** The OpenCode session id backing a chat, if any (used by "Continue in TUI"). */
	currentSessionId(): string | undefined {
		return this.context.workspaceState.get<string>('dragon.lastSession');
	}

	/** The Dragon model the user last sent a chat message with, if any. */
	lastPickedModel(): ModelRef | undefined {
		return parseModelRef(this.context.globalState.get<string>(LAST_MODEL_KEY));
	}

	private async handle(mode: ChatModeId, request: vscode.ChatRequest, chatContext: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		let client: OpenCodeClient;
		if (this.server.state.kind !== 'ready') {
			response.progress('Starting OpenCode…');
		}
		try {
			client = await this.server.ensure();
		} catch (err) {
			// The chat shows the error box only: shown as text as well, the error read twice.
			return { errorDetails: { message: vscode.l10n.t('OpenCode could not start: {0}\n\nRun **Dragon: Show OpenCode Log** for details.', message(err)) } };
		}

		const key = this.sessionKey(request);
		if (request.isSystemInitiated) {
			return this.handleDelivery(client, key, modelFromRequest(request), chatContext, response, token);
		}
		const directory = DragonChat.directory();
		// A chat with no history is a new conversation, so it gets a new OpenCode session, unless
		// "Continue in Chat" just picked one for it or one was made for it (a team's lead, a teammate).
		const stored = this.getSession(key);
		let record = chatContext.history.length || stored?.bound ? stored : undefined;
		if (record && !record.bound && record.directory !== directory) {
			record = undefined;
		}
		let continued: string | undefined;
		if (!chatContext.history.length && this.adopted && this.adopted.until > Date.now()) {
			record = { id: this.adopted.id, directory };
			continued = this.adopted.title;
			this.adopted = undefined;
			await this.setSession(key, record);
		}

		const model = modelFromRequest(request);
		if (model) {
			// New agents and teams start on the model the user picked last.
			void this.context.globalState.update(LAST_MODEL_KEY, formatModelRef(model));
		}
		// Read-Only permission mode always runs the plan agent, whatever the composer mode.
		const readOnly = permissionMode() === 'read-only';
		const agent = readOnly ? 'plan' : MODE_AGENTS[mode];

		if (request.command === 'new') {
			await this.setSession(key, undefined);
			response.markdown('Started a new OpenCode session.');
			return {};
		}
		if (request.command === 'autocompact') {
			await setAutoCompact(request.prompt, response);
			return {};
		}

		try {
			if (!record) {
				const session = await client.createSession({ directory, title: truncate(request.prompt || 'Dragon chat', 60), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });
				record = { id: session.id, directory, model: model && formatModelRef(model), agent, readOnly };
				await this.setSession(key, record);
				// Every chat's agent is known to the hub, and can message the other chats open in the
				// window unless the user turned that off with the Messages chip.
				const chosen = this.pendingMessaging.get(key);
				await this.hub?.register(session.id, { name: await this.agentNameFor(key, truncate(request.prompt || 'agent', 24)), directory, readOnly, messaging: chosen ?? 'on', messagingChosen: chosen !== undefined });
				this.pendingMessaging.delete(key);
			} else {
				if (model && record.model !== formatModelRef(model)) {
					await client.setModel(record.id, model);
					record.model = formatModelRef(model);
				}
				if (record.agent !== agent) {
					await client.setAgent(record.id, agent);
					record.agent = agent;
				}
				if (record.readOnly !== readOnly) {
					await client.setPermissions(record.id, sessionPermissions(readOnly, this.hub?.get(record.id)?.role === 'teammate'));
					record.readOnly = readOnly;
				}
				await this.setSession(key, record);
				await this.hub?.setReadOnly(record.id, readOnly);
			}
			// A person is speaking to this agent: it may be woken by other agents again.
			await this.hub?.humanTurn(record.id);
			await this.context.workspaceState.update('dragon.lastSession', record.id);
			if (continued) {
				response.markdown(vscode.l10n.t('Continuing the OpenCode session "{0}".', continued) + '\n\n');
			}
		} catch (err) {
			return { errorDetails: { message: vscode.l10n.t('Could not open an OpenCode session: {0}', message(err)) } };
		}

		let text = request.prompt.trim();
		let command = request.command;
		switch (request.command) {
			case 'team': {
				const task = await this.startTeam(key, text, response);
				if (!task) {
					return {};
				}
				// The rest of the line is a message to the lead, which can now hand the work out.
				text = task;
				command = undefined;
				break;
			}
			case 'create-agent':
				await this.createAgent(key, text, response);
				return {};
			case 'compact':
				return this.runTurn(client, record.id, response, token, () => client.request('POST', `/api/session/${encodeURIComponent(record!.id)}/compact`, { body: {} }), { yieldRequested: () => chatContext.yieldRequested, directory: record.directory });
			case 'tui':
				await vscode.commands.executeCommand('dragon.openTui', record.id);
				response.markdown('Opened this session in the OpenCode TUI. Both views stay in sync.');
				return {};
		}

		if (!text && !command) {
			return {};
		}
		const folders = [...(vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath), record.directory];
		const { files, instructions } = filesToSend(await referencesToFiles(request.references), record.directory, this.sentInstructions.get(record.id) ?? new Set(), folders);
		const send = command
			// Any other slash command is one of OpenCode's own (built-in or from `.opencode/command`).
			? () => client.request('POST', `/api/session/${encodeURIComponent(record!.id)}/command`, { body: { name: command, text, ...(files.length ? { files } : {}) } })
			: () => client.prompt(record!.id, { text, files });
		return this.runTurn(client, record.id, response, token, async () => {
			const sent = await send();
			let sentInstructions = this.sentInstructions.get(record!.id);
			if (!sentInstructions) {
				sentInstructions = new Set();
				this.sentInstructions.set(record!.id, sentInstructions);
			}
			for (const instruction of instructions) {
				sentInstructions.add(instruction);
			}
			const inboxID = (sent as { data?: { id?: unknown } } | undefined)?.data?.id;
			this.hub?.endWaits(record!.id, typeof inboxID === 'string' ? inboxID : undefined);
			return sent;
		}, { yieldRequested: () => chatContext.yieldRequested, directory: record.directory });
	}

	/**
	 * `/team [N] [task]`: this chat's agent leads a team of N teammates (default 4), started now and
	 * idle until it sends them work. Returns the task, which goes to the lead as a message.
	 */
	private async startTeam(key: string, args: string, response: vscode.ChatResponseStream): Promise<string | undefined> {
		const { size, task } = /^(?<size>\d+)?\s*(?<task>[\s\S]*)$/.exec(args)!.groups!;
		const count = size ? Number(size) : DEFAULT_TEAM_SIZE;
		const max = Math.max(1, vscode.workspace.getConfiguration('dragon.agents').get<number>('maxTeammates', 16));
		if (!this.teams) {
			response.markdown(vscode.l10n.t('Agent messaging is not available in this window, so this chat cannot lead a team.'));
			return undefined;
		}
		if (count < 1 || count > max) {
			response.markdown(vscode.l10n.t('A team has 1 to {0} teammates. For example, `/team 4 Build the game` starts four.', max));
			return undefined;
		}
		response.progress(vscode.l10n.t('Starting {0} teammates…', count));
		try {
			const started = await this.teams.startTeam(key, count);
			response.markdown(vscode.l10n.t('This chat leads the team "{0}". Started {1}, each in a pane of its own, on this chat\'s model. A teammate works only on what the lead sends it.', started.team, started.teammates.map(name => `**${name}**`).join(', ')) + '\n\n');
		} catch (err) {
			response.markdown(vscode.l10n.t('Could not start the team: {0}', message(err)));
			return undefined;
		}
		return task.trim() || undefined;
	}

	/**
	 * `/create-agent <role> [what it does]`: a teammate for the role joins the team this chat's agent
	 * leads, which it starts leading if it leads none. The teammate is idle until the lead sends it work.
	 */
	private async createAgent(key: string, args: string, response: vscode.ChatResponseStream): Promise<void> {
		const { role, purpose } = /^(?<role>\S*)\s*(?<purpose>[\s\S]*)$/.exec(args)!.groups!;
		if (!this.teams) {
			response.markdown(vscode.l10n.t('Agent messaging is not available in this window, so this chat cannot lead a team.'));
			return;
		}
		if (!role) {
			response.markdown(vscode.l10n.t('Name the teammate\'s role, and say what it does if you like. For example, `/create-agent artist Draws the pixel-art sprites` adds a teammate named artist to the team this chat leads.'));
			return;
		}
		try {
			const created = await this.teams.createAgent(key, role, purpose);
			response.markdown(vscode.l10n.t('Started **{0}** in a pane of its own, on this chat\'s model, as a teammate on the team "{1}", which this chat leads. It works only on what this chat sends it.', created.teammate, created.team));
		} catch (err) {
			response.markdown(vscode.l10n.t('Could not create the agent: {0}', message(err)));
		}
	}

	/**
	 * A turn the user did not type: a message from another agent, queued by `queueDelivery`. The
	 * session runs on the model the chat's picker shows, as a typed message would; it keeps its
	 * agent and permissions, which only a person's message changes.
	 */
	private async handleDelivery(client: OpenCodeClient, key: string, model: ModelRef | undefined, chatContext: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const record = this.getSession(key);
		// A message the turn does not send, as it has no session or its events do not open, goes back to its sender.
		return await this.deliveries.deliver(key, async (opening, send) => {
			if (!record) {
				return {};
			}
			if (model && record.model !== formatModelRef(model)) {
				try {
					await client.setModel(record.id, model);
					record.model = formatModelRef(model);
					await this.setSession(key, record);
				} catch (err) {
					this.output.warn(`[chat] the delivery runs on the session's model; switching to ${formatModelRef(model)} failed: ${message(err)}`);
				}
			}
			// The inbox id it returns keeps the turn open until OpenCode takes the message in and the run after it ends.
			return this.runTurn(client, record.id, response, token, send, { opening, yieldRequested: () => chatContext.yieldRequested, directory: record.directory });
		}) ?? {};
	}

	/**
	 * An inline edit: OpenCode's plan agent writes the replacement for the selected lines (or
	 * code to insert at the cursor), and the editor shows it as an inline diff.
	 */
	private async handleInline(request: vscode.ChatRequest, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const data = request.location2;
		if (!(data instanceof vscode.ChatRequestEditorData)) {
			response.markdown('Inline edits need a text editor. Use the chat view for everything else.');
			return {};
		}
		const instruction = request.prompt.trim();
		if (!instruction) {
			return {};
		}
		const document = data.document;
		const selection = data.selection;
		// Whole lines: from the selection's first line to its last (a selection ending at column 0 stops the line before).
		const first = selection.start.line;
		const last = !selection.isEmpty && selection.end.character === 0 && selection.end.line > first ? selection.end.line - 1 : selection.end.line;
		const currentLine = document.lineAt(first);
		const inserting = selection.isEmpty;
		// With no selection, code goes on the cursor's line when it is blank, else on a new line after it.
		const replaceBlank = inserting && currentLine.isEmptyOrWhitespace;
		const targetStart = inserting && !replaceBlank ? first + 1 : first;
		const targetEnd = inserting && !replaceBlank ? first : last;
		const lines = (from: number, to: number) => {
			const out: string[] = [];
			for (let i = Math.max(0, from); i <= Math.min(document.lineCount - 1, to); i++) {
				out.push(document.lineAt(i).text + '\n');
			}
			return out.join('');
		};
		const target = inserting ? '' : lines(first, last).replace(/\n$/, '');
		const before = lines(targetStart - 80, targetStart - 1);
		const after = lines(targetEnd + 1, targetEnd + 40);
		const relative = vscode.workspace.asRelativePath(document.uri, false);
		const prompt = buildInlinePrompt({ instruction, path: relative, languageId: document.languageId, before, target, after });

		response.progress('Asking OpenCode…');
		let reply: string;
		const abort = new AbortController();
		const cancel = token.onCancellationRequested(() => abort.abort());
		try {
			const client = await this.server.ensure();
			reply = await runInlineEdit(client, { directory: DragonChat.directory(), prompt, title: `Inline edit: ${truncate(instruction, 50)}`, model: modelFromRequest(request) }, message => response.progress(message), abort.signal);
		} catch (err) {
			if (token.isCancellationRequested) {
				return {};
			}
			this.output.error(`[inline] ${message(err)}`);
			return { errorDetails: { message: vscode.l10n.t('OpenCode could not make this edit: {0}', message(err)) } };
		} finally {
			cancel.dispose();
		}
		const code = extractCode(reply);
		if (code === undefined) {
			response.markdown(reply.trim() || 'OpenCode returned no code for this edit.');
			return {};
		}
		const baseIndent = /^[ \t]*/.exec(inserting ? currentLine.text : document.lineAt(first).text)![0];
		const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const text = reindent(code, baseIndent).split('\n').join(eol);
		const edit = inserting && !replaceBlank
			? vscode.TextEdit.insert(new vscode.Position(first, currentLine.text.length), eol + text)
			: vscode.TextEdit.replace(new vscode.Range(first, 0, last, document.lineAt(last).text.length), text);
		response.textEdit(document.uri, edit);
		response.textEdit(document.uri, true);
		return {};
	}

	/**
	 * Subscribes to events, sends the turn, and renders until the session finishes.
	 *
	 * A message the user sends meanwhile asks the turn to yield (VS Code's steering). Once the text
	 * the model is writing ends, the turn stops showing the session without stopping it: OpenCode
	 * takes the message into the work at its next step, and the message's own turn shows the rest.
	 * A message sent while a card is open cancels the turn instead (the workbench treats it as
	 * choosing another path), and the card is skipped.
	 *
	 * Approval and question cards do not hold up the turn: it keeps showing the agent's work while
	 * they are open, and a card OpenCode settled elsewhere closes.
	 */
	private async runTurn(client: OpenCodeClient, sessionID: string, response: vscode.ChatResponseStream, token: vscode.CancellationToken, send: () => Promise<unknown>, options: { readonly opening?: AgentMessage; readonly yieldRequested?: () => boolean; readonly directory?: string } = {}): Promise<vscode.ChatResult> {
		const controller = new AbortController();
		let tools = this.tools.get(sessionID);
		if (!tools) {
			tools = new Map();
			this.tools.set(sessionID, tools);
		}
		const reducer = new TurnReducer(sessionID, this.childrenOf(sessionID), tools, () => this.hub?.get(sessionID)?.name);
		const renderer = new TurnRenderer(response, this.output, shellID => client.shellTail(options.directory, shellID));
		const questions = new OpenQuestions(err => this.output.warn(`[chat] ${message(err)}`));
		if (options.opening) {
			// The chat shows the message as the request that started this turn.
			renderer.agentMessage(options.opening, true);
		}
		const changed = new Map<string, ChangedFile>();
		let outcome: TurnOp & { kind: 'done' } | undefined;
		let usage = { input: 0, output: 0 };

		const cancel = token.onCancellationRequested(() => {
			// The stop is on disk before the interrupt, so a message racing it cannot wake the agent again.
			void (this.hub?.stop(sessionID) ?? Promise.resolve()).catch(() => undefined).then(() => client.interrupt(sessionID)).catch(() => undefined);
		});
		let yielded = false;
		let failure: string | undefined;
		const yieldRequested = options.yieldRequested;
		const turnYield = new TurnYield(YIELD_TEXT_WAIT);
		const yieldWatch = yieldRequested ? setInterval(() => {
			if (!yielded && turnYield.now(yieldRequested(), { writingText: reducer.writingText, openQuestions: questions.size }, Date.now())) {
				yielded = true;
				controller.abort();
			}
		}, 250) : undefined;
		this.activeTurns.set(sessionID, (this.activeTurns.get(sessionID) ?? 0) + 1);
		// A message expected after the agent finished ends the turn when it is not coming after all.
		const endIf = (ends: boolean) => {
			if (ends && !outcome && !yielded && !token.isCancellationRequested) {
				outcome = { kind: 'done', outcome: 'succeeded' };
				controller.abort();
			}
		};
		let listen!: (listening: boolean) => void;
		const listener: TurnListener = {
			listening: new Promise<boolean>(resolve => listen = resolve),
			expect: () => {
				const expectation = outcome || yielded || token.isCancellationRequested ? undefined : reducer.expect();
				return expectation && { sent: inboxID => endIf(expectation.sent(inboxID)), failed: () => endIf(expectation.failed()) };
			},
		};
		const listeners = this.listeners.get(sessionID) ?? [];
		listeners.push(listener);
		this.listeners.set(sessionID, listeners);
		try {
			const events = client.events(controller.signal)[Symbol.asyncIterator]();
			// Subscribe BEFORE sending, or the first deltas are lost. The first frame is `server.connected`.
			const first = await events.next();
			if (first.done) {
				throw new Error('the OpenCode event stream closed immediately');
			}
			listen(true);
			const sent = await send() as { data?: { id?: unknown } } | undefined;
			if (typeof sent?.data?.id === 'string') {
				// A prompt or compaction joins the session's inbox; the turn lasts until OpenCode takes it in and finishes.
				reducer.awaitDelivery(sent.data.id);
			}
			const trace = !!process.env.DRAGON_CHAT_TRACE;
			const started = Date.now();
			for (let next = await events.next(); !next.done; next = await events.next()) {
				const event = next.value;
				if (trace) {
					this.output.trace(`+${Date.now() - started}ms ${event.type} ${JSON.stringify(event.data).slice(0, 200)}`);
				}
				for (const op of reducer.reduce(event)) {
					switch (op.kind) {
						case 'done':
							outcome = op;
							break;
						case 'usage':
							usage = { input: op.input, output: op.output };
							break;
						case 'permission': {
							const request = op.request;
							questions.ask(request.id, signal => this.askPermission(request, response, token, signal), decision => this.replyPermission(client, request, decision));
							break;
						}
						case 'form': {
							const formID = op.formID;
							questions.ask(formID, signal => this.askForm(client, sessionID, formID, response, token, signal), answer => this.replyForm(client, sessionID, formID, answer));
							break;
						}
						case 'settled':
							questions.settled(op.id);
							if (op.denied) {
								// Its failure follows, and shows as denied rather than as an error.
								renderer.denied(op.denied);
							}
							break;
						case 'tool-done':
							for (const file of op.files) {
								changed.set(file.file, file);
							}
							renderer.render(op);
							break;
						case 'compacted':
							// The summary replaced the instruction files sent before it, so they go again.
							this.sentInstructions.delete(sessionID);
							renderer.render(op);
							break;
						default:
							renderer.render(op);
					}
				}
				if (outcome) {
					break;
				}
			}
		} catch (err) {
			failure = message(err);
			// A turn ended by a message that was not coming after all stopped its event stream itself.
			if (!token.isCancellationRequested && !yielded && !outcome) {
				this.output.error(`[chat] turn failed: ${message(err)}`);
				return { errorDetails: { message: vscode.l10n.t('OpenCode could not finish this turn: {0}', message(err)) } };
			}
		} finally {
			listen(false);
			listeners.splice(listeners.indexOf(listener), 1);
			if (!listeners.length && this.listeners.get(sessionID) === listeners) {
				this.listeners.delete(sessionID);
			}
			clearInterval(yieldWatch);
			// Messages from other agents held back for text that did not end in this turn.
			for (const op of reducer.flush()) {
				renderer.render(op);
			}
			this.output.debug(`[chat] the turn in ${sessionID} ended: ${outcome ? outcome.outcome : yielded ? 'it yielded to the next request' : token.isCancellationRequested ? 'it was stopped' : failure ? `it failed: ${failure}` : 'the event stream ended first'}`);
			const turns = (this.activeTurns.get(sessionID) ?? 1) - 1;
			if (turns > 0) {
				this.activeTurns.set(sessionID, turns);
			} else {
				this.activeTurns.delete(sessionID);
			}
			cancel.dispose();
			controller.abort();
			renderer.finish(yielded && !outcome);
		}

		if (changed.size) {
			await this.showChanges(sessionID, [...changed.values()], response);
		}
		if (usage.input || usage.output) {
			try {
				response.usage({ promptTokens: usage.input, completionTokens: usage.output });
			} catch {
				// usage reporting is best effort
			}
		}
		if (yielded && !outcome) {
			response.markdown(`\n\n_${vscode.l10n.t('The work continues below, with your new message.')}_`);
			return {};
		}
		if (token.isCancellationRequested || outcome?.outcome === 'interrupted') {
			return {};
		}
		if (outcome?.outcome === 'failed') {
			// Shown once, in the chat's error box: the same text in the reply above it read twice.
			return { errorDetails: { message: failureMessage(outcome.error) } };
		}
		if (!renderer.producedOutput) {
			response.markdown('_OpenCode finished without a reply._');
		}
		this.turnCompleted.fire();
		return {};
	}

	/**
	 * The answer to one permission request, as the permission mode says: in Ask mode the user's, from
	 * an approval card. Undefined when OpenCode settled the request elsewhere first; its card closes.
	 */
	private async askPermission(request: PermissionRequest, response: vscode.ChatResponseStream, token: vscode.CancellationToken, signal: AbortSignal): Promise<PermissionDecision | undefined> {
		const mode = permissionMode();
		// Project Only approves like Full Access; the server environment keeps it to the open folders.
		if (mode === 'full-access' || mode === 'project') {
			return 'once';
		}
		if (mode !== 'ask') {
			return 'reject';
		}
		const description = request.message || describePermission(request.action, request.resources);
		const answers = await whileOpen(signal, settled => response.questionCarousel([
			new vscode.ChatQuestion('decision', vscode.ChatQuestionType.SingleSelect, 'Allow this?', {
				message: description,
				options: [
					{ id: 'once', label: 'Allow once', value: 'once' },
					{ id: 'always', label: 'Always allow', value: 'always' },
					{ id: 'reject', label: 'Deny', value: 'reject' },
				],
				defaultValue: 'once',
				// OpenCode does not pass a note with a denial on to the agent, so there is nothing to type.
				allowFreeformInput: false,
			}),
		], false, settled));
		if (signal.aborted) {
			return undefined;
		}
		return token.isCancellationRequested ? 'reject' : permissionDecision(answers?.decision);
	}

	private async replyPermission(client: OpenCodeClient, request: PermissionRequest, decision: PermissionDecision): Promise<void> {
		await settle(client.replyPermission(request.sessionID, request.id, decision), `permission ${request.id}`, this.output);
	}

	/**
	 * The answers to one of OpenCode's forms, from a question card; null when the user skipped it or
	 * stopped the turn. Undefined when OpenCode settled it elsewhere first; its card closes.
	 */
	private async askForm(client: OpenCodeClient, sessionID: string, formID: string, response: vscode.ChatResponseStream, token: vscode.CancellationToken, signal: AbortSignal): Promise<{ fields: FormField[]; answers: Record<string, unknown> } | null | undefined> {
		const form = await client.form(sessionID, formID);
		if (signal.aborted) {
			return undefined;
		}
		const fields = form.fields.filter(field => !field.hidden && field.type !== 'external');
		const answers = await whileOpen(signal, settled => response.questionCarousel(fields.map(field => toQuestion(field, form.title)), true, settled));
		if (signal.aborted) {
			return undefined;
		}
		return answers && !token.isCancellationRequested ? { fields, answers } : null;
	}

	private async replyForm(client: OpenCodeClient, sessionID: string, formID: string, answer: { fields: FormField[]; answers: Record<string, unknown> } | null): Promise<void> {
		await settle(answer ? client.replyForm(sessionID, formID, fromAnswers(answer.fields, answer.answers)) : client.cancelForm(sessionID, formID), `form ${formID}`, this.output);
	}

	/** Shows the files this turn changed as a reviewable multi-file diff. */
	private async showChanges(sessionID: string, files: ChangedFile[], response: vscode.ChatResponseStream): Promise<void> {
		const root = vscode.Uri.file(DragonChat.directory());
		const entries: vscode.ChatResponseDiffEntry[] = [];
		for (const file of files) {
			const modifiedUri = vscode.Uri.joinPath(root, file.file);
			let originalUri: vscode.Uri | undefined;
			if (file.status !== 'added' && file.patch) {
				try {
					const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(modifiedUri));
					const original = reversePatch(current, file.patch);
					if (original !== undefined) {
						originalUri = vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${sessionID}/${file.file}`, query: String(Date.now()) });
						this.originals.set(originalUri.toString(), original);
					}
				} catch {
					// deleted or unreadable: show it without a diff
				}
			}
			entries.push({
				originalUri,
				modifiedUri: file.status === 'deleted' ? undefined : modifiedUri,
				goToFileUri: modifiedUri,
				added: file.additions,
				removed: file.deletions,
			});
		}
		response.push(new vscode.ChatResponseMultiDiffPart(entries, vscode.l10n.t('Changed by OpenCode'), true));
	}
}

/** Renders reducer operations onto a chat response stream. */
class TurnRenderer {
	private readonly tools = new Map<string, vscode.ChatToolInvocationPart>();
	/** Tool calls the user denied; they fail without having run. */
	private readonly deniedTools = new Set<string>();
	private readonly shownMessages = new ShownMessages();
	/** Compaction summaries shown so far, by id. */
	private readonly summaries = new Set<string>();
	/** What `/compact` did, or that a compaction failed, shown again at the end if steps after it fold it away. */
	private readonly notes = new TurnNotes();
	private output = false;
	/** Commands still running, whose lines show how long they have run and what they printed last. */
	private readonly commands: RunningCommands;

	/** @param tail Reads the end of what a shell has printed so far. */
	constructor(private readonly response: vscode.ChatResponseStream, private readonly log: vscode.LogOutputChannel, tail: (shellID: string) => Promise<string>) {
		this.commands = new RunningCommands(tail, (id, message) => this.showRunning(id, message));
	}

	get producedOutput(): boolean {
		return this.output;
	}

	/** Records that the user denied a tool call, so it reads as skipped rather than run. */
	denied(toolCallID: string): void {
		this.deniedTools.add(toolCallID);
	}

	render(op: TurnOp): void {
		if (op.kind !== 'compacted' && op.kind !== 'compaction-failed') {
			this.notes.see(op);
		}
		switch (op.kind) {
			case 'text':
				this.output = true;
				this.response.markdown(op.delta);
				return;
			case 'thinking':
				this.safe(() => this.response.thinkingProgress({ id: op.id, text: op.delta }));
				return;
			case 'thinking-end':
				this.safe(() => this.response.thinkingProgress({ id: op.id, text: '', metadata: { vscodeReasoningDone: true } }));
				return;
			case 'status':
				this.response.progress(op.message);
				return;
			case 'compaction-text':
				// The summary streams into a collapsed block, so a long compaction shows it is working.
				if (!this.summaries.has(op.id)) {
					this.summaries.add(op.id);
					this.safe(() => this.response.thinkingProgress({ id: op.id, text: `**${vscode.l10n.t('Summarizing the conversation')}**\n\n` }));
				}
				this.safe(() => this.response.thinkingProgress({ id: op.id, text: op.delta }));
				return;
			case 'compacted': {
				this.output = true;
				const before = op.before ? formatTokens(op.before) : undefined;
				const after = op.after ? formatTokens(op.after) : undefined;
				const text = op.reason === 'manual'
					? before && after
						? vscode.l10n.t('Compacted the conversation: {0} tokens of history became a {1}-token summary.', before, after)
						: vscode.l10n.t('Compacted the conversation.')
					: before && after
						? vscode.l10n.t('OpenCode compacted the conversation automatically: {0} tokens of history became a {1}-token summary.', before, after)
						: vscode.l10n.t('OpenCode compacted the conversation automatically.');
				const note = `\n\n_${text}_\n\n`;
				this.notes.see(op, op.reason === 'manual' ? note : undefined);
				this.response.markdown(note);
				return;
			}
			case 'compaction-failed': {
				this.output = true;
				const note = `\n\n**${vscode.l10n.t('Compaction failed:')}** ${op.message}\n\n`;
				this.notes.see(op, note);
				this.response.markdown(note);
				return;
			}
			case 'agent-message':
				this.agentMessage(op);
				return;
			case 'tool-start': {
				const part = new vscode.ChatToolInvocationPart(op.name, op.id);
				part.isComplete = false;
				part.enablePartialUpdate = true;
				part.invocationMessage = new vscode.MarkdownString(presentTool(op.name).running);
				this.tools.set(op.id, part);
				this.response.push(part);
				return;
			}
			case 'tool-running': {
				const part = this.part(op.id, op.name);
				const view = presentTool(op.name, op.input);
				// The terminal block waits for the result: the chat view titles it "Ran", even for a command that was denied.
				part.invocationMessage = new vscode.MarkdownString(view.running);
				this.response.push(part);
				return;
			}
			case 'tool-progress':
				if (op.name === 'shell' && !this.tools.get(op.id)?.isComplete) {
					this.commands.start(op.id, op.shellID, presentTool(op.name, op.input).running, op.input);
				}
				return;
			case 'tool-done':
			case 'tool-error': {
				this.commands.stop(op.id);
				this.output = true;
				const part = this.part(op.id, op.name);
				const view = presentTool(op.name, op.input);
				part.isComplete = true;
				part.isConfirmed = true;
				part.isError = op.kind === 'tool-error';
				part.invocationMessage = new vscode.MarkdownString(view.running);
				const skipped = op.kind === 'tool-error' && (this.deniedTools.has(op.id) || op.errorType === 'permission.rejected');
				if (op.kind === 'tool-error' && (skipped || !view.command)) {
					const reason = this.deniedTools.has(op.id) ? 'denied' : op.message;
					part.pastTenseMessage = new vscode.MarkdownString(skipped ? skippedMessage(view.running, reason) : `${view.done} (failed: ${op.message})`);
					// Only tool data in this shape carries the error flag to the chat view.
					part.toolSpecificData = { input: JSON.stringify(op.input, null, 2), output: [new vscode.McpToolInvocationContentData(new TextEncoder().encode(reason), 'text/plain')] };
					this.response.push(part);
					return;
				}
				part.pastTenseMessage = new vscode.MarkdownString(op.kind === 'tool-error' ? `${view.done} (failed: ${op.message})` : view.done);
				if (view.command) {
					part.toolSpecificData = { commandLine: { original: view.command }, language: 'sh', output: { text: op.kind === 'tool-done' ? op.output : op.message } };
				} else if (op.kind === 'tool-done' && op.output && !view.edits && op.name !== 'read') {
					part.toolSpecificData = { input: JSON.stringify(op.input, null, 2), output: op.output };
				}
				this.response.push(part);
				return;
			}
		}
	}

	/**
	 * Shows a message from another agent that reached the agent's inbox: quoted and attributed, so it
	 * never reads as something the user or this agent said. The message that `opened` the turn is shown
	 * as its request instead.
	 */
	agentMessage(message: AgentMessage, opened = false): void {
		if (opened) {
			this.shownMessages.opened(message);
			return;
		}
		if (!this.shownMessages.arrived(message)) {
			return;
		}
		const quote = quotedMessage(vscode.l10n.t('From {0}', message.from), message.text);
		this.notes.see({ kind: 'agent-message', ...message }, quote);
		this.response.markdown(quote);
	}

	/**
	 * Marks tools still open when the turn ends (for example after a stop) as finished, and shows the
	 * notes steps folded away; when it `yielded` to the user's next message, the agents' messages too.
	 */
	finish(yielded = false): void {
		this.commands.dispose();
		for (const part of this.tools.values()) {
			if (!part.isComplete) {
				part.isComplete = true;
				this.safe(() => this.response.push(part));
			}
		}
		for (const note of this.notes.foldedAway(yielded)) {
			this.safe(() => this.response.markdown(note));
		}
	}

	/** Updates the line of a command that is still running. */
	private showRunning(id: string, message: string): void {
		const part = this.tools.get(id);
		if (part && !part.isComplete) {
			part.invocationMessage = new vscode.MarkdownString(message);
			this.safe(() => this.response.push(part));
		}
	}

	private part(id: string, name: string): vscode.ChatToolInvocationPart {
		let part = this.tools.get(id);
		if (!part) {
			part = new vscode.ChatToolInvocationPart(name, id);
			part.enablePartialUpdate = true;
			this.tools.set(id, part);
		}
		return part;
	}

	private safe(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			this.log.debug(`[chat] render skipped: ${message(err)}`);
		}
	}
}

export type { PermissionMode };

/** `dragon.permissionMode`, set by the composer's permission chip. */
export function permissionMode(): PermissionMode {
	const value = vscode.workspace.getConfiguration('dragon').get<string>('permissionMode');
	return value === 'read-only' || value === 'full-access' || value === 'project' ? value : 'ask';
}

/** `dragon.compaction.autoAt`: the percentage of the context window a conversation is compacted at, or 0 for never. */
export function autoCompactAt(): number {
	const value = vscode.workspace.getConfiguration('dragon.compaction').get<number>('autoAt');
	return typeof value === 'number' && value >= 0 && value <= 100 ? value : DEFAULT_AUTO_COMPACT_AT;
}

/** `/autocompact [off | on | 60%]`: shows or changes `dragon.compaction.autoAt`. */
async function setAutoCompact(args: string, response: vscode.ChatResponseStream): Promise<void> {
	const describe = (at: number) => at > 0
		? vscode.l10n.t('Conversations compact automatically at {0}% of the model\'s context window, or sooner when the model needs the rest for its reply. The context readout in the composer shows where.', at)
		: vscode.l10n.t('Automatic compaction is off, also when a request no longer fits the model\'s context window. Run `/compact` before a conversation fills it.');
	if (!args.trim()) {
		response.markdown(`${describe(autoCompactAt())}\n\n${vscode.l10n.t('Change it with `/autocompact 60%`, `/autocompact off` or `/autocompact on`.')}`);
		return;
	}
	const at = parseAutoCompactAt(args);
	if (at === undefined) {
		response.markdown(vscode.l10n.t('`/autocompact` takes `off`, `on`, or a percentage from 10 to 100, such as `/autocompact 60%`.'));
		return;
	}
	// The setting a workspace overrides is changed there; otherwise it is the user's.
	const config = vscode.workspace.getConfiguration('dragon.compaction');
	const target = config.inspect('autoAt')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await config.update('autoAt', at, target);
	response.markdown(describe(at));
}

/** Lets the user choose the directory new OpenCode sessions work in. */
export async function moveSession(): Promise<string | undefined> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
		openLabel: vscode.l10n.t('Work Here'), title: vscode.l10n.t('Choose the directory OpenCode works in'),
		defaultUri: vscode.Uri.file(DragonChat.directory()),
	});
	if (!picked?.length) {
		return undefined;
	}
	const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await vscode.workspace.getConfiguration('dragon').update('workingDirectory', picked[0].fsPath, target);
	return picked[0].fsPath;
}

/** The composer's selected model as an OpenCode model ref; only Dragon's own models count. */
export function modelFromRequest(request: Pick<vscode.ChatRequest, 'model'>): ModelRef | undefined {
	const model = request.model;
	if (!model || model.vendor !== DRAGON_VENDOR) {
		return undefined;
	}
	return parseModelRef(model.id);
}

/** The request's file and selection references; instruction files carry their modification time. */
async function referencesToFiles(references: readonly vscode.ChatPromptReference[]): Promise<FileReference[]> {
	const files: FileReference[] = [];
	for (const reference of references) {
		const value = reference.value;
		if (value instanceof vscode.Uri && value.scheme === 'file') {
			const version = isInstructionReference(reference.id) ? await vscode.workspace.fs.stat(value).then(stat => stat.mtime, () => undefined) : undefined;
			files.push({ id: reference.id, uri: value.toString(), path: value.fsPath, version });
		} else if (value instanceof vscode.Location && value.uri.scheme === 'file') {
			const uri = value.uri.with({ query: `start=${value.range.start.line + 1}&end=${value.range.end.line + 1}` });
			files.push({ id: reference.id, uri: uri.toString(), path: value.uri.fsPath });
		}
	}
	return files;
}

function toQuestion(field: FormField, title: string): vscode.ChatQuestion {
	const options = field.options?.map(o => ({ id: o.value, label: o.label, value: o.value }));
	const type = field.type === 'multiselect'
		? vscode.ChatQuestionType.MultiSelect
		: options?.length || field.type === 'boolean' ? vscode.ChatQuestionType.SingleSelect : vscode.ChatQuestionType.Text;
	return new vscode.ChatQuestion(field.key, type, field.title ?? title, {
		message: field.description,
		options: field.type === 'boolean' ? [{ id: 'true', label: 'Yes', value: true }, { id: 'false', label: 'No', value: false }] : options,
		allowFreeformInput: field.custom ?? field.type === 'string',
	});
}

function fromAnswers(fields: readonly FormField[], answers: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		let value = answerValue(answers[field.key]);
		if (value === undefined) {
			continue;
		}
		if (field.type === 'number' || field.type === 'integer') {
			value = Number(value);
		} else if (field.type === 'boolean') {
			value = value === true || value === 'true';
		}
		out[field.key] = value;
	}
	return out;
}

function truncate(value: string, max: number): string {
	const single = value.replace(/\s+/g, ' ').trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Shows a card that closes, unanswered, once `signal` aborts: OpenCode settled what it asks elsewhere. */
async function whileOpen<T>(signal: AbortSignal, show: (settled: vscode.CancellationToken) => Thenable<T>): Promise<T> {
	const settled = new vscode.CancellationTokenSource();
	const close = () => settled.cancel();
	signal.addEventListener('abort', close);
	if (signal.aborted) {
		close();
	}
	try {
		return await show(settled.token);
	} finally {
		signal.removeEventListener('abort', close);
		settled.dispose();
	}
}

/**
 * Sends an answer. A 404 means OpenCode settled the question already, which is not an error: it
 * drops the requests of a run that was interrupted without saying so.
 */
async function settle(reply: Promise<unknown>, what: string, output: vscode.LogOutputChannel): Promise<void> {
	try {
		await reply;
	} catch (err) {
		if (!isNotFound(err)) {
			throw err;
		}
		output.info(`[chat] ${what} was already settled`);
	}
}
