/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end: chat turns on the real OpenCode binary, sent as the chat participant sends them,
 * against a scripted model. Runs when an `opencode` binary is available.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { OpenQuestions } from '../chat/openQuestions';
import { filesToSend } from '../chat/references';
import { failureMessage, TurnOp, TurnReducer } from '../chat/turn';
import { buildDragonConfig, writeDragonConfig, writeSearchPlugin } from '../dragonConfig';
import { isNotFound, type OpenCodeClient } from '../opencode/client';
import { OpenCodeServer, resolveBinary } from '../opencode/server';
import { MockOllamaOptions, ScriptStep, startMockOllama, MockOllama } from './mockOllama';

const extensionPath = path.join(__dirname, '..', '..');
const binary = process.env.DRAGON_OPENCODE_BIN ?? resolveBinary({ extensionPath, env: { PATH: '' } });
const MODEL = 'acme-large';

/** Runs `body` against an OpenCode server whose only model is the scripted one. `config` is added to its config. */
async function withServer(script: readonly ScriptStep[], options: MockOllamaOptions, body: (client: OpenCodeClient, sessionID: string, mock: MockOllama, logs: string[]) => Promise<void>, config: object = {}): Promise<void> {
	const workspace = mkdtempSync(path.join(tmpdir(), 'dragon-turns-ws-'));
	const home = mkdtempSync(path.join(tmpdir(), 'dragon-turns-home-'));
	const mock = await startMockOllama(script, MODEL, 0, options);
	const configFile = path.join(home, 'dragon.json');
	// The agent messaging plugin, which Dragon always loads.
	const pluginDir = path.join(home, 'agents-plugin');
	await writeSearchPlugin(pluginDir, path.join(__dirname, '..', 'agents', 'opencodePlugin.js'), 'agent messaging');
	await writeDragonConfig(configFile, {
		$schema: 'https://opencode.ai/config.json',
		model: `acme/${MODEL}`,
		plugins: [pluginDir],
		providers: {
			acme: {
				name: 'Acme', package: '@opencode/ai/providers/openai-compatible',
				settings: { baseURL: `${mock.origin}/v1`, apiKey: 'test' },
				models: { [MODEL]: { name: 'Acme Large', limit: { context: 200_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
			},
		},
		...config,
	});
	const logs: string[] = [];
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: workspace, configFile, log: line => { logs.push(line); if (process.env.DRAGON_TEST_LOG) { console.error(line); } },
		env: { ...process.env, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
	});
	try {
		const client = await server.ensure();
		for (let i = 0; i < 120 && !(await client.models(workspace)).some(m => m.providerID === 'acme'); i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const session = await client.createSession({ directory: workspace, agent: 'build', model: { providerID: 'acme', id: MODEL } });
		await body(client, session.id, mock, logs);
	} finally {
		server.dispose();
		await mock.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
}

/** The session's tool calls in progress, shared by its turns as the participant shares them. */
const tools = new Map<string, { name: string; input: Record<string, unknown> }>();

/**
 * Sends a turn and collects its chat operations, as the participant does: permission requests are
 * allowed, and the turn ends when it is done or, like a turn that yields, when `until` holds.
 */
async function turn(client: OpenCodeClient, sessionID: string, send: () => Promise<unknown>, until: (ops: readonly TurnOp[]) => boolean = ops => ops.some(op => op.kind === 'done')): Promise<TurnOp[]> {
	const controller = new AbortController();
	const events = client.events(controller.signal)[Symbol.asyncIterator]();
	assert.equal((await events.next()).value?.type, 'server.connected');
	const reducer = new TurnReducer(sessionID, undefined, tools);
	const sent = await send() as { data?: { id?: string } } | undefined;
	if (sent?.data?.id) {
		reducer.awaitDelivery(sent.data.id);
	}
	const ops: TurnOp[] = [];
	for (let next = await events.next(); !next.done; next = await events.next()) {
		for (const op of reducer.reduce(next.value)) {
			ops.push(op);
			if (op.kind === 'permission') {
				await client.replyPermission(op.request.sessionID, op.request.id, 'once');
			}
		}
		if (until(ops)) {
			break;
		}
	}
	controller.abort();
	return ops;
}

function textOf(body: unknown): string {
	return JSON.stringify((body as { messages?: unknown[] } | undefined)?.messages ?? []);
}

test('an instruction file sent with a message reaches the model under its path, which the model can read', { skip: !binary && 'no opencode binary', timeout: 120_000 }, async () => {
	// Instructions in the folder open in the window, outside the session's folder, as in a worktree's session.
	const folder = mkdtempSync(path.join(tmpdir(), 'dragon-turns-instructions-'));
	try {
		const file = path.join(folder, 'CLAUDE.md');
		writeFileSync(file, '# Rules\n\nINSTRUCTIONS-MARKER\n');
		await withServer([{ kind: 'text', chunks: ['Hello.'] }], {}, async (client, sessionID, mock) => {
			const { files } = filesToSend([{ id: `vscode.instructions.file.root__${pathToFileURL(file).href}`, uri: pathToFileURL(file).href, path: file, version: 1 }], path.join(folder, 'elsewhere'), new Set(), [folder]);
			await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Say hello.', files }));
			// The turn's own request: OpenCode also sends the message, without its files, to name the session.
			const sent = textOf(mock.requests.find(r => r.path.startsWith('/v1/chat/completions') && textOf(r.body).includes('Say hello.') && !textOf(r.body).includes('generate a title'))?.body);
			assert.deepStrictEqual({ named: sent.includes(`Attached file: ${file}`), content: sent.includes('INSTRUCTIONS-MARKER'), label: sent.includes('prompt:') }, { named: true, content: true, label: false });
		});
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test('/compact shows the summary and how much it saved', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const summary = ['## Objective\n', 'Say hello.\n\n', '## Next Move\n', 'Wait for the user.\n'];
	await withServer([{ kind: 'text', chunks: ['Hello.'] }], { usage: { prompt: 3_000, completion: 400, cached: 2_000 }, summary }, async (client, sessionID, _mock, logs) => {
		const hello = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Say hello.' }));
		assert.deepEqual(hello.find(op => op.kind === 'done'), { kind: 'done', outcome: 'succeeded' }, logs.slice(-20).join('\n'));

		const ops = await turn(client, sessionID, () => client.request('POST', `/api/session/${encodeURIComponent(sessionID)}/compact`, { body: {} }));
		const shown = ops.filter(op => op.kind !== 'usage');
		const written = shown.filter(op => op.kind === 'compaction-text').map(op => op.kind === 'compaction-text' ? op.delta : '').join('');
		assert.deepStrictEqual({ written, ops: shown.filter(op => op.kind !== 'compaction-text') }, {
			written: summary.join(''),
			ops: [
				{ kind: 'status', message: 'Compacting the conversation…' },
				{ kind: 'thinking-end', id: 'compaction-1' },
				// The provider read 3,000 prompt tokens (2,000 of them cached) and wrote 400.
				{ kind: 'compacted', reason: 'manual', before: 3_000, after: 400 },
				{ kind: 'done', outcome: 'succeeded' },
			],
		}, logs.slice(-20).join('\n'));
	});
});

test('a message sent while the agent works joins its run instead of stopping it', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const script: ScriptStep[] = [
		{ kind: 'tool', name: 'shell', args: { command: 'sleep 3', description: 'Wait three seconds' } },
		{ kind: 'text', chunks: ['Done, and hi.'] },
	];
	await withServer(script, {}, async (client, sessionID, mock, logs) => {
		// The first turn yields while the command runs, as a chat turn does when the user steers.
		const first = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Run the slow command.' }), ops => ops.some(op => op.kind === 'tool-running'));
		assert.ok(first.some(op => op.kind === 'tool-running'), logs.slice(-20).join('\n'));
		const second = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Also say hi.' }));

		const replies = mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && textOf(r.body).includes('Run the slow command.'));
		assert.deepStrictEqual({
			ops: second.filter(op => op.kind === 'tool-done' || op.kind === 'text' || op.kind === 'done').map(op => op.kind === 'tool-done' ? `${op.name} done` : op.kind === 'text' ? op.delta : `${op.kind} ${op.outcome}`),
			// The model saw the command's result and the new message in the same conversation.
			lastRequest: ['Wait three seconds', 'Also say hi.'].map(text => textOf(replies.at(-1)?.body).includes(text)),
		}, {
			ops: ['shell done', 'Done, and hi.', 'done succeeded'],
			lastRequest: [true, true],
		}, logs.slice(-20).join('\n'));
	});
});

test('/compact sent while the agent works ends once the compaction ran, and shows it', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const script: ScriptStep[] = [
		{ kind: 'tool', name: 'shell', args: { command: 'sleep 3', description: 'Wait three seconds' } },
		{ kind: 'text', chunks: ['Done.'] },
	];
	await withServer(script, { usage: { prompt: 3_000, completion: 400 }, summary: ['## Objective\n', 'Wait.\n'] }, async (client, sessionID, _mock, logs) => {
		// The first turn yields while the command runs, as a chat turn does when the user types /compact.
		await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Run the slow command.' }), ops => ops.some(op => op.kind === 'tool-running'));
		const ops = await turn(client, sessionID, () => client.request('POST', `/api/session/${encodeURIComponent(sessionID)}/compact`, { body: {} }));
		assert.deepStrictEqual(ops.filter(op => op.kind === 'tool-done' || op.kind === 'text' || op.kind === 'compacted' || op.kind === 'done').map(op => op.kind === 'tool-done' ? `${op.name} done` : op.kind === 'text' ? op.delta : op.kind === 'compacted' ? `compacted ${op.reason}` : `${op.kind} ${op.outcome}`), [
			'shell done',
			// OpenCode compacts once the running step ends, and the turn goes on. The mock picks its step from the
			// tool results it is sent, and the summary replaced them, so it runs the command again.
			'compacted manual',
			'shell done',
			'Done.',
			'done succeeded',
		], logs.slice(-20).join('\n'));
	});
});

test('code that execute cannot parse comes back to the model saying execute runs only JavaScript', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	// The Python a model sent to execute in the owner's game demo.
	const code = 'import json\nimport os\n\nos.makedirs(".opencode/agents", exist_ok=True)\nprint(json.dumps({"ok": True}))';
	const script: ScriptStep[] = [
		{ kind: 'tool', name: 'execute', args: { code } },
		{ kind: 'text', chunks: ['Done.'] },
	];
	await withServer(script, {}, async (client, sessionID, mock, logs) => {
		const ops = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Write the planner agent.' }));
		const last = mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && textOf(r.body).includes('Write the planner agent.')).at(-1)?.body as { messages?: { role?: string; content?: unknown }[] } | undefined;
		assert.deepStrictEqual({
			done: ops.find(op => op.kind === 'done'),
			// What the model was told the tool returned.
			results: (last?.messages ?? []).filter(m => m.role === 'tool').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
		}, {
			done: { kind: 'done', outcome: 'succeeded' },
			results: ['\'import\' and \'export\' may appear only with \'sourceType: module\' (1:0)\n\nexecute runs JavaScript only, and this code is not valid JavaScript. To run Python or another language, call the shell tool directly (for example `python3 script.py`). To create or change files, call the write or edit tool directly.'],
		}, logs.slice(-20).join('\n'));
	});
});

test('a model provider\'s usage limit stops the turn as one, which the chat says what to do about', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	// As the free Nemotron answered after hours of use, which OpenCode reported as provider.quota. A 429
	// without a code that says so is a rate limit, which OpenCode retried ten times, for 85 seconds.
	const limited: ScriptStep = { kind: 'fail', status: 429, message: 'Rate limit exceeded. Please try again later.', code: 'FreeUsageLimitError' };
	await withServer([limited], {}, async (client, sessionID, mock, logs) => {
		const ops = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Name the hero.' }));
		const done = ops.find(op => op.kind === 'done');
		assert.deepStrictEqual({
			outcome: done?.kind === 'done' && done.outcome,
			type: done?.kind === 'done' && done.error?.type,
			shown: done?.kind === 'done' && failureMessage(done.error),
			// Not retried. OpenCode also sends the message, to name the session.
			asked: mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && textOf(r.body).includes('Name the hero.') && !textOf(r.body).includes('generate a title')).length,
		}, {
			outcome: 'failed',
			type: 'provider.quota',
			shown: 'Rate limit exceeded. Please try again later.\n\nThe model provider says this model\'s usage limit is reached. Send your message again later, or run **Dragon: Choose Model** to pick another model.',
			asked: 1,
		}, logs.slice(-20).join('\n'));
	});
});

