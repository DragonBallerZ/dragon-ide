/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Plain HTTP helpers for a local Ollama daemon. OpenCode itself discovers Ollama models and
 * runs them; Dragon IDE only detects the daemon, lists and downloads models, and configures
 * sane limits for OpenCode.
 */

export const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434';

export interface OllamaModel {
	readonly name: string;
	readonly size: number;
	readonly parameterSize?: string;
	readonly family?: string;
}

export interface OllamaStatus {
	readonly running: boolean;
	readonly version?: string;
	readonly models: readonly OllamaModel[];
}

export interface RecommendedModel {
	readonly name: string;
	readonly label: string;
	/** Approximate download size in bytes. */
	readonly bytes: number;
	/** Memory this model wants to run comfortably. */
	readonly minMemoryBytes: number;
	readonly note: string;
}

const GB = 1024 ** 3;

/**
 * Models that call tools reliably enough to drive an agent. Below ~7B, models tend to emit tool
 * calls as plain text, so they are not offered for agent work.
 */
export const RECOMMENDED_MODELS: readonly RecommendedModel[] = [
	{ name: 'qwen3-coder:30b', label: 'Qwen3 Coder 30B', bytes: 19 * GB, minMemoryBytes: 32 * GB, note: 'Best local coding agent if you have 32 GB+ of memory.' },
	{ name: 'gpt-oss:20b', label: 'gpt-oss 20B', bytes: 14 * GB, minMemoryBytes: 24 * GB, note: 'Strong reasoning and tool use.' },
	{ name: 'qwen3:14b', label: 'Qwen3 14B', bytes: 9 * GB, minMemoryBytes: 16 * GB, note: 'Good all-rounder for 16 GB machines.' },
	{ name: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', bytes: 4.7 * GB, minMemoryBytes: 8 * GB, note: 'Smallest model that handles agent tool calls well.' },
];

/** Models that fit this machine, largest first. Never offers a model beyond the memory limit. */
export function recommendFor(totalMemoryBytes: number): RecommendedModel[] {
	const fitting = RECOMMENDED_MODELS.filter(model => model.minMemoryBytes <= totalMemoryBytes);
	return fitting;
}

/** Embedding models (for semantic search) cannot chat, so they are never offered or configured as agent models. */
export function isEmbeddingModel(name: string): boolean {
	return /embed|minilm|(^|\/)bge-|paraphrase-/i.test(name);
}

/**
 * Installed models to offer for chat: no embedding models, and a model that has a Dragon agent
 * variant appears only as that variant.
 */
export function chatModelNames(models: readonly OllamaModel[]): string[] {
	const names = models.map(m => m.name).filter(name => !isEmbeddingModel(name));
	return names.filter(name => !names.some(other => other.startsWith(`${name}-dragon-`)));
}

/** Whether `model` is among the installed model names; a name without a tag means `:latest`. */
export function hasOllamaModel(installed: readonly string[], model: string): boolean {
	const wanted = model.includes(':') ? model : `${model}:latest`;
	return installed.some(name => name === model || name === wanted);
}

/** The default embedding model for semantic search: small, fast, and Matryoshka-trained. */
export const DEFAULT_EMBEDDING_MODEL = 'qwen3-embedding:0.6b';

/** Ollama must stay on loopback: Dragon IDE never points a local-model provider at another host. */
export function isLoopbackOrigin(origin: string): boolean {
	try {
		const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
		return host === '127.0.0.1' || host === 'localhost' || host === '::1';
	} catch {
		return false;
	}
}

export async function ollamaStatus(origin = DEFAULT_OLLAMA_ORIGIN, fetchImpl: typeof fetch = fetch): Promise<OllamaStatus> {
	try {
		const [version, tags] = await Promise.all([
			fetchImpl(new URL('/api/version', origin), { signal: AbortSignal.timeout(1500) }).then(r => r.ok ? r.json() as Promise<{ version?: string }> : undefined),
			fetchImpl(new URL('/api/tags', origin), { signal: AbortSignal.timeout(1500) }).then(r => r.ok ? r.json() as Promise<{ models?: any[] }> : undefined),
		]);
		if (!tags) {
			return { running: false, models: [] };
		}
		return {
			running: true,
			version: version?.version,
			models: (tags.models ?? []).map(m => ({ name: String(m.name ?? m.model), size: Number(m.size ?? 0), parameterSize: m.details?.parameter_size, family: m.details?.family })),
		};
	} catch {
		return { running: false, models: [] };
	}
}

export interface PullProgress {
	readonly status: string;
	/** 0..1 when the daemon reports byte counts. */
	readonly fraction?: number;
}

/** Downloads a model, reporting progress, via Ollama's streaming `/api/pull`. */
export async function pullModel(name: string, onProgress: (progress: PullProgress) => void, signal?: AbortSignal, origin = DEFAULT_OLLAMA_ORIGIN, fetchImpl: typeof fetch = fetch): Promise<void> {
	const res = await fetchImpl(new URL('/api/pull', origin), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: name, stream: true }),
		signal,
	});
	if (!res.ok || !res.body) {
		throw new Error(`Ollama could not download ${name} (HTTP ${res.status}).`);
	}
	const reader = (res.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let success = false;
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let index: number;
		while ((index = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) {
				continue;
			}
			const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
			if (event.error) {
				throw new Error(event.error);
			}
			if (event.status === 'success') {
				success = true;
			}
			onProgress({ status: event.status ?? '', fraction: event.total ? (event.completed ?? 0) / event.total : undefined });
		}
	}
	if (!success) {
		throw new Error(`The download of ${name} did not finish.`);
	}
}

