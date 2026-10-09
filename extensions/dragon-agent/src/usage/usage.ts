/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The composer's usage readout: how full the context window is, how much prompt input was
 * served from the provider's cache, and what the selected model costs. Pure, so it is tested
 * directly; the numbers all come from OpenCode (session token buckets, per-message tokens, and
 * the model catalog's USD-per-million prices).
 *
 * `formatTokens` and `formatCacheHitPercent` are adapted from DeepSeek Harness
 * (packages/client/ui-chat/src/client/chat/token-format.ts at commit
 * 639ed015397290b3745d163aafe02ffee4aa3f84), Copyright (c) 2026 DeepSeek, MIT License. See
 * extensions/dragon-agent/NOTICE-deepseek-harness.txt. The readout's shape (a context ring with
 * a percentage, and a cache-hit pill with the token buckets behind it) follows its ContextMeter
 * and StatsPills.
 */

/** OpenCode's token buckets. `input` is prompt input that was not served from cache. */
export interface TokenBuckets {
	readonly input: number;
	readonly output: number;
	readonly reasoning: number;
	readonly cache: { readonly read: number; readonly write: number };
}

/** One entry of OpenCode's `Model.Info.cost`: USD per million tokens, optionally above a context size. */
export interface ModelCost {
	readonly tier?: { readonly type: 'context'; readonly size: number };
	readonly input: number;
	readonly output: number;
	readonly cache: { readonly read: number; readonly write: number };
}

export interface UsageModel {
	readonly providerID: string;
	readonly id: string;
	readonly name: string;
	readonly cost?: readonly ModelCost[];
	readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
}

/** What the composer shows. Strings are ready to display; numbers are for tests and tooltips. */
export interface UsageSummary {
	readonly model?: { readonly label: string; readonly local: boolean };
	readonly context?: {
		/** Tokens the next request will carry, approximately (the last request's prompt plus its reply). */
		readonly used: number;
		readonly window: number;
		readonly percent: number;
		readonly text: string;
		readonly tooltip: string;
	};
	readonly cache?: { readonly percent: string; readonly text: string; readonly tooltip: string };
	readonly price?: { readonly text: string; readonly tooltip: string };
}

const LOCAL_PROVIDERS = new Set(['ollama', 'splash', 'lmstudio', 'llama.cpp']);

/** OpenCode's defaults (`session/compaction.ts`): tokens kept free for the reply, and the most output it plans for. */
const COMPACTION_BUFFER = 20_000;
const COMPACTION_OUTPUT_MAX = 32_000;

/**
 * The prompt size at which OpenCode compacts automatically (its `SessionCompaction.required`): at
 * `autoAt` percent of the window, or sooner when the room it keeps for the reply runs out first.
 * Undefined when it never does: automatic compaction is off, or the window is not known.
 */
function compactionPoint(limit: UsageModel['limit'], autoAt = 100): number | undefined {
	const context = limit?.context ?? 0;
	if (autoAt <= 0 || context <= 0) {
		return undefined;
	}
	const output = Math.min(limit?.output ?? 0, COMPACTION_OUTPUT_MAX);
	return Math.max(0, Math.min(
		limit?.input === undefined ? Number.POSITIVE_INFINITY : limit.input - COMPACTION_BUFFER,
		context - Math.max(output, COMPACTION_BUFFER),
		Math.ceil(context * autoAt / 100),
	));
}

/** The tooltip's last line: where the conversation compacts. */
function compactionLine(model: UsageModel, autoAt: number | undefined): string | undefined {
	if (autoAt !== undefined && autoAt <= 0) {
		return 'Automatic compaction is off: run /compact before the window fills up, or /autocompact on to turn it back on.';
	}
	const point = compactionPoint(model.limit, autoAt);
	const context = model.limit?.context ?? 0;
	if (point === undefined) {
		return undefined;
	}
	const percent = Math.round(point * 100 / context);
	const sooner = point < Math.ceil(context * (autoAt ?? 100) / 100) ? ', keeping the rest free for the reply' : '';
	return `Compacts automatically at ${percent}% (${formatTokens(point)} tokens)${sooner}. /autocompact changes this.`;
}

