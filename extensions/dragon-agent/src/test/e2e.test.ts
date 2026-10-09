/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end: the real OpenCode binary, driven exactly as the chat participant drives it,
 * against a scripted Ollama. Runs when an `opencode` binary is available (the bundled
 * `bin/opencode`, or DRAGON_OPENCODE_BIN); otherwise it is skipped.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { extractCode, runInlineEdit } from '../chat/inline';
import { permissionDecision } from '../chat/toolPresentation';
import { TurnOp, TurnReducer } from '../chat/turn';
import { buildDragonConfig, READ_ONLY_PERMISSIONS, writeDragonConfig, writeSearchPlugin } from '../dragonConfig';
import { findRipgrep } from '../search/ripgrep';
import { OpenCodeServer, resolveBinary } from '../opencode/server';
import type { PermissionRule } from '../opencode/types';
import { ScriptStep, startMockOllama } from './mockOllama';

const extensionPath = path.join(__dirname, '..', '..');
const binary = process.env.DRAGON_OPENCODE_BIN ?? resolveBinary({ extensionPath, env: { PATH: '' } });
/** A Dragon agent variant: the context window it was created with is in its name. */
const MODEL = 'qwen2.5-coder:7b-dragon-32k';

for (const provider of ['ollama', 'splash']) {
	test(`a chat turn runs through OpenCode with a local ${provider} model`, { skip: !binary && 'no opencode binary', timeout: 180_000 }, async t => {
		const workspace = mkdtempSync(path.join(tmpdir(), 'dragon-e2e-'));
		const home = mkdtempSync(path.join(tmpdir(), 'dragon-home-'));
		writeFileSync(path.join(workspace, 'hello.txt'), 'hello world\n');
		writeFileSync(path.join(workspace, 'notes.md'), '# Greetings\n\nThe hello.txt file holds the greeting the app says to the world when it starts.\n');
		const mock = await startMockOllama([
			{ kind: 'tool', name: 'grep', args: { pattern: 'hello w[a-z]+' } },
			{ kind: 'tool', name: 'codebase_search', args: { query: 'the greeting that says hello to the world' } },
			{ kind: 'tool', name: 'edit', args: { path: 'hello.txt', oldString: 'hello world', newString: 'hello dragon' } },
			// Slow, as Nemotron on OpenCode Zen is: OpenCode publishes the start of the answer before it
			// reports the reasoning ended, and the rest after.
			{ kind: 'text', reasoning: ['Checking the edit.'], chunks: ['Changed ', 'hello.txt.'], pause: 500 },
		], MODEL, 0, { embedModel: 'mock-embed' });
		const semanticConfig = path.join(home, 'semantic.json');
		writeFileSync(semanticConfig, JSON.stringify({ enabled: true, model: 'mock-embed', origin: mock.origin }));
		const configFile = path.join(home, 'dragon.json');
		const pluginDir = path.join(home, 'instant-grep');
		await writeSearchPlugin(pluginDir, path.join(__dirname, '..', 'search', 'opencodePlugin.js'));
		const config = buildDragonConfig({
			model: `${provider}/${MODEL}`,
			ollamaOrigin: mock.origin,
			ollamaModels: [{ name: MODEL, size: 1 }, { name: 'mock-embed', size: 1 }],
			searchPluginDir: pluginDir,
			splashModels: provider === 'splash' ? [{ id: MODEL, context: 32768, input: ['text'] }] : undefined,
		}) as { providers: Record<string, { settings?: { baseURL?: string } }> };
		if (provider === 'splash') { config.providers.splash.settings!.baseURL = `${mock.origin}/v1`; }
		await writeDragonConfig(configFile, config);
		const rg = findRipgrep({ appRoot: path.join(extensionPath, '..', '..') });
		assert.ok(rg, 'ripgrep is available');
		const logs: string[] = [];
		const server = new OpenCodeServer({
			configuredBinary: binary,
			extensionPath,
			cwd: workspace,
			configFile,
			log: line => { logs.push(line); if (process.env.DRAGON_TEST_LOG) { console.error(line); } },
			// Isolate OpenCode's data and config from the machine running the test.
			extraEnv: { DRAGON_RG_PATH: rg!, DRAGON_SEARCH_STORAGE: path.join(home, 'index'), DRAGON_SEMANTIC_CONFIG: semanticConfig },
			env: { ...process.env, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
		});
		try {
			const client = await server.ensure();
			assert.equal(server.state.kind, 'ready');

			// Wait for OpenCode to discover the Ollama model and apply Dragon's output cap. Discovery
			// and the config layer are applied asynchronously, so the cap can land a moment later.
			let ollamaModels: Awaited<ReturnType<typeof client.models>> = [];
			for (let i = 0; i < 120; i++) {
				ollamaModels = (await client.models(workspace)).filter(m => m.providerID === provider);
				if (ollamaModels.length && ollamaModels.every(m => m.limit?.output === 8192 && m.limit?.context === 32768)) {
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 250));
			}
			assert.deepEqual(ollamaModels.map(m => m.id), [MODEL], 'OpenCode discovered the chat model, and not the embedding model');
			assert.equal(ollamaModels[0].limit?.output, 8192, 'Dragon\'s output cap for local models is applied');
			assert.equal(ollamaModels[0].limit?.context, 32768, 'the agent variant\'s real window overrides the model maximum Ollama reports (131072)');

			const session = await client.createSession({ directory: workspace, agent: 'build', model: { providerID: provider, id: MODEL } });
			const controller = new AbortController();
			const events = client.events(controller.signal)[Symbol.asyncIterator]();
			assert.equal((await events.next()).value?.type, 'server.connected');
			await client.prompt(session.id, { text: 'Change hello.txt to say hello dragon.' });

			const reducer = new TurnReducer(session.id);
			const ops: TurnOp[] = [];
			for (let next = await events.next(); !next.done; next = await events.next()) {
				for (const op of reducer.reduce(next.value)) {
					ops.push(op);
					if (op.kind === 'permission') {
						await client.replyPermission(op.request.sessionID, op.request.id, 'once');
					}
				}
				if (ops.some(op => op.kind === 'done')) {
					break;
				}
			}
			controller.abort();

			const done = ops.find(op => op.kind === 'done');
			assert.deepEqual(done, { kind: 'done', outcome: 'succeeded' }, `turn failed: ${JSON.stringify(done)}\n${logs.slice(-20).join('\n')}`);
			const grep = ops.find(op => op.kind === 'tool-done' && op.name === 'grep');
			assert.ok(grep && grep.kind === 'tool-done', `grep ran: ${JSON.stringify(ops.filter(op => op.kind.startsWith('tool')))}`);
			t.diagnostic(`grep output: ${grep.output.replace(/\n/g, ' | ')}`);
			assert.match(grep.output, /hello\.txt/);
			assert.match(grep.output, /instant index|full scan/, 'grep was answered by the Instant Grep plugin');
			const semantic = ops.find(op => op.kind === 'tool-done' && op.name === 'codebase_search');
			assert.ok(semantic && semantic.kind === 'tool-done', 'codebase_search ran');
			t.diagnostic(`codebase_search output: ${semantic.output.replace(/\n/g, ' | ')}`);
			assert.match(semantic.output, /result\(s\) for "the greeting that says hello to the world"/);
			assert.match(semantic.output, /^(notes\.md|hello\.txt):1-\d+ \(similarity/m, 'answered from the semantic index');
			const edit = ops.find(op => op.kind === 'tool-done' && op.name === 'edit');
			assert.ok(edit && edit.kind === 'tool-done' && edit.name === 'edit' && edit.files[0].file === 'hello.txt');
			assert.equal(ops.filter(op => op.kind === 'text').map(op => op.kind === 'text' ? op.delta : '').join(''), 'Changed hello.txt.');
			// The reasoning ends before the answer starts, so the chat does not fold the answer away with it.
			const reply = ops.map(op => op.kind).filter(kind => kind === 'thinking' || kind === 'thinking-end' || kind === 'text');
			assert.deepEqual(reply.filter((kind, i) => kind !== reply[i - 1]), ['thinking', 'thinking-end', 'text']);
			assert.equal(readFileSync(path.join(workspace, 'hello.txt'), 'utf8'), 'hello dragon\n');

			// "Continue in Chat" lists sessions from the same server, newest first.
			const listed = await client.sessions(workspace);
			assert.equal(listed[0]?.id, session.id);
			assert.ok(listed[0].time && listed[0].time.updated >= listed[0].time.created);

			// The semantic index was built inside OpenCode's process and saved next to the trigram index.
			let saved = false;
			for (let i = 0; i < 100 && !saved; i++) {
				saved = readdirSync(path.join(home, 'index')).some(f => f.endsWith('.vectors'));
				if (!saved) {
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			}
			assert.ok(saved, 'semantic vectors were saved');
			assert.ok(mock.requests.some(r => r.path === '/api/embed'), 'OpenCode embedded through the local Ollama');
		} finally {
			server.dispose();
			await mock.close();
			rmSync(workspace, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
}

test('an inline edit runs in a short-lived OpenCode plan session', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const workspace = mkdtempSync(path.join(tmpdir(), 'dragon-inline-'));
	const home = mkdtempSync(path.join(tmpdir(), 'dragon-home-'));
	const mock = await startMockOllama([{ kind: 'text', chunks: ['```ts\n', 'const total = items.length;\n', '```'] }], MODEL);
	const configFile = path.join(home, 'dragon.json');
	await writeDragonConfig(configFile, buildDragonConfig({ model: `ollama/${MODEL}`, ollamaOrigin: mock.origin, ollamaModels: [{ name: MODEL, size: 1 }] }));
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: workspace, configFile, log: line => process.env.DRAGON_TEST_LOG && console.error(line),
		env: { ...process.env, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
	});
	try {
		const client = await server.ensure();
		for (let i = 0; i < 120 && !(await client.models(workspace)).some(m => m.providerID === 'ollama'); i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const reply = await runInlineEdit(client, { directory: workspace, prompt: 'Rewrite the selection to use const.', title: 'Inline edit: test', model: { providerID: 'ollama', id: MODEL } }, () => { });
		assert.equal(extractCode(reply), 'const total = items.length;');
		const request = mock.requests.find(r => r.path.startsWith('/v1/chat/completions') && JSON.stringify(r.body).includes('Rewrite the selection'));
		assert.ok(request, 'the prompt reached the model');
		// The session is removed afterwards, so inline edits never appear in the session list.
		let listed = await client.sessions(workspace);
		for (let i = 0; i < 20 && listed.length; i++) {
			await new Promise(resolve => setTimeout(resolve, 100));
			listed = await client.sessions(workspace);
		}
		assert.deepEqual(listed, []);
	} finally {
		server.dispose();
		await mock.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test('permission modes hold: the build agent asks first, the plan agent and Read-Only change nothing', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const workspace = mkdtempSync(path.join(tmpdir(), 'dragon-modes-'));
	const home = mkdtempSync(path.join(tmpdir(), 'dragon-home-'));
	writeFileSync(path.join(workspace, 'hello.txt'), 'hello world\n');
	// Each scenario runs a command, writes a file and edits hello.txt, then answers.
	const attempt = (tag: string, command: string): ScriptStep[] => [
		{ kind: 'tool', name: 'shell', args: { command } },
		{ kind: 'tool', name: 'write', args: { path: `${tag}.txt`, content: 'written\n' } },
		{ kind: 'tool', name: 'edit', args: { path: 'hello.txt', oldString: 'hello', newString: `hello ${tag}` } },
		{ kind: 'text', chunks: ['Done.'] },
	];
	const mock = await startMockOllama([{ kind: 'text', chunks: ['No scenario.'] }], MODEL, 0, {
		scenarios: {
			allowed: attempt('allowed', 'echo allowed >> shell.log'),
			denied: attempt('denied', 'touch denied-shell.txt'),
			plan: attempt('plan', 'touch plan-shell.txt'),
			// `echo *` is saved by "Always allow" in the first turn; Read-Only must still refuse it.
			readonly: attempt('readonly', 'echo readonly >> shell.log'),
			subagent: [
				{ kind: 'tool', name: 'subagent', args: { agent: 'general', description: 'Run a command', prompt: '[[mock:child]] Run the command.' } },
				{ kind: 'text', chunks: ['The subagent finished.'] },
			],
			child: [{ kind: 'tool', name: 'shell', args: { command: 'touch child-shell.txt' } }, { kind: 'text', chunks: ['Ran it.'] }],
		},
	});
	const configFile = path.join(home, 'dragon.json');
	await writeDragonConfig(configFile, buildDragonConfig({ model: `ollama/${MODEL}`, ollamaOrigin: mock.origin, ollamaModels: [{ name: MODEL, size: 1 }] }));
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: workspace, configFile, log: line => process.env.DRAGON_TEST_LOG && console.error(line),
		env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
	});
	try {
		const client = await server.ensure();
		for (let i = 0; i < 120 && !(await client.models(workspace)).some(m => m.providerID === 'ollama'); i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		/** One chat turn: which permissions were asked for, and which tools ran or failed. `decide` answers as the approval prompt would. */
		const turn = async (agent: string, scenario: string, decide: (action: string) => unknown, permissions?: readonly PermissionRule[]) => {
			const started = Date.now();
			const session = await client.createSession({ directory: workspace, agent, model: { providerID: 'ollama', id: MODEL }, permissions });
			const before = mock.requests.length;
			const controller = new AbortController();
			const events = client.events(controller.signal)[Symbol.asyncIterator]();
			await events.next();
			await client.prompt(session.id, { text: `[[mock:${scenario}]] Go.` });
			const reducer = new TurnReducer(session.id);
			const asked: string[] = [];
			const tools: string[] = [];
			let done: TurnOp | undefined;
			for (let next = await events.next(); !next.done; next = await events.next()) {
				for (const op of reducer.reduce(next.value)) {
					if (op.kind === 'permission') {
						asked.push(`${op.request.action} ${op.request.resources.join(' ')}${op.request.sessionID === session.id ? '' : ' (subagent)'}`);
						await client.replyPermission(op.request.sessionID, op.request.id, permissionDecision(decide(op.request.action)));
					} else if (op.kind === 'tool-done' || op.kind === 'tool-error') {
						tools.push(`${op.name} ${op.kind === 'tool-done' ? 'ran' : 'failed'}`);
					} else if (op.kind === 'done') {
						done = op;
					}
				}
				if (done) {
					break;
				}
			}
			controller.abort();
			t.diagnostic(`${scenario}: ${Date.now() - started} ms`);
			const offered = mock.requests.slice(before).map(r => (r.body as { tools?: { function?: { name?: string } }[] } | undefined)?.tools).find(t => t?.length)?.map(t => t.function?.name);
			return { asked, tools, outcome: done?.kind === 'done' ? done.outcome : 'none', offers: { shell: !!offered?.includes('shell'), edit: !!offered?.includes('edit') } };
		};
		const state = () => ({
			hello: readFileSync(path.join(workspace, 'hello.txt'), 'utf8'),
			shellLog: existsSync(path.join(workspace, 'shell.log')) ? readFileSync(path.join(workspace, 'shell.log'), 'utf8') : '',
			files: readdirSync(workspace).sort(),
		});

		const once = () => ({ selectedValue: 'once' });
		const results = {
			// Agent mode, Ask permission: every edit and command waits for the chat.
			allowed: await turn('build', 'allowed', action => ({ selectedValue: action === 'shell' ? 'always' : 'once' })),
			afterAllowed: state(),
			// Deny stops the turn.
			denied: await turn('build', 'denied', () => ({ selectedValue: 'reject' })),
			afterDenied: state(),
			// Ask mode runs the plan agent: it may run a command once approved, but never edits.
			plan: await turn('plan', 'plan', once),
			afterPlan: state(),
			// Read-Only: no commands or edits, not even `echo *`, which the first turn saved with "Always allow".
			readonly: await turn('plan', 'readonly', once, READ_ONLY_PERMISSIONS),
			afterReadOnly: state(),
			// A subagent's permission requests come to the chat that started it.
			subagent: await turn('build', 'subagent', once),
			afterSubagent: state(),
		};
		t.diagnostic(JSON.stringify(results));
		const files = ['allowed.txt', 'hello.txt', 'shell.log'];
		const unchanged = { hello: 'hello allowed world\n', shellLog: 'allowed\n', files };
		assert.deepEqual(results, {
			allowed: { asked: ['shell echo allowed >> shell.log', 'edit allowed.txt', 'edit hello.txt'], tools: ['shell ran', 'write ran', 'edit ran'], outcome: 'succeeded', offers: { shell: true, edit: true } },
			afterAllowed: unchanged,
			denied: { asked: ['shell touch denied-shell.txt'], tools: ['shell failed'], outcome: 'interrupted', offers: { shell: true, edit: true } },
			afterDenied: unchanged,
			plan: { asked: ['shell touch plan-shell.txt'], tools: ['shell ran', 'write failed', 'edit failed'], outcome: 'succeeded', offers: { shell: true, edit: true } },
			afterPlan: { ...unchanged, files: ['allowed.txt', 'hello.txt', 'plan-shell.txt', 'shell.log'] },
			readonly: { asked: [], tools: ['shell failed', 'write failed', 'edit failed'], outcome: 'succeeded', offers: { shell: false, edit: false } },
			afterReadOnly: { ...unchanged, files: ['allowed.txt', 'hello.txt', 'plan-shell.txt', 'shell.log'] },
			subagent: { asked: ['shell touch child-shell.txt (subagent)'], tools: ['subagent ran'], outcome: 'succeeded', offers: { shell: true, edit: true } },
			afterSubagent: { ...unchanged, files: ['allowed.txt', 'child-shell.txt', 'hello.txt', 'plan-shell.txt', 'shell.log'] },
		});
	} finally {
		server.dispose();
		await mock.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
