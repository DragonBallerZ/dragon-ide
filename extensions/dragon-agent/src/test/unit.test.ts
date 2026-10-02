/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { featuredIntegrations, pickDefaultModel, sortModels } from '../catalog';
import { reversePatch, TurnOp, TurnReducer } from '../chat/turn';
import { buildInlinePrompt, extractCode, reindent } from '../chat/inline';
import { buildFimRequest, complete, isMidLine, postProcess } from '../completions/fim';
import { startMockOllama } from './mockOllama';
import { describePermission, permissionDecision, presentTool, skippedMessage } from '../chat/toolPresentation';
import { buildDragonConfig } from '../dragonConfig';
import { basicAuth, formatModelRef, OpenCodeClient, parseModelRef } from '../opencode/client';
import { binaryCandidates, parseListenLine, resolveBinary, serverEnv, tuiArgs } from '../opencode/server';
import { SseParser } from '../opencode/sse';
import type { IntegrationInfo, ModelInfo, OpenCodeEvent } from '../opencode/types';
import { agentContextFor, agentVariantName, chatModelNames, createAgentVariant, isLoopbackOrigin, LOCAL_OUTPUT_TOKENS, ollamaConfig, recommendFor, variantContext } from '../ollama/ollama';
import { availableUpdate, compareVersions, latestRelease, readDragonProduct } from '../updates/release';

const fixture = (name: string) => JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', name), 'utf8'));

test('SSE parser handles split frames, heartbeats and CRLF', () => {
	const parser = new SseParser();
	assert.deepEqual(parser.push('data: {"type":"a"'), []);
	assert.deepEqual(parser.push('}\n\n: heartbeat\n\ndata: {"type":"b"}\r\n\r\n'), [{ type: 'a' }, { type: 'b' }]);
	assert.deepEqual(parser.push('data: not json\n\n'), []);
});

test('reducer turns a recorded OpenCode turn into chat operations', () => {
	const { sessionID, events } = fixture('turn-edit.json') as { sessionID: string; events: OpenCodeEvent[] };
	const reducer = new TurnReducer(sessionID);
	const ops: TurnOp[] = events.flatMap(event => reducer.reduce(event));
	const kinds = ops.map(op => op.kind);

	assert.ok(reducer.hasStarted);
	assert.deepEqual(kinds.filter(k => k.startsWith('tool')), ['tool-start', 'tool-running', 'tool-done']);
	const done = ops.find(op => op.kind === 'tool-done');
	assert.equal(done?.kind === 'tool-done' && done.name, 'edit');
	assert.equal(done?.kind === 'tool-done' && done.files[0].file, 'hello.txt');
	assert.ok(ops.some(op => op.kind === 'thinking' && op.delta.includes('Thinking')));
	const text = ops.filter(op => op.kind === 'text').map(op => op.kind === 'text' ? op.delta : '').join('');
	assert.equal(text, 'The file said hello world and now says hello dragon.');
	assert.deepEqual(ops.at(-1), { kind: 'done', outcome: 'succeeded' });
});

