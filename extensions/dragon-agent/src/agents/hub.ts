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
import { METADATA_SOURCE, ownWords, Reply, wrapMessage } from './message';

/** Off: cannot send, receive or be listed. On: full messaging. Muted: receives, but is never woken. */
export type MessagingMode = 'off' | 'on' | 'muted';

export type AgentStatus = 'idle' | 'running' | 'waiting';

export interface AgentRecord {
	/** The OpenCode session ID. */
	readonly id: string;
	name: string;
	directory: string;
	messaging: MessagingMode;
	/**
	 * The user set `messaging` (with the Messages chip, or by merging the agent's worktree), so the
	 * default does not change it. Without it, an agent whose chat is open has messaging on.
	 */
	messagingChosen?: boolean;
	/** Set when the user stopped the agent; cleared by the user's next message to it. */
	stopped?: boolean;
	/** The agent runs under the Read-Only rules, and so does every teammate it spawns. */
	readOnly?: boolean;
	team?: string;
	role?: 'lead' | 'teammate';
	/** What the user made the agent for (`/create-agent artist Draws the sprites`); it and its team are told with the roster. */
	purpose?: string;
	/** The branch of the Git worktree New Agent made for the agent: what it writes reaches the main working tree only when the user merges the branch. */
	branch?: string;
	/** Wakes caused by other agents since a person last spoke to this agent, its team's lead, or an agent that woke it. */
	wakes: number;
	/** The agents that woke this one since its wakes were last reset: a person speaking to one of them resets them again. */
	wokenBy?: string[];
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
}

/** What the hub needs from its surroundings: OpenCode, and (in the IDE) the chat editors. */
export interface HubHost {
	deliver(delivery: Delivery): Promise<void>;
	/** Creates the OpenCode session for a new teammate, under the lead's permission ceiling. */
	createTeammate(input: { readonly lead: AgentRecord; readonly name: string; readonly agent?: string }): Promise<{ readonly id: string; readonly directory: string }>;
	/** The agent's most recent reply (written at or after `since`), for `wait_agent` and the answer to a message. */
	lastReply?(sessionID: string, since?: number): Promise<Reply | undefined>;
	/**
	 * Tells the hub which chats are open (`setOpen`), so that an agent is answered with the chats
	 * open now, including ones opened since it last asked.
	 */
	sync?(): Promise<void>;
}

/** A refusal the calling agent should read, as opposed to a bug. */
export class HubError extends Error { }

export const HUB_TOOLS = ['list_agents', 'send_message', 'wait_agent', 'spawn_teammate'] as const;
export type HubTool = typeof HUB_TOOLS[number];

const NAME_PATTERN = /[^a-z0-9._-]+/g;

/** Longest part a teammate made for a role can be given: the roster carries it in every request. */
const MAX_PURPOSE_CHARS = 500;

/** The tools whose `path` (or `filePath`) input is the file they change. */
const FILE_TOOLS = new Set(['write', 'edit']);

/** A file a patch changes: `*** Add File: path`, `*** Update File: path`, `*** Delete File: path` or `*** Move to: path`. */
const PATCHED_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (?<file>.+)$/;

/**
 * The files a tool call changes. write and edit name one; the patch tool, which OpenCode gives
 * GPT-5 models in their place, names each in its text.
 */
function changedFiles(tool: string, input: Record<string, unknown>): string[] {
	if (tool === 'patch' || tool === 'apply_patch') {
		const text = typeof input.patchText === 'string' ? input.patchText : '';
		return text.split('\n').flatMap(line => {
			const file = PATCHED_FILE.exec(line.trim())?.groups?.file.trim();
			return file ? [file] : [];
		});
	}
	const file = input.path ?? input.filePath;
	return FILE_TOOLS.has(tool) && typeof file === 'string' && file ? [file] : [];
}

/** Most files the roster lists for one agent: the latest ones. */
const MAX_FILES_SHOWN = 6;

/** Most of an agent's tool calls a lead is shown when its wait_agent runs out: the latest ones. */
const CALLS_SHOWN = 3;

/**
 * Longest wait_agent waits, in seconds. OpenCode calls the hub with Bun's fetch, which gives up on an
 * answer after 360 s ("The operation timed out."): a team-demo lead that asked for 600 s twice got
 * that error, not what the agent was doing.
 */
const MAX_WAIT_SECONDS = 300;
/** How many inbox items the hub remembers a step started after, for `endWaits` to hear of late. */
const READ_KEPT = 100;

/** Most characters of an agent's reply a lead is shown. */
const MAX_REPLY_SHOWN = 4000;

/** What the roster says an agent is doing. */
const DOING: Record<AgentStatus, string> = { idle: 'idle', running: 'working', waiting: 'waiting for the user to approve something' };

/**
 * How the roster ends: another agent's request is work to do, in the agent's own folder. Asked to
 * "name the hero", a small model looked for a hero's name instead, across the disk and the web;
 * given index.html to write, one wrote the game's style sheet and script too. Each agent writing one
 * of a game's files wrote it as its first step, and the script drew on a canvas of its own, under
 * the empty one of the page written just before it: a lead does not always say the names the parts
 * share, so the agent writing a part reads the others once its own is written.
 */
const WORK_FROM_OTHERS = 'A message from another agent asks for work, as the user\'s messages do: what it asks you to make, such as a name, an idea or code, is yours to make up or write, not to look for. What it needs from the files is in your folder unless it says where else to look: do not search the rest of the disk or the web for it. When it gives you files to change, change only those: other agents may be writing the rest. Once yours are written, read the files yours work with, such as the page a script draws on, and change yours to fit the names they use (files, element ids, functions).';

/**
 * Told to an agent that hands out work. Told by the user to have three agents write a game's
 * index.html, style.css and game.js, the lead sent each its file alone, and each guessed the
 * others: the style sheet styled ids the page did not have, and the script drew on a canvas of
 * its own under the page's empty one. Another lead, finding the script inside index.html, wrote
 * all three files itself. Two leads, told they could have one agent make its part first, sent the
 * page's agent its part and waited for it: it wrote all three files, and the lead sent the other
 * two nothing.
 */
const PARTS_OF_ONE = 'When agents each make a part of one thing, such as the files of one program, first settle the names the parts share (files, element ids, functions), then send each of them its part with the same list before you wait for any of them: an agent working alone makes the whole thing. List the files each one is to change in send_message\'s files: the other agents are then kept from changing them. When a part needs fixing, send its agent what to fix instead of changing its files yourself.';

/** A file an agent was given to change with send_message's `files`. */
interface HandedOut {
	/** The agent given the file. */
	readonly owner: string;
	/** The agent that gave it. */
	readonly by: string;
	/** The file's full path, spelled as it was given. */
	readonly file: string;
	/** When it was given. */
	readonly time: number;
}

