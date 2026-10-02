/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FSWatcher, promises as fs, watch } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { fuzzyScore, globToRegExp, isGlob } from './fuzzy';
import { indexFileFor, MERGE_POSTINGS, readIndexable, TrigramIndex } from './index';
import { planLiteral, planRegex, Query } from './planner';
import { spawn } from 'node:child_process';
import { ALWAYS_SKIPPED, listFiles, streamRipgrep } from './ripgrep';

export interface GrepParams {
	readonly pattern: string;
	/** Treat the pattern as a literal string instead of a regex. */
	readonly fixedStrings?: boolean;
	/** true = case-sensitive, false = insensitive, undefined = smart case (sensitive only if the pattern has uppercase). */
	readonly caseSensitive?: boolean;
	/** Glob(s) the path must match, e.g. `src/**\/*.ts` or `*.{ts,tsx}`. */
	readonly include?: readonly string[];
	/** Glob(s) to leave out. */
	readonly exclude?: readonly string[];
	/** Restrict to this file or directory (relative to the root). */
	readonly under?: string;
	/** Lines of context around each match (0-10). */
	readonly context?: number;
	/** Maximum matching lines to return (default 100, max 1000). */
	readonly maxResults?: number;
	/** Let `.` and character classes match newlines (ripgrep --multiline). */
	readonly multiline?: boolean;
	/** Only list matching files, not lines. */
	readonly filesOnly?: boolean;
}

export interface GrepMatch {
	readonly path: string;
	readonly line: number;
	readonly text: string;
	readonly context?: boolean;
}

export interface GrepResult {
	readonly matches: GrepMatch[];
	readonly files: string[];
	readonly totalMatches: number;
	readonly truncated: boolean;
	/** How the search ran: "index" (narrowed by the trigram index) or "scan" (full ripgrep). */
	readonly mode: 'index' | 'scan';
	readonly candidates: number;
	readonly totalFiles: number;
	readonly elapsedMs: number;
}

export interface SearchEngineOptions {
	readonly home?: string;
	readonly maxFiles?: number;
	readonly freeBytes?: () => Promise<number>;
	readonly spillPostings?: number;
}

