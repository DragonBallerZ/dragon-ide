/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Query } from './planner';
import { BLOOM_BITS_LOG2, bloomHas, bloomSet, extractTrigrams, gramHashes, nextBit, positionBit, rotl8, trigramKey } from './trigrams';

/** Files larger than this are not indexed; they are always searched directly instead. */
export const MAX_INDEXED_BYTES = 16 * 1024 * 1024;
const FORMAT_VERSION = 7;
const MAGIC = 0x49544744; // "DGTI"
/** Written in the machine's byte order; a file from a machine with the other order reads differently and is rebuilt. */
const BYTE_ORDER = 0x01020304;
const FIXED_HEADER_BYTES = 48;

/** Postings kept in memory before they are spilled to a run on disk (about 10 bytes each). */
export const SPILL_POSTINGS = 1 << 21;
/** Once the index is ready, edits are folded into the saved base segment after this many postings. */
export const MERGE_POSTINGS = 1 << 20;

/** Marker returned by readIndexable for binary files. */
export const BINARY = Symbol('binary');

interface FileEntry {
	path: string; // relative to the root, with forward slashes
	mtimeMs: number;
	size: number;
	/** false for files skipped by size: they are always candidates. */
	indexed: boolean;
	/** Binary files are never searched (ripgrep skips them too). */
	binary?: boolean;
	/** Removed from the tree; kept as a tombstone until the next merge. */
	deleted?: boolean;
}

/**
 * A read-only set of index documents with their posting lists, in compressed-sparse-row form:
 * the postings of `keys[k]` are `ids`/`masks` from `starts[k]` to `starts[k + 1]`, with local
 * document ids ascending. A segment is a saved base (memory-mapped when the runtime can), a run
 * spilled while indexing, or the frozen in-memory delta.
 */
interface IndexSegment {
	readonly keys: Uint32Array;
	readonly starts: Uint32Array;
	readonly ids: Uint32Array;
	/** `next << 8 | position` for each posting. */
	readonly masks: Uint16Array;
	/** Local document id -> file id. */
	readonly docFile: Uint32Array;
	/** Bloom document -> file id. */
	readonly bloomFiles: Uint32Array;
	/** BLOOM_WORDS words per bloom document. */
	readonly bloomBits: Uint32Array;
	/** The file backing the segment, if any. */
	readonly file?: string;
	/** True when the bytes are memory-mapped rather than held in memory. */
	readonly mapped: boolean;
	readonly byteLength: number;
}

interface SavedHeader {
	readonly root: string;
	readonly files: [string, number, number, number][];
}

export interface IndexStats {
	readonly files: number;
	readonly indexedFiles: number;
	/** Trigram keys summed over segments (a key present in two segments counts twice). */
	readonly trigrams: number;
	readonly blooms: number;
	readonly dirty: number;
	readonly postings: number;
	/** Segments on disk or frozen in memory, not counting the delta. */
	readonly segments: number;
	readonly deltaPostings: number;
	/** Bytes of segments that are memory-mapped: the OS pages them in and out. */
	readonly mappedBytes: number;
	/** Bytes of index data held in the process's own memory. */
	readonly memoryBytes: number;
}

/**
 * A local, case-folded trigram index over a workspace. It answers "which files could match"
 * and never "what matches": callers verify candidates with ripgrep. Correctness under edits is
 * kept by the dirty set, whose files are always candidates until they are re-indexed.
 *
 * Postings live in immutable segments plus an in-memory delta. The saved base segment is
 * memory-mapped where the runtime supports it (Bun on macOS and Linux, which is how OpenCode
 * runs the plugin), so a large repository's postings stay in the OS page cache rather than in
 * the process. New and changed files go to the delta; when it grows past `spillPostings` it is
 * written to a run on disk, and `save` merges everything into a new base.
 */
export class TrigramIndex {
	private files: FileEntry[] = [];
	private byPath = new Map<string, number>();
	private deletedFiles = 0;
	private segments: IndexSegment[] = [];
	private delta = new Delta();
	private readonly dirty = new Set<string>();
	private runs = 0;

	/**
	 * @param file where `save` writes the index and spilled runs go; without it everything stays in memory
	 * @param spillPostings how many postings the delta may hold before it is spilled
	 */
	constructor(readonly root: string, private file?: string, private readonly spillPostings = SPILL_POSTINGS) { }

	get stats(): IndexStats {
		let postings = this.delta.postings;
		let trigrams = 0;
		let blooms = this.delta.blooms;
		let mappedBytes = 0;
		let memoryBytes = this.delta.byteLength;
		for (const segment of this.segments) {
			postings += segment.ids.length;
			trigrams += segment.keys.length;
			blooms += segment.bloomFiles.length;
			if (segment.mapped) {
				mappedBytes += segment.byteLength;
			} else {
				memoryBytes += segment.byteLength;
			}
		}
		return {
			files: this.byPath.size,
			indexedFiles: this.files.filter(f => f.indexed && !f.deleted).length,
			trigrams,
			blooms,
			dirty: this.dirty.size,
			postings,
			segments: this.segments.length,
			deltaPostings: this.delta.postings,
			mappedBytes,
			memoryBytes,
		};
	}

