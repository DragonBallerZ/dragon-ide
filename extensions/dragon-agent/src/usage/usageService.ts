/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { formatModelRef, OpenCodeClient, parseModelRef } from '../opencode/client';
import { changesModels, Disposable, SessionBridge } from '../opencode/sessionBridge';
import type { ModelInfo } from '../opencode/types';
import { summarize, TokenBuckets, UsageModel, UsageSummary } from './usage';

interface SessionUsage {
	readonly model?: string;
	readonly last?: TokenBuckets;
	readonly total?: TokenBuckets;
	readonly cost?: number;
	readonly compacted?: boolean;
}

interface RawMessage {
	readonly type: string;
	readonly time?: { readonly created?: number };
	readonly tokens?: TokenBuckets;
	readonly status?: string;
}

const MODEL_TTL = 60_000;

/** Events after which a session's usage must be read again. */
const STALE_ON = new Set([
	'session.usage.updated', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted',
	'session.compaction.ended', 'session.model.selected', 'session.model.switched',
]);

/**
 * Answers the composer's usage readout from OpenCode: the model catalog (context window and
 * prices) and the session's token buckets. Reads are cached per session and refreshed only after
 * OpenCode reports new usage, so the composer can ask as often as it likes.
 */
export class UsageService implements Disposable {
	private models: { at: number; list: ModelInfo[] } | undefined;
	private readonly sessions = new Map<string, { stale: boolean; value?: SessionUsage; pending?: Promise<SessionUsage> }>();
	private readonly subscription: Disposable;

	constructor(
		private readonly connect: () => Promise<OpenCodeClient>,
		bridge: Pick<SessionBridge, 'subscribe'>,
		private readonly directory: () => string,
		private readonly now: () => number = Date.now,
	) {
		this.subscription = bridge.subscribe(event => {
			const sessionID = typeof event.data?.sessionID === 'string' ? event.data.sessionID : undefined;
			if (sessionID && STALE_ON.has(event.type)) {
				const entry = this.sessions.get(sessionID);
				if (entry) {
					entry.stale = true;
				}
			}
			if (changesModels(event)) {
				this.models = undefined;
			}
		});
	}

	dispose(): void {
		this.subscription.dispose();
	}

	/** Forgets the model catalog, for example after the config layer changed. */
	invalidateModels(): void {
		this.models = undefined;
	}

	private async modelList(client: OpenCodeClient): Promise<ModelInfo[]> {
		if (!this.models || this.now() - this.models.at > MODEL_TTL) {
			this.models = { at: this.now(), list: await client.models(this.directory()) };
		}
		return this.models.list;
	}

	private async sessionUsage(client: OpenCodeClient, sessionID: string): Promise<SessionUsage> {
		let entry = this.sessions.get(sessionID);
		if (entry?.value && !entry.stale) {
			return entry.value;
		}
		if (entry?.pending) {
			return entry.pending;
		}
		entry = entry ?? { stale: true };
		this.sessions.set(sessionID, entry);
		entry.stale = false;
		const current = entry;
		current.pending = (async () => {
			const [session, messages] = await Promise.all([client.session(sessionID), client.messages(sessionID, 30) as Promise<RawMessage[]>]);
			const newestFirst = [...messages].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
			let last: TokenBuckets | undefined;
			let compacted = false;
			for (const m of newestFirst) {
				if (m.type === 'compaction') {
					compacted = true;
					break;
				}
				if (m.type === 'assistant' && m.tokens && (m.tokens.input + m.tokens.cache.read + m.tokens.cache.write) > 0) {
					last = m.tokens;
					break;
				}
			}
			const value: SessionUsage = {
				...(session.model ? { model: formatModelRef(session.model) } : {}),
				...(last ? { last } : {}),
				...(session.tokens ? { total: session.tokens } : {}),
				...(typeof session.cost === 'number' ? { cost: session.cost } : {}),
				compacted,
			};
			current.value = value;
			return value;
		})().finally(() => { current.pending = undefined; });
		try {
			return await current.pending;
		} catch (err) {
			current.stale = true;
			throw err;
		}
	}

	/**
	 * The readout for a session and the model the composer has selected (`provider/model`). With
	 * no session yet it shows only the model's window and prices. `autoAt` is
	 * `dragon.compaction.autoAt`.
	 */
	async summary(input: { sessionID?: string; model?: string; autoAt?: number }): Promise<UsageSummary> {
		const client = await this.connect();
		const session = input.sessionID ? await this.sessionUsage(client, input.sessionID).catch(() => undefined) : undefined;
		const ref = parseModelRef(input.model ?? session?.model);
		let model: UsageModel | undefined;
		if (ref) {
			const found = (await this.modelList(client)).find(m => m.providerID === ref.providerID && (m.modelID === ref.id || m.id === ref.id));
			model = found ? { providerID: found.providerID, id: found.modelID ?? found.id, name: found.name || found.id, cost: found.cost, limit: found.limit } : undefined;
		}
		// Usage belongs to the model that produced it: a different selection shows its window and prices only.
		const sameModel = !input.model || !session?.model || session.model === input.model;
		return summarize({
			model,
			last: sameModel ? session?.last : undefined,
			total: session?.total,
			cost: session?.cost,
			compacted: sameModel && session?.compacted,
			autoAt: input.autoAt,
		});
	}
}
