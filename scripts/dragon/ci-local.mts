/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Runs the jobs of .github/workflows/ci.yml on this machine, step for step, against the
// current commit. Each job gets a fresh git worktree (like a fresh runner checkout), the Node
// version pinned in .nvmrc and the Bun version pinned in the workflow. The `run:` steps are
// executed verbatim with bash -eo pipefail, as on GitHub; the actions are replaced by local
// equivalents (checkout: the worktree, setup-node / setup-bun: the pinned versions,
// upload-artifact: a copy under <dir>/artifacts). Nothing is uploaded anywhere.
//
// Usage: node scripts/dragon/ci-local.mts [job ...] [--dir=<path>] [--base=<ref>] [--keep] [--node-headers]
//   job             one or more job ids from ci.yml (default: all, in file order)
//   --dir           where worktrees, logs and artifacts go (default: ../.dragon-ci next to the repo)
//   --base          the base of the change for the hygiene step (default: merge-base with origin/main)
//   --keep          keep each job's worktree even when the job passes (failed jobs are always kept)
//   --node-headers  build native modules against Node's headers (nodejs.org) instead of Electron's
//                   (electronjs.org), for networks that block electronjs.org. A deviation from
//                   GitHub CI; the run says so. Native modules are N-API, so the app still loads them.
//   --reuse-deps    replace `npm ci` steps with a copy of this checkout's node_modules trees and of
//                   the files the build downloads from GitHub (.build/typings, .build/builtInExtensions, .build/electron),
//                   for networks where api.github.com is blocked (@vscode/ripgrep, the Electron typings
//                   and the built-in extensions need it). A deviation from GitHub CI; the run says so.
//
// apt-get steps install only the packages that are missing, so an unrelated broken apt source on
// this machine does not fail the job. Uncommitted changes are not tested: the worktrees check out HEAD.

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..', '..');
const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(text: string): unknown };

interface Step {
	readonly name?: string;
	readonly uses?: string;
	readonly run?: string;
	readonly if?: string;
	readonly with?: Record<string, string | number | boolean>;
	readonly env?: Record<string, string | number | boolean>;
}
interface Job {
	readonly name?: string;
	readonly 'timeout-minutes'?: number;
	readonly steps: readonly Step[];
}

