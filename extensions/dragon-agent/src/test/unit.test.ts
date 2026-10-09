/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { featuredIntegrations, pickDefaultModel, sortModels } from '../catalog';
import { failureMessage, reversePatch, ShownMessages, TurnNotes, TurnOp, TurnReducer, TurnYield } from '../chat/turn';
import { buildInlinePrompt, extractCode, reindent } from '../chat/inline';
import { OpenQuestions } from '../chat/openQuestions';
import { FileReference, filesToSend } from '../chat/references';
import { RunningCommands } from '../chat/runningCommands';
import { buildFimRequest, complete, isMidLine, postProcess } from '../completions/fim';
import { startMockOllama } from './mockOllama';
import { describePermission, lastOutputLine, permissionDecision, presentTool, runningCommandMessage, shellTimeout, skippedMessage } from '../chat/toolPresentation';
import { buildDragonConfig, confinementConfig, confinementEnv, confinesToFolders, parseAutoCompactAt, PermissionMode } from '../dragonConfig';
import { basicAuth, formatModelRef, isNotFound, OpenCodeClient, OpenCodeHttpError, parseModelRef } from '../opencode/client';
import { cliFailure, openCodeLogDirectory, readCliFailure } from '../opencode/logs';
import { binaryCandidates, OpenCodeServer, parseListenLine, resolveBinary, serverEnv, tuiArgs } from '../opencode/server';
import { SseParser } from '../opencode/sse';
import type { IntegrationInfo, ModelInfo, OpenCodeEvent, PermissionRule } from '../opencode/types';
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

test('a failed turn says what to do when the model provider refused it: no account, a usage limit or a rate limit', () => {
	assert.deepStrictEqual([
		// As OpenCode reported the free Nemotron's limit, and a plain 429 from the test model.
		failureMessage({ type: 'provider.quota', message: 'Rate limit exceeded. Please try again later.', status: 429 }),
		failureMessage({ type: 'provider.rate-limit', message: 'Rate limit exceeded. Please try again later.', status: 429 }),
		failureMessage({ type: 'provider.auth', message: 'nope' }),
		failureMessage({ type: 'provider.internal', message: 'Streaming response failed: [504] Upstream idle timeout exceeded ' }),
		failureMessage(undefined),
	], [
		'Rate limit exceeded. Please try again later.\n\nThe model provider says this model\'s usage limit is reached. Send your message again later, or run **Dragon: Choose Model** to pick another model.',
		'Rate limit exceeded. Please try again later.\n\nThe model provider is limiting how often it can be called, and OpenCode\'s retries ran out. Send your message again in a few minutes, or run **Dragon: Choose Model** to pick another model.',
		'nope\n\nThe model provider rejected the request. Run **Dragon: Choose Model** to connect a provider or pick a local Ollama model.',
		'Streaming response failed: [504] Upstream idle timeout exceeded',
		'unknown error',
	]);
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

test('the reasoning ends where the answer starts, also when OpenCode reports its end later', () => {
	// The order of a Nemotron turn on OpenCode Zen recorded on 2026-10-07: the reasoning's end came
	// after the answer's first two parts, and the chat folded those away with the reasoning.
	const reducer = new TurnReducer('s');
	const event = (type: string, data: Record<string, unknown> = {}): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's', assistantMessageID: 'm1', ordinal: 0, ...data } });
	assert.deepStrictEqual([
		event('session.reasoning.started'),
		event('session.reasoning.delta', { delta: 'A tagline for Dragon Dash.' }),
		event('session.text.started'),
		event('session.text.delta', { delta: 'Dragon Dash: Where heroes rise' }),
		event('session.text.delta', { delta: ' and dragons so' }),
		event('session.reasoning.ended', { text: 'A tagline for Dragon Dash.' }),
		event('session.text.delta', { delta: 'ar!' }),
		event('session.text.ended'),
		// Reasoning in a later step ends when OpenCode says so, and so does reasoning that resumes
		// after the answer started.
		event('session.reasoning.delta', { ordinal: 1, delta: 'Done.' }),
		event('session.reasoning.ended', { ordinal: 1 }),
		event('session.reasoning.delta', { assistantMessageID: 'm2', delta: 'Go on.' }),
		event('session.text.delta', { assistantMessageID: 'm2', delta: 'Going.' }),
		event('session.reasoning.delta', { assistantMessageID: 'm2', delta: 'Again.' }),
		event('session.reasoning.ended', { assistantMessageID: 'm2' }),
	].flatMap(e => reducer.reduce(e)), [
		{ kind: 'thinking', id: 'm1#0', delta: 'A tagline for Dragon Dash.' },
		{ kind: 'thinking-end', id: 'm1#0' },
		{ kind: 'text', delta: 'Dragon Dash: Where heroes rise', block: 'm1#0' },
		{ kind: 'text', delta: ' and dragons so', block: 'm1#0' },
		{ kind: 'text', delta: 'ar!', block: 'm1#0' },
		{ kind: 'thinking', id: 'm1#1', delta: 'Done.' },
		{ kind: 'thinking-end', id: 'm1#1' },
		{ kind: 'thinking', id: 'm2#0', delta: 'Go on.' },
		{ kind: 'thinking-end', id: 'm2#0' },
		{ kind: 'text', delta: '\n\nGoing.', block: 'm2#0' },
		{ kind: 'thinking', id: 'm2#0', delta: 'Again.' },
		{ kind: 'thinking-end', id: 'm2#0' },
	]);
});

