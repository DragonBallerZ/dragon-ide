/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** A message from another agent that is waiting for its chat to start the turn that delivers it. */
export interface PendingDelivery {
	/**
	 * True once the message is in the agent's inbox, false once the chat's turn for it ended without
	 * sending it, so it is the sender's to send. Rejects when sending it failed.
	 */
	readonly sent: Promise<boolean>;
	/** Takes the message back. False when the chat already has it. */
	cancel(): boolean;
}

/** Messages from other agents, by chat, each waiting for the chat turn that delivers it. */
export class Deliveries<M> {
	private readonly queues = new Map<string, { readonly message: M; readonly send: () => Promise<unknown>; readonly settle: (sent: boolean) => void; readonly fail: (err: unknown) => void }[]>();

	/** Queues `message` for the next turn `chat` starts by itself; `send` puts it in the agent's inbox. */
	add(chat: string, message: M, send: () => Promise<unknown>): PendingDelivery {
		let settle!: (sent: boolean) => void;
		let fail!: (err: unknown) => void;
		const sent = new Promise<boolean>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		const entry = { message, send, settle, fail };
		const queue = this.queues.get(chat) ?? [];
		queue.push(entry);
		this.queues.set(chat, queue);
		return {
			sent,
			cancel: () => {
				const at = queue.indexOf(entry);
				if (at >= 0) {
					queue.splice(at, 1);
				}
				return at >= 0;
			},
		};
	}

	/**
	 * Runs `turn` for the chat's next message, if one waits. The turn shows the message and sends it
	 * with the function it is given, which returns what sending returned. A turn that ends without
	 * sending it, as one whose event stream did not open, gives it back: kept, its sender waited for
	 * good, and every later message to the agent waited for the chat first.
	 */
	async deliver<T>(chat: string, turn: (message: M, send: () => Promise<unknown>) => Promise<T>): Promise<T | undefined> {
		const entry = this.queues.get(chat)?.shift();
		if (!entry) {
			return undefined;
		}
		let sending = false;
		try {
			return await turn(entry.message, async () => {
				sending = true;
				try {
					const sent = await entry.send();
					entry.settle(true);
					return sent;
				} catch (err) {
					entry.fail(err ?? new Error('delivery failed'));
					throw err;
				}
			});
		} finally {
			if (!sending) {
				entry.settle(false);
			}
		}
	}
}

/**
 * Whether the chat's turn sent `pending`, once the chat was asked to start a turn for it: accepted,
 * it has `timeoutMs` to take the message. A chat that has the message, or is sending it now, sends
 * it, also one that refused the request after a turn of it took the message: sending it again would
 * deliver it twice. Otherwise the message is taken back, for its sender to send another way. Rejects
 * when the chat's turn failed to send it.
 */
export async function sentByChat(pending: PendingDelivery, accepted: boolean, timeoutMs: number): Promise<boolean> {
	if (accepted) {
		let timer: NodeJS.Timeout | undefined;
		// Whether the chat's turn sent it, or undefined if no turn took it in time.
		const taken = await Promise.race([
			pending.sent,
			new Promise<undefined>(resolve => timer = setTimeout(() => resolve(undefined), timeoutMs)),
		]).finally(() => clearTimeout(timer));
		if (taken !== undefined) {
			return taken;
		}
	}
	return !pending.cancel() && await pending.sent;
}
