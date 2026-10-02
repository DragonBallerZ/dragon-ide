/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Semantic code search ("search by meaning") with a local embedding model served by Ollama.
 *
 * Code is split into chunks at natural boundaries, embedded on this machine in the background,
 * stored as 8-bit vectors and searched by cosine similarity. Results are fused with Instant
 * Grep keyword hits (reciprocal rank fusion), so identifiers named in a question still count.
 * Only a loopback Ollama origin is ever used: no code or query leaves the machine.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_OLLAMA_ORIGIN, hasOllamaModel, isLoopbackOrigin } from '../ollama/ollama';
import type { SearchEngine } from './engine';

export interface SemanticSettings {
	readonly enabled: boolean;
	readonly model: string;
	readonly origin: string;
}

/**
 * Settings come from the JSON file Dragon IDE writes (`DRAGON_SEMANTIC_CONFIG`), re-read on
 * every use so a change applies without restarting OpenCode. Without the file the environment
 * decides, and semantic search defaults to on with the default model on the default origin.
 */
export async function readSemanticSettings(file = process.env.DRAGON_SEMANTIC_CONFIG): Promise<SemanticSettings> {
	let stored: Partial<SemanticSettings> = {};
	if (file) {
		try {
			stored = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SemanticSettings>;
		} catch {
			// missing or partly written: use the defaults below
		}
	}
	return {
		enabled: typeof stored.enabled === 'boolean' ? stored.enabled : process.env.DRAGON_SEMANTIC !== '0',
		model: (typeof stored.model === 'string' && stored.model.trim()) || process.env.DRAGON_EMBED_MODEL || DEFAULT_EMBEDDING_MODEL,
		origin: ((typeof stored.origin === 'string' && stored.origin.trim()) || process.env.DRAGON_OLLAMA_ORIGIN || DEFAULT_OLLAMA_ORIGIN).replace(/\/$/, ''),
	};
}

// ---- chunking --------------------------------------------------------------------------------

export interface CodeChunk {
	/** First line, 1-based. */
	readonly start: number;
	/** Last line, 1-based, inclusive. */
	readonly end: number;
	readonly text: string;
}

const CHUNK_TARGET_CHARS = 1000;
const CHUNK_MAX_CHARS = 1800;
const CHUNK_MAX_LINES = 60;
const CHUNK_MIN_CHARS = 24;

/**
 * Splits source text into chunks of about CHUNK_TARGET_CHARS. A chunk ends early only where the
 * next line is blank or starts a new top-level construct, so functions and classes tend to stay
 * whole; it is cut hard at CHUNK_MAX_CHARS or CHUNK_MAX_LINES.
 */
export function chunkCode(text: string): CodeChunk[] {
	const lines = text.split('\n');
	if (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	const out: CodeChunk[] = [];
	let start = 0;
	let chars = 0;
	const flush = (end: number) => {
		const body = lines.slice(start, end).join('\n');
		if (body.replace(/\s+/g, '').length >= CHUNK_MIN_CHARS) {
			out.push({ start: start + 1, end, text: body });
		}
		start = end;
		chars = 0;
	};
	for (let i = 0; i < lines.length; i++) {
		chars += lines[i].length + 1;
		const next = lines[i + 1];
		const boundary = next === undefined || next.trim() === '' || (/^\S/.test(next) && !/^[)}\]]/.test(next));
		if (chars >= CHUNK_MAX_CHARS || i + 1 - start >= CHUNK_MAX_LINES || (chars >= CHUNK_TARGET_CHARS && boundary)) {
			flush(i + 1);
		}
	}
	if (start < lines.length) {
		flush(lines.length);
	}
	return out;
}

const CODE_EXTENSIONS = new Set([
	'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
	'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'php', 'lua', 'dart', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'elm', 'hs',
	'ml', 'mli', 'nim', 'zig', 'sol', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'r', 'jl', 'pl', 'pm', 'vue', 'svelte', 'astro', 'html',
	'css', 'scss', 'less', 'proto', 'graphql', 'gql', 'tf', 'hcl', 'yaml', 'yml', 'toml', 'json', 'md', 'mdx', 'rst', 'txt',
]);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock', 'Gemfile.lock', 'uv.lock']);
const MAX_FILE_BYTES = 200 * 1024;
const MAX_DATA_FILE_BYTES = 32 * 1024;

