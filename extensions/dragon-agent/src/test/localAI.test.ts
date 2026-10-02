/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GiB, Hardware, LOCAL_MODELS, modelBudget, unsupportedReason } from '../localAI/catalog';
import { splashModels, splashProvider } from '../localAI/splash';
import { buildDragonConfig } from '../dragonConfig';

const mac = (ram: number): Hardware => ({ ram: ram * GiB, disk: 100 * GiB, platform: 'darwin', arch: 'arm64', chip: 'Apple M4 Pro', osMajor: 26 });

test('local AI admission reserves OS memory and never equates active MoE parameters with footprint', () => {
	const small = LOCAL_MODELS.find(m => m.id === 'qwen3.5:9b')!;
	const large = LOCAL_MODELS.find(m => m.id === 'qwen3.6:35b')!;
	assert.equal(modelBudget(mac(24)), 18 * GiB);
	assert.equal(unsupportedReason(small, mac(24)), undefined);
	assert.match(unsupportedReason(large, mac(24))!, /memory|AI/);
	assert.equal(unsupportedReason(large, mac(48)), undefined);
	assert.ok(LOCAL_MODELS.every(m => unsupportedReason(m, mac(4))));
	assert.ok(unsupportedReason(small, { ...mac(24), disk: 8 * GiB }));
	assert.equal(unsupportedReason(small, { ...mac(24), disk: 8 * GiB }, true), undefined);
});

test('Splash only allows a supported chip and OS, independently of RAM', () => {
	const model = LOCAL_MODELS.find(m => m.runtime === 'splash')!;
	for (const hardware of [{ ...mac(128), platform: 'linux' }, { ...mac(128), arch: 'x64' }, { ...mac(128), chip: 'Apple M2 Max' }, { ...mac(128), osMajor: 24 }]) {
		assert.ok(unsupportedReason(model, hardware));
	}
	assert.equal(unsupportedReason(model, mac(48)), undefined);
});

test('Splash discovery rejects remote origins, unrelated servers, failures and undersized context', async () => {
	let requests = 0;
	const fake = (async () => {
		requests++; return new Response(JSON.stringify({
			data: [
				{ id: 'valid', owned_by: 'splash', context_length: 32768, input_modalities: ['text', 'image'] },
				{ id: 'wrong', owned_by: 'other', context_length: 65536 },
				{ id: 'small', owned_by: 'splash', context_length: 8192 },
			]
		}));
	}) as typeof fetch;
	assert.deepEqual(await splashModels('https://example.com', fake), []);
	assert.equal(requests, 0);
	const models = await splashModels('http://127.0.0.1:8000', fake);
	assert.deepEqual(models.map(m => m.id), ['valid']);
	assert.deepEqual(await splashModels(undefined, (async () => new Response('', { status: 503 })) as typeof fetch), []);
	const config = buildDragonConfig({ ollamaOrigin: 'http://127.0.0.1:11434', ollamaModels: [], splashModels: models }) as { providers: Record<string, any> };
	assert.ok(config.providers.ollama);
	assert.equal(config.providers.splash.models.valid.limit.context, 32768);
	assert.deepEqual(config.providers.splash, splashProvider(models));
});