test('reducer reports a compaction: its summary as it is written, the sizes, and a failure', () => {
	// The sizes of the manual compaction stored on 2026-10-07 at 17:29 (Nemotron, 128,384 cached tokens).
	const reducer = new TurnReducer('s1');
	const event = (type: string, data: Record<string, unknown>): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's1', ...data } });
	const ops = [
		event('session.compaction.started', { reason: 'manual', recent: '' }),
		event('session.compaction.delta', { text: '## Goal\n' }),
		event('session.compaction.delta', { text: 'A Godot strategy game.' }),
		event('session.compaction.ended', { reason: 'manual', text: '## Goal\nA Godot strategy game.', recent: '', tokens: { input: 1279, output: 1462, reasoning: 173, cache: { read: 128384, write: 0 } } }),
		event('session.execution.succeeded', {}),
		event('session.compaction.started', { reason: 'auto', recent: '' }),
		event('session.compaction.failed', { reason: 'auto', error: { type: 'compaction.interrupted', message: 'Compaction was interrupted' } }),
	].flatMap(e => reducer.reduce(e));
	assert.deepStrictEqual(ops, [
		{ kind: 'status', message: 'Compacting the conversation…' },
		{ kind: 'compaction-text', id: 'compaction-1', delta: '## Goal\n' },
		{ kind: 'compaction-text', id: 'compaction-1', delta: 'A Godot strategy game.' },
		{ kind: 'thinking-end', id: 'compaction-1' },
		{ kind: 'compacted', reason: 'manual', before: 129663, after: 1462 },
		{ kind: 'done', outcome: 'succeeded' },
		{ kind: 'status', message: 'Compacting the conversation automatically…' },
		{ kind: 'compaction-failed', reason: 'auto', message: 'Compaction was interrupted' },
	]);
});

test('what /compact did shows at the end of the turn when the agent works on after it, as steps fold it away', () => {
	const shell = (kind: 'tool-start' | 'tool-done', id: string): TurnOp => kind === 'tool-start' ? { kind, id, name: 'shell' } : { kind, id, name: 'shell', input: {}, output: '', files: [] };
	const run = (ops: readonly (TurnOp | string)[]) => {
		const notes = new TurnNotes();
		for (const op of ops) {
			if (typeof op === 'string') {
				notes.see({ kind: 'compacted', reason: 'manual' }, op);
			} else {
				notes.see(op);
			}
		}
		return notes.foldedAway();
	};
	assert.deepStrictEqual({
		// /compact typed while a command ran: it compacts once the command ends, and the agent goes on.
		workedOn: run([shell('tool-done', 'call_1'), 'Compacted.', shell('tool-start', 'call_2'), shell('tool-done', 'call_2'), { kind: 'text', delta: 'Done.', block: 'b1' }]),
		// /compact while the agent was idle: the note is the reply.
		idle: run([{ kind: 'status', message: 'Compacting the conversation…' }, { kind: 'compaction-text', id: 'compaction-1', delta: '## Goal' }, { kind: 'thinking-end', id: 'compaction-1' }, 'Compacted.']),
		// The command that ran before the note ends after it: that step was shown before the note.
		earlierStep: run([shell('tool-start', 'call_1'), 'Compacted.', shell('tool-done', 'call_1'), { kind: 'text', delta: 'Done.', block: 'b1' }]),
		// Reasoning after the note is a step too.
		reasoning: run(['Compacted.', { kind: 'thinking', id: 'r1', delta: 'Next.' }]),
	}, {
		workedOn: ['Compacted.'],
		idle: [],
		earlierStep: [],
		reasoning: ['Compacted.'],
	});
});

test('a message from another agent that a step folded away shows again at the end of a turn that gives way to the user\'s next message', () => {
	const tool = (kind: 'tool-start' | 'tool-done', id: string, name: string): TurnOp => kind === 'tool-start' ? { kind, id, name } : { kind, id, name, input: {}, output: '', files: [] };
	const quote = (from: string, text: string) => `> From ${from}: ${text}`;
	// As the lead's chat ran in smoke-turns: it messaged its agents, two answered before it called
	// wait_agent, and the user asked how they were doing while it waited.
	const run = (yielded: boolean) => {
		const notes = new TurnNotes();
		notes.see(tool('tool-start', 'call_1', 'send_message'));
		notes.see(tool('tool-done', 'call_1', 'send_message'));
		for (const [from, text] of [['agent-1', 'Shield: Dragon Scale.'], ['agent-2', 'Minion: Ember Bat.']]) {
			notes.see({ kind: 'agent-message', from, text }, quote(from, text));
		}
		notes.see(tool('tool-start', 'call_2', 'wait_agent'));
		notes.see({ kind: 'agent-message', from: 'agent-3', text: 'Last level: Obsidian Keep.' }, quote('agent-3', 'Last level: Obsidian Keep.'));
		return notes.foldedAway(yielded);
	};
	assert.deepStrictEqual({ yielded: run(true), ended: run(false) }, {
		// agent-3's answer came after the last step: it shows without help.
		yielded: [quote('agent-1', 'Shield: Dragon Scale.'), quote('agent-2', 'Minion: Ember Bat.')],
		// A turn that ends has the reply the lead wrote after them.
		ended: [],
	});
});

