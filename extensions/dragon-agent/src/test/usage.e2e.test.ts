/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end: the composer's usage readout on the real OpenCode binary. A hosted-style provider
 * (OpenAI-compatible, with prices in the config layer) reports cached prompt tokens the way
 * OpenAI does; OpenCode normalizes them, and the readout shows the context, the cache hit and the
 * prices. Runs when an `opencode` binary is available.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { writeDragonConfig } from '../dragonConfig';
import { OpenCodeServer, resolveBinary } from '../opencode/server';
import { SessionBridge } from '../opencode/sessionBridge';
import { UsageService } from '../usage/usageService';
import { startMockOllama } from './mockOllama';

const extensionPath = path.join(__dirname, '..', '..');
const binary = process.env.DRAGON_OPENCODE_BIN ?? resolveBinary({ extensionPath, env: { PATH: '' } });
const MODEL = 'acme-large';

test('the usage readout shows context, cache hits and prices from a caching provider', { skip: !binary && 'no opencode binary', timeout: 180_000 }, async () => {
	const workspace = mkdtempSync(path.join(tmpdir(), 'dragon-usage-ws-'));
	const home = mkdtempSync(path.join(tmpdir(), 'dragon-usage-home-'));
	const mock = await startMockOllama([{ kind: 'text', chunks: ['Hello.'] }], MODEL, 0, { usage: { prompt: 10_000, completion: 500, cached: 8_000 } });
	const configFile = path.join(home, 'dragon.json');
	await writeDragonConfig(configFile, {
		$schema: 'https://opencode.ai/config.json',
		model: `acme/${MODEL}`,
		providers: {
			acme: {
				name: 'Acme', package: '@opencode/ai/providers/openai-compatible',
				settings: { baseURL: `${mock.origin}/v1`, apiKey: 'test' },
				models: { [MODEL]: { name: 'Acme Large', limit: { context: 200_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] }, cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }] } },
			},
		},
	});
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: workspace, configFile, log: line => process.env.DRAGON_TEST_LOG && console.error(line),
		env: { ...process.env, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
	});
	const bridge = new SessionBridge(() => server.ensure());
	try {
		const client = await server.ensure();
		for (let i = 0; i < 120 && !(await client.models(workspace)).some(m => m.providerID === 'acme'); i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const usage = new UsageService(() => server.ensure(), bridge, () => workspace);
		const before = await usage.summary({ model: `acme/${MODEL}` });
		assert.equal(before.price?.text, '$3 / $15 per 1M', 'prices come from the model catalog OpenCode serves');
		assert.equal(before.context?.text, '0%');
		assert.equal(before.cache, undefined);

		const session = await client.createSession({ directory: workspace, agent: 'build', model: { providerID: 'acme', id: MODEL } });
		await client.prompt(session.id, { text: 'Say hello.' });
		await client.request('POST', `/api/experimental/session/${session.id}/wait`);
		let after = await usage.summary({ sessionID: session.id });
		for (let i = 0; i < 40 && !after.cache; i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
			after = await usage.summary({ sessionID: session.id });
		}
		// OpenCode splits the 10,000 prompt tokens into 2,000 uncached and 8,000 cache reads. The
		// session totals also count its title request (10 prompt and 5 output tokens, uncached).
		assert.equal(after.cache?.text, '80% cache hit', JSON.stringify(after));
		assert.match(after.cache!.tooltip, /Input \(uncached\) 2,010/);
		assert.match(after.cache!.tooltip, /Output 505/);
		assert.match(after.cache!.tooltip, /Cache read 8,000/);
		assert.equal(after.context?.used, 10_500);
		assert.equal(after.context?.text, '5%');
		assert.equal(after.price?.text, '$3 / $15 per 1M');
		const info = await client.session(session.id);
		const expected = (2_010 * 3 + 505 * 15 + 8_000 * 0.3) / 1_000_000;
		assert.ok(Math.abs((info.cost ?? 0) - expected) < 1e-9, `OpenCode billed ${info.cost}, expected ${expected}`);
		assert.match(after.cache!.tooltip, /Session cost so far \$0\.016/);
		usage.dispose();
	} finally {
		bridge.dispose();
		server.dispose();
		await mock.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