test('a conversation past dragon.compaction.autoAt is compacted before its next step', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	// The window is 200K tokens and OpenCode keeps 20K of it free for the reply, so on its own it
	// compacts at 180K. Every reply reports a 120K-token prompt; Dragon's config compacts at 50%.
	const { compaction } = buildDragonConfig({ ollamaOrigin: 'http://127.0.0.1:11434', ollamaModels: [], autoCompactAt: 50 }) as { compaction: object };
	await withServer([{ kind: 'text', chunks: ['Done.'] }], { usage: { prompt: 120_000, completion: 400 }, summary: ['## Objective\n', 'Keep going.\n'] }, async (client, sessionID, _mock, logs) => {
		const compactions = (ops: readonly TurnOp[]) => ops.filter(op => op.kind === 'status' || op.kind === 'compacted' || op.kind === 'done');
		const first = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Start.' }));
		const second = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Continue.' }));
		assert.deepStrictEqual({ first: compactions(first), second: compactions(second) }, {
			// The first request has no usage to measure yet.
			first: [{ kind: 'done', outcome: 'succeeded' }],
			second: [
				{ kind: 'status', message: 'Compacting the conversation automatically…' },
				{ kind: 'compacted', reason: 'auto', before: 120_000, after: 400 },
				{ kind: 'done', outcome: 'succeeded' },
			],
		}, logs.slice(-20).join('\n'));
	}, { compaction });
});

