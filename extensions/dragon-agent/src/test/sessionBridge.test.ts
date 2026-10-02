/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient } from '../opencode/client';
import { changesModels, SessionBridge } from '../opencode/sessionBridge';
import type { OpenCodeEvent } from '../opencode/types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A client whose event stream yields the given batches, one connection per batch, then fails. */
function fakeClient(batches: OpenCodeEvent[][]): { client: OpenCodeClient; connections: () => number } {
	let n = 0;
	const client = {
		async *events(signal: AbortSignal) {
			const batch = batches[n++];
			if (!batch) {
				await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
				return;
			}
			for (const event of batch) {
				yield event;
			}
			throw new Error('connection reset');
		},
	} as unknown as OpenCodeClient;
	return { client, connections: () => n };
}

const ev = (type: string, data: Record<string, unknown> = {}, id = `${type}-${Math.random()}`): OpenCodeEvent => ({ id, type, data });

test('the session bridge fans one stream out to every subscriber and reconnects after it drops', async () => {
	const { client, connections } = fakeClient([
		[ev('server.connected'), ev('session.execution.started', { sessionID: 'a' })],
		[ev('server.connected'), ev('session.execution.succeeded', { sessionID: 'a' })],
	]);
	const bridge = new SessionBridge(async () => client, () => { }, [5]);
	const seen: string[][] = [[], []];
	let reconnects = 0;
	bridge.onDidConnect(() => reconnects++);
	const subs = seen.map(list => bridge.subscribe(e => list.push(e.type)));
	for (let i = 0; i < 100 && connections() < 3; i++) {
		await sleep(5);
	}
	assert.deepEqual(seen[0], ['server.connected', 'session.execution.started', 'server.connected', 'session.execution.succeeded']);
	assert.deepEqual(seen[1], seen[0], 'every subscriber gets every event');
	assert.equal(reconnects, 2, 'subscribers are told about each (re)connection so they can re-read missed state');
	subs[1].dispose();
	bridge.dispose();
});

test('a failing subscriber does not stop the others', async () => {
	const { client } = fakeClient([[ev('server.connected'), ev('x')]]);
	const bridge = new SessionBridge(async () => client, () => { }, [1000]);
	const got: string[] = [];
	bridge.subscribe(() => { throw new Error('boom'); });
	bridge.subscribe(e => got.push(e.type));
	for (let i = 0; i < 100 && got.length < 2; i++) {
		await sleep(5);
	}
	assert.deepEqual(got, ['server.connected', 'x']);
	bridge.dispose();
});

test('provider, model, catalog and config events mean the model list must be read again', () => {
	const types = ['provider.updated', 'model.updated', 'catalog.updated', 'config.updated', 'session.usage.updated', 'agent.updated', 'server.connected'];
	assert.deepEqual(types.filter(type => changesModels({ id: 'e', type } as OpenCodeEvent)), ['provider.updated', 'model.updated', 'catalog.updated', 'config.updated']);
});