test('reducer ignores other sessions and reports failures', () => {
	const reducer = new TurnReducer('ses_a');
	assert.deepEqual(reducer.reduce({ id: '1', type: 'session.text.delta', data: { sessionID: 'ses_b', delta: 'x' } }), []);
	assert.deepEqual(reducer.reduce({ id: '2', type: 'session.execution.failed', data: { sessionID: 'ses_a', error: { type: 'provider.auth', message: 'nope' } } }),
		[{ kind: 'done', outcome: 'failed', error: { type: 'provider.auth', message: 'nope' } }]);
	assert.deepEqual(reducer.reduce({ id: '3', type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_a' } } }), [{ kind: 'form', formID: 'frm_1' }]);
	assert.equal(reducer.reduce({ id: '4', type: 'permission.asked', data: { sessionID: 'ses_a', id: 'per_1', action: 'edit', resources: ['a.ts'] } })[0].kind, 'permission');
});

test('reducer passes on permission requests from the subagent sessions it saw created', () => {
	const children = new Set<string>();
	const first = new TurnReducer('ses_a', children);
	const asked = (reducer: TurnReducer, events: OpenCodeEvent[]) => events.flatMap(event => reducer.reduce(event)).map(op => op.kind === 'permission' ? op.request.id : op.kind);
	const ask = (id: string, sessionID: string): OpenCodeEvent => ({ id, type: 'permission.asked', data: { sessionID, id, action: 'shell', resources: ['ls'] } });
	assert.deepEqual({
		first: asked(first, [
			{ id: '1', type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_a' } },
			ask('per_child', 'ses_child'),
			ask('per_other', 'ses_other'),
			{ id: '2', type: 'session.created', data: { sessionID: 'ses_grandchild', parentID: 'ses_child' } },
			ask('per_grandchild', 'ses_grandchild'),
			{ id: '3', type: 'session.created', data: { sessionID: 'ses_unrelated', parentID: 'ses_other' } },
			ask('per_unrelated', 'ses_unrelated'),
		]),
		// A later turn gets the same set, so a subagent it resumes still reaches the chat.
		later: asked(new TurnReducer('ses_a', children), [ask('per_resumed', 'ses_child')]),
	}, { first: ['per_child', 'per_grandchild'], later: ['per_resumed'] });
});

test('reducer separates text blocks', () => {
	const reducer = new TurnReducer('s');
	const a = reducer.reduce({ id: '1', type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm1', ordinal: 0, delta: 'one' } });
	const b = reducer.reduce({ id: '2', type: 'session.text.delta', data: { sessionID: 's', assistantMessageID: 'm2', ordinal: 0, delta: 'two' } });
	assert.equal(a[0].kind === 'text' && a[0].delta, 'one');
	assert.equal(b[0].kind === 'text' && b[0].delta, '\n\ntwo');
});

test('reversePatch recovers the original content', () => {
	const patch = 'Index: a\n===\n--- a\n+++ a\n@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3\n';
	assert.equal(reversePatch('line1\nnew\nline3\n', patch), 'line1\nold\nline3\n');
	assert.equal(reversePatch('something else\n', patch), undefined);
	const multi = '@@ -1,1 +1,2 @@\n a\n+b\n@@ -5,1 +6,1 @@\n-x\n+y\n';
	assert.equal(reversePatch('a\nb\n2\n3\n4\ny\n', multi), 'a\n2\n3\n4\nx\n');
});

test('tool presentation', () => {
	assert.equal(presentTool('read', { path: 'src/a.ts' }).done, 'Read `src/a.ts`');
	assert.equal(presentTool('edit', { path: 'b.ts' }).edits, true);
	assert.equal(presentTool('shell', { command: 'npm test' }).command, 'npm test');
	assert.equal(presentTool('mcp_github_search', {}).running, 'Running `mcp_github_search`');
	assert.equal(presentTool('find_files', { query: 'chatWidget' }).done, 'Found files like `chatWidget`');
	assert.match(describePermission('edit', ['a.ts', 'b.ts']), /change `a.ts`, `b.ts`/);
	assert.match(describePermission('shell', ['rm -rf dist']), /run `rm -rf dist`/);
	assert.equal(skippedMessage(presentTool('shell', { command: 'rm -rf dist' }).running, 'denied'), 'Skipped running `rm -rf dist`: denied');
});

test('approval answers become permission decisions', () => {
	const answers = [{ selectedValue: 'once' }, { selectedValue: 'always' }, { selectedValue: 'reject' }, { freeformValue: 'always' }, 'once', undefined];
	assert.deepEqual(answers.map(permissionDecision), ['once', 'always', 'reject', 'always', 'once', 'reject']);
});

test('model refs', () => {
	assert.deepEqual(parseModelRef('ollama/qwen3:8b'), { providerID: 'ollama', id: 'qwen3:8b' });
	assert.deepEqual(parseModelRef('openrouter/anthropic/claude'), { providerID: 'openrouter', id: 'anthropic/claude' });
	assert.equal(parseModelRef('nope'), undefined);
	assert.equal(parseModelRef('/x'), undefined);
	assert.equal(formatModelRef({ providerID: 'a', id: 'b' }), 'a/b');
	assert.equal(basicAuth('pw'), `Basic ${Buffer.from('opencode:pw').toString('base64')}`);
});

test('server helpers', () => {
	assert.equal(parseListenLine('{"url":"http://127.0.0.1:4096"}'), 'http://127.0.0.1:4096');
	assert.equal(parseListenLine('server listening on http://127.0.0.1:5000'), 'http://127.0.0.1:5000');
	assert.equal(parseListenLine('other'), undefined);
	const env = serverEnv({ PATH: '/bin', OPENCODE_SERVER_PASSWORD: 'leak' }, 'secret', '/cfg.json');
	assert.equal(env.OPENCODE_PASSWORD, 'secret');
	assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined);
	assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
	assert.equal(env.OPENCODE_CONFIG, '/cfg.json');
	const candidates = binaryCandidates({ configuredBinary: '/custom/opencode', extensionPath: '/ext', platform: 'linux', env: { PATH: '/usr/bin' } });
	assert.deepEqual(candidates, ['/custom/opencode', path.join('/ext', 'bin', 'opencode'), path.join('/usr/bin', 'opencode')]);
	assert.equal(resolveBinary({ extensionPath: '/ext', platform: 'linux', env: { PATH: '' } }, p => p === path.join('/ext', 'bin', 'opencode')), path.join('/ext', 'bin', 'opencode'));
	assert.deepEqual(tuiArgs('http://x', 'ses_1'), ['--server', 'http://x', '--session', 'ses_1']);
});

test('ollama helpers', () => {
	assert.ok(isLoopbackOrigin('http://127.0.0.1:11434'));
	assert.ok(isLoopbackOrigin('http://[::1]:11434'));
	assert.ok(!isLoopbackOrigin('http://192.168.1.4:11434'));
	assert.equal(recommendFor(4 * 1024 ** 3).length, 0);
	assert.ok(recommendFor(64 * 1024 ** 3).length >= 3);
	type Cfg = { model?: string; providers: { ollama: { settings?: { baseURL: string }; models?: Record<string, { limit: { output: number } }> } } };
	const config = ollamaConfig('http://127.0.0.1:11434', [{ name: 'qwen2.5-coder:7b', size: 1 }]) as Cfg;
	assert.equal(config.providers.ollama.models?.['qwen2.5-coder:7b'].limit.output, LOCAL_OUTPUT_TOKENS);
	assert.equal(config.providers.ollama.settings, undefined);
	const custom = ollamaConfig('http://localhost:9999', []) as Cfg;
	assert.equal(custom.providers.ollama.settings?.baseURL, 'http://localhost:9999/v1');
	const dragon = buildDragonConfig({ model: 'ollama/qwen2.5-coder:7b', ollamaOrigin: 'http://127.0.0.1:11434', ollamaModels: [] }) as Cfg;
	assert.equal(dragon.model, 'ollama/qwen2.5-coder:7b');
});

test('ollama agent variants get a context window OpenCode can work in', async () => {
	const GB = 1024 ** 3;
	assert.equal(agentContextFor(16 * GB, 32768), 32768);
	assert.equal(agentContextFor(64 * GB, 262144), 65536);
	assert.equal(agentContextFor(64 * GB, 32768), 32768, 'never above the model maximum');
	assert.equal(agentContextFor(8 * GB), 32768);
	assert.equal(agentVariantName('qwen2.5-coder:7b', 32768), 'qwen2.5-coder:7b-dragon-32k');
	assert.equal(agentVariantName('llama3', 65536), 'llama3:latest-dragon-64k');
	assert.equal(agentVariantName('hf.co/user/repo:Q4_K_M', 32768), 'hf.co/user/repo:Q4_K_M-dragon-32k');
	assert.equal(agentVariantName('localhost:5000/team/model', 32768), 'localhost:5000/team/model:latest-dragon-32k');
	assert.equal(agentVariantName('qwen3:14b-dragon-32k', 65536), 'qwen3:14b-dragon-64k', 'a variant is never nested');
	assert.equal(variantContext('qwen3:14b-dragon-64k'), 65536);
	assert.equal(variantContext('qwen3:14b'), undefined);
	assert.deepEqual(chatModelNames([{ name: 'qwen3:14b', size: 1 }, { name: 'qwen2.5-coder:7b', size: 1 }, { name: 'qwen2.5-coder:7b-dragon-32k', size: 1 }, { name: 'nomic-embed-text:latest', size: 1 }]),
		['qwen3:14b', 'qwen2.5-coder:7b-dragon-32k'], 'no embedding models, and variants replace their base');

	const requests: { url: string; body: unknown }[] = [];
	const fake = (status: number, reply: object) => (async (url: URL, init: { body: string }) => {
		requests.push({ url: String(url), body: JSON.parse(init.body) });
		return new Response(JSON.stringify(reply), { status });
	}) as unknown as typeof fetch;
	assert.equal(await createAgentVariant('qwen2.5-coder:7b', 32768, 'http://127.0.0.1:11434', fake(200, { status: 'success' })), 'qwen2.5-coder:7b-dragon-32k');
	assert.deepEqual(requests[0], { url: 'http://127.0.0.1:11434/api/create', body: { model: 'qwen2.5-coder:7b-dragon-32k', from: 'qwen2.5-coder:7b', parameters: { num_ctx: 32768 }, stream: false } });
	await assert.rejects(createAgentVariant('old:7b', 32768, 'http://127.0.0.1:11434', fake(400, { error: 'invalid model name' })), /invalid model name/);

	type Cfg = { providers: { ollama: { models?: Record<string, { limit: { context?: number; output: number } }> } } };
	const config = ollamaConfig('http://127.0.0.1:11434', [{ name: 'qwen2.5-coder:7b', size: 1 }, { name: 'qwen2.5-coder:7b-dragon-32k', size: 1 }]) as Cfg;
	assert.deepEqual(config.providers.ollama.models?.['qwen2.5-coder:7b-dragon-32k'].limit, { context: 32768, output: LOCAL_OUTPUT_TOKENS });
	assert.deepEqual(config.providers.ollama.models?.['qwen2.5-coder:7b'].limit, { output: LOCAL_OUTPUT_TOKENS });

	const model = (providerID: string, id: string): ModelInfo => ({ id, modelID: id, providerID, name: id, enabled: true });
	assert.deepEqual(sortModels([model('ollama', 'qwen2.5-coder:7b'), model('ollama', 'qwen2.5-coder:7b-dragon-32k'), model('ollama', 'qwen3:14b')]).map(m => m.id),
		['qwen2.5-coder:7b-dragon-32k', 'qwen3:14b'], 'the base model is shown only as its variant');
});

test('catalog helpers', () => {
	const model = (providerID: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, modelID: id, providerID, name: id, enabled: true, ...extra });
	const sorted = sortModels([model('github-copilot', 'gpt'), model('github-copilot-enterprise', 'claude'), model('zeta', 'z'), model('anthropic', 'a'), model('ollama', 'q'), model('x', 'dep', { status: 'deprecated' })]);
	assert.deepEqual(sorted.map(m => m.providerID), ['ollama', 'anthropic', 'zeta']);
	assert.equal(pickDefaultModel([model('anthropic', 'old', { status: 'deprecated' }), model('anthropic', 'new', { status: 'active' })], 'anthropic')?.id, 'new');
	assert.equal(pickDefaultModel([model('github-copilot', 'gpt')], 'github-copilot'), undefined);
	const integrations: IntegrationInfo[] = [
		{ id: 'github-copilot', name: 'GitHub Copilot', methods: [{ type: 'key' }, { type: 'oauth', id: 'github', label: 'Sign in' }], connections: [] },
		{ id: 'github-copilot-enterprise', name: 'GitHub Copilot Enterprise', methods: [{ type: 'oauth', id: 'github', label: 'Sign in' }], connections: [] },
		{ id: 'zzz', name: 'Zed', methods: [{ type: 'key' }], connections: [] },
		{ id: 'openai', name: 'OpenAI', methods: [{ type: 'key' }, { type: 'oauth', id: 'chatgpt-browser', label: 'ChatGPT' }], connections: [] },
		{ id: 'anthropic', name: 'Anthropic', methods: [{ type: 'key' }, { type: 'env', names: ['ANTHROPIC_API_KEY'] }], connections: [] },
	];
	const { key, signIn } = featuredIntegrations(integrations);
	assert.deepEqual(key.map(k => k.id), ['anthropic', 'openai', 'zzz']);
	assert.deepEqual(signIn, [{ id: 'openai', name: 'OpenAI', methodID: 'chatgpt-browser', label: 'ChatGPT' }]);
});

test('update checks', async () => {
	assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
	assert.ok(compareVersions('v1.10.0', '1.9.3') > 0);
	assert.equal(compareVersions('v1.2', '1.2.0'), 0);
	assert.ok(compareVersions('1.2.0', '1.2.0-beta.2') > 0);
	assert.ok(compareVersions('1.2.0-beta.10', '1.2.0-beta.2') > 0);

	const feed = 'https://api.github.com/repos/o/r/releases/latest';
	const reply = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
	assert.deepEqual(await latestRelease(feed, reply(200, { tag_name: 'v0.2.0', name: 'Dragon IDE 0.2.0', html_url: 'https://example.test/r/0.2.0' })), { version: '0.2.0', name: 'Dragon IDE 0.2.0', url: 'https://example.test/r/0.2.0' });
	await assert.rejects(latestRelease(feed, reply(404, { message: 'Not Found' })), /no published release/);
	await assert.rejects(latestRelease(feed, reply(200, { tag_name: 'v0.3.0-rc.1', html_url: 'x', prerelease: true })), /no usable release/);
	assert.equal((await availableUpdate({ version: '0.1.0', updateFeed: feed }, reply(200, { tag_name: 'v0.2.0', html_url: 'u' })))?.version, '0.2.0');
	assert.equal(await availableUpdate({ version: '0.2.0', updateFeed: feed }, reply(200, { tag_name: 'v0.2.0', html_url: 'u' })), undefined);
	assert.equal(await availableUpdate({ version: '0.2.0' }), undefined, 'no feed, no check');

	const product = readDragonProduct(path.join(__dirname, '..', '..', '..', '..'));
	assert.match(product.version ?? '', /^\d+\.\d+\.\d+/);
	assert.match(product.updateFeed ?? '', /^https:\/\/api\.github\.com\/repos\/.+\/releases\/latest$/);
	assert.deepEqual(readDragonProduct('/nonexistent'), {});
});

test('inline edit helpers', () => {
	const prompt = buildInlinePrompt({ instruction: 'use const', path: 'src/a.ts', languageId: 'typescript', before: 'function f() {\n', target: '\tlet x = 1;', after: '}\n' });
	assert.match(prompt, /Instruction: use const/);
	assert.match(prompt, /```typescript\nfunction f\(\) \{\n<selection>\n\tlet x = 1;\n<\/selection>\n\}\n\n```/);
	assert.match(buildInlinePrompt({ instruction: 'x', path: 'a.md', languageId: 'markdown', before: '```js\n', target: '', after: '```\n' }), /^````markdown$/m, 'the fence outgrows code fences in the file');
	assert.match(buildInlinePrompt({ instruction: 'x', path: 'a.ts', languageId: 'typescript', before: 'a\n', target: '', after: '' }), /a\n<cursor\/>\n/);

	assert.equal(extractCode('Here you go:\n```ts\nconst x = 1;\n```\nDone.'), 'const x = 1;');
	assert.equal(extractCode('```\n<selection>\nconst x = 1;\n</selection>\n```'), 'const x = 1;');
	assert.equal(extractCode('const x = 1;\n'), 'const x = 1;', 'no fence: the reply is the code');
	assert.equal(extractCode('````md\n```js\nx\n```\n````'), '```js\nx\n```');
	assert.equal(extractCode('```\n\n```'), undefined);

	assert.equal(reindent('if (a) {\n\tb();\n}', '\t\t'), '\t\tif (a) {\n\t\t\tb();\n\t\t}');
	assert.equal(reindent('    x();\n\n    y();', '  '), '  x();\n\n  y();');
	assert.equal(reindent('\tx();', '\t'), '\tx();');
});

test('a request on a dead pooled socket is retried once', async () => {
	const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
	let calls = 0;
	const flaky = (async () => {
		if (calls++ === 0) {
			throw reset();
		}
		return new Response(JSON.stringify({ version: '2.0.18', pid: 1, urls: [] }), { status: 200 });
	}) as unknown as typeof fetch;
	assert.equal((await new OpenCodeClient('http://127.0.0.1:4096', 'pw', flaky).info()).version, '2.0.18');
	assert.equal(calls, 2);

	let dead = 0;
	const down = (async () => { dead++; throw reset(); }) as unknown as typeof fetch;
	await assert.rejects(new OpenCodeClient('http://127.0.0.1:4096', 'pw', down).info(), /fetch failed/);
	assert.equal(dead, 2, 'retried once, not forever');

	let refused = 0;
	const refusing = (async () => { refused++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;
	await assert.rejects(new OpenCodeClient('http://127.0.0.1:4096', 'pw', refusing).info());
	assert.equal(refused, 1, 'a refused connection is not a stale socket');
});

test('tab completions: fill-in-the-middle through a local Ollama', async () => {
	assert.ok(!isMidLine('\n}\n'));
	assert.ok(!isMidLine(');\nfoo()'), 'only closing punctuation after the cursor');
	assert.ok(isMidLine('b, c);\n'));

	const request = buildFimRequest('qwen2.5-coder:1.5b', { prefix: 'x'.repeat(7000), suffix: 'y);' }) as { prompt: string; suffix: string; options: { stop: string[]; num_predict: number } };
	assert.equal(request.prompt.length, 6000);
	assert.deepEqual(request.options.stop, ['\n'], 'mid-line: one line only');

	const block = { prefix: 'function add(a, b) {\n\treturn ', suffix: '\n}\n' };
	assert.equal(postProcess('a + b;\n}', block), 'a + b;', 'the closing brace the suffix already has is dropped');
	assert.equal(postProcess('a, b', { prefix: 'add(', suffix: ');' }), 'a, b');
	assert.equal(postProcess('a, b);', { prefix: 'add(', suffix: ');' }), 'a, b');
	assert.equal(postProcess('1, 2);\nmore', { prefix: 'add(', suffix: '1, 2);' }), undefined, 'nothing new');
	assert.equal(postProcess('   \n', block), undefined);
	assert.equal(postProcess(Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'), { prefix: '', suffix: '' })?.split('\n').length, 8);

	const mock = await startMockOllama([], 'qwen2.5-coder:1.5b', 0, { complete: (prompt, suffix) => prompt.endsWith('return ') && suffix.startsWith('\n}') ? 'a + b;\n}' : '' });
	try {
		assert.equal(await complete(mock.origin, 'qwen2.5-coder:1.5b', block, new AbortController().signal), 'a + b;');
		assert.equal(await complete('http://10.0.0.1:11434', 'qwen2.5-coder:1.5b', block, new AbortController().signal), undefined, 'never a remote origin');
		const aborted = new AbortController();
		aborted.abort();
		assert.equal(await complete(mock.origin, 'qwen2.5-coder:1.5b', block, aborted.signal), undefined);
	} finally {
		await mock.close();
	}
});