test('a turn that sent a message ends when the run that took it in ends, not an earlier one', () => {
	const event = (type: string, data: Record<string, unknown> = {}): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's1', ...data } });
	const steered = new TurnReducer('s1');
	steered.awaitDelivery('msg_2');
	const unreported = new TurnReducer('s1');
	unreported.awaitDelivery('msg_2');
	assert.deepStrictEqual({
		// The agent's run ends just before it takes the message in; the next run answers it.
		steered: [
			event('session.inbox.enqueued', { inboxID: 'msg_2', item: { type: 'user', payload: { text: 'Also say hi.' }, delivery: 'steer' } }),
			event('session.execution.succeeded'),
			event('session.execution.started'),
			event('session.inbox.delivered', { inboxID: 'msg_2' }),
			event('session.execution.succeeded'),
		].map(e => steered.reduce(e).map(op => op.kind)),
		// A server that does not report the message's inbox item ends the turn as before.
		unreported: unreported.reduce(event('session.execution.succeeded')),
	}, {
		steered: [[], [], [], [], ['done']],
		unreported: [{ kind: 'done', outcome: 'succeeded' }],
	});
});

test('a turn showing an agent stays open for a message sent to it meanwhile until the agent has answered it, however the send and the agent\'s run interleave', () => {
	const event = (type: string, data: Record<string, unknown> = {}): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's1', ...data } });
	const answer = (inboxID: string) => event('session.inbox.enqueued', { inboxID, item: { type: 'synthetic', payload: { text: 'Hero: Ignis.', metadata: { source: 'dragon.agent', fromName: 'agent-1' } } } });
	const kinds = (reducer: TurnReducer, events: OpenCodeEvent[]) => events.map(e => reducer.reduce(e).map(op => op.kind));
	// The agent's run ends just before it takes the answer in, after the answer's send returned; the next run answers it.
	const late = new TurnReducer('s1');
	const lateAnswer = late.expect()!;
	const lateEvents = kinds(late, [answer('in_1')]);
	lateAnswer.sent('in_1');
	// The run ends while the answer's send is still out, and it is not taken in before then.
	const pending = new TurnReducer('s1');
	const pendingAnswer = pending.expect()!;
	const pendingEvents = kinds(pending, [event('session.execution.succeeded')]);
	const pendingEnds = pendingAnswer.sent('in_2');
	// The agent took the answer in and finished before its send returned: the turn ends then.
	const quick = new TurnReducer('s1');
	const quickAnswer = quick.expect()!;
	const quickEvents = kinds(quick, [answer('in_3'), event('session.execution.started'), event('session.inbox.delivered', { inboxID: 'in_3' }), event('session.execution.succeeded')]);
	// The answer's send failed after the agent finished: the turn ends then.
	const failed = new TurnReducer('s1');
	const failedAnswer = failed.expect()!;
	const failedEvents = kinds(failed, [event('session.execution.succeeded')]);
	const ended = new TurnReducer('s1');
	ended.reduce(event('session.execution.succeeded'));
	assert.deepStrictEqual({
		late: [...lateEvents, ...kinds(late, [event('session.execution.succeeded'), event('session.execution.started'), event('session.inbox.delivered', { inboxID: 'in_1' }), event('session.execution.succeeded')])],
		pending: [...pendingEvents, pendingEnds, ...kinds(pending, [answer('in_2'), event('session.execution.started'), event('session.inbox.delivered', { inboxID: 'in_2' }), event('session.execution.succeeded')])],
		quick: [...quickEvents, quickAnswer.sent('in_3')],
		failed: [...failedEvents, failedAnswer.failed()],
		// A turn that ended takes no more messages: they go to the chat as turns of their own.
		ended: ended.expect(),
	}, {
		late: [['agent-message'], [], [], [], ['done']],
		pending: [[], false, ['agent-message'], [], [], ['done']],
		quick: [['agent-message'], [], [], [], true],
		failed: [[], true],
		ended: undefined,
	});
});

test('a message from another agent that comes while the model writes shows after that text, not inside it', () => {
	const event = (type: string, data: Record<string, unknown> = {}): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, ...data } });
	const answer = (from: string) => event('session.inbox.enqueued', { inboxID: `in_${from}`, item: { type: 'synthetic', payload: { text: `${from} answered.`, metadata: { source: 'dragon.agent', fromName: from } } } });
	const shown = (ops: TurnOp[]) => ops.map(op => op.kind === 'text' ? op.delta : op.kind === 'agent-message' ? `> ${op.from}` : op.kind);
	const reduced = (reducer: TurnReducer, events: OpenCodeEvent[]) => shown(events.flatMap(e => reducer.reduce(e)));
	// The lead's chat read "On it", the answers of agent-2 and agent-3, then " again.".
	const written = new TurnReducer('s1');
	const ended = new TurnReducer('s1');
	const stopped = new TurnReducer('s1');
	assert.deepStrictEqual({
		// OpenCode reports the text's end.
		written: reduced(written, [answer('agent-1'), event('session.text.started'), event('session.text.delta', { delta: 'On it' }), answer('agent-2'), answer('agent-3'), event('session.text.delta', { delta: ' again.' }), event('session.text.ended'), event('session.execution.succeeded')]),
		// Another text block starts, or the run ends, without it.
		ended: reduced(ended, [event('session.text.delta', { delta: 'On it' }), answer('agent-2'), event('session.text.delta', { delta: 'Done.', ordinal: 1 }), answer('agent-3'), event('session.execution.succeeded')]),
		// The turn ends first: the user stopped it, or wrote again.
		stopped: [...reduced(stopped, [event('session.text.delta', { delta: 'On it' }), answer('agent-2')]), ...shown(stopped.flush())],
	}, {
		written: ['> agent-1', 'On it', ' again.', '> agent-2', '> agent-3', 'done'],
		ended: ['On it', '> agent-2', '\n\nDone.', '> agent-3', 'done'],
		stopped: ['On it', '> agent-2'],
	});
});

