/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { METADATA_SOURCE, OwnWordsStream, unwrapMessage } from '../agents/message';
import type { OpenCodeEvent, PermissionRequest, ServerError, ToolContent } from '../opencode/types';

/** A file changed by a tool, as reported in `session.tool.success` metadata. */
export interface ChangedFile {
	readonly file: string;
	readonly patch?: string;
	readonly status?: string;
	readonly additions?: number;
	readonly deletions?: number;
}

/** What the chat view should do in response to one server event. */
export type TurnOp =
	| { readonly kind: 'text'; readonly delta: string; readonly block: string }
	| { readonly kind: 'thinking'; readonly id: string; readonly delta: string }
	| { readonly kind: 'thinking-end'; readonly id: string }
	| { readonly kind: 'tool-start'; readonly id: string; readonly name: string }
	| { readonly kind: 'tool-running'; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
	/** A command started running in shell `shellID`, whose output can be read while it runs. */
	| { readonly kind: 'tool-progress'; readonly id: string; readonly name: string; readonly input: Record<string, unknown>; readonly shellID: string }
	| { readonly kind: 'tool-done'; readonly id: string; readonly name: string; readonly input: Record<string, unknown>; readonly output: string; readonly files: readonly ChangedFile[] }
	| { readonly kind: 'tool-error'; readonly id: string; readonly name: string; readonly input: Record<string, unknown>; readonly message: string; readonly errorType?: string }
	| { readonly kind: 'permission'; readonly request: PermissionRequest }
	| { readonly kind: 'form'; readonly formID: string }
	/**
	 * OpenCode settled permission request or form `id`: it was answered here or anywhere else, or
	 * OpenCode settled it itself (a denial rejects the session's other requests, and "Always allow"
	 * allows the ones it now covers). `denied` is the tool call a denied request was for, whose
	 * failure follows.
	 */
	| { readonly kind: 'settled'; readonly id: string; readonly denied?: string }
	| { readonly kind: 'status'; readonly message: string }
	/** A message another agent sent to this session. */
	| { readonly kind: 'agent-message'; readonly from: string; readonly text: string }
	| { readonly kind: 'usage'; readonly input: number; readonly output: number }
	/** Part of the summary a compaction is writing; `thinking-end` with the same id closes it. */
	| { readonly kind: 'compaction-text'; readonly id: string; readonly delta: string }
	/** OpenCode summarized the conversation. `before` is about the size of the history it replaced and `after` the summary's, in tokens. */
	| { readonly kind: 'compacted'; readonly reason: 'auto' | 'manual'; readonly before?: number; readonly after?: number }
	| { readonly kind: 'compaction-failed'; readonly reason: 'auto' | 'manual'; readonly message: string }
	| { readonly kind: 'done'; readonly outcome: 'succeeded' | 'failed' | 'interrupted'; readonly error?: ServerError };

/**
 * Turns the OpenCode event stream for one session into chat-view operations. It is pure
 * (no VS Code types), so a recorded trace can be replayed in tests.
 *
 * The OpenCode v2 event names are documented in `opencode/packages/schema/src/session-event.ts`.
 */
export class TurnReducer {
	private lastTextBlock: string | undefined;
	/** Reasoning blocks that have streamed and whose end OpenCode has not reported. */
	private readonly openThinking = new Set<string>();
	/** Reasoning blocks ended here because the answer started; OpenCode's own end for them is dropped. */
	private readonly endedThinking = new Set<string>();
	private started = false;
	private compactions = 0;
	/** The id of the compaction summary being written, if any. */
	private compaction: string | undefined;
	/**
	 * Inbox items this turn waits for OpenCode to take in, by id: true once the item is known to be
	 * in the inbox (see `awaitDelivery` and `expect`).
	 */
	private readonly awaiting = new Map<string, boolean>();
	/** Inbox items OpenCode took in during this turn, so an item whose id is learnt late is not waited for. */
	private readonly delivered = new Set<string>();
	/** Messages handed to this turn (see `expect`) whose send has not returned. */
	private expected = 0;
	/** Whether the agent's run ended while a message held the turn open, and no run has started since. */
	private held = false;
	private ended = false;
	/** The text block the model is writing, until it ends. */
	private writing: string | undefined;
	/** Messages from other agents that came while the model was writing, shown once its text ends. */
	private readonly arrived: TurnOp[] = [];
	/** The text block being written, without message wrappers the model imitated. */
	private words: OwnWordsStream | undefined;
	/** The tool call each open permission request is for, by request id. */
	private readonly requestTools = new Map<string, string>();

	/**
	 * @param children The session's subagent sessions seen so far. The reducer adds the ones it sees
	 * created, so pass the same set to every turn of a session.
	 * @param tools The session's tool calls in progress, by call id. A turn that yielded leaves its
	 * running calls for the next turn to finish showing, so pass the same map to every turn of a session.
	 * @param name The agent's name among the agents that message each other, if it has one: the
	 * message wrappers its model imitates are taken out of its text. Text of a chat with none is as written.
	 */
	constructor(private readonly sessionID: string, private readonly children = new Set<string>(), private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>(), private readonly name: () => string | undefined = () => undefined) { }

	/** True once the server has started executing this turn. */
	get hasStarted(): boolean {
		return this.started;
	}

	/**
	 * Keeps the turn open until OpenCode delivers the inbox item this turn sent. A message sent
	 * while the agent works joins its run at the next step; a run that ends before taking it in is
	 * not the end of this turn. Only once this item's enqueued event has been seen, so a server
	 * that reports inbox items differently ends turns as before.
	 */
	awaitDelivery(inboxID: string): void {
		this.awaiting.set(inboxID, false);
	}

	/**
	 * Keeps the turn open for a message about to be sent to the session while the turn shows it:
	 * until OpenCode has taken the message in and the agent's run after it ends. A message that
	 * arrives as a run ends wakes the next one, which no turn showed. Report the message's inbox id
	 * once it is sent, or that it was not; each returns true when that ends the turn: the agent
	 * finished meanwhile, and only this message held the turn open. Undefined once the turn ended.
	 */
	expect(): { sent(inboxID: string | undefined): boolean; failed(): boolean } | undefined {
		if (this.ended) {
			return undefined;
		}
		this.expected++;
		let settled = false;
		const settle = (inboxID?: string) => {
			if (settled || this.ended) {
				return false;
			}
			settled = true;
			this.expected--;
			if (inboxID && !this.delivered.has(inboxID)) {
				// OpenCode has it, so it is waited for though its enqueued event may not have come yet.
				this.awaiting.set(inboxID, true);
			}
			if (!this.held || this.holding()) {
				return false;
			}
			this.ended = true;
			return true;
		};
		return { sent: inboxID => settle(inboxID), failed: () => settle() };
	}

	/** Whether a message this turn waits for has not reached the agent yet. */
	private holding(): boolean {
		return this.expected > 0 || [...this.awaiting.values()].some(inInbox => inInbox);
	}

	/**
	 * A message from another agent shows where it reached the agent's inbox, but not inside the text
	 * the model is writing then: the lead's chat read "On it", three answers, then "again.". It shows
	 * once that text ends.
	 */
	reduce(event: OpenCodeEvent): TurnOp[] {
		const reduced = this.reduceEvent(event);
		if (event.data?.sessionID !== this.sessionID) {
			return reduced;
		}
		const text = reduced.find(op => op.kind === 'text');
		const ends = text ? text.block !== this.writing : TEXT_ENDS.has(event.type);
		// The rest of the text that ends, then the new text without wrappers.
		const rest = ends ? this.endWords() : [];
		const ops = reduced.flatMap(op => op.kind === 'text' ? this.ownWords(op) : [op]);
		if (ends) {
			this.writing = text?.block;
			return [...rest, ...this.arrived.splice(0), ...ops];
		}
		if (this.writing === undefined) {
			return ops;
		}
		this.arrived.push(...ops.filter(op => op.kind === 'agent-message'));
		return ops.filter(op => op.kind !== 'agent-message');
	}

	/** The messages from other agents still held back, for a turn that ends before the model's text does. */
	flush(): TurnOp[] {
		const rest = this.endWords();
		this.writing = undefined;
		return [...rest, ...this.arrived.splice(0)];
	}

	private ownWords(op: TurnOp & { kind: 'text' }): TurnOp[] {
		// Only an agent others message reads their wrappers, and so may imitate them. Other text, as an
		// inline edit's code, is shown as written.
		if (!this.words && this.name() === undefined) {
			return [op];
		}
		const delta = (this.words ??= new OwnWordsStream(this.name)).push(op.delta);
		return delta ? [{ ...op, delta }] : [];
	}

	/** The text held back from the block being written, which ends. */
	private endWords(): TurnOp[] {
		const delta = this.words?.end();
		this.words = undefined;
		return delta && this.writing !== undefined ? [{ kind: 'text', delta, block: this.writing }] : [];
	}

	/** Whether the model is writing a text block that has not ended yet. */
	get writingText(): boolean {
		return this.writing !== undefined;
	}

	private reduceEvent(event: OpenCodeEvent): TurnOp[] {
		const data = event.data ?? {};
		if (event.type === 'form.created') {
			const form = data.form as { id?: string; sessionID?: string } | undefined;
			return form?.id && form.sessionID === this.sessionID ? [{ kind: 'form', formID: form.id }] : [];
		}
		if (data.sessionID !== this.sessionID) {
			return this.reduceChild(event, data);
		}
		switch (event.type) {
			case 'session.execution.started':
				this.started = true;
				this.held = false;
				return [];
			case 'session.text.delta': {
				const delta = str(data.delta);
				if (!delta) {
					return [];
				}
				const block = `${str(data.assistantMessageID)}#${data.ordinal ?? 0}`;
				// Some providers report the reasoning ended only after the answer streamed (Nemotron on
				// OpenCode Zen). The chat then took the answer's start for a step of the reasoning and
				// folded it away with it, showing only the rest; the reasoning ends where the answer starts.
				const ops: TurnOp[] = [...this.openThinking].map(id => ({ kind: 'thinking-end', id }));
				for (const id of this.openThinking) {
					this.endedThinking.add(id);
				}
				this.openThinking.clear();
				// Separate distinct text blocks (for example before and after a tool call).
				const separator = this.lastTextBlock !== undefined && this.lastTextBlock !== block ? '\n\n' : '';
				this.lastTextBlock = block;
				ops.push({ kind: 'text', delta: separator + delta, block });
				return ops;
			}
			case 'session.reasoning.delta': {
				const delta = str(data.delta);
				const id = `${str(data.assistantMessageID)}#${data.ordinal ?? 0}`;
				if (!delta) {
					return [];
				}
				// Reasoning that resumes after the answer started ends when OpenCode says so.
				this.endedThinking.delete(id);
				this.openThinking.add(id);
				return [{ kind: 'thinking', id, delta }];
			}
			case 'session.reasoning.ended': {
				const id = `${str(data.assistantMessageID)}#${data.ordinal ?? 0}`;
				this.openThinking.delete(id);
				return this.endedThinking.delete(id) ? [] : [{ kind: 'thinking-end', id }];
			}
			case 'session.tool.input.started': {
				const id = str(data.id);
				const name = str(data.name) || 'tool';
				this.tools.set(id, { name, input: {} });
				return [{ kind: 'tool-start', id, name }];
			}
			case 'session.tool.called': {
				const id = str(data.id);
				const input = obj(data.input);
				const known = this.tools.get(id);
				const name = known?.name ?? (str(data.name) || 'tool');
				this.tools.set(id, { name, input });
				const ops: TurnOp[] = known ? [] : [{ kind: 'tool-start', id, name }];
				ops.push({ kind: 'tool-running', id, name, input });
				return ops;
			}
			case 'session.tool.progress': {
				const id = str(data.id);
				const known = this.tools.get(id);
				const shellID = str(obj(data.metadata).shellID);
				return known && shellID ? [{ kind: 'tool-progress', id, name: known.name, input: known.input, shellID }] : [];
			}
			case 'session.tool.success': {
				const id = str(data.id);
				const known = this.tools.get(id) ?? { name: 'tool', input: {} };
				this.tools.delete(id);
				const metadata = obj(data.metadata);
				const files = Array.isArray(metadata.files) ? (metadata.files as ChangedFile[]).filter(f => typeof f?.file === 'string') : [];
				return [{ kind: 'tool-done', id, name: known.name, input: known.input, output: contentText(data.content), files }];
			}
			case 'session.tool.failed': {
				const id = str(data.id);
				const known = this.tools.get(id) ?? { name: 'tool', input: {} };
				this.tools.delete(id);
				const error = obj(data.error) as Partial<ServerError>;
				return [{ kind: 'tool-error', id, name: known.name, input: known.input, message: error.message ?? 'The tool failed.', errorType: error.type }];
			}
			case 'session.retry.scheduled':
			case 'session.status': {
				const status = obj(data.status);
				if (event.type === 'session.status' && status.type !== 'retry') {
					return [];
				}
				const attempt = (event.type === 'session.status' ? status.attempt : data.attempt) as number | undefined;
				return [{ kind: 'status', message: `The model provider is retrying${attempt ? ` (attempt ${attempt})` : ''}…` }];
			}
			case 'session.inbox.enqueued': {
				if (this.awaiting.has(str(data.inboxID))) {
					this.awaiting.set(str(data.inboxID), true);
				}
				// A message from another agent, as it reaches this session's inbox.
				const item = obj(data.item);
				const payload = obj(item.payload);
				const metadata = obj(payload.metadata);
				return item.type === 'synthetic' && metadata.source === METADATA_SOURCE
					? [{ kind: 'agent-message', from: str(metadata.fromName) || 'agent', text: unwrapMessage(str(payload.text)) }]
					: [];
			}
			case 'session.compaction.started':
				return [{ kind: 'status', message: data.reason === 'manual' ? 'Compacting the conversation…' : 'Compacting the conversation automatically…' }];
			case 'session.compaction.delta': {
				const delta = str(data.text);
				if (!delta) {
					return [];
				}
				this.compaction ??= `compaction-${++this.compactions}`;
				return [{ kind: 'compaction-text', id: this.compaction, delta }];
			}
			case 'session.compaction.ended':
			case 'session.compaction.failed': {
				const ops: TurnOp[] = this.compaction ? [{ kind: 'thinking-end', id: this.compaction }] : [];
				this.compaction = undefined;
				const reason = data.reason === 'manual' ? 'manual' : 'auto';
				if (event.type === 'session.compaction.failed') {
					const error = obj(data.error);
					ops.push({ kind: 'compaction-failed', reason, message: str(error.message) || str(error.type) || 'unknown error' });
					return ops;
				}
				// The usage of the summarizing request: it read the history and wrote the summary.
				const tokens = data.tokens === undefined ? undefined : obj(data.tokens);
				const cache = obj(tokens?.cache);
				ops.push(tokens
					? { kind: 'compacted', reason, before: num(tokens.input) + num(cache.read) + num(cache.write), after: num(tokens.output) }
					: { kind: 'compacted', reason });
				return ops;
			}
			case 'session.usage.updated': {
				const tokens = obj(data.tokens);
				return [{ kind: 'usage', input: num(tokens.input), output: num(tokens.output) }];
			}
			case 'permission.asked':
				return [this.asked(data)];
			case 'permission.replied':
				return [this.replied(data)];
			case 'form.replied':
			case 'form.cancelled':
				return [{ kind: 'settled', id: str(data.id) }];
			case 'session.inbox.delivered':
				this.awaiting.delete(str(data.inboxID));
				this.delivered.add(str(data.inboxID));
				return [];
			case 'session.execution.succeeded':
				if (this.holding()) {
					this.held = true;
					return [];
				}
				this.ended = true;
				return [{ kind: 'done', outcome: 'succeeded' }];
			case 'session.execution.interrupted':
				this.ended = true;
				return [{ kind: 'done', outcome: 'interrupted' }];
			case 'session.execution.failed':
				this.ended = true;
				return [{ kind: 'done', outcome: 'failed', error: obj(data.error) as unknown as ServerError }];
			default:
				return [];
		}
	}

	/**
	 * Subagents run in child sessions, and wait there for their permission requests to be answered.
	 * Those come to this chat; the rest of a subagent's activity shows in its tool card.
	 */
	private reduceChild(event: OpenCodeEvent, data: Record<string, unknown>): TurnOp[] {
		const sessionID = str(data.sessionID);
		const parentID = str(data.parentID);
		if (event.type === 'session.created' && parentID && (parentID === this.sessionID || this.children.has(parentID))) {
			this.children.add(sessionID);
			return [];
		}
		if (!this.children.has(sessionID)) {
			return [];
		}
		if (event.type === 'permission.asked') {
			return [this.asked(data)];
		}
		return event.type === 'permission.replied' ? [this.replied(data)] : [];
	}

	private asked(data: Record<string, unknown>): TurnOp {
		const request = data as unknown as PermissionRequest;
		if (request.source?.id) {
			this.requestTools.set(request.id, request.source.id);
		}
		return { kind: 'permission', request };
	}

	private replied(data: Record<string, unknown>): TurnOp {
		const id = str(data.requestID);
		const tool = this.requestTools.get(id);
		this.requestTools.delete(id);
		return data.reply === 'reject' && tool ? { kind: 'settled', id, denied: tool } : { kind: 'settled', id };
	}
}

/** A note shown in a turn, and whether it is a message from another agent. */
interface Note {
	readonly text: string;
	readonly message: boolean;
}

/**
 * A finished turn's reply is the text after its last step: the chat folds the rest into
 * "Completed N steps". A note the user must see, such as what `/compact` did, is folded away
 * with the steps when the agent works on after it, so the turn shows it again at its end. So is a
 * message from another agent in a turn that gives way to the user's next message: its reply is
 * only the line saying the work continues.
 */
export class TurnNotes {
	/** The tool calls and reasoning blocks shown, each one step in the chat. */
	private readonly steps = new Set<string>();
	/** Notes shown since the last step began. */
	private shown: Note[] = [];
	private readonly folded: Note[] = [];

	/** Takes in an op as it is shown, with the note shown for it, if any. */
	see(op: TurnOp, note?: string): void {
		const step = op.kind === 'thinking' || op.kind === 'compaction-text' ? `thinking ${op.id}`
			: op.kind === 'tool-start' || op.kind === 'tool-running' || op.kind === 'tool-done' || op.kind === 'tool-error' ? `tool ${op.id}`
				: undefined;
		if (step && !this.steps.has(step)) {
			this.steps.add(step);
			this.folded.push(...this.shown);
			this.shown = [];
		}
		if (note) {
			this.shown.push({ text: note, message: op.kind === 'agent-message' });
		}
	}

	/**
	 * The notes that steps after them folded away, to show again at the end of the turn. Messages
	 * from other agents only when it `yielded`: a turn that ends has the reply the agent wrote after them.
	 */
	foldedAway(yielded = false): string[] {
		return this.folded.splice(0).filter(note => yielded || !note.message).map(note => note.text);
	}
}

/** Events after which the model's text has ended, whether or not OpenCode reported its end. */
const TEXT_ENDS = new Set([
	'session.text.ended', 'session.step.ended', 'session.step.failed', 'session.reasoning.delta', 'session.tool.input.started', 'session.tool.called',
	'session.compaction.started', 'session.execution.succeeded', 'session.execution.interrupted', 'session.execution.failed',
]);

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) {
		return '';
	}
	return (content as ToolContent[])
		.map(part => part?.type === 'text' ? part.text ?? '' : part?.type === 'file' ? `[${part.name ?? part.uri ?? 'file'}]` : '')
		.filter(Boolean)
		.join('\n');
}

