/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end: agents are kept to the folders open in the window, on the real OpenCode binary with
 * Dragon's config layers and plugins, against a scripted model. Every permission OpenCode asks for
 * is approved, as Full Access does. Runs when an `opencode` binary is available; the shell sandbox
 * on macOS.
 */

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { TurnOp, TurnReducer } from '../chat/turn';
import { buildDragonConfig, confinementEnv, confinesToFolders, PermissionMode, writeDragonConfig, writeSearchPlugin } from '../dragonConfig';
import { OpenCodeClient } from '../opencode/client';
import { OpenCodeServer, resolveBinary } from '../opencode/server';
import type { OpenCodeEvent } from '../opencode/types';
import { prepareSandbox } from '../sandbox/sandbox';
import { findRipgrep } from '../search/ripgrep';
import { MockOllama, ScriptStep, startMockOllama } from './mockOllama';

const extensionPath = path.join(__dirname, '..', '..');
const binary = process.env.DRAGON_OPENCODE_BIN ?? resolveBinary({ extensionPath, env: { PATH: '' } });
const MODEL = 'qwen2.5-coder:7b-dragon-32k';
/** OpenCode gives GPT-5 models its patch tool in place of write and edit. */
const PATCHING_MODEL = 'gpt-5-dragon-mock';
/** What the file outside the open folders holds; no request to the model may carry it. */
const SECRET = 'not-for-agents-7f3a';

interface Confined {
	/** The client of the server now running. */
	readonly client: OpenCodeClient;
	readonly server: OpenCodeServer;
	readonly mock: MockOllama;
	/** The folders outside the session's that OpenCode asked to use. */
	readonly asked: string[];
	readonly seen: OpenCodeEvent[];
	until(what: string, check: () => boolean): Promise<void>;
	ended(sessionID: string): boolean;
	/** Each tool call's result: `name: output` or `name failed: message`. */
	results(sessionID: string): string[];
	/** Changes the folders open in the window, as the extension does (`reconfine` in extension.ts). */
	reopen(folders: readonly string[]): Promise<void>;
	close(): Promise<void>;
}

/**
 * Starts the real binary as the extension does (`serverEnv` in extension.ts) for a window with
 * `folders` open, the first one the server's folder, in a home folder of its own, and answers every
 * permission request as Full Access does. The shell sandbox is made when `sandbox` is set.
 */
async function startConfined(home: string, folders: readonly string[], scenarios: Record<string, ScriptStep[]>, sandbox: boolean, mode: PermissionMode = 'project'): Promise<Confined> {
	const temp = path.dirname(home);
	const mock = await startMockOllama([{ kind: 'text', chunks: ['No scenario.'] }], MODEL, 0, { scenarios });
	const configFile = path.join(home, 'dragon.json');
	const pluginDir = path.join(temp, 'instant-grep');
	const sandboxPluginDir = path.join(temp, 'sandbox-plugin');
	await writeSearchPlugin(pluginDir, path.join(__dirname, '..', 'search', 'opencodePlugin.js'));
	await writeSearchPlugin(sandboxPluginDir, path.join(__dirname, '..', 'sandbox', 'opencodePlugin.js'), 'sandbox');
	await writeDragonConfig(configFile, buildDragonConfig({ model: `ollama/${MODEL}`, ollamaOrigin: mock.origin, ollamaModels: [{ name: MODEL, size: 1 }, { name: PATCHING_MODEL, size: 1 }], searchPluginDir: pluginDir, sandboxPluginDir }));
	const semanticConfig = path.join(temp, 'semantic.json');
	writeFileSync(semanticConfig, JSON.stringify({ enabled: false }));
	const rg = findRipgrep({ appRoot: path.join(extensionPath, '..', '..') });
	assert.ok(rg, 'ripgrep is available');
	const dataHome = path.join(home, '.local', 'share');
	const serverEnv = async (open: readonly string[]): Promise<Record<string, string>> => {
		const prepared = sandbox && confinesToFolders(mode) ? await prepareSandbox({ folders: open, home, pathEnv: process.env.PATH ?? '', closed: [] }) : undefined;
		assert.ok(!prepared || prepared.ok, JSON.stringify(prepared));
		return {
			DRAGON_RG_PATH: rg!, DRAGON_SEARCH_STORAGE: path.join(temp, 'index'), DRAGON_SEMANTIC_CONFIG: semanticConfig,
			...confinementEnv(mode, { folders: open, home, tmpdir: tmpdir(), dataHome, trustedPlugins: [pluginDir, sandboxPluginDir] }, prepared?.ok ? { ...prepared.variables } : {}),
		};
	};
	const logs: string[] = [];
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: folders[0], configFile,
		log: line => { logs.push(line); if (process.env.DRAGON_TEST_LOG) { console.error(line); } },
		extraEnv: await serverEnv(folders),
		env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache') },
	});
	const controller = new AbortController();
	let client = await server.ensure();
	for (let i = 0; i < 120 && !(await client.models(folders[0])).some(m => m.providerID === 'ollama'); i++) {
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	const seen: OpenCodeEvent[] = [];
	const reducers = new Map<string, TurnReducer>();
	const opsOf = new Map<string, TurnOp[]>();
	const asked: string[] = [];
	const waiters = new Set<() => void>();
	const follow = async (event: OpenCodeEvent) => {
		seen.push(event);
		const sessionID = typeof event.data.sessionID === 'string' ? event.data.sessionID : undefined;
		if (sessionID) {
			const reducer = reducers.get(sessionID) ?? reducers.set(sessionID, new TurnReducer(sessionID)).get(sessionID)!;
			for (const op of reducer.reduce(event)) {
				opsOf.set(sessionID, [...opsOf.get(sessionID) ?? [], op]);
				if (op.kind === 'permission') {
					if (op.request.action === 'external_directory') {
						asked.push(op.request.resources.join(' '));
					}
					await client.replyPermission(op.request.sessionID, op.request.id, 'once');
				}
			}
		}
		waiters.forEach(w => w());
	};
	// Follows the server through a restart, as the extension's event stream does.
	void (async () => {
		while (!controller.signal.aborted) {
			try {
				client = await server.ensure();
				for await (const event of client.events(controller.signal)) {
					await follow(event);
				}
			} catch {
				// The server stopped; the next one is waited for.
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}
	})();
	return {
		get client() { return client; },
		server, mock, asked, seen,
		async until(what, check) {
			const deadline = Date.now() + 90_000;
			while (!check()) {
				if (Date.now() > deadline) {
					assert.fail(`timed out waiting for ${what}\n${logs.slice(-30).join('\n')}`);
				}
				await new Promise<void>(resolve => { const w = () => { waiters.delete(w); resolve(); }; waiters.add(w); setTimeout(w, 250); });
			}
		},
		ended: sessionID => seen.some(e => e.data.sessionID === sessionID && e.type.startsWith('session.execution.') && e.type !== 'session.execution.started'),
		results: sessionID => (opsOf.get(sessionID) ?? []).flatMap(op => op.kind === 'tool-done' ? [`${op.name}: ${op.output}`] : op.kind === 'tool-error' ? [`${op.name} failed: ${op.message}`] : []),
		async reopen(open) {
			await server.reconfigure({ extraEnv: await serverEnv(open) });
			const restarted = await server.ensure();
			for (let i = 0; i < 120 && !(await restarted.models(open[0])).some(m => m.providerID === 'ollama'); i++) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}
		},
		async close() {
			controller.abort();
			server.dispose();
			await mock.close();
		},
	};
}

