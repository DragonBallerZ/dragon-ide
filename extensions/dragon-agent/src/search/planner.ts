/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Turns a regular expression into a boolean query over literal strings that any match must
 * contain. The query only narrows candidate files; ripgrep decides the actual matches, so the
 * planner must be conservative: when in doubt it gives up ("all") rather than guessing.
 *
 * Supported: literal runs, escapes, `.`, character classes, groups (capturing, `(?:`, named,
 * inline flags), alternation, and the quantifiers `* + ? {m,n}` (lazy/possessive too).
 * Lookarounds and backreferences are treated as unknown atoms.
 */
export type Query =
	| { readonly kind: 'all' }
	| { readonly kind: 'lit'; readonly text: string }
	| { readonly kind: 'and'; readonly items: readonly Query[] }
	| { readonly kind: 'or'; readonly items: readonly Query[] };

const ALL: Query = { kind: 'all' };

/** Minimum literal length that is worth a trigram lookup. */
export const MIN_LITERAL = 3;

type Atom =
	| { readonly kind: 'char'; readonly value: string }
	| { readonly kind: 'any' } // anything we cannot turn into a literal
	| { readonly kind: 'group'; readonly alternatives: Atom[][] };

interface Piece {
	readonly atom: Atom;
	/** The atom may be absent (`?`, `*`, `{0,n}`). */
	readonly optional: boolean;
	/** The atom may repeat (`+`, `*`, `{n,}` ...), which breaks literal adjacency after it. */
	readonly repeats: boolean;
}

class Parser {
	private i = 0;
	constructor(private readonly src: string) { }

	parse(): Piece[][] {
		const alternatives = this.alternation();
		if (this.i < this.src.length) {
			throw new Error('unbalanced');
		}
		return alternatives;
	}

	private alternation(): Piece[][] {
		const alternatives: Piece[][] = [this.sequence()];
		while (this.src[this.i] === '|') {
			this.i++;
			alternatives.push(this.sequence());
		}
		return alternatives;
	}

	private sequence(): Piece[] {
		const pieces: Piece[] = [];
		while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') {
			const atom = this.atom();
			if (!atom) {
				continue;
			}
			pieces.push(this.quantified(atom));
		}
		return pieces;
	}

	private quantified(atom: Atom): Piece {
		let optional = false;
		let repeats = false;
		const c = this.src[this.i];
		if (c === '*') {
			this.i++; optional = true; repeats = true;
		} else if (c === '+') {
			this.i++; repeats = true;
		} else if (c === '?') {
			this.i++; optional = true;
		} else if (c === '{') {
			const m = /^\{(\d*)(,(\d*))?\}/.exec(this.src.slice(this.i));
			if (m) {
				this.i += m[0].length;
				const min = m[1] === '' ? 0 : Number(m[1]);
				const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
				optional = min === 0;
				repeats = max !== 1;
			}
		}
		if (this.src[this.i] === '?' || (this.src[this.i] === '+' && (optional || repeats))) {
			this.i++; // lazy or possessive modifier
		}
		return { atom, optional, repeats };
	}

	private atom(): Atom | undefined {
		const c = this.src[this.i++];
		switch (c) {
			case '^':
			case '$':
				return undefined; // anchors take no characters
			case '.':
				return { kind: 'any' };
			case '[':
				this.skipClass();
				return { kind: 'any' };
			case '(':
				return this.group();
			case '\\':
				return this.escape();
			default:
				return { kind: 'char', value: c };
		}
	}

	private group(): Atom {
		let lookaround = false;
		if (this.src[this.i] === '?') {
			const rest = this.src.slice(this.i);
			const m = /^\?(?::|P?<[A-Za-z_][A-Za-z0-9_]*>|'[A-Za-z_][A-Za-z0-9_]*'|[imsxU-]+:|[imsxU-]+\)|=|!|<=|<!)/.exec(rest);
			if (!m) {
				throw new Error('unsupported group');
			}
			if (/^\?[imsxU-]+\)$/.test(m[0])) {
				this.i += m[0].length; // inline flags: (?i) - no atom
				return { kind: 'any' };
			}
			lookaround = /^\?(=|!|<=|<!)$/.test(m[0]);
			this.i += m[0].length;
		}
		const alternatives = this.alternation();
		if (this.src[this.i] !== ')') {
			throw new Error('unbalanced');
		}
		this.i++;
		if (lookaround) {
			return { kind: 'any' };
		}
		const unknown: Atom = { kind: 'any' };
		return { kind: 'group', alternatives: alternatives.map(seq => seq.map(p => p.optional || p.repeats ? unknown : p.atom)) };
	}

	private skipClass(): void {
		if (this.src[this.i] === '^') {
			this.i++;
		}
		if (this.src[this.i] === ']') {
			this.i++;
		}
		while (this.i < this.src.length && this.src[this.i] !== ']') {
			if (this.src[this.i] === '\\') {
				this.i++;
			} else if (this.src[this.i] === '[' && this.src[this.i + 1] === ':') {
				const end = this.src.indexOf(':]', this.i + 2);
				if (end !== -1) {
					this.i = end + 1;
				}
			}
			this.i++;
		}
		if (this.src[this.i] !== ']') {
			throw new Error('unterminated class');
		}
		this.i++;
	}

	private escape(): Atom {
		const c = this.src[this.i++];
		if (c === undefined) {
			throw new Error('trailing backslash');
		}
		if (/[dDwWsSbBAzZpPkKGh0-9]/.test(c)) {
			if ((c === 'p' || c === 'P') && this.src[this.i] === '{') {
				this.i = this.src.indexOf('}', this.i) + 1;
			}
			return c === 'b' || c === 'B' || c === 'A' || c === 'z' || c === 'Z' || c === 'G' ? { kind: 'group', alternatives: [[]] } : { kind: 'any' };
		}
		if (c === 'x') {
			const m = /^(\{[0-9a-fA-F]+\}|[0-9a-fA-F]{2})/.exec(this.src.slice(this.i));
			if (m) {
				this.i += m[0].length;
				return { kind: 'char', value: String.fromCodePoint(parseInt(m[0].replace(/[{}]/g, ''), 16)) };
			}
		}
		if (c === 'u') {
			const m = /^(\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/.exec(this.src.slice(this.i));
			if (m) {
				this.i += m[0].length;
				return { kind: 'char', value: String.fromCodePoint(parseInt(m[0].replace(/[{}]/g, ''), 16)) };
			}
		}
		const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };
		return { kind: 'char', value: map[c] ?? c };
	}
}

