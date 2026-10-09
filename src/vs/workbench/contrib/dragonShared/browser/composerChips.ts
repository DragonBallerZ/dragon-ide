/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/composerChips.css';
import { addDisposableListener, EventType, getActiveWindow, h, reset, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { basename as resourceBasename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/**
 * How much OpenCode may do without asking, and whether it is kept to the open project, read by the
 * dragon-agent extension:
 *   read-only   - the plan agent runs and every permission request is denied; project only
 *   ask         - OpenCode asks in the chat before edits and commands (default); project only
 *   project     - OpenCode edits and runs commands without asking, but only inside the open project
 *   full-access - OpenCode edits and runs commands without asking, across the whole disk
 */
export type DragonPermissionMode = 'read-only' | 'ask' | 'project' | 'full-access';
export const DRAGON_PERMISSION_SETTING = 'dragon.permissionMode';
const CYCLE: DragonPermissionMode[] = ['read-only', 'ask', 'project', 'full-access'];

const LABELS: Record<DragonPermissionMode, string> = {
	'read-only': localize('dragon.permission.readOnly', "Read-Only"),
	'ask': localize('dragon.permission.ask', "Ask"),
	'project': localize('dragon.permission.project', "Project Only"),
	'full-access': localize('dragon.permission.full', "Full Access"),
};

const GLYPHS: Record<DragonPermissionMode, string> = {
	'read-only': '\u25CB',
	'ask': '\u25D0',
	'project': '\u25C9',
	'full-access': '\u25CF',
};

const TOOLTIPS: Record<DragonPermissionMode, string> = {
	'read-only': localize('dragon.permission.readOnly.tooltip', "Read-Only: OpenCode plans and answers but may not change files or run commands. Click to switch to Ask."),
	'ask': localize('dragon.permission.ask.tooltip', "Ask: OpenCode asks in the chat before it edits files or runs commands. Click to switch to Project Only."),
	'project': localize('dragon.permission.project.tooltip', "Project Only: OpenCode edits files and runs commands without asking, but only inside the open project, never the rest of your disk. Click to switch to Full Access."),
	'full-access': localize('dragon.permission.full.tooltip', "Full Access: OpenCode edits files and runs commands without asking, and can reach your whole disk. Click to switch to Read-Only."),
};

/** The composer chip that cycles the Dragon permission mode. */
export class DragonPermissionToggle extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly glyph: HTMLElement;
	private readonly label: HTMLElement;
	private current: DragonPermissionMode = 'ask';

	constructor(
		container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const layout = h('button.dragon-chip.dragon-permission-toggle@root', [
			h('span.dragon-chip-glyph@glyph'),
			h('span.dragon-chip-label@label'),
		]);
		this.domNode = layout.root as HTMLButtonElement;
		this.domNode.type = 'button';
		this.glyph = layout.glyph;
		this.label = layout.label;

		this._register(addDisposableListener(this.domNode, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			const next = CYCLE[(CYCLE.indexOf(this.current) + 1) % CYCLE.length];
			void this.configurationService.updateValue(DRAGON_PERMISSION_SETTING, next, ConfigurationTarget.WORKSPACE).catch(() => undefined);
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(DRAGON_PERMISSION_SETTING)) {
				this.refresh();
			}
		}));
		container.appendChild(this.domNode);
		this.refresh();
	}

	private refresh(): void {
		const raw = this.configurationService.getValue<string>(DRAGON_PERMISSION_SETTING);
		this.current = CYCLE.includes(raw as DragonPermissionMode) ? raw as DragonPermissionMode : 'ask';
		this.domNode.classList.remove('dragon-permission-readonly', 'dragon-permission-ask', 'dragon-permission-project', 'dragon-permission-full');
		this.domNode.classList.add(this.current === 'read-only' ? 'dragon-permission-readonly' : this.current === 'ask' ? 'dragon-permission-ask' : this.current === 'project' ? 'dragon-permission-project' : 'dragon-permission-full');
		reset(this.glyph, GLYPHS[this.current]);
		reset(this.label, LABELS[this.current]);
		this.domNode.title = TOOLTIPS[this.current];
		this.domNode.setAttribute('aria-label', localize('dragon.permission.aria', "Dragon permission mode: {0}. Click to cycle.", LABELS[this.current]));
	}
}

export const DRAGON_MOVE_COMMAND = 'dragon.moveSession';

/** Where a composer chip finds the chat it belongs to. */
export interface DragonChatSource {
	sessionResource(): URI | undefined;
}