test('an agent\'s chat shows its text without the message wrappers its model imitated, as Nemotron\'s "Blaze <agent-message from="main" …>" was shown', () => {
	const event = (type: string, data: Record<string, unknown> = {}): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, ...data } });
	/** What agent-1's chat shows for the text, written in these pieces, after which the text ends. */
	const shown = (pieces: (string | OpenCodeEvent)[], name: () => string | undefined = () => 'agent-1') => {
		const reducer = new TurnReducer('s1', undefined, undefined, name);
		const events = [...pieces.map(piece => typeof piece === 'string' ? event('session.text.delta', { delta: piece }) : piece), event('session.text.ended')];
		return events.flatMap(e => reducer.reduce(e)).map(op => op.kind === 'text' ? op.delta : op.kind);
	};
	assert.deepStrictEqual({
		// Agent-1's words in a run, written in pieces that split the tags.
		echoed: shown(['Blaze\n<agent-mes', 'sage from="main" session="ses_1">Provide just one line', ' with the hero\'s name.</agent-', 'message>']),
		own: shown(['<agent-message from="Agent-1">\nRagefire\n</agent-message>']),
		unnamed: shown(['<agent-message>Ragefire</agent-message>']),
		prose: shown(['a < b, and <', 'agents> are fine <']),
		unclosed: shown(['<agent-message from="main">Name the', ' hero.']),
		nextBlock: shown(['Done <', event('session.text.delta', { delta: 'x', ordinal: 1 })]),
		// Text of a chat no agent messages is as written: an inline edit's code here read `\n${safe}\n`.
		nameUnknown: shown(['return `<agent-message from="${sender.name}" session="${sender.id}">', '\\n${safe}\\n</agent-message>`;'], () => undefined),
	}, {
		echoed: ['Blaze\n'],
		own: ['\nRagefire\n'],
		unnamed: ['Ragefire'],
		prose: ['a < b, and ', '<agents> are fine ', '<'],
		unclosed: ['<agent-message from="main">Name the hero.'],
		nextBlock: ['Done ', '<', '\n\nx'],
		nameUnknown: ['return `<agent-message from="${sender.name}" session="${sender.id}">', '\\n${safe}\\n</agent-message>`;'],
	});
});

test('a turn shows every message from another agent that reaches the inbox, also one worded as the last, but not again the one it started with', () => {
	const messages = new ShownMessages();
	messages.opened({ from: 'agent-1', text: 'Name the hero.' });
	assert.deepStrictEqual([
		// The message the turn started with, as it reaches the inbox: the chat shows it as the request.
		{ from: 'agent-1', text: 'Name the hero.' },
		// Two answers worded the same, as agents ending turns with "Done.".
		{ from: 'agent-2', text: 'Done.' },
		{ from: 'agent-2', text: 'Done.' },
		{ from: 'agent-3', text: 'Done.' },
		// The message the turn started with, sent again.
		{ from: 'agent-1', text: 'Name the hero.' },
	].map(message => messages.arrived(message)), [false, true, true, true, true]);
});

test('a turn knows while the model writes text, so one asked to yield to the user lets that text end first', () => {
	const event = (type: string, data: Record<string, unknown> = {}): OpenCodeEvent => ({ id: type, type, data: { sessionID: 's1', assistantMessageID: 'm1', ordinal: 0, ...data } });
	/** After each event, whether the model is writing text. */
	const writing = (events: OpenCodeEvent[]) => {
		const reducer = new TurnReducer('s1');
		return events.map(e => (reducer.reduce(e), reducer.writingText));
	};
	// Yielding while it wrote, the lead's chat read "Asked", and the next turn began " them.".
	assert.deepStrictEqual({
		ended: writing([event('session.text.started'), event('session.text.delta', { delta: 'Asked' }), event('session.text.delta', { delta: ' them.' }), event('session.text.ended')]),
		toolNext: writing([event('session.text.delta', { delta: 'Asked' }), event('session.tool.input.started', { callID: 'c1', name: 'shell' })]),
		otherSession: writing([event('session.text.delta', { delta: 'Asked', sessionID: 's2' })]),
	}, {
		ended: [false, true, true, false],
		toolNext: [true, false],
		otherSession: [false],
	});
});