/**
 * The messages from other agents a turn shows: each one that reaches the agent's inbox, also one
 * worded as one before it, as two "Done." from an agent. The message the turn started with is shown
 * as its request, so its own arrival in the inbox shows nothing more.
 */
export class ShownMessages {
	/** The messages the turn started with whose arrival is still to come, by sender and text. */
	private readonly openings = new Map<string, number>();

	/** Takes in the message that started the turn, which the chat shows as its request. */
	opened(message: { readonly from: string; readonly text: string }): void {
		const key = `${message.from}\n${message.text}`;
		this.openings.set(key, (this.openings.get(key) ?? 0) + 1);
	}

	/** Whether a message that reached the agent's inbox is to be shown. */
	arrived(message: { readonly from: string; readonly text: string }): boolean {
		const key = `${message.from}\n${message.text}`;
		const openings = this.openings.get(key) ?? 0;
		if (!openings) {
			return true;
		}
		this.openings.set(key, openings - 1);
		return false;
	}
}

/**
 * When a turn the user asked to give way to their next message does so. The text the model is
 * writing ends in the turn first, for at most `textWait` ms: yielding at once, the lead's chat read
 * "Asked", "The work continues below", and the next turn began " them.". A card waiting for the
 * user's answer holds the turn, as the workbench holds a message typed while one waits: a message
 * typed while the model wrote, just before it asked to run a command, ended the turn and so denied
 * the command, its card closed unanswered.
 */