function and(items: Query[]): Query {
	const flat = items.flatMap(q => q.kind === 'and' ? q.items : [q]).filter(q => q.kind !== 'all');
	if (!flat.length) {
		return ALL;
	}
	return flat.length === 1 ? flat[0] : { kind: 'and', items: dedupe(flat) };
}

function or(items: Query[]): Query {
	if (!items.length || items.some(q => q.kind === 'all')) {
		return ALL; // one unconstrained branch makes the whole alternation unconstrained
	}
	const flat = items.flatMap(q => q.kind === 'or' ? q.items : [q]);
	return flat.length === 1 ? flat[0] : { kind: 'or', items: dedupe(flat) };
}

function dedupe(items: Query[]): Query[] {
	const seen = new Set<string>();
	return items.filter(q => {
		const key = JSON.stringify(q);
		return seen.has(key) ? false : (seen.add(key), true);
	});
}

/** Literal runs of a sequence of atoms; groups become sub-queries. */
function sequenceQuery(atoms: readonly Atom[]): Query {
	const parts: Query[] = [];
	let run = '';
	const flush = () => {
		if (run.length >= MIN_LITERAL) {
			parts.push({ kind: 'lit', text: run });
		}
		run = '';
	};
	for (const atom of atoms) {
		if (atom.kind === 'char') {
			if (atom.value === '\n' || atom.value === '\r') {
				flush(); // indexed trigrams never cross a line break
				continue;
			}
			run += atom.value;
		} else if (atom.kind === 'group') {
			// A single-branch group of plain characters just continues the run.
			if (atom.alternatives.length === 1 && atom.alternatives[0].every(a => a.kind === 'char')) {
				run += atom.alternatives[0].map(a => (a as { value: string }).value).join('');
				continue;
			}
			flush();
			parts.push(or(atom.alternatives.map(sequenceQuery)));
		} else {
			flush();
		}
	}
	flush();
	return and(parts);
}

function piecesQuery(pieces: readonly Piece[]): Query {
	const atoms: Atom[] = [];
	for (const piece of pieces) {
		if (piece.optional) {
			atoms.push({ kind: 'any' });
		} else if (piece.repeats) {
			atoms.push(piece.atom, { kind: 'any' });
		} else {
			atoms.push(piece.atom);
		}
	}
	return sequenceQuery(atoms);
}

/** Plans a regex. Unparseable patterns plan to "all" (full scan), never to a wrong answer. */
export function planRegex(pattern: string): Query {
	try {
		return or(new Parser(pattern).parse().map(piecesQuery));
	} catch {
		return ALL;
	}
}

/** Plans a fixed string (`--fixed-strings`). */
export function planLiteral(text: string): Query {
	const lines = text.split('\n');
	const parts = lines.filter(l => l.length >= MIN_LITERAL).map((l): Query => ({ kind: 'lit', text: l }));
	return and(parts);
}