/** Never recursively index a whole account or disk, including a symlink to one. */
export function unindexableRoot(root: string, home: string): boolean {
	const normalize = (p: string) => process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase();
	const dir = normalize(root);
	const account = normalize(home);
	const relative = path.relative(dir, account);
	return dir === path.parse(dir).root || relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

const MIN_FREE_BYTES = 2 * 1024 ** 3;
const MAX_INDEX_BYTES = 512 * 1024 ** 2;
class IndexBudgetError extends Error { }

const MAX_EXPLICIT_CANDIDATES = 20_000;
const IN_PROCESS_MAX_FILES = 1000;
/** Total bytes read in-process for one query; beyond it the remaining files go to ripgrep. */
const IN_PROCESS_MAX_BYTES = 16 * 1024 * 1024;
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Instant Grep for one workspace root: a persistent trigram index kept fresh by a file watcher,
 * with every answer verified by ripgrep so results are exactly ripgrep's.
 */
export class SearchEngine {
	private index: TrigramIndex;
	private ready = false;
	private disabledReason: string | undefined;
	private freeFloor = MIN_FREE_BYTES;
	private building: Promise<void> | undefined;
	private watcher: FSWatcher | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private saveTimer: NodeJS.Timeout | undefined;
	private changedSinceSave = false;
	/** Serializes work that adds files to the index with the merges that rewrite it. */
	private queue: Promise<unknown> = Promise.resolve();
	private ripgrepRuns = 0;
	private readonly listeners = new Set<() => void>();

	constructor(readonly root: string, private readonly rg: string, private readonly storageDir: string | undefined, private readonly log: (line: string) => void = () => { }, private readonly options: SearchEngineOptions = {}) {
		this.index = new TrigramIndex(root, storageDir ? indexFileFor(storageDir, root) : undefined, options.spillPostings);
	}

	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	get isReady(): boolean {
		return this.ready;
	}

	get stats() {
		return { ...this.index.stats, ready: this.ready, disabledReason: this.disabledReason, ripgrepRuns: this.ripgrepRuns };
	}

	/** Text files as last indexed. Empty until the index is ready. */
	textFiles(): { path: string; mtimeMs: number; size: number }[] {
		return this.ready ? this.index.textFiles() : [];
	}

	/** Calls `listener` whenever the index changes (after the initial build and after re-indexing edits). */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	private fire(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// a listener's failure is its own
			}
		}
	}

	/** Loads the saved index (if any), starts watching, and reconciles with the disk in the background. */
	start(): Promise<void> {
		this.building ??= this.build();
		return this.building;
	}

	private build(): Promise<void> {
		return this.exclusive(async () => {
			try { await this.reconcile(); } catch (err) {
				await this.disable(err instanceof Error ? err.message : String(err));
			}
		});
	}

	private async freeBytes(): Promise<number> {
		if (this.options.freeBytes) { return this.options.freeBytes(); }
		let dir = this.storageDir ?? this.root;
		for (; ;) {
			try {
				const stat = await fs.statfs(dir);
				return stat.bavail * stat.bsize;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(dir) === dir) { throw err; }
				dir = path.dirname(dir);
			}
		}
	}

	private async checkBudget(): Promise<void> {
		const { mappedBytes, memoryBytes, files } = this.index.stats;
		const bytes = mappedBytes + memoryBytes;
		if (files > (this.options.maxFiles ?? 500_000) || bytes > MAX_INDEX_BYTES) {
			throw new IndexBudgetError('index size limit reached');
		}
		if (this.storageDir && (await this.freeBytes()) - bytes * 2 < this.freeFloor) {
			throw new IndexBudgetError('index disk-space reserve reached');
		}
	}

	private async disable(reason: string): Promise<void> {
		this.ready = false;
		this.disabledReason = reason;
		this.watcher?.close();
		this.watcher = undefined;
		if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
		if (this.saveTimer) { clearTimeout(this.saveTimer); }
		await this.index.discardRuns();
		this.index = new TrigramIndex(this.root);
		this.changedSinceSave = false;
		this.log(`[instant-grep] ${reason}; searches will scan`);
	}

	private async reconcile(): Promise<void> {
		const started = Date.now();
		const root = await fs.realpath(this.root);
		const home = await fs.realpath(this.options.home ?? homedir()).catch(() => this.options.home ?? homedir());
		if (unindexableRoot(root, home)) { throw new IndexBudgetError('home directories and disk roots are not indexed'); }
		if (this.storageDir) { this.freeFloor = Math.max(MIN_FREE_BYTES, (await this.freeBytes()) / 2); }
		await this.checkBudget();
		if (this.storageDir) {
			const loaded = await TrigramIndex.load(indexFileFor(this.storageDir, this.root), this.root, this.options.spillPostings);
			if (loaded) {
				for (const rel of this.index.dirtyPaths()) {
					loaded.markDirty(rel); // changes seen while loading
				}
				this.index = loaded;
			}
		}
		await this.checkBudget();
		const files = await listFiles(this.rg, this.root);
		if (files.length > (this.options.maxFiles ?? 500_000)) { throw new IndexBudgetError('index file limit reached'); }
		this.watch();
		const live = new Set(files);
		for (const rel of this.index.paths()) {
			if (!live.has(rel)) {
				this.index.removeFile(rel);
			}
		}
		let changed = 0;
		for (const rel of files) {
			const abs = path.join(this.root, rel);
			try {
				const stat = await fs.stat(abs);
				if (!this.index.isCurrent(rel, stat)) {
					if (this.index.needsSpill) {
						await this.checkBudget();
						await this.index.spill(); // bounded before every spill
					}
					this.index.addFile(rel, await readIndexable(abs, stat.size), stat);
					changed++;
				}
			} catch (err) {
				if (err instanceof IndexBudgetError) { throw err; }
				this.index.removeFile(rel);
			}
		}
		await this.checkBudget();
		this.ready = !!this.watcher;
		this.changedSinceSave ||= changed > 0 || this.index.needsMerge;
		this.log(`[instant-grep] ${this.root}: ${files.length} files, ${changed} (re)indexed in ${Date.now() - started} ms`);
		await this.save();
		this.scheduleRefresh();
		this.fire();
	}

	private watch(): void {
		try {
			this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
				if (!filename) {
					return;
				}
				const rel = filename.toString().replace(/\\/g, '/');
				if (ALWAYS_SKIPPED.some(d => rel === d || rel.startsWith(`${d}/`) || rel.includes(`/${d}/`))) {
					return;
				}
				this.index.markDirty(rel);
				this.scheduleRefresh();
			});
			this.watcher.on('error', err => { void this.exclusive(() => this.disable(`watcher error: ${err.message}`)); });
		} catch (err) {
			// Without a watcher every query re-checks nothing, so fall back to scanning.
			this.log(`[instant-grep] file watching unavailable (${err instanceof Error ? err.message : String(err)}); searches will scan`);
			this.ready = false;
		}
	}

	private scheduleRefresh(): void {
		if (this.disabledReason) { return; }
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => void this.refreshDirty(), REFRESH_DEBOUNCE_MS);
	}

	private refreshDirty(): Promise<void> {
		return this.exclusive(() => this.refreshDirtyNow());
	}

	private async refreshDirtyNow(): Promise<void> {
		const dirty = this.index.dirtyPaths();
		if (!dirty.length || !this.ready) {
			return;
		}
		// New paths that .gitignore excludes (build output, caches) are not searched, as with ripgrep.
		const known = new Set(this.index.paths());
		const ignored = await gitIgnored(this.root, dirty.filter(rel => !known.has(rel)));
		for (const rel of ignored) {
			this.index.forget(rel);
		}
		await forEachLimit(dirty.filter(rel => !ignored.has(rel)), 16, rel => this.index.refreshFile(rel));
		this.changedSinceSave = true;
		this.fire();
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => void this.exclusive(() => this.saveIfWorthIt()), 10_000);
	}

	/**
	 * Edits live in the index's in-memory delta; a restart re-indexes them from their mtimes, so
	 * they need not be saved. A small index is saved anyway (cheap, and restarts stay instant);
	 * a large one only once enough has changed to be worth rewriting it.
	 */
	private async saveIfWorthIt(): Promise<void> {
		if (this.index.needsMerge || this.index.stats.postings <= 4 * MERGE_POSTINGS) {
			await this.save();
		}
	}

	private async save(): Promise<void> {
		if (!this.changedSinceSave || this.disabledReason) {
			return;
		}
		this.changedSinceSave = false;
		const started = Date.now();
		try {
			await this.checkBudget();
			await this.index.save();
			const { postings, mappedBytes, memoryBytes } = this.index.stats;
			this.log(`[instant-grep] ${this.root}: saved ${postings} postings in ${Date.now() - started} ms (${mappedBytes} bytes mapped, ${memoryBytes} in memory)`);
		} catch (err) {
			await this.disable(err instanceof Error ? err.message : String(err));
			this.log(`[instant-grep] save failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	dispose(): void {
		this.listeners.clear();
		this.watcher?.close();
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
	}

	/** Regex or literal search. Narrowed by the index when it is ready, verified by ripgrep always. */
	async grep(params: GrepParams, signal?: AbortSignal): Promise<GrepResult> {
		const started = Date.now();
		const query: Query = params.fixedStrings ? planLiteral(params.pattern) : planRegex(params.pattern);
		let candidates: string[] | undefined = this.ready ? this.index.candidates(query) : undefined;
		const include = (params.include ?? []).map(globToRegExp);
		const exclude = (params.exclude ?? []).map(globToRegExp);
		const under = params.under?.replace(/\/$/, '');
		const inScope = (p: string) => !under || p === under || p.startsWith(`${under}/`);
		if (candidates) {
			candidates = candidates.filter(p => inScope(p) && (!include.length || include.some(r => r.test(p))) && !exclude.some(r => r.test(p)));
		}
		const totalFiles = this.index.stats.files;
		const maxResults = clamp(params.maxResults ?? 100, 1, 1000);
		const context = clamp(params.context ?? 0, 0, 10);

		const args = ['--no-messages'];
		if (!params.filesOnly) {
			args.push('--json');
		}
		if (params.fixedStrings) {
			args.push('--fixed-strings');
		}
		args.push(params.caseSensitive === true ? '--case-sensitive' : params.caseSensitive === false ? '--ignore-case' : '--smart-case');
		if (params.multiline) {
			args.push('--multiline', '--multiline-dotall');
		}
		if (context && !params.filesOnly) {
			args.push('--context', String(context));
		}
		if (params.filesOnly) {
			args.push('--files-with-matches');
		}
		args.push('-e', params.pattern);

		let mode: GrepResult['mode'];
		if (candidates && candidates.length <= MAX_EXPLICIT_CANDIDATES) {
			mode = 'index';
			if (!candidates.length) {
				return { matches: [], files: [], totalMatches: 0, truncated: false, mode, candidates: 0, totalFiles, elapsedMs: Date.now() - started };
			}
		} else {
			mode = 'scan';
			candidates = undefined;
			args.push('--hidden');
			for (const g of params.include ?? []) {
				args.push('-g', g);
			}
			for (const g of params.exclude ?? []) {
				args.push('-g', `!${g}`);
			}
			for (const d of ALWAYS_SKIPPED) {
				args.push('-g', `!**/${d}/**`);
			}
		}

		const acc: Collected = { matches: [], files: new Set(), totalMatches: 0, shown: 0, truncated: false };
		let rgTargets = candidates;

		// Fast path: a literal over a modest set of indexed, unchanged candidates is verified
		// in-process, without spawning ripgrep. Files ripgrep could read differently (byte-order
		// marks, NUL bytes, invalid UTF-8) are handed to ripgrep, which then runs only on those.
		const matcher = inProcessMatcher(params);
		if (candidates && matcher && candidates.length <= IN_PROCESS_MAX_FILES && this.fitsInProcess(candidates)) {
			rgTargets = await this.grepInProcess(candidates, matcher, params, maxResults, context, acc);
			if (acc.truncated || !rgTargets.length) {
				return this.result(acc, mode, candidates.length, totalFiles, started);
			}
		}

		const batches = rgTargets ? chunk(rgTargets, 2000) : [undefined];
		for (const batch of batches) {
			if (acc.truncated) {
				break;
			}
			this.ripgrepRuns++;
			const result = await streamRipgrep(this.rg, batch ? [...args, '--', ...batch] : [...args, '--', under ?? '.'], this.root, line => {
				if (!line) {
					return true;
				}
				if (params.filesOnly) {
					acc.files.add(normalizePath(line));
					acc.totalMatches++;
					return acc.files.size < maxResults * 10;
				}
				let event: { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
				try {
					event = JSON.parse(line);
				} catch {
					return true;
				}
				if (event.type !== 'match' && event.type !== 'context') {
					return true;
				}
				const p = normalizePath(event.data?.path?.text ?? '');
				if (event.type === 'match') {
					acc.totalMatches++;
					if (acc.shown >= maxResults) {
						return false; // enough: stop ripgrep
					}
					acc.files.add(p);
					acc.shown++;
				}
				acc.matches.push({ path: p, line: event.data?.line_number ?? 0, text: (event.data?.lines?.text ?? '').replace(/\r?\n$/, ''), context: event.type === 'context' });
				return true;
			}, signal);
			acc.truncated ||= result.stopped;
		}
		return this.result(acc, mode, candidates?.length ?? totalFiles, totalFiles, started);
	}

	/** True when every candidate is indexed and unchanged, and together they are small enough to read in-process. */
	private fitsInProcess(candidates: readonly string[]): boolean {
		let bytes = 0;
		for (const p of candidates) {
			const size = this.index.indexedSize(p);
			if (size === undefined || (bytes += size) > IN_PROCESS_MAX_BYTES) {
				return false;
			}
		}
		return true;
	}

	private result(acc: Collected, mode: GrepResult['mode'], candidates: number, totalFiles: number, started: number): GrepResult {
		return {
			matches: sortMatches(acc.matches),
			files: [...acc.files].sort(),
			totalMatches: acc.totalMatches,
			truncated: acc.truncated,
			mode,
			candidates,
			totalFiles,
			elapsedMs: Date.now() - started,
		};
	}

	/**
	 * Verifies `candidates` in-process, adding to `acc`, in path order. Returns the files it could
	 * not verify exactly as ripgrep would (byte-order marks, NUL bytes, invalid UTF-8), for ripgrep.
	 */
	private async grepInProcess(candidates: readonly string[], matcher: LiteralMatcher, params: GrepParams, maxResults: number, context: number, acc: Collected): Promise<string[]> {
		const fallback: string[] = [];
		const contents = new Map<string, Buffer>();
		await forEachLimit([...candidates], 64, async rel => {
			try {
				contents.set(rel, await fs.readFile(path.join(this.root, rel)));
			} catch {
				// deleted since it was indexed: nothing to match
			}
		});
		for (const rel of [...contents.keys()].sort()) {
			if (acc.truncated) {
				break;
			}
			const bytes = contents.get(rel)!;
			if (hasByteOrderMark(bytes) || bytes.includes(0)) {
				fallback.push(rel);
				continue;
			}
			if (matcher.needle && !bytes.includes(matcher.needle)) {
				continue;
			}
			const text = bytes.toString('utf8');
			if (text.includes('\uFFFD')) {
				fallback.push(rel); // invalid UTF-8 (or a literal U+FFFD): ripgrep reports raw bytes
				continue;
			}
			if (!matcher.test(text)) {
				continue;
			}
			if (params.filesOnly) {
				acc.files.add(rel);
				acc.totalMatches++;
				acc.truncated = acc.files.size >= maxResults * 10;
				continue;
			}
			const lines = text.split('\n');
			if (lines.length && lines[lines.length - 1] === '') {
				lines.pop();
			}
			const hits: number[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (matcher.test(lines[i])) {
					acc.totalMatches++;
					if (acc.shown >= maxResults) {
						acc.truncated = true;
						break;
					}
					acc.shown++;
					hits.push(i);
				}
			}
			if (!hits.length) {
				continue;
			}
			acc.files.add(rel);
			const hitSet = new Set(hits);
			const emitted = new Set<number>();
			for (const i of hits) {
				for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
					if (!emitted.has(j)) {
						emitted.add(j);
						acc.matches.push({ path: rel, line: j + 1, text: lines[j].replace(/\r$/, ''), context: !hitSet.has(j) });
					}
				}
			}
		}
		return fallback;
	}

	/** Fuzzy or glob file lookup over the indexed file list. Hidden paths only when asked for. */
	async findFiles(pattern: string, maxResults = 50, options: { hidden?: boolean; under?: string } = {}): Promise<string[]> {
		let paths = this.ready ? this.index.paths() : await listFiles(this.rg, this.root);
		if (!options.hidden) {
			paths = paths.filter(p => !/(^|\/)\./.test(p));
		}
		if (options.under) {
			const prefix = options.under.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/$/, '');
			paths = prefix ? paths.filter(p => p === prefix || p.startsWith(`${prefix}/`)) : paths;
		}
		if (isGlob(pattern)) {
			const re = globToRegExp(pattern);
			return paths.filter(p => re.test(p)).sort().slice(0, clamp(maxResults, 1, 1000));
		}
		return paths
			.map(p => ({ p, score: fuzzyScore(pattern, p) }))
			.filter((x): x is { p: string; score: number } => x.score !== undefined)
			.sort((a, b) => b.score - a.score)
			.slice(0, clamp(maxResults, 1, 1000))
			.map(x => x.p);
	}
}