const argv = process.argv.slice(2);
const options = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')).map(([k, v]) => [k, v ?? 'true'])) as Record<string, string>;
const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };
const requested = argv.filter(a => !a.startsWith('--'));
for (const id of requested) {
	if (!workflow.jobs[id]) {
		throw new Error(`ci.yml has no job "${id}". Jobs: ${Object.keys(workflow.jobs).join(', ')}`);
	}
}
const jobIds = requested.length ? requested : Object.keys(workflow.jobs);
const dir = path.resolve(options.dir ?? path.join(root, '..', '.dragon-ci'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const base = options.base ? git('rev-parse', options.base) : git('merge-base', 'HEAD', 'origin/main');
if (git('status', '--porcelain', '--untracked-files=no')) {
	console.warn('warning: the working tree has uncommitted changes; they are not part of this run (HEAD is tested).');
}

/** The Node pinned in .nvmrc: this one when it matches, otherwise a cached download from nodejs.org. */
function pinnedNodeBin(): string {
	const version = readFileSync(path.join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
	if (process.version === `v${version}`) {
		return path.dirname(process.execPath);
	}
	const platform = { linux: 'linux', darwin: 'darwin' }[process.platform as string];
	if (!platform) {
		throw new Error(`Node ${version} is required (.nvmrc); install it, then run this script with it.`);
	}
	const name = `node-v${version}-${platform}-${process.arch}`;
	const cache = path.join(homedir(), '.cache', 'dragon-ci');
	const bin = path.join(cache, name, 'bin');
	if (!existsSync(path.join(bin, 'node'))) {
		mkdirSync(cache, { recursive: true });
		const archive = path.join(cache, `${name}.tar.gz`);
		console.log(`Downloading Node ${version} (pinned in .nvmrc)...`);
		execFileSync('curl', ['-fsSL', '-o', archive, `https://nodejs.org/dist/v${version}/${name}.tar.gz`], { stdio: 'inherit' });
		execFileSync('tar', ['-xzf', archive, '-C', cache], { stdio: 'inherit' });
		rmSync(archive);
	}
	return bin;
}

/** Evaluates the few `${{ }}` expressions ci.yml uses. */
function expand(text: string): string {
	const context: Record<string, string> = {
		'github.event.pull_request.base.sha': base,
		'github.sha': head,
		'github.ref': 'refs/heads/local',
	};
	return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression: string) => {
		for (const term of expression.split('||').map(t => t.trim())) {
			const literal = /^'(.*)'$/.exec(term);
			if (literal) {
				return literal[1];
			}
			if (!(term in context)) {
				throw new Error(`ci-local does not know the expression "${term}"; teach expand() about it.`);
			}
			if (context[term]) {
				return context[term];
			}
		}
		return '';
	});
}

/** apt-get install steps are skipped when every package is already installed. */
function missingAptPackages(script: string): string[] | undefined {
	const match = /apt-get install -y ([^\n&|;]+)/.exec(script);
	if (!match) {
		return undefined;
	}
	return match[1].trim().split(/\s+/).filter(pkg => {
		try {
			return !execFileSync('dpkg-query', ['-W', '-f=${Status}', pkg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('install ok installed');
		} catch {
			return true;
		}
	});
}

function runScript(script: string, cwd: string, env: NodeJS.ProcessEnv, log: NodeJS.WritableStream, timeoutMs: number): Promise<number> {
	return new Promise(resolve => {
		const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
		const forward = (chunk: Buffer) => {
			process.stdout.write(chunk);
			log.write(chunk);
		};
		child.stdout.on('data', forward);
		child.stderr.on('data', forward);
		const timer = setTimeout(() => {
			forward(Buffer.from(`\nci-local: the job timed out; killing the step.\n`));
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch { /* already gone */ }
		}, Math.max(timeoutMs, 1));
		child.on('close', code => {
			clearTimeout(timer);
			resolve(code ?? 1);
		});
	});
}

interface JobResult {
	readonly id: string;
	readonly ok: boolean;
	readonly seconds: number;
	readonly failedStep?: string;
	readonly worktree: string;
}

async function runJob(id: string, job: Job, nodeBin: string): Promise<JobResult> {
	const started = Date.now();
	const deadline = started + (job['timeout-minutes'] ?? 360) * 60_000;
	const jobDir = path.join(dir, id);
	const worktree = path.join(jobDir, 'dragon-ide');
	mkdirSync(path.join(dir, 'logs'), { recursive: true });
	const log = createWriteStream(path.join(dir, 'logs', `${id}.log`));
	const say = (line: string) => {
		console.log(line);
		log.write(line + '\n');
	};
	say(`\n=== ${id}: ${job.name ?? id} (${head.slice(0, 8)}) ===`);

	if (existsSync(worktree)) {
		execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: 'ignore' });
	}
	rmSync(jobDir, { recursive: true, force: true });
	mkdirSync(jobDir, { recursive: true });
	git('worktree', 'prune'); // forget worktrees whose directories were deleted by hand
	git('worktree', 'add', '--detach', worktree, head);

	// GitHub sets CI and GITHUB_WORKSPACE; the Electron unit-test runner shows its window only when it sees them.
	const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', GITHUB_WORKSPACE: worktree, PATH: `${nodeBin}${path.delimiter}${process.env.PATH}` };
	if (options['node-headers'] === 'true') {
		const nodeVersion = execFileSync(path.join(nodeBin, 'node'), ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '');
		Object.assign(env, { npm_config_disturl: 'https://nodejs.org/dist', npm_config_target: nodeVersion, npm_config_runtime: 'node' });
		say(`deviation from GitHub CI: native modules are built against Node ${nodeVersion} headers, not Electron's (--node-headers)`);
	}
	let failedStep: string | undefined;
	for (const [index, step] of job.steps.entries()) {
		const title = step.name ?? step.uses ?? step.run?.split('\n')[0] ?? `step ${index + 1}`;
		const always = step.if?.trim() === 'always()';
		if (step.if && !always) {
			throw new Error(`ci-local does not understand "if: ${step.if}" in ${id}; teach it.`);
		}
		if (failedStep && !always) {
			say(`--- skipped: ${title}`);
			continue;
		}
		say(`--- ${title}`);
		const action = step.uses?.split('@')[0];
		if (action === 'actions/checkout') {
			say(`worktree ${worktree} at ${head}`);
		} else if (action === 'actions/setup-node') {
			say(execFileSync(path.join(nodeBin, 'node'), ['--version'], { encoding: 'utf8' }).trim());
		} else if (action === 'oven-sh/setup-bun') {
			const want = String(step.with?.['bun-version'] ?? '');
			const have = execFileSync('bun', ['--version'], { encoding: 'utf8', env }).trim();
			if (want && have !== want) {
				say(`bun ${want} is required, found ${have}. Install it with: curl -fsSL https://bun.sh/install | bash -s bun-v${want}`);
				failedStep = title;
			} else {
				say(`bun ${have}`);
			}
		} else if (action === 'actions/upload-artifact') {
			const source = path.join(worktree, String(step.with?.path ?? ''));
			const target = path.join(dir, 'artifacts', String(step.with?.name ?? id));
			if (existsSync(source)) {
				rmSync(target, { recursive: true, force: true });
				mkdirSync(target, { recursive: true });
				cpSync(source, statSync(source).isDirectory() ? target : path.join(target, path.basename(source)), { recursive: true });
				say(`artifact -> ${target}`);
			} else {
				say(`warning: nothing to upload at ${source}`);
			}
		} else if (step.run) {
			const script = expand(step.run);
			const missing = missingAptPackages(script);
			if (missing && !missing.length) {
				say('all packages are already installed; skipping apt-get');
				continue;
			}
			const stepEnv = { ...env, ...Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, String(v)])) };
			// Install just the missing packages; apt-get update is allowed to fail on unrelated sources.
			let command = missing ? `sudo apt-get update || true\nsudo apt-get install -y ${missing.join(' ')}` : script;
			if (options['reuse-deps'] === 'true' && /^npm ci( --ignore-scripts)?$/.test(script.trim())) {
				const trees = execFileSync('find', ['.', '-name', 'node_modules', '-type', 'd', '-prune', '-not', '-path', './opencode/*', '-not', '-path', './.build/*', '-not', '-path', './out*'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
				// Also what the build downloads from GitHub: the Electron typings npm ci's postinstall
				// writes (build/npm/electronTypes.ts) and the built-in extensions the packaging fetches.
				const downloads = ['./.build/typings', './.build/builtInExtensions', './.build/electron'].filter(d => existsSync(path.join(root, d)));
				trees.push(...downloads);
				say(`deviation from GitHub CI: "${script.trim()}" replaced by a copy of ${trees.length - downloads.length} node_modules trees and ${downloads.join(', ')} from ${root} (--reuse-deps)`);
				command = trees.map(tree => `mkdir -p "${path.dirname(tree)}" && cp -a "${path.join(root, tree)}" "${tree}"`).join('\n');
			}
			const code = await runScript(command, worktree, stepEnv, log, deadline - Date.now());
			if (code !== 0) {
				say(`--- FAILED (exit ${code}): ${title}`);
				failedStep = title;
			}
		} else {
			throw new Error(`ci-local does not support "${step.uses}" in ${id}; teach it.`);
		}
	}

	const seconds = Math.round((Date.now() - started) / 1000);
	say(`=== ${id}: ${failedStep ? `FAILED at "${failedStep}"` : 'passed'} in ${seconds}s ===`);
	log.end();
	if (!failedStep && options.keep !== 'true') {
		execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root, stdio: 'ignore' });
		rmSync(jobDir, { recursive: true, force: true });
	}
	return { id, ok: !failedStep, seconds, failedStep, worktree };
}

const nodeBin = pinnedNodeBin();
console.log(`ci-local: ${jobIds.join(', ')} on ${head.slice(0, 8)} (base ${base.slice(0, 8)}); output in ${dir}`);
const results: JobResult[] = [];
for (const id of jobIds) {
	results.push(await runJob(id, workflow.jobs[id], nodeBin));
}
console.log('\nci-local summary');
for (const r of results) {
	console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${Math.floor(r.seconds / 60)}m${String(r.seconds % 60).padStart(2, '0')}s${r.ok ? '' : `  failed at "${r.failedStep}"; worktree kept at ${r.worktree}`}`);
}
console.log(`  logs: ${path.join(dir, 'logs')}`);
process.exitCode = results.every(r => r.ok) ? 0 : 1;
