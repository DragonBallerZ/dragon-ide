/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { SearchEngine, unindexableRoot } from '../search/engine';
import { fuzzyScore, globToRegExp } from '../search/fuzzy';
import { TrigramIndex } from '../search/index';
import { planLiteral, planRegex, Query } from '../search/planner';
import { findRipgrep, runRipgrep } from '../search/ripgrep';
import { extractTrigrams, rotl8, trigramKey } from '../search/trigrams';

const lits = (q: Query): string[] => q.kind === 'lit' ? [q.text] : q.kind === 'all' ? [] : q.items.flatMap(lits);

test('planner extracts required literals', () => {
	assert.deepEqual(planRegex('ChatToolInvocationPart'), { kind: 'lit', text: 'ChatToolInvocationPart' });
	assert.deepEqual(planRegex('foo.*barbaz'), { kind: 'and', items: [{ kind: 'lit', text: 'foo' }, { kind: 'lit', text: 'barbaz' }] });
	assert.deepEqual(planRegex('(alpha|beta)Service'), { kind: 'and', items: [{ kind: 'or', items: [{ kind: 'lit', text: 'alpha' }, { kind: 'lit', text: 'beta' }] }, { kind: 'lit', text: 'Service' }] });
	assert.deepEqual(planRegex('TODO|FIXME'), { kind: 'or', items: [{ kind: 'lit', text: 'TODO' }, { kind: 'lit', text: 'FIXME' }] });
	assert.deepEqual(lits(planRegex('class \\w+Service extends')), ['class ', 'Service extends']);
	assert.deepEqual(lits(planRegex('foo\\.bar\\(')), ['foo.bar(']);
	assert.deepEqual(lits(planRegex('colou?r')), ['colo']);
	assert.deepEqual(lits(planRegex('ab+cdef')), ['cdef']);
	assert.deepEqual(lits(planRegex('x{0,3}hello')), ['hello']);
	assert.deepEqual(lits(planRegex('(?i)Hello World')), ['Hello World']);
	assert.deepEqual(lits(planRegex('line one\\nline two')), ['line one', 'line two']);
});

test('planner gives up rather than guessing', () => {
	for (const p of ['a.c', '.*', '[a-z]+', '(foo|x)bar', '(?=abc)', '\\d{4}-\\d{2}', '(', 'a|bc']) {
		const q = planRegex(p);
		// Either unconstrained, or every literal is genuinely required.
		if (p === '(foo|x)bar') {
			assert.deepEqual(q, { kind: 'lit', text: 'bar' });
		} else {
			assert.deepEqual(q, { kind: 'all' }, p);
		}
	}
	assert.deepEqual(planLiteral('a.b*c'), { kind: 'lit', text: 'a.b*c' });
});

test('trigram masks reject non-adjacent and wrongly-followed trigrams', () => {
	const tris = extractTrigrams('abcd');
	assert.ok(tris.has(trigramKey(97, 98, 99)));
	assert.equal(rotl8(0b1000_0000, 1), 0b0000_0001);
	const index = new TrigramIndex('/r');
	index.addFile('adjacent.txt', 'xx abcd yy', { mtimeMs: 1, size: 1 });
	index.addFile('apart.txt', 'abcX ... Xbcd', { mtimeMs: 1, size: 1 }); // has abc and bcd, never abcd
	index.addFile('none.txt', 'nothing here', { mtimeMs: 1, size: 1 });
	assert.deepEqual(index.candidates({ kind: 'lit', text: 'abcd' }), ['adjacent.txt']);
	assert.deepEqual(index.candidates({ kind: 'lit', text: 'ABCD' }), ['adjacent.txt'], 'case-folded');
	assert.equal(index.candidates({ kind: 'all' }), undefined);
});

