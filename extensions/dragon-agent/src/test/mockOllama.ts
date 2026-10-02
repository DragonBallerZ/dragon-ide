/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scripted stand-in for Ollama, used by the end-to-end tests. It implements the endpoints
 * OpenCode's Ollama provider calls (`/api/tags`, `/api/show`, and the OpenAI-compatible
 * `/v1/chat/completions` stream) plus `/api/pull` and `/api/create` for Dragon IDE's own download and
 * agent-variant flows.
 *
 * Requests without tools (session titles, summaries) get a short title. Requests with tools
 * get the scripted step matching how many tool results the conversation already holds, so a
 * turn is deterministic whatever else OpenCode asks the model in between.
 *
 * With `scenarios`, a user message containing `[[mock:<name>]]` switches to that scenario's
 * script, counting only the tool results after it. One server can then script several chats, and
 * a subagent's own conversation when its prompt names a scenario.
 *
 * With `embedModel`, `/api/embed` answers with a hashed bag-of-words vector: texts sharing
 * words get similar vectors, which is enough to test ranking deterministically.
 */
export type ScriptStep =
	| { readonly kind: 'tool'; readonly name: string; readonly args: Record<string, unknown> }
	| { readonly kind: 'text'; readonly chunks: readonly string[]; readonly reasoning?: readonly string[] };

export interface MockOllama {
	readonly origin: string;
	readonly requests: { path: string; body: unknown }[];
	close(): Promise<void>;
}

export interface MockOllamaOptions {
	/** An embedding model to list in `/api/tags` and serve from `/api/embed`. */
	readonly embedModel?: string;
	/** Dimensions of the mock embeddings. Default 256. */
	readonly embedDims?: number;
	/** Answers `/api/generate` (fill-in-the-middle completions). */
	readonly complete?: (prompt: string, suffix: string) => string;
	/** Token usage each completion reports, OpenAI-style (`cached` goes in `prompt_tokens_details.cached_tokens`). */
	readonly usage?: { readonly prompt: number; readonly completion: number; readonly cached?: number };
	/** Scripts picked by a `[[mock:<name>]]` marker in a user message (see above). */
	readonly scenarios?: Readonly<Record<string, readonly ScriptStep[]>>;
}

interface ChatMessage {
	readonly role?: string;
	readonly content?: string | readonly { readonly type?: string; readonly text?: string }[];
}