/** Renders a grep result as compact text for the model. */
export function formatGrep(result: GrepResult, params: GrepParams): string {
	const how = result.mode === 'index'
		? `instant index: ${result.candidates} candidate file(s) of ${result.totalFiles}`
		: 'full scan';
	if (!result.totalMatches) {
		return `No matches for ${JSON.stringify(params.pattern)} (${how}, ${result.elapsedMs} ms).`;
	}
	const count = result.truncated ? `More than ${result.totalMatches - 1} match(es)` : `${result.totalMatches} match(es)`;
	const header = `${count} in ${result.files.length}${result.truncated ? '+' : ''} file(s) (${how}, ${result.elapsedMs} ms)${result.truncated ? `; showing the first ${params.maxResults ?? 100}. Narrow the pattern or add include globs for more` : ''}.`;
	if (params.filesOnly) {
		return `${header}\n${result.files.join('\n')}`;
	}
	const lines: string[] = [header];
	let current = '';
	for (const m of result.matches) {
		if (m.path !== current) {
			current = m.path;
			lines.push('', m.path);
		}
		lines.push(`${m.line}${m.context ? '-' : ':'} ${m.text.length > 400 ? `${m.text.slice(0, 400)}…` : m.text}`);
	}
	return lines.join('\n');
}

interface Collected {
	readonly matches: GrepMatch[];
	readonly files: Set<string>;
	totalMatches: number;
	shown: number;
	truncated: boolean;
}

