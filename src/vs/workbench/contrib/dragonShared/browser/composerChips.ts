/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/composerChips.css';
import { addDisposableListener, EventType, h, reset } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/path.js';
import { basename as resourceBasename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/**
 * How much OpenCode may do without asking, read by the dragon-agent extension:
 *   read-only   - the plan agent runs and every permission request is denied
 *   ask         - OpenCode asks in the chat before edits and commands (default)
 *   full-access - every permission request is approved
 */
export type DragonPermissionMode = 'read-only' | 'ask' | 'full-access';
export const DRAGON_PERMISSION_SETTING = 'dragon.permissionMode';
const CYCLE: DragonPermissionMode[] = ['read-only', 'ask', 'full-access'];

const LABELS: Record<DragonPermissionMode, string> = {
	'read-only': localize('dragon.permission.readOnly', "Read-Only"),
	'ask': localize('dragon.permission.ask', "Ask"),
	'full-access': localize('dragon.permission.full', "Full Access"),
};

const GLYPHS: Record<DragonPermissionMode, string> = {
	'read-only': '\u25CB',
	'ask': '\u25D0',
	'full-access': '\u25CF',
};

const TOOLTIPS: Record<DragonPermissionMode, string> = {
	'read-only': localize('dragon.permission.readOnly.tooltip', "Read-Only: OpenCode plans and answers but may not change files or run commands. Click to switch to Ask."),
	'ask': localize('dragon.permission.ask.tooltip', "Ask: OpenCode asks in the chat before it edits files or runs commands. Click to switch to Full Access."),
	'full-access': localize('dragon.permission.full.tooltip', "Full Access: OpenCode edits files and runs commands without asking. Click to switch to Read-Only."),
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
		this.domNode.classList.remove('dragon-permission-readonly', 'dragon-permission-ask', 'dragon-permission-full');
		this.domNode.classList.add(this.current === 'read-only' ? 'dragon-permission-readonly' : this.current === 'ask' ? 'dragon-permission-ask' : 'dragon-permission-full');
		reset(this.glyph, GLYPHS[this.current]);
		reset(this.label, LABELS[this.current]);
		this.domNode.title = TOOLTIPS[this.current];
		this.domNode.setAttribute('aria-label', localize('dragon.permission.aria', "Dragon permission mode: {0}. Click to cycle.", LABELS[this.current]));
	}
}

export const DRAGON_MOVE_COMMAND = 'dragon.moveSession';

/** The composer chip showing (and changing) the directory OpenCode works in. */
export class DragonDirectoryToggle extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly label: HTMLElement;

	constructor(
		container: HTMLElement,
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
		this.refresh();
	}

	private refresh(): void {
		const configured = this.configurationService.getValue<string>('dragon.workingDirectory')?.trim();
		const folder = this.contextService.getWorkspace().folders[0];
		const name = configured ? basename(configured) : folder ? resourceBasename(folder.uri) : localize('dragon.directory.none', "Home");
		const where = configured || folder?.uri.fsPath;
		reset(this.label, name);
		this.domNode.title = where
			? localize('dragon.directory.tooltip', "OpenCode works in {0}. Click to choose another directory for new sessions.", where)
			: localize('dragon.directory.tooltipNone', "No folder is open, so OpenCode works in your home directory. Click to choose a project directory.");
	}
}
