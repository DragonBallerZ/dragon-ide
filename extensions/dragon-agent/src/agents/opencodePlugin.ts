/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The agent messaging OpenCode plugin. OpenCode loads it in-process (Dragon's config layer lists
 * it under `plugins`). It adds the tools agents use to find, message, wait for and spawn each
 * other: every call goes to the agent hub in the dragon-agent extension (`hub.ts`), which owns the
 * registry and the rules. Each model request of an agent with messaging on gets the hub's roster
 * of who it can message. As the one plugin Dragon always loads, it also explains Code Mode parse
 * failures to the model (`explainParseFailure`).
 *
 * The sender of a message is the session OpenCode ran the tool in. That ID comes from OpenCode's
 * tool context, not from the model's arguments, so an agent cannot speak as another one.
 */

import { readFileSync } from 'node:fs';

interface PluginContext {
	readonly tool: {
		transform(callback: (editor: ToolEditor) => void): Promise<unknown>;
		/** Missing from OpenCode builds older than the one Dragon ships. */
		hook?(name: 'execute.after', callback: (event: ToolExecuted) => Promise<void> | void): Promise<unknown>;
		/** A callback that throws fails that one call, which the model is told. */
		hook?(name: 'execute.before', callback: (event: ToolCalling) => Promise<void> | void): Promise<unknown>;
	};
	readonly session: {
		hook(name: 'context', callback: (input: RequestContext) => Promise<void> | void): Promise<unknown>;
	};
}

interface ToolEditor {
	add(tool: {
		name: string;
		description: string;
		input: object;
		options?: { codemode: boolean; permission?: string };
		execute(input: Record<string, unknown>, context: { readonly sessionID: string; readonly agent: string; readonly signal: AbortSignal }): Promise<{ content: string; metadata?: Record<string, unknown> }>;
	}): void;
}

/** OpenCode's `session` → `context` event: one model request, which a hook may rewrite. */
interface RequestContext {
	readonly sessionID: string;
	tools: Record<string, unknown>;
	/** OpenCode's `Message` objects: `{role, content: [{type: 'text', text}, …]}`. */
	messages: object[];
}

/** OpenCode's `tool` → `execute.before` event: a call about to run, before any permission is asked. */
interface ToolCalling {
	readonly tool: string;
	readonly sessionID: string;
	readonly input: unknown;
}

/** OpenCode's `tool` → `execute.after` event: what a tool returned, which a hook may rewrite. */
interface ToolExecuted {
	readonly tool: string;
	readonly sessionID?: string;
	readonly input?: unknown;
	readonly status: 'completed' | 'error';
	result?: {
		output?: unknown;
		content?: string | readonly { readonly type: string; readonly text?: string }[];
		metadata?: Record<string, unknown>;
	};
}

interface HubAddress {
	readonly url: string;
	readonly token: string;
}

/** The hub's address, read on every call: the extension rewrites the file when it restarts. */
function hubAddress(): HubAddress {
	const file = process.env.DRAGON_AGENTS_HUB;
	if (!file) {
		throw new Error('Agent messaging is not available: this OpenCode server was not started by Dragon IDE.');
	}
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as HubAddress;
	} catch {
		throw new Error('Agent messaging is not available right now: the Dragon IDE agent hub is not running.');
	}
}

async function callHub(tool: string, sessionID: string, agent: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
	const hub = hubAddress();
	const res = await fetch(`${hub.url}/tool`, {
		method: 'POST',
		headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ tool, sessionID, agent, input }),
		signal,
	});
	const body = await res.json() as { content?: string; error?: string };
	if (!res.ok || body.content === undefined) {
		throw new Error(body.error ?? `The agent hub answered ${res.status}.`);
	}
	return body.content;
}

/**
 * Whether the hub's tools are shown to this session, and the roster it is told (`AgentHub.roster`).
 * Hidden when the hub cannot be asked.
 */
async function offered(sessionID: string): Promise<{ offered: boolean; roster?: string }> {
	try {
		const hub = hubAddress();
		const res = await fetch(`${hub.url}/offered?session=${encodeURIComponent(sessionID)}`, { headers: { authorization: `Bearer ${hub.token}` }, signal: AbortSignal.timeout(2000) });
		const body = res.ok ? await res.json() as { offered?: boolean; roster?: unknown } : {};
		return { offered: body.offered === true, roster: typeof body.roster === 'string' ? body.roster : undefined };
	} catch {
		return { offered: false };
	}
}