/** Whether a file is worth embedding: source, config or docs, not generated, not huge, not hidden. */
export function isSemanticCandidate(rel: string, size: number): boolean {
	const base = rel.slice(rel.lastIndexOf('/') + 1);
	const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
	if (!CODE_EXTENSIONS.has(ext) || LOCKFILES.has(base) || /\.min\.|\.map$|\.d\.ts$/.test(base) || rel.split('/').some(part => part.startsWith('.'))) {
		return false;
	}
	return size > 0 && size <= (ext === 'json' || ext === 'txt' ? MAX_DATA_FILE_BYTES : MAX_FILE_BYTES);
}

/** Tests and fixtures are embedded after the code they exercise. */
function priority(rel: string): number {
	return /(^|\/)(tests?|__tests__|spec|fixtures?|e2e|testdata|mocks?)(\/|$)|\.(test|spec)\./.test(rel) ? 1 : 0;
}

// ---- embeddings ------------------------------------------------------------------------------

const MAX_INPUT_CHARS = 2000;
const EMBED_BATCH = 16;

/** Instruction prefixes the popular local embedding models were trained with. */
export function queryInput(model: string, query: string): string {
	if (/qwen3-embedding/i.test(model)) {
		return `Instruct: Given a question about a codebase, retrieve the code or documentation that answers it\nQuery: ${query}`;
	}
	if (/nomic-embed/i.test(model)) {
		return `search_query: ${query}`;
	}
	if (/embeddinggemma/i.test(model)) {
		return `task: code retrieval | query: ${query}`;
	}
	if (/mxbai-embed|snowflake-arctic-embed/i.test(model)) {
		return `Represent this sentence for searching relevant passages: ${query}`;
	}
	return query;
}

export function documentInput(model: string, rel: string, text: string): string {
	const body = text.slice(0, MAX_INPUT_CHARS);
	if (/nomic-embed/i.test(model)) {
		return `search_document: ${rel}\n${body}`;
	}
	if (/embeddinggemma/i.test(model)) {
		return `title: ${rel} | text: ${body}`;
	}
	return `${rel}\n${body}`;
}