/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
export function formatTokens(value: number): string {
	const scaled = (candidate: number): string => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
	if (value < 1_000) {
		return String(Math.round(value));
	}
	if (value < 1_000_000) {
		return `${scaled(value / 1_000)}K`;
	}
	return `${scaled(value / 1_000_000)}M`;
}

/** Exact count with thousands separators. */
export function formatExactTokens(value: number): string {
	return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
function roundedPercentUnits(cacheReadTokens: number, denominator: number, decimalPlaces: 0 | 1): number {
	const unitsPerPercent = decimalPlaces === 0 ? 1 : 10;
	const scale = unitsPerPercent * 100;
	const doubledScale = scale * 2;
	const denominatorQuotient = Math.floor(denominator / doubledScale);
	const denominatorRemainder = denominator % doubledScale;
	let lower = 0;
	let upper = scale;
	while (lower < upper) {
		const candidate = Math.floor((lower + upper + 1) / 2);
		const factor = candidate * 2 - 1;
		const threshold = factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale);
		if (cacheReadTokens >= threshold) {
			lower = candidate;
		} else {
			upper = candidate - 1;
		}
	}
	return lower;
}

function displayPercentUnits(units: number, decimalPlaces: 0 | 1): string {
	if (decimalPlaces === 0) {
		return String(units);
	}
	const whole = Math.floor(units / 10);
	const tenths = units % 10;
	return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * Cache-hit share of prompt input, without ever rounding a partial hit up to 100%.
 * Returns null when there was no prompt input.
 */
export function formatCacheHitPercent(cacheReadTokens: number, promptTokens: number, decimalPlaces: 0 | 1 = 0): string | null {
	if (promptTokens === 0) {
		return null;
	}
	const missedInputTokens = promptTokens - cacheReadTokens;
	if (missedInputTokens === 0) {
		return '100';
	}
	const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokens, decimalPlaces);
	const fullHitUnits = decimalPlaces === 0 ? 100 : 1_000;
	if (roundedUnits < fullHitUnits) {
		return displayPercentUnits(roundedUnits, decimalPlaces);
	}
	let distinguishingPlaces = 1;
	let scaledDoubleGap = missedInputTokens * 200;
	const denominatorTens = Math.floor(promptTokens / 10);
	while (scaledDoubleGap <= denominatorTens) {
		scaledDoubleGap *= 10;
		distinguishingPlaces += 1;
	}
	const denominatorOnes = promptTokens % 10;
	let roundedLoss = 5;
	for (let loss = 1; loss < 5; loss += 1) {
		const factor = loss * 2 + 1;
		const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
		if (scaledDoubleGap <= threshold) {
			roundedLoss = loss;
			break;
		}
	}
	return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}

/** Prompt-side tokens: uncached input plus cache reads and writes (disjoint buckets). */
export function promptTokens(tokens: TokenBuckets): number {
	return tokens.input + tokens.cache.read + tokens.cache.write;
}

/** US dollars: $15, $3, $0.30, $0.075; costs: $0.0042. */
export function formatUSD(value: number): string {
	if (value === 0) {
		return '$0';
	}
	if (value >= 100) {
		return `$${Math.round(value)}`;
	}
	if (value >= 1) {
		return `$${Number(value.toFixed(2))}`;
	}
	return `$${Number(value.toPrecision(2))}`;
}

export function isLocal(providerID: string): boolean {
	return LOCAL_PROVIDERS.has(providerID);
}

/** The base price (no context tier) and the tiers above it, as OpenCode bills them. */
export function pricing(model: UsageModel): { base?: ModelCost; tiers: ModelCost[] } {
	const costs = model.cost ?? [];
	const base = costs.find(c => !c.tier) ?? costs[0];
	const tiers = costs.filter(c => c.tier && c !== base).sort((a, b) => a.tier!.size - b.tier!.size);
	return { base, tiers };
}

