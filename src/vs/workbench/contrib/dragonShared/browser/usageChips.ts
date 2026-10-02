/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The composer's usage readout for Dragon models: how full the context window is, how much of
 * the session's prompt input the provider served from its cache, and the selected model's price.
 * The numbers come from OpenCode through the dragon-agent extension (`dragon.usage.summary`), so
 * they work for every provider OpenCode reports usage and prices for.
 *
 * The ring geometry and pill layout are adapted from DeepSeek Harness's ContextMeter and
 * StatsPills (commit 639ed015397290b3745d163aafe02ffee4aa3f84, MIT License, Copyright (c) 2026
 * DeepSeek; see extensions/dragon-agent/NOTICE-deepseek-harness.txt).
 */

import './media/composerChips.css';
import { getActiveWindow, h, reset } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export const DRAGON_USAGE_COMMAND = 'dragon.usage.summary';

/** What `dragon.usage.summary` returns (see extensions/dragon-agent/src/usage/usage.ts). */
export interface DragonUsageSummary {
	readonly context?: { readonly percent: number; readonly text: string; readonly tooltip: string };
	readonly cache?: { readonly text: string; readonly tooltip: string };
	readonly price?: { readonly text: string; readonly tooltip: string };
}

export interface DragonUsageSource {
	/** The chat session the composer belongs to. */
	sessionResource(): URI | undefined;
	/** The model selected in the picker. */
	model(): { readonly vendor: string; readonly id: string } | undefined;
}

const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const SVG_NS = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 2500;

/** The context ring, cache-hit pill and price pill, at the end of the composer's secondary toolbar. */
export class DragonUsageChips extends Disposable {
	readonly domNode: HTMLElement;
	private readonly contextPill: HTMLElement;
	private readonly contextText: HTMLElement;
	private readonly ringFill: SVGCircleElement;
	private readonly cachePill: HTMLElement;
	private readonly pricePill: HTMLElement;
	private generation = 0;
	private lastKey: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly source: DragonUsageSource,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const layout = h('span.dragon-usage@root', [
			h('span.dragon-usage-pill.dragon-usage-context@context', [h('span.dragon-usage-context-text@contextText')]),
			h('span.dragon-usage-pill.dragon-usage-cache@cache'),
			h('span.dragon-usage-pill.dragon-usage-price@price'),
		]);
		this.domNode = layout.root;
		this.contextPill = layout.context;
		this.contextText = layout.contextText;
		this.cachePill = layout.cache;
		this.pricePill = layout.price;
		for (const pill of [this.contextPill, this.cachePill, this.pricePill]) {
			pill.setAttribute('role', 'img');
			pill.tabIndex = 0;
		}

		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 14 14');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('aria-hidden', 'true');
		const track = document.createElementNS(SVG_NS, 'circle');
		this.ringFill = document.createElementNS(SVG_NS, 'circle');
		for (const [circle, cls] of [[track, 'dragon-ring-track'], [this.ringFill, 'dragon-ring-fill']] as const) {
			circle.setAttribute('class', cls);
			circle.setAttribute('cx', '7');
			circle.setAttribute('cy', '7');
			circle.setAttribute('r', String(RADIUS));
		}
		this.ringFill.setAttribute('transform', 'rotate(-90 7 7)');
		svg.append(track, this.ringFill);
		this.contextPill.prepend(svg);

		this.render(undefined);
		container.appendChild(this.domNode);
		const timer = getActiveWindow().setInterval(() => this.refresh(), REFRESH_MS);
		this._register(toDisposable(() => getActiveWindow().clearInterval(timer)));
		this.refresh();
	}

	/** Reads the readout again; called on a timer and when the model or session changes. */
	refresh(force = false): void {
		if (!this.domNode.isConnected && !force) {
			return;
		}
		if (getActiveWindow().document.visibilityState === 'hidden') {
			return;
		}
		const model = this.source.model();
		const sessionResource = this.source.sessionResource()?.toString();
		if (model && model.vendor !== 'dragon') {
			this.render(undefined);
			return;
		}
		const generation = ++this.generation;
		this.commandService.executeCommand<DragonUsageSummary | undefined>(DRAGON_USAGE_COMMAND, { sessionResource, vendor: model?.vendor, model: model?.id }).then(summary => {
			if (generation === this.generation && !this._store.isDisposed) {
				this.render(summary);
			}
		}, () => {
			if (generation === this.generation && !this._store.isDisposed) {
				this.render(undefined);
			}
		});
	}

	private render(summary: DragonUsageSummary | undefined): void {
		const key = JSON.stringify(summary ?? null);
		if (key === this.lastKey) {
			return;
		}
		this.lastKey = key;
		this.domNode.style.display = summary && (summary.context || summary.cache || summary.price) ? '' : 'none';

		const context = summary?.context;
		this.contextPill.style.display = context ? '' : 'none';
		if (context) {
			const percent = Math.max(0, Math.min(100, context.percent));
			this.ringFill.setAttribute('stroke-dasharray', `${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`);
			this.ringFill.classList.toggle('dragon-ring-high', percent >= 90);
			reset(this.contextText, context.text);
			this.contextPill.title = context.tooltip;
			this.contextPill.setAttribute('aria-label', localize('dragon.usage.context.aria', "Context window: {0} used", context.text));
		}

		const cache = summary?.cache;
		this.cachePill.style.display = cache ? '' : 'none';
		if (cache) {
			reset(this.cachePill, `\u26C1 ${cache.text}`);
			this.cachePill.title = cache.tooltip;
			this.cachePill.setAttribute('aria-label', cache.tooltip.split('\n')[0]);
		}

		const price = summary?.price;
		this.pricePill.style.display = price ? '' : 'none';
		if (price) {
			reset(this.pricePill, price.text);
			this.pricePill.title = price.tooltip;
			this.pricePill.setAttribute('aria-label', localize('dragon.usage.price.aria', "Model price: {0}", price.text));
		}
	}
}