export async function startMockOllama(script: readonly ScriptStep[], model = 'qwen2.5-coder:7b', port = 0, options: MockOllamaOptions = {}): Promise<MockOllama> {
	const requests: { path: string; body: unknown }[] = [];
	/** Models created with `/api/create` (Dragon's agent variants). */
	const created: string[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', chunk => raw += chunk);
		req.on('end', () => {
			const body = (raw ? safeJson(raw) : undefined) as { tools?: unknown[]; messages?: ChatMessage[] } | undefined;
			requests.push({ path: req.url ?? '', body });
			const url = req.url ?? '';
			if (url === '/api/tags') {
				const models = [model, ...created].map(name => ({ name, model: name, modified_at: new Date().toISOString(), size: 4_700_000_000, digest: `sha256:mock-${name}`, details: { format: 'gguf', family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }));
				if (options.embedModel) {
					models.push({ name: options.embedModel, model: options.embedModel, modified_at: new Date().toISOString(), size: 600_000_000, digest: 'sha256:mock-embed', details: { format: 'gguf', family: 'bert', parameter_size: '0.6B', quantization_level: 'Q8_0' } });
				}
				return json(res, { models });
			}
			if (url === '/api/generate') {
				const request = body as { prompt?: string; suffix?: string } | undefined;
				return json(res, { model, response: options.complete?.(request?.prompt ?? '', request?.suffix ?? '') ?? '', done: true });
			}
			if (url === '/api/create') {
				const request = body as { model?: string; from?: string } | undefined;
				if (!request?.model || (request.from !== model && !created.includes(request.from ?? ''))) {
					res.writeHead(404, { 'content-type': 'application/json' });
					return res.end(JSON.stringify({ error: `model "${request?.from}" not found` }));
				}
				if (!created.includes(request.model)) {
					created.push(request.model);
				}
				return json(res, { status: 'success' });
			}
			if (url === '/api/embed') {
				const request = body as { model?: string; input?: string | string[] } | undefined;
				if (!options.embedModel || request?.model !== options.embedModel) {
					res.writeHead(404, { 'content-type': 'application/json' });
					return res.end(JSON.stringify({ error: `model "${request?.model}" not found, try pulling it first` }));
				}
				const inputs = Array.isArray(request.input) ? request.input : [request.input ?? ''];
				return json(res, { model: request.model, embeddings: inputs.map(text => bagOfWords(text, options.embedDims ?? 256)) });
			}
			if (url === '/api/show') {
				const shown = body as { model?: string; name?: string } | undefined;
				if (options.embedModel && (shown?.model === options.embedModel || shown?.name === options.embedModel)) {
					return json(res, { capabilities: ['embedding'], details: { format: 'gguf', family: 'bert', parameter_size: '0.6B', quantization_level: 'Q8_0' }, model_info: { 'bert.context_length': 8192 } });
				}
				return json(res, { capabilities: ['completion', 'tools'], details: { format: 'gguf', family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' }, model_info: { 'qwen2.context_length': 131072 } });
			}
			if (url === '/api/version') {
				return json(res, { version: '0.33.0-mock' });
			}
			if (url === '/api/pull') {
				res.writeHead(200, { 'content-type': 'application/x-ndjson' });
				for (const line of [{ status: 'pulling manifest' }, { status: 'downloading', total: 100, completed: 50 }, { status: 'downloading', total: 100, completed: 100 }, { status: 'success' }]) {
					res.write(JSON.stringify(line) + '\n');
				}
				return res.end();
			}
			if (url.startsWith('/v1/chat/completions')) {
				if (!body?.tools?.length) {
					return streamCompletion(res, model, { kind: 'text', chunks: ['Dragon session'] });
				}
				const messages = body.messages ?? [];
				const scenario = findScenario(messages, options.scenarios);
				const steps = scenario?.steps ?? script;
				const toolResults = messages.slice(scenario?.from ?? 0).filter(m => m.role === 'tool').length;
				return streamCompletion(res, model, steps[toolResults % steps.length], options.usage);
			}
			res.writeHead(404).end();
		});
	});
	await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
	const address = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise(resolve => server.close(() => resolve())),
	};
}

function streamCompletion(res: http.ServerResponse, model: string, step: ScriptStep | undefined, usage?: MockOllamaOptions['usage']): void {
	res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
	const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
	const send = (delta: object, finish: string | null = null) =>
		res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	if (!step || step.kind === 'text') {
		send({ role: 'assistant' });
		for (const chunk of step?.reasoning ?? []) {
			send({ reasoning_content: chunk });
		}
		for (const chunk of step?.chunks ?? ['Done.']) {
			send({ content: chunk });
		}
		send({}, 'stop');
	} else {
		send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2)}`, type: 'function', function: { name: step.name, arguments: '' } }] });
		send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] });
		send({}, 'tool_calls');
	}
	const reported = usage
		? { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion, ...(usage.cached !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cached } } : {}) }
		: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: reported })}\n\n`);
	res.write('data: [DONE]\n\n');
	res.end();
}

function json(res: http.ServerResponse, value: unknown): void {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(value));
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** A deterministic embedding: each word (camelCase and snake_case split, lowercased) adds a signed hashed component. */
/** The scenario named by the last user message with a known `[[mock:<name>]]` marker, and where that message is. */
function findScenario(messages: readonly ChatMessage[], scenarios: MockOllamaOptions['scenarios']): { steps: readonly ScriptStep[]; from: number } | undefined {
	for (let i = messages.length - 1; scenarios && i >= 0; i--) {
		if (messages[i].role !== 'user') {
			continue;
		}
		const content = messages[i].content;
		const text = typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
		for (const match of text.matchAll(/\[\[mock:(?<name>[\w-]+)\]\]/g)) {
			const steps = scenarios[match.groups!.name];
			if (steps) {
				return { steps, from: i };
			}
		}
	}
	return undefined;
}

export function bagOfWords(text: string, dims: number): number[] {
	const vector = new Array<number>(dims).fill(0);
	const words = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? [];
	for (const word of words) {
		if (word.length < 3) {
			continue;
		}
		let h = 2166136261;
		for (let i = 0; i < word.length; i++) {
			h = Math.imul(h ^ word.charCodeAt(i), 16777619);
		}
		vector[(h >>> 1) % dims] += h & 1 ? 1 : -1;
	}
	return vector;
}
