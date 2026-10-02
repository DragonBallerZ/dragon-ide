/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	| { readonly kind: 'tool-done'; readonly id: string; readonly name: string; readonly input: Record<string, unknown>; readonly output: string; readonly files: readonly ChangedFile[] }
	| { readonly kind: 'tool-error'; readonly id: string; readonly name: string; readonly input: Record<string, unknown>; readonly message: string; readonly errorType?: string }
	| { readonly kind: 'permission'; readonly request: PermissionRequest }
	| { readonly kind: 'form'; readonly formID: string }
	| { readonly kind: 'status'; readonly message: string }
	| { readonly kind: 'usage'; readonly input: number; readonly output: number }
	| { readonly kind: 'done'; readonly outcome: 'succeeded' | 'failed' | 'interrupted'; readonly error?: ServerError };

/**
 * Turns the OpenCode event stream for one session into chat-view operations. It is pure
 * (no VS Code types), so a recorded trace can be replayed in tests.
 *
 * The OpenCode v2 event names are documented in `opencode/packages/schema/src/session-event.ts`.
 */
export class TurnReducer {
	private readonly tools = new Map<string, { name: string; input: Record<string, unknown> }>();
	private lastTextBlock: string | undefined;
	private started = false;

	/**
	 * @param children The session's subagent sessions seen so far. The reducer adds the ones it sees
	 * created, so pass the same set to every turn of a session.
	 */
	constructor(private readonly sessionID: string, private readonly children = new Set<string>()) { }

	/** True once the server has started executing this turn. */
	get hasStarted(): boolean {
		return this.started;
	}

	reduce(event: OpenCodeEvent): TurnOp[] {
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
				return [];
			case 'session.text.delta': {
				const delta = str(data.delta);
				if (!delta) {
					return [];
				}
				const block = `${str(data.assistantMessageID)}#${data.ordinal ?? 0}`;
				const ops: TurnOp[] = [];
				// Separate distinct text blocks (for example before and after a tool call).
				const separator = this.lastTextBlock !== undefined && this.lastTextBlock !== block ? '\n\n' : '';
				this.lastTextBlock = block;
				ops.push({ kind: 'text', delta: separator + delta, block });
				return ops;
			}
			case 'session.reasoning.delta': {
				const delta = str(data.delta);
				return delta ? [{ kind: 'thinking', id: `${str(data.assistantMessageID)}#${data.ordinal ?? 0}`, delta }] : [];
			}
			case 'session.reasoning.ended':
				return [{ kind: 'thinking-end', id: `${str(data.assistantMessageID)}#${data.ordinal ?? 0}` }];
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
			case 'session.tool.success': {
				const id = str(data.id);
				const known = this.tools.get(id) ?? { name: 'tool', input: {} };
				const metadata = obj(data.metadata);
				const files = Array.isArray(metadata.files) ? (metadata.files as ChangedFile[]).filter(f => typeof f?.file === 'string') : [];
				return [{ kind: 'tool-done', id, name: known.name, input: known.input, output: contentText(data.content), files }];
			}
			case 'session.tool.failed': {
				const id = str(data.id);
				const known = this.tools.get(id) ?? { name: 'tool', input: {} };
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
			case 'session.compaction.started':
				return [{ kind: 'status', message: 'Compacting the conversation to fit the model\'s context window…' }];
			case 'session.usage.updated': {
				const tokens = obj(data.tokens);
				return [{ kind: 'usage', input: num(tokens.input), output: num(tokens.output) }];
			}
			case 'permission.asked':
				return [{ kind: 'permission', request: data as unknown as PermissionRequest }];
			case 'session.execution.succeeded':
				return [{ kind: 'done', outcome: 'succeeded' }];
			case 'session.execution.interrupted':
				return [{ kind: 'done', outcome: 'interrupted' }];
			case 'session.execution.failed':
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
		return event.type === 'permission.asked' && this.children.has(sessionID) ? [{ kind: 'permission', request: data as unknown as PermissionRequest }] : [];
	}
}

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