export class TurnYield {
	/** When the turn was asked to give way with no card open. */
	private asked: number | undefined;

	constructor(private readonly textWait: number) { }

	/** Whether the turn gives way now; `requested` is whether the user asked it to. */
	now(requested: boolean, turn: { readonly writingText: boolean; readonly openQuestions: number }, time: number): boolean {
		if (!requested || turn.openQuestions) {
			// The text the model writes once the cards are answered gets the whole wait.
			this.asked = undefined;
			return false;
		}
		this.asked ??= time;
		return !turn.writingText || time - this.asked >= this.textWait;
	}
}

/**
 * What a failed turn shows in its chat's error box: OpenCode's error and, when the model provider
 * refused the request, what the user can do about it. After hours of use the free Nemotron answers
 * "Rate limit exceeded. Please try again later.", which OpenCode reports as a usage limit
 * (provider.quota); a plain 429 it retries for over a minute, then reports as provider.rate-limit.
 */
export function failureMessage(error: ServerError | undefined): string {
	const detail = error?.message?.trim() || 'unknown error';
	switch (error?.type) {
		case 'provider.auth':
			return `${detail}\n\nThe model provider rejected the request. Run **Dragon: Choose Model** to connect a provider or pick a local Ollama model.`;
		case 'provider.quota':
			return `${detail}\n\nThe model provider says this model's usage limit is reached. Send your message again later, or run **Dragon: Choose Model** to pick another model.`;
		case 'provider.rate-limit':
			return `${detail}\n\nThe model provider is limiting how often it can be called, and OpenCode's retries ran out. Send your message again in a few minutes, or run **Dragon: Choose Model** to pick another model.`;
		default:
			return detail;
	}
}