/** A short name agents can type: lowercase letters, digits, dots, dashes and underscores. */
export function agentName(value: string): string {
	return value.toLowerCase().trim().replace(NAME_PATTERN, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export class AgentHub {
	private state: HubState = { version: 1, agents: {}, teams: {}, ledger: [] };
	private readonly status = new Map<string, AgentStatus>();
	/** The agents whose chat is open in the window; unknown (everyone counts as open) until the host says. */
	private open: ReadonlySet<string> | undefined;
	private readonly listeners = new Set<() => void>();
	private readonly idleWaiters = new Map<string, Set<() => void>>();
	/**
	 * The agents whose message woke an agent, by its ID, with when each message went out: the answer
	 * its turn ends with goes back to them.
	 */
	private readonly owed = new Map<string, Map<string, number>>();
	/** `wait_agent` calls in progress, as `<waiter>><agent>`; the waiter gets the answer from the call. */
	private readonly waiting = new Map<string, number>();
	/** By agent ID, ends each `wait_agent` call it is making: a person writing to it ends them. */
	private readonly waitsOf = new Map<string, Set<() => void>>();
	/**
	 * By agent ID, the inbox items a person wrote to it that no step of its model has read: a
	 * `wait_agent` call it makes meanwhile was written before the message was in its conversation, and
	 * ends at once. Otherwise, the user writing while the lead's model wrote a step that waits, the lead
	 * read the message only once the wait was over, up to 300 s later.
	 */
	private readonly unread = new Map<string, Set<string>>();
	/** By agent ID, the inbox items OpenCode put in its conversation since its last step started. */
	private readonly delivered = new Map<string, string[]>();
	/** The inbox items a step started after lately, the last `READ_KEPT`: one can be read before `endWaits` hears of it. */
	private readonly read = new Set<string>();
	/** The teams of teammates whose sessions are being created, by name: the name and the place are theirs already. */
	private readonly joining = new Map<string, string>();
	/** The debts of the agents whose answer the hub is reading; a wait_agent that returns the reply settles one. */
	private readonly answering = new Map<string, Map<string, number>>();
	/** The agents each agent has answered with send_message in its current turn: what else it sends them in that turn is part of the answer. */
	private readonly answered = new Map<string, Set<string>>();
	/**
	 * By agent ID, the agent whose request started its current turn, until a person speaks to it. Set to
	 * work by main in a team-demo run on Nemotron, agent-2 asked the user with the question tool whether
	 * its file was ready: its turn waited on the card, which covered the chat main was in, while both
	 * of main's waits for it ran out.
	 */
	private readonly startedBy = new Map<string, string>();
	/**
	 * When each agent last sent each other agent a message with send_message or spawn_teammate, as
	 * `<sender>><recipient>`: what the recipient wrote before it is not a reply to it. Given an agent's
	 * reply from an earlier step after the agent's turn on its new message ended with no text,
	 * Nemotron as lead took it for the new answer and wrote the agent's file itself.
	 */
	private readonly sentAt = new Map<string, number>();
	/** The ledger key of the last message each agent sent each other agent with send_message, keyed as `sentAt` is. */
	private readonly lastSent = new Map<string, string>();
	/**
	 * The error each agent's last turn stopped with, by ID, until its next turn starts. On the free
	 * Nemotron, rate-limited, an agent's turn failed after "Let me search for the game's level files.",
	 * and its lead was given that line as its answer.
	 */
	private readonly failure = new Map<string, string>();
	/**
	 * The agents whose last turn was stopped, as the user stops one, until their next turn starts. A
	 * lead waiting for one was given the line its turn stopped after, "Let me search the disk for the
	 * level files.", as its reply.
	 */
	private readonly interrupted = new Set<string>();
	/** The tool each running call of an agent is, by call ID: OpenCode names it only when the call's input starts. */
	private readonly calling = new Map<string, string>();
	/** The agent or subagent session each subagent's child session was started from. */
	private readonly parents = new Map<string, string>();
	/** The files each running write, edit or patch call of an agent changes, by call ID. */
	private readonly changing = new Map<string, string[]>();
	/** How many tool calls each agent made in its current turn, and the latest ones, for a lead whose wait_agent runs out. */
	private readonly turnCalls = new Map<string, { readonly count: number; readonly latest: readonly string[] }>();
	/** The files each agent changed since a person last spoke to an agent, for the roster. */
	private readonly wrote = new Map<string, string[]>();
	/** The files agents were given to change with send_message since a person last spoke to an agent, by `fileKey`. */
	private readonly handedOut = new Map<string, HandedOut>();
	/** The files given with messages still going out: until the message is delivered, its recipient may not read as working yet. */
	private readonly giving = new Set<HandedOut>();
	/** When each agent's wait_agent for each other agent last returned, keyed as `sentAt` is. */
	private readonly waitedAt = new Map<string, number>();
	/** When each agent's last turn ended, by ID. */
	private readonly endedAt = new Map<string, number>();
	/** When each agent's last turn that failed or was stopped ended, by ID. */
	private readonly failedAt = new Map<string, number>();
	/** The files whose giver was refused a change once: its next change takes the file back. */
	private readonly refusedOnce = new Set<string>();
	/** The tool call that last changed each file, and the one with which each agent last read it, by `fileKey`: counted in `fileCalls`, so the later one is larger. */
	private readonly changedBy = new Map<string, number>();
	private readonly readBy = new Map<string, Map<string, number>>();
	private fileCalls = 0;
	private writing: Promise<void> = Promise.resolve();
	private server: http.Server | undefined;
	private readonly token = randomBytes(24).toString('base64url');

	constructor(
		private readonly host: HubHost,
		/** Where the registry is kept. Without it the hub is in-memory only. */
		private readonly file?: string,
		private limits: HubLimits = DEFAULT_LIMITS,
		private readonly now: () => number = Date.now,
		/** Whether file names that differ only in case name one file, as on the disks macOS and Windows make by default. */
		private readonly ignoreCase = process.platform !== 'linux',
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

	/** The lead of the team an agent is on, which is the agent itself when it leads one. */
	leadOf(id: string): AgentRecord | undefined {
		const team = this.team(this.state.agents[id]?.team);
		return team && this.state.agents[team.lead];
	}

	/** Every agent with messaging on or muted. */
	list(): AgentRecord[] {
		return Object.values(this.state.agents).filter(agent => agent.messaging !== 'off');
	}

	/** Whether an agent already has this name, which names are matched by. */
	nameTaken(name: string): boolean {
		return this.joining.has(agentName(name)) || Object.values(this.state.agents).some(agent => agent.name === agentName(name));
	}

	statusOf(id: string): AgentStatus {
		return this.status.get(id) ?? 'idle';
	}

	/**
	 * Adds an agent, or updates the one already registered for this session. `messagingChosen` says
	 * the user chose `messaging` with the Messages chip, as `setMessaging` does.
	 */
	async register(id: string, input: { name?: string; directory: string; messaging?: MessagingMode; messagingChosen?: boolean; readOnly?: boolean; branch?: string }): Promise<AgentRecord> {
		const existing = this.state.agents[id];
		const record: AgentRecord = existing ?? { id, name: '', directory: input.directory, messaging: 'off', wakes: 0 };
		record.directory = input.directory;
		if (input.messaging !== undefined) {
			record.messaging = input.messaging;
		}
		if (input.messagingChosen) {
			record.messagingChosen = true;
		}
		if (input.readOnly !== undefined) {
			record.readOnly = input.readOnly;
		}
		if (input.branch !== undefined) {
			record.branch = input.branch;
		}
		if (input.name !== undefined || !record.name) {
			record.name = this.uniqueName(input.name || 'agent', id);
		}
		this.state.agents[id] = record;
		await this.changed();
		return record;
	}

	/** The user's choice of messaging mode for an agent, which opening its chat does not change. */
	async setMessaging(id: string, messaging: MessagingMode): Promise<void> {
		const agent = this.state.agents[id];
		if (agent && (agent.messaging !== messaging || !agent.messagingChosen)) {
			agent.messaging = messaging;
			agent.messagingChosen = true;
			await this.changed();
		}
	}

	/**
	 * The agents whose chat is open in the window. Each one has messaging on unless the user turned
	 * it off, so a chat can message the others the user opened; agents are told about the open ones.
	 */
	async setOpen(ids: Iterable<string>): Promise<void> {
		this.open = new Set(ids);
		const defaulted = [...this.open].map(id => this.state.agents[id]).filter((agent): agent is AgentRecord => !!agent && agent.messaging === 'off' && !agent.messagingChosen);
		for (const agent of defaulted) {
			agent.messaging = 'on';
		}
		if (defaulted.length) {
			await this.changed();
		}
	}

	/**
	 * Whether other agents are told about this one: its chat is open, or it is working anyway. A chat
	 * closed long ago is still reachable by name, but no one is told about it.
	 */
	private shown(agent: AgentRecord): boolean {
		return !this.open || this.open.has(agent.id) || this.statusOf(agent.id) !== 'idle';
	}

	/** The agents `self` is told about: its team, and the other agents with messaging on that are shown. */
	private others(self: AgentRecord): { mates: AgentRecord[]; others: AgentRecord[] } {
		const team = this.team(self.team);
		const mates = team ? [team.lead, ...team.members].filter(id => id !== self.id).map(id => this.state.agents[id]).filter((agent): agent is AgentRecord => !!agent && agent.messaging !== 'off') : [];
		const others = this.list().filter(agent => agent.id !== self.id && !mates.includes(agent) && this.shown(agent));
		return { mates, others };
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

	/**
	 * What a person wrote to this agent is in its inbox: its wait_agent calls end, so it reads the
	 * message now, not once the agents it waits for are done. Ended as the message was being sent,
	 * the lead's next step was told the user wrote and read no message from them (14 of 14 smoke-turns
	 * runs), and a lead that then waited again would not hear from the user for up to 300 s. With the
	 * message's inbox item, so do the calls the agent makes before a step of its model reads it.
	 */
	endWaits(id: string, inboxID?: string): void {
		if (inboxID && !this.read.has(inboxID)) {
			this.unread.set(id, (this.unread.get(id) ?? new Set()).add(inboxID));
		}
		for (const end of this.waitsOf.get(id) ?? []) {
			end();
		}
	}

	/**
	 * A person spoke to this agent: it may be woken again, and so may the team it leads and the agents
	 * it woke, as a chat the user told to run the agents they opened wakes them.
	 */
	async humanTurn(id: string): Promise<void> {
		const agent = this.state.agents[id];
		if (!agent) {
			return;
		}
		this.wrote.clear();
		this.handedOut.clear();
		this.refusedOnce.clear();
		// Asked by a person, an agent may send the same request again, such as to run the tests again.
		this.lastSent.clear();
		// A person is in its chat, so it may ask them.
		this.startedBy.delete(id);
		const team = agent.role === 'lead' ? this.team(agent.team) : undefined;
		const reset = [agent, ...Object.values(this.state.agents).filter(other => other !== agent && (team?.members.includes(other.id) || other.wokenBy?.includes(id)))];
		if (!agent.stopped && reset.every(member => member.wakes === 0)) {
			return;
		}
		agent.stopped = false;
		for (const member of reset) {
			member.wakes = 0;
			delete member.wokenBy;
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
		if (!id) {
			return;
		}
		const parentID = event.data.parentID;
		if (event.type === 'session.created' && typeof parentID === 'string' && !this.state.agents[id] && !this.parents.has(id) && this.agentOf(parentID)) {
			this.parents.set(id, parentID);
		}
		const agentID = this.agentOf(id);
		if (!agentID) {
			return;
		}
		if (agentID !== id) {
			// A subagent's tool calls are its agent's, and the files they change are counted as its.
			if (event.type !== 'session.execution.started') {
				this.noteTool(agentID, event);
			}
			return;
		}
		this.noteTool(id, event);
		this.noteInbox(id, event);
		if (event.type === 'session.execution.started') {
			this.setStatus(id, 'running');
			this.failure.delete(id);
			this.interrupted.delete(id);
		} else if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') {
			if (event.type === 'session.execution.failed') {
				const error = event.data.error as { readonly message?: unknown } | undefined;
				this.failure.set(id, typeof error?.message === 'string' ? error.message.trim() : '');
			} else if (event.type === 'session.execution.interrupted') {
				this.interrupted.add(id);
			}
			this.endedAt.set(id, this.now());
			if (event.type !== 'session.execution.succeeded') {
				this.failedAt.set(id, this.now());
			}
			this.setStatus(id, 'idle');
			this.answered.delete(id);
			this.startedBy.delete(id);
			void this.answer(id, event.type === 'session.execution.succeeded' ? 'succeeded' : event.type === 'session.execution.failed' ? 'failed' : 'interrupted');
		} else if (event.type === 'permission.asked') {
			this.setStatus(id, 'waiting');
		} else if (this.status.get(id) === 'waiting' && (event.type.startsWith('session.tool.') || event.type === 'session.text.delta')) {
			this.setStatus(id, 'running');
		}
	}

	/** Notes which inbox items each agent's model has read: those in its conversation when a step starts. */
	private noteInbox(id: string, event: OpenCodeEvent): void {
		if (event.type === 'session.inbox.delivered' && typeof event.data.inboxID === 'string') {
			this.delivered.set(id, [...this.delivered.get(id) ?? [], event.data.inboxID]);
			return;
		}
		const ended = event.type === 'session.execution.succeeded' || event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted';
		if (event.type !== 'session.step.started' && !ended) {
			return;
		}
		for (const inboxID of this.delivered.get(id) ?? []) {
			this.read.add(inboxID);
			this.unread.get(id)?.delete(inboxID);
		}
		this.delivered.delete(id);
		for (const inboxID of this.read) {
			if (this.read.size <= READ_KEPT) {
				break;
			}
			this.read.delete(inboxID);
		}
		// A message not delivered yet is delivered before the next run's first step, which reads it.
		if (ended || !this.unread.get(id)?.size) {
			this.unread.delete(id);
		}
	}

	/**
	 * Notes an agent's tool calls: how many it made in its turn and the latest ones, for a lead whose
	 * wait_agent runs out, and the file a write or edit call changed, once it succeeds. Told only that
	 * an agent was still running, Nemotron as lead waited again in five team-demo runs of fifteen, in
	 * three meaning to "check what they're doing"; in one, the agent spent four minutes searching the
	 * disk for the level name it was asked to make up. Told only what each agent was given, a lead
	 * could not see an agent write a file it gave another, nor an agent see the page another had
	 * written for the script it was writing.
	 */
	private noteTool(id: string, event: OpenCodeEvent): void {
		if (event.type === 'session.execution.started') {
			this.turnCalls.delete(id);
			return;
		}
		const call = typeof event.data.id === 'string' ? event.data.id : undefined;
		if (!call) {
			return;
		}
		// OpenCode names the tool when its input starts, and gives the input, without the name, when it is called.
		if (event.type === 'session.tool.input.started') {
			this.calling.set(call, String(event.data.name ?? ''));
		} else if (event.type === 'session.tool.called') {
			const name = this.calling.get(call) ?? '';
			const input = (event.data.input ?? {}) as Record<string, unknown>;
			const turn = this.turnCalls.get(id);
			this.turnCalls.set(id, { count: (turn?.count ?? 0) + 1, latest: [...turn?.latest ?? [], callLine(name, input, this.state.agents[id].directory)].slice(-CALLS_SHOWN) });
			const files = changedFiles(name, input);
			if (files.length) {
				this.changing.set(call, files);
			}
		} else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
			this.calling.delete(call);
			const files = this.changing.get(call) ?? [];
			this.changing.delete(call);
			if (event.type === 'session.tool.success') {
				const directory = this.state.agents[id].directory;
				for (const file of files) {
					const key = this.fileKey(directory, file);
					this.wrote.set(id, [...(this.wrote.get(id) ?? []).filter(other => this.fileKey(directory, other) !== key), path.resolve(directory, file)]);
					this.changedBy.set(key, ++this.fileCalls);
				}
			}
		}
	}

	/** Whether the hub's tools are offered to this session at all. */
	offered(sessionID: string): boolean {
		return (this.state.agents[sessionID]?.messaging ?? 'off') !== 'off';
	}

	/**
	 * What an agent with messaging on is told before each of its model requests: who it is, who it
	 * can message, and what each of them is doing, so a model need not think of calling list_agents.
	 * Undefined when it has nobody to message.
	 */
	roster(sessionID: string): string | undefined {
		const self = this.state.agents[sessionID];
		if (!self || self.messaging === 'off') {
			return undefined;
		}
		// An agent New Agent gave a worktree of its own changes files there, not in this agent's folder.
		const line = (agent: AgentRecord) => `- ${agent.name}${agent.purpose ? ` (${agent.purpose})` : ''}: ${agent.stopped ? 'stopped by the user' : agent.messaging === 'muted' ? 'muted: gets messages but is not woken by them' : DOING[this.statusOf(agent.id)]}${agent.directory === self.directory ? '' : this.elsewhereLine(agent)}${this.givenLine(agent.id, self.directory)}${this.wroteLine(agent.id, self.directory)}`;
		const team = this.team(self.team);
		const { mates, others } = this.others(self);
		const parts: string[] = [];
		if (team && self.role === 'lead') {
			parts.push(mates.length
				? `You are "${self.name}", the lead of the team "${team.name}". Your teammates:\n${mates.map(line).join('\n')}\nA teammate sees only what you send it: give each one a self-contained task with send_message (to: its name) that says what the work is for, what you want back, and which files are its to change. Teammates report back to you with messages, and you answer their questions with send_message; use wait_agent when you have nothing else to do.`
				: `You are "${self.name}", the lead of the team "${team.name}", which has no teammates yet. Start them with spawn_teammate, one self-contained task each.`);
		} else if (team) {
			const lead = this.state.agents[team.lead]?.name ?? 'lead';
			// Told at each step to report the result, three of four Nemotron teammates /team started in a
			// team-demo run reported it again and again in one turn, of 83, 56 and 51 steps. The lead writing
			// again makes the teammate owe it an answer again.
			const reported = !!this.answered.get(self.id)?.has(team.lead) && !this.owed.get(self.id)?.has(team.lead);
			parts.push(`You are "${self.name}", a teammate on the team "${team.name}", led by "${lead}".${self.purpose ? ` Your part: ${self.purpose}` : ''} ${reported
				? `You have sent "${lead}" your report in this turn. Do not send it again: end your turn now. When "${lead}" writes to you, its message starts a new turn for you.`
				: `Do what your lead sends you, then report the result to it with send_message (to: "${lead}"). When something is unclear, ask your lead the same way, not the user.`} Your team:\n${mates.map(line).join('\n')}`);
		}
		if (others.length) {
			parts.push(`${team ? 'Agents outside your team' : `You are "${self.name}". Other agents`} you can message with send_message (to: the name):\n${others.map(line).join('\n')}\nThey see only the messages you send them, not this chat: say what the work is for, what you want back and which files are its to change, and answer their questions with send_message.`);
		}
		if (parts.length) {
			if (self.role !== 'teammate') {
				parts.push(PARTS_OF_ONE);
			}
			parts.push(WORK_FROM_OTHERS, ...this.fitLines(self));
		}
		return parts.length ? `<system-reminder>\n${parts.join('\n\n')}\n</system-reminder>` : undefined;
	}

	/**
	 * Where an agent works when it is not in the reader's folder. In a Git repository, three agents
	 * opened with New Agent each wrote their file of a game in a worktree of their own, and main,
	 * told only that they worked in other folders, read the files there and told the user the game
	 * was ready, while the user's folder had none of them.
	 */
	private elsewhereLine(agent: AgentRecord): string {
		return agent.branch
			? `; works in its own Git worktree, ${agent.directory}, on the branch ${agent.branch}: its files reach your folder only when the user merges its work with Merge Agent's Work and Remove Its Worktree`
			: `; works in ${agent.directory}, not in your folder`;
	}

	/**
	 * For an agent given files, the files the same agent gave others that changed since it last read
	 * them. Told in every request to read the files theirs work with once theirs were written, the
	 * agents writing a game's page, style sheet and script for main each wrote theirs as their first
	 * step, and the script's agent ended its turn without reading the page: the script drew on a
	 * canvas of its own under the page's empty one.
	 */
	private fitLines(self: AgentRecord): string[] {
		const handed = [...this.handedOut];
		const reads = this.readBy.get(self.id);
		return [...new Set(handed.filter(([, mine]) => mine.owner === self.id).map(([, mine]) => mine.by))].flatMap(giver => {
			const changed = handed.filter(([file, other]) => other.by === giver && other.owner !== self.id && (this.changedBy.get(file) ?? 0) > (reads?.get(file) ?? 0));
			if (!changed.length) {
				return [];
			}
			const yours = listed(handed.filter(([, mine]) => mine.by === giver && mine.owner === self.id).map(([, mine]) => shownFrom(self.directory, mine.file)));
			const theirs = listed(changed.map(([, other]) => `${this.state.agents[other.owner]?.name ?? 'another agent'}'s ${shownFrom(self.directory, other.file)}`));
			const one = changed.length === 1;
			return [`Changed since you last read ${one ? 'it' : 'them'}: ${theirs}, which ${this.state.agents[giver]?.name ?? 'another agent'} gave out with your ${yours}. Read ${one ? 'it' : 'them'} now, and make ${yours} fit the names ${one ? 'it uses' : 'they use'} (files, element ids, functions) before you reply.`];
		});
	}

	/** `; changed FILES since the user's last message`, the files named from `directory`, or nothing. */
	private wroteLine(id: string, directory: string): string {
		const files = (this.wrote.get(id) ?? []).map(file => shownFrom(directory, file));
		return files.length ? `; changed ${listed(files)} since the user's last message` : '';
	}

	/** `; given FILES to change`, the files another agent gave it with send_message, or nothing. */
	private givenLine(id: string, directory: string): string {
		const files = [...this.handedOut.values()].filter(handed => handed.owner === id).map(handed => shownFrom(directory, handed.file));
		return files.length ? `; given ${listed(files)} to change` : '';
	}

	/**
	 * An agent read `file` with OpenCode's read tool. The plugin says so before the tool returns: the
	 * event comes too late, as OpenCode sends the model the next request first.
	 */
	noteRead(sessionID: string, file: string): void {
		const agent = this.state.agents[sessionID];
		if (!agent) {
			return;
		}
		const reads = this.readBy.get(sessionID) ?? new Map<string, number>();
		reads.set(this.fileKey(agent.directory, file), ++this.fileCalls);
		this.readBy.set(sessionID, reads);
	}

	/**
	 * Why an agent may not change `file` with the write or edit tool, or undefined when it may. Since
	 * a person last spoke to an agent, another agent was given the file with send_message's `files`.
	 * The agent that gave it is refused once, and its next change takes the file back. Agents without
	 * messaging are not refused: the user runs them.
	 */
	checkChange(sessionID: string, file: string): string | undefined {
		// A subagent changes files for the agent that started it.
		sessionID = this.agentOf(sessionID) ?? sessionID;
		const agent = this.state.agents[sessionID];
		if (!agent || agent.messaging === 'off') {
			return undefined;
		}
		const key = this.fileKey(agent.directory, file);
		const handed = this.handedOut.get(key);
		if (!handed || handed.owner === sessionID) {
			return undefined;
		}
		const shown = shownFrom(agent.directory, path.resolve(agent.directory, file));
		const owner = this.state.agents[handed.owner]?.name ?? 'another agent';
		if (handed.by === sessionID) {
			if (this.refusedOnce.delete(key)) {
				this.handedOut.delete(key);
				return undefined;
			}
			this.refusedOnce.add(key);
			return `You gave ${shown} to ${owner} to change: send ${owner} what to change instead, so you do not overwrite its work. To change it yourself anyway, call the tool again.`;
		}
		const by = this.state.agents[handed.by]?.name ?? 'another agent';
		return `${shown} is ${owner}'s to change: ${by} gave it to ${owner}. Leave it to ${owner}: send ${owner} what it needs, or ask ${by}.`;
	}

	/**
	 * Why an agent may not make a write, edit, patch or question call, or undefined when it may: the
	 * first of its files `checkChange` refuses, or a question to the user in a turn another agent's
	 * request started. A file another agent gave out is checked before one this agent gave out, whose
	 * check takes it back.
	 */
	checkCall(sessionID: string, tool: string, input: Record<string, unknown>): string | undefined {
		sessionID = this.agentOf(sessionID) ?? sessionID;
		const agent = this.state.agents[sessionID];
		const waker = tool === 'question' ? this.startedBy.get(sessionID) : undefined;
		if (waker) {
			const name = this.state.agents[waker]?.name ?? 'the agent that messaged you';
			return `${name}'s message started this turn, and ${name} is waiting for your answer: a question to the user would hold the turn until someone answered it. Do not ask the user. Finish what ${name} asked, then end your turn with your answer; if something needs deciding, put the question to ${name} in that answer.`;
		}
		const files = changedFiles(tool, input);
		const ownGiving = (file: string) => !!agent && this.handedOut.get(this.fileKey(agent.directory, file))?.by === sessionID;
		for (const file of [...files.filter(file => !ownGiving(file)), ...files.filter(ownGiving)]) {
			const refused = this.checkChange(sessionID, file);
			if (refused) {
				return refused;
			}
		}
		return undefined;
	}

	/** The agent a session is, or that started it as a subagent (through any subagents of its own). */
	private agentOf(sessionID: string): string | undefined {
		for (let id: string | undefined = sessionID; id; id = this.parents.get(id)) {
			if (this.state.agents[id]) {
				return id;
			}
		}
		return undefined;
	}

	/**
	 * `file`, named from `directory`, as the hub's file maps key it. Where the disk ignores case,
	 * README.md and readme.md are one file: an agent naming another's file in other letters wrote it.
	 */
	private fileKey(directory: string, file: string): string {
		const full = path.resolve(directory, file);
		return this.ignoreCase ? full.toLowerCase() : full;
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
				return this.sendMessage(sender, text(input.to, 'to'), text(input.message, 'message'), fileList(input.files));
			case 'wait_agent':
				return this.waitAgent(sender, text(input.agent ?? input.to, 'agent'), typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : 120, signal);
			case 'spawn_teammate':
				return this.spawnTeammate(sender, text(input.name, 'name'), text(input.prompt, 'prompt'), typeof input.agent === 'string' ? input.agent : undefined);
			default:
				throw new HubError(`Unknown tool ${tool}.`);
		}
	}

	private listAgents(sender: AgentRecord): string {
		const { mates, others } = this.others(sender);
		const lines = this.list().filter(agent => agent === sender || mates.includes(agent) || others.includes(agent)).map(agent => {
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
		return lines.length > 1 ? lines.join('\n') : `${lines.join('\n')}\n\nNo other agent with messaging on is open in this window.`;
	}

	private async sendMessage(sender: AgentRecord, to: string, body: string, given: readonly string[] = []): Promise<string> {
		const recipient = this.resolve(to);
		if (recipient.id === sender.id) {
			// Nemotron, as main, sent its report for the user to "main" four times in a team-demo run.
			throw new HubError(`You are ${sender.name}: an agent cannot send a message to itself. What you write in your reply is what the user reads.`);
		}
		if (body.length > this.limits.maxMessageChars) {
			throw new HubError(`The message is ${body.length} characters; the limit is ${this.limits.maxMessageChars}. Send a summary, or write the details to a file and send its path.`);
		}
		// The recipient changes its files from its own folder. They are handed out before the message
		// goes out, as a woken agent may start writing before the delivery returns. Only the agent that
		// gave a file hands it on: in a team-demo run an agent given style.css listed it in files when it
		// asked another agent a question and when it reported to main, and was refused its own file.
		const files = new Map<string, string>();
		for (const file of given) {
			const key = this.fileKey(recipient.directory, file);
			if (!files.has(key)) {
				files.set(key, path.resolve(recipient.directory, file));
			}
		}
		const paths: (readonly [key: string, file: string])[] = [];
		const stays: string[] = [];
		const moved: string[] = [];
		const unheard = new Map<string, string[]>();
		for (const [key, file] of files) {
			const handed = this.handedOut.get(key);
			if (!handed || handed.by === sender.id) {
				// The giver is told that the agent it gave the file to before can no longer change it: in two
				// team-demo runs of 37 the lead gave one file to each of three agents in turn, and in one an
				// agent was then refused its write to it.
				if (handed && handed.owner !== recipient.id) {
					const owner = this.state.agents[handed.owner]?.name ?? 'another agent';
					if (this.atItUnheard(sender, handed)) {
						unheard.set(owner, [...unheard.get(owner) ?? [], shownFrom(sender.directory, file)]);
					} else {
						moved.push(` ${shownFrom(sender.directory, file)} was ${owner}'s: it is ${recipient.name}'s now, so ${owner} can no longer change it.`);
					}
				}
				paths.push([key, file]);
				continue;
			}
			const by = this.state.agents[handed.by]?.name ?? 'another agent';
			const owner = this.state.agents[handed.owner]?.name ?? 'another agent';
			stays.push(handed.owner === sender.id
				? ` ${shownFrom(sender.directory, file)} stays yours, as ${by} gave it to you: list in files only what ${recipient.name} is to change.`
				: ` ${shownFrom(sender.directory, file)} stays ${owner}'s, as ${by} gave it to ${owner}.`);
		}
		const yours = paths.length ? `\n\nThe files that are yours to change: ${paths.map(([, file]) => shownFrom(recipient.directory, file)).join(', ')}. Other agents are kept from changing them until the user's next message.` : '';
		if (unheard.size) {
			// Its first message sent again is refused as one, as a lead sent its first message again after it had handed its file on.
			if (await this.repeats(sender, recipient, this.messageKey(sender, recipient, `${body}${yours}`))) {
				return this.alreadyHas(sender, recipient);
			}
			// Nemotron as lead gave index.html to agent-1 and then, in the same step, to agent-2 to write, and
			// agent-1, told the file was agent-2's, stopped and asked whether there was a conflict.
			const given = [...unheard].map(([owner, shown]) => ` You gave ${shown.join(', ')} to ${owner}, which is still working and has not answered you since: ${shown.length === 1 ? 'it is' : 'they are'} ${owner}'s to change.`).join('');
			throw new HubError(`Nothing was sent to ${recipient.name}.${given} Send ${recipient.name} your message again with only the files that are its to change in files. To give ${recipient.name} ${[...unheard.values()].flat().join(', ')} instead, first wait for ${[...unheard.keys()].join(' and ')} with wait_agent.`);
		}
		const before = paths.map(([key]) => [key, this.handedOut.get(key)] as const);
		const now = this.now();
		// A message left for its recipient without waking it does not set it to work.
		const wakes = !this.held(recipient);
		const gave = paths.map(([key, file]) => {
			const handed: HandedOut = { owner: recipient.id, by: sender.id, file, time: now };
			this.handedOut.set(key, handed);
			this.refusedOnce.delete(key);
			if (wakes) {
				this.giving.add(handed);
			}
			return handed;
		});
		// A message that did not go out hands out nothing.
		const takeBack = () => {
			for (const [file, handed] of before) {
				if (handed) {
					this.handedOut.set(file, handed);
				} else {
					this.handedOut.delete(file);
				}
			}
		};
		let posted: Awaited<ReturnType<AgentHub['post']>>;
		try {
			posted = await this.post(sender, recipient, `${body}${yours}`, false);
		} catch (err) {
			takeBack();
			throw err;
		} finally {
			for (const handed of gave) {
				this.giving.delete(handed);
			}
		}
		if (posted.duplicate) {
			// Refused as a duplicate, a lead's first message sent again gave its file back to the agent it
			// had since handed it on from, which was then refused its writes, and the lead was not told.
			takeBack();
			return this.alreadyHas(sender, recipient);
		}
		const kept = `${paths.length ? ` Other agents' write and edit calls on ${paths.map(([, file]) => shownFrom(sender.directory, file)).join(', ')} are refused until the user's next message.` : ''}${moved.join('')}${stays.join('')}`;
		return posted.held ? `Message left for ${recipient.name}, but it was not woken: ${posted.held}. It reads the message when the user next continues it. Do not send it again.${kept}`
			: posted.answers ? `Answer delivered to ${recipient.name}, whose message woke you. Do not wait for ${recipient.name}: finish your turn. If it writes back, its message starts a new turn for you.${kept}`
				// Told each time that the agent "is now working on it", Nemotron as lead sent a question four
				// more times, reworded, to an agent that was searching the disk for the answer.
				: posted.busy ? `Message delivered to ${recipient.name}, which was already working: it reads the message at its next step. ${this.turnSoFar(recipient)} Its reply arrives as a message to you; wait_agent waits for it to finish.${kept}`
					: `Message delivered to ${recipient.name}, which is now working on it. Its reply arrives as a message to you; wait_agent waits for it to finish.${kept}`;
	}

	/**
	 * Whether the agent `sender` gave a file to is still at it, and `sender` has not heard from it
	 * since: it has not written to `sender`, ended a turn, or been waited for with wait_agent. Its wait
	 * run out, a lead may give the file of an agent that is stuck to another.
	 */
	private atItUnheard(sender: AgentRecord, handed: HandedOut): boolean {
		const atIt = this.statusOf(handed.owner) !== 'idle' || this.giving.has(handed);
		const heard = [this.sentAt.get(`${handed.owner}>${sender.id}`), this.endedAt.get(handed.owner), this.waitedAt.get(`${sender.id}>${handed.owner}`)].some(time => time !== undefined && time >= handed.time);
		return atIt && !heard;
	}

	/**
	 * Why a message went out only once, and what its recipient is doing. Refused a message whose
	 * recipient had answered it with a question, or was still working on it, Nemotron as lead sent it
	 * again five times running in two team-demo runs of fifteen.
	 */
	private async alreadyHas(sender: AgentRecord, recipient: AgentRecord): Promise<string> {
		const refused = `${recipient.name} already has this exact message from you, so it was not sent.`;
		const status = this.statusOf(recipient.id);
		if (status !== 'idle') {
			return `${refused} It is ${DOING[status]}: wait_agent waits for it to finish.`;
		}
		if (recipient.messaging === 'muted' || recipient.stopped) {
			return `${refused} Do not send it again.`;
		}
		const answer = await this.answerSince(sender, recipient);
		return answer.reply ? `${refused} It is idle. Its last reply:\n\n${clipped(answer.reply)}\n\n${answer.thought ? `${onlyThought(recipient.name)}\n\n` : ''}${answer.failed ? `${answer.failed}\n\n` : ''}Do not send the message again: answer what it said, or send something new.`
			: answer.silent ? `${refused} It ${answer.silent}`
				: `${refused} Do not send it again.`;
	}

	/**
	 * What `agent` wrote since `sender` last sent it a message: its reply, and whether it only repeats
	 * its thinking, or, when it wrote none, `silent`, which says so and what its last turn did, to
	 * follow its name. With no message from the sender, its last reply.
	 */
	private async answerSince(sender: AgentRecord, agent: AgentRecord): Promise<{ readonly reply?: string; readonly thought?: boolean; readonly silent?: string; readonly failed?: string }> {
		const since = this.sentAt.get(`${sender.id}>${agent.id}`);
		const read = await this.host.lastReply?.(agent.id, since).catch(() => undefined);
		const reply = read === undefined ? undefined : ownWords(agent.name, read.text) || undefined;
		const error = this.failure.get(agent.id);
		const failed = this.interrupted.has(agent.id) ? `Its last turn was stopped${agent.stopped ? ' by the user' : ''} before it finished.`
			: error === undefined ? undefined : `Its last turn stopped with an error${error ? `: ${sentence(error)}` : '.'}`;
		if (reply || since === undefined) {
			return { reply, thought: read?.thought, failed };
		}
		const wrote = (this.sentAt.get(`${agent.id}>${sender.id}`) ?? -Infinity) >= since;
		return {
			silent: wrote ? 'is idle. It wrote to you with send_message since your last message to it, and wrote no reply besides.'
				: `is idle and has not replied since your last message to it. ${failed ? `${failed} ` : ''}${this.turnSoFar(agent, true)} If you still need its answer, send it a new message saying what you need.`,
			failed,
		};
	}

	/**
	 * Delivers a message under the duplicate and wake rules. A message that wakes its recipient gets
	 * the answer its turn ends with, unless it is itself an answer: one the hub sends, or one the
	 * sender writes, in the turn it is answering, to an agent whose message woke it. So two agents
	 * do not answer each other's answers.
	 */
	private async post(sender: AgentRecord, recipient: AgentRecord, body: string, answer: boolean): Promise<{ readonly duplicate?: boolean; readonly held?: string; readonly answers?: boolean; readonly busy?: boolean }> {
		const key = this.messageKey(sender, recipient, body);
		const sent = `${sender.id}>${recipient.id}`;
		// An answer the hub sends answers a message of its own, so one that reads as the last is no repeat.
		if (!answer && await this.repeats(sender, recipient, key)) {
			return { duplicate: true };
		}
		const now = this.now();
		this.state.ledger = this.state.ledger.filter(entry => now - entry.time < this.limits.dedupWindowMs);
		// Only a message to an idle agent wakes it; a busy one reads the message at its next step.
		const idle = this.statusOf(recipient.id) === 'idle';
		const held = this.held(recipient);
		const wakes = !held && idle;
		const wokenBy = recipient.wokenBy;
		// The ledger and the wake count are written before the message goes out, so a crash in between cannot deliver it twice.
		const entry: LedgerEntry = { key, time: now };
		this.state.ledger.push(entry);
		if (wakes) {
			recipient.wakes++;
			if (!wokenBy?.includes(sender.id)) {
				recipient.wokenBy = [...wokenBy ?? [], sender.id];
			}
		}
		await this.changed();
		const answers = !answer && (!!this.owed.get(sender.id)?.has(recipient.id) || !!this.answered.get(sender.id)?.has(recipient.id));
		// Owed before it goes out: a quick turn may end before the delivery returns.
		const owes = !held && !answer && !answers && this.owe(recipient.id, sender.id, now);
		// An answer the hub sends is not the sender's own message, which a reply is read after.
		const sentBefore = this.sentAt.get(sent);
		const lastBefore = this.lastSent.get(sent);
		if (!answer) {
			this.sentAt.set(sent, now);
			this.lastSent.set(sent, key);
		}
		try {
			await this.deliver(sender, recipient, body, !held, owes);
		} catch (err) {
			// It did not go out, so the sender may try again.
			this.state.ledger = this.state.ledger.filter(other => other !== entry);
			if (wakes) {
				recipient.wakes--;
				if (wokenBy) {
					recipient.wokenBy = wokenBy;
				} else {
					delete recipient.wokenBy;
				}
			}
			if (owes) {
				this.owed.get(recipient.id)?.delete(sender.id);
			}
			// Unless a message sent since went out after it.
			if (!answer && this.lastSent.get(sent) === key) {
				if (sentBefore === undefined) {
					this.sentAt.delete(sent);
				} else {
					this.sentAt.set(sent, sentBefore);
				}
				if (lastBefore === undefined) {
					this.lastSent.delete(sent);
				} else {
					this.lastSent.set(sent, lastBefore);
				}
			}
			await this.changed();
			throw err;
		}
		if (answers) {
			// The sender answered the agent whose message woke it.
			this.owed.get(sender.id)?.delete(recipient.id);
			this.answered.set(sender.id, (this.answered.get(sender.id) ?? new Set<string>()).add(recipient.id));
		}
		return { held, answers, busy: !idle };
	}

	/** Why a message to `recipient` would be left for it without waking it, if it would be. */
	private held(recipient: AgentRecord): string | undefined {
		return recipient.messaging === 'muted' ? 'it is muted'
			: recipient.stopped ? 'the user stopped it'
				: this.statusOf(recipient.id) === 'idle' && recipient.wakes >= this.limits.maxWakes ? `it has been woken by other agents ${recipient.wakes} times since a person last spoke to it, to its lead or to an agent that woke it, which is the limit`
					: undefined;
	}

	/** The ledger key of a message from `sender` to `recipient`. */
	private messageKey(sender: AgentRecord, recipient: AgentRecord, body: string): string {
		return createHash('sha256').update(`${sender.id}\n${recipient.id}\n${body}`).digest('hex');
	}

	/** Whether the message with ledger `key` went out within the duplicate window, or is `sender`'s last to `recipient`, which still has it. */
	private async repeats(sender: AgentRecord, recipient: AgentRecord, key: string): Promise<boolean> {
		const repeat = this.lastSent.get(`${sender.id}>${recipient.id}`) === key && await this.stillHas(sender, recipient);
		const now = this.now();
		this.state.ledger = this.state.ledger.filter(entry => now - entry.time < this.limits.dedupWindowMs);
		return repeat || this.state.ledger.some(entry => entry.key === key);
	}

	/**
	 * Whether `recipient` is still at `sender`'s last message to it, or answered it in a turn that
	 * ended well, so the same message again is a repeat however long ago the first went out. Its
	 * wait_agent run out after 120 seconds, Nemotron as lead sent its question again two seconds
	 * after the agent had answered it, and the agent answered it again, in a turn of three minutes.
	 */
	private async stillHas(sender: AgentRecord, recipient: AgentRecord): Promise<boolean> {
		// A turn that failed or was stopped since may not have got to it, though another's message has set it to work again.
		if ((this.failedAt.get(recipient.id) ?? -Infinity) >= (this.sentAt.get(`${sender.id}>${recipient.id}`) ?? Infinity)) {
			return false;
		}
		if (this.statusOf(recipient.id) !== 'idle') {
			return true;
		}
		const answer = await this.answerSince(sender, recipient);
		return !!answer.reply && !answer.failed;
	}

	/** Records that `debtor` owes `creditor` the answer to a message sent at `time`. */
	private owe(debtor: string, creditor: string, time: number): boolean {
		const creditors = this.owed.get(debtor) ?? new Map<string, number>();
		this.owed.set(debtor, creditors);
		creditors.set(creditor, Math.min(creditors.get(creditor) ?? time, time));
		return true;
	}

	/**
	 * Sends the answer an agent's turn ended with to the agents whose message woke it, unless it
	 * messaged them itself or they wait for it with wait_agent, which returns the answer. A turn the
	 * user stopped answers no one.
	 */
	private async answer(id: string, ended: 'succeeded' | 'failed' | 'interrupted'): Promise<void> {
		const owed = this.owed.get(id);
		this.owed.delete(id);
		const agent = this.state.agents[id];
		if (!owed?.size || !agent || ended === 'interrupted') {
			return;
		}
		const creditors = [...owed.keys()]
			.filter(creditor => !this.waiting.has(`${creditor}>${id}`))
			.map(creditor => this.state.agents[creditor])
			.filter((creditor): creditor is AgentRecord => !!creditor && creditor.messaging !== 'off');
		if (!creditors.length) {
			return;
		}
		this.answering.set(id, owed);
		let read: Reply | undefined;
		try {
			read = await this.host.lastReply?.(id, Math.min(...owed.values())).catch(() => undefined);
		} finally {
			if (this.answering.get(id) === owed) {
				this.answering.delete(id);
			}
		}
		const reply = ownWords(agent.name, read?.text ?? '') || undefined;
		const rest = `…\n\n(The rest is in ${agent.name}'s chat.)`;
		const error = ended === 'failed' ? this.failure.get(id) : undefined;
		const why = error ? `: ${sentence(error)}` : '.';
		const body = !reply ? (ended === 'failed' ? `${agent.name} stopped with an error before it answered${why}` : `${agent.name} finished without writing an answer.`)
			: `${reply.length > this.limits.maxMessageChars ? `${reply.slice(0, Math.max(0, this.limits.maxMessageChars - rest.length))}${rest}` : reply}${read?.thought ? `\n\n(${onlyThought(agent.name)})` : ''}${ended === 'failed' ? `\n\n(${agent.name} stopped with an error after writing this${why})` : ''}`;
		// A creditor whose wait_agent returned the reply meanwhile, or that waits for it now, has it.
		for (const creditor of creditors.filter(creditor => owed.has(creditor.id) && !this.waiting.has(`${creditor.id}>${id}`))) {
			// A creditor that cannot be reached still has wait_agent and the agent's chat.
			await this.post(agent, creditor, body, true).catch(() => undefined);
		}
	}

	/** Sends a message; `request` when the recipient owes the sender an answer, so a turn it starts is the sender's. */
	private async deliver(sender: AgentRecord, recipient: AgentRecord, body: string, wake: boolean, request: boolean): Promise<void> {
		// An agent at work stays as it is: one waiting for the user to approve something read as running.
		const starts = wake && this.statusOf(recipient.id) === 'idle';
		if (starts) {
			// Until OpenCode reports the turn, the recipient counts as busy, so a wait_agent sent right after does not return at once.
			this.setStatus(recipient.id, 'running');
			this.turnCalls.delete(recipient.id);
			if (request) {
				this.startedBy.set(recipient.id, sender.id);
			}
		}
		try {
			await this.host.deliver({
				sender, recipient, body, wake,
				text: wrapMessage(sender, body),
				description: `From ${sender.name}`,
				metadata: { source: METADATA_SOURCE, from: sender.id, fromName: sender.name },
			});
		} catch (err) {
			// Only the turn the message would have started is not coming: one running already goes on.
			if (starts) {
				this.setStatus(recipient.id, 'idle');
				this.startedBy.delete(recipient.id);
			}
			throw err;
		}
	}

	private async waitAgent(sender: AgentRecord, name: string, timeoutSeconds: number, signal?: AbortSignal): Promise<string> {
		const agent = this.resolve(name);
		if (agent.id === sender.id) {
			throw new HubError('An agent cannot wait for itself.');
		}
		// In a team-demo run on Nemotron, agent-2 answered main, which was waiting for it, then waited
		// for main: neither could finish, and both waits ran out, 120 s each.
		const chain = this.waitChain(agent.id, sender.id);
		if (chain) {
			const names = chain.map(id => this.state.agents[id]?.name ?? id);
			throw new HubError(`${names[0]} is waiting for ${names.slice(1).map(name => `${name}, which is waiting for `).join('')}you with wait_agent, so ${agent.name} cannot finish before you do: waiting for it would only run out. Finish your turn instead: ${names.length === 1 ? 'its' : `${names[names.length - 1]}'s`} wait then ends with your answer. A message you send ${agent.name} is read when its wait ends.`);
		}
		const timeout = Math.min(MAX_WAIT_SECONDS, Math.max(1, timeoutSeconds)) * 1000;
		const key = `${sender.id}>${agent.id}`;
		this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1);
		const userWrote = new AbortController();
		const end = () => userWrote.abort();
		const waits = this.waitsOf.get(sender.id) ?? new Set();
		this.waitsOf.set(sender.id, waits);
		waits.add(end);
		if (this.unread.has(sender.id)) {
			end();
		}
		try {
			await this.untilIdle(agent.id, timeout, signal ? AbortSignal.any([signal, userWrote.signal]) : userWrote.signal);
		} finally {
			waits.delete(end);
			if (!waits.size) {
				this.waitsOf.delete(sender.id);
			}
			const left = (this.waiting.get(key) ?? 1) - 1;
			if (left) {
				this.waiting.set(key, left);
			} else {
				this.waiting.delete(key);
			}
		}
		this.waitedAt.set(key, this.now());
		const status = this.statusOf(agent.id);
		if (status !== 'idle' && userWrote.signal.aborted) {
			const stopped = `The user wrote to you, so you stopped waiting for ${agent.name}, which is still ${status === 'waiting' ? 'waiting for the user to approve something' : 'working'}. Answer the user`;
			// A reply comes by itself only for a message that woke the agent and was not an answer (see
			// `post`): the user ended a lead's wait for an agent it had answered, and was told otherwise.
			return this.owed.get(agent.id)?.has(sender.id) ? `${stopped}; ${agent.name}'s reply still comes to you as a message when it is done.`
				: `${stopped}. ${agent.name}'s reply does not come to you by itself: wait_agent waits for it again.`;
		}
		if (status === 'waiting') {
			return `${agent.name} is still waiting for the user to approve something after ${Math.round(timeout / 1000)} seconds.`;
		}
		if (status !== 'idle') {
			return `${agent.name} is still running after ${Math.round(timeout / 1000)} seconds. ${this.turnSoFar(agent)} A message to it reaches it at its next step: if it is not doing what you asked, send it what it is missing.`;
		}
		// The waiter gets the reply here, so the hub does not send it as an answer too.
		this.answering.get(agent.id)?.delete(sender.id);
		const answer = await this.answerSince(sender, agent);
		return answer.reply ? `${agent.name} is idle. Its last reply:\n\n${clipped(answer.reply)}${answer.thought ? `\n\n${onlyThought(agent.name)}` : ''}${answer.failed ? `\n\n${answer.failed}` : ''}`
			: answer.silent ? `${agent.name} ${answer.silent}`
				: `${agent.name} is idle.${answer.failed ? ` ${answer.failed}` : ''}`;
	}

	/** The agents through which `from` waits for `to` with wait_agent, `from` first, if it does. */
	private waitChain(from: string, to: string): string[] | undefined {
		const awaited = new Map<string, string[]>();
		for (const key of this.waiting.keys()) {
			const [waiter, other] = key.split('>');
			awaited.set(waiter, [...awaited.get(waiter) ?? [], other]);
		}
		const chains = [[from]];
		const seen = new Set([from]);
		for (let i = 0; i < chains.length; i++) {
			for (const next of awaited.get(chains[i][chains[i].length - 1]) ?? []) {
				if (next === to) {
					return chains[i];
				}
				if (!seen.has(next)) {
					seen.add(next);
					chains.push([...chains[i], next]);
				}
			}
		}
		return undefined;
	}

	/** The tool calls an agent made in its turn, or in its last one when it `ended`: how many, and the latest. */
	private turnSoFar(agent: AgentRecord, ended = false): string {
		const turn = this.turnCalls.get(agent.id);
		const calls = turn && `${turn.count} tool call${turn.count === 1 ? '' : 's'}${turn.count > turn.latest.length ? `, the last ${turn.latest.length}` : ''}: ${turn.latest.join('; ')}.`;
		return ended ? (calls ? `In its last turn it made ${calls}` : 'It made no tool calls in its last turn.')
			: calls ? `In this turn it has made ${calls}` : 'It has made no tool calls in this turn.';
	}

	/** Resolves once the agent is idle, after `timeout` ms, or when `signal` aborts. */
	private async untilIdle(id: string, timeout: number, signal?: AbortSignal): Promise<void> {
		if (this.statusOf(id) === 'idle' || signal?.aborted) {
			return;
		}
		await new Promise<void>(resolve => {
			const waiters = this.idleWaiters.get(id) ?? new Set();
			this.idleWaiters.set(id, waiters);
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

	private async spawnTeammate(sender: AgentRecord, rawName: string, prompt: string, agent?: string): Promise<string> {
		if (prompt.length > this.limits.maxMessageChars) {
			throw new HubError(`The prompt is ${prompt.length} characters; the limit is ${this.limits.maxMessageChars}.`);
		}
		const teammate = await this.addTeammate(sender.id, rawName, agent);
		const team = this.team(teammate.team)!;
		const brief = `You are "${teammate.name}", a teammate on the team "${team.name}", led by "${sender.name}". Do the task below, then report the result to your lead with send_message (to: "${sender.name}"). When something is unclear, ask your lead the same way, not the user. Keep the report short and concrete.\n\n${prompt}`;
		// The brief wakes it, and that is on disk before it goes out, as for any message.
		teammate.wakes = 1;
		await this.changed();
		const now = this.now();
		this.owe(teammate.id, sender.id, now);
		this.sentAt.set(`${sender.id}>${teammate.id}`, now);
		await this.deliver(sender, teammate, brief, true, true);
		return `Teammate ${teammate.name} (${teammate.id}) started${teammate.readOnly ? ' in read-only mode, like you' : ''}. Its report arrives as a message to you; wait_agent waits for it to finish.`;
	}

	/**
	 * `/create-agent`: starts a teammate for the team `leadID` leads, named after `role` (`artist`,
	 * then `artist-2`), whose `purpose` it and its team are told with the roster.
	 */
	async addRole(leadID: string, role: string, purpose: string): Promise<AgentRecord> {
		if (!agentName(role)) {
			throw new HubError('Give the teammate a short name, for example "tests" or "api-review".');
		}
		return this.addTeammate(leadID, this.uniqueName(role, ''), undefined, purpose);
	}

	/**
	 * Starts a teammate for the team `leadID` leads, under the lead's permission ceiling. It is idle
	 * until someone messages it.
	 */
	async addTeammate(leadID: string, rawName: string, agent?: string, purpose?: string): Promise<AgentRecord> {
		const sender = this.state.agents[leadID];
		const team = sender?.role === 'lead' ? this.team(sender.team) : undefined;
		if (!sender || !team) {
			throw new HubError('Only the lead of a team can spawn teammates. The user starts a team with "Dragon: New Team" or /team.');
		}
		const members = team.members.length + [...this.joining.values()].filter(joining => joining === team.id).length;
		if (members >= this.limits.maxTeammates) {
			throw new HubError(`The team already has ${members} teammates, which is the limit.`);
		}
		const name = agentName(rawName);
		if (!name) {
			throw new HubError('Give the teammate a short name, for example "tests" or "api-review".');
		}
		if (this.nameTaken(name)) {
			throw new HubError(`There is already an agent named "${name}". Choose another name.`);
		}
		const part = purpose?.trim();
		if (part && part.length > MAX_PURPOSE_CHARS) {
			throw new HubError(`Describe the teammate's part in at most ${MAX_PURPOSE_CHARS} characters.`);
		}
		// Two started at once, as New Agent clicked twice, would otherwise both pass the checks above.
		this.joining.set(name, team.id);
		let session: Awaited<ReturnType<HubHost['createTeammate']>>;
		try {
			// A read-only lead cannot get work done through a teammate that may write.
			session = await this.host.createTeammate({ lead: sender, name, agent: sender.readOnly ? 'plan' : agent });
		} finally {
			this.joining.delete(name);
		}
		const teammate: AgentRecord = { id: session.id, name, directory: session.directory, messaging: 'on', readOnly: sender.readOnly, team: team.id, role: 'teammate', ...(part ? { purpose: part } : {}), wakes: 0 };
		this.state.agents[teammate.id] = teammate;
		team.members.push(teammate.id);
		await this.changed();
		return teammate;
	}

	/** Finds an agent with messaging on by name or session ID. */
	private resolve(nameOrID: string): AgentRecord {
		const wanted = nameOrID.trim();
		const agents = this.list();
		const found = agents.find(agent => agent.id === wanted) ?? agents.filter(agent => agent.name === agentName(wanted));
		const agent = Array.isArray(found) ? (found.length === 1 ? found[0] : undefined) : found;
		if (!agent) {
			// Nemotron sent its report for the user to "user", then to another agent.
			throw new HubError(`No agent named "${wanted}" has messaging on. Call list_agents for the names. The user is not an agent: what you write in your reply is what the user reads.`);
		}
		return agent;
	}

	private uniqueName(wanted: string, id: string): string {
		const base = agentName(wanted) || 'agent';
		const taken = new Set([...this.joining.keys(), ...Object.values(this.state.agents).filter(agent => agent.id !== id).map(agent => agent.name)]);
		// Agents with no name of their own, as New Agent opens them, are numbered from 1 as worktree agents
		// are: three read agent-1, agent-2 and agent-3 in their tabs and to each other, not agent, agent-2.
		let name = base === 'agent' ? 'agent-1' : base;
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
		// A chat the user just opened is one the asking agent may message.
		await this.host.sync?.().catch(() => undefined);
		if (req.method === 'GET' && url.pathname === '/offered') {
			const session = url.searchParams.get('session') ?? '';
			return reply(200, { offered: this.offered(session), roster: this.roster(session) });
		}
		if (req.method !== 'POST' || (url.pathname !== '/tool' && url.pathname !== '/change' && url.pathname !== '/read')) {
			return reply(404, { error: 'not found' });
		}
		const abort = new AbortController();
		res.on('close', () => abort.abort());
		try {
			let raw = '';
			for await (const chunk of req) {
				raw += chunk;
			}
			if (url.pathname === '/change') {
				// Asked before each write, edit or patch call runs.
				const change = JSON.parse(raw) as { sessionID?: string; tool?: string; input?: Record<string, unknown> };
				return reply(200, { refused: typeof change.tool === 'string' ? this.checkCall(String(change.sessionID), change.tool, change.input ?? {}) : undefined });
			}
			if (url.pathname === '/read') {
				// Told after each read call, before the tool returns.
				const read = JSON.parse(raw) as { sessionID?: string; file?: string };
				if (typeof read.file === 'string') {
					this.noteRead(String(read.sessionID), read.file);
				}
				return reply(200, {});
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

/** A file named from `directory` when it is inside it, else its full path. */
function shownFrom(directory: string, file: string): string {
	const relative = path.relative(directory, file);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/** A reply as a lead is shown it. */
/** `text`, ending as a sentence does. */
function sentence(text: string): string {
	return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function clipped(reply: string): string {
	return reply.length > MAX_REPLY_SHOWN ? `${reply.slice(0, MAX_REPLY_SHOWN)}…` : reply;
}

/**
 * Said after a reply that only repeats its model's thinking (see `Reply.thought`). The lead is to
 * ask anew: the same message again, within the duplicate window, is refused.
 */
function onlyThought(name: string): string {
	return `${name} wrote this word for word as its thinking first, so it may be that thinking and no answer. If it does not answer you, send ${name} a new message asking again for what you need.`;
}

/** A tool call as a lead is shown it: the tool, and what it was called on, cut short. */
function callLine(name: string, input: Record<string, unknown>, directory: string): string {
	const on = [input.command, input.code, input.pattern, input.query, input.url, input.to].filter((value): value is string => typeof value === 'string');
	const file = input.path ?? input.filePath;
	if (typeof file === 'string') {
		on.push(shownFrom(directory, path.resolve(directory, file)));
	}
	const what = on.join(' ').replace(/\s+/g, ' ').trim();
	return `${name || 'a tool'}${what ? ` (${what.length > 80 ? `${what.slice(0, 80).trimEnd()}…` : what})` : ''}`;
}

/** The latest files of a list, and how many more there are. */
function listed(files: readonly string[]): string {
	const shown = files.slice(-MAX_FILES_SHOWN);
	return files.length > shown.length ? `${shown.join(', ')} and ${files.length - shown.length} more` : shown.join(', ');
}

/** send_message's `files`: the files given to the recipient to change. A model may send one as a string. */
function fileList(value: unknown): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	const list = typeof value === 'string' ? [value] : value;
	if (!Array.isArray(list) || list.some(file => typeof file !== 'string')) {
		throw new HubError('"files" is a list of the file paths the agent is to change.');
	}
	// A blank entry is no file (see the files parameter in opencodePlugin.ts).
	return list.map(file => file.trim()).filter(file => file);
}

function text(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new HubError(`"${name}" is required.`);
	}
	return value;
}