test('dirty and oversized files are always candidates; deleted ones never', () => {
	const index = new TrigramIndex('/r');
	index.addFile('a.txt', 'hello world', { mtimeMs: 1, size: 11 });
	index.addFile('big.log', undefined, { mtimeMs: 1, size: 9e9 });
	index.markDirty('b.txt');
	assert.deepEqual(index.candidates({ kind: 'lit', text: 'zzzz' })?.sort(), ['b.txt', 'big.log']);
	index.removeFile('a.txt');
	assert.deepEqual(index.candidates({ kind: 'lit', text: 'hello' })?.sort(), ['b.txt', 'big.log']);
});

test('index survives save and load', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dragon-idx-'));
	try {
		const index = new TrigramIndex('/root');
		index.addFile('src/a.ts', 'export const answer = 42;', { mtimeMs: 5, size: 25 });
		index.addFile('src/b.ts', 'import { answer } from "./a";', { mtimeMs: 6, size: 29 });
		index.removeFile('src/b.ts');
		const file = path.join(dir, 'x.trigrams');
		await index.save(file);
		const loaded = await TrigramIndex.load(file, '/root');
		assert.ok(loaded);
		assert.deepEqual(loaded!.paths(), ['src/a.ts']);
		assert.deepEqual(loaded!.candidates({ kind: 'lit', text: 'answer' }), ['src/a.ts']);
		assert.ok(loaded!.isCurrent('src/a.ts', { mtimeMs: 5, size: 25 }));
		assert.equal(await TrigramIndex.load(file, '/other-root'), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A small deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
	return () => {
		seed = (seed + 0x6D2B79F5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ['alpha', 'Beta', 'gamma', 'DELTA', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'fooBar', 'baz_qux', 'x1', '(', ')', ';'];

function randomText(rand: () => number, words: number): string {
	let out = '';
	for (let i = 0; i < words; i++) {
		out += WORDS[Math.floor(rand() * WORDS.length)] + (rand() < 0.15 ? '\n' : ' ');
	}
	return out;
}

test('a spilled, edited and merged index answers exactly like one built in one go', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dragon-idx-'));
	try {
		const rand = random(7);
		const content = new Map<string, string>();
		const file = path.join(dir, 'x.trigrams');
		// A tiny spill threshold forces many runs on disk while indexing.
		const segmented = new TrigramIndex('/root', file, 500);
		for (let i = 0; i < 300; i++) {
			const rel = `src/f${i}.ts`;
			const text = randomText(rand, 5 + Math.floor(rand() * 60));
			content.set(rel, text);
			if (segmented.needsSpill) {
				await segmented.spill();
			}
			segmented.addFile(rel, text, { mtimeMs: i, size: text.length });
		}
		// One file with a line long enough to go into bloom documents.
		const long = 'q'.repeat(300_000) + ' needleInAHaystack ' + randomText(rand, 20).replace(/\n/g, ' ');
		content.set('dist/min.js', long);
		segmented.addFile('dist/min.js', long, { mtimeMs: 1, size: long.length });
		const runs = readdirSync(dir).filter(n => n.includes('.run-')).length;
		assert.ok(runs > 5, `expected spilled runs, got ${runs}`);
		assert.ok(segmented.stats.segments > 5);
		// Edits and deletions after the spills.
		for (let i = 0; i < 60; i++) {
			const rel = `src/f${Math.floor(rand() * 300)}.ts`;
			if (rand() < 0.3) {
				segmented.removeFile(rel);
				content.delete(rel);
			} else {
				const text = randomText(rand, 30);
				segmented.addFile(rel, text, { mtimeMs: 1000 + i, size: text.length });
				content.set(rel, text);
			}
		}

		const fresh = new TrigramIndex('/root');
		for (const [rel, text] of content) {
			fresh.addFile(rel, text, { mtimeMs: 0, size: text.length });
		}
		const queries: string[] = ['needleInAHaystack', 'qqqq needle', 'nothing here at all'];
		for (let i = 0; i < 150; i++) {
			const text = [...content.values()][Math.floor(rand() * content.size)];
			const start = Math.floor(rand() * Math.max(1, text.length - 12));
			queries.push(text.slice(start, start + 3 + Math.floor(rand() * 10)));
		}
		const check = (index: TrigramIndex, label: string) => {
			for (const q of queries) {
				const got = index.candidates({ kind: 'lit', text: q })?.sort();
				assert.deepEqual(got, fresh.candidates({ kind: 'lit', text: q })?.sort(), `${label}: ${JSON.stringify(q)}`);
				// Never a false negative: every file that really contains the literal is a candidate.
				if (!q.includes('\n')) {
					for (const [rel, text] of content) {
						if (text.toLowerCase().includes(q.toLowerCase())) {
							assert.ok(got?.includes(rel), `${label}: ${rel} contains ${JSON.stringify(q)}`);
						}
					}
				}
			}
			assert.deepEqual(index.paths().sort(), [...content.keys()].sort());
		};
		check(segmented, 'segmented');
		assert.ok(segmented.needsMerge);
		await segmented.save();
		assert.equal(segmented.stats.segments, 1);
		assert.equal(segmented.stats.deltaPostings, 0);
		assert.deepEqual(readdirSync(dir), ['x.trigrams'], 'runs are removed once merged');
		check(segmented, 'merged');
		const loaded = await TrigramIndex.load(file, '/root');
		assert.ok(loaded);
		check(loaded!, 'loaded');
		assert.equal(loaded!.stats.postings, segmented.stats.postings);
		// Edits on top of a loaded base, then another merge.
		const text = 'brand new content with uniqueTokenXyz';
		loaded!.addFile('src/new.ts', text, { mtimeMs: 1, size: text.length });
		content.set('src/new.ts', text);
		fresh.addFile('src/new.ts', text, { mtimeMs: 1, size: text.length });
		queries.push('uniqueTokenXyz');
		check(loaded!, 'loaded + delta');
		await loaded!.save();
		check(loaded!, 'merged again');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('damaged, foreign or older index files are rebuilt, and dead processes\' runs are removed', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dragon-idx-'));
	try {
		const index = new TrigramIndex('/root');
		index.addFile('a.ts', 'export const answer = 42;', { mtimeMs: 5, size: 25 });
		const file = path.join(dir, 'x.trigrams');
		await index.save(file);
		const good = readFileSync(file);
		assert.ok(await TrigramIndex.load(file, '/root'));

		writeFileSync(file, good.subarray(0, good.length - 8));
		assert.equal(await TrigramIndex.load(file, '/root'), undefined, 'truncated');
		const older = Buffer.from(good);
		older.writeUInt32LE(6, 4);
		writeFileSync(file, older);
		assert.equal(await TrigramIndex.load(file, '/root'), undefined, 'format version 6');
		writeFileSync(file, '{"version":6}\n');
		assert.equal(await TrigramIndex.load(file, '/root'), undefined, 'the old JSON-headed format');
		assert.equal(await TrigramIndex.load(path.join(dir, 'missing.trigrams'), '/root'), undefined);

		writeFileSync(file, good);
		const deadPid = 2 ** 22 + 12345; // above every platform's pid limit
		writeFileSync(`${file}.run-${deadPid}-1`, 'x');
		writeFileSync(`${file}.${deadPid}.tmp`, 'x');
		writeFileSync(`${file}.run-${process.pid}-1`, 'x'); // a live process's run is left alone
		assert.ok(await TrigramIndex.load(file, '/root'));
		assert.deepEqual(readdirSync(dir).sort(), ['x.trigrams', `x.trigrams.run-${process.pid}-1`]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a run that cannot be written stays in memory and the index still answers', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dragon-idx-'));
	try {
		writeFileSync(path.join(dir, 'not-a-dir'), '');
		const index = new TrigramIndex('/root', path.join(dir, 'not-a-dir', 'x.trigrams'), 10);
		index.addFile('a.ts', 'export const answer = 42;', { mtimeMs: 1, size: 25 });
		await index.spill();
		index.addFile('b.ts', 'the answer is elsewhere', { mtimeMs: 1, size: 23 });
		assert.deepEqual(index.candidates({ kind: 'lit', text: 'answer' })?.sort(), ['a.ts', 'b.ts']);
		assert.equal(index.stats.mappedBytes, 0);
		await assert.rejects(index.save());
		assert.deepEqual(index.candidates({ kind: 'lit', text: 'answer' })?.sort(), ['a.ts', 'b.ts'], 'a failed merge changes nothing');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });

test('under Bun the saved index is memory-mapped, not read into memory', { skip: (bun.status !== 0 || process.platform === 'win32') && 'bun not found' }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'dragon-idx-'));
	try {
		const script = path.join(dir, 'probe.cjs');
		writeFileSync(script, `
			const { TrigramIndex } = require(${JSON.stringify(path.join(__dirname, '..', 'search', 'index.js'))});
			(async () => {
				const file = ${JSON.stringify(path.join(dir, 'x.trigrams'))};
				const index = new TrigramIndex('/root', file);
				for (let i = 0; i < 200; i++) index.addFile('f' + i + '.ts', 'const value' + i + ' = compute(' + i + ');', { mtimeMs: i, size: 30 });
				await index.save();
				const loaded = await TrigramIndex.load(file, '/root');
				console.log(JSON.stringify({ stats: loaded.stats, hits: loaded.candidates({ kind: 'lit', text: 'value17 ' }) }));
			})();
		`);
		const out = spawnSync('bun', [script], { encoding: 'utf8' });
		assert.equal(out.status, 0, out.stderr);
		const { stats, hits } = JSON.parse(out.stdout.trim().split('\n').pop()!);
		assert.deepEqual(hits, ['f17.ts']);
		assert.ok(stats.mappedBytes > 0, JSON.stringify(stats));
		assert.equal(stats.memoryBytes, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('globs and fuzzy scoring', () => {
	assert.ok(globToRegExp('**/*.ts').test('src/a/b.ts'));
	assert.ok(globToRegExp('*.{ts,tsx}').test('deep/x.tsx'));
	assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
	assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
	const exact = fuzzyScore('chatwidget', 'src/chat/chatWidget.ts');
	const scattered = fuzzyScore('chatwidget', 'src/chat/browser/widget/other.ts');
	assert.ok(exact !== undefined && scattered !== undefined && exact > scattered, `${exact} > ${scattered}`);
	assert.ok(fuzzyScore('usrctl', 'src/user/controller.ts') !== undefined);
	assert.equal(fuzzyScore('zzz', 'src/a.ts'), undefined);
});

const rg = findRipgrep({ appRoot: path.join(__dirname, '..', '..', '..', '..') });

test('a changed file that is gone by the time ripgrep runs does not fail the search', { skip: !rg && 'ripgrep not found' }, async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'dragon-grep-'));
	const engine = new SearchEngine(root, rg!, undefined);
	try {
		writeFileSync(path.join(root, 'hello.txt'), 'hello world\n');
		await engine.start();
		// A file the watcher reported (an editor's temporary file, say) and that was deleted again
		// before the refresh: it is still a dirty candidate, which ripgrep can no longer open.
		(engine as unknown as { index: TrigramIndex }).index.markDirty('hello.txt.tmp-1234');
		for (const params of [{ pattern: 'hello w[a-z]+' }, { pattern: 'hello w[a-z]+', filesOnly: true }]) {
			const result = await engine.grep(params);
			assert.equal(result.mode, 'index');
			assert.deepEqual([...new Set(result.files)], ['hello.txt'], JSON.stringify(params));
		}
	} finally {
		engine.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test('Instant Grep returns exactly what ripgrep returns', { skip: !rg && 'ripgrep not found', timeout: 120_000 }, async t => {
	const root = mkdtempSync(path.join(tmpdir(), 'dragon-grep-'));
	const storage = mkdtempSync(path.join(tmpdir(), 'dragon-grep-store-'));
	// A small synthetic repository with hidden, ignored, binary and oversized files.
	const words = ['alpha', 'beta', 'gamma', 'delta', 'Service', 'Controller', 'handleRequest', 'TODO', 'FIXME', 'foo', 'bar', 'baz', 'Æther', 'naïve'];
	let seed = 7;
	const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let f = 0; f < 300; f++) {
		const dir = path.join(root, `pkg${f % 7}`, f % 3 ? 'src' : 'test');
		mkdirSync(dir, { recursive: true });
		const lines = Array.from({ length: 5 + Math.floor(rand() * 30) }, () => Array.from({ length: 2 + Math.floor(rand() * 8) }, () => words[Math.floor(rand() * words.length)]).join(rand() < 0.3 ? '.' : ' '));
		writeFileSync(path.join(dir, `file${f}.${['ts', 'js', 'md'][f % 3]}`), lines.join('\n') + '\n');
	}
	mkdirSync(path.join(root, '.github'));
	writeFileSync(path.join(root, '.github', 'ci.yml'), 'run: handleRequest alpha\n');
	writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
	mkdirSync(path.join(root, 'ignored'));
	writeFileSync(path.join(root, 'ignored', 'x.ts'), 'handleRequest alpha\n');
	writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 104, 97, 110, 100, 108, 101, 0]));
	writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(17 * 1024 * 1024) + '\nalpha Controller\n');
	// UTF-16 with a byte-order mark: ripgrep transcodes these, so they must be found too.
	writeFileSync(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('line one\r\nhandleRequest alpha\r\n', 'utf16le')]));
	writeFileSync(path.join(root, 'crlf.ts'), 'first handleRequest\r\nsecond\r\nthird handleRequest again\r\n');
	// Unicode case folding: ripgrep's -i matches the Kelvin sign with k and the long s with s.
	writeFileSync(path.join(root, 'fold.md'), 'ÆTHER CONTROLLER\nthe \u212Aey\n\u017Fervice alpha\n');
	// A UTF-8 byte-order mark and invalid UTF-8: ripgrep reads both specially, so they are left to it.
	writeFileSync(path.join(root, 'bom8.ts'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('handleRequest alpha\n')]));
	writeFileSync(path.join(root, 'latin1.txt'), Buffer.concat([Buffer.from('invalidUtf8Marker caf'), Buffer.from([0xE9, 0x0A])]));
	// A large single-line file (like a recorded fixture) is indexed and verified in-process.
	writeFileSync(path.join(root, 'blob.json'), `{"data":"${'QUJD'.repeat(600_000)}","note":"handleRequest again"}\n`);
	const { execFileSync } = await import('node:child_process');
	try {
		execFileSync('git', ['init', '-q'], { cwd: root });
	} catch {
		// .gitignore is honoured by ripgrep with or without git
	}

	const engine = new SearchEngine(root, rg!, storage);
	try {
		await engine.start();
		const cases: [string, { fixedStrings?: boolean; caseSensitive?: boolean; include?: string[] }][] = [
			['handleRequest', {}], ['alpha Controller', {}], ['(foo|bar)\\.baz', {}], ['TODO|FIXME', {}], ['Service\\b', {}],
			['gamma.delta', {}], ['^beta', {}], ['Æther', {}], ['naïve Service', {}], ['nothing_matches_this', {}],
			['a.b', {}], ['foo.bar', { fixedStrings: true }], ['ALPHA', { caseSensitive: false }], ['ALPHA', { caseSensitive: true }],
			['Controller', { include: ['*.ts'] }], ['æther', { caseSensitive: false }], ['key', { caseSensitive: false }],
			['service alpha', { caseSensitive: false }], ['æther controller', {}], ['invalidUtf8Marker', {}], ['handleRequest again', {}],
		];
		let indexed = 0;
		for (const [pattern, opts] of cases) {
			const result = await engine.grep({ pattern, ...opts, filesOnly: true, maxResults: 1000 });
			if (result.mode === 'index') {
				indexed++;
			}
			const args = ['-l', '--hidden', '--no-messages', '-g', '!**/.git/**', opts.fixedStrings ? '-F' : '', opts.caseSensitive === true ? '-s' : opts.caseSensitive === false ? '-i' : '-S', ...(opts.include ?? []).flatMap(g => ['-g', g]), '-e', pattern, '.'].filter(Boolean);
			const expected = (await runRipgrep(rg!, args, root)).stdout.split('\n').filter(Boolean).map(p => p.replace(/^\.\//, '').replace(/\\/g, '/')).sort();
			assert.deepEqual(result.files, expected, `pattern ${pattern} ${JSON.stringify(opts)} (${result.mode}, ${result.candidates} candidates)`);
		}
		assert.ok(indexed >= 10, `most cases should be answered from the index (got ${indexed})`);

		// Line-level equality with ripgrep, including the in-process fast path for literals.
		const lineCases: [string, { fixedStrings?: boolean; caseSensitive?: boolean }][] = [
			['handleRequest again', {}], ['handleRequest alpha', {}], ['naïve Controller', { fixedStrings: true }], ['Æther Controller', { caseSensitive: true }],
			['ALPHA controller', { caseSensitive: false }], ['æther controller', {}], ['SERVICE ALPHA', { caseSensitive: false }],
		];
		for (const [pattern, opts] of lineCases) {
			const mine = await engine.grep({ pattern, ...opts, context: 1, maxResults: 1000 });
			const args = ['--json', '--hidden', '--no-messages', '-g', '!**/.git/**', '--context', '1', opts.fixedStrings ? '-F' : '', opts.caseSensitive === true ? '-s' : opts.caseSensitive === false ? '-i' : '-S', '-e', pattern, '.'].filter(Boolean);
			const events = (await runRipgrep(rg!, args, root)).stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
			const expected = events.filter(e => e.type === 'match' || e.type === 'context').map(e => `${e.data.path.text.replace(/^\.\//, '')}:${e.data.line_number}:${e.type}:${e.data.lines.text.replace(/\r?\n$/, '')}`).sort();
			const actual = mine.matches.map(m => `${m.path}:${m.line}:${m.context ? 'context' : 'match'}:${m.text}`).sort();
			assert.ok(expected.length > 0 && expected.length < 900, `${pattern} is a useful probe (${expected.length} lines)`);
			assert.deepEqual(actual, expected, `lines for ${pattern} ${JSON.stringify(opts)} (${mine.mode})`);
		}
		// Literals over indexed files are verified in-process, without starting ripgrep.
		const runs = engine.stats.ripgrepRuns;
		const started = Date.now();
		const literal = await engine.grep({ pattern: 'handleRequest again', include: ['*.ts', '*.json'], maxResults: 1000 });
		t.diagnostic(`literal search: ${Date.now() - started} ms`);
		assert.deepEqual(literal.files, ['blob.json', 'crlf.ts', ...literal.files.filter(p => p.startsWith('pkg'))]);
		assert.ok(literal.matches.some(m => m.path === 'blob.json' && m.text.endsWith('"note":"handleRequest again"}')));
		assert.equal(engine.stats.ripgrepRuns, runs, 'no ripgrep process for an indexed literal');

		// Freshness: an edit is found before the index catches up, and after it does.
		writeFileSync(path.join(root, 'pkg1', 'src', 'fresh.ts'), 'brandNewSymbolXyz\n');
		// Visible as soon as the OS delivers the change event (well under a second), before re-indexing.
		const deadline = Date.now() + 3000;
		let before = await engine.grep({ pattern: 'brandNewSymbolXyz', filesOnly: true });
		while (!before.files.length && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 20));
			before = await engine.grep({ pattern: 'brandNewSymbolXyz', filesOnly: true });
		}
		assert.deepEqual(before.files, ['pkg1/src/fresh.ts']);
		await new Promise(resolve => setTimeout(resolve, 800));
		const after = await engine.grep({ pattern: 'brandNewSymbolXyz', filesOnly: true });
		assert.deepEqual(after.files, ['pkg1/src/fresh.ts']);
		t.diagnostic(`after re-index: ${after.mode}, ${after.candidates} candidate(s)`);

		// Context lines and truncation.
		const withContext = await engine.grep({ pattern: 'brandNewSymbolXyz', context: 1 });
		assert.equal(withContext.matches.filter(m => !m.context).length, 1);
		const capped = await engine.grep({ pattern: 'alpha', maxResults: 5 });
		assert.ok(capped.truncated);
		assert.equal(capped.matches.filter(m => !m.context).length, 5);

		// find_files
		assert.equal((await engine.findFiles('fresh'))[0], 'pkg1/src/fresh.ts');
		assert.ok((await engine.findFiles('pkg2/**/*.md')).every(p => p.startsWith('pkg2/') && p.endsWith('.md')));
	} finally {
		engine.dispose();
		rmSync(root, { recursive: true, force: true });
		rmSync(storage, { recursive: true, force: true });
	}
});