/** Embeds `inputs` with Ollama's `/api/embed`. */
export async function embed(origin: string, model: string, inputs: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
	if (!isLoopbackOrigin(origin)) {
		throw new Error(`semantic search only uses a local Ollama, not ${origin}`);
	}
	const timeout = AbortSignal.timeout(120_000);
	const res = await fetch(new URL('/api/embed', origin), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model, input: inputs, truncate: true }),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	if (!res.ok) {
		throw new Error(`Ollama could not embed with ${model} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
	}
	const body = await res.json() as { embeddings?: number[][] };
	if (!Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length) {
		throw new Error(`Ollama returned ${body.embeddings?.length ?? 0} embeddings for ${inputs.length} inputs`);
	}
	return body.embeddings.map(e => Float32Array.from(e));
}

/** Installed Ollama model names, or an error message. */
async function installedModels(origin: string): Promise<string[] | string> {
	if (!isLoopbackOrigin(origin)) {
		return `semantic search only uses a local Ollama, and ${origin} is not on this machine`;
	}
	try {
		const res = await fetch(new URL('/api/tags', origin), { signal: AbortSignal.timeout(2000) });
		if (!res.ok) {
			return `Ollama at ${origin} answered HTTP ${res.status}`;
		}
		const body = await res.json() as { models?: { name?: string; model?: string }[] };
		return (body.models ?? []).map(m => String(m.name ?? m.model ?? ''));
	} catch {
		return `Ollama is not running at ${origin}`;
	}
}

// ---- vectors ---------------------------------------------------------------------------------

/** Vectors are truncated to this many dimensions (local embedding models are Matryoshka-trained) and stored as int8. */
const MAX_DIMS = 512;

class VectorStore {
	dims = 0;
	private data = new Int8Array(0);
	private scales = new Float32Array(0);
	private used = 0;
	private readonly free: number[] = [];

	reset(dims: number): void {
		this.dims = dims;
		this.data = new Int8Array(0);
		this.scales = new Float32Array(0);
		this.used = 0;
		this.free.length = 0;
	}

	add(vector: Float32Array): number {
		const slot = this.free.pop() ?? this.used++;
		if ((slot + 1) * this.dims > this.data.length) {
			const capacity = Math.max(1024, (slot + 1) * 2);
			const data = new Int8Array(capacity * this.dims);
			data.set(this.data);
			this.data = data;
			const scales = new Float32Array(capacity);
			scales.set(this.scales);
			this.scales = scales;
		}
		const v = normalize(vector, this.dims);
		let max = 0;
		for (let i = 0; i < this.dims; i++) {
			max = Math.max(max, Math.abs(v[i]));
		}
		const scale = max / 127 || 1;
		const offset = slot * this.dims;
		for (let i = 0; i < this.dims; i++) {
			this.data[offset + i] = Math.round(v[i] / scale);
		}
		this.scales[slot] = scale;
		return slot;
	}

	/** Adds a vector already quantized (from disk). */
	addQuantized(values: Int8Array, scale: number): number {
		const slot = this.add(new Float32Array(this.dims));
		this.data.set(values, slot * this.dims);
		this.scales[slot] = scale;
		return slot;
	}

	release(slot: number): void {
		this.free.push(slot);
	}

	/** Cosine similarity between a stored vector and a unit-length query of `dims` components. */
	cosine(slot: number, query: Float32Array): number {
		const offset = slot * this.dims;
		let sum = 0;
		for (let i = 0; i < this.dims; i++) {
			sum += this.data[offset + i] * query[i];
		}
		return sum * this.scales[slot];
	}

	raw(slot: number): { values: Int8Array; scale: number } {
		return { values: this.data.subarray(slot * this.dims, (slot + 1) * this.dims), scale: this.scales[slot] };
	}
}

/** The first `dims` components of `vector`, scaled to unit length. */
function normalize(vector: Float32Array, dims: number): Float32Array {
	const out = new Float32Array(dims);
	let norm = 0;
	for (let i = 0; i < dims && i < vector.length; i++) {
		out[i] = vector[i];
		norm += vector[i] * vector[i];
	}
	norm = Math.sqrt(norm) || 1;
	for (let i = 0; i < dims; i++) {
		out[i] /= norm;
	}
	return out;
}

// ---- index -----------------------------------------------------------------------------------

interface ChunkRecord {
	readonly start: number;
	readonly end: number;
	readonly hash: string;
	readonly slot: number;
}

interface FileRecord {
	readonly mtimeMs: number;
	readonly size: number;
	readonly chunks: ChunkRecord[];
}

export type SemanticState =
	| { readonly kind: 'starting' }
	| { readonly kind: 'disabled'; readonly reason: string }
	| { readonly kind: 'unavailable'; readonly reason: string }
	| { readonly kind: 'indexing' }
	| { readonly kind: 'ready' };

export interface SemanticHit {
	readonly path: string;
	readonly start: number;
	readonly end: number;
	/** Cosine similarity with the question, when the semantic index had the chunk. */
	readonly similarity?: number;
	/** The file matched keywords from the question. */
	readonly keyword: boolean;
}

export interface SemanticResult {
	readonly hits: SemanticHit[];
	/** "hybrid" (embeddings + keywords) or "keyword" (Instant Grep only, when embeddings are unavailable). */
	readonly mode: 'hybrid' | 'keyword';
	readonly note?: string;
	readonly keywords: string[];
	readonly indexedFiles: number;
	readonly candidateFiles: number;
	readonly chunks: number;
	readonly elapsedMs: number;
}

const FORMAT_VERSION = 1;
const RRF_K = 60;
const SEMANTIC_POOL = 150;
const KEYWORD_POOL = 40;
const FILES_PER_ROUND = 64;
const SAVE_INTERVAL_MS = 30_000;
/** How long a search waits for a starting index before answering from keywords alone. */
const SETTLE_MS = 2000;

/**
 * The semantic index for one workspace root. It follows the Instant Grep engine's file list,
 * embeds new and changed files in the background, and answers questions with hybrid ranking.
 */
export class SemanticIndex {
	private readonly store = new VectorStore();
	private files = new Map<string, FileRecord>();
	private model: string | undefined;
	private state: SemanticState = { kind: 'starting' };
	private disposed = false;
	private wake: (() => void) | undefined;
	private dirty = false;
	private lastSave = Date.now();
	private candidates = 0;
	private embedded = 0;
	private readonly subscription: { dispose(): void };
	private loading: Promise<void> | undefined;

	constructor(
		readonly root: string,
		private readonly engine: SearchEngine,
		private readonly storageDir: string | undefined,
		private readonly log: (line: string) => void = () => { },
		private readonly settings: () => Promise<SemanticSettings> = () => readSemanticSettings(),
	) {
		this.subscription = engine.onDidChange(() => this.wake?.());
	}

	get status(): SemanticState {
		return this.state;
	}

	get stats() {
		let chunks = 0;
		for (const record of this.files.values()) {
			chunks += record.chunks.length;
		}
		return { files: this.files.size, candidates: this.candidates, chunks, embedded: this.embedded, model: this.model, state: this.state.kind };
	}

	/** Starts the background indexer. */
	start(): void {
		void this.run().catch(err => this.log(`[semantic] stopped: ${err instanceof Error ? err.message : String(err)}`));
	}

	dispose(): void {
		this.disposed = true;
		this.subscription.dispose();
		this.wake?.();
		void this.save();
	}

	/** Resolves when every candidate file is embedded (or embedding is unavailable). For tests. */
	async whenIdle(timeoutMs = 60_000): Promise<SemanticState> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && (this.state.kind === 'starting' || this.state.kind === 'indexing' || !this.engine.isReady)) {
			await sleep(25);
		}
		return this.state;
	}

	private async run(): Promise<void> {
		await this.engine.start();
		while (!this.disposed) {
			const settings = await this.settings();
			if (!settings.enabled) {
				this.state = { kind: 'disabled', reason: 'semantic search is turned off (setting `dragon.semanticSearch.enabled`)' };
				await this.idle(15_000);
				continue;
			}
			const installed = await installedModels(settings.origin);
			if (typeof installed === 'string' || !hasOllamaModel(installed, settings.model)) {
				this.state = {
					kind: 'unavailable',
					reason: typeof installed === 'string' ? installed : `the embedding model ${settings.model} is not installed in Ollama (run "Dragon: Set Up Semantic Search", or \`ollama pull ${settings.model}\`)`,
				};
				await this.idle(30_000);
				continue;
			}
			if (this.model !== settings.model) {
				await this.useModel(settings.model);
			}
			const { work, total } = this.pending();
			this.candidates = total;
			if (!work.length) {
				this.state = { kind: 'ready' };
				await this.save();
				await this.idle(60_000);
				continue;
			}
			this.state = { kind: 'indexing' };
			try {
				await this.indexFiles(work.slice(0, FILES_PER_ROUND), settings);
			} catch (err) {
				this.state = { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
				this.log(`[semantic] ${this.state.reason}`);
				await this.idle(30_000);
				continue;
			}
			if (Date.now() - this.lastSave > SAVE_INTERVAL_MS) {
				await this.save();
			}
		}
	}

	/** Waits for an index change, a timeout or disposal. */
	private idle(ms: number): Promise<void> {
		return new Promise(resolve => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this.wake = () => {
				this.wake = undefined;
				done();
			};
		});
	}

	/** Candidate files that are new or changed since they were embedded, tests last. Drops records of removed files. */
	private pending(): { work: { path: string; mtimeMs: number; size: number }[]; total: number } {
		const live = this.engine.textFiles().filter(f => isSemanticCandidate(f.path, f.size));
		const seen = new Set(live.map(f => f.path));
		for (const [rel, record] of this.files) {
			if (!seen.has(rel)) {
				this.drop(record);
				this.files.delete(rel);
				this.dirty = true;
			}
		}
		const work = live.filter(f => {
			const record = this.files.get(f.path);
			return !record || record.mtimeMs !== f.mtimeMs || record.size !== f.size;
		});
		work.sort((a, b) => priority(a.path) - priority(b.path) || a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1));
		return { work, total: live.length };
	}

	private drop(record: FileRecord): void {
		for (const chunk of record.chunks) {
			this.store.release(chunk.slot);
		}
	}

	private async indexFiles(files: readonly { path: string; mtimeMs: number; size: number }[], settings: SemanticSettings): Promise<void> {
		const jobs: { rel: string; stat: { mtimeMs: number; size: number }; chunks: { chunk: CodeChunk; hash: string; input: string; slot?: number }[] }[] = [];
		for (const file of files) {
			let text: string;
			try {
				text = await fs.readFile(path.join(this.root, file.path), 'utf8');
			} catch {
				continue; // removed meanwhile; the next round drops it
			}
			const lines = text.split('\n');
			const chunks = lines.length && text.length / lines.length > 300 ? [] : chunkCode(text); // minified or data: skip
			const previous = new Map((this.files.get(file.path)?.chunks ?? []).map(c => [c.hash, c]));
			jobs.push({
				rel: file.path,
				stat: file,
				chunks: chunks.map(chunk => {
					const input = documentInput(settings.model, file.path, chunk.text);
					const hash = createHash('sha1').update(input).digest('hex').slice(0, 20);
					const reused = previous.get(hash);
					previous.delete(hash); // a slot is reused at most once, even if a chunk repeats
					return { chunk, hash, input, slot: reused?.slot };
				}),
			});
		}
		const missing = jobs.flatMap(job => job.chunks.filter(c => c.slot === undefined));
		for (let i = 0; i < missing.length && !this.disposed; i += EMBED_BATCH) {
			const batch = missing.slice(i, i + EMBED_BATCH);
			const vectors = await embed(settings.origin, settings.model, batch.map(c => c.input));
			if (!this.store.dims) {
				this.store.reset(Math.min(MAX_DIMS, vectors[0].length));
			}
			batch.forEach((c, j) => c.slot = this.store.add(vectors[j]));
			this.embedded += batch.length;
		}
		if (this.disposed) {
			return;
		}
		for (const job of jobs) {
			const kept = new Set(job.chunks.map(c => c.slot));
			const old = this.files.get(job.rel);
			for (const chunk of old?.chunks ?? []) {
				if (!kept.has(chunk.slot)) {
					this.store.release(chunk.slot);
				}
			}
			this.files.set(job.rel, {
				mtimeMs: job.stat.mtimeMs,
				size: job.stat.size,
				chunks: job.chunks.map(c => ({ start: c.chunk.start, end: c.chunk.end, hash: c.hash, slot: c.slot! })),
			});
		}
		this.dirty = true;
	}

	/** Switches to `model`: loads its saved vectors, or starts empty. */
	private async useModel(model: string): Promise<void> {
		this.loading ??= this.load(model).finally(() => this.loading = undefined);
		await this.loading;
	}

	private file(): string | undefined {
		if (!this.storageDir) {
			return undefined;
		}
		const hash = createHash('sha256').update(this.root).digest('hex').slice(0, 16);
		return path.join(this.storageDir, `${hash}.vectors`);
	}

	private async load(model: string): Promise<void> {
		this.model = model;
		this.files = new Map();
		this.store.reset(0);
		const file = this.file();
		if (!file) {
			return;
		}
		try {
			const buf = await fs.readFile(file);
			let o = 0;
			const headerLength = buf.readUInt32LE(o); o += 4;
			const header = JSON.parse(buf.toString('utf8', o, o + headerLength)) as { version: number; root: string; model: string; dims: number; files: [string, number, number, [number, number, string][]][] };
			o += headerLength;
			if (header.version !== FORMAT_VERSION || header.root !== this.root || header.model !== model) {
				return;
			}
			this.store.reset(header.dims);
			for (const [rel, mtimeMs, size, chunks] of header.files) {
				const records: ChunkRecord[] = [];
				for (const [start, end, hash] of chunks) {
					const scale = buf.readFloatLE(o); o += 4;
					const values = new Int8Array(buf.buffer.slice(buf.byteOffset + o, buf.byteOffset + o + header.dims)); o += header.dims;
					records.push({ start, end, hash, slot: this.store.addQuantized(values, scale) });
				}
				this.files.set(rel, { mtimeMs, size, chunks: records });
			}
			this.log(`[semantic] loaded ${this.files.size} files from ${file}`);
		} catch {
			this.files = new Map();
			this.store.reset(0);
		}
	}

	private async save(): Promise<void> {
		const file = this.file();
		if (!file || !this.dirty || !this.model) {
			return;
		}
		this.dirty = false;
		this.lastSave = Date.now();
		const dims = this.store.dims;
		const entries = [...this.files];
		const header = Buffer.from(JSON.stringify({
			version: FORMAT_VERSION, root: this.root, model: this.model, dims,
			files: entries.map(([rel, r]) => [rel, r.mtimeMs, r.size, r.chunks.map(c => [c.start, c.end, c.hash])]),
		}), 'utf8');
		const count = entries.reduce((n, [, r]) => n + r.chunks.length, 0);
		const buf = Buffer.alloc(4 + header.length + count * (4 + dims));
		let o = 0;
		buf.writeUInt32LE(header.length, o); o += 4;
		header.copy(buf, o); o += header.length;
		for (const [, record] of entries) {
			for (const chunk of record.chunks) {
				const { values, scale } = this.store.raw(chunk.slot);
				buf.writeFloatLE(scale, o); o += 4;
				Buffer.from(values.buffer, values.byteOffset, values.byteLength).copy(buf, o); o += dims;
			}
		}
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, buf);
			await fs.rename(tmp, file);
		} catch (err) {
			this.log(`[semantic] save failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ---- search ------------------------------------------------------------------------------

	/** Finds the code that best answers `query`, by meaning and by the identifiers it names. */
	async search(query: string, options: { under?: string; limit?: number; signal?: AbortSignal } = {}): Promise<SemanticResult> {
		const started = Date.now();
		const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
		const under = options.under?.replace(/\/$/, '');
		const inScope = (p: string) => !under || p === under || p.startsWith(`${under}/`);
		const keywords = extractKeywords(query);
		const settings = await this.settings();
		// Right after startup, give the index a moment to find the model and embed a small workspace.
		const settleUntil = started + SETTLE_MS;
		while (Date.now() < settleUntil && (this.state.kind === 'starting' || (this.state.kind === 'indexing' && !this.store.dims))) {
			await sleep(25);
		}
		const semanticReady = this.state.kind === 'ready' || this.state.kind === 'indexing';
		const [keywordFiles, queryVector] = await Promise.all([
			this.keywordFiles(keywords, under, options.signal),
			semanticReady && this.store.dims && this.model
				? embed(settings.origin, this.model, [queryInput(this.model, query)], options.signal).then(v => normalize(v[0], this.store.dims), (err: unknown) => err instanceof Error ? err : new Error(String(err)))
				: Promise.resolve(undefined),
		]);
		const base = { keywords: keywords.map(k => k.text), indexedFiles: this.files.size, candidateFiles: this.candidates, chunks: this.stats.chunks };

		if (!(queryVector instanceof Float32Array)) {
			const reason = queryVector instanceof Error ? queryVector.message
				: this.state.kind === 'disabled' || this.state.kind === 'unavailable' ? this.state.reason
					: this.state.kind === 'indexing' ? 'the semantic index is still being built' : 'the semantic index is still starting';
			const hits = await this.keywordHits(keywordFiles, keywords, under, limit, options.signal);
			return { ...base, hits, mode: 'keyword', note: `Semantic search is unavailable: ${reason}.`, elapsedMs: Date.now() - started };
		}

		// Score every chunk; remember each file's best chunk for keyword fusion.
		const scored: { path: string; chunk: ChunkRecord; similarity: number }[] = [];
		const bestByFile = new Map<string, { path: string; chunk: ChunkRecord; similarity: number }>();
		for (const [rel, record] of this.files) {
			if (!inScope(rel)) {
				continue;
			}
			for (const chunk of record.chunks) {
				const entry = { path: rel, chunk, similarity: this.store.cosine(chunk.slot, queryVector) };
				scored.push(entry);
				const best = bestByFile.get(rel);
				if (!best || entry.similarity > best.similarity) {
					bestByFile.set(rel, entry);
				}
			}
		}
		scored.sort((a, b) => b.similarity - a.similarity);
		const keywordRank = new Map([...keywordFiles].sort((a, b) => b[1] - a[1]).slice(0, KEYWORD_POOL).map(([rel], i) => [rel, i]));
		const fused = new Map<string, { entry: { path: string; chunk: ChunkRecord; similarity: number }; score: number; keyword: boolean }>();
		const add = (entry: { path: string; chunk: ChunkRecord; similarity: number }, semanticRank: number | undefined) => {
			const key = `${entry.path}:${entry.chunk.start}`;
			const current = fused.get(key);
			const rank = keywordRank.get(entry.path);
			const score = (semanticRank !== undefined ? 1 / (RRF_K + semanticRank) : 0) + (rank !== undefined ? 1 / (RRF_K + rank) : 0);
			if (!current || score > current.score) {
				fused.set(key, { entry, score, keyword: rank !== undefined });
			}
		};
		scored.slice(0, SEMANTIC_POOL).forEach((entry, i) => add(entry, i));
		const semanticRankOf = new Map(scored.slice(0, SEMANTIC_POOL).map((e, i) => [`${e.path}:${e.chunk.start}`, i]));
		for (const rel of keywordRank.keys()) {
			const best = bestByFile.get(rel);
			if (best) {
				add(best, semanticRankOf.get(`${best.path}:${best.chunk.start}`));
			}
		}
		const perFile = new Map<string, number>();
		const hits: SemanticHit[] = [];
		for (const { entry, keyword } of [...fused.values()].sort((a, b) => b.score - a.score || b.entry.similarity - a.entry.similarity)) {
			const count = perFile.get(entry.path) ?? 0;
			if (count >= 2) {
				continue;
			}
			perFile.set(entry.path, count + 1);
			hits.push({ path: entry.path, start: entry.chunk.start, end: entry.chunk.end, similarity: entry.similarity, keyword });
			if (hits.length >= limit) {
				break;
			}
		}
		// Keyword matches in files not embedded yet still deserve a place while indexing runs.
		if (hits.length < limit && keywordFiles.size) {
			const known = new Set(hits.map(h => h.path));
			const extra = (await this.keywordHits(new Map([...keywordFiles].filter(([rel]) => !this.files.has(rel) && !known.has(rel))), keywords, under, limit - hits.length, options.signal));
			hits.push(...extra);
		}
		const note = this.state.kind === 'indexing' ? `The semantic index is still being built (${this.files.size} of ${this.candidates} files so far); keyword matches cover the rest.` : undefined;
		return { ...base, hits, mode: 'hybrid', note, elapsedMs: Date.now() - started };
	}

	/** Files matching the question's keywords, scored by keyword weight and rarity (IDF). */
	private async keywordFiles(keywords: readonly Keyword[], under: string | undefined, signal: AbortSignal | undefined): Promise<Map<string, number>> {
		const scores = new Map<string, number>();
		const total = Math.max(1, this.engine.stats.files);
		await Promise.all(keywords.map(async ({ text, weight }) => {
			const result = await this.engine.grep({ pattern: text, fixedStrings: true, caseSensitive: false, filesOnly: true, maxResults: 100, under }, signal).catch(() => undefined);
			if (!result?.files.length) {
				return;
			}
			const idf = Math.log(1 + total / result.files.length);
			for (const rel of result.files) {
				scores.set(rel, (scores.get(rel) ?? 0) + weight * idf);
			}
		}));
		return scores;
	}

	/** Keyword-only hits: the best files, each with the lines around its first keyword match. */
	private async keywordHits(files: Map<string, number>, keywords: readonly Keyword[], under: string | undefined, limit: number, signal: AbortSignal | undefined): Promise<SemanticHit[]> {
		const top = [...files].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([rel]) => rel);
		if (!top.length) {
			return [];
		}
		const pattern = keywords.map(k => k.text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|');
		const result = await this.engine.grep({ pattern, caseSensitive: false, maxResults: 1000, under }, signal).catch(() => undefined);
		const firstLine = new Map<string, number>();
		for (const match of result?.matches ?? []) {
			if (!match.context && !firstLine.has(match.path)) {
				firstLine.set(match.path, match.line);
			}
		}
		return top.map(rel => {
			const line = firstLine.get(rel) ?? 1;
			return { path: rel, start: Math.max(1, line - 3), end: line + 12, keyword: true };
		});
	}
}

interface Keyword {
	readonly text: string;
	readonly weight: number;
}

const STOPWORDS = new Set((
	'the and for with that this from what where which when who how why does do did is are was were be been being can could should would will ' +
	'may might must into onto over under about above below than then there here their them they our your you its not all any each every some such ' +
	'only own same too very just also but else code file files function functions method methods class classes find show use used using uses get ' +
	'set make made work works handle handles handled implement implemented implementation logic call calls called happen happens need needs want'
).split(' '));

/** Identifiers and distinctive words in a question, most specific first: `backticked` text, then code-like names, then words. */
export function extractKeywords(query: string): Keyword[] {
	const weights = new Map<string, number>();
	for (const match of query.matchAll(/`([^`\n]{3,80})`/g)) {
		weights.set(match[1].trim(), 3);
	}
	for (const match of query.replace(/`[^`\n]*`/g, ' ').matchAll(/[A-Za-z_$][\w$]*/g)) {
		const token = match[0];
		if (token.length < 3 || STOPWORDS.has(token.toLowerCase())) {
			continue;
		}
		const codeLike = /[a-z][A-Z]|_|\d|^[A-Z]{2,}$|\$/.test(token);
		weights.set(token, Math.max(weights.get(token) ?? 0, codeLike ? 2 : 1));
	}
	return [...weights]
		.map(([text, weight]) => ({ text, weight }))
		.sort((a, b) => b.weight - a.weight || b.text.length - a.text.length)
		.slice(0, 6);
}

/** Renders a result as text for the model, with the code of each hit. */
export async function formatSemantic(root: string, result: SemanticResult, query: string): Promise<string> {
	const how = result.mode === 'hybrid'
		? `semantic + keyword; ${result.chunks} chunks from ${result.indexedFiles} files`
		: `keyword only${result.keywords.length ? `: ${result.keywords.join(', ')}` : ''}`;
	const lines = [`${result.hits.length ? `${result.hits.length} result(s)` : 'No results'} for ${JSON.stringify(query)} (${how}; ${result.elapsedMs} ms).`];
	if (result.note) {
		lines.push(result.note);
	}
	if (!result.hits.length && !result.keywords.length && result.mode === 'keyword') {
		lines.push('Name an identifier, or use grep for exact text.');
	}
	for (const hit of result.hits) {
		let text: string[] = [];
		try {
			text = (await fs.readFile(path.join(root, hit.path), 'utf8')).split('\n');
		} catch {
			continue;
		}
		if (text.length > 1 && text[text.length - 1] === '') {
			text.pop(); // the final newline does not start another line
		}
		const end = Math.min(hit.end, text.length);
		const shownEnd = Math.min(end, hit.start + 39);
		lines.push('', `${hit.path}:${hit.start}-${end}${hit.similarity !== undefined ? ` (similarity ${hit.similarity.toFixed(2)}${hit.keyword ? ', keyword match' : ''})` : ' (keyword match)'}`);
		for (let i = hit.start; i <= shownEnd; i++) {
			const line = text[i - 1] ?? '';
			lines.push(`${i}: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
		}
		if (shownEnd < end) {
			lines.push(`… ${end - shownEnd} more line(s)`);
		}
	}
	return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