	/** True when the delta should be spilled to disk before more files are added. */
	get needsSpill(): boolean {
		return this.delta.postings >= this.spillPostings;
	}

	/** True when enough has changed since the base was written that it is worth merging. */
	get needsMerge(): boolean {
		return this.segments.length > 1 || this.delta.postings >= Math.min(MERGE_POSTINGS, this.spillPostings) || this.deletedFiles > Math.max(64, this.files.length / 4);
	}

	/** Every live file path, relative to the root. */
	paths(): string[] {
		return this.files.filter(f => !f.deleted).map(f => f.path);
	}

	/** Every live text file whose content is indexed, with the size and mtime it was indexed at. */
	textFiles(): { path: string; mtimeMs: number; size: number }[] {
		return this.files.filter(f => !f.deleted && f.indexed).map(f => ({ path: f.path, mtimeMs: f.mtimeMs, size: f.size }));
	}

	/** Marks a file as changed (edited, created or deleted). It stays a candidate until re-indexed. */
	markDirty(relativePath: string): void {
		this.dirty.add(toPosix(relativePath));
	}

	/** Drops a dirty path without indexing it (for example because it is git-ignored). */
	forget(relativePath: string): void {
		const rel = toPosix(relativePath);
		this.dirty.delete(rel);
		this.removeFile(rel);
	}

	dirtyPaths(): string[] {
		return [...this.dirty];
	}

	/** Adds or replaces a file's content in the index. */
	addFile(relativePath: string, content: string | undefined | typeof BINARY, stat: { mtimeMs: number; size: number }): void {
		const rel = toPosix(relativePath);
		const previous = this.byPath.get(rel);
		if (previous !== undefined) {
			this.markDeleted(previous); // old postings stay but point at a tombstone
		}
		const id = this.files.length;
		const binary = content === BINARY;
		const indexed = typeof content === 'string';
		this.files.push({ path: rel, mtimeMs: stat.mtimeMs, size: stat.size, indexed, binary });
		this.byPath.set(rel, id);
		if (typeof content === 'string') {
			// Large files are indexed in line-aligned chunks so their masks do not saturate. A match
			// never spans lines, so every single-line literal lies inside one chunk. Very long lines
			// go into overlapping bloom documents instead (see segmentsOf).
			for (const segment of segmentsOf(content)) {
				if (segment.bloom) {
					this.delta.addBloom(id, segment.text);
				} else {
					this.delta.addDocument(id, extractTrigrams(segment.text));
				}
			}
		}
	}

	removeFile(relativePath: string): void {
		const rel = toPosix(relativePath);
		const id = this.byPath.get(rel);
		if (id !== undefined) {
			this.markDeleted(id);
			this.byPath.delete(rel);
		}
	}

	private markDeleted(id: number): void {
		if (!this.files[id].deleted) {
			this.files[id].deleted = true;
			this.deletedFiles++;
		}
	}