test('a running command reports its shell, and what it printed so far can be read while it runs', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const script: ScriptStep[] = [
		{ kind: 'tool', name: 'shell', args: { command: 'echo compiling; sleep 3; echo exported', description: 'Build the game' } },
		{ kind: 'text', chunks: ['Built.'] },
	];
	await withServer(script, {}, async (client, sessionID, _mock, logs) => {
		const directory = (await client.session(sessionID)).location.directory;
		// As the chat does: once the command reports its shell, its output is read until it finishes.
		let reading: Promise<string[]> | undefined;
		const ops = await turn(client, sessionID, () => client.prompt(sessionID, { text: 'Build the game.' }), ops => {
			const progress = ops.find(op => op.kind === 'tool-progress');
			if (progress?.kind === 'tool-progress' && !reading) {
				reading = (async () => {
					const seen: string[] = [];
					while (!ops.some(op => op.kind === 'tool-done' || op.kind === 'tool-error')) {
						seen.push(await client.shellTail(directory, progress.shellID).catch(err => `failed: ${err}`));
						await new Promise(resolve => setTimeout(resolve, 250));
					}
					return seen;
				})();
			}
			return ops.some(op => op.kind === 'done');
		});
		const seen = await reading ?? [];
		assert.deepStrictEqual({
			progress: ops.filter(op => op.kind === 'tool-progress').map(op => op.kind === 'tool-progress' && /^sh_/.test(op.shellID)),
			// While the command slept, it had printed its first line and not its second.
			whileRunning: seen.includes('compiling\n'),
			failedReads: seen.filter(text => text.startsWith('failed')),
			ops: ops.filter(op => op.kind === 'tool-done' || op.kind === 'done').map(op => op.kind === 'tool-done' ? `${op.name} done: ${op.output.trim()}` : `${op.kind} ${op.kind === 'done' && op.outcome}`),
		}, {
			progress: [true],
			whileRunning: true,
			failedReads: [],
			ops: ['shell done: compiling\nexported', 'done succeeded'],
		}, `${seen.join(' | ')}\n${logs.slice(-20).join('\n')}`);
	});
});

