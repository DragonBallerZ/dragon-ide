/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The agent hub: which OpenCode sessions of this window may message each other, the teams they
 * form, and the rules every message passes before it is delivered. The OpenCode plugin
 * (`opencodePlugin.ts`) forwards the agents' tool calls here over a localhost endpoint, with the
 * session ID OpenCode itself supplies as the sender.
 *
 * It holds no VS Code types, so it is tested directly.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import type { OpenCodeEvent } from '../opencode/types';
import { METADATA_SOURCE, wrapMessage } from './message';

/** Off: cannot send, receive or be listed. On: full messaging. Muted: receives, but is never woken. */
export type MessagingMode = 'off' | 'on' | 'muted';

export type AgentStatus = 'idle' | 'running' | 'waiting';

export interface AgentRecord {
	/** The OpenCode session ID. */
	readonly id: string;
	name: string;
	directory: string;
	messaging: MessagingMode;
	/** Set when the user stopped the agent; cleared by the user's next message to it. */
	stopped?: boolean;
	/** The agent runs under the Read-Only rules, and so does every teammate it spawns. */
	readOnly?: boolean;
	team?: string;
	role?: 'lead' | 'teammate';
	/** Wakes caused by other agents since a person last spoke to this agent or its team's lead. */
	wakes: number;
}

export interface TeamRecord {
	readonly id: string;
	name: string;
	readonly lead: string;
	members: string[];
}

interface LedgerEntry {
	readonly key: string;
	readonly time: number;
}

interface HubState {
	version: 1;
	agents: Record<string, AgentRecord>;
	teams: Record<string, TeamRecord>;
	/** Recently delivered messages, by content hash, for deduplication. */
	ledger: LedgerEntry[];
}

export interface HubLimits {
	/** Longest message `send_message` accepts, in characters. */
	readonly maxMessageChars: number;
	/** An identical message between the same two agents within this window is not delivered again. */
	readonly dedupWindowMs: number;
	/** Agent-caused wakes an agent accepts before a person has to continue it. */
	readonly maxWakes: number;
	readonly maxTeammates: number;
}

export const DEFAULT_LIMITS: HubLimits = { maxMessageChars: 16_000, dedupWindowMs: 60_000, maxWakes: 25, maxTeammates: 16 };

/** One message on its way to an agent. */
export interface Delivery {
	readonly sender: AgentRecord;
	readonly recipient: AgentRecord;
	/** The message as the sender wrote it. */
	readonly body: string;
	/** The message as the recipient's model reads it, wrapped with the validated sender. */
	readonly text: string;
	/** A short label for the transcript, for example `From lead`. */
	readonly description: string;
	readonly metadata: Record<string, unknown>;
	/** Whether the recipient should start working on it now. */
	readonly wake: boolean;
	/** Whether the recipient was between turns when the message was sent, so that this message starts its next one. */
	readonly idle: boolean;
}

/** What the hub needs from its surroundings: OpenCode, and (in the IDE) the chat editors. */
export interface HubHost {
	deliver(delivery: Delivery): Promise<void>;
	/** Creates the OpenCode session for a new teammate, under the lead's permission ceiling. */
	createTeammate(input: { readonly lead: AgentRecord; readonly name: string; readonly agent?: string }): Promise<{ readonly id: string; readonly directory: string }>;
	/** The agent's most recent reply, for `wait_agent`. */
	lastReply?(sessionID: string): Promise<string | undefined>;
}

/** A refusal the calling agent should read, as opposed to a bug. */
export class HubError extends Error { }

export const HUB_TOOLS = ['list_agents', 'send_message', 'wait_agent', 'spawn_teammate'] as const;
export type HubTool = typeof HUB_TOOLS[number];

const NAME_PATTERN = /[^a-z0-9._-]+/g;