	/** Reads a file from disk and (re)indexes it, clearing its dirty flag. */
	async refreshFile(relativePath: string): Promise<void> {
		const rel = toPosix(relativePath);
		const abs = path.join(this.root, rel);
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile()) {
				this.removeFile(rel);
			} else {
				this.addFile(rel, await readIndexable(abs, stat.size), stat);
			}
		} catch {
			this.removeFile(rel);
		}
		this.dirty.delete(rel);
	}

	/** True when the file's content is in the index (known, text, not dirty) and at most `maxBytes` long. */
	isIndexed(relativePath: string, maxBytes = Infinity): boolean {
		const size = this.indexedSize(relativePath);
		return size !== undefined && size <= maxBytes;
	}

	/** The size of the file as indexed, or undefined when its content is not in the index (unknown, binary, too large or dirty). */
	indexedSize(relativePath: string): number | undefined {
		const rel = toPosix(relativePath);
		const id = this.byPath.get(rel);
		return id !== undefined && this.files[id].indexed && !this.dirty.has(rel) ? this.files[id].size : undefined;
	}

	/** True when `relativePath` is known with this exact mtime and size. */
	isCurrent(relativePath: string, stat: { mtimeMs: number; size: number }): boolean {
		const id = this.byPath.get(toPosix(relativePath));
		if (id === undefined) {
			return false;
		}
		const entry = this.files[id];
		return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
	}

	/**
	 * Files that could match `query`: index hits, plus every dirty or unindexed file.
	 * Returns undefined when the query cannot narrow anything (search everything).
	 */
	candidates(query: Query): string[] | undefined {
		const ids = this.evaluate(query, this.sources());
		if (!ids) {
			return undefined;
		}
		const out = new Set<string>();
		for (const id of ids) {
			const entry = this.files[id];
			if (entry && !entry.deleted) {
				out.add(entry.path);
			}
		}
		for (const entry of this.files) {
			if (!entry.deleted && !entry.indexed && !entry.binary) {
				out.add(entry.path);
			}
		}
		for (const rel of this.dirty) {
			out.add(rel);
		}
		return [...out];
	}

	/** Every segment a query must read, the delta last. */
	private sources(): IndexSegment[] {
		return this.delta.isEmpty ? this.segments : [...this.segments, this.delta.freeze()];
	}

	private evaluate(query: Query, sources: readonly IndexSegment[]): Set<number> | undefined {
		switch (query.kind) {
			case 'all':
				return undefined;
			case 'lit': {
				const files = new Set<number>();
				for (const segment of sources) {
					postingsLiteral(segment, query.text, files);
				}
				for (const id of bloomLiteral(sources, query.text)) {
					files.add(id);
				}
				return files;
			}
			case 'and': {
				let acc: Set<number> | undefined;
				for (const item of query.items) {
					const ids = this.evaluate(item, sources);
					if (!ids) {
						continue;
					}
					acc = acc ? intersect(acc, ids) : ids;
					if (acc.size === 0) {
						return acc;
					}
				}
				return acc;
			}
			case 'or': {
				const acc = new Set<number>();
				for (const item of query.items) {
					const ids = this.evaluate(item, sources);
					if (!ids) {
						return undefined;
					}
					for (const id of ids) {
						acc.add(id);
					}
				}
				return acc;
			}
		}
	}

	// ---- persistence -------------------------------------------------------------------------

	/**
	 * Writes the delta to a run on disk (or, without a file, freezes it in memory) and starts a
	 * new delta. Safe to call while other files are being added: runs keep the current file ids.
	 */
	async spill(): Promise<void> {
		if (this.delta.isEmpty) {
			return;
		}
		const frozen = this.delta.freeze();
		this.delta = new Delta();
		this.segments.push(frozen);
		if (!this.file) {
			return;
		}
		const keep = new Int32Array(this.files.length);
		this.files.forEach((f, id) => keep[id] = f.deleted ? -1 : id);
		let run: IndexSegment;
		try {
			run = await writeSegment([frozen], keep, `${this.file}.run-${process.pid}-${++this.runs}`, undefined);
		} catch {
			return; // the disk is full or unwritable: the run stays in memory, which is still correct
		}
		const at = this.segments.indexOf(frozen);
		if (at >= 0) {
			this.segments[at] = run;
		} else {
			await removeQuietly(run.file); // merged into a new base while it was being written
		}
	}

	/**
	 * Merges every segment and the delta into one new base segment, dropping deleted files, and
	 * writes it to `file` (then reads it back memory-mapped). Without a file the merge happens in
	 * memory. Files must not be added or removed until it finishes.
	 */
	async save(file = this.file): Promise<void> {
		const sources = this.sources();
		const fileRemap = new Int32Array(this.files.length).fill(-1);
		const files: FileEntry[] = [];
		this.files.forEach((f, id) => {
			if (!f.deleted) {
				fileRemap[id] = files.length;
				files.push(f);
			}
		});
		const header: SavedHeader = { root: this.root, files: files.map(f => [f.path, f.mtimeMs, f.size, f.indexed ? 1 : f.binary ? 2 : 0]) };
		const base = await writeSegment(sources, fileRemap, file, header);
		const previous = this.segments;
		this.files = files;
		this.byPath = new Map(files.map((f, id) => [f.path, id]));
		this.deletedFiles = 0;
		this.segments = [base];
		this.delta = new Delta();
		this.file = file;
		for (const segment of previous) {
			if (segment.file && segment.file !== file) {
				await removeQuietly(segment.file); // spilled runs; the old base was replaced by rename
			}
		}
	}

	/** Remove only spill files owned by this instance; retain the last complete base index. */
	async discardRuns(): Promise<void> {
		for (const segment of this.segments) {
			if (segment.file && segment.file !== this.file) { await removeQuietly(segment.file); }
		}
	}

	/** Loads an index written by `save`, or returns undefined when absent or incompatible. */
	static async load(file: string, root: string, spillPostings = SPILL_POSTINGS): Promise<TrigramIndex | undefined> {
		await removeOrphans(file);
		let opened: { segment: IndexSegment; header: SavedHeader | undefined } | undefined;
		try {
			opened = await openSegment(file);
		} catch {
			return undefined;
		}
		const header = opened?.header;
		if (!opened || !header || header.root !== root || !Array.isArray(header.files)) {
			return undefined;
		}
		const index = new TrigramIndex(root, file, spillPostings);
		index.files = header.files.map(([p, mtimeMs, size, kind]) => ({ path: p, mtimeMs, size, indexed: kind === 1, binary: kind === 2 }));
		index.files.forEach((f, id) => index.byPath.set(f.path, id));
		const { docFile, bloomFiles } = opened.segment;
		if (docFile.some(id => id >= index.files.length) || bloomFiles.some(id => id >= index.files.length)) {
			return undefined;
		}
		index.segments = [opened.segment];
		return index;
	}
}

/** Words per bloom document. */
const BLOOM_WORDS = (1 << BLOOM_BITS_LOG2) >>> 5;
const BLOOM_BYTES = BLOOM_WORDS * 4;

/**
 * Postings added since the last spill or merge, as an append-only log (key, document, mask) at
 * about 10 bytes per posting. Queries read it through `freeze`, which sorts it into a segment.
 */
