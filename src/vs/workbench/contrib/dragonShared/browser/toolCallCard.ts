/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file

/**
 * Phase 2 - Dragon tool-call card.
 *
 * Renders a single agent tool invocation as a collapsible card:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ ▶ readFile  src/api/index.ts        [running]│
 *   └─────────────────────────────────────────────┘
 *
 * Expanded:
 *   ┌─────────────────────────────────────────────┐
 *   │ ▼ readFile  src/api/index.ts          [12ms]│
 *   │   args:  { filePath: "src/api/index.ts" }   │
 *   │   output: ┌──────────────────────────────┐  │
 *   │           │ export function handler() {…}│  │
 *   │           └──────────────────────────────┘  │
 *   └─────────────────────────────────────────────┘
 *
 * The card streams: it renders immediately on tool dispatch with
 * status = 'pending', then switches to 'running' on first delta,
 * and 'success' / 'error' on completion. Inputs and outputs may
 * arrive incrementally (streaming JSON parser feeds partials).
 */

import './media/toolCallCard.css';
import { disposableWindowInterval, getWindow, h, reset } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { localize } from '../../../../nls.js';
import { LiveActivityUpdateScheduler } from './liveActivityScheduler.js';

export type ToolCardStatus = 'pending' | 'running' | 'waiting' | 'success' | 'error' | 'cancelled';
export type ToolCardKind = 'thinking' | 'context' | 'code' | 'terminal' | 'browser' | 'validation' | 'subagent' | 'checkpoint' | 'tool';

export interface IToolCardModel {
	id: string;
	tool: string;
	toolKind?: ToolCardKind;
	subtitle?: string;
	args?: unknown;
	output?: string;
	status: ToolCardStatus;
	durationMs?: number;
	/** When a running tool started, in milliseconds since the epoch. The card counts up from it while the tool runs. */
	startedAt?: number;
	errorMessage?: string;
	command?: string;
	exitCode?: number;
	filePaths?: readonly string[];
}

const MAX_OUTPUT_PREVIEW = 4000;

export class ToolCallCard extends Disposable {
	private readonly _root: HTMLElement;
	private readonly _header: HTMLElement;
	private readonly _chevron: HTMLElement;
	private readonly _toolName: HTMLElement;
	private readonly _subtitle: HTMLElement;
	private readonly _statusBadge: HTMLElement;
	private readonly _elapsed: HTMLElement;
	private readonly _meta: HTMLElement;
	private readonly _body: HTMLElement;
	private readonly _argsBlock: HTMLElement;
	private readonly _outputBlock: HTMLElement;
	private readonly _scheduler: LiveActivityUpdateScheduler;
	/** Updates the time a running tool has run, so a long command does not look stalled. */
	private readonly _ticker = this._register(new MutableDisposable());

	private _model: IToolCardModel;
	private _expanded = false;

	get domNode(): HTMLElement {
		return this._root;
	}

	get model(): Readonly<IToolCardModel> {
		return this._model;
	}

	/**
	 * @param now The clock the time a tool has run is measured with.
	 * @param tickInterval How often that time updates, in milliseconds.
	 */
	constructor(parent: HTMLElement, model: IToolCardModel, private readonly _now: () => number = Date.now, private readonly _tickInterval = 1000) {
		super();
		this._model = model;

		const layout = h('div.dragon-tool-card@root', [
			h('div.dragon-tool-card-header@header', [
				h('span.dragon-tool-card-chevron@chevron'),
				h('span.dragon-tool-card-name@toolName'),
				h('span.dragon-tool-card-subtitle@subtitle'),
				h('span.dragon-tool-card-status@status'),
				h('span.dragon-tool-card-elapsed@elapsed'),
			]),
			h('div.dragon-tool-card-meta@meta'),
			h('div.dragon-tool-card-body@body', [
				h('pre.dragon-tool-card-args@args'),
				h('pre.dragon-tool-card-output@output'),
			]),
		]);

		this._root = layout.root;
		this._header = layout.header;
		this._chevron = layout.chevron;
		this._toolName = layout.toolName;
		this._subtitle = layout.subtitle;
		this._statusBadge = layout.status;
		this._elapsed = layout.elapsed;
		this._meta = layout.meta;
		this._body = layout.body;
		this._argsBlock = layout.args;
		this._outputBlock = layout.output;
		this._scheduler = this._register(new LiveActivityUpdateScheduler(() => this.render()));

		this._body.style.display = 'none';
		this._header.style.cursor = 'pointer';

		// Phase 6g a11y: full keyboard + screen-reader support.
		this._header.setAttribute('tabindex', '0');
		this._header.setAttribute('role', 'button');
		this._header.setAttribute('aria-expanded', 'false');
		this._header.setAttribute('aria-controls', `dragon-tool-card-body-${this._model.id}`);
		this._body.setAttribute('id', `dragon-tool-card-body-${this._model.id}`);
		this._body.setAttribute('role', 'region');
		this._statusBadge.setAttribute('role', 'status');
		this._statusBadge.setAttribute('aria-live', 'polite');
		// It changes every second, so it stays out of what the status announces.
		this._elapsed.setAttribute('aria-hidden', 'true');

		this._header.addEventListener('click', () => this.toggle());
		this._header.addEventListener('keydown', (ev: KeyboardEvent) => {
			// Enter / Space toggle - standard button behavior.
			if (ev.key === 'Enter' || ev.key === ' ') {
				ev.preventDefault();
				this.toggle();
			}
		});

		parent.appendChild(this._root);
		this.render();
	}