/**
 * Rebuilds a file's previous content from its current content and the unified diff OpenCode
 * reported for the edit. Returns undefined when the patch does not apply cleanly, in which
 * case the caller shows the file without a diff rather than a wrong one.
 */
export function reversePatch(current: string, patch: string): string | undefined {
	const hunks = parseHunks(patch);
	if (!hunks) {
		return undefined;
	}
	const lines = current.split('\n');
	// Walk hunks bottom-up so earlier offsets stay valid.
	for (const hunk of [...hunks].reverse()) {
		const newLines = hunk.lines.filter(l => l[0] === ' ' || l[0] === '+').map(l => l.slice(1));
		const oldLines = hunk.lines.filter(l => l[0] === ' ' || l[0] === '-').map(l => l.slice(1));
		const start = Math.max(0, hunk.newStart - 1);
		const actual = lines.slice(start, start + newLines.length);
		if (actual.length !== newLines.length || actual.some((line, i) => line !== newLines[i])) {
			return undefined;
		}
		lines.splice(start, newLines.length, ...oldLines);
	}
	return lines.join('\n');
}

interface Hunk {
	readonly newStart: number;
	readonly lines: string[];
}

function parseHunks(patch: string): Hunk[] | undefined {
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;
	for (const line of patch.split('\n')) {
		const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			current = { newStart: Number(header[1]), lines: [] };
			hunks.push(current);
		} else if (current && (line[0] === ' ' || line[0] === '+' || line[0] === '-')) {
			current.lines.push(line);
		} else if (current && line.startsWith('\\')) {
			// "\ No newline at end of file"
		}
	}
	return hunks.length ? hunks : undefined;
}
