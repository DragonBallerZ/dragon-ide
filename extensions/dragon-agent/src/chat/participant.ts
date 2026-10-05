/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as vscode from 'vscode';
import { OpenCodeClient, parseModelRef, formatModelRef } from '../opencode/client';
import type { OpenCodeServer } from '../opencode/server';
import { READ_ONLY_PERMISSIONS } from '../dragonConfig';
import type { FormField, ModelRef, PermissionDecision, PermissionRequest } from '../opencode/types';
import { DRAGON_VENDOR } from '../models';
import { buildInlinePrompt, extractCode, reindent, runInlineEdit } from './inline';
import { answerValue, describePermission, permissionDecision, presentTool, skippedMessage } from './toolPresentation';
import { ChangedFile, reversePatch, TurnOp, TurnReducer } from './turn';
import type { AgentHub, MessagingMode } from '../agents/hub';

/** Chat modes the composer offers, and the OpenCode primary agent each one runs. */
export const MODE_AGENTS = {
	agent: 'build',
	edit: 'build',
	ask: 'plan',
} as const;
export type ChatModeId = keyof typeof MODE_AGENTS;

export const ORIGINAL_SCHEME = 'dragon-original';

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

/** A message from another agent, as the chat shows it. */
export interface AgentMessage {
	readonly from: string;
	readonly text: string;
}

