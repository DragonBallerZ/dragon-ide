/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Inline edits (Ctrl/Cmd+I in the editor), the Cursor "Cmd+K" flow. OpenCode's read-only `plan`
 * agent writes the replacement for the selection in a short-lived session: it may read and
 * search the workspace for context, but never touches the file. The editor then shows the
 * result as an inline diff to accept or discard. No VS Code types here, so it runs in tests.
 */

import { READ_ONLY_PERMISSIONS } from '../dragonConfig';
import type { OpenCodeClient } from '../opencode/client';
import type { ModelRef } from '../opencode/types';
import { presentTool } from './toolPresentation';
import { TurnReducer } from './turn';

export interface InlineEditRequest {
	/** What the user asked for. */
	readonly instruction: string;
	/** The file, relative to the workspace. */
	readonly path: string;
	readonly languageId: string;
	/** Whole lines before the target, ending with a newline (or empty). */
	readonly before: string;
	/** The lines to rewrite, without their final newline. Empty to insert new code. */
	readonly target: string;
	/** Whole lines after the target, starting after its newline (or empty). */
	readonly after: string;
}

/** The prompt for one inline edit: the instruction, the code around it, and a strict reply format. */
export function buildInlinePrompt(request: InlineEditRequest): string {
	const fence = fenceFor(request.before + request.target + request.after);
	const inserting = !request.target.trim();
	return [
		'You are making an inline edit in the user\'s editor. Do not change any file yourself; you may read and search files for context.',
		inserting
			? `Write new code to insert at <cursor/> in ${request.path}, following the instruction.`
			: `Rewrite the code between <selection> and </selection> in ${request.path}, following the instruction. Keep everything the instruction does not ask to change.`,
		'',
		`Instruction: ${request.instruction}`,
		'',
		`${fence}${request.languageId}`,
		request.before + (inserting ? '<cursor/>\n' : `<selection>\n${request.target}\n</selection>\n`) + request.after,
		fence,
		'',
		inserting
			? 'Reply with only the code to insert, in one fenced code block. No explanation.'
			: 'Reply with only the new code for the selection, in one fenced code block, without the markers or the surrounding code. No explanation.',
	].join('\n');
}

/** A code fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
	return '`'.repeat(longest + 1);
}

/**
 * The code in a model reply: the first fenced block, or the whole reply when it has no fence
 * (small local models often skip it). Selection markers the model echoed are dropped.
 */
export function extractCode(reply: string): string | undefined {
	const text = reply.replace(/\r\n/g, '\n');
	const fenced = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n`]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/.exec(text);
	const code = (fenced ? fenced[3] : text)
		.split('\n')
		.filter(line => !/^\s*<\/?selection>\s*$|^\s*<cursor\/>\s*$/.test(line))
		.join('\n')
		.replace(/^\n+|\s+$/g, '');
	return code.trim() ? code : undefined;
}

/**
 * Shifts `code` so that its least-indented line starts with `baseIndent`, the indentation of
 * the code being replaced. Models often return a snippet flush left.
 */
export function reindent(code: string, baseIndent: string): string {
	const lines = code.split('\n');
	const indents = lines.filter(line => line.trim()).map(line => /^[ \t]*/.exec(line)![0]);
	if (!indents.length) {
		return code;
	}
	const shortest = indents.reduce((a, b) => (b.length < a.length ? b : a));
	if (shortest === baseIndent) {
		return code;
	}
	return lines.map(line => (line.trim() ? baseIndent + line.slice(shortest.length) : '')).join('\n');
}

/**
 * Runs one inline edit in a short-lived OpenCode session with the `plan` agent and returns the
 * model's reply. The session is deleted afterwards so it does not clutter the session list.
 */
export async function runInlineEdit(
	client: OpenCodeClient,
	input: { readonly directory: string; readonly prompt: string; readonly title: string; readonly model?: ModelRef },
	onProgress: (message: string) => void,
	signal?: AbortSignal,
): Promise<string> {
	const session = await client.createSession({ directory: input.directory, title: input.title, agent: 'plan', model: input.model, permissions: READ_ONLY_PERMISSIONS });
	const controller = new AbortController();
	const abort = () => {
		controller.abort();
		void client.interrupt(session.id).catch(() => undefined);
	};
	signal?.addEventListener('abort', abort);
	try {
		const events = client.events(controller.signal)[Symbol.asyncIterator]();
		// Subscribe before sending, or the first deltas are lost.
		if ((await events.next()).done) {
			throw new Error('the OpenCode event stream closed immediately');
		}
		await client.prompt(session.id, { text: input.prompt });
		const reducer = new TurnReducer(session.id);
		const blocks = new Map<string, string>();
		for (let next = await events.next(); !next.done; next = await events.next()) {
			for (const op of reducer.reduce(next.value)) {
				switch (op.kind) {
					case 'text':
						blocks.set(op.block, (blocks.get(op.block) ?? '') + op.delta);
						break;
					case 'tool-running':
						onProgress(presentTool(op.name, op.input).running);
						break;
					case 'permission':
						// The plan agent only reads; anything that needs permission is out of scope here.
						await client.replyPermission(op.request.sessionID, op.request.id, 'reject', 'Inline edits cannot change files or run commands.');
						break;
					case 'done': {
						if (op.outcome !== 'succeeded') {
							throw new Error(op.error?.message ?? `OpenCode ${op.outcome === 'interrupted' ? 'was interrupted' : 'failed'}`);
						}
						// Prefer the last block with code; the model may think aloud before answering.
						const texts = [...blocks.values()];
						return [...texts].reverse().find(t => /```|~~~/.test(t)) ?? texts[texts.length - 1] ?? '';
					}
				}
			}
		}
		throw new Error(signal?.aborted ? 'cancelled' : 'the OpenCode event stream ended before the edit was ready');
	} finally {
		signal?.removeEventListener('abort', abort);
		controller.abort();
		void client.request('DELETE', `/api/session/${encodeURIComponent(session.id)}`).catch(() => undefined);
	}
}