function priceSummary(model: UsageModel): UsageSummary['price'] {
	const local = isLocal(model.providerID);
	const { base, tiers } = pricing(model);
	const free = !base || (base.input === 0 && base.output === 0);
	if (local || (free && model.cost?.length)) {
		return {
			text: local ? 'Local · free' : 'Free',
			tooltip: local
				? `${model.name} runs on this machine: no per-token charge.`
				: `${model.name}: the provider lists no per-token charge.`,
		};
	}
	if (!base) {
		return undefined;
	}
	const lines = [
		`${model.name}, USD per million tokens:`,
		`Input ${formatUSD(base.input)} · Output ${formatUSD(base.output)}`,
		`Cache read ${formatUSD(base.cache.read)} · Cache write ${formatUSD(base.cache.write)}`,
		...tiers.map(t => `Above ${formatTokens(t.tier!.size)} context: input ${formatUSD(t.input)} · output ${formatUSD(t.output)}`),
	];
	return { text: `${formatUSD(base.input)} / ${formatUSD(base.output)} per 1M`, tooltip: lines.join('\n') };
}

/**
 * Builds the readout. `last` is the token usage of the most recent request in the session's
 * current context (undefined before the first reply or right after a compaction); `total` is
 * the session's running total; `cost` is what OpenCode recorded for the session in USD.
 */
export function summarize(input: { model?: UsageModel; last?: TokenBuckets; total?: TokenBuckets; cost?: number; compacted?: boolean; autoAt?: number }): UsageSummary {
	const { model, last, total } = input;
	const window = model?.limit?.context || model?.limit?.input || 0;
	let context: UsageSummary['context'];
	if (window > 0) {
		const used = last ? promptTokens(last) + last.output + last.reasoning : 0;
		const percent = Math.min(100, Math.round(used * 100 / window));
		const detail = last
			? `~${formatTokens(used)} of ${formatTokens(window)} tokens: the last request's prompt (${formatExactTokens(promptTokens(last))}) plus its reply (${formatExactTokens(last.output + last.reasoning)}).`
			: input.compacted
				? `The conversation was just compacted; the next reply measures it again. Window: ${formatTokens(window)} tokens.`
				: `Nothing sent yet. Window: ${formatTokens(window)} tokens.`;
		const compaction = compactionLine(model!, input.autoAt);
		context = { used, window, percent, text: `${percent}%`, tooltip: [`${percent}% of the context window used`, detail, ...(compaction ? [compaction] : [])].join('\n') };
	}
	let cache: UsageSummary['cache'];
	// Only for providers that cache prompts: they report cache tokens, or price cache reads. For
	// the others a "0% cache hit" would be misleading, so the pill is left out.
	const caches = !!total && (total.cache.read + total.cache.write > 0 || (!!model && (pricing(model).base?.cache.read ?? 0) > 0));
	if (total && caches && promptTokens(total) > 0) {
		const percent = formatCacheHitPercent(total.cache.read, promptTokens(total))!;
		cache = {
			percent,
			text: `${percent}% cache hit`,
			tooltip: [
				`${percent}% of this session's prompt input was read from the provider's cache.`,
				`Input (uncached) ${formatExactTokens(total.input)}`,
				`Cache read ${formatExactTokens(total.cache.read)}`,
				...(total.cache.write ? [`Cache write ${formatExactTokens(total.cache.write)}`] : []),
				`Output ${formatExactTokens(total.output + total.reasoning)}`,
				...(input.cost !== undefined && input.cost > 0 ? [`Session cost so far ${formatUSD(input.cost)}`] : []),
			].join('\n'),
		};
	}
	return {
		...(model ? { model: { label: model.name, local: isLocal(model.providerID) } } : {}),
		...(context ? { context } : {}),
		...(cache ? { cache } : {}),
		...(model ? { price: priceSummary(model) } : {}),
	};
}
