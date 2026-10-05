/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end: agents messaging each other through the real OpenCode binary, the agent messaging
 * plugin and the agent hub, against a scripted Ollama. Skipped when there is no `opencode` binary.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentHub } from '../agents/hub';
import { lastAssistantText } from '../agents/message';
import { TurnOp, TurnReducer } from '../chat/turn';
import { buildDragonConfig, READ_ONLY_PERMISSIONS, writeDragonConfig, writeSearchPlugin } from '../dragonConfig';
import type { OpenCodeClient } from '../opencode/client';
import { OpenCodeServer, resolveBinary } from '../opencode/server';
import type { OpenCodeEvent } from '../opencode/types';
import { startMockOllama } from './mockOllama';

const extensionPath = path.join(__dirname, '..', '..');
const binary = process.env.DRAGON_OPENCODE_BIN ?? resolveBinary({ extensionPath, env: { PATH: '' } });
const MODEL = 'qwen2.5-coder:7b-dragon-32k';

interface ChatMessage {
	readonly role?: string;
	readonly content?: string | readonly { readonly text?: string }[];
}

function contentOf(message: ChatMessage): string {
	return typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n');
}

test('agents message each other: a lead spawns a teammate, it reports back, and the rules hold', { skip: !binary && 'no opencode binary', timeout: 240_000 }, async t => {
	const workspace = mkdtempSync(path.join(tmpdir(), 'dragon-agents-'));
	const home = mkdtempSync(path.join(tmpdir(), 'dragon-home-'));
	const mock = await startMockOllama([{ kind: 'text', chunks: ['No scenario.'] }], MODEL, 0, {
		scenarios: {
			// alpha asks beta, then waits for it.
			ask: [
				{ kind: 'tool', name: 'list_agents', args: {} },
				{ kind: 'tool', name: 'send_message', args: { to: 'beta', message: '[[mock:answer]] What does hello.txt say?' } },
				{ kind: 'tool', name: 'wait_agent', args: { agent: 'beta', timeoutSeconds: 60 } },
				{ kind: 'text', chunks: ['Beta answered.'] },
			],
			answer: [
				{ kind: 'tool', name: 'send_message', args: { to: 'alpha', message: 'It says hello world.' } },
				{ kind: 'text', chunks: ['Replied to alpha.'] },
			],
			// The lead of a team starts a teammate and waits for its report.
			lead: [
				{ kind: 'tool', name: 'spawn_teammate', args: { name: 'Scout', prompt: '[[mock:scout]] Look around and report.' } },
				{ kind: 'tool', name: 'wait_agent', args: { agent: 'scout', timeoutSeconds: 60 } },
				{ kind: 'text', chunks: ['The scout reported.'] },
			],
			scout: [
				{ kind: 'tool', name: 'send_message', args: { to: 'lead', message: 'Nothing to report.' } },
				{ kind: 'text', chunks: ['Reported.'] },
			],
			// An agent without messaging is not offered the tools; calling one anyway is refused.
			outsider: [
				{ kind: 'tool', name: 'send_message', args: { to: 'beta', message: 'Let me in.' } },
				{ kind: 'text', chunks: ['Tried.'] },
			],
		},
	});
	const configFile = path.join(home, 'dragon.json');
	const pluginDir = path.join(home, 'agents-plugin');
	const hubAddress = path.join(home, 'hub.json');
	await writeSearchPlugin(pluginDir, path.join(__dirname, '..', 'agents', 'opencodePlugin.js'), 'agent messaging');
	await writeDragonConfig(configFile, buildDragonConfig({ model: `ollama/${MODEL}`, ollamaOrigin: mock.origin, ollamaModels: [{ name: MODEL, size: 1 }], agentsPluginDir: pluginDir }));
	const logs: string[] = [];
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: workspace, configFile,
		log: line => { logs.push(line); if (process.env.DRAGON_TEST_LOG) { console.error(line); } },
		extraEnv: { DRAGON_AGENTS_HUB: hubAddress },
		env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
	});
	let client: OpenCodeClient;
	const teammates: { id: string; permissions: unknown }[] = [];
	const hub = new AgentHub({
		deliver: async delivery => { await client.synthetic(delivery.recipient.id, { text: delivery.text, description: delivery.description, metadata: delivery.metadata, resume: delivery.wake }); },
		createTeammate: async input => {
			const permissions = input.lead.readOnly ? READ_ONLY_PERMISSIONS : undefined;
			const session = await client.createSession({ directory: input.lead.directory, title: input.name, agent: input.agent ?? 'build', model: { providerID: 'ollama', id: MODEL }, permissions });
			teammates.push({ id: session.id, permissions });
			return { id: session.id, directory: input.lead.directory };
		},
		lastReply: async sessionID => lastAssistantText(await client.messages(sessionID)),
	}, path.join(home, 'agents.json'));
	const controller = new AbortController();
	try {
		client = await server.ensure();
		await hub.listen(hubAddress);
		for (let i = 0; i < 120 && !(await client.models(workspace)).some(m => m.providerID === 'ollama'); i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const create = async (name: string, messaging: 'on' | 'off' | 'muted') => {
			const session = await client.createSession({ directory: workspace, title: name, agent: 'build', model: { providerID: 'ollama', id: MODEL } });
			await hub.register(session.id, { name, directory: workspace, messaging });
			return session.id;
		};

		// One event stream for the whole test, as the extension's session bridge has.
		const seen: OpenCodeEvent[] = [];
		const waiters = new Set<() => void>();
		void (async () => {
			for await (const event of client.events(controller.signal)) {
				seen.push(event);
				hub.observe(event);
				waiters.forEach(w => w());
			}
		})().catch(() => undefined);
		const until = async (what: string, check: () => boolean) => {
			const deadline = Date.now() + 60_000;
			while (!check()) {
				if (Date.now() > deadline) {
					assert.fail(`timed out waiting for ${what}\n${logs.slice(-30).join('\n')}`);
				}
				await new Promise<void>(resolve => { const w = () => { waiters.delete(w); resolve(); }; waiters.add(w); setTimeout(w, 250); });
			}
		};
		const finished = (sessionID: string) => seen.filter(e => e.data.sessionID === sessionID && e.type === 'session.execution.succeeded').length;
		/** What the chat view would show for one session, from every event seen so far. */
		const ops = (sessionID: string): TurnOp[] => {
			const reducer = new TurnReducer(sessionID);
			return seen.flatMap(event => reducer.reduce(event));
		};
		const toolResults = (sessionID: string) => ops(sessionID).flatMap(op => op.kind === 'tool-done' ? [`${op.name}: ${op.output}`] : op.kind === 'tool-error' ? [`${op.name} failed: ${op.message}`] : []);
		const requestsWith = (needle: string) => mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && ((r.body as { messages?: ChatMessage[] }).messages ?? []).some(m => m.role === 'user' && contentOf(m).includes(needle)));

		// 1. Two agents with messaging on: alpha asks, beta wakes on its own and answers.
		const alpha = await create('alpha', 'on');
		const beta = await create('beta', 'on');
		await client.prompt(alpha, { text: '[[mock:ask]] Ask beta what hello.txt says.' });
		await until('alpha and beta to finish', () => finished(alpha) >= 1 && finished(beta) >= 1 && hub.statusOf(alpha) === 'idle' && hub.statusOf(beta) === 'idle');
		const alphaTools = toolResults(alpha);
		t.diagnostic(`alpha: ${JSON.stringify(alphaTools)}`);
		assert.match(alphaTools[0], /^list_agents: - alpha \(ses\w+\): running \[you\]\n- beta \(ses\w+\): idle$/);
		assert.match(alphaTools[1], /^send_message: Message delivered to beta, which is now working on it\./);
		assert.match(alphaTools[2], /^wait_agent: beta is idle\. Its last reply:\n\nReplied to alpha\.$/);
		assert.deepEqual(toolResults(beta), ['send_message: Message delivered to alpha, which is now working on it. Its reply arrives as a message to you; wait_agent waits for it to finish.']);
		// Each model read the other's message wrapped with the sender the hub validated.
		assert.ok(requestsWith(`<agent-message from="alpha" session="${alpha}">\n[[mock:answer]] What does hello.txt say?\n</agent-message>`).length, 'beta\'s model read alpha\'s message');
		assert.ok(requestsWith(`<agent-message from="beta" session="${beta}">\nIt says hello world.\n</agent-message>`).length, 'alpha\'s model read beta\'s reply');
		// The chat view shows the incoming message as a turn of its own, from the sender.
		assert.deepEqual(ops(beta).filter(op => op.kind === 'agent-message'), [{ kind: 'agent-message', from: 'alpha', text: '[[mock:answer]] What does hello.txt say?' }]);

		// 2. An agent with messaging off is not offered the tools, and a call is refused anyway.
		const outsider = await create('outsider', 'off');
		const before = mock.requests.length;
		await client.prompt(outsider, { text: '[[mock:outsider]] Message beta.' });
		await until('the outsider to finish', () => finished(outsider) >= 1);
		const offeredTo = (needle: string) => (requestsWith(needle).at(-1)?.body as { tools?: { function?: { name?: string } }[] }).tools?.map(tool => tool.function?.name) ?? [];
		assert.ok(mock.requests.length > before);
		assert.equal(offeredTo('[[mock:outsider]]').includes('send_message'), false, 'no messaging tools without the chip');
		assert.equal(offeredTo('[[mock:ask]]').includes('send_message'), true);
		t.diagnostic(`outsider: ${JSON.stringify(toolResults(outsider))}`);
		assert.match(toolResults(outsider)[0], /^send_message failed: /);
		assert.equal(finished(beta), 1, 'beta was not woken by an agent without messaging');

		// 3. A stopped agent keeps the message but is not woken.
		await hub.stop(beta);
		const gamma = await create('gamma', 'on');
		assert.match(await hub.call('send_message', gamma, { to: 'beta', message: 'Are you there?' }), /^Message left for beta, but it was not woken: the user stopped it\./);
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.equal(finished(beta), 1, 'a stopped agent does not wake');
		assert.equal(seen.filter(e => e.type === 'session.execution.started' && e.data.sessionID === beta).length, 1);

		// 4. A team: the lead spawns a teammate, which reports back.
		const lead = await create('lead', 'on');
		await hub.setReadOnly(lead, true);
		await hub.createTeam(lead, 'explorers');
		await client.prompt(lead, { text: '[[mock:lead]] Have a scout look around.' });
		await until('the lead and its teammate to finish', () => finished(lead) >= 1 && teammates.length === 1 && finished(teammates[0].id) >= 1 && hub.statusOf(lead) === 'idle');
		const leadTools = toolResults(lead);
		t.diagnostic(`lead: ${JSON.stringify(leadTools)}`);
		assert.match(leadTools[0], /^spawn_teammate: Teammate scout \(ses\w+\) started in read-only mode, like you\./);
		assert.match(leadTools[1], /^wait_agent: scout is idle\. Its last reply:\n\nReported\.$/);
		assert.deepEqual(teammates[0].permissions, READ_ONLY_PERMISSIONS, 'a read-only lead gets a read-only teammate');
		assert.deepEqual({ ...hub.get(teammates[0].id), id: 'x', team: 'x' }, { id: 'x', name: 'scout', directory: workspace, messaging: 'on', readOnly: true, team: 'x', role: 'teammate', wakes: 1 });
		assert.ok(requestsWith('You are "scout", a teammate on the team "explorers", led by "lead".').length, 'the teammate was briefed');
	} finally {
		controller.abort();
		hub.dispose();
		server.dispose();
		await mock.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