/** A message from another agent that is waiting for its chat to start the turn that delivers it. */
export interface PendingDelivery {
	/** Settles when the message is in the agent's inbox, or could not be put there. */
	readonly sent: Promise<void>;
	/** Takes the message back. False when the chat already has it. */
	cancel(): boolean;
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
	private readonly originalsChanged = new vscode.EventEmitter<vscode.Uri>();
	private readonly turnCompleted = new vscode.EventEmitter<void>();
	/** Fires after an agent turn finishes successfully. */
	readonly onDidCompleteTurn = this.turnCompleted.event;
	/** The agent hub, once messaging is set up. Agents register with it and it is told about stops. */
	hub: AgentHub | undefined;
	/** Sessions with a chat turn running, which shows their events and answers their permission requests. */
	private readonly activeTurns = new Map<string, number>();
	/** Messages from other agents, by chat, each waiting for the turn that delivers it. */
	private readonly deliveries = new Map<string, { message: AgentMessage; send: () => Promise<unknown>; settle: (err?: unknown) => void }[]>();
	/** Messaging modes chosen with the composer chip before the chat had a session. */
	private readonly pendingMessaging = new Map<string, MessagingMode>();

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
		this.disposables.forEach(d => d.dispose());
		this.originalsChanged.dispose();
		this.turnCompleted.dispose();
	}

	/** The directory OpenCode works in: the `dragon.workingDirectory` override, else the first folder. */
	static directory(): string {
		const configured = vscode.workspace.getConfiguration('dragon').get<string>('workingDirectory')?.trim();
		return configured || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
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
	 * Hands a message to a chat. The chat's next system-initiated turn calls `send` and then shows
	 * the agent's reply, so the message and the answer appear where the user watches the agent.
	 */
	queueDelivery(sessionResource: string, message: AgentMessage, send: () => Promise<unknown>): PendingDelivery {
		let settle!: (err?: unknown) => void;
		const sent = new Promise<void>((resolve, reject) => settle = err => err === undefined ? resolve() : reject(err));
		const entry = { message, send, settle };
		const queue = this.deliveries.get(sessionResource) ?? [];
		queue.push(entry);
		this.deliveries.set(sessionResource, queue);
		return {
			sent,
			cancel: () => {
				const at = queue.indexOf(entry);
				if (at >= 0) {
					queue.splice(at, 1);
				}
				return at >= 0;
			},
		};
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

	private async handle(mode: ChatModeId, request: vscode.ChatRequest, chatContext: vscode.ChatContext, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		let client: OpenCodeClient;
		if (this.server.state.kind !== 'ready') {
			response.progress('Starting OpenCode…');
		}
		try {
			client = await this.server.ensure();
		} catch (err) {
			response.markdown(`OpenCode could not start: ${message(err)}\n\nRun **Dragon: Show OpenCode Log** for details.`);
			return { errorDetails: { message: message(err) } };
		}

		const key = this.sessionKey(request);
		if (request.isSystemInitiated) {
			return this.handleDelivery(client, key, response, token);
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
		// Read-Only permission mode always runs the plan agent, whatever the composer mode.
		const readOnly = permissionMode() === 'read-only';
		const agent = readOnly ? 'plan' : MODE_AGENTS[mode];

		if (request.command === 'new') {
			await this.setSession(key, undefined);
			response.markdown('Started a new OpenCode session.');
			return {};
		}

		try {
			if (!record) {
				const session = await client.createSession({ directory, title: truncate(request.prompt || 'Dragon chat', 60), agent, model, permissions: readOnly ? READ_ONLY_PERMISSIONS : undefined });
				record = { id: session.id, directory, model: model && formatModelRef(model), agent, readOnly };
				await this.setSession(key, record);
				// Every chat's agent is known to the hub; it can message others only once the user turns that on.
				await this.hub?.register(session.id, { name: truncate(request.prompt || 'agent', 24), directory, readOnly, messaging: this.pendingMessaging.get(key) ?? 'off' });
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
					await client.setPermissions(record.id, readOnly ? READ_ONLY_PERMISSIONS : []);
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
			response.markdown(`Could not open an OpenCode session: ${message(err)}`);
			return { errorDetails: { message: message(err) } };
		}

		switch (request.command) {
			case 'compact':
				return this.runTurn(client, record.id, response, token, () => client.request('POST', `/api/session/${encodeURIComponent(record!.id)}/compact`, { body: {} }));
			case 'tui':
				await vscode.commands.executeCommand('dragon.openTui', record.id);
				response.markdown('Opened this session in the OpenCode TUI. Both views stay in sync.');
				return {};
		}

		const text = request.prompt.trim();
		if (!text && !request.command) {
			return {};
		}
		const files = referencesToFiles(request.references);
		const send = request.command
			// Any other slash command is one of OpenCode's own (built-in or from `.opencode/command`).
			? () => client.request('POST', `/api/session/${encodeURIComponent(record!.id)}/command`, { body: { name: request.command, text, ...(files.length ? { files } : {}) } })
			: () => client.prompt(record!.id, { text, files });
		return this.runTurn(client, record.id, response, token, send);
	}

	/**
	 * A turn the user did not type: a message from another agent, queued by `queueDelivery`. The
	 * session keeps its model, agent and permissions; only a person's message changes those.
	 */
	private async handleDelivery(client: OpenCodeClient, key: string, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const record = this.getSession(key);
		const delivery = this.deliveries.get(key)?.shift();
		if (!record || !delivery) {
			return {};
		}
		return this.runTurn(client, record.id, response, token, async () => {
			try {
				await delivery.send();
				delivery.settle();
			} catch (err) {
				delivery.settle(err ?? new Error('delivery failed'));
				throw err;
			}
		}, delivery.message);
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
			response.markdown(`OpenCode could not make this edit: ${message(err)}`);
			return { errorDetails: { message: message(err) } };
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

	/** Subscribes to events, sends the turn, and renders until the session finishes. */
	private async runTurn(client: OpenCodeClient, sessionID: string, response: vscode.ChatResponseStream, token: vscode.CancellationToken, send: () => Promise<unknown>, opening?: AgentMessage): Promise<vscode.ChatResult> {
		const controller = new AbortController();
		const reducer = new TurnReducer(sessionID, this.childrenOf(sessionID));
		const renderer = new TurnRenderer(response, this.output);
		if (opening) {
			// The chat shows the message as the request that started this turn.
			renderer.agentMessage(opening, false);
		}
		const changed = new Map<string, ChangedFile>();
		let outcome: TurnOp & { kind: 'done' } | undefined;
		let usage = { input: 0, output: 0 };

		const cancel = token.onCancellationRequested(() => {
			// The stop is on disk before the interrupt, so a message racing it cannot wake the agent again.
			void (this.hub?.stop(sessionID) ?? Promise.resolve()).catch(() => undefined).then(() => client.interrupt(sessionID)).catch(() => undefined);
		});
		this.activeTurns.set(sessionID, (this.activeTurns.get(sessionID) ?? 0) + 1);
		try {
			const events = client.events(controller.signal)[Symbol.asyncIterator]();
			// Subscribe BEFORE sending, or the first deltas are lost. The first frame is `server.connected`.
			const first = await events.next();
			if (first.done) {
				throw new Error('the OpenCode event stream closed immediately');
			}
			await send();
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
						case 'permission':
							if (await this.askPermission(client, op.request, response, token) === 'reject' && op.request.source) {
								renderer.denied(op.request.source.id);
							}
							break;
						case 'form':
							await this.answerForm(client, sessionID, op.formID, response, token);
							break;
						case 'tool-done':
							for (const file of op.files) {
								changed.set(file.file, file);
							}
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
			if (!token.isCancellationRequested) {
				this.output.error(`[chat] turn failed: ${message(err)}`);
				response.markdown(`\n\nOpenCode could not finish this turn: ${message(err)}`);
				return { errorDetails: { message: message(err) } };
			}
		} finally {
			const turns = (this.activeTurns.get(sessionID) ?? 1) - 1;
			if (turns > 0) {
				this.activeTurns.set(sessionID, turns);
			} else {
				this.activeTurns.delete(sessionID);
			}
			cancel.dispose();
			controller.abort();
			renderer.finish();
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
		if (token.isCancellationRequested || outcome?.outcome === 'interrupted') {
			return {};
		}
		if (outcome?.outcome === 'failed') {
			const detail = outcome.error?.message ?? 'unknown error';
			const hint = outcome.error?.type === 'provider.auth'
				? '\n\nThe model provider rejected the request. Run **Dragon: Choose Model** to connect a provider or pick a local Ollama model.'
				: '';
			response.markdown(`\n\n**OpenCode stopped:** ${detail}${hint}`);
			return { errorDetails: { message: detail } };
		}
		if (!renderer.producedOutput) {
			response.markdown('_OpenCode finished without a reply._');
		}
		this.turnCompleted.fire();
		return {};
	}

	/** Answers one permission request as the permission mode says, and returns the decision. */
	private async askPermission(client: OpenCodeClient, request: PermissionRequest, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<PermissionDecision> {
		const mode = permissionMode();
		let decision: PermissionDecision = 'reject';
		if (mode === 'full-access') {
			decision = 'once';
		} else if (mode === 'ask') {
			const description = request.message || describePermission(request.action, request.resources);
			const answers = await response.questionCarousel([
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
			], false);
			decision = permissionDecision(answers?.decision);
		}
		if (token.isCancellationRequested) {
			decision = 'reject';
		}
		await client.replyPermission(request.sessionID, request.id, decision).catch(err => this.output.warn(`[chat] permission reply failed: ${message(err)}`));
		return decision;
	}

	private async answerForm(client: OpenCodeClient, sessionID: string, formID: string, response: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> {
		try {
			const form = await client.form(sessionID, formID);
			const fields = form.fields.filter(field => !field.hidden && field.type !== 'external');
			const answers = await response.questionCarousel(fields.map(field => toQuestion(field, form.title)), true);
			if (!answers || token.isCancellationRequested) {
				await client.cancelForm(sessionID, formID);
				return;
			}
			await client.replyForm(sessionID, formID, fromAnswers(fields, answers));
		} catch (err) {
			this.output.warn(`[chat] form ${formID} failed: ${message(err)}`);
		}
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
	private readonly shownMessages = new Set<string>();
	private output = false;

	constructor(private readonly response: vscode.ChatResponseStream, private readonly log: vscode.LogOutputChannel) { }

	get producedOutput(): boolean {
		return this.output;
	}

	/** Records that the user denied a tool call, so it reads as skipped rather than run. */
	denied(toolCallID: string): void {
		this.deniedTools.add(toolCallID);
	}

	render(op: TurnOp): void {
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
			case 'tool-done':
			case 'tool-error': {
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

	/** Shows a message from another agent, once: quoted and attributed, so it never reads as something the user or this agent said. */
	agentMessage(message: AgentMessage, show = true): void {
		const key = `${message.from}\n${message.text}`;
		if (this.shownMessages.has(key) || !this.shownMessages.add(key) || !show) {
			return;
		}
		this.response.markdown(`> **${vscode.l10n.t('From {0}', message.from)}**\n>\n${message.text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`);
	}

	/** Marks tools still open when the turn ends (for example after a stop) as finished. */
	finish(): void {
		for (const part of this.tools.values()) {
			if (!part.isComplete) {
				part.isComplete = true;
				this.safe(() => this.response.push(part));
			}
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

export type PermissionMode = 'read-only' | 'ask' | 'full-access';

/** `dragon.permissionMode`, set by the composer's permission chip. */
export function permissionMode(): PermissionMode {
	const value = vscode.workspace.getConfiguration('dragon').get<string>('permissionMode');
	return value === 'read-only' || value === 'full-access' ? value : 'ask';
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

function referencesToFiles(references: readonly vscode.ChatPromptReference[]): { uri: string; name?: string }[] {
	const files: { uri: string; name?: string }[] = [];
	for (const reference of references) {
		const value = reference.value;
		if (value instanceof vscode.Uri && value.scheme === 'file') {
			files.push({ uri: value.toString(), name: reference.name });
		} else if (value instanceof vscode.Location && value.uri.scheme === 'file') {
			const uri = value.uri.with({ query: `start=${value.range.start.line + 1}&end=${value.range.end.line + 1}` });
			files.push({ uri: uri.toString(), name: reference.name });
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