/** A short name agents can type: lowercase letters, digits, dots, dashes and underscores. */
export function agentName(value: string): string {
	return value.toLowerCase().trim().replace(NAME_PATTERN, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export class AgentHub {
	private state: HubState = { version: 1, agents: {}, teams: {}, ledger: [] };
	private readonly status = new Map<string, AgentStatus>();
	private readonly listeners = new Set<() => void>();
	private readonly idleWaiters = new Map<string, Set<() => void>>();
	private writing: Promise<void> = Promise.resolve();
	private server: http.Server | undefined;
	private readonly token = randomBytes(24).toString('base64url');

	constructor(
		private readonly host: HubHost,
		/** Where the registry is kept. Without it the hub is in-memory only. */
		private readonly file?: string,
		private limits: HubLimits = DEFAULT_LIMITS,
		private readonly now: () => number = Date.now,
	) { }

	async load(): Promise<void> {
		if (!this.file) {
			return;
		}
		try {
			const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<HubState>;
			if (parsed.version === 1 && parsed.agents && parsed.teams) {
				this.state = { version: 1, agents: parsed.agents, teams: parsed.teams, ledger: parsed.ledger ?? [] };
			}
		} catch {
			// no registry yet, or an unreadable one: start empty
		}
	}

	setLimits(limits: Partial<HubLimits>): void {
		this.limits = { ...this.limits, ...limits };
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	get(id: string): AgentRecord | undefined {
		return this.state.agents[id];
	}

	team(id: string | undefined): TeamRecord | undefined {
		return id ? this.state.teams[id] : undefined;
	}

	/** Every agent with messaging on or muted. */
	list(): AgentRecord[] {
		return Object.values(this.state.agents).filter(agent => agent.messaging !== 'off');
	}

	statusOf(id: string): AgentStatus {
		return this.status.get(id) ?? 'idle';
	}

	/** Adds an agent, or updates the one already registered for this session. */
	async register(id: string, input: { name?: string; directory: string; messaging?: MessagingMode; readOnly?: boolean }): Promise<AgentRecord> {
		const existing = this.state.agents[id];
		const record: AgentRecord = existing ?? { id, name: '', directory: input.directory, messaging: 'off', wakes: 0 };
		record.directory = input.directory;
		if (input.messaging !== undefined) {
			record.messaging = input.messaging;
		}
		if (input.readOnly !== undefined) {
			record.readOnly = input.readOnly;
		}
		if (input.name !== undefined || !record.name) {
			record.name = this.uniqueName(input.name || 'agent', id);
		}
		this.state.agents[id] = record;
		await this.changed();
		return record;
	}

	async setMessaging(id: string, messaging: MessagingMode): Promise<void> {
		const agent = this.state.agents[id];
		if (agent && agent.messaging !== messaging) {
			agent.messaging = messaging;
			await this.changed();
		}
	}

	async setReadOnly(id: string, readOnly: boolean): Promise<void> {
		const agent = this.state.agents[id];
		if (agent && !!agent.readOnly !== readOnly) {
			agent.readOnly = readOnly;
			await this.changed();
		}
	}

	/**
	 * Records that the user stopped this agent. It resolves once that is on disk, so the caller
	 * can interrupt the session afterwards: a message racing the interrupt then finds the agent
	 * stopped and does not wake it again.
	 */
	async stop(id: string): Promise<void> {
		const agent = this.state.agents[id];
		if (agent && !agent.stopped) {
			agent.stopped = true;
			await this.changed();
		}
	}

	/** A person spoke to this agent: it may be woken again, and so may the team it leads. */
	async humanTurn(id: string): Promise<void> {
		const agent = this.state.agents[id];
		if (!agent) {
			return;
		}
		const team = agent.role === 'lead' ? this.team(agent.team) : undefined;
		const reset = [agent, ...(team?.members ?? []).map(member => this.state.agents[member]).filter((member): member is AgentRecord => !!member)];
		if (!agent.stopped && reset.every(member => member.wakes === 0)) {
			return;
		}
		agent.stopped = false;
		for (const member of reset) {
			member.wakes = 0;
		}
		await this.changed();
	}

	/** Makes `leadID` the lead of a new team. */
	async createTeam(leadID: string, name: string): Promise<TeamRecord> {
		const lead = this.state.agents[leadID];
		if (!lead) {
			throw new HubError('The lead agent is not registered.');
		}
		const team: TeamRecord = { id: `team_${randomBytes(6).toString('hex')}`, name: name.trim() || 'team', lead: leadID, members: [] };
		this.state.teams[team.id] = team;
		lead.team = team.id;
		lead.role = 'lead';
		lead.messaging = 'on';
		await this.changed();
		return team;
	}

	/** Follows the session's activity so `list_agents` and `wait_agent` know who is busy. */
	observe(event: OpenCodeEvent): void {
		const id = typeof event.data?.sessionID === 'string' ? event.data.sessionID : undefined;
		if (!id || !this.state.agents[id]) {
			return;
		}
		if (event.type === 'session.execution.started') {
			this.setStatus(id, 'running');
		} else if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
			this.setStatus(id, 'idle');
		} else if (event.type === 'permission.asked') {
			this.setStatus(id, 'waiting');
		} else if (this.status.get(id) === 'waiting' && (event.type.startsWith('session.tool.') || event.type === 'session.text.delta')) {
			this.setStatus(id, 'running');
		}
	}

	/** Whether the hub's tools are offered to this session at all. */
	offered(sessionID: string): boolean {
		return (this.state.agents[sessionID]?.messaging ?? 'off') !== 'off';
	}

	/** Runs one tool call. `senderID` is the session OpenCode ran the tool in. */
	async call(tool: string, senderID: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
		const sender = this.state.agents[senderID];
		if (!sender || sender.messaging === 'off') {
			throw new HubError('Agent messaging is off for this agent. The user turns it on with the Messages chip in the chat composer.');
		}
		switch (tool) {
			case 'list_agents':
				return this.listAgents(sender);
			case 'send_message':
				return this.sendMessage(sender, text(input.to, 'to'), text(input.message, 'message'));
			case 'wait_agent':
				return this.waitAgent(sender, text(input.agent, 'agent'), typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : 120, signal);
			case 'spawn_teammate':
				return this.spawnTeammate(sender, text(input.name, 'name'), text(input.prompt, 'prompt'), typeof input.agent === 'string' ? input.agent : undefined);
			default:
				throw new HubError(`Unknown tool ${tool}.`);
		}
	}

	private listAgents(sender: AgentRecord): string {
		const lines = this.list().map(agent => {
			const team = this.team(agent.team);
			const notes = [
				agent.id === sender.id ? 'you' : undefined,
				team ? `${agent.role} of team "${team.name}"` : undefined,
				agent.messaging === 'muted' ? 'muted: receives messages but is not woken' : undefined,
				agent.stopped ? 'stopped by the user: not woken' : undefined,
				agent.readOnly ? 'read-only' : undefined,
			].filter(Boolean);
			return `- ${agent.name} (${agent.id}): ${this.statusOf(agent.id)}${notes.length ? ` [${notes.join('; ')}]` : ''}`;
		});
		return lines.length > 1 ? lines.join('\n') : `${lines.join('\n')}\n\nNo other agent has messaging on.`;
	}

	private async sendMessage(sender: AgentRecord, to: string, body: string): Promise<string> {
		const recipient = this.resolve(to);
		if (recipient.id === sender.id) {
			throw new HubError('An agent cannot send a message to itself.');
		}
		if (body.length > this.limits.maxMessageChars) {
			throw new HubError(`The message is ${body.length} characters; the limit is ${this.limits.maxMessageChars}. Send a summary, or write the details to a file and send its path.`);
		}
		const now = this.now();
		const key = createHash('sha256').update(`${sender.id}\n${recipient.id}\n${body}`).digest('hex');
		this.state.ledger = this.state.ledger.filter(entry => now - entry.time < this.limits.dedupWindowMs);
		if (this.state.ledger.some(entry => entry.key === key)) {
			return `${recipient.name} already has this exact message from you; it was not sent again.`;
		}
		const held = recipient.messaging === 'muted' ? 'it is muted'
			: recipient.stopped ? 'the user stopped it'
				: recipient.wakes >= this.limits.maxWakes ? `it has been woken by other agents ${recipient.wakes} times since a person last spoke to it or to its lead, which is the limit`
					: undefined;
		// The ledger and the wake count are written before the message goes out, so a crash in between cannot deliver it twice.
		const entry: LedgerEntry = { key, time: now };
		this.state.ledger.push(entry);
		if (!held) {
			recipient.wakes++;
		}
		await this.changed();
		try {
			await this.deliver(sender, recipient, body, !held);
		} catch (err) {
			// It did not go out, so the sender may try again.
			this.state.ledger = this.state.ledger.filter(other => other !== entry);
			if (!held) {
				recipient.wakes--;
			}
			await this.changed();
			throw err;
		}
		return held
			? `Message left for ${recipient.name}, but it was not woken: ${held}. It reads the message when the user next continues it. Do not send it again.`
			: `Message delivered to ${recipient.name}, which is now working on it. Its reply arrives as a message to you; wait_agent waits for it to finish.`;
	}

	private async deliver(sender: AgentRecord, recipient: AgentRecord, body: string, wake: boolean): Promise<void> {
		const idle = this.statusOf(recipient.id) === 'idle';
		if (wake) {
			// Until OpenCode reports the turn, the recipient counts as busy, so a wait_agent sent right after does not return at once.
			this.setStatus(recipient.id, 'running');
		}
		try {
			await this.host.deliver({
				sender, recipient, body, wake, idle,
				text: wrapMessage(sender, body),
				description: `From ${sender.name}`,
				metadata: { source: METADATA_SOURCE, from: sender.id, fromName: sender.name },
			});
		} catch (err) {
			if (wake) {
				this.setStatus(recipient.id, 'idle');
			}
			throw err;
		}
	}

	private async waitAgent(sender: AgentRecord, name: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
		const agent = this.resolve(name);
		if (agent.id === sender.id) {
			throw new HubError('An agent cannot wait for itself.');
		}
		const timeout = Math.min(600, Math.max(1, timeoutSeconds)) * 1000;
		if (this.statusOf(agent.id) !== 'idle') {
			await new Promise<void>(resolve => {
				const waiters = this.idleWaiters.get(agent.id) ?? new Set();
				this.idleWaiters.set(agent.id, waiters);
				const finish = () => {
					clearTimeout(timer);
					waiters.delete(finish);
					signal?.removeEventListener('abort', finish);
					resolve();
				};
				const timer = setTimeout(finish, timeout);
				waiters.add(finish);
				signal?.addEventListener('abort', finish, { once: true });
			});
		}
		const status = this.statusOf(agent.id);
		if (status !== 'idle') {
			return `${agent.name} is still ${status === 'waiting' ? 'waiting for the user to approve something' : 'running'} after ${Math.round(timeout / 1000)} seconds.`;
		}
		const reply = (await this.host.lastReply?.(agent.id).catch(() => undefined))?.trim();
		return reply
			? `${agent.name} is idle. Its last reply:\n\n${reply.length > 4000 ? `${reply.slice(0, 4000)}…` : reply}`
			: `${agent.name} is idle.`;
	}

	private async spawnTeammate(sender: AgentRecord, rawName: string, prompt: string, agent?: string): Promise<string> {
		const team = sender.role === 'lead' ? this.team(sender.team) : undefined;
		if (!team) {
			throw new HubError('Only the lead of a team can spawn teammates. The user starts a team with "Dragon: New Team".');
		}
		if (team.members.length >= this.limits.maxTeammates) {
			throw new HubError(`The team already has ${team.members.length} teammates, which is the limit.`);
		}
		if (prompt.length > this.limits.maxMessageChars) {
			throw new HubError(`The prompt is ${prompt.length} characters; the limit is ${this.limits.maxMessageChars}.`);
		}
		const name = agentName(rawName);
		if (!name) {
			throw new HubError('Give the teammate a short name, for example "tests" or "api-review".');
		}
		if (Object.values(this.state.agents).some(other => other.name === name)) {
			throw new HubError(`There is already an agent named "${name}". Choose another name.`);
		}
		// A read-only lead cannot get work done through a teammate that may write.
		const session = await this.host.createTeammate({ lead: sender, name, agent: sender.readOnly ? 'plan' : agent });
		const teammate: AgentRecord = { id: session.id, name, directory: session.directory, messaging: 'on', readOnly: sender.readOnly, team: team.id, role: 'teammate', wakes: 1 };
		this.state.agents[teammate.id] = teammate;
		team.members.push(teammate.id);
		await this.changed();
		const brief = `You are "${name}", a teammate on the team "${team.name}", led by "${sender.name}". Do the task below, then report the result to your lead with send_message (to: "${sender.name}"). Keep the report short and concrete.\n\n${prompt}`;
		await this.deliver(sender, teammate, brief, true);
		return `Teammate ${name} (${teammate.id}) started${teammate.readOnly ? ' in read-only mode, like you' : ''}. Its report arrives as a message to you; wait_agent waits for it to finish.`;
	}

	/** Finds an agent with messaging on by name or session ID. */
	private resolve(nameOrID: string): AgentRecord {
		const wanted = nameOrID.trim();
		const agents = this.list();
		const found = agents.find(agent => agent.id === wanted) ?? agents.filter(agent => agent.name === agentName(wanted));
		const agent = Array.isArray(found) ? (found.length === 1 ? found[0] : undefined) : found;
		if (!agent) {
			throw new HubError(`No agent named "${wanted}" has messaging on. Call list_agents for the names.`);
		}
		return agent;
	}

	private uniqueName(wanted: string, id: string): string {
		const base = agentName(wanted) || 'agent';
		const taken = new Set(Object.values(this.state.agents).filter(agent => agent.id !== id).map(agent => agent.name));
		let name = base;
		for (let i = 2; taken.has(name); i++) {
			name = `${base}-${i}`;
		}
		return name;
	}

	private setStatus(id: string, status: AgentStatus): void {
		if (this.statusOf(id) === status) {
			return;
		}
		this.status.set(id, status);
		if (status === 'idle') {
			for (const waiter of [...this.idleWaiters.get(id) ?? []]) {
				waiter();
			}
		}
		this.fire();
	}

	private fire(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// a listener's failure is its own
			}
		}
	}

	private async changed(): Promise<void> {
		this.fire();
		if (!this.file) {
			return;
		}
		const file = this.file;
		const next = JSON.stringify(this.state, null, '\t');
		// Writes are serialized, and each is a rename, so the file is never half-written.
		this.writing = this.writing.catch(() => undefined).then(async () => {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(`${file}.tmp`, next, { encoding: 'utf8', mode: 0o600 });
			await rename(`${file}.tmp`, file);
		});
		await this.writing;
	}

	/**
	 * Starts the endpoint the OpenCode plugin calls, and writes its address and token to
	 * `addressFile` (readable by this user only) for the plugin to find.
	 */
	async listen(addressFile: string): Promise<string> {
		const server = http.createServer((req, res) => void this.handle(req, res));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await mkdir(path.dirname(addressFile), { recursive: true });
		await writeFile(addressFile, JSON.stringify({ url, token: this.token }), { encoding: 'utf8', mode: 0o600 });
		return url;
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const reply = (status: number, body: object) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(body));
		};
		const given = Buffer.from(req.headers.authorization ?? '');
		const expected = Buffer.from(`Bearer ${this.token}`);
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			return reply(401, { error: 'unauthorized' });
		}
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (req.method === 'GET' && url.pathname === '/offered') {
			return reply(200, { offered: this.offered(url.searchParams.get('session') ?? '') });
		}
		if (req.method !== 'POST' || url.pathname !== '/tool') {
			return reply(404, { error: 'not found' });
		}
		const abort = new AbortController();
		res.on('close', () => abort.abort());
		try {
			let raw = '';
			for await (const chunk of req) {
				raw += chunk;
			}
			const body = JSON.parse(raw) as { tool?: string; sessionID?: string; input?: Record<string, unknown> };
			const content = await this.call(String(body.tool), String(body.sessionID), body.input ?? {}, abort.signal);
			reply(200, { content });
		} catch (err) {
			reply(err instanceof HubError ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
		}
	}

	dispose(): void {
		this.server?.close();
		this.server?.closeAllConnections();
		this.listeners.clear();
		for (const waiters of this.idleWaiters.values()) {
			for (const waiter of [...waiters]) {
				waiter();
			}
		}
	}
}

function text(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new HubError(`"${name}" is required.`);
	}
	return value;
}
