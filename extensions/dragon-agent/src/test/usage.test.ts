/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient } from '../opencode/client';
import type { BridgeListener } from '../opencode/sessionBridge';
import type { OpenCodeEvent } from '../opencode/types';
import { formatCacheHitPercent, formatTokens, formatUSD, summarize, TokenBuckets, UsageModel } from '../usage/usage';
import { UsageService } from '../usage/usageService';

const tokens = (input: number, read = 0, write = 0, output = 0, reasoning = 0): TokenBuckets => ({ input, output, reasoning, cache: { read, write } });

test('cache-hit percentages never round a partial hit up to 100% (cases from DeepSeek Harness)', () => {
	// [cache read, uncached input, expected]
	const cases: [number, number, string][] = [
		[986, 14, '99'], [991, 9, '99'], [9_949, 51, '99'], [995, 5, '99.5'], [9_994, 6, '99.9'],
		[9_995, 5, '99.95'], [19_991, 9, '99.96'], [19_997, 3, '99.99'], [19_999, 1, '99.995'], [39_999, 1, '99.998'],
		[Number.MAX_SAFE_INTEGER - 1, 1, '99.99999999999999'], [10_000, 0, '100'], [90, 10, '90'], [0, 10, '0'],
	];
	for (const [read, uncached, expected] of cases) {
		assert.equal(formatCacheHitPercent(read, read + uncached), expected, `${read}/${read + uncached}`);
	}
	assert.equal(formatCacheHitPercent(0, 0), null);
	assert.equal(formatCacheHitPercent(1, 2, 1), '50');
});

test('token and money formats', () => {
	assert.deepEqual([517, 12_240, 517_000, 1_234_567].map(formatTokens), ['517', '12.2K', '517K', '1.2M']);
	assert.deepEqual([15, 3, 0.3, 0.075, 1.25, 0, 0.0042, 250].map(formatUSD), ['$15', '$3', '$0.3', '$0.075', '$1.25', '$0', '$0.0042', '$250']);
});