test('agents\' file tools reach the folders open in the window and OpenCode\'s own, and no other, with every request approved', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-confine-')));
	// The project is in the home folder, as most are; so is the folder it must not reach.
	const home = path.join(temp, 'home');
	const workspace = path.join(home, 'game');
	const second = path.join(temp, 'assets');
	const outside = path.join(home, 'private');
	for (const dir of [workspace, second, outside]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
	writeFileSync(path.join(second, 'art.txt'), 'art\n');
	writeFileSync(path.join(outside, 'secret.txt'), `${SECRET}\n`);
	const confined = await startConfined(home, [workspace, second], {
		peek: [
			{ kind: 'tool', name: 'read', args: { path: path.join(outside, 'secret.txt') } },
			{ kind: 'tool', name: 'read', args: { path: outside } },
			{ kind: 'tool', name: 'read', args: { path: '../private/secret.txt' } },
			{ kind: 'tool', name: 'write', args: { path: path.join(outside, 'planted.txt'), content: 'planted\n' } },
			{ kind: 'tool', name: 'edit', args: { path: path.join(outside, 'secret.txt'), oldString: 'agents', newString: 'anyone' } },
			{ kind: 'tool', name: 'grep', args: { pattern: 'agents', path: outside } },
			{ kind: 'tool', name: 'glob', args: { pattern: '*.txt', path: outside } },
			{ kind: 'tool', name: 'read', args: { path: 'hello.txt' } },
			{ kind: 'tool', name: 'read', args: { path: path.join(second, 'art.txt') } },
			{ kind: 'tool', name: 'write', args: { path: path.join(second, 'new.txt'), content: 'new\n' } },
			{ kind: 'tool', name: 'subagent', args: { agent: 'explore', description: 'Look around', prompt: '[[mock:explore-peek]] Look around.' } },
			{ kind: 'text', chunks: ['Done.'] },
		],
		'explore-peek': [
			{ kind: 'tool', name: 'read', args: { path: path.join(outside, 'secret.txt') } },
			{ kind: 'text', chunks: ['Looked.'] },
		],
		'patch-peek': [
			{ kind: 'tool', name: 'patch', args: { patchText: `*** Begin Patch\n*** Add File: ${path.join(outside, 'patched.txt')}\n+patched\n*** End Patch` } },
			{ kind: 'text', chunks: ['Patched.'] },
		],
	}, false);
	const { client, mock, asked, seen, until, ended, results } = confined;
	const outcomes = (sessionID: string) => results(sessionID).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`));
	try {
		const peek = (await client.createSession({ directory: workspace, title: 'peek', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await client.prompt(peek, { text: '[[mock:peek]] Look around.' });
		await until('the agent to finish', () => ended(peek));
		const explore = String(seen.find(event => event.type === 'session.created' && event.data.parentID === peek)?.data.sessionID);
		await until('the explore subagent to finish', () => ended(explore));
		const patcher = (await client.createSession({ directory: workspace, title: 'patcher', agent: 'build', model: { providerID: 'ollama', id: PATCHING_MODEL } })).id;
		await client.prompt(patcher, { text: '[[mock:patch-peek]] Patch.' });
		await until('the patcher to finish', () => ended(patcher));
		t.diagnostic(`peek: ${JSON.stringify(results(peek))}`);
		t.diagnostic(`explore: ${JSON.stringify(results(explore))}; patcher: ${JSON.stringify(results(patcher))}; asked: ${JSON.stringify(asked)}`);

		assert.deepEqual({
			peek: outcomes(peek),
			explore: outcomes(explore),
			patcher: outcomes(patcher),
			asked,
			leaked: JSON.stringify(mock.requests).includes(SECRET),
			outside: { planted: existsSync(path.join(outside, 'planted.txt')), patched: existsSync(path.join(outside, 'patched.txt')), secret: readFileSync(path.join(outside, 'secret.txt'), 'utf8') },
			second: readFileSync(path.join(second, 'new.txt'), 'utf8'),
		}, {
			peek: ['read failed', 'read failed', 'read failed', 'write failed', 'edit failed', 'grep failed', 'glob failed', 'read ran', 'read ran', 'write ran', 'subagent ran'],
			explore: ['read failed'],
			patcher: ['patch failed'],
			asked: [],
			leaked: false,
			outside: { planted: false, patched: false, secret: `${SECRET}\n` },
			second: 'new\n',
		});
	} finally {
		await confined.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test('a symbolic link in an open folder does not take agents\' file tools out of the open folders', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-linked-')));
	const home = path.join(temp, 'home');
	const workspace = path.join(home, 'game');
	const outside = path.join(home, 'private');
	for (const dir of [workspace, outside]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
	writeFileSync(path.join(outside, 'secret.txt'), `${SECRET}\n`);
	// Links a command or a cloned repository could have made.
	symlinkSync(outside, path.join(workspace, 'out'));
	symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'notes.txt'));
	const calls: ScriptStep[] = [
		{ kind: 'tool', name: 'read', args: { path: 'notes.txt' } },
		{ kind: 'tool', name: 'read', args: { path: path.join(workspace, 'out', 'secret.txt') } },
		{ kind: 'tool', name: 'read', args: { path: 'out' } },
		{ kind: 'tool', name: 'grep', args: { pattern: 'agents', path: 'out' } },
		{ kind: 'tool', name: 'glob', args: { pattern: '*.txt', path: 'out' } },
		{ kind: 'tool', name: 'codebase_search', args: { query: 'agents', path: 'out' } },
		{ kind: 'tool', name: 'write', args: { path: 'out/planted.txt', content: 'planted\n' } },
		{ kind: 'tool', name: 'edit', args: { path: 'notes.txt', oldString: 'agents', newString: 'anyone' } },
		// The folder's own files, and a search of the whole folder, which does not follow links.
		{ kind: 'tool', name: 'read', args: { path: 'hello.txt' } },
		{ kind: 'tool', name: 'grep', args: { pattern: 'not-for' } },
		{ kind: 'tool', name: 'write', args: { path: 'levels/one.txt', content: 'one\n' } },
	];
	const confined = await startConfined(home, [workspace], {
		linked: [...calls, { kind: 'text', chunks: ['Done.'] }],
		'patch-linked': [
			{ kind: 'tool', name: 'patch', args: { patchText: '*** Begin Patch\n*** Add File: out/patched.txt\n+patched\n*** End Patch' } },
			{ kind: 'text', chunks: ['Patched.'] },
		],
	}, false);
	const { client, mock, until, ended, results } = confined;
	const outcomes = (sessionID: string) => results(sessionID).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`));
	try {
		const linked = (await client.createSession({ directory: workspace, title: 'linked', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await client.prompt(linked, { text: '[[mock:linked]] Look around.' });
		await until('the agent to finish', () => ended(linked));
		const patcher = (await client.createSession({ directory: workspace, title: 'patcher', agent: 'build', model: { providerID: 'ollama', id: PATCHING_MODEL } })).id;
		await client.prompt(patcher, { text: '[[mock:patch-linked]] Patch.' });
		await until('the patcher to finish', () => ended(patcher));
		t.diagnostic(`linked: ${JSON.stringify(results(linked))}; patcher: ${JSON.stringify(results(patcher))}`);
		assert.deepEqual({
			linked: outcomes(linked),
			patcher: outcomes(patcher),
			told: results(linked)[0],
			leaked: JSON.stringify(mock.requests).includes(SECRET),
			outside: { planted: existsSync(path.join(outside, 'planted.txt')), patched: existsSync(path.join(outside, 'patched.txt')), secret: readFileSync(path.join(outside, 'secret.txt'), 'utf8') },
			made: readFileSync(path.join(workspace, 'levels', 'one.txt'), 'utf8'),
		}, {
			linked: [...calls.slice(0, 8).map(call => `${call.kind === 'tool' && call.name} failed`), 'read ran', 'grep ran', 'write ran'],
			patcher: ['patch failed'],
			told: 'read failed: notes.txt leads outside the folders open in the window through a symbolic link. Agents are kept to those folders.',
			leaked: false,
			outside: { planted: false, patched: false, secret: `${SECRET}\n` },
			made: 'one\n',
		});
	} finally {
		await confined.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test('output OpenCode saved for other windows, and links in the folders it keeps open to agents, do not take agents\' file tools out of the open folders', { skip: (!binary && 'no opencode binary') || (process.platform === 'win32' && 'the link is made with ln'), timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-saved-')));
	const home = path.join(temp, 'home');
	const workspace = path.join(home, 'game');
	const outside = path.join(home, 'private');
	for (const dir of [workspace, outside]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(outside, 'secret.txt'), `${SECRET}\n`);
	// Long output is saved after five lines, so a short command's is.
	writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({ tool_output: { max_lines: 5 } }));
	// What OpenCode saved for an agent of another window, or of OpenCode on its own, in another project.
	const OTHER = 'other-window-output-5c1e';
	const data = path.join(home, '.local', 'share', 'opencode');
	const otherOutput = path.join(data, 'tool-output', 'tool_0ffd7fd12001Other0window0');
	const otherShell = path.join(data, 'shell', '0123456789abcdef0123456789abcdef01234567', 'sh_0ffd7fd12001Other0window0.out');
	for (const file of [otherOutput, otherShell]) {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, `${OTHER}\n`);
	}
	// OpenCode's temp folder is open to agents' commands and file tools; a command links it to the private folder.
	const scratch = path.join(tmpdir(), 'opencode');
	const tmpLink = path.join(scratch, `dragon-link-${process.pid}`);
	const scratchFile = path.join(scratch, `dragon-scratch-${process.pid}.txt`);
	// The plan agent's folder, which no command of Dragon's sandbox reaches, linked the same way.
	mkdirSync(path.join(home, '.opencode', 'plan'), { recursive: true });
	symlinkSync(outside, path.join(home, '.opencode', 'plan', 'notes'));
	const calls: ScriptStep[] = [
		{ kind: 'tool', name: 'shell', args: { command: `ln -s '${outside}' '${tmpLink}'` } },
		// The agent's own saved output, which it is told to read.
		{ kind: 'tool', name: 'shell', args: { command: 'seq 1 20' } },
		{ kind: 'tool', name: 'read', args: { path: '[[mock:saved]]' } },
		{ kind: 'tool', name: 'subagent', args: { agent: 'explore', description: 'Look around', prompt: '[[mock:long]] Report.' } },
		{ kind: 'tool', name: 'read', args: { path: '[[mock:saved]]' } },
		// Another window's, and the folders they are kept in.
		{ kind: 'tool', name: 'read', args: { path: otherOutput } },
		{ kind: 'tool', name: 'read', args: { path: otherShell } },
		{ kind: 'tool', name: 'glob', args: { pattern: '*', path: path.dirname(otherOutput) } },
		{ kind: 'tool', name: 'grep', args: { pattern: 'other', path: path.join(data, 'shell') } },
		{ kind: 'tool', name: 'read', args: { path: path.dirname(otherOutput) } },
		// Through the links.
		{ kind: 'tool', name: 'read', args: { path: path.join(tmpLink, 'secret.txt') } },
		{ kind: 'tool', name: 'glob', args: { pattern: '*.txt', path: tmpLink } },
		{ kind: 'tool', name: 'read', args: { path: '~/.opencode/plan/notes/secret.txt' } },
		// OpenCode's temp folder itself stays open.
		{ kind: 'tool', name: 'write', args: { path: scratchFile, content: 'scratch\n' } },
		{ kind: 'tool', name: 'read', args: { path: scratchFile } },
	];
	const confined = await startConfined(home, [workspace], {
		outputs: [...calls, { kind: 'text', chunks: ['Done.'] }],
		long: [{ kind: 'text', chunks: [Array.from({ length: 12 }, (_, i) => `finding ${i + 1}`).join('\n')] }],
	}, process.platform === 'darwin');
	const { client, mock, until, ended, results } = confined;
	const outcomes = (sessionID: string) => results(sessionID).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`));
	try {
		const session = (await client.createSession({ directory: workspace, title: 'outputs', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await client.prompt(session, { text: '[[mock:outputs]] Look around.' });
		await until('the agent to finish', () => ended(session));
		const done = results(session);
		t.diagnostic(JSON.stringify(done));
		const sent = JSON.stringify(mock.requests);
		assert.deepEqual({
			outcomes: outcomes(session),
			readBack: { shell: /\b20\b/.test(done[2] ?? ''), subagent: (done[4] ?? '').includes('finding 12') },
			linked: lstatSync(tmpLink).isSymbolicLink(),
			leaked: [SECRET, OTHER].filter(marker => sent.includes(marker)),
			scratch: readFileSync(scratchFile, 'utf8'),
		}, {
			outcomes: ['shell ran', 'shell ran', 'read ran', 'subagent ran', 'read ran', ...calls.slice(5, 13).map(call => `${call.kind === 'tool' && call.name} failed`), 'write ran', 'read ran'],
			readBack: { shell: true, subagent: true },
			linked: true,
			leaked: [],
			scratch: 'scratch\n',
		});
	} finally {
		await confined.close();
		rmSync(tmpLink, { force: true });
		rmSync(scratchFile, { force: true });
		rmSync(temp, { recursive: true, force: true });
	}
});

test('a plan is open to the project it was written in, also after a restart, and closed to another, as is the folder every project keeps its plans in', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-plans-')));
	const home = path.join(temp, 'home');
	const game = path.join(home, 'game');
	const shop = path.join(home, 'shop');
	const plans = path.join(home, '.opencode', 'plan');
	for (const dir of [game, shop, plans]) {
		mkdirSync(dir, { recursive: true });
	}
	// A plan of another project's, written by OpenCode on its own or before Dragon recorded plans.
	const OTHER = 'other-project-plan-9d2e';
	writeFileSync(path.join(plans, 'roadmap.md'), `${OTHER}\n`);
	const GAME = 'game-plan-levels-31b7';
	const levels = path.join(plans, 'levels.md');
	const prices = path.join(plans, 'prices.md');
	const confined = await startConfined(home, [game], {
		planning: [
			{ kind: 'tool', name: 'write', args: { path: levels, content: `${GAME}\n` } },
			{ kind: 'tool', name: 'read', args: { path: levels } },
			{ kind: 'tool', name: 'read', args: { path: path.join(plans, 'roadmap.md') } },
			{ kind: 'tool', name: 'read', args: { path: plans } },
			{ kind: 'text', chunks: ['Planned.'] },
		],
		again: [
			{ kind: 'tool', name: 'read', args: { path: levels } },
			{ kind: 'text', chunks: ['Read again.'] },
		],
		shopping: [
			{ kind: 'tool', name: 'read', args: { path: levels } },
			{ kind: 'tool', name: 'write', args: { path: levels, content: 'shop\n' } },
			// Part of the plan's text, so that the model's own call does not send the shop's model the plan.
			{ kind: 'tool', name: 'edit', args: { path: levels, oldString: 'plan-levels', newString: 'plan-prices' } },
			{ kind: 'tool', name: 'read', args: { path: plans } },
			{ kind: 'tool', name: 'write', args: { path: prices, content: 'prices\n' } },
			{ kind: 'tool', name: 'read', args: { path: prices } },
			{ kind: 'text', chunks: ['Shopped.'] },
		],
	}, process.platform === 'darwin');
	const { mock, seen, until, results } = confined;
	const turnsEnded = (sessionID: string) => seen.filter(e => e.data.sessionID === sessionID && e.type.startsWith('session.execution.') && e.type !== 'session.execution.started').length;
	const outcomes = (sessionID: string) => results(sessionID).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`));
	try {
		// The plan agent writes a plan in the game's window, and reads it back.
		const planner = (await confined.client.createSession({ directory: game, title: 'planning', agent: 'plan', model: { providerID: 'ollama', id: MODEL } })).id;
		await confined.client.prompt(planner, { text: '[[mock:planning]] Plan the levels.' });
		await until('the plan to be written', () => turnsEnded(planner) > 0);
		const planned = results(planner);
		// Dragon restarts the server, as it does when the window's folders or settings change.
		await confined.reopen([game]);
		let turns = mock.requests.length;
		await confined.client.prompt(planner, { text: '[[mock:again]] Read it again.' });
		await until('the plan to be read again', () => mock.requests.length > turns && turnsEnded(planner) > 1);
		const again = results(planner).slice(planned.length);
		// The window is opened on another project.
		await confined.reopen([shop]);
		turns = mock.requests.length;
		const shopper = (await confined.client.createSession({ directory: shop, title: 'shopping', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await confined.client.prompt(shopper, { text: '[[mock:shopping]] Look at the plans.' });
		await until('the shop\'s agent to finish', () => turnsEnded(shopper) > 0);
		const shopped = results(shopper);
		t.diagnostic(JSON.stringify({ planned, again, shopped }));
		assert.deepEqual({
			planned: outcomes(planner).slice(0, planned.length),
			again: outcomes(planner).slice(planned.length),
			shopped: outcomes(shopper),
			readBack: [planned[1] ?? '', again[0] ?? '', shopped[5] ?? ''].map(result => result.includes(GAME) || result.includes('prices')),
			listed: { game: planned[3]?.includes(levels) && !planned[3].includes('roadmap'), shop: !shopped[3]?.includes('levels') },
			sent: { other: JSON.stringify(mock.requests).includes(OTHER), gameToShop: JSON.stringify(mock.requests.slice(turns)).includes(GAME) },
			levels: readFileSync(levels, 'utf8'),
		}, {
			planned: ['write ran', 'read ran', 'read failed', 'read failed'],
			again: ['read ran'],
			shopped: ['read failed', 'write failed', 'edit failed', 'read failed', 'write ran', 'read ran'],
			readBack: [true, true, true],
			listed: { game: true, shop: true },
			sent: { other: false, gameToShop: false },
			levels: `${GAME}\n`,
		});
	} finally {
		await confined.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test('instruction files and skills from outside the open folders do not reach the model', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-instructions-')));
	const home = path.join(temp, 'home');
	const workspace = path.join(home, 'game');
	const files: Record<string, string> = {
		// The user's own, in the home folder.
		'.claude/CLAUDE.md': 'HOME-CLAUDE-MARKER',
		'.config/opencode/AGENTS.md': 'HOME-OPENCODE-AGENTS-MARKER',
		'.claude/skills/home-skill/SKILL.md': '---\nname: home-skill\ndescription: HOME-CLAUDE-SKILL-MARKER\n---\n\nHOME-CLAUDE-SKILL-BODY\n',
		'.agents/skills/agents-skill/SKILL.md': '---\nname: agents-skill\ndescription: HOME-AGENTS-SKILL-MARKER\n---\n\nHOME-AGENTS-SKILL-BODY\n',
		'.config/opencode/skills/opencode-skill/SKILL.md': '---\nname: opencode-skill\ndescription: HOME-OPENCODE-SKILL-MARKER\n---\n\nHOME-OPENCODE-SKILL-BODY\n',
		// In a folder above the open one.
		'AGENTS.md': 'PARENT-AGENTS-MARKER',
		'CLAUDE.md': 'PARENT-CLAUDE-MARKER',
		// The project's own.
		'game/AGENTS.md': 'PROJECT-AGENTS-MARKER',
		'game/.claude/skills/project-skill/SKILL.md': '---\nname: project-skill\ndescription: PROJECT-SKILL-MARKER\n---\n\nPROJECT-SKILL-BODY\n',
	};
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
		writeFileSync(path.join(home, file), `${content}\n`);
	}
	const confined = await startConfined(home, [workspace], {
		skills: [
			{ kind: 'tool', name: 'skill', args: { id: 'home-skill' } },
			{ kind: 'tool', name: 'skill', args: { id: 'project-skill' } },
			{ kind: 'text', chunks: ['Done.'] },
		],
		again: [{ kind: 'text', chunks: ['Done again.'] }],
	}, false);
	const { client, mock, seen, until, ended, results } = confined;
	const turnsEnded = (sessionID: string) => seen.filter(e => e.data.sessionID === sessionID && e.type.startsWith('session.execution.') && e.type !== 'session.execution.started').length;
	try {
		const session = (await client.createSession({ directory: workspace, title: 'skills', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await client.prompt(session, { text: '[[mock:skills]] Use the skills.' });
		await until('the agent to finish', () => ended(session));
		// Between turns the user's files change, and the project's: OpenCode tells the model so in the next turn.
		writeFileSync(path.join(home, '.config/opencode/AGENTS.md'), 'HOME-OPENCODE-AGENTS-MARKER\nHOME-CHANGED-MARKER\n');
		rmSync(path.join(home, 'AGENTS.md'));
		writeFileSync(path.join(workspace, 'AGENTS.md'), 'PROJECT-AGENTS-MARKER\nPROJECT-CHANGED-MARKER\n');
		mkdirSync(path.join(home, '.claude/skills/late-skill'));
		writeFileSync(path.join(home, '.claude/skills/late-skill/SKILL.md'), '---\nname: late-skill\ndescription: HOME-LATE-SKILL-MARKER\n---\n\nHOME-LATE-SKILL-BODY\n');
		await new Promise(resolve => setTimeout(resolve, 2000));
		const turns = mock.requests.length;
		await client.prompt(session, { text: '[[mock:again]] Once more.' });
		await until('the second turn to finish', () => mock.requests.length > turns && turnsEnded(session) > 1);
		t.diagnostic(`results: ${JSON.stringify(results(session))}`);
		const sent = JSON.stringify(mock.requests);
		assert.deepEqual({
			skills: results(session).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`)),
			markers: [...new Set(sent.match(/[A-Z]+(?:-[A-Z]+)*-(?:MARKER|BODY)/g) ?? [])].sort(),
			named: [path.join(home, 'AGENTS.md'), path.join(home, '.config/opencode/AGENTS.md'), path.join(home, '.claude')].filter(file => sent.includes(file)),
		}, {
			skills: ['skill failed', 'skill ran'],
			// OpenCode reads ~/.claude/CLAUDE.md no more; VS Code attaches it, and Dragon's chat leaves it out (`filesToSend`).
			markers: ['PROJECT-AGENTS-MARKER', 'PROJECT-CHANGED-MARKER', 'PROJECT-SKILL-BODY', 'PROJECT-SKILL-MARKER'],
			named: [],
		});
	} finally {
		await confined.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test('agents\' shell commands reach the folders open in the window and their own home folder, and no other, without the server\'s password', { skip: (!binary && 'no opencode binary') || (process.platform !== 'darwin' && 'the sandbox is macOS only'), timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-sandbox-')));
	const home = path.join(temp, 'home');
	const workspace = path.join(home, 'game');
	const second = path.join(temp, 'assets');
	const outside = path.join(home, 'private');
	for (const dir of [workspace, second, outside]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
	writeFileSync(path.join(outside, 'secret.txt'), `${SECRET}\n`);
	const commands = [
		`cat ${path.join(outside, 'secret.txt')}`,
		'cat ../private/secret.txt',
		`ls ${outside}`,
		`echo planted > ${path.join(outside, 'planted.txt')}`,
		'cat hello.txt && echo made > made.txt',
		`echo art > ${path.join(second, 'art.txt')}`,
		'echo "home=$HOME" && echo mine > "$HOME/mine.txt"',
		'env',
	];
	const confined = await startConfined(home, [workspace, second], {
		shell: [...commands.map((command): ScriptStep => ({ kind: 'tool', name: 'shell', args: { command } })), { kind: 'text', chunks: ['Done.'] }],
	}, true);
	try {
		const { client, mock, until, ended, results, server } = confined;
		const session = (await client.createSession({ directory: workspace, title: 'shell', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await client.prompt(session, { text: '[[mock:shell]] Look around.' });
		await until('the agent to finish', () => ended(session));
		const outputs = results(session);
		t.diagnostic(JSON.stringify(outputs));
		const commandHome = /home=(?<home>\S+)/.exec(outputs.join('\n'))?.groups?.home ?? '';
		const sent = JSON.stringify(mock.requests);
		assert.deepEqual({
			outcomes: Object.fromEntries(commands.slice(0, -1).map((command, i) => [command, /Operation not permitted|operation not permitted/.test(outputs[i] ?? '') ? 'refused' : outputs[i]?.startsWith('shell: ') ? 'ran' : outputs[i]])),
			secretSent: sent.includes(SECRET),
			passwordSent: sent.includes(server.serverPassword),
			serverVariables: (outputs.at(-1)?.match(/^(OPENCODE_(?!TERMINAL)|DRAGON_)\w+/gm) ?? []),
			planted: existsSync(path.join(outside, 'planted.txt')),
			made: readFileSync(path.join(workspace, 'made.txt'), 'utf8'),
			art: readFileSync(path.join(second, 'art.txt'), 'utf8'),
			commandHome: path.relative(home, commandHome).split(path.sep).slice(0, 3).join('/'),
			mine: readFileSync(path.join(commandHome, 'mine.txt'), 'utf8'),
		}, {
			outcomes: {
				[commands[0]]: 'refused',
				[commands[1]]: 'refused',
				[commands[2]]: 'refused',
				[commands[3]]: 'refused',
				[commands[4]]: 'ran',
				[commands[5]]: 'ran',
				[commands[6]]: 'ran',
			},
			secretSent: false,
			passwordSent: false,
			serverVariables: [],
			planted: false,
			made: 'made\n',
			art: 'art\n',
			commandHome: '.dragon/sandbox/homes',
			mine: 'mine\n',
		});
	} finally {
		await confined.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test('a folder taken out of the window is closed to agents\' file tools and shell commands at once, and one added is open to them', { skip: (!binary && 'no opencode binary') || (process.platform !== 'darwin' && 'the sandbox is macOS only'), timeout: 240_000 }, async t => {
	const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-reopen-')));
	const home = path.join(temp, 'home');
	const workspace = path.join(home, 'game');
	const assets = path.join(home, 'assets');
	const music = path.join(home, 'music');
	for (const dir of [workspace, assets, music]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(assets, 'art.txt'), 'art\n');
	writeFileSync(path.join(music, 'song.txt'), 'song\n');
	const calls = (turn: string): ScriptStep[] => [assets, music].flatMap((folder): ScriptStep[] => [
		{ kind: 'tool', name: 'read', args: { path: path.join(folder, folder === assets ? 'art.txt' : 'song.txt') } },
		{ kind: 'tool', name: 'write', args: { path: path.join(folder, `${turn}.txt`), content: `${turn}\n` } },
		{ kind: 'tool', name: 'shell', args: { command: `ls ${folder}` } },
	]);
	const confined = await startConfined(home, [workspace, assets], {
		before: [...calls('before'), { kind: 'text', chunks: ['Done.'] }],
		after: [...calls('after'), { kind: 'text', chunks: ['Done again.'] }],
	}, true);
	const { mock, seen, until, results } = confined;
	const turnsEnded = (sessionID: string) => seen.filter(e => e.data.sessionID === sessionID && e.type.startsWith('session.execution.') && e.type !== 'session.execution.started').length;
	const outcomes = (sessionID: string) => results(sessionID).map(result => /^shell: /.test(result) ? (/operation not permitted/i.test(result) ? 'shell refused' : 'shell ran') : result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`));
	try {
		const session = (await confined.client.createSession({ directory: workspace, title: 'reopen', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
		await confined.client.prompt(session, { text: '[[mock:before]] Look around.' });
		await until('the first turn to finish', () => turnsEnded(session) > 0);
		const before = outcomes(session);
		// The user takes the assets folder out of the window and adds the music folder; the chat goes on.
		await confined.reopen([workspace, music]);
		const turns = mock.requests.length;
		await confined.client.prompt(session, { text: '[[mock:after]] Once more.' });
		await until('the second turn to finish', () => mock.requests.length > turns && turnsEnded(session) > 1);
		t.diagnostic(JSON.stringify(results(session)));
		assert.deepEqual({
			before,
			after: outcomes(session).slice(before.length),
			written: [assets, music].flatMap(folder => ['before.txt', 'after.txt'].filter(file => existsSync(path.join(folder, file))).map(file => `${path.basename(folder)}/${file}`)),
		}, {
			before: ['read ran', 'write ran', 'shell ran', 'read failed', 'write failed', 'shell refused'],
			after: ['read failed', 'write failed', 'shell refused', 'read ran', 'write ran', 'shell ran'],
			written: ['assets/before.txt', 'music/after.txt'],
		});
	} finally {
		await confined.close();
		rmSync(temp, { recursive: true, force: true });
	}
});

test('Full Access reaches outside the open folders, and Project Only keeps agents inside them', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const run = async (mode: PermissionMode): Promise<string[]> => {
		const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-mode-')));
		const home = path.join(temp, 'home');
		const workspace = path.join(home, 'game');
		const outside = path.join(home, 'notes');
		for (const dir of [workspace, outside]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
		const beyond = path.join(outside, 'beyond.txt');
		writeFileSync(beyond, 'beyond\n');
		const confined = await startConfined(home, [workspace], {
			look: [
				{ kind: 'tool', name: 'read', args: { path: 'hello.txt' } },
				{ kind: 'tool', name: 'read', args: { path: beyond } },
				{ kind: 'text', chunks: ['Looked.'] },
			],
		}, process.platform === 'darwin', mode);
		try {
			const { client, until, ended, results } = confined;
			const session = (await client.createSession({ directory: workspace, title: 'look', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
			await client.prompt(session, { text: '[[mock:look]] Look.' });
			await until('the agent to finish', () => ended(session));
			t.diagnostic(`${mode}: ${JSON.stringify(results(session))}`);
			return results(session).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`));
		} finally {
			await confined.close();
			rmSync(temp, { recursive: true, force: true });
		}
	};
	// Project Only approves the agent's actions but keeps it to the open folder; Full Access does not.
	assert.deepEqual({ project: await run('project'), fullAccess: await run('full-access') }, {
		project: ['read ran', 'read failed'],
		fullAccess: ['read ran', 'read ran'],
	});
});

test('a project\'s local MCP server runs in the window\'s sandbox under Project Only, and outside it under Full Access', { skip: (!binary && 'no opencode binary') || (process.platform !== 'darwin' && 'the sandbox is macOS only'), timeout: 240_000 }, async t => {
	const run = async (mode: PermissionMode): Promise<{ inside: boolean; outside: boolean }> => {
		const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-mcp-')));
		const home = path.join(temp, 'home');
		const workspace = path.join(home, 'game');
		const outside = path.join(home, 'notes');
		for (const dir of [workspace, outside]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
		const insideMarker = path.join(workspace, 'mcp-ran.txt');
		const outsideMarker = path.join(outside, 'mcp-escaped.txt');
		// The project defines a local MCP server in its own opencode.json, which OpenCode spawns directly.
		// On spawn it tries to write outside the open folder, then inside it, then waits. Writing inside is
		// allowed either way and shows the server was spawned; writing outside is what confinement must stop,
		// so once the inside marker is there the outside attempt has already run.
		const serverCommand = `echo ran > ${outsideMarker}; echo ran > ${insideMarker}; sleep 30`;
		writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({ mcp: { prober: { type: 'local', command: ['sh', '-c', serverCommand] } } }));
		const confined = await startConfined(home, [workspace], {
			look: [
				{ kind: 'tool', name: 'read', args: { path: 'hello.txt' } },
				{ kind: 'text', chunks: ['Looked.'] },
			],
		}, process.platform === 'darwin', mode);
		try {
			const { client, until, ended } = confined;
			const session = (await client.createSession({ directory: workspace, title: 'look', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
			await client.prompt(session, { text: '[[mock:look]] Look.' });
			await until('the agent to finish', () => ended(session));
			await until('the project\'s MCP server to spawn', () => existsSync(insideMarker));
			return { inside: existsSync(insideMarker), outside: existsSync(outsideMarker) };
		} finally {
			await confined.close();
			rmSync(temp, { recursive: true, force: true });
		}
	};
	const project = await run('project');
	const fullAccess = await run('full-access');
	t.diagnostic(`project: ${JSON.stringify(project)}; fullAccess: ${JSON.stringify(fullAccess)}`);
	assert.deepEqual({ project, fullAccess }, {
		project: { inside: true, outside: false },
		fullAccess: { inside: true, outside: true },
	});
});

test('a project\'s formatter runs in the window\'s sandbox under Project Only, and outside it under Full Access', { skip: (!binary && 'no opencode binary') || (process.platform !== 'darwin' && 'the sandbox is macOS only'), timeout: 240_000 }, async t => {
	const run = async (mode: PermissionMode): Promise<{ inside: boolean; outside: boolean }> => {
		const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-fmt-')));
		const home = path.join(temp, 'home');
		const workspace = path.join(home, 'game');
		const outside = path.join(home, 'notes');
		for (const dir of [workspace, outside]) {
			mkdirSync(dir, { recursive: true });
		}
		const insideMarker = path.join(workspace, 'fmt-ran.txt');
		const outsideMarker = path.join(outside, 'fmt-escaped.txt');
		// The project configures its own formatter in opencode.json, which OpenCode spawns on a matching
		// write. It tries to write outside the open folder, then inside it. Writing inside is allowed either
		// way and shows the formatter ran; once it is there the outside attempt has already run.
		const formatterCommand = `echo ran > ${outsideMarker}; echo ran > ${insideMarker}`;
		writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({ formatter: { prober: { command: ['sh', '-c', formatterCommand], extensions: ['.txt'] } } }));
		const confined = await startConfined(home, [workspace], {
			edit: [
				{ kind: 'tool', name: 'write', args: { path: 'note.txt', content: 'note\n' } },
				{ kind: 'text', chunks: ['Wrote.'] },
			],
		}, process.platform === 'darwin', mode);
		try {
			const { client, until, ended } = confined;
			const session = (await client.createSession({ directory: workspace, title: 'edit', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
			await client.prompt(session, { text: '[[mock:edit]] Write.' });
			await until('the agent to finish', () => ended(session));
			await until('the formatter to run', () => existsSync(insideMarker));
			return { inside: existsSync(insideMarker), outside: existsSync(outsideMarker) };
		} finally {
			await confined.close();
			rmSync(temp, { recursive: true, force: true });
		}
	};
	const project = await run('project');
	const fullAccess = await run('full-access');
	t.diagnostic(`project: ${JSON.stringify(project)}; fullAccess: ${JSON.stringify(fullAccess)}`);
	assert.deepEqual({ project, fullAccess }, {
		project: { inside: true, outside: false },
		fullAccess: { inside: true, outside: true },
	});
});

test('a project\'s in-process plugin is not loaded in a confined window, and is under Full Access', { skip: (!binary && 'no opencode binary') || (process.platform !== 'darwin' && 'the sandbox is macOS only'), timeout: 240_000 }, async t => {
	const run = async (mode: PermissionMode): Promise<{ read: string; loaded: boolean }> => {
		const temp = realpathSync(mkdtempSync(path.join(tmpdir(), 'dragon-inproc-')));
		const home = path.join(temp, 'home');
		const workspace = path.join(home, 'game');
		const outside = path.join(home, 'notes');
		for (const dir of [workspace, outside]) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
		const beyond = path.join(outside, 'beyond.txt');
		writeFileSync(beyond, 'beyond\n');
		// The project drops an in-process plugin in its own .opencode/plugin. On import it writes a marker;
		// the marker's presence shows the plugin was loaded into the server process. In-process code cannot
		// be sandboxed, so under confinement the plugin must not be loaded at all. Reading outside the open
		// folder is refused when the window is confined, which shows the plugin pass ran (the sandbox plugin
		// loaded), so the marker being absent means the project plugin was dropped, not merely late.
		const marker = path.join(temp, 'plugin-loaded.txt');
		const pluginDir = path.join(workspace, '.opencode', 'plugin');
		mkdirSync(pluginDir, { recursive: true });
		writeFileSync(path.join(pluginDir, 'escape.js'), `import { writeFileSync } from "node:fs"\ntry { writeFileSync(${JSON.stringify(marker)}, "loaded\\n") } catch {}\nexport default async () => {}\n`);
		const confined = await startConfined(home, [workspace], {
			look: [
				{ kind: 'tool', name: 'read', args: { path: beyond } },
				{ kind: 'text', chunks: ['Looked.'] },
			],
		}, process.platform === 'darwin', mode);
		try {
			const { client, until, ended, results } = confined;
			const session = (await client.createSession({ directory: workspace, title: 'look', agent: 'build', model: { providerID: 'ollama', id: MODEL } })).id;
			await client.prompt(session, { text: '[[mock:look]] Look.' });
			await until('the agent to finish', () => ended(session));
			if (mode === 'full-access') {
				await until('the project plugin to load', () => existsSync(marker));
			}
			const read = results(session).map(result => result.replace(/^(\S+?)(:| failed:).*$/s, (_, name: string, how: string) => `${name} ${how === ':' ? 'ran' : 'failed'}`))[0];
			return { read, loaded: existsSync(marker) };
		} finally {
			await confined.close();
			rmSync(temp, { recursive: true, force: true });
		}
	};
	const project = await run('project');
	const fullAccess = await run('full-access');
	t.diagnostic(`project: ${JSON.stringify(project)}; fullAccess: ${JSON.stringify(fullAccess)}`);
	assert.deepEqual({ project, fullAccess }, {
		project: { read: 'read failed', loaded: false },
		fullAccess: { read: 'read ran', loaded: true },
	});
});