/**
 * Adds `text` to this request only, as a user message: before the user's message when the request
 * ends with one, else after the last tool result, where OpenCode puts its own reminders. Near the
 * end, it leaves the cached prefix of the conversation alone. The message is made with the
 * constructor of the request's own messages, so it is the same kind of object.
 */
function remind(messages: object[], text: string): void {
	const Message = messages[0]?.constructor as (new (input: object) => object) | undefined;
	if (!Message) {
		return;
	}
	const at = (messages.at(-1) as { role?: string }).role === 'user' ? messages.length - 1 : messages.length;
	messages.splice(at, 0, new Message({ role: 'user', content: [{ type: 'text', text }] }));
}

const TOOLS: { name: string; description: string; input: object }[] = [
	{
		name: 'list_agents',
		description: 'List the other agents working in this window that you can message: their names, whether each is idle, running or waiting for the user, and which team they are on. Call it before send_message to get the exact names.',
		input: { type: 'object', properties: {}, additionalProperties: false },
	},
	{
		name: 'send_message',
		description: [
			'Send a message to another agent, by the name list_agents shows. The message starts a new turn for an idle agent and reaches a busy one at its next step.',
			'The other agent sees who sent it. It does not see your conversation, so include what it needs: the goal, file paths, what you already know, and what you want back.',
			// Told only in the roster, Nemotron sent agents writing one game's page, style and script their
			// files alone in four runs of six, and in one the script drew on a canvas the page did not have.
			'When several agents each make a part of one thing, such as the files of one program, send every one of them the same names the parts share (files, element ids, functions), and list the files each is to change in files.',
			'Replies come back to you as messages on their own; do not poll. Use wait_agent when you have nothing else to do until it finishes.',
			'Send a message only when it moves the work forward. Do not send thanks or acknowledgements: each message wakes the other agent.',
		].join(' '),
		input: {
			type: 'object',
			properties: {
				to: { type: 'string', minLength: 1, description: 'The agent\'s name (or session ID) from list_agents.' },
				message: { type: 'string', minLength: 1, description: 'The message. Plain text or markdown.' },
				// An agent given one file of a game wrote the other two as well, in four team-demo runs of ten.
				// A blank entry is no file: refused, Nemotron sent "files": [""] with a message that gave none,
				// then handed each agent README.md to get past the refusal, in a team-demo run.
				files: { type: 'array', items: { type: 'string' }, description: 'The files the agent is to change, from your folder. Until the user\'s next message, other agents\' write and edit calls on them are refused.' },
			},
			required: ['to', 'message'],
			additionalProperties: false,
		},
	},
	{
		name: 'wait_agent',
		description: 'Wait until another agent is idle (finished its turn), or until the timeout. Returns its status and its last reply. Use it after send_message or spawn_teammate when you need the result before you can continue.',
		input: {
			type: 'object',
			properties: {
				agent: { type: 'string', minLength: 1, description: 'The agent\'s name (or session ID) from list_agents.' },
				// OpenCode drops keys a schema does not have: Nemotron named the agent "to" in four team-demo
				// runs of thirteen, and with it gone, one main sent its question eight times rather than wait.
				to: { type: 'string', minLength: 1, description: 'The same as agent, named as send_message names it.' },
				// At most the hub's MAX_WAIT_SECONDS: Bun's fetch of the hub gives up after 360 s.
				timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300, description: 'How long to wait, in seconds. Default 120.' },
			},
			additionalProperties: false,
		},
	},
	{
		name: 'spawn_teammate',
		description: [
			'Start a new teammate agent with its own conversation and give it a task. Only the lead of a team can do this.',
			'The teammate opens next to you in the IDE, works in the same directory under the same permission limits as you, and reports back to you with send_message.',
			'Give each teammate one self-contained task and tell it which files are its to change, so teammates do not edit the same files.',
		].join(' '),
		input: {
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1, maxLength: 40, description: 'A short unique name, for example "tests" or "api-review".' },
				prompt: { type: 'string', minLength: 1, description: 'The task, with everything the teammate needs to know. It does not see your conversation.' },
				agent: { type: 'string', description: 'The OpenCode agent to run: "build" (default) or "plan" for a teammate that only reads and plans.' },
			},
			required: ['name', 'prompt'],
			additionalProperties: false,
		},
	},
];

/**
 * The tools the hub checks: those that change files, the patch tool being what OpenCode gives GPT-5
 * models in place of write and edit, and the question tool, which asks the user.
 */
const CHECKED_TOOLS = new Set(['write', 'edit', 'patch', 'apply_patch', 'question']);

