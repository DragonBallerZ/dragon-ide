/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The approval and question cards a turn shows. Each is asked without holding up the turn, so the
 * chat keeps showing what the agent does meanwhile, and several can be open at once. OpenCode can
 * settle one before it is answered here: in another window, or itself (a denial rejects the
 * session's other requests, and "Always allow" allows the ones it now covers). Its card then
 * closes, and nothing is sent for it.
 */
export class OpenQuestions {
	private readonly open = new Map<string, AbortController>();
	private readonly pending = new Set<Promise<void>>();

	/** @param onError Gets an answer that could not be sent. */
	constructor(private readonly onError: (err: unknown) => void) { }

	/** The questions shown and not yet answered. */
	get size(): number {
		return this.open.size;
	}

	/**
	 * Shows question `id`, unless it is already open, and sends the answer it gets.
	 *
	 * @param question Shows the question, and resolves with its answer; undefined sends nothing. Its
	 * signal aborts when OpenCode settled the question elsewhere, and the card should then close.
	 * @param answer Sends the answer to OpenCode.
	 */
	ask<T>(id: string, question: (signal: AbortSignal) => Promise<T | undefined>, answer: (value: T) => Promise<void>): void {
		if (this.open.has(id)) {
			return;
		}
		const controller = new AbortController();
		this.open.set(id, controller);
		const asked: Promise<void> = this.askOne(id, controller, question, answer).finally(() => this.pending.delete(asked));
		this.pending.add(asked);
	}

	private async askOne<T>(id: string, controller: AbortController, question: (signal: AbortSignal) => Promise<T | undefined>, answer: (value: T) => Promise<void>): Promise<void> {
		try {
			const value = await question(controller.signal);
			if (controller.signal.aborted || value === undefined) {
				return;
			}
			// Answered: OpenCode reporting it settled is about this answer, not a reason to close it.
			this.open.delete(id);
			await answer(value);
		} catch (err) {
			this.onError(err);
		} finally {
			if (this.open.get(id) === controller) {
				this.open.delete(id);
			}
		}
	}

	/** OpenCode settled question `id`; if it is still open, its card closes unanswered. */
	settled(id: string): void {
		const controller = this.open.get(id);
		if (controller) {
			this.open.delete(id);
			controller.abort();
		}
	}

	/** Resolves once every question is answered or closed, and its answer sent. */
	async idle(): Promise<void> {
		while (this.pending.size) {
			await Promise.all(this.pending);
		}
	}
}