class Delta {
	private keys = new Uint32Array(0);
	private docs = new Uint32Array(0);
	private masks = new Uint16Array(0);
	postings = 0;
	private readonly docFile: number[] = [];
	private readonly bloomFiles: number[] = [];
	private bloomBits = new Uint32Array(0);
	private frozen: IndexSegment | undefined;

	get isEmpty(): boolean {
		return !this.docFile.length && !this.bloomFiles.length;
	}

	get blooms(): number {
		return this.bloomFiles.length;
	}

	get byteLength(): number {
		return this.keys.byteLength + this.docs.byteLength + this.masks.byteLength + this.bloomBits.byteLength + (this.frozen?.byteLength ?? 0);
	}

	addDocument(file: number, trigrams: Map<number, number>): void {
		this.frozen = undefined;
		const doc = this.docFile.length;
		this.docFile.push(file);
		const needed = this.postings + trigrams.size;
		if (needed > this.keys.length) {
			const capacity = Math.max(needed, 1024, this.keys.length * 2);
			this.keys = grow(this.keys, new Uint32Array(capacity));
			this.docs = grow(this.docs, new Uint32Array(capacity));
			this.masks = grow(this.masks, new Uint16Array(capacity));
		}
		let p = this.postings;
		for (const [key, mask] of trigrams) {
			this.keys[p] = key;
			this.docs[p] = doc;
			this.masks[p] = mask;
			p++;
		}
		this.postings = p;
	}

	addBloom(file: number, text: string): void {
		this.frozen = undefined;
		const n = this.bloomFiles.length;
		if ((n + 1) * BLOOM_WORDS > this.bloomBits.length) {
			this.bloomBits = grow(this.bloomBits, new Uint32Array(Math.max(n + 1, n * 2) * BLOOM_WORDS));
		}
		const bits = this.bloomBits.subarray(n * BLOOM_WORDS, (n + 1) * BLOOM_WORDS);
		gramHashes(text, hash => bloomSet(bits, hash));
		this.bloomFiles.push(file);
	}

	/** The delta as a segment: postings sorted by key (a stable radix sort keeps documents ascending). */
	freeze(): IndexSegment {
		if (this.frozen) {
			return this.frozen;
		}
		const n = this.postings;
		const keys = this.keys;
		// Keys are 24 bits: two stable counting-sort passes of 12 bits each.
		const low = new Uint32Array(n);
		const counts = new Uint32Array(4097);
		for (let i = 0; i < n; i++) {
			counts[(keys[i] & 0xfff) + 1]++;
		}
		for (let d = 1; d <= 4096; d++) {
			counts[d] += counts[d - 1];
		}
		for (let i = 0; i < n; i++) {
			low[counts[keys[i] & 0xfff]++] = i;
		}
		counts.fill(0);
		for (let i = 0; i < n; i++) {
			counts[((keys[i] >>> 12) & 0xfff) + 1]++;
		}
		for (let d = 1; d <= 4096; d++) {
			counts[d] += counts[d - 1];
		}
		const order = new Uint32Array(n);
		for (let i = 0; i < n; i++) {
			const p = low[i];
			order[counts[(keys[p] >>> 12) & 0xfff]++] = p;
		}
		const ids = low; // reused: `low` is no longer needed
		const masks = new Uint16Array(n);
		let distinct = 0;
		let previous = -1;
		for (let i = 0; i < n; i++) {
			const p = order[i];
			ids[i] = this.docs[p];
			masks[i] = this.masks[p];
			if (keys[p] !== previous) {
				previous = keys[p];
				distinct++;
			}
		}
		const outKeys = new Uint32Array(distinct);
		const starts = new Uint32Array(distinct + 1);
		previous = -1;
		for (let i = 0, k = -1; i < n; i++) {
			const key = keys[order[i]];
			if (key !== previous) {
				previous = key;
				outKeys[++k] = key;
				starts[k] = i;
			}
		}
		starts[distinct] = n;
		const docFile = Uint32Array.from(this.docFile);
		const bloomFiles = Uint32Array.from(this.bloomFiles);
		const bloomBits = this.bloomBits.subarray(0, this.bloomFiles.length * BLOOM_WORDS);
		this.frozen = {
			keys: outKeys, starts, ids, masks, docFile, bloomFiles, bloomBits, mapped: false,
			byteLength: outKeys.byteLength + starts.byteLength + ids.byteLength + masks.byteLength + docFile.byteLength + bloomFiles.byteLength,
		};
		return this.frozen;
	}
}

function grow<T extends Uint32Array | Uint16Array>(from: T, to: T): T {
	to.set(from);
	return to;
}

/**
 * Adds to `out` the files with a document containing every trigram of `text`, adjacent (position
 * masks) and followed correctly (next masks). Trigrams are intersected rarest-first; the other
 * posting lists are probed by binary search, so common trigrams cost almost nothing. A literal
 * lies inside one document, so each segment is searched on its own.
 */