test('a turn asked to yield to the user holds while a card waits for the user\'s answer, which yielding would deny', () => {
	/** Whether the turn yields at each check, as [requested, writing text, open cards, time]. */
	const yields = (checks: [boolean, boolean, number, number][]) => {
		const turnYield = new TurnYield(10_000);
		return checks.map(([requested, writingText, openQuestions, time]) => turnYield.now(requested, { writingText, openQuestions }, time));
	};
	assert.deepStrictEqual({
		notAsked: yields([[false, false, 0, 0]]),
		// The user typed while the model wrote; the text ended in a command whose approval card opened.
		cardOpens: yields([[true, true, 0, 0], [true, false, 1, 250], [true, false, 1, 60_000], [true, false, 0, 60_250]]),
		// Text after a card answered late gets the whole wait, as text with no card.
		textAfterCard: yields([[true, false, 1, 0], [true, true, 0, 30_000], [true, true, 0, 39_750], [true, true, 0, 40_000]]),
		textNoCard: yields([[true, true, 0, 0], [true, true, 0, 9_750], [true, true, 0, 10_000]]),
	}, {
		notAsked: [false],
		cardOpens: [false, false, false, true],
		textAfterCard: [false, false, false, true],
		textNoCard: [false, false, true],
	});
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

test('a running command reads as how long it has run, its timeout and the last line it printed', () => {
	const running = presentTool('shell', { command: 'npm test' }).running;
	assert.deepStrictEqual({
		messages: [
			runningCommandMessage(running, 0, 120_000, ''),
			runningCommandMessage(running, 65_400, 120_000, 'PASS src/a.test.ts\n'),
			runningCommandMessage(running, 3_725_000, 0, 'serving on :8080'),
			runningCommandMessage(running, 9_000, 30_000, `${'x'.repeat(120)}`),
		],
		lines: [
			lastOutputLine('one\ntwo\n\n  \n'),
			// Colors are dropped, and of a line a progress bar rewrote only what it shows last.
			lastOutputLine('\x1b[32m✓\x1b[0m built\nDownloading 10%\rDownloading 55%\rDownloading 90%'),
			lastOutputLine('use `npm ci`'),
			lastOutputLine(''),
		],
		timeouts: [shellTimeout({}), shellTimeout({ timeout: 600_000 }), shellTimeout({ timeout: 0 }), shellTimeout({ background: true }), shellTimeout({ timeout: 'soon' })],
	}, {
		messages: [
			'Running `npm test` — 0s of its 2m timeout',
			'Running `npm test` — 1m 5s of its 2m timeout · `PASS src/a.test.ts`',
			'Running `npm test` — 1h 2m, no timeout · `serving on :8080`',
			`Running \`npm test\` — 9s of its 30s timeout · \`${'x'.repeat(79)}…\``,
		],
		lines: ['two', 'Downloading 90%', 'use `npm ci`', undefined],
		timeouts: [120_000, 600_000, 0, 0, 120_000],
	});
});

test('a running command\'s line updates with the time and its output until it stops', async () => {
	let now = 1_000;
	const output = new Map([['sh_1', 'Compiling…\n'], ['sh_2', '']]);
	const shown: string[] = [];
	const commands = new RunningCommands(async shellID => output.get(shellID) ?? '', (id, message) => shown.push(`${id}: ${message}`), () => now, 0);
	commands.start('call_1', 'sh_1', 'Running `godot --export`', { timeout: 300_000 });
	now += 2_000;
	await commands.tick();
	output.set('sh_1', 'Compiling…\nExported game.pck\n');
	commands.start('call_2', 'sh_2', 'Running `sleep 5`', {});
	now += 1_000;
	await commands.tick();
	commands.stop('call_1');
	now += 1_000;
	await commands.tick();
	commands.dispose();
	await commands.tick();
	assert.deepStrictEqual(shown, [
		'call_1: Running `godot --export` — 0s of its 5m timeout',
		'call_1: Running `godot --export` — 2s of its 5m timeout · `Compiling…`',
		'call_2: Running `sleep 5` — 0s of its 2m timeout',
		'call_1: Running `godot --export` — 3s of its 5m timeout · `Exported game.pck`',
		'call_2: Running `sleep 5` — 1s of its 2m timeout',
		'call_2: Running `sleep 5` — 2s of its 2m timeout',
	]);
});

test('reducer passes on the shell a running command reports, so its output can be read', () => {
	const reducer = new TurnReducer('ses_a');
	const ops = [
		{ id: '1', type: 'session.tool.called', data: { sessionID: 'ses_a', id: 'call_1', name: 'shell', input: { command: 'npm test' } } },
		{ id: '2', type: 'session.tool.progress', data: { sessionID: 'ses_a', id: 'call_1', metadata: { shellID: 'sh_1' } } },
		{ id: '3', type: 'session.tool.progress', data: { sessionID: 'ses_a', id: 'call_1', metadata: { other: true } } },
		{ id: '4', type: 'session.tool.progress', data: { sessionID: 'ses_a', id: 'call_unknown', metadata: { shellID: 'sh_2' } } },
	].flatMap(event => reducer.reduce(event));
	assert.deepStrictEqual(ops.filter(op => op.kind === 'tool-progress'), [
		{ kind: 'tool-progress', id: 'call_1', name: 'shell', input: { command: 'npm test' }, shellID: 'sh_1' },
	]);
});

test('reducer reports a permission request or form OpenCode settled, from this chat or anywhere else', () => {
	const children = new Set<string>(['ses_child']);
	const reducer = new TurnReducer('ses_a', children);
	const ask = (sessionID: string, id: string, tool: string) => ({ id, type: 'permission.asked', data: { sessionID, id, action: 'shell', resources: ['ls'], source: { type: 'tool', messageID: 'msg_1', id: tool } } });
	const ops = [
		ask('ses_a', 'per_1', 'call_1'),
		ask('ses_child', 'per_2', 'call_2'),
		ask('ses_child', 'per_4', 'call_4'),
		{ id: '1', type: 'permission.replied', data: { sessionID: 'ses_a', requestID: 'per_1', reply: 'reject' } },
		{ id: '2', type: 'permission.replied', data: { sessionID: 'ses_child', requestID: 'per_2', reply: 'always' } },
		{ id: '3', type: 'permission.replied', data: { sessionID: 'ses_other', requestID: 'per_3', reply: 'once' } },
		{ id: '4', type: 'permission.replied', data: { sessionID: 'ses_child', requestID: 'per_4', reply: 'reject' } },
		{ id: '5', type: 'form.replied', data: { sessionID: 'ses_a', id: 'frm_1', answer: {} } },
		{ id: '6', type: 'form.cancelled', data: { sessionID: 'ses_a', id: 'frm_2' } },
		{ id: '7', type: 'form.cancelled', data: { sessionID: 'ses_other', id: 'frm_3' } },
	].flatMap(event => reducer.reduce(event)).filter(op => op.kind === 'settled');
	// A denied request names its tool call, whose failure follows: it shows as denied, whoever denied it.
	assert.deepStrictEqual(ops, [
		{ kind: 'settled', id: 'per_1', denied: 'call_1' },
		{ kind: 'settled', id: 'per_2' },
		{ kind: 'settled', id: 'per_4', denied: 'call_4' },
		{ kind: 'settled', id: 'frm_1' },
		{ kind: 'settled', id: 'frm_2' },
	]);
});

test('questions are asked without holding up the turn, and one OpenCode settled elsewhere closes unanswered', async () => {
	const seen: string[] = [];
	const questions = new OpenQuestions(err => seen.push(`error: ${err instanceof Error ? err.message : err}`));
	let answerFirst: (decision: string) => void = () => { };
	const ask = (id: string) => (signal: AbortSignal) => new Promise<string | undefined>(resolve => {
		seen.push(`${id} shown`);
		if (id === 'per_1') {
			answerFirst = resolve;
		}
		signal.addEventListener('abort', () => {
			seen.push(`${id} closed`);
			resolve(undefined);
		});
	});
	const reply = (id: string) => async (decision: string) => {
		seen.push(`${id} ${decision}`);
		if (id === 'per_3') {
			throw new Error('the reply failed');
		}
	};

	questions.ask('per_1', ask('per_1'), reply('per_1'));
	questions.ask('per_2', ask('per_2'), reply('per_2'));
	questions.ask('per_1', ask('per_1 again'), reply('per_1 again'));
	const openAtOnce = questions.size;
	answerFirst('reject');
	await new Promise(resolve => setImmediate(resolve));
	// OpenCode reports the request this chat answered as settled too: nothing more happens to it.
	questions.settled('per_1');
	// A denial rejects the session's other requests, and their cards close unanswered.
	questions.settled('per_2');
	questions.ask('per_3', async () => 'once', reply('per_3'));
	await questions.idle();

	assert.deepStrictEqual({ openAtOnce, openAfter: questions.size, seen }, {
		openAtOnce: 2,
		openAfter: 0,
		seen: ['per_1 shown', 'per_2 shown', 'per_1 reject', 'per_2 closed', 'per_3 once', 'error: the reply failed'],
	});
});

test('a reply OpenCode answers with 404 was to a request it already settled', () => {
	assert.deepStrictEqual([
		new OpenCodeHttpError('POST', '/api/session/ses_a/permission/per_1/reply', 404, '{"_tag":"PermissionNotFoundError"}'),
		new OpenCodeHttpError('POST', '/api/session/ses_a/permission/per_1/reply', 500, ''),
		new Error('fetch failed'),
	].map(isNotFound), [true, false, false]);
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

test('a running server restarts when the folders agents are kept to change, and not otherwise', { skip: process.platform === 'win32' && 'the stand-in server is a script' }, async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'dragon-server-'));
	// Stands in for `opencode serve --stdio`: says where it listens, reports the folders it was given, and stops when stdin closes.
	const fake = path.join(dir, 'opencode');
	writeFileSync(fake, `#!${process.execPath}\n${[
		'const server = require(\'node:http\').createServer((_, res) => res.end(JSON.stringify({ version: process.env.DRAGON_CONFINED_FOLDERS, pid: process.pid, urls: [] })));',
		'server.listen(0, \'127.0.0.1\', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })));',
		'process.stdin.on(\'end\', () => process.exit(0)).resume();',
	].join('\n')}\n`);
	chmodSync(fake, 0o755);
	const confined = (folders: string[]) => ({ extraEnv: { DRAGON_CONFINED_FOLDERS: JSON.stringify(folders) } });
	const server = new OpenCodeServer({ configuredBinary: fake, extensionPath: dir, cwd: dir, log: () => undefined, ...confined(['/a', '/b']) });
	try {
		await server.reconfigure(confined(['/a', '/b', '/c']));
		const stopped = server.state.kind;
		const first = await (await server.ensure()).info();
		await server.reconfigure(confined(['/a', '/b', '/c']));
		const same = await (await server.ensure()).info();
		await server.reconfigure(confined(['/a']));
		const fewer = await (await server.ensure()).info();
		assert.deepEqual({ stopped, first: first.version, same: same.pid === first.pid, fewer: fewer.version, restarted: fewer.pid !== first.pid }, {
			stopped: 'stopped',
			first: '["/a","/b","/c"]',
			same: true,
			fewer: '["/a"]',
			restarted: true,
		});
	} finally {
		server.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a terminal UI that stops says why, from the line OpenCode logged for that run', async () => {
	// The real line from a hardened-runtime opencode whose TUI could not load its render library.
	const renderLibrary = readFileSync(path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'tui-failure.log'), 'utf8').trim();
	const unreachable = 'timestamp=2026-10-08T02:05:55.000Z level=ERROR run=9f8e7d6c message="cli process failed" cause="Cause([Fail(Error: Could not reach server at http://127.0.0.1:9 (cause: ClientError: Transport: Unable to connect.))])" args="[\\"--server\\",\\"http://127.0.0.1:9\\"]" role=cli';
	const starting = 'timestamp=2026-10-08T02:05:54.542Z level=INFO run=0a1b2c3d message="cli starting" version=2.0.18 channel=local local=true args="[\\"--server\\",\\"http://127.0.0.1:47651\\"]" role=cli';
	const log = [starting, renderLibrary, unreachable, ''].join('\n');
	const failedAt = Date.parse('2026-10-08T02:05:54.651Z');
	const tui = ['--server', 'http://127.0.0.1:47651'];
	const logs = mkdtempSync(path.join(os.tmpdir(), 'dragon-logs-'));
	writeFileSync(path.join(logs, 'opencode-local.log'), log);
	const read = await readCliFailure(logs, tui, failedAt - 1000);
	rmSync(logs, { recursive: true, force: true });
	assert.deepEqual({
		renderLibrary: cliFailure(log, tui, failedAt - 1000),
		read: read && { reason: read.reason === cliFailure(log, tui, failedAt - 1000), file: path.basename(read.file) },
		otherServer: cliFailure(log, ['--server', 'http://127.0.0.1:9'], failedAt - 1000),
		otherSession: cliFailure(log, [...tui, '--session', 'ses_1'], failedAt - 1000),
		beforeLaunch: cliFailure(log, tui, failedAt + 1),
		emptyLog: cliFailure('', tui, 0),
		directory: [openCodeLogDirectory({ XDG_DATA_HOME: '/xdg' }, '/home/u'), openCodeLogDirectory({}, '/home/u')],
	}, {
		renderLibrary: 'Failed to initialize OpenTUI render library: Failed to open library "/var/folders/xx/0000gn/T/.bun-501-580dfe60f7f73ad8.dylib": mapping process and mapped file (non-platform) have different Team IDs',
		read: { reason: true, file: 'opencode-local.log' },
		otherServer: 'Could not reach server at http://127.0.0.1:9',
		otherSession: undefined,
		beforeLaunch: undefined,
		emptyLog: undefined,
		directory: [path.join('/xdg', 'opencode', 'log'), path.join('/home/u', '.local', 'share', 'opencode', 'log')],
	});
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

test('automatic compaction: the config layer compacts at dragon.compaction.autoAt, or never with 0, and /autocompact reads its argument', () => {
	const compaction = (autoCompactAt?: number) => (buildDragonConfig({ ollamaOrigin: 'http://127.0.0.1:11434', ollamaModels: [], autoCompactAt }) as { compaction?: object }).compaction;
	assert.deepEqual({
		config: { at75: compaction(75), at100: compaction(100), off: compaction(0), unset: compaction() },
		parsed: Object.fromEntries(['off', 'OFF', '0', 'on', '60%', '60', ' 100 % ', '9', '101', '75.5', 'half', ''].map(text => [text, parseAutoCompactAt(text)])),
	}, {
		config: { at75: { auto: true, threshold: 0.75 }, at100: { auto: true, threshold: 1 }, off: { auto: false }, unset: undefined },
		parsed: { off: 0, OFF: 0, '0': 0, on: 75, '60%': 60, '60': 60, ' 100 % ': 100, '9': undefined, '101': undefined, '75.5': undefined, half: undefined, '': undefined },
	});
});

test('the confinement layer denies agents\' file tools every folder but the open ones and OpenCode\'s own', () => {
	const rules = (dataHome?: string, openCodeHome?: string) => confinementConfig({ folders: ['/work/game', '/home/me/.dragon/worktrees/game-1a2b3c4d'], home: '/home/me', tmpdir: '/tmp', dataHome, openCodeHome }).permissions.map(rule => `${rule.effect} ${rule.resource}`);
	assert.deepEqual({ unset: rules(), set: rules('/data').slice(1, 3), openCodeHome: rules(undefined, '/test').slice(1, 5), actions: [...new Set(confinementConfig({ folders: [], home: '/h', tmpdir: '/t' }).permissions.map(rule => rule.action))] }, {
		unset: [
			'deny *',
			'allow /home/me/.local/share/opencode/tool-output/*',
			'allow /home/me/.local/share/opencode/shell/*/*',
			'allow /tmp/opencode/*',
			'allow /home/me/.opencode/plan/*',
			'allow /work/game/*',
			'allow /home/me/.dragon/worktrees/game-1a2b3c4d/*',
		],
		set: ['allow /data/opencode/tool-output/*', 'allow /data/opencode/shell/*/*'],
		// OpenCode keeps plans in its own home folder, and its data in the home folder.
		openCodeHome: ['allow /home/me/.local/share/opencode/tool-output/*', 'allow /home/me/.local/share/opencode/shell/*/*', 'allow /tmp/opencode/*', 'allow /test/.opencode/plan/*'],
		actions: ['external_directory'],
	});
});

test('only Full Access reaches the whole disk; every other mode keeps agents to the open folders', () => {
	const input = { folders: ['/work/game'], home: '/home/me', tmpdir: '/tmp' };
	const sandboxVariables = { DRAGON_SANDBOX_PROFILE: '/p', DRAGON_SANDBOX_WRAPPER: '/w', DRAGON_SANDBOX_HOME: '/hb' };
	const summary = (mode: PermissionMode) => {
		const env = confinementEnv(mode, input, sandboxVariables);
		const config = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) as { permissions: PermissionRule[] } : undefined;
		return {
			confines: confinesToFolders(mode),
			sandbox: env.DRAGON_SANDBOX_PROFILE !== undefined,
			folders: env.DRAGON_CONFINED_FOLDERS,
			denies: config?.permissions.some(rule => rule.action === 'external_directory' && rule.effect === 'deny') ?? false,
		};
	};
	assert.deepEqual((['read-only', 'ask', 'project', 'full-access'] as PermissionMode[]).map(summary), [
		{ confines: true, sandbox: true, folders: '["/work/game"]', denies: true },
		{ confines: true, sandbox: true, folders: '["/work/game"]', denies: true },
		{ confines: true, sandbox: true, folders: '["/work/game"]', denies: true },
		{ confines: false, sandbox: false, folders: undefined, denies: false },
	]);
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

test('instruction files VS Code attaches to every request reach OpenCode once, and AGENTS.md not at all; a message that failed to go leaves them unsent', () => {
	const instruction = (file: string, version?: number): FileReference => ({ id: `vscode.instructions.file.root__file://${file}`, uri: `file://${file}`, path: file, version });
	const attached = (file: string): FileReference => ({ id: `file://${file}`, uri: `file://${file}`, path: file });
	const request = (claudeVersion: number) => [
		instruction('/repo/AGENTS.md'),
		instruction('/repo/app/AGENTS.md'),
		instruction('/repo/tools/AGENTS.md'),
		instruction('/repo/.claude/CLAUDE.md', claudeVersion),
		attached('/repo/app/main.gd'),
		attached('/repo/AGENTS.md'),
	];
	const sent = new Set<string>();
	/** The files a message is sent with; one that reached OpenCode has its instruction files sent. */
	const names = (claudeVersion: number, reached = true) => {
		const { files, instructions } = filesToSend(request(claudeVersion), '/repo/app', sent, ['/repo']);
		if (reached) {
			instructions.forEach(instruction => sent.add(instruction));
		}
		return files.map(file => file.uri.replace('file:///repo/', ''));
	};
	assert.deepStrictEqual([names(1, false), names(1), names(1), names(2)], [
		['tools/AGENTS.md', '.claude/CLAUDE.md', 'app/main.gd', 'AGENTS.md'],
		['tools/AGENTS.md', '.claude/CLAUDE.md', 'app/main.gd', 'AGENTS.md'],
		['app/main.gd', 'AGENTS.md'],
		['.claude/CLAUDE.md', 'app/main.gd', 'AGENTS.md'],
	]);
});

test('files reach OpenCode named by a path the model can read, not by VS Code\'s label for them', () => {
	const files: FileReference[] = [
		{ id: 'vscode.instructions.file.root__file:///repo/.github/copilot-instructions.md', uri: 'file:///repo/.github/copilot-instructions.md', path: '/repo/.github/copilot-instructions.md', version: 1 },
		{ id: 'file:///repo/app/src/main.gd', uri: 'file:///repo/app/src/main.gd', path: '/repo/app/src/main.gd' },
		{ id: 'selection', uri: 'file:///repo/app/game.js?start=3&end=5', path: '/repo/app/game.js' },
		{ id: 'file:///repo/README.md', uri: 'file:///repo/README.md', path: '/repo/README.md' },
	];
	assert.deepStrictEqual(filesToSend(files, '/repo/app', new Set(), ['/repo']).files, [
		{ uri: 'file:///repo/.github/copilot-instructions.md', name: '/repo/.github/copilot-instructions.md' },
		{ uri: 'file:///repo/app/src/main.gd', name: 'src/main.gd' },
		{ uri: 'file:///repo/app/game.js?start=3&end=5', name: 'game.js' },
		{ uri: 'file:///repo/README.md', name: '/repo/README.md' },
	]);
});

test('instruction files outside the folders open in the window do not reach OpenCode; files the user attached do', () => {
	const instruction = (file: string): FileReference => ({ id: `vscode.instructions.file.root__file://${file}`, uri: `file://${file}`, path: file, version: 1 });
	const attached = (file: string): FileReference => ({ id: `file://${file}`, uri: `file://${file}`, path: file });
	const files = filesToSend([
		instruction('/Users/me/.claude/CLAUDE.md'),
		instruction('/Users/me/Library/Application Support/Dragon/User/prompts/style.instructions.md'),
		instruction('/Users/me/CLAUDE.md'),
		instruction('/Users/me/game/CLAUDE.md'),
		instruction('/Users/me/art/.github/copilot-instructions.md'),
		instruction('/Users/me/.dragon/worktrees/game/agent-1/CLAUDE.local.md'),
		attached('/Users/me/notes/plan.md'),
		attached('/Users/me/game/main.gd'),
	], '/Users/me/.dragon/worktrees/game/agent-1', new Set(), ['/Users/me/game', '/Users/me/art', '/Users/me/.dragon/worktrees/game/agent-1']).files;
	assert.deepStrictEqual(files.map(file => file.uri.replace('file:///Users/me/', '')), [
		'game/CLAUDE.md',
		'art/.github/copilot-instructions.md',
		'.dragon/worktrees/game/agent-1/CLAUDE.local.md',
		'notes/plan.md',
		'game/main.gd',
	]);
});

test('an instruction file in an open folder that links out of the open folders does not reach OpenCode', () => {
	// Not resolved: the temp folder is a link on macOS.
	const temp = mkdtempSync(path.join(os.tmpdir(), 'dragon-linked-instructions-'));
	try {
		const game = path.join(temp, 'game');
		const notes = path.join(temp, 'notes');
		for (const folder of [path.join(game, '.github'), path.join(notes, 'rules')]) {
			mkdirSync(folder, { recursive: true });
		}
		writeFileSync(path.join(notes, 'CLAUDE.md'), 'Mine.\n');
		writeFileSync(path.join(game, '.github', 'copilot-instructions.md'), 'The game\'s.\n');
		writeFileSync(path.join(game, 'style.md'), 'The game\'s style.\n');
		symlinkSync(path.join(notes, 'CLAUDE.md'), path.join(game, 'CLAUDE.md'));
		// A link the other way leads in: what it names is in the open folder.
		symlinkSync(path.join(game, 'style.md'), path.join(notes, 'rules', 'style.instructions.md'));
		const instruction = (file: string): FileReference => ({ id: `vscode.instructions.file.root__file://${file}`, uri: `file://${file}`, path: file, version: 1 });
		const files = filesToSend([
			instruction(path.join(game, 'CLAUDE.md')),
			instruction(path.join(game, '.github', 'copilot-instructions.md')),
			instruction(path.join(notes, 'rules', 'style.instructions.md')),
		], game, new Set(), [game]).files;
		assert.deepStrictEqual(files.map(file => file.name), ['.github/copilot-instructions.md', path.join(notes, 'rules', 'style.instructions.md')]);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
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
