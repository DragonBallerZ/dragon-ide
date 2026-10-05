/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The agent messaging OpenCode plugin. OpenCode loads it in-process (Dragon's config layer lists
 * it under `plugins`). It adds the tools agents use to find, message, wait for and spawn each
 * other, and does nothing else: every call goes to the agent hub in the dragon-agent extension
 * (`hub.ts`), which owns the registry and the rules.
 *
 * The sender of a message is the session OpenCode ran the tool in. That ID comes from OpenCode's
 * tool context, not from the model's arguments, so an agent cannot speak as another one.
 */

import { readFileSync } from 'node:fs';

interface PluginContext {
	readonly tool: {
		transform(callback: (editor: ToolEditor) => void): Promise<unknown>;
	};
	readonly session: {
		hook(name: 'context', callback: (input: { readonly sessionID: string; tools: Record<string, unknown> }) => Promise<void> | void): Promise<unknown>;
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

/** Whether the hub's tools are shown to this session. Hidden when the hub cannot be asked. */
async function offered(sessionID: string): Promise<boolean> {
	try {
		const hub = hubAddress();
		const res = await fetch(`${hub.url}/offered?session=${encodeURIComponent(sessionID)}`, { headers: { authorization: `Bearer ${hub.token}` }, signal: AbortSignal.timeout(2000) });
		return res.ok && (await res.json() as { offered?: boolean }).offered === true;
	} catch {
		return false;
	}
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
			'Replies come back to you as messages on their own; do not poll. Use wait_agent when you have nothing else to do until it finishes.',
			'Send a message only when it moves the work forward. Do not send thanks or acknowledgements: each message wakes the other agent.',
		].join(' '),
		input: {
			type: 'object',
			properties: {
				to: { type: 'string', minLength: 1, description: 'The agent\'s name (or session ID) from list_agents.' },
				message: { type: 'string', minLength: 1, description: 'The message. Plain text or markdown.' },
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
				timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600, description: 'How long to wait. Default 120.' },
			},
			required: ['agent'],
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
		// Agents without messaging (and every subagent) are not offered the tools at all.
		await context.session.hook('context', async input => {
			if (TOOLS.some(tool => Object.hasOwn(input.tools, tool.name)) && !await offered(input.sessionID)) {
				for (const tool of TOOLS) {
					delete input.tools[tool.name];
				}
			}
		});
	},
};

export default plugin;