function postingsLiteral(segment: IndexSegment, text: string, out: Set<number>): void {
	const terms: { start: number; end: number; next: number; shift: number }[] = [];
	for (let i = 0; i + 2 < text.length; i++) {
		const k = findKey(segment.keys, trigramKey(text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2)));
		if (k < 0) {
			return;
		}
		terms.push({ start: segment.starts[k], end: segment.starts[k + 1], next: i + 3 < text.length ? nextBit(text.charCodeAt(i + 3)) : 0, shift: 8 - (i & 7) });
	}
	if (!terms.length) {
		return;
	}
	const { ids, masks } = segment;
	terms.sort((a, b) => (a.end - a.start) - (b.end - b.start));
	// document -> position mask aligned to the literal's first character
	let aligned = new Map<number, number>();
	const first = terms[0];
	for (let j = first.start; j < first.end; j++) {
		const mask = masks[j];
		if (first.next && !((mask >>> 8) & first.next)) {
			continue;
		}
		const id = ids[j];
		aligned.set(id, (aligned.get(id) ?? 0) | rotl8(mask & 0xff, first.shift));
	}
	for (let t = 1; t < terms.length && aligned.size; t++) {
		const { start, end, next, shift } = terms[t];
		const survivors = new Map<number, number>();
		for (const [id, pos] of aligned) {
			const j = findId(ids, start, end, id);
			if (j < 0) {
				continue;
			}
			const mask = masks[j];
			if (next && !((mask >>> 8) & next)) {
				continue;
			}
			const both = pos & rotl8(mask & 0xff, shift);
			if (both) {
				survivors.set(id, both);
			}
		}
		aligned = survivors;
	}
	for (const doc of aligned.keys()) {
		const file = segment.docFile[doc];
		if (file !== undefined) {
			out.add(file);
		}
	}
}

/**
 * Files with bloom documents holding every trigram and 4-gram of `text`. A literal longer than
 * the overlap between bloom documents may span two of them, so it is split into windows that
 * each fit in one, and a file must hold every window. A file's bloom documents all come from one
 * segment, but the check does not rely on it.
 */
function bloomLiteral(sources: readonly IndexSegment[], text: string): Set<number> {
	if (text.length < 3 || !sources.some(s => s.bloomFiles.length)) {
		return new Set();
	}
	const windows: string[] = [];
	for (let start = 0; ; start += BLOOM_OVERLAP - 3) {
		windows.push(text.slice(start, start + BLOOM_OVERLAP));
		if (start + BLOOM_OVERLAP >= text.length) {
			break;
		}
	}
	let files: Set<number> | undefined;
	for (const window of windows) {
		const hashes: number[] = [];
		gramHashes(window, hash => hashes.push(hash));
		const hits = new Set<number>();
		for (const segment of sources) {
			for (let b = 0; b < segment.bloomFiles.length; b++) {
				const file = segment.bloomFiles[b];
				if ((!files || files.has(file)) && !hits.has(file)) {
					const bits = segment.bloomBits.subarray(b * BLOOM_WORDS, (b + 1) * BLOOM_WORDS);
					if (hashes.every(hash => bloomHas(bits, hash))) {
						hits.add(file);
					}
				}
			}
		}
		files = hits;
		if (!files.size) {
			break;
		}
	}
	return files ?? new Set();
}

/** Index of `key` in the ascending `keys`, or -1. */
function findKey(keys: Uint32Array, key: number): number {
	let lo = 0;
	let hi = keys.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const v = keys[mid];
		if (v < key) {
			lo = mid + 1;
		} else if (v > key) {
			hi = mid - 1;
		} else {
			return mid;
		}
	}
	return -1;
}

/** Index of `id` in `ids[start..end)` (ascending), or -1. */
function findId(ids: Uint32Array, start: number, end: number, id: number): number {
	let lo = start;
	let hi = end - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const v = ids[mid];
		if (v < id) {
			lo = mid + 1;
		} else if (v > id) {
			hi = mid - 1;
		} else {
			return mid;
		}
	}
	return -1;
}

// ---- segment files ---------------------------------------------------------------------------
//
// Layout (version 7), every section in the writing machine's byte order:
//   fixed header (48 bytes): magic, version, byte-order mark, JSON header length, key count,
//     document count, bloom count, reserved, posting count (float64), reserved
//   JSON header ({root, files} for a base; empty for a spilled run)
//   8-byte aligned: keys u32[K], starts u32[K+1], docFile u32[D], bloomFiles u32[B]
//   8-byte aligned: ids u32[P], masks u16[P]
//   8-byte aligned: bloom bits, BLOOM_BYTES per bloom document
// The sections are read as typed-array views straight over the mapped file.

interface Layout {
	readonly keys: number;
	readonly starts: number;
	readonly docFile: number;
	readonly bloomFiles: number;
	readonly ids: number;
	readonly masks: number;
	readonly blooms: number;
	readonly total: number;
}

function layout(headerLength: number, keys: number, docs: number, blooms: number, postings: number): Layout {
	const align = (n: number) => (n + 7) & ~7;
	let o = align(FIXED_HEADER_BYTES + headerLength);
	const keysAt = o; o += 4 * keys;
	const startsAt = o; o += 4 * (keys + 1);
	const docFileAt = o; o += 4 * docs;
	const bloomFilesAt = o; o += 4 * blooms;
	o = align(o);
	const idsAt = o; o += 4 * postings;
	const masksAt = o; o += 2 * postings;
	o = align(o);
	const bloomsAt = o; o += BLOOM_BYTES * blooms;
	return { keys: keysAt, starts: startsAt, docFile: docFileAt, bloomFiles: bloomFilesAt, ids: idsAt, masks: masksAt, blooms: bloomsAt, total: o };
}

