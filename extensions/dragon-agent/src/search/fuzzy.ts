/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fuzzy path scoring for `find_files`, in the spirit of VS Code's quick open: every query
 * character must appear in order; consecutive runs, word starts and matches in the file name
 * score higher. Returns undefined for no match.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
	const q = query.toLowerCase().replace(/\s+/g, '');
	if (!q) {
		return 0;
	}
	const c = candidate.toLowerCase();
	const nameStart = candidate.lastIndexOf('/') + 1;
	let score = 0;
	let ci = 0;
	let previous = -2;
	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi];
		// Prefer the next occurrence at a word start (after / _ - . or a camelCase hump), as long as
		// the rest of the query still fits after it; otherwise take the next occurrence.
		let found = -1;
		const rest = q.slice(qi + 1);
		for (let i = ci; i < c.length; i++) {
			if (c[i] === ch && isWordStart(candidate, i) && fitsAfter(c, i + 1, rest)) {
				found = i;
				break;
			}
		}
		if (found === -1) {
			for (let i = ci; i < c.length; i++) {
				if (c[i] === ch) {
					found = i;
					break;
				}
			}
		}
		if (found === -1) {
			return undefined;
		}
		let bonus = 1;
		if (found === previous + 1) {
			bonus += 5; // consecutive
		}
		if (isWordStart(candidate, found)) {
			bonus += 4; // word start or camelCase hump
		}
		if (found >= nameStart) {
			bonus += 3; // in the file name
		}
		score += bonus;
		previous = found;
		ci = found + 1;
	}
	// Prefer shorter paths and exact file-name hits.
	const name = c.slice(nameStart);
	if (name === q || name.startsWith(q)) {
		score += 20;
	}
	return score - candidate.length * 0.01;
}

function isWordStart(candidate: string, i: number): boolean {
	const before = candidate[i - 1];
	return i === 0 || before === '/' || before === '_' || before === '-' || before === '.' || (!!before && before === before.toLowerCase() && candidate[i] !== candidate[i].toLowerCase());
}

/** True when `rest` is a subsequence of `text` from `start`. */
function fitsAfter(text: string, start: number, rest: string): boolean {
	let j = start;
	for (const ch of rest) {
		j = text.indexOf(ch, j);
		if (j === -1) {
			return false;
		}
		j++;
	}
	return true;
}

/** Converts a glob to a RegExp (`**`, `*`, `?`, `{a,b}`, character classes). */
export function globToRegExp(glob: string): RegExp {
	let re = '';
	let i = 0;
	let braces = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				const slash = glob[i + 2] === '/';
				re += slash ? '(?:.*/)?' : '.*';
				i += slash ? 3 : 2;
				continue;
			}
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '{') {
			braces++;
			re += '(?:';
		} else if (c === '}' && braces) {
			braces--;
			re += ')';
		} else if (c === ',' && braces) {
			re += '|';
		} else if (c === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end === -1) {
				re += '\\[';
			} else {
				re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
				i = end;
			}
		} else {
			re += c.replace(/[.+^$()|\\]/g, '\\$&');
		}
		i++;
	}
	// A glob without a slash matches at any depth, like ripgrep's -g.
	return new RegExp(glob.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

export function isGlob(pattern: string): boolean {
	return /[*?[{]/.test(pattern);
}