export const DRAGON_SESSION_DIRECTORY_COMMAND = 'dragon.agents.directory';
const CHAT_REFRESH_MS = 3000;

/**
 * Has every chat's chips read their state again. The extension runs it when a chat gets its
 * session or an agent changes, which the chips would otherwise learn at their next refresh.
 */
export const DRAGON_REFRESH_CHIPS_COMMAND = '_dragon.chat.refreshChips';
const onDidRequestRefresh = new Emitter<void>();
CommandsRegistry.registerCommand(DRAGON_REFRESH_CHIPS_COMMAND, () => onDidRequestRefresh.fire());

/**
 * The composer chip showing the directory this chat's agent works in (a worktree of its own for an
 * agent started with New Agent), and changing the directory new sessions work in.
 */
export class DragonDirectoryToggle extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly label: HTMLElement;
	private generation = 0;

	constructor(
		container: HTMLElement,
		private readonly source: DragonChatSource,
		@ICommandService private readonly commandService: ICommandService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const layout = h('button.dragon-chip.dragon-directory-toggle@root', [
			h('span.dragon-chip-glyph@glyph'),
			h('span.dragon-chip-label@label'),
		]);
		this.domNode = layout.root as HTMLButtonElement;
		this.domNode.type = 'button';
		layout.glyph.textContent = '\u25A6';
		this.label = layout.label;

		this._register(addDisposableListener(this.domNode, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.commandService.executeCommand(DRAGON_MOVE_COMMAND).then(undefined, () => { /* the extension reports its own failures */ });
		}));
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.refresh()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dragon.workingDirectory')) {
				this.refresh();
			}
		}));
		container.appendChild(this.domNode);
		// A chat gets its session, and with it its directory, after the composer is made.
		this._register(onDidRequestRefresh.event(() => this.refresh()));
		const timer = getActiveWindow().setInterval(() => this.refresh(), CHAT_REFRESH_MS);
		this._register(toDisposable(() => getActiveWindow().clearInterval(timer)));
		this.refresh();
	}

	/** Reads the directory again; called on a timer and when the chat changes. */
	refresh(): void {
		const sessionResource = this.source.sessionResource()?.toString();
		const generation = ++this.generation;
		const show = (own: string | undefined) => {
			if (generation === this.generation && !this._store.isDisposed) {
				this.render(own);
			}
		};
		if (!sessionResource || !this.domNode.isConnected || getActiveWindow().document.visibilityState === 'hidden') {
			show(undefined);
			return;
		}
		this.commandService.executeCommand<string | undefined>(DRAGON_SESSION_DIRECTORY_COMMAND, { sessionResource }).then(show, () => show(undefined));
	}

	/** `own` is the directory of this chat's session, once it has one. */
	private render(own: string | undefined): void {
		const configured = this.configurationService.getValue<string>('dragon.workingDirectory')?.trim();
		const folder = this.contextService.getWorkspace().folders[0];
		const name = configured ? basename(configured) : folder ? resourceBasename(folder.uri) : localize('dragon.directory.none', "Home");
		const where = configured || folder?.uri.fsPath;
		if (own && own !== where) {
			reset(this.label, basename(own));
			this.domNode.title = localize('dragon.directory.tooltipOwn', "This chat's agent works in {0}. Click to choose the directory for new sessions.", own);
			return;
		}
		reset(this.label, name);
		this.domNode.title = where
			? localize('dragon.directory.tooltip', "OpenCode works in {0}. Click to choose another directory for new sessions.", where)
			: localize('dragon.directory.tooltipNone', "No folder is open, so OpenCode works in your home directory. Click to choose a project directory.");
	}
}

/**
 * Whether this chat's agent may exchange messages with the window's other agents, as the
 * dragon-agent extension reports it:
 *   off   - it cannot send or receive, and other agents do not see it
 *   on    - it can message other agents, and their messages start a turn here (default)
 *   muted - messages for it are kept, but never start a turn
 */
export type DragonMessagingMode = 'off' | 'on' | 'muted';

/** The messaging state of one chat, from the dragon-agent extension. */
export interface DragonMessagingState {
	readonly mode: DragonMessagingMode;
	/** The name other agents use for this agent, once it has one. */
	readonly name?: string;
	/** `lead` or `teammate`, with the team's name, when the agent is on a team. */
	readonly role?: string;
	readonly team?: string;
}

export const DRAGON_MESSAGING_STATE_COMMAND = 'dragon.agents.messagingState';
export const DRAGON_MESSAGING_CYCLE_COMMAND = 'dragon.agents.cycleMessaging';