/** Destination of a segment's bytes: a temporary file, or one buffer in memory. */
interface Sink {
	write(bytes: Uint8Array, position: number): Promise<void>;
}

const STAGE_POSTINGS = 1 << 16;

/**
 * Writes the postings of `sources` whose files survive `fileRemap` (old file id -> new id, or -1)
 * as one segment, to `file` (through a temporary file and a rename) or, without a file, into
 * memory. Sources cover separate documents, so each key's postings are concatenated source by
 * source with documents renumbered in order, which keeps them ascending. Keys are merged k-way,
 * twice (count, then write), and postings stream out through small buffers, so memory stays flat
 * however large the index is. The event loop gets a turn every few thousand keys.
 */
async function writeSegment(sources: readonly IndexSegment[], fileRemap: Int32Array, file: string | undefined, header: SavedHeader | undefined): Promise<IndexSegment> {
	const survives = (id: number) => id < fileRemap.length && fileRemap[id] >= 0;
	const docRemaps = sources.map(() => new Int32Array(0));
	let docCount = 0;
	sources.forEach((s, i) => {
		const remap = new Int32Array(s.docFile.length);
		for (let d = 0; d < remap.length; d++) {
			remap[d] = survives(s.docFile[d]) ? docCount++ : -1;
		}
		docRemaps[i] = remap;
	});
	const docFile = new Uint32Array(docCount);
	sources.forEach((s, i) => docRemaps[i].forEach((d, local) => {
		if (d >= 0) {
			docFile[d] = fileRemap[s.docFile[local]];
		}
	}));
	const blooms: { source: IndexSegment; index: number; file: number }[] = [];
	for (const s of sources) {
		for (let b = 0; b < s.bloomFiles.length; b++) {
			if (survives(s.bloomFiles[b])) {
				blooms.push({ source: s, index: b, file: fileRemap[s.bloomFiles[b]] });
			}
		}
	}

	// Pass 1: surviving postings per key.
	let keys = new Uint32Array(1024);
	let starts = new Uint32Array(1025);
	let keyCount = 0;
	let postings = 0;
	await forEachKey(sources, (key, segments, ranges) => {
		let count = 0;
		for (let s = 0; s < segments.length; s++) {
			const { ids } = segments[s];
			const remap = docRemaps[sources.indexOf(segments[s])];
			for (let j = ranges[2 * s]; j < ranges[2 * s + 1]; j++) {
				if (remap[ids[j]] >= 0) {
					count++;
				}
			}
		}
		if (count) {
			if (keyCount === keys.length) {
				keys = grow(keys, new Uint32Array(keys.length * 2));
				starts = grow(starts, new Uint32Array(keys.length + 1));
			}
			keys[keyCount] = key;
			starts[keyCount++] = postings;
			postings += count;
		}
	});
	if (postings > 0xFFFFFFFF) {
		throw new Error(`index too large: ${postings} postings`);
	}
	keys = keys.subarray(0, keyCount);
	starts = starts.subarray(0, keyCount + 1);
	starts[keyCount] = postings;

	const headerBytes = header ? Buffer.from(JSON.stringify(header), 'utf8') : Buffer.alloc(0);
	const at = layout(headerBytes.length, keyCount, docCount, blooms.length, postings);
	const fixed = new ArrayBuffer(FIXED_HEADER_BYTES);
	new Uint32Array(fixed, 0, 8).set([MAGIC, FORMAT_VERSION, BYTE_ORDER, headerBytes.length, keyCount, docCount, blooms.length, 0]);
	new Float64Array(fixed, 32, 2)[0] = postings;

	let memory: Uint8Array | undefined;
	let handle: fs.FileHandle | undefined;
	const tmp = file ? `${file}.${process.pid}.tmp` : undefined;
	let sink: Sink;
	if (tmp) {
		await fs.mkdir(path.dirname(tmp), { recursive: true });
		const h = handle = await fs.open(tmp, 'w');
		sink = { write: async (bytes, position) => { await h.write(bytes, 0, bytes.length, position); } };
	} else {
		const m = memory = new Uint8Array(at.total);
		sink = { write: async (bytes, position) => m.set(bytes, position) };
	}
	try {
		await sink.write(new Uint8Array(fixed), 0);
		await sink.write(headerBytes, FIXED_HEADER_BYTES);
		await sink.write(bytesOf(keys), at.keys);
		await sink.write(bytesOf(starts), at.starts);
		await sink.write(bytesOf(docFile), at.docFile);
		await sink.write(bytesOf(Uint32Array.from(blooms, b => b.file)), at.bloomFiles);

		// Pass 2: the postings themselves.
		const stageIds = new Uint32Array(STAGE_POSTINGS);
		const stageMasks = new Uint16Array(STAGE_POSTINGS);
		let staged = 0;
		let written = 0;
		const flush = async () => {
			await sink.write(bytesOf(stageIds.subarray(0, staged)), at.ids + 4 * written);
			await sink.write(bytesOf(stageMasks.subarray(0, staged)), at.masks + 2 * written);
			written += staged;
			staged = 0;
		};
		await forEachKey(sources, async (_key, segments, ranges) => {
			for (let s = 0; s < segments.length; s++) {
				const { ids, masks } = segments[s];
				const remap = docRemaps[sources.indexOf(segments[s])];
				for (let j = ranges[2 * s]; j < ranges[2 * s + 1]; j++) {
					const doc = remap[ids[j]];
					if (doc >= 0) {
						stageIds[staged] = doc;
						stageMasks[staged] = masks[j];
						if (++staged === STAGE_POSTINGS) {
							await flush();
						}
					}
				}
			}
		});
		await flush();
		if (written !== postings) {
			throw new Error(`segment writer lost postings (${written} of ${postings})`);
		}
		for (let i = 0; i < blooms.length; i++) {
			const { source, index } = blooms[i];
			await sink.write(bytesOf(source.bloomBits.subarray(index * BLOOM_WORDS, (index + 1) * BLOOM_WORDS)), at.blooms + i * BLOOM_BYTES);
		}
		if (handle) {
			await handle.truncate(at.total); // trailing alignment padding
			await handle.close();
			handle = undefined;
			await fs.rename(tmp!, file!);
		}
	} catch (err) {
		await handle?.close().catch(() => undefined);
		if (tmp) {
			await removeQuietly(tmp);
		}
		throw err;
	}
	if (memory) {
		const parsed = parseSegment(memory, undefined, false);
		if (!parsed) {
			throw new Error('segment writer produced an unreadable segment');
		}
		return parsed.segment;
	}
	const opened = await openSegment(file!);
	if (!opened) {
		throw new Error(`segment writer produced an unreadable file: ${file}`);
	}
	return opened.segment;
}