	update(partial: Partial<IToolCardModel>): void {
		this._model = { ...this._model, ...partial };
		this._scheduler.schedule();
	}

	toggle(): void {
		this._expanded = !this._expanded;
		this._body.style.display = this._expanded ? '' : 'none';
		// Phase 6g a11y: keep aria-expanded in sync so screen readers announce the change.
		this._header.setAttribute('aria-expanded', this._expanded ? 'true' : 'false');
		this.renderChevron();
	}

	private render(): void {
		this._root.classList.remove(
			'dragon-tool-card-pending',
			'dragon-tool-card-running',
			'dragon-tool-card-waiting',
			'dragon-tool-card-success',
			'dragon-tool-card-error',
			'dragon-tool-card-cancelled',
			'dragon-tool-card-thinking',
			'dragon-tool-card-context',
			'dragon-tool-card-code',
			'dragon-tool-card-terminal',
			'dragon-tool-card-browser',
			'dragon-tool-card-validation',
			'dragon-tool-card-subagent',
			'dragon-tool-card-checkpoint',
			'dragon-tool-card-tool',
		);
		this._root.classList.add(`dragon-tool-card-${this._model.status}`);
		this._root.classList.add(`dragon-tool-card-${this._model.toolKind ?? 'tool'}`);
		reset(this._toolName, this._model.tool);
		reset(this._subtitle, this._model.subtitle ?? '');
		const badge = badgeText(this._model);
		reset(this._statusBadge, badge);
		// Phase 6g a11y: descriptive aria-label combining tool + subtitle + status.
		const subtitle = this._model.subtitle ? ` (${this._model.subtitle})` : '';
		const ariaLabel = `${this._model.tool}${subtitle}, status: ${badge}. Press Enter to ${this._expanded ? 'collapse' : 'expand'} details.`;
		this._header.setAttribute('aria-label', ariaLabel);
		this._statusBadge.setAttribute('aria-label', `Status: ${badge}`);
		this.renderElapsed();
		this.renderMeta();

		if (this._model.args !== undefined) {
			const argText = typeof this._model.args === 'string'
				? this._model.args
				: JSON.stringify(this._model.args, null, 2);
			reset(this._argsBlock, argText);
			this._argsBlock.style.display = '';
		} else {
			this._argsBlock.style.display = 'none';
		}

		if (this._model.output) {
			const text = this._model.output.length > MAX_OUTPUT_PREVIEW
				? this._model.output.slice(0, MAX_OUTPUT_PREVIEW) + '\n…'
				: this._model.output;
			reset(this._outputBlock, text);
			this._outputBlock.style.display = '';
		} else if (this._model.errorMessage) {
			reset(this._outputBlock, this._model.errorMessage);
			this._outputBlock.style.display = '';
		} else {
			this._outputBlock.style.display = 'none';
		}
		this.renderChevron();
	}

	private renderElapsed(): void {
		const { status, startedAt } = this._model;
		if (status !== 'running' || startedAt === undefined) {
			this._ticker.clear();
			reset(this._elapsed);
			return;
		}
		reset(this._elapsed, formatElapsed(this._now() - startedAt));
		if (!this._ticker.value) {
			this._ticker.value = disposableWindowInterval(getWindow(this._root), () => this.renderElapsed(), this._tickInterval);
		}
	}

	private renderChevron(): void {
		const icon = this._expanded ? Codicon.chevronDown : Codicon.chevronRight;
		reset(this._chevron, renderIcon(icon));
	}

	private renderMeta(): void {
		const pieces: HTMLElement[] = [];
		if (this._model.command) {
			pieces.push(metaChip('command', this._model.command));
		}
		if (typeof this._model.exitCode === 'number') {
			pieces.push(metaChip('exit', `exit ${this._model.exitCode}`));
		}
		for (const filePath of this._model.filePaths ?? []) {
			pieces.push(metaChip('file', filePath));
		}
		reset(this._meta, ...pieces);
		this._meta.style.display = pieces.length ? '' : 'none';
	}
}

function badgeText(model: IToolCardModel): string {
	switch (model.status) {
		case 'pending':
			return 'pending';
		case 'running':
			return 'running…';
		case 'waiting':
			return 'waiting';
		case 'success':
			return typeof model.durationMs === 'number'
				? `${model.durationMs.toFixed(0)} ms`
				: 'done';
		case 'error':
			return 'error';
		case 'cancelled':
			return 'cancelled';
	}
}

/** How long a tool has run, such as "12s", "1m 5s" or "1h 2m"; nothing for the first second. */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 1) {
		return '';
	}
	if (seconds < 60) {
		return localize('dragonToolCard.elapsedSeconds', "{0}s", seconds);
	}
	if (seconds < 3600) {
		return localize('dragonToolCard.elapsedMinutes', "{0}m {1}s", Math.floor(seconds / 60), seconds % 60);
	}
	return localize('dragonToolCard.elapsedHours', "{0}h {1}m", Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60);
}

function metaChip(kind: string, text: string): HTMLElement {
	const element = document.createElement('span');
	element.className = `dragon-tool-card-meta-chip dragon-tool-card-meta-${kind}`;
	element.textContent = text;
	element.title = text;
	return element;
}
