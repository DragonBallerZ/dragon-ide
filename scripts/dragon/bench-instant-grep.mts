/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Benchmarks Instant Grep against plain ripgrep on a repository and checks that both return the
// same files for every pattern.
//
//   npx tsc -p extensions/dragon-agent && node scripts/dragon/bench-instant-grep.mts [repo] [pattern ...]

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const out = path.resolve(import.meta.dirname, '..', '..', 'extensions', 'dragon-agent', 'out', 'search');
const { SearchEngine } = require(path.join(out, 'engine.js'));
const { findRipgrep, runRipgrep } = require(path.join(out, 'ripgrep.js'));

const root = path.resolve(process.argv[2] ?? '.');
const patterns = process.argv.length > 3 ? process.argv.slice(3) : [
	'registerWorkbenchContribution2\\(', 'class \\w+Service extends Disposable', 'TODO|FIXME', '(foo|bar)baz',
	'nonexistent_symbol_xyz_123', 'onDidChange[A-Z]\\w+Configuration', 'function\\s+activate', '\\bawait\\s+Promise\\.all\\b',
	'IOnboardingService', 'ChatToolInvocationPart', 'createDecorator',
];
const rg = findRipgrep({ appRoot: path.resolve(import.meta.dirname, '..', '..') });
if (!rg) {
	throw new Error('ripgrep not found');
}
const storage = mkdtempSync(path.join(tmpdir(), 'instant-grep-bench-'));
const engine = new SearchEngine(root, rg, storage, (line: string) => console.log(line));
let t = Date.now();
await engine.start();
console.log(`index ready in ${Date.now() - t} ms`, engine.stats);

let indexTotal = 0;
let rgTotal = 0;
let mismatches = 0;
for (const pattern of patterns) {
	t = Date.now();
	const runs = engine.stats.ripgrepRuns;
	const result = await engine.grep({ pattern, filesOnly: true, maxResults: 1000 });
	const indexMs = Date.now() - t;
	const verified = engine.stats.ripgrepRuns === runs ? 'in-process' : 'ripgrep';
	t = Date.now();
	const { stdout } = await runRipgrep(rg, ['-l', '--hidden', '--no-messages', '-S', '-g', '!**/.git/**', '-g', '!**/node_modules/**', '-e', pattern, '.'], root);
	const rgMs = Date.now() - t;
	const expected = stdout.split('\n').filter(Boolean).map((p: string) => p.replace(/^\.\//, '').replace(/\\/g, '/')).sort();
	const same = JSON.stringify(expected) === JSON.stringify(result.files);
	mismatches += same ? 0 : 1;
	indexTotal += indexMs;
	rgTotal += rgMs;
	console.log(`${same ? 'OK ' : 'BAD'} ${String(indexMs).padStart(6)} ms instant (${result.mode}, ${result.candidates} candidates, ${verified}) | ${String(rgMs).padStart(6)} ms ripgrep | ${expected.length} files | ${pattern}`);
}
console.log(`\ntotal: instant ${indexTotal} ms, ripgrep ${rgTotal} ms (${(rgTotal / Math.max(1, indexTotal)).toFixed(1)}x); mismatches: ${mismatches}`);
engine.dispose();
rmSync(storage, { recursive: true, force: true });
process.exit(mismatches ? 1 : 0);