test('two approvals are open at once, and denying one closes the other, which OpenCode settled, unanswered', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const script: ScriptStep[] = [
		{ kind: 'tools', calls: [{ name: 'shell', args: { command: 'touch first.txt', description: 'Make the first file' } }, { name: 'shell', args: { command: 'touch second.txt', description: 'Make the second file' } }] },
		{ kind: 'text', chunks: ['Neither ran.'] },
	];
	await withServer(script, {}, async (client, sessionID, _mock, logs) => {
		const controller = new AbortController();
		const events = client.events(controller.signal)[Symbol.asyncIterator]();
		assert.equal((await events.next()).value?.type, 'server.connected');
		const reducer = new TurnReducer(sessionID);
		const sent = await client.prompt(sessionID, { text: 'Make both files.' });
		reducer.awaitDelivery(sent.data.id);

		// The chat's cards, as the participant shows them: asked without holding up the turn.
		const questions = new OpenQuestions(err => seen.push(`error: ${err instanceof Error ? err.message : err}`));
		const seen: string[] = [];
		const answers = new Map<string, (decision: 'reject') => void>();
		const asked: string[] = [];
		let openAtOnce = 0;
		const ops: TurnOp[] = [];
		for (let next = await events.next(); !next.done; next = await events.next()) {
			for (const op of reducer.reduce(next.value)) {
				ops.push(op);
				if (op.kind === 'permission') {
					const request = op.request;
					asked.push(request.id);
					questions.ask(request.id, signal => new Promise<'reject' | undefined>(resolve => {
						answers.set(request.id, resolve);
						signal.addEventListener('abort', () => {
							seen.push(`card ${asked.indexOf(request.id) + 1} closed`);
							resolve(undefined);
						});
					}), async decision => {
						seen.push(`card ${asked.indexOf(request.id) + 1} answered ${decision}`);
						await client.replyPermission(request.sessionID, request.id, decision);
					});
				} else if (op.kind === 'settled') {
					questions.settled(op.id);
				}
			}
			openAtOnce = Math.max(openAtOnce, questions.size);
			if (questions.size === 2) {
				answers.get(asked[0])?.('reject');
			}
			if (ops.some(op => op.kind === 'done')) {
				break;
			}
		}
		controller.abort();
		// Bounded, so a card that never closes fails the test instead of hanging it.
		await Promise.race([questions.idle(), new Promise(resolve => setTimeout(resolve, 5_000))]);
		// A reply to the request OpenCode settled itself finds nothing to answer.
		const late = await client.replyPermission(sessionID, asked[1], 'once').then(() => 'answered', err => isNotFound(err) ? 'not found' : String(err));

		const failed = ops.flatMap(op => op.kind === 'tool-error' ? [op.id] : []);
		assert.deepStrictEqual({
			openAtOnce,
			seen,
			late,
			// Each request is reported settled, naming the tool it denied, before that tool fails.
			order: ops.flatMap(op => op.kind === 'settled' ? [`card ${asked.indexOf(op.id) + 1} settled, ${op.denied && failed.includes(op.denied) ? 'its tool denied' : `denied ${op.denied}`}`] : op.kind === 'tool-error' || op.kind === 'tool-done' ? [`${op.name} ${op.kind === 'tool-error' ? 'failed' : 'ran'}`] : []),
			// A denial ends the run.
			done: ops.find(op => op.kind === 'done'),
		}, {
			openAtOnce: 2,
			seen: ['card 1 answered reject', 'card 2 closed'],
			late: 'not found',
			order: ['card 1 settled, its tool denied', 'card 2 settled, its tool denied', 'shell failed', 'shell failed'],
			done: { kind: 'done', outcome: 'interrupted' },
		}, `${ops.map(op => op.kind).join(' ')}\n${logs.slice(-20).join('\n')}`);
	}, { permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] });
});
