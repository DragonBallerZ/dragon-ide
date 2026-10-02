/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Tab completions: fill-in-the-middle (FIM) with a small local model through Ollama's
 * `/api/generate`, which formats the prefix and `suffix` with the model's own FIM template.
 * Only a loopback Ollama is used, so code never leaves the machine. No VS Code types here.
 */

import { isLoopbackOrigin } from '../ollama/ollama';

/** Small, fast, FIM-trained, and good at code. */
export const DEFAULT_COMPLETION_MODEL = 'qwen2.5-coder:1.5b';

/** How much text before and after the cursor the model sees. */
export const PREFIX_CHARS = 6000;
export const SUFFIX_CHARS = 2000;
const MAX_LINES = 8;

export interface CompletionContext {
	/** Document text before the cursor. */
	readonly prefix: string;
	/** Document text after the cursor. */
	readonly suffix: string;
}

/** Whether the rest of the cursor's line has code, in which case only the current line is completed. */
export function isMidLine(suffix: string): boolean {
	const rest = suffix.slice(0, suffix.indexOf('\n') === -1 ? undefined : suffix.indexOf('\n'));
	return /[^\s)\]}'"`;,]/.test(rest);
}

/** The `/api/generate` request body for a completion at the cursor. */
export function buildFimRequest(model: string, context: CompletionContext): object {
	const midLine = isMidLine(context.suffix);
	return {
		model,
		prompt: context.prefix.slice(-PREFIX_CHARS),
		suffix: context.suffix.slice(0, SUFFIX_CHARS),
		stream: false,
		keep_alive: '30m',
		options: {
			temperature: 0.1,
			top_p: 0.9,
			num_predict: midLine ? 48 : 160,
			stop: midLine ? ['\n'] : ['\n\n\n'],
		},
	};
}

/**
 * Cleans a raw completion: at most one line when the cursor is mid-line, at most MAX_LINES
 * otherwise, no trailing whitespace, and no text the suffix already has (models often repeat the
 * closing brackets that follow the cursor). Returns undefined when nothing useful remains.
 */
export function postProcess(raw: string, context: CompletionContext): string | undefined {
	let text = raw.replace(/\r\n/g, '\n');
	const midLine = isMidLine(context.suffix);
	if (midLine) {
		text = text.split('\n')[0];
	} else {
		text = text.split('\n').slice(0, MAX_LINES).join('\n');
	}
	text = text.replace(/\s+$/, '');
	// Drop the longest ending of the completion that the suffix starts with.
	const suffix = context.suffix.replace(/^[ \t]*/, '');
	for (let n = Math.min(text.length, suffix.length); n > 0; n--) {
		if (text.endsWith(suffix.slice(0, n)) && suffix.slice(0, n).trim()) {
			text = text.slice(0, text.length - n).replace(/\s+$/, '');
			break;
		}
	}
	return text.trim() ? text : undefined;
}

/** Asks Ollama for a completion. Resolves to undefined when there is none or the request was cancelled. */
export async function complete(origin: string, model: string, context: CompletionContext, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
	if (!isLoopbackOrigin(origin)) {
		return undefined;
	}
	try {
		const res = await fetchImpl(new URL('/api/generate', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(buildFimRequest(model, context)),
			signal,
		});
		if (!res.ok) {
			return undefined;
		}
		const body = await res.json() as { response?: string };
		return typeof body.response === 'string' ? postProcess(body.response, context) : undefined;
	} catch {
		return undefined;
	}
}