export interface LiteralMatcher {
	/** UTF-8 bytes every matching file contains; set for case-sensitive searches, to skip decoding. */
	readonly needle?: Buffer;
	test(text: string): boolean;
}

/**
 * A matcher for searches that can be verified in-process with exactly ripgrep's results, or
 * undefined. Only single-line literals qualify: fixed strings, or regexes without metacharacters.
 * Case-insensitive matching uses Unicode simple case folding, as ripgrep does, and smart case is
 * case-sensitive when the pattern has an uppercase letter.
 */
export function inProcessMatcher(params: GrepParams): LiteralMatcher | undefined {
	const literal = params.pattern;
	if (params.multiline || !literal || /[\n\r\uFFFD]/.test(literal)) {
		return undefined;
	}
	if (!params.fixedStrings && /[\\^$.|?*+()[\]{}]/.test(literal)) {
		return undefined;
	}
	const sensitive = params.caseSensitive === true || (params.caseSensitive === undefined && /\p{Uppercase}/u.test(literal));
	if (sensitive) {
		return { needle: Buffer.from(literal, 'utf8'), test: text => text.includes(literal) };
	}
	const re = new RegExp(literal.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'iu');
	return { test: text => re.test(text) };
}

function hasByteOrderMark(bytes: Buffer): boolean {
	return (bytes.length >= 2 && ((bytes[0] === 0xFF && bytes[1] === 0xFE) || (bytes[0] === 0xFE && bytes[1] === 0xFF)))
		|| (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF);
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function sortMatches(matches: GrepMatch[]): GrepMatch[] {
	return matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			await fn(items[next++]);
		}
	}));
}

/** Which of `paths` git ignores. Outside a git repository nothing is ignored. */
export function gitIgnored(root: string, paths: readonly string[]): Promise<Set<string>> {
	if (!paths.length) {
		return Promise.resolve(new Set());
	}
	return new Promise(resolve => {
		const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: root, windowsHide: true });
		let out = '';
		child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
		child.on('error', () => resolve(new Set()));
		child.on('close', () => resolve(new Set(out.split('\0').filter(Boolean))));
		child.stdin.end(paths.join('\0') + '\0');
	});
}