/*
 * Context windows. OpenCode talks to Ollama through its OpenAI-compatible endpoint, which ignores
 * per-request `num_ctx` and runs every model at Ollama's default window. OpenCode's system prompt
 * and tool definitions overflow that, and Ollama drops the start of the prompt silently. OpenCode
 * also keeps max(output, 20000) tokens free before compacting, so an agent needs at least 32k.
 *
 * Dragon therefore gives each chosen model an agent variant, `<name>:<tag>-dragon-<n>k`: a
 * copy-on-write Ollama model (no extra disk) with `num_ctx` set, created through `/api/create`.
 * The context size is in the name, so the config layer can tell OpenCode the real limit.
 */

/** The context window Dragon gives a local agent model: 64k on machines with 48 GB or more, else 32k, never above the model's own maximum. */
export function agentContextFor(totalMemoryBytes: number, modelContext?: number): number {
	const wanted = totalMemoryBytes >= 48 * GB ? 65536 : 32768;
	return modelContext && modelContext > 0 ? Math.min(wanted, modelContext) : wanted;
}

const VARIANT = /-dragon-(\d+)k$/;

/** The agent variant of `model` with a `context`-token window, e.g. `qwen2.5-coder:7b-dragon-32k`. */
export function agentVariantName(model: string, context: number): string {
	const colon = model.lastIndexOf(':');
	const [name, tag] = colon > model.lastIndexOf('/') ? [model.slice(0, colon), model.slice(colon + 1)] : [model, 'latest'];
	return `${name}:${tag.replace(VARIANT, '')}-dragon-${Math.round(context / 1024)}k`;
}

/** The context window encoded in an agent variant's name, or undefined for other models. */
export function variantContext(model: string): number | undefined {
	const match = VARIANT.exec(model);
	return match ? Number(match[1]) * 1024 : undefined;
}

/** The model's own maximum context length, from `/api/show`. */
export async function modelContextLength(model: string, origin = DEFAULT_OLLAMA_ORIGIN, fetchImpl: typeof fetch = fetch): Promise<number | undefined> {
	try {
		const res = await fetchImpl(new URL('/api/show', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
		if (!res.ok) {
			return undefined;
		}
		const info = (await res.json() as { model_info?: Record<string, unknown> }).model_info ?? {};
		const value = Object.entries(info).find(([key, v]) => key.endsWith('.context_length') && typeof v === 'number' && v > 0)?.[1];
		return typeof value === 'number' ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Creates (or re-creates, which is idempotent) the agent variant of `base` and returns its name. */
export async function createAgentVariant(base: string, context: number, origin = DEFAULT_OLLAMA_ORIGIN, fetchImpl: typeof fetch = fetch): Promise<string> {
	const variant = agentVariantName(base, context);
	const res = await fetchImpl(new URL('/api/create', origin), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: variant, from: base, parameters: { num_ctx: context }, stream: false }),
		signal: AbortSignal.timeout(60_000),
	});
	const body = await res.json().catch(() => ({})) as { status?: string; error?: string };
	if (!res.ok || body.error || (body.status && body.status !== 'success')) {
		throw new Error(body.error ?? `Ollama could not create ${variant} (HTTP ${res.status})`);
	}
	return variant;
}

/** Output tokens Dragon reserves for local models (OpenCode's default of 32,000 does not fit small windows). */
export const LOCAL_OUTPUT_TOKENS = 8192;

/**
 * The OpenCode config Dragon IDE contributes for Ollama.
 *
 * OpenCode sizes its compaction trigger as `context - max(output, 20000)` with a default output
 * of 32,000 tokens, so a 32k-context local model starts every turn by compacting and never
 * answers. Capping the output for local models keeps the prompt window usable.
 */
export function ollamaConfig(origin: string, models: readonly OllamaModel[]): object {
	const entries: Record<string, object> = {};
	for (const model of models) {
		if (!isEmbeddingModel(model.name)) {
			const context = variantContext(model.name);
			entries[model.name] = { limit: { ...(context ? { context } : {}), output: LOCAL_OUTPUT_TOKENS } };
		}
	}
	return {
		providers: {
			ollama: {
				...(origin !== DEFAULT_OLLAMA_ORIGIN ? { settings: { baseURL: `${origin.replace(/\/$/, '')}/v1` } } : {}),
				...(Object.keys(entries).length ? { models: entries } : {}),
			},
		},
	};
}