const claude: UsageModel = {
	providerID: 'anthropic', id: 'claude-sonnet-5', name: 'Claude Sonnet 5', limit: { context: 200_000 },
	cost: [
		{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
		{ tier: { type: 'context', size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
	],
};

test('the readout for a caching cloud model: context, cache hit and prices', () => {
	const s = summarize({ model: claude, last: tokens(1_000, 40_000, 2_000, 1_500, 500), total: tokens(10_000, 90_000, 5_000, 4_000), cost: 0.4213 });
	assert.equal(s.context?.used, 45_000);
	assert.equal(s.context?.percent, 23);
	assert.equal(s.context?.text, '23%');
	assert.match(s.context!.tooltip, /~45K of 200K tokens/);
	assert.equal(s.cache?.text, '86% cache hit'); // 90,000 of 105,000 prompt tokens
	assert.match(s.cache!.tooltip, /Cache read 90,000/);
	assert.match(s.cache!.tooltip, /Cache write 5,000/);
	assert.match(s.cache!.tooltip, /Session cost so far \$0\.42/);
	assert.equal(s.price?.text, '$3 / $15 per 1M');
	assert.match(s.price!.tooltip, /Cache read \$0\.3 · Cache write \$3\.75/);
	assert.match(s.price!.tooltip, /Above 200K context: input \$6 · output \$22\.5/);
});

test('works for every provider shape OpenCode reports', () => {
	// OpenAI-style: caching reported as cache reads only, no write price.
	const gpt: UsageModel = { providerID: 'openai', id: 'gpt-5', name: 'GPT-5', limit: { context: 400_000 }, cost: [{ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } }] };
	assert.equal(summarize({ model: gpt, total: tokens(1_000, 3_000) }).cache?.text, '75% cache hit');
	// A provider that caches but whose catalog lists no cache price still shows real hits.
	const openrouter: UsageModel = { providerID: 'openrouter', id: 'x', name: 'X', limit: { input: 128_000 }, cost: [{ input: 0.5, output: 1.5, cache: { read: 0, write: 0 } }] };
	const routed = summarize({ model: openrouter, last: tokens(64_000), total: tokens(1_000, 1_000) });
	assert.equal(routed.cache?.text, '50% cache hit');
	assert.equal(routed.context?.percent, 50, 'limit.input is the window when context is not listed');
	// No cache support and no hits: no misleading "0% cache hit".
	assert.equal(summarize({ model: openrouter, total: tokens(5_000) }).cache, undefined);
	// Local models: free, and no cache pill unless the runtime reports hits.
	const local: UsageModel = { providerID: 'ollama', id: 'qwen', name: 'Qwen', limit: { context: 32_768 } };
	const l = summarize({ model: local, last: tokens(30_000, 0, 0, 2_000), total: tokens(30_000) });
	assert.equal(l.price?.text, 'Local · free');
	assert.equal(l.cache, undefined);
	assert.equal(l.context?.percent, 98);
	assert.equal(summarize({ model: local, last: tokens(40_000) }).context?.percent, 100, 'clamped');
	// A free hosted model.
	assert.equal(summarize({ model: { ...openrouter, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] } }).price?.text, 'Free');
	// A model without prices or a window shows what it can.
	assert.deepEqual(summarize({ model: { providerID: 'custom', id: 'm', name: 'M' } }), { model: { label: 'M', local: false }, price: undefined });
	// Before the first reply, and right after a compaction.
	assert.equal(summarize({ model: claude }).context?.text, '0%');
	assert.match(summarize({ model: claude, compacted: true }).context!.tooltip, /just compacted/);
});

function fakeClient() {
	const calls: string[] = [];
	let sessionTokens = tokens(100, 900);
	const client = {
		async models() {
			calls.push('models');
			return [{ id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', providerID: 'anthropic', name: 'Claude Sonnet 5', enabled: true, cost: claude.cost, limit: claude.limit }];
		},
		async session(id: string) {
			calls.push(`session:${id}`);
			return { id, model: { providerID: 'anthropic', id: 'claude-sonnet-5' }, location: { directory: '/w' }, tokens: sessionTokens, cost: 0.01 };
		},
		async messages(id: string) {
			calls.push(`messages:${id}`);
			return [
				{ id: 'm1', type: 'user', time: { created: 1 } },
				{ id: 'm2', type: 'assistant', time: { created: 2 }, tokens: tokens(100, 900, 0, 50) },
				{ id: 'm3', type: 'idle', time: { created: 3 } },
			];
		},
	} as unknown as OpenCodeClient;
	return { client, calls, setTokens: (t: TokenBuckets) => { sessionTokens = t; } };
}

test('the usage service caches per session and refreshes only after OpenCode reports new usage', async () => {
	const { client, calls, setTokens } = fakeClient();
	let listener: BridgeListener | undefined;
	const bridge = { subscribe: (l: BridgeListener) => { listener = l; return { dispose: () => { } }; } };
	const service = new UsageService(async () => client, bridge, () => '/w');
	const first = await service.summary({ sessionID: 's1' });
	assert.equal(first.cache?.text, '90% cache hit');
	assert.equal(first.context?.used, 1_050);
	assert.equal(first.price?.text, '$3 / $15 per 1M');
	await service.summary({ sessionID: 's1' });
	assert.deepEqual(calls, ['session:s1', 'messages:s1', 'models'], 'the second read is served from the cache');

	setTokens(tokens(100, 1_900));
	listener!({ id: 'e', type: 'session.usage.updated', data: { sessionID: 'other' } } as OpenCodeEvent);
	assert.equal((await service.summary({ sessionID: 's1' })).cache?.text, '90% cache hit', 'another session\'s usage does not invalidate it');
	listener!({ id: 'e2', type: 'session.usage.updated', data: { sessionID: 's1' } } as OpenCodeEvent);
	assert.equal((await service.summary({ sessionID: 's1' })).cache?.text, '95% cache hit');

	// A different model selected in the composer: its window and prices, not the old context.
	const other = await service.summary({ sessionID: 's1', model: 'anthropic/other' });
	assert.equal(other.price, undefined, 'unknown model');
	const noSession = await service.summary({ model: 'anthropic/claude-sonnet-5' });
	assert.equal(noSession.context?.text, '0%');
	assert.equal(noSession.cache, undefined);
	service.dispose();
});

test('a compaction newer than the last reply resets the context reading', async () => {
	const { client } = fakeClient();
	(client as unknown as { messages: () => Promise<unknown[]> }).messages = async () => [
		{ id: 'm2', type: 'assistant', time: { created: 2 }, tokens: tokens(100, 90_000) },
		{ id: 'm3', type: 'compaction', time: { created: 3 } },
	];
	const service = new UsageService(async () => client, { subscribe: () => ({ dispose: () => { } }) }, () => '/w');
	const s = await service.summary({ sessionID: 's1' });
	assert.equal(s.context?.used, 0);
	assert.match(s.context!.tooltip, /just compacted/);
});