/**
 * Visits every key present in `sources` once, in ascending order, with the segments that hold it
 * and each one's posting range (`ranges[2s]`, `ranges[2s + 1]`), in source order.
 */
async function forEachKey(sources: readonly IndexSegment[], visit: (key: number, segments: IndexSegment[], ranges: number[]) => void | Promise<void>): Promise<void> {
	const cursors = new Int32Array(sources.length);
	let steps = 0;
	for (; ;) {
		let key = Infinity;
		for (let s = 0; s < sources.length; s++) {
			if (cursors[s] < sources[s].keys.length && sources[s].keys[cursors[s]] < key) {
				key = sources[s].keys[cursors[s]];
			}
		}
		if (key === Infinity) {
			return;
		}
		const segments: IndexSegment[] = [];
		const ranges: number[] = [];
		for (let s = 0; s < sources.length; s++) {
			const source = sources[s];
			if (cursors[s] < source.keys.length && source.keys[cursors[s]] === key) {
				segments.push(source);
				ranges.push(source.starts[cursors[s]], source.starts[cursors[s] + 1]);
				cursors[s]++;
			}
		}
		await visit(key, segments, ranges);
		if (++steps % 8192 === 0) {
			await new Promise(resolve => setImmediate(resolve));
		}
	}
}

function bytesOf(view: Uint32Array | Uint16Array): Uint8Array {
	return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Reads a segment file: memory-mapped under Bun (not on Windows, where a mapped file cannot be replaced), otherwise read into memory. */
async function openSegment(file: string): Promise<{ segment: IndexSegment; header: SavedHeader | undefined } | undefined> {
	const mapped = mapFile(file);
	return parseSegment(mapped ?? await fs.readFile(file), file, !!mapped);
}

type BunMmap = (path: string, options?: { shared?: boolean }) => Uint8Array;

function mapFile(file: string): Uint8Array | undefined {
	const mmap = (globalThis as { Bun?: { mmap?: BunMmap } }).Bun?.mmap;
	if (process.platform === 'win32' || typeof mmap !== 'function' || process.env.DRAGON_SEARCH_NO_MMAP) {
		return undefined;
	}
	try {
		// A private mapping: the index never writes through it, and if it did the file would not change.
		return mmap(file, { shared: false });
	} catch {
		return undefined;
	}
}

function parseSegment(input: Uint8Array, file: string | undefined, mapped: boolean): { segment: IndexSegment; header: SavedHeader | undefined } | undefined {
	// Typed-array views need aligned offsets; a small file read into Node's buffer pool may not be.
	const bytes = input.byteOffset % 8 ? new Uint8Array(input) : input;
	if (bytes.byteLength < FIXED_HEADER_BYTES) {
		return undefined;
	}
	const { buffer, byteOffset } = bytes;
	const fixed = new Uint32Array(buffer, byteOffset, 8);
	if (fixed[0] !== MAGIC || fixed[1] !== FORMAT_VERSION || fixed[2] !== BYTE_ORDER) {
		return undefined;
	}
	const [, , , headerLength, keyCount, docCount, bloomCount] = fixed;
	const postings = new Float64Array(buffer, byteOffset + 32, 1)[0];
	if (!Number.isInteger(postings) || postings < 0 || postings > 0xFFFFFFFF) {
		return undefined;
	}
	const at = layout(headerLength, keyCount, docCount, bloomCount, postings);
	if (at.total !== bytes.byteLength) {
		return undefined;
	}
	let header: SavedHeader | undefined;
	if (headerLength) {
		try {
			header = JSON.parse(Buffer.from(buffer, byteOffset + FIXED_HEADER_BYTES, headerLength).toString('utf8'));
		} catch {
			return undefined;
		}
	}
	const keys = new Uint32Array(buffer, byteOffset + at.keys, keyCount);
	const starts = new Uint32Array(buffer, byteOffset + at.starts, keyCount + 1);
	// The directory is small; checking it catches truncated or corrupt files without touching the postings.
	if (starts[0] !== 0 || starts[keyCount] !== postings) {
		return undefined;
	}
	for (let k = 0; k < keyCount; k++) {
		if (starts[k] > starts[k + 1] || (k && keys[k - 1] >= keys[k])) {
			return undefined;
		}
	}
	const segment: IndexSegment = {
		keys,
		starts,
		docFile: new Uint32Array(buffer, byteOffset + at.docFile, docCount),
		bloomFiles: new Uint32Array(buffer, byteOffset + at.bloomFiles, bloomCount),
		ids: new Uint32Array(buffer, byteOffset + at.ids, postings),
		masks: new Uint16Array(buffer, byteOffset + at.masks, postings),
		bloomBits: new Uint32Array(buffer, byteOffset + at.blooms, bloomCount * BLOOM_WORDS),
		file,
		mapped,
		byteLength: bytes.byteLength,
	};
	return { segment, header };
}

/** Deletes runs and temporary files left in the storage directory by processes that have exited. */
async function removeOrphans(file: string): Promise<void> {
	const dir = path.dirname(file);
	const base = path.basename(file);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const match = name.startsWith(`${base}.`) ? /^(?:run-(\d+)-\d+|(\d+)\.tmp)$/.exec(name.slice(base.length + 1)) : null;
		const pid = match ? Number(match[1] ?? match[2]) : undefined;
		if (pid !== undefined && !isAlive(pid)) {
			await removeQuietly(path.join(dir, name));
		}
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function removeQuietly(file: string | undefined): Promise<void> {
	if (file) {
		await fs.rm(file, { force: true }).catch(() => undefined);
	}
}

/** Characters per line-aligned index chunk for large files. */
export const CHUNK_CHARS = 256 * 1024;
/** A chunk may run this far past CHUNK_CHARS to end on a line; longer lines go into bloom documents. */
const LINE_SLACK = 16 * 1024;
/** Characters of text per bloom document. */
const BLOOM_CHARS = 64 * 1024;
/** Consecutive bloom documents overlap by this many characters, so any literal this long lies inside one. */
export const BLOOM_OVERLAP = 256;

export interface Segment {
	readonly text: string;
	/** Stored as a bloom document rather than in the posting lists. */
	readonly bloom: boolean;
}

/**
 * Splits text into index documents. Files up to CHUNK_CHARS are one document; larger files are
 * cut into chunks of about CHUNK_CHARS that end on line boundaries. Where a line runs far past
 * a chunk boundary (base64 data, minified code), nearly every trigram occurs and masks would
 * saturate, so that region is cut into overlapping bloom documents of trigrams and 4-grams.
 */
export function segmentsOf(text: string): Segment[] {
	const out: Segment[] = [];
	let start = 0;
	while (start < text.length) {
		if (text.length - start <= CHUNK_CHARS) {
			out.push({ text: start ? text.slice(start) : text, bloom: false });
			break;
		}
		const target = start + CHUNK_CHARS;
		const newline = text.indexOf('\n', target);
		const end = newline === -1 ? text.length : newline + 1;
		if (end - target <= LINE_SLACK) {
			out.push({ text: text.slice(start, end), bloom: false });
		} else {
			for (let piece = start; piece < end; piece += BLOOM_CHARS) {
				out.push({ text: text.slice(piece, Math.min(end, piece + BLOOM_CHARS + BLOOM_OVERLAP)), bloom: true });
			}
		}
		start = end;
	}
	return out;
}

/** Content to index, undefined for files too large to index, or BINARY. */
export async function readIndexable(abs: string, size: number): Promise<string | undefined | typeof BINARY> {
	if (size > MAX_INDEXED_BYTES) {
		return undefined;
	}
	const bytes = await fs.readFile(abs);
	// ripgrep transcodes files that start with a UTF-16 byte-order mark, so index their text too.
	if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
		return new TextDecoder('utf-16le').decode(bytes.subarray(2));
	}
	if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
		return new TextDecoder('utf-16be').decode(bytes.subarray(2));
	}
	const probe = bytes.subarray(0, Math.min(bytes.length, 8000));
	if (probe.includes(0)) {
		return BINARY; // ripgrep skips binary files too
	}
	return bytes.toString('utf8');
}

/** Where a workspace's index is stored. */
export function indexFileFor(storageDir: string, root: string): string {
	const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
	return path.join(storageDir, `${hash}.trigrams`);
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	const out = new Set<number>();
	for (const x of small) {
		if (large.has(x)) {
			out.add(x);
		}
	}
	return out;
}

function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}

// Exported for tests.
export const _masks = { nextBit, positionBit };