const MESSAGING_LABELS: Record<DragonMessagingMode, string> = {
	'off': localize('dragon.messaging.off', "Messages Off"),
	'on': localize('dragon.messaging.on', "Messages On"),
	'muted': localize('dragon.messaging.muted', "Messages Muted"),
};

const MESSAGING_GLYPHS: Record<DragonMessagingMode, string> = {
	'off': '\u2715',
	'on': '\u21C4',
	'muted': '\u2016',
};

const MESSAGING_TOOLTIPS: Record<DragonMessagingMode, string> = {
	'off': localize('dragon.messaging.off.tooltip', "Messages Off: this agent cannot message other agents, and they do not see it. Click to turn messages on."),
	'on': localize('dragon.messaging.on.tooltip', "Messages On: this agent can message the other agents in this window that have messages on, and a message from one of them starts a turn here. Click to mute."),
	'muted': localize('dragon.messaging.muted.tooltip', "Messages Muted: messages from other agents are kept for this agent but do not start a turn. Click to turn messages off."),
};

/** The composer chip that turns messages between agents on, mutes them, or turns them off for this chat. */
export class DragonMessagingToggle extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly glyph: HTMLElement;
	private readonly label: HTMLElement;
	private generation = 0;

	constructor(
		container: HTMLElement,
		private readonly source: DragonChatSource,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const layout = h('button.dragon-chip.dragon-messaging-toggle@root', [
			h('span.dragon-chip-glyph@glyph'),
			h('span.dragon-chip-label@label'),
		]);
		this.domNode = layout.root as HTMLButtonElement;
		this.domNode.type = 'button';
		this.glyph = layout.glyph;
		this.label = layout.label;

		this._register(addDisposableListener(this.domNode, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this.request(DRAGON_MESSAGING_CYCLE_COMMAND);
		}));
		container.appendChild(this.domNode);
		// On is the default, until the extension says otherwise; a chip that cannot ask shows Off.
		this.render({ mode: 'on' });
		// The state also changes from outside the chip: a chat New Agent opened gets its session, a new
		// team, a teammate the lead spawned. The extension says when; the timer catches what it misses.
		this._register(onDidRequestRefresh.event(() => this.refresh()));
		const timer = getActiveWindow().setInterval(() => this.refresh(), CHAT_REFRESH_MS);
		this._register(toDisposable(() => getActiveWindow().clearInterval(timer)));
		// The input is not in the page yet when the chip is made, so it asks once it is.
		this._register(scheduleAtNextAnimationFrame(getActiveWindow(), () => this.refresh()));
	}

	/** Reads the state again; called on a timer and when the chat changes. */
	refresh(): void {
		if (this.domNode.isConnected && getActiveWindow().document.visibilityState !== 'hidden') {
			this.request(DRAGON_MESSAGING_STATE_COMMAND);
		}
	}

	private request(command: string): void {
		const sessionResource = this.source.sessionResource()?.toString();
		const generation = ++this.generation;
		const show = (state: DragonMessagingState | undefined) => {
			if (generation === this.generation && !this._store.isDisposed) {
				this.render(state);
			}
		};
		this.commandService.executeCommand<DragonMessagingState | undefined>(command, { sessionResource }).then(show, () => show(undefined));
	}

	private render(state: DragonMessagingState | undefined): void {
		const mode: DragonMessagingMode = state?.mode === 'on' || state?.mode === 'muted' ? state.mode : 'off';
		this.domNode.classList.remove('dragon-messaging-off', 'dragon-messaging-on', 'dragon-messaging-muted');
		this.domNode.classList.add(`dragon-messaging-${mode}`);
		reset(this.glyph, MESSAGING_GLYPHS[mode]);
		// With messages on, the chip shows the name other agents call this one.
		reset(this.label, mode !== 'off' && state?.name ? state.name : MESSAGING_LABELS[mode]);
		const identity = state?.name && mode !== 'off'
			? state.team && state.role
				? localize('dragon.messaging.identityTeam', "Other agents know this agent as \"{0}\" ({1} of team \"{2}\").", state.name, state.role, state.team)
				: localize('dragon.messaging.identity', "Other agents know this agent as \"{0}\".", state.name)
			: undefined;
		this.domNode.title = identity ? `${MESSAGING_TOOLTIPS[mode]}\n${identity}` : MESSAGING_TOOLTIPS[mode];
		this.domNode.setAttribute('aria-label', localize('dragon.messaging.aria', "Dragon agent messages: {0}. Click to cycle.", MESSAGING_LABELS[mode]));
	}
}
