/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Trigram keys and the two per-posting masks that let Instant Grep reject most candidate files
 * without opening them (the technique Cursor described for its "Instant Grep" index):
 *
 *  - next mask: an 8-bit bloom filter of the characters that follow the trigram in the file.
 *    For a literal "abcd", a file whose "abc" is never followed by "d" cannot match.
 *  - position mask: the trigram's offsets modulo 8. For "abc" at p and "bcd" at p+1, the
 *    rotated masks must intersect, or the two trigrams are never adjacent in that file.
 *
 * Text is case-folded before indexing, so one index serves case-sensitive and insensitive
 * searches; ripgrep verifies the exact semantics afterwards.
 */

/**
 * Folds one UTF-16 code unit into 8 bits. ASCII is exact; other characters may collide, which
 * only adds candidates. Characters that are equal under Unicode simple case folding (ripgrep's
 * `-i`) always fold alike: U+00C6/U+00E6, U+03A3/U+03C3/U+03C2, and the Kelvin sign (U+212A)
 * and long s (U+017F) with `k` and `s`.
 */
function fold(code: number): number {
	if (code >= 65 && code <= 90) {
		return code + 32; // A-Z -> a-z
	}
	if (code < 128) {
		return code;
	}
	return (foldTable ??= buildFoldTable())[code];
}

let foldTable: Uint8Array | undefined;

/** Simple case folding pairs that toUpperCase/toLowerCase do not relate. */
const FOLD_EXTRA: Record<number, number> = { 0x1FD3: 0x0390, 0x1FE3: 0x03B0, 0xFB05: 0xFB06 };

function buildFoldTable(): Uint8Array {
	const table = new Uint8Array(0x10000);
	for (let code = 128; code < 0x10000; code++) {
		let folded = code;
		if (code >= 0xDC00 && code <= 0xDFFF) {
			folded = 0xDC00; // low surrogates share a bucket, so astral case pairs (same high surrogate) collide
		} else if (FOLD_EXTRA[code] !== undefined) {
			folded = FOLD_EXTRA[code];
		} else if (code < 0xD800 || code > 0xDBFF) {
			const upper = String.fromCharCode(code).toUpperCase();
			const lower = (upper.length === 1 ? upper : String.fromCharCode(code)).toLowerCase();
			folded = lower.length === 1 ? lower.charCodeAt(0) : code;
		}
		table[code] = folded < 128 ? folded : 128 + ((folded * 2654435761) >>> 25); // 128..255
	}
	return table;
}

/** 24-bit key for three consecutive (case-folded) characters. */
export function trigramKey(a: number, b: number, c: number): number {
	return (fold(a) << 16) | (fold(b) << 8) | fold(c);
}

/** Bloom bit (0..7) for the character that follows a trigram. */
export function nextBit(code: number): number {
	return 1 << (((fold(code) * 0x9E3779B1) >>> 29) & 7);
}

/** Position bit (0..7) for a trigram starting at `offset`. */
export function positionBit(offset: number): number {
	return 1 << (offset & 7);
}

/** Rotates an 8-bit mask left by `n`. */
export function rotl8(mask: number, n: number): number {
	const s = n & 7;
	return ((mask << s) | (mask >>> (8 - s))) & 0xff;
}

/**
 * Every trigram of `text` with its masks, packed as `next << 8 | position`.
 * Masks of repeated trigrams are OR-ed together.
 */
export function extractTrigrams(text: string): Map<number, number> {
	const out = new Map<number, number>();
	const n = text.length;
	for (let i = 0; i + 2 < n; i++) {
		const c0 = text.charCodeAt(i);
		const c1 = text.charCodeAt(i + 1);
		const c2 = text.charCodeAt(i + 2);
		if (c0 === 10 || c1 === 10 || c2 === 10) {
			continue; // a match never spans lines
		}
		const key = trigramKey(c0, c1, c2);
		const next = i + 3 < n ? nextBit(text.charCodeAt(i + 3)) : 0;
		const packed = (next << 8) | positionBit(i);
		out.set(key, (out.get(key) ?? 0) | packed);
	}
	return out;
}

/** A bloom document holds 2^19 bits (64 KiB): about 8 bits per character of text it covers. */
export const BLOOM_BITS_LOG2 = 19;

/**
 * Calls `visit` with a hash of every trigram and every 4-gram of `text`, case-folded, skipping
 * any that span a newline. Bloom documents store these, so a literal must match both its
 * trigrams and the character that follows each one.
 */
export function gramHashes(text: string, visit: (hash: number) => void): void {
	const n = text.length;
	for (let i = 0; i + 2 < n; i++) {
		const c0 = text.charCodeAt(i);
		const c1 = text.charCodeAt(i + 1);
		const c2 = text.charCodeAt(i + 2);
		if (c0 === 10 || c1 === 10 || c2 === 10) {
			continue;
		}
		const key = trigramKey(c0, c1, c2);
		visit(mix(key));
		if (i + 3 < n) {
			const c3 = text.charCodeAt(i + 3);
			if (c3 !== 10) {
				visit(mix(((key << 8) | fold(c3)) ^ 0x9E3779B9));
			}
		}
	}
}

/** Sets the two bloom bits of `hash`. */
export function bloomSet(bits: Uint32Array, hash: number): void {
	const a = hash >>> (32 - BLOOM_BITS_LOG2);
	const b = mix(hash ^ 0x27D4EB2F) >>> (32 - BLOOM_BITS_LOG2);
	bits[a >>> 5] |= 1 << (a & 31);
	bits[b >>> 5] |= 1 << (b & 31);
}

/** True when both bloom bits of `hash` are set. */
export function bloomHas(bits: Uint32Array, hash: number): boolean {
	const a = hash >>> (32 - BLOOM_BITS_LOG2);
	const b = mix(hash ^ 0x27D4EB2F) >>> (32 - BLOOM_BITS_LOG2);
	return (bits[a >>> 5] & (1 << (a & 31))) !== 0 && (bits[b >>> 5] & (1 << (b & 31))) !== 0;
}

function mix(h: number): number {
	h = Math.imul(h ^ (h >>> 16), 0x85EBCA6B);
	h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
	return (h ^ (h >>> 16)) >>> 0;
}