test('index refuses account roots, ancestors and filesystem roots', async () => {
	assert.ok(unindexableRoot('/Users/me', '/Users/me'));
	assert.ok(unindexableRoot('/Users', '/Users/me'));
	assert.ok(unindexableRoot('/', '/Users/me'));
	assert.equal(unindexableRoot('/Users/mee/project', '/Users/me'), false);
	assert.equal(unindexableRoot('/Users/me/project', '/Users/me'), false);
	const root = mkdtempSync(path.join(tmpdir(), 'dragon-home-guard-'));
	const engine = new SearchEngine(root, 'must-not-run', undefined, undefined, { home: root });
	try {
		await engine.start();
		assert.equal(engine.isReady, false);
		assert.match(engine.stats.disabledReason!, /home directories/);
		assert.deepEqual(engine.textFiles(), []);
	} finally { engine.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test('file and disk budgets retain correct ripgrep fallback without writing an index', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'dragon-budget-'));
	const storage = path.join(root, 'storage');
	writeFileSync(path.join(root, 'a.txt'), 'needle in haystack');
	writeFileSync(path.join(root, 'b.txt'), 'another needle');
	const rg = findRipgrep({ appRoot: path.resolve(__dirname, '../../../..') })!;
	assert.ok(rg);
	try {
		for (const options of [{ maxFiles: 1 }, { freeBytes: async () => 1024 }]) {
			const engine = new SearchEngine(root, rg, storage, undefined, options);
			try {
				await engine.start();
				assert.equal(engine.isReady, false);
				assert.ok(engine.stats.disabledReason);
				const result = await engine.grep({ pattern: 'needle', fixedStrings: true });
				assert.equal(result.mode, 'scan');
				assert.equal(result.totalMatches, 2);
				assert.ok(!readdirSync(root).includes('storage'));
			} finally { engine.dispose(); }
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});


test('disk exhaustion during spills cleans temporary runs and preserves scan results', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'dragon-spill-budget-'));
	const storage = mkdtempSync(path.join(tmpdir(), 'dragon-spill-store-'));
	for (let i = 0; i < 4; i++) { writeFileSync(path.join(root, `${i}.txt`), `needle ${i} hello world`); }
	let checks = 0;
	const rg = findRipgrep({ appRoot: path.resolve(__dirname, '../../../..') })!;
	const engine = new SearchEngine(root, rg, storage, undefined, { spillPostings: 1, freeBytes: async () => ++checks < 5 ? 80 * 1024 ** 3 : 1024 });
	try {
		await engine.start();
		assert.ok(checks >= 5);
		assert.equal(engine.isReady, false);
		assert.match(engine.stats.disabledReason!, /disk-space/);
		assert.deepEqual(readdirSync(storage), []);
		assert.equal((await engine.grep({ pattern: 'needle', fixedStrings: true })).totalMatches, 4);
	} finally { engine.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(storage, { recursive: true, force: true }); }
});
