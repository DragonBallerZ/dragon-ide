/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end: agents messaging each other through the real OpenCode binary, the agent messaging
 * plugin and the agent hub, against a scripted Ollama. Skipped when there is no `opencode` binary.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentHub, DEFAULT_LIMITS } from '../agents/hub';
import { lastAssistantReply, lastAssistantText } from '../agents/message';
import { TurnOp, TurnReducer } from '../chat/turn';
import { buildDragonConfig, READ_ONLY_PERMISSIONS, sessionPermissions, writeDragonConfig, writeSearchPlugin } from '../dragonConfig';
import type { OpenCodeClient } from '../opencode/client';
import { OpenCodeServer, resolveBinary } from '../opencode/server';
import type { OpenCodeEvent, PermissionRule } from '../opencode/types';
import { startMockOllama } from './mockOllama';

const extensionPath = path.join(__dirname, '..', '..');
const binary = process.env.DRAGON_OPENCODE_BIN ?? resolveBinary({ extensionPath, env: { PATH: '' } });
const MODEL = 'qwen2.5-coder:7b-dragon-32k';
/** A model OpenCode gives its patch tool in place of write and edit, as it does GPT-5. */
const PATCHING_MODEL = 'gpt-5-dragon-mock';
/** The hub's duplicate window here, short so a message can be sent again past it. */
const DEDUP_WINDOW_MS = 1000;
/** Whether the hub takes file names that differ only in case for one file, as it does off Linux. */
const ignoresCase = process.platform !== 'linux';

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
			// alpha asks beta, then waits for it: first longer than OpenCode's fetch of the hub lasts.
			ask: [
				{ kind: 'tool', name: 'list_agents', args: {} },
				{ kind: 'tool', name: 'send_message', args: { to: 'beta', message: '[[mock:answer]] What does hello.txt say?', files: ['answer.txt'] } },
				{ kind: 'tool', name: 'wait_agent', args: { agent: 'beta', timeoutSeconds: 600 } },
				{ kind: 'tool', name: 'wait_agent', args: { agent: 'beta', timeoutSeconds: 60 } },
				{ kind: 'text', chunks: ['Beta answered.'] },
			],
			// beta writes its answer to a file too, which alpha is then told it changed.
			answer: [
				{ kind: 'tool', name: 'write', args: { path: 'answer.txt', content: 'hello world\n' } },
				{ kind: 'tool', name: 'send_message', args: { to: 'alpha', message: 'It says hello world.' } },
				{ kind: 'text', chunks: ['Replied to alpha.'] },
			],
			// Another agent tries to change the file alpha gave beta, also by a name in other letters where the disk ignores case.
			intrude: [
				{ kind: 'tool', name: 'write', args: { path: 'answer.txt', content: 'overwritten\n' } },
				...ignoresCase ? [{ kind: 'tool', name: 'write', args: { path: 'Answer.TXT', content: 'overwritten\n' } } as const] : [],
				{ kind: 'text', chunks: ['Tried.'] },
			],
			// Another agent, on a model that changes files only with the patch tool, tries the same.
			'intrude-patch': [
				{ kind: 'tool', name: 'patch', args: { patchText: '*** Begin Patch\n*** Update File: answer.txt\n@@\n-hello world\n+patched\n*** End Patch' } },
				{ kind: 'text', chunks: ['Tried to patch.'] },
			],
			// Another agent has a subagent try it: the subagent's child session asks the mock with this prompt.
			delegate: [
				{ kind: 'tool', name: 'subagent', args: { agent: 'general', description: 'Rewrite answer.txt', prompt: '[[mock:intrude]] Rewrite answer.txt.' } },
				{ kind: 'text', chunks: ['Delegated.'] },
			],
			// beta names the file it was given in a message to another agent, then writes it again.
			relist: [
				{ kind: 'tool', name: 'send_message', args: { to: 'quiet', message: 'answer.txt is mine.', files: ['answer.txt'] } },
				{ kind: 'tool', name: 'write', args: { path: 'answer.txt', content: 'hello again\n' } },
				{ kind: 'text', chunks: ['Kept it.'] },
			],
			// An agent given level.txt reads the file given out with it, then writes its own.
			fit: [
				{ kind: 'tool', name: 'read', args: { path: 'answer.txt' } },
				{ kind: 'tool', name: 'write', args: { path: 'level.txt', content: 'level one\n' } },
				{ kind: 'text', chunks: ['Fitted.'] },
			],
			// An agent looks around before it answers, and is slow to answer.
			dig: [
				{ kind: 'tool', name: 'glob', args: { pattern: '**/*.txt' } },
				{ kind: 'tool', name: 'read', args: { path: 'answer.txt' } },
				{ kind: 'text', chunks: ['Still', ' digging.'], pause: 4000 },
			],
			// The lead of a team starts a teammate and waits for its report, naming it as send_message
			// does, as Nemotron did: OpenCode drops a key the tool's schema does not have.
			lead: [
				{ kind: 'tool', name: 'spawn_teammate', args: { name: 'Scout', prompt: '[[mock:scout]] Look around and report.' } },
				{ kind: 'tool', name: 'wait_agent', args: { to: 'scout', timeoutSeconds: 60 } },
				{ kind: 'text', chunks: ['The scout reported.'] },
			],
			scout: [
				{ kind: 'tool', name: 'send_message', args: { to: 'lead', message: 'Nothing to report.' } },
				{ kind: 'text', chunks: ['Reported.'] },
			],
			// An agent names the level; asked next for a file, its turn ends with reasoning and no text,
			// as agent-3's did on Nemotron in a team-demo run.
			name: [{ kind: 'text', chunks: ['The Starting Grounds'] }],
			muse: [{ kind: 'text', chunks: [], reasoning: ['game.js should draw the hero on the canvas.'] }],
			// Asked again, it answers in the very words it thought, as agent-3 did in another run.
			echo: [{ kind: 'text', chunks: ['The user is asking me', ' to name the level.'], reasoning: ['The user is asking me to name the level.\n'] }],
			// The provider refuses an agent's request, as Zen's free Nemotron did, rate-limited, in team-demo
			// runs. Not as a rate limit: OpenCode retried one from this mock ten times, for 89 seconds.
			limited: [{ kind: 'fail', status: 400, message: 'The request was refused.' }],
			// A lead asks an agent and waits for it; the agent looks around, answers, then waits for the lead,
			// as agent-2 did on Nemotron in a team-demo run while main waited for it: both waits ran out.
			convene: [
				{ kind: 'tool', name: 'send_message', args: { to: 'helper', message: '[[mock:reply-wait]] Name the hero.' } },
				{ kind: 'tool', name: 'wait_agent', args: { agent: 'helper', timeoutSeconds: 15 } },
				{ kind: 'text', chunks: ['Heard.'] },
			],
			'reply-wait': [
				{ kind: 'tool', name: 'glob', args: { pattern: '**/*.txt' } },
				{ kind: 'tool', name: 'send_message', args: { to: 'chief', message: 'Ignis.' } },
				{ kind: 'tool', name: 'wait_agent', args: { agent: 'chief', timeoutSeconds: 15 } },
				{ kind: 'text', chunks: ['Named.'] },
			],
			// Set to work by another agent, an agent asks the user, as agent-2 did main's work on Nemotron
			// in a team-demo run: its turn waited on the question while main's waits for it ran out.
			'ask-user': [
				{ kind: 'tool', name: 'question', args: { questions: [{ question: 'Is the title ready?', header: 'Ready', options: [{ label: 'Yes', description: 'Keep it' }, { label: 'No', description: 'Change it' }], multiple: false }] } },
				{ kind: 'text', chunks: ['Titled.'] },
			],
			// A teammate made for a role (/create-agent) does what the lead sends it.
			art: [{ kind: 'text', chunks: ['Drawn.'] }],
			// An agent without messaging is not offered the tools; calling one anyway is refused.
			outsider: [
				{ kind: 'tool', name: 'send_message', args: { to: 'beta', message: 'Let me in.' } },
				{ kind: 'text', chunks: ['Tried.'] },
			],
			// A chat the user opened runs another they opened.
			// With a blank file, as Nemotron sent for a message that gave none: it goes, with no file.
			lone: [
				{ kind: 'tool', name: 'send_message', args: { to: 'fresh', message: '[[mock:fresh]] Report in.', files: [''] } },
				{ kind: 'text', chunks: ['Sent.'] },
			],
			// fresh answers only in its own chat; the hub sends the answer to lone.
			fresh: [{ kind: 'text', chunks: ['[[mock:thanks]] Fresh here.'] }],
			thanks: [{ kind: 'text', chunks: ['Thanks, fresh.'] }],
		},
	});
	const configFile = path.join(home, 'dragon.json');
	const pluginDir = path.join(home, 'agents-plugin');
	const hubAddress = path.join(home, 'hub.json');
	await writeSearchPlugin(pluginDir, path.join(__dirname, '..', 'agents', 'opencodePlugin.js'), 'agent messaging');
	await writeDragonConfig(configFile, buildDragonConfig({ model: `ollama/${MODEL}`, ollamaOrigin: mock.origin, ollamaModels: [{ name: MODEL, size: 1 }, { name: PATCHING_MODEL, size: 1 }], agentsPluginDir: pluginDir }));
	const logs: string[] = [];
	const server = new OpenCodeServer({
		configuredBinary: binary, extensionPath, cwd: workspace, configFile,
		log: line => { logs.push(line); if (process.env.DRAGON_TEST_LOG) { console.error(line); } },
		extraEnv: { DRAGON_AGENTS_HUB: hubAddress },
		env: { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache') },
	});
	let client: OpenCodeClient;
	const teammates: { id: string; permissions: readonly unknown[] }[] = [];
	/** The chats open in the IDE, as the extension tells the hub before each answer; unknown until set. */
	let openChats: string[] | undefined;
	const hub = new AgentHub({
		deliver: async delivery => { await client.synthetic(delivery.recipient.id, { text: delivery.text, description: delivery.description, metadata: delivery.metadata, resume: delivery.wake }); },
		createTeammate: async input => {
			// As the extension makes a teammate's session (`AgentManager.createTeammate`).
			const permissions = sessionPermissions(!!input.lead.readOnly, true);
			const session = await client.createSession({ directory: input.lead.directory, title: input.name, agent: input.agent ?? 'build', model: { providerID: 'ollama', id: MODEL }, permissions });
			teammates.push({ id: session.id, permissions });
			return { id: session.id, directory: input.lead.directory };
		},
		lastReply: async (sessionID, since) => lastAssistantReply(await client.messages(sessionID), since),
		sync: async () => {
			if (openChats) {
				await hub.setOpen(openChats);
			}
		},
	}, path.join(home, 'agents.json'), { ...DEFAULT_LIMITS, dedupWindowMs: DEDUP_WINDOW_MS });
	const controller = new AbortController();
	try {
		client = await server.ensure();
		await hub.listen(hubAddress);
		for (let i = 0; i < 120 && !(await client.models(workspace)).some(m => m.providerID === 'ollama'); i++) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const create = async (name: string, messaging: 'on' | 'off' | 'muted', permissions?: readonly PermissionRule[], model = MODEL) => {
			const session = await client.createSession({ directory: workspace, title: name, agent: 'build', model: { providerID: 'ollama', id: model }, permissions });
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
		// beta may write files without asking, as under Full Access.
		const beta = await create('beta', 'on', [{ action: 'edit', resource: '*', effect: 'allow' }]);
		await client.prompt(alpha, { text: '[[mock:ask]] Ask beta what hello.txt says.' });
		await until('alpha and beta to finish', () => finished(alpha) >= 1 && finished(beta) >= 1 && hub.statusOf(alpha) === 'idle' && hub.statusOf(beta) === 'idle');
		const alphaTools = toolResults(alpha);
		t.diagnostic(`alpha: ${JSON.stringify(alphaTools)}`);
		assert.match(alphaTools[0], /^list_agents: - alpha \(ses\w+\): running \[you\]\n- beta \(ses\w+\): idle$/);
		assert.match(alphaTools[1], /^send_message: Message delivered to beta, which is now working on it\./);
		assert.match(alphaTools[2], /^wait_agent failed: Invalid arguments for tool "wait_agent":\n- timeoutSeconds: Expected a value less than or equal to 300\n/);
		assert.match(alphaTools[3], /^wait_agent: beta is idle\. Its last reply:\n\nReplied to alpha\.$/);
		// beta answers alpha, whose message woke it, so it is not told to wait for alpha.
		assert.deepEqual(toolResults(beta).slice(1), ['send_message: Answer delivered to alpha, whose message woke you. Do not wait for alpha: finish your turn. If it writes back, its message starts a new turn for you.']);
		assert.match(toolResults(beta)[0], /^write: /);
		// Each model read the other's message wrapped with the sender the hub validated.
		const given = '\n\nThe files that are yours to change: answer.txt. Other agents are kept from changing them until the user\'s next message.';
		assert.ok(requestsWith(`<agent-message from="alpha" session="${alpha}">\n[[mock:answer]] What does hello.txt say?${given}\n</agent-message>`).length, 'beta\'s model read alpha\'s message');
		assert.ok(requestsWith(`<agent-message from="beta" session="${beta}">\nIt says hello world.\n</agent-message>`).length, 'alpha\'s model read beta\'s reply');
		// The chat view shows the incoming message as a turn of its own, from the sender.
		assert.deepEqual(ops(beta).filter(op => op.kind === 'agent-message'), [{ kind: 'agent-message', from: 'alpha', text: `[[mock:answer]] What does hello.txt say?${given}` }]);
		// Every request of an agent with messaging on says who it can message, without a list_agents call.
		assert.ok(requestsWith('You are "alpha". Other agents you can message with send_message (to: the name):\n- beta: idle').length, 'alpha\'s model was told about beta');
		// Once beta has written its file, alpha is told so, from OpenCode's own events.
		assert.ok(requestsWith('- beta: idle; given answer.txt to change; changed answer.txt since the user\'s last message\n').length, 'alpha\'s model was told the file beta changed');
		// And to send every agent making a part of one thing its part before it waits for any of them.
		assert.ok(requestsWith('then send each of them its part with the same list before you wait for any of them: an agent working alone makes the whole thing.').length, 'alpha\'s model was told to send every part before it waits');

		// 1b. Another agent's write to the file alpha gave beta is refused before it runs, through
		// OpenCode's execute.before hook, and the file is left as beta wrote it.
		const intruder = await create('intruder', 'on', [{ action: 'edit', resource: '*', effect: 'allow' }]);
		await client.prompt(intruder, { text: '[[mock:intrude]] Rewrite answer.txt.' });
		await until('the intruder to finish', () => finished(intruder) >= 1 && hub.statusOf(intruder) === 'idle');
		t.diagnostic(`intruder: ${JSON.stringify(toolResults(intruder))}`);
		assert.deepEqual({ intruder: toolResults(intruder), file: readFileSync(path.join(workspace, 'answer.txt'), 'utf8'), said: lastAssistantText(await client.messages(intruder)) }, {
			intruder: ['answer.txt', ...ignoresCase ? ['Answer.TXT'] : []].map(name => `write failed: ${name} is beta's to change: alpha gave it to beta. Leave it to beta: send beta what it needs, or ask alpha.`),
			file: 'hello world\n',
			said: 'Tried.',
		});
		// A subagent changes files as the agent that started it.
		const delegator = await create('delegator', 'on', [{ action: 'edit', resource: '*', effect: 'allow' }]);
		await client.prompt(delegator, { text: '[[mock:delegate]] Have a subagent rewrite answer.txt.' });
		await until('the delegator to finish', () => finished(delegator) >= 1 && hub.statusOf(delegator) === 'idle');
		const subagent = String(seen.find(event => event.type === 'session.created' && event.data.parentID === delegator)?.data.sessionID);
		t.diagnostic(`delegator: ${JSON.stringify(toolResults(delegator))}; subagent: ${JSON.stringify(toolResults(subagent))}`);
		assert.deepEqual({ subagent: toolResults(subagent), file: readFileSync(path.join(workspace, 'answer.txt'), 'utf8') }, {
			subagent: ['answer.txt', ...ignoresCase ? ['Answer.TXT'] : []].map(name => `write failed: ${name} is beta's to change: alpha gave it to beta. Leave it to beta: send beta what it needs, or ask alpha.`),
			file: 'hello world\n',
		});
		const patcher = await create('patcher', 'on', [{ action: 'edit', resource: '*', effect: 'allow' }], PATCHING_MODEL);
		await client.prompt(patcher, { text: '[[mock:intrude-patch]] Patch answer.txt.' });
		await until('the patcher to finish', () => finished(patcher) >= 1 && hub.statusOf(patcher) === 'idle');
		t.diagnostic(`patcher: ${JSON.stringify(toolResults(patcher))}`);
		assert.deepEqual({ patcher: toolResults(patcher), file: readFileSync(path.join(workspace, 'answer.txt'), 'utf8') }, {
			patcher: ['patch failed: answer.txt is beta\'s to change: alpha gave it to beta. Leave it to beta: send beta what it needs, or ask alpha.'],
			file: 'hello world\n',
		});

		// 1c. Listed by beta in a message to another agent, the file alpha gave beta stays beta's, and beta writes it again.
		await create('quiet', 'muted');
		await client.prompt(beta, { text: '[[mock:relist]] Tell quiet whose file answer.txt is.' });
		await until('beta to finish again', () => finished(beta) >= 2 && hub.statusOf(beta) === 'idle');
		t.diagnostic(`beta: ${JSON.stringify(toolResults(beta).slice(2))}`);
		assert.deepEqual({ beta: toolResults(beta).slice(2).map(result => result.split('\n')[0]), file: readFileSync(path.join(workspace, 'answer.txt'), 'utf8') }, {
			beta: [
				'send_message: Message left for quiet, but it was not woken: it is muted. It reads the message when the user next continues it. Do not send it again. answer.txt stays yours, as alpha gave it to you: list in files only what quiet is to change.',
				'write: Wrote file successfully: answer.txt',
			],
			file: 'hello again\n',
		});

		// 1d. A lead whose wait runs out is told the tool calls the agent made in its turn, from OpenCode's own events.
		const digger = await create('digger', 'on');
		await client.prompt(digger, { text: '[[mock:dig]] Name the first level.' });
		await until('the digger to make its calls', () => seen.filter(e => e.data.sessionID === digger && e.type === 'session.tool.success').length >= 2);
		const waited = await hub.call('wait_agent', alpha, { agent: 'digger', timeoutSeconds: 1 });
		// A message sent to it while it works says so, with the same calls, and reaches it at its next step.
		const nudged = await hub.call('send_message', alpha, { to: 'digger', message: 'Make the name up.' });
		await until('the digger to finish', () => finished(digger) >= 1 && hub.statusOf(digger) === 'idle' && requestsWith('Make the name up.').length > 0);
		assert.deepEqual({ waited, nudged }, {
			waited: 'digger is still running after 1 seconds. In this turn it has made 2 tool calls: glob (**/*.txt); read (answer.txt). A message to it reaches it at its next step: if it is not doing what you asked, send it what it is missing.',
			nudged: 'Message delivered to digger, which was already working: it reads the message at its next step. In this turn it has made 2 tool calls: glob (**/*.txt); read (answer.txt). Its reply arrives as a message to you; wait_agent waits for it to finish.',
		});

		// 1e. An agent given a file is told, until it reads it, that the file given out with its own changed.
		const fitter = await create('fitter', 'muted', [{ action: 'edit', resource: '*', effect: 'allow' }]);
		await hub.call('send_message', alpha, { to: 'fitter', message: 'Write level.txt.', files: ['level.txt'] });
		await client.prompt(fitter, { text: '[[mock:fit]] Write level.txt to fit answer.txt.' });
		await until('the fitter to finish', () => finished(fitter) >= 1 && hub.statusOf(fitter) === 'idle');
		const fitterRequests = requestsWith('[[mock:fit]]').map(r => ((r.body as { messages?: ChatMessage[] }).messages ?? []).filter(m => m.role === 'user' && contentOf(m).startsWith('<system-reminder>\nYou are')).map(contentOf).join(''));
		assert.deepEqual(fitterRequests.map(roster => roster.includes('Changed since you last read it: beta\'s answer.txt, which alpha gave out with your level.txt. Read it now, and make level.txt fit the names it uses (files, element ids, functions) before you reply.')), [true, false, false]);

		// 1f. A lead waiting for an agent whose turn on its message ended with no text is told so, not
		// given the agent's reply to its earlier message, which main took for the new answer in that run.
		const namer = await create('namer', 'on');
		// level.txt, given to the fitter above, moves to the namer: alpha is told the fitter can no longer change it.
		const moved = await hub.call('send_message', alpha, { to: 'namer', message: '[[mock:name]] Name the level.', files: ['level.txt'] });
		const named = await hub.call('wait_agent', alpha, { agent: 'namer', timeoutSeconds: 60 });
		await hub.call('send_message', alpha, { to: 'namer', message: '[[mock:muse]] Write game.js.' });
		const mused = await hub.call('wait_agent', alpha, { agent: 'namer', timeoutSeconds: 60 });
		// A reply in the words its model thought, as OpenCode stores it, is said to be maybe no answer.
		await hub.call('send_message', alpha, { to: 'namer', message: '[[mock:echo]] Name the level, in one line.' });
		const echoed = await hub.call('wait_agent', alpha, { agent: 'namer', timeoutSeconds: 60 });
		assert.deepEqual({ moved: moved.slice(moved.indexOf(' level.txt was') + 1), named, mused, echoed, turns: finished(namer), said: lastAssistantText(await client.messages(namer)) }, {
			moved: 'level.txt was fitter\'s: it is namer\'s now, so fitter can no longer change it.',
			named: 'namer is idle. Its last reply:\n\nThe Starting Grounds',
			mused: 'namer is idle and has not replied since your last message to it. It made no tool calls in its last turn. If you still need its answer, send it a new message saying what you need.',
			echoed: 'namer is idle. Its last reply:\n\nThe user is asking me to name the level.\n\nnamer wrote this word for word as its thinking first, so it may be that thinking and no answer. If it does not answer you, send namer a new message asking again for what you need.',
			turns: 3,
			said: 'The user is asking me to name the level.',
		});

		// 1g. A lead is told the error an agent's turn stopped with, from OpenCode's own event.
		const limited = await create('limited', 'on');
		await hub.call('send_message', alpha, { to: 'limited', message: '[[mock:limited]] Name the hero.' });
		const stopped = await hub.call('wait_agent', alpha, { agent: 'limited', timeoutSeconds: 120 });
		t.diagnostic(`limited: ${stopped}`);
		assert.match(stopped, /^limited is idle and has not replied since your last message to it\. Its last turn stopped with an error: .*The request was refused\..* It made no tool calls in its last turn\./);
		assert.equal(seen.filter(e => e.data.sessionID === limited && e.type === 'session.execution.failed').length, 1);

		// 1h. The same message again past the duplicate window is refused while the agent is at it and
		// once it has answered, as main sent agent-3 its question again on Nemotron in a team-demo run,
		// two seconds after agent-3 had answered it, and agent-3 answered it again in a turn of three minutes.
		const repeater = await create('repeater', 'on');
		const question = '[[mock:dig]] Name the first level.';
		await hub.call('send_message', alpha, { to: 'repeater', message: question });
		await until('the repeater to make its calls', () => seen.filter(e => e.data.sessionID === repeater && e.type === 'session.tool.success').length >= 2);
		await new Promise(resolve => setTimeout(resolve, DEDUP_WINDOW_MS + 200));
		const working = await hub.call('send_message', alpha, { to: 'repeater', message: question });
		await until('the repeater to finish', () => finished(repeater) >= 1 && hub.statusOf(repeater) === 'idle');
		const answered = await hub.call('send_message', alpha, { to: 'repeater', message: question });
		await new Promise(resolve => setTimeout(resolve, 1500));
		const once = { turns: finished(repeater), started: seen.filter(e => e.data.sessionID === repeater && e.type === 'session.execution.started').length };
		// Asked by the user, alpha may send it again.
		await hub.humanTurn(alpha);
		const askedAgain = await hub.call('send_message', alpha, { to: 'repeater', message: question });
		if (askedAgain.startsWith('Message delivered')) {
			await until('the repeater to finish again', () => finished(repeater) >= 2 && hub.statusOf(repeater) === 'idle');
		}
		assert.deepEqual({ working, answered, once, askedAgain, turns: finished(repeater) }, {
			working: 'repeater already has this exact message from you, so it was not sent. It is working: wait_agent waits for it to finish.',
			answered: 'repeater already has this exact message from you, so it was not sent. It is idle. Its last reply:\n\nStill digging.\n\nDo not send the message again: answer what it said, or send something new.',
			once: { turns: 1, started: 1 },
			askedAgain: 'Message delivered to repeater, which is now working on it. Its reply arrives as a message to you; wait_agent waits for it to finish.',
			turns: 2,
		});

		// 1i. A lead does not hand on a file it gave an agent still at work and not heard from since, as
		// Nemotron as lead gave index.html to agent-1 and then, in the same step, to agent-2 in a team-demo
		// run, and agent-1 was refused its write. Sent at once, the first message may still be going out.
		const builder = await create('builder', 'on');
		const painter = await create('painter', 'on');
		const page = '[[mock:dig]] Write page.txt.';
		const [built, painted] = await Promise.all([
			hub.call('send_message', alpha, { to: 'builder', message: page, files: ['page.txt'] }),
			hub.call('send_message', alpha, { to: 'painter', message: page, files: ['page.txt'] }).catch((err: Error) => `refused: ${err.message}`),
		]);
		await until('the builder to finish', () => finished(builder) >= 1 && hub.statusOf(builder) === 'idle');
		const handedOn = await hub.call('send_message', alpha, { to: 'painter', message: page, files: ['page.txt'] });
		await until('the painter to finish', () => finished(painter) >= 1 && hub.statusOf(painter) === 'idle');
		const startedBy = (session: string) => seen.filter(e => e.data.sessionID === session && e.type === 'session.execution.started').length;
		assert.deepEqual({ built, painted, handedOn: handedOn.slice(handedOn.indexOf(' page.txt was') + 1), turns: { builder: startedBy(builder), painter: startedBy(painter) } }, {
			built: 'Message delivered to builder, which is now working on it. Its reply arrives as a message to you; wait_agent waits for it to finish. Other agents\' write and edit calls on page.txt are refused until the user\'s next message.',
			painted: 'refused: Nothing was sent to painter. You gave page.txt to builder, which is still working and has not answered you since: it is builder\'s to change. Send painter your message again with only the files that are its to change in files. To give painter page.txt instead, first wait for builder with wait_agent.',
			handedOn: 'page.txt was builder\'s: it is painter\'s now, so builder can no longer change it.',
			turns: { builder: 1, painter: 1 },
		});

		// 1j. An agent is refused a wait for its lead while the lead waits for it, so it finishes and the
		// lead's wait returns its answer at once, not when both waits have run out.
		const chief = await create('chief', 'on');
		const helper = await create('helper', 'on');
		const convened = Date.now();
		await client.prompt(chief, { text: '[[mock:convene]] Ask helper to name the hero.' });
		await until('the chief and the helper to finish', () => finished(chief) >= 1 && finished(helper) >= 1 && hub.statusOf(chief) === 'idle' && hub.statusOf(helper) === 'idle');
		const took = Date.now() - convened;
		t.diagnostic(`chief: ${JSON.stringify(toolResults(chief))}; helper: ${JSON.stringify(toolResults(helper))}; ${took} ms`);
		assert.deepStrictEqual({ chief: toolResults(chief), helper: toolResults(helper).slice(1), beforeAWaitRanOut: took < 15_000 }, {
			chief: [
				'send_message: Message delivered to helper, which is now working on it. Its reply arrives as a message to you; wait_agent waits for it to finish.',
				'wait_agent: helper is idle. Its last reply:\n\nNamed.',
			],
			helper: [
				'send_message: Answer delivered to chief, whose message woke you. Do not wait for chief: finish your turn. If it writes back, its message starts a new turn for you.',
				'wait_agent failed: chief is waiting for you with wait_agent, so chief cannot finish before you do: waiting for it would only run out. Finish your turn instead: its wait then ends with your answer. A message you send chief is read when its wait ends.',
			],
			beforeAWaitRanOut: true,
		});

		// 1k. An agent another agent's message set to work is refused a question to the user, so its turn
		// goes on and the answer reaches the sender.
		const asker = await create('asker', 'on');
		await hub.call('send_message', chief, { to: 'asker', message: '[[mock:ask-user]] Title the game.' });
		const formOf = (session: string) => ops(session).flatMap(op => op.kind === 'form' ? [op.formID] : []);
		await until('the asker to finish or ask', () => (finished(asker) >= 1 && hub.statusOf(asker) === 'idle') || formOf(asker).length > 0);
		// Asked, it would wait for an answer for good: the question is dismissed so the test can go on.
		const asked = formOf(asker);
		for (const formID of asked) {
			await client.cancelForm(asker, formID);
		}
		const ends = (session: string) => seen.filter(e => e.data.sessionID === session && /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type)).map(e => e.type.slice('session.execution.'.length));
		await until('the asker to end its turn', () => ends(asker).length >= 1 && hub.statusOf(asker) === 'idle');
		const titled = `<agent-message from="asker" session="${asker}">\nTitled.\n</agent-message>`;
		if (!asked.length) {
			await until('the chief to read the answer', () => requestsWith(titled).length > 0 && hub.statusOf(chief) === 'idle');
		}
		t.diagnostic(`asker: ${JSON.stringify(toolResults(asker))}; its turn ${ends(asker).join(', ')}`);
		assert.deepStrictEqual({ asked: asked.length, asker: toolResults(asker), answered: requestsWith(titled).length > 0 }, {
			asked: 0,
			asker: ['question failed: chief\'s message started this turn, and chief is waiting for your answer: a question to the user would hold the turn until someone answered it. Do not ask the user. Finish what chief asked, then end your turn with your answer; if something needs deciding, put the question to chief in that answer.'],
			answered: true,
		});

		// 2. An agent with messaging off is not offered the tools, and a call is refused anyway.
		const outsider = await create('outsider', 'off');
		const before = mock.requests.length;
		await client.prompt(outsider, { text: '[[mock:outsider]] Message beta.' });
		await until('the outsider to finish', () => finished(outsider) >= 1);
		const offeredTo = (needle: string) => (requestsWith(needle).at(-1)?.body as { tools?: { function?: { name?: string } }[] }).tools?.map(tool => tool.function?.name) ?? [];
		assert.ok(mock.requests.length > before);
		assert.equal(offeredTo('[[mock:outsider]]').includes('send_message'), false, 'no messaging tools without the chip');
		assert.equal(offeredTo('[[mock:ask]]').includes('send_message'), true);
		// OpenCode sends the model the tool as the plugin describes it.
		const described = (requestsWith('[[mock:ask]]').at(-1)?.body as { tools?: { function?: { name?: string; description?: string } }[] }).tools?.find(tool => tool.function?.name === 'send_message')?.function?.description ?? '';
		assert.ok(described.includes('send every one of them the same names the parts share (files, element ids, functions), and list the files each is to change in files.'), described);
		t.diagnostic(`outsider: ${JSON.stringify(toolResults(outsider))}`);
		assert.match(toolResults(outsider)[0], /^send_message failed: /);
		// beta's two turns are its answer to alpha (1) and the file it kept (1c).
		assert.equal(finished(beta), 2, 'beta was not woken by an agent without messaging');
		const told = (needle: string) => requestsWith(needle).filter(r => ((r.body as { messages?: ChatMessage[] }).messages ?? []).some(m => m.role === 'user' && contentOf(m).startsWith('<system-reminder>\nYou are')));
		assert.deepEqual(told('[[mock:outsider]]'), [], 'an agent without messaging is not told who it could message');

		// 3. A stopped agent keeps the message but is not woken.
		await hub.stop(beta);
		const gamma = await create('gamma', 'on');
		assert.match(await hub.call('send_message', gamma, { to: 'beta', message: 'Are you there?' }), /^Message left for beta, but it was not woken: the user stopped it\./);
		await new Promise(resolve => setTimeout(resolve, 1500));
		assert.equal(finished(beta), 2, 'a stopped agent does not wake');
		assert.equal(seen.filter(e => e.type === 'session.execution.started' && e.data.sessionID === beta).length, 2);

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
		assert.deepEqual(teammates[0].permissions?.slice(0, READ_ONLY_PERMISSIONS.length), READ_ONLY_PERMISSIONS, 'a read-only lead gets a read-only teammate');
		assert.deepEqual({ ...hub.get(teammates[0].id), id: 'x', team: 'x' }, { id: 'x', name: 'scout', directory: workspace, messaging: 'on', readOnly: true, team: 'x', role: 'teammate', wakes: 1 });
		assert.ok(requestsWith('You are "scout", a teammate on the team "explorers", led by "lead".').length, 'the teammate was briefed');
		assert.ok(requestsWith('You are "lead", the lead of the team "explorers". Your teammates:\n- scout: ').length, 'the lead\'s model was told about its teammate');
		assert.ok(requestsWith('You are "scout", a teammate on the team "explorers", led by "lead". Do what your lead sends you').length, 'the teammate\'s model was told who leads it');
		// Once it has reported, its next step is told to end its turn, not to report again.
		assert.ok(requestsWith('You are "scout", a teammate on the team "explorers", led by "lead". You have sent "lead" your report in this turn. Do not send it again: end your turn now.').length, 'the teammate\'s model was told it had reported');

		// 5. A teammate made for a role (/create-agent) is told its part with each request, and the lead sees it.
		const artist = await hub.addRole(lead, 'Artist', 'Draws the pixel-art sprites.');
		assert.match(await hub.call('send_message', lead, { to: 'artist', message: '[[mock:art]] Draw the hero.' }), /^Message delivered to artist, which is now working on it\./);
		// The artist answers in its own chat only; its answer reaches the lead as a message from it.
		const drawn = `<agent-message from="artist" session="${artist.id}">\nDrawn.\n</agent-message>`;
		await until('the artist\'s answer to reach the lead', () => finished(artist.id) >= 1 && requestsWith(drawn).length > 0 && hub.statusOf(lead) === 'idle');
		await client.prompt(lead, { text: 'Who is on the team now?' });
		await until('the lead to answer', () => requestsWith('Who is on the team now?').length > 0 && hub.statusOf(lead) === 'idle');
		assert.ok(requestsWith('You are "artist", a teammate on the team "explorers", led by "lead". Your part: Draws the pixel-art sprites. Do what your lead sends you').length, 'the artist\'s model was told its part');
		assert.ok(requestsWith('- artist (Draws the pixel-art sprites.): idle').length, 'the lead\'s model was told the artist\'s part');
		// A teammate asks its lead, not the user: it is not offered the question tool, and the lead is.
		assert.deepEqual({ lead: offeredTo('Who is on the team now?').includes('question'), artist: offeredTo('[[mock:art]]').includes('question') }, { lead: true, artist: false });

		// 6. The hub asks which chats are open before it answers: a chat the user opened, whose messaging
		// is off only by the earlier default, is offered the tools, is told only about the chat opened
		// just before its request (not the agents above, whose chats are closed), and runs it.
		const lone = await create('lone', 'off');
		const fresh = await create('fresh', 'on');
		openChats = [lone, fresh];
		await client.prompt(lone, { text: '[[mock:lone]] Message the chat I opened.' });
		// fresh never writes to lone: the hub sends lone the answer fresh's turn ended with, and lone's
		// turn on it does not wake fresh again.
		const answer = `<agent-message from="fresh" session="${fresh}">\n[[mock:thanks]] Fresh here.\n</agent-message>`;
		try {
			await until('fresh\'s answer to reach lone', () => finished(fresh) >= 1 && requestsWith(answer).length > 0 && hub.statusOf(lone) === 'idle' && hub.statusOf(fresh) === 'idle');
			await new Promise(resolve => setTimeout(resolve, 1500));
		} finally {
			// Shown also when the message never went: its refusal says which layer refused it.
			t.diagnostic(`lone: ${JSON.stringify(toolResults(lone))}`);
		}
		assert.deepEqual({
			offered: offeredTo('[[mock:lone]]').includes('send_message'),
			told: requestsWith('You are "lone". Other agents you can message with send_message (to: the name):\n- fresh: idle\nThey see only the messages you send them, not this chat: say what the work is for, what you want back and which files are its to change, and answer their questions with send_message.\n\nWhen agents each make a part of one thing').length > 0,
			sent: toolResults(lone)[0]?.startsWith('send_message: Message delivered to fresh'),
			freshRead: requestsWith(`<agent-message from="lone" session="${lone}">\n[[mock:fresh]] Report in.\n</agent-message>`).length > 0,
			mode: hub.get(lone)?.messaging,
			loneSaid: lastAssistantText(await client.messages(lone)),
			freshTurns: finished(fresh),
		}, { offered: true, told: true, sent: true, freshRead: true, mode: 'on', loneSaid: 'Thanks, fresh.', freshTurns: 1 });
	} finally {
		controller.abort();
		hub.dispose();
		server.dispose();
		await mock.close();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});
