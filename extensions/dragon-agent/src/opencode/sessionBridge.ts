/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OpenCodeClient } from './client';
import type { OpenCodeEvent } from './types';

export interface Disposable {
	dispose(): void;
}

export type BridgeListener = (event: OpenCodeEvent) => void;

/**
 * One long-lived event stream from the window's OpenCode server for features that watch
 * sessions outside a chat turn (the composer's usage readout). It reconnects with backoff when
 * the stream drops or the server restarts, and tells subscribers so they can re-read state
 * that events do not replay.
 *
 * It holds no VS Code types, so it is tested directly.
 */
export class SessionBridge implements Disposable {
	private readonly listeners = new Set<BridgeListener>();
	private readonly reconnectListeners = new Set<() => void>();
	private controller: AbortController | undefined;
	private running = false;
	private disposed = false;
	private connectedOnce = false;

	constructor(
		private readonly connect: () => Promise<OpenCodeClient>,
		private readonly log: (line: string) => void = () => { },
		private readonly delays: readonly number[] = [500, 1000, 2000, 5000, 10_000],
	) { }

	/** Receives every event. Starts the stream on first use. */
	subscribe(listener: BridgeListener): Disposable {
		this.listeners.add(listener);
		this.start();
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Called after the stream (re)connects. Re-read anything events may have missed. */
	onDidConnect(listener: () => void): Disposable {
		this.reconnectListeners.add(listener);
		return { dispose: () => this.reconnectListeners.delete(listener) };
	}

	get connected(): boolean {
		return this.connectedOnce && !!this.controller && !this.controller.signal.aborted;
	}

	start(): void {
		if (this.running || this.disposed) {
			return;
		}
		this.running = true;
		void this.loop();
	}

	private async loop(): Promise<void> {
		let failures = 0;
		while (!this.disposed) {
			const controller = new AbortController();
			this.controller = controller;
			try {
				const client = await this.connect();
				const events = client.events(controller.signal);
				let first = true;
				for await (const event of events) {
					if (first) {
						first = false;
						failures = 0;
						this.connectedOnce = true;
						this.reconnectListeners.forEach(l => safe(l, this.log));
					}
					for (const listener of [...this.listeners]) {
						safe(() => listener(event), this.log);
					}
				}
			} catch (err) {
				if (!this.disposed) {
					this.log(`[sessions] event stream dropped: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				controller.abort();
			}
			if (this.disposed) {
				break;
			}
			const delay = this.delays[Math.min(failures, this.delays.length - 1)];
			failures++;
			await new Promise(resolve => setTimeout(resolve, delay));
		}
		this.running = false;
	}

	dispose(): void {
		this.disposed = true;
		this.controller?.abort();
		this.listeners.clear();
		this.reconnectListeners.clear();
	}
}

/**
 * Whether OpenCode's model list may have changed: a provider, model, the catalog or the config was
 * updated. OpenCode answers model listings before it has loaded the workspace's providers (empty at
 * first, then its built-in models) and sends these when they change, so a list read earlier is stale.
 */
export function changesModels(event: OpenCodeEvent): boolean {
	return event.type.startsWith('provider.') || event.type.startsWith('model.') || event.type.startsWith('catalog.') || event.type === 'config.updated';
}

function safe(fn: () => void, log: (line: string) => void): void {
	try {
		fn();
	} catch (err) {
		log(`[sessions] listener failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
