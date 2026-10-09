/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Holds a message to an agent whose chat is starting a turn for an earlier message until that turn
 * has sent it. The turn listens from then on, so the chat shows the message when it arrives. Sent
 * before, it reached OpenCode while no turn listened: three agents answered the lead at once, and
 * the lead's model read agent-2's answer, which its chat never showed.
 */
export class DeliveryGate {
	/** By session ID: settles once the chat's turn sent its message, failed to, or gave it up. */
	private readonly starting = new Map<string, Promise<void>>();

	constructor(private readonly timeoutMs: number) { }

	/**
	 * Marks the recipient's chat as starting a turn until `sent` settles. The returned function ends
	 * that sooner, for a turn the chat did not start.
	 */
	starts(recipient: string, sent: Promise<unknown>): () => void {
		let settle!: () => void;
		const settled = new Promise<void>(resolve => settle = resolve);
		const end = () => {
			if (this.starting.get(recipient) === settled) {
				this.starting.delete(recipient);
			}
			settle();
		};
		sent.then(end, end);
		this.starting.set(recipient, settled);
		return end;
	}

	/** Resolves once the recipient's chat is not starting a turn, or after the timeout. */
	async ready(recipient: string): Promise<void> {
		const settled = this.starting.get(recipient);
		if (!settled) {
			return;
		}
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([settled, new Promise<void>(resolve => timer = setTimeout(resolve, this.timeoutMs))]).finally(() => clearTimeout(timer));
	}
}