/**
 * Why the hub refuses a write, edit, patch or question call: a file it changes is another agent's to
 * change, or another agent's request started the turn (`AgentHub.checkCall`). When the hub cannot be
 * asked, the call goes ahead.
 */
async function refusal(event: ToolCalling): Promise<string | undefined> {
	if (!CHECKED_TOOLS.has(event.tool)) {
		return undefined;
	}
	try {
		const hub = hubAddress();
		const res = await fetch(`${hub.url}/change`, {
			method: 'POST',
			headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ sessionID: event.sessionID, tool: event.tool, input: event.input ?? {} }),
			signal: AbortSignal.timeout(2000),
		});
		const body = res.ok ? await res.json() as { refused?: unknown } : {};
		return typeof body.refused === 'string' ? body.refused : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Tells the hub an agent read a file (`AgentHub.noteRead`), before OpenCode sends the model its next
 * request, which says what changed since the agent last read the files its work fits with.
 */
async function noteRead(event: ToolExecuted): Promise<void> {
	const input = (event.input ?? {}) as { path?: unknown; filePath?: unknown };
	const file = input.path ?? input.filePath;
	if (event.tool !== 'read' || event.status !== 'completed' || typeof file !== 'string' || !file) {
		return;
	}
	try {
		const hub = hubAddress();
		await fetch(`${hub.url}/read`, {
			method: 'POST',
			headers: { authorization: `Bearer ${hub.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ sessionID: event.sessionID, file }),
			signal: AbortSignal.timeout(2000),
		});
	} catch {
		// The next request may then say the file changed since the agent last read it.
	}
}

/**
 * A program Code Mode could not parse. Its message is the parser's, ending in `(line:column)`;
 * runtime failures name their error, or end in `(line 1, col 1)`.
 */
const PARSE_FAILURE = /^(?!\w*Error: |Uncaught: ).* \(\d+:\d+\)$/;

const JAVASCRIPT_ONLY = 'execute runs JavaScript only, and this code is not valid JavaScript. To run Python or another language, call the shell tool directly (for example `python3 script.py`). To create or change files, call the write or edit tool directly.';

/**
 * Says what went wrong when a model sends `execute` code in another language. The parser's message
 * alone ("'import' and 'export' may appear only with 'sourceType: module'") led a model to decide
 * the tool wanted Python, and to keep retrying it.
 */
function explainParseFailure(event: ToolExecuted): void {
	const result = event.result;
	if (event.tool !== 'execute' || event.status !== 'completed' || !result || result.metadata?.error !== true) {
		return;
	}
	const content = typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content ?? [];
	const text = content[0]?.type === 'text' ? content[0].text ?? '' : '';
	if (!PARSE_FAILURE.test(text.split('\n')[0])) {
		return;
	}
	const explained = `${text}\n\n${JAVASCRIPT_ONLY}`;
	result.content = typeof result.content === 'string' ? explained : [{ ...content[0], text: explained }, ...content.slice(1)];
	const output = result.output as { output?: unknown } | undefined;
	if (typeof output?.output === 'string') {
		result.output = { ...output, output: explained };
	}
}

const plugin = {
	id: 'dragon.agents',
	async setup(context: PluginContext) {
		await context.tool.transform(editor => {
			for (const tool of TOOLS) {
				editor.add({
					...tool,
					options: { codemode: false },
					async execute(input, toolContext) {
						return { content: await callHub(tool.name, toolContext.sessionID, toolContext.agent, input, toolContext.signal) };
					},
				});
			}
		});
		// Agents without messaging (and every subagent) are not offered the tools at all; agents with
		// it are told who they can message.
		await context.session.hook('context', async input => {
			if (!TOOLS.some(tool => Object.hasOwn(input.tools, tool.name))) {
				return;
			}
			const hub = await offered(input.sessionID);
			if (!hub.offered) {
				for (const tool of TOOLS) {
					delete input.tools[tool.name];
				}
			} else if (hub.roster) {
				remind(input.messages, hub.roster);
			}
		});
		// Refused before it runs, and before the user is asked to approve it.
		await context.tool.hook?.('execute.before', async event => {
			const refused = await refusal(event);
			if (refused) {
				throw new Error(refused);
			}
		});
		// A failing hook would fail the tool call, so it never throws.
		await context.tool.hook?.('execute.after', async event => {
			try {
				explainParseFailure(event);
			} catch {
				// The result goes back as OpenCode made it.
			}
			await noteRead(event);
		});
	},
};

export default plugin;
