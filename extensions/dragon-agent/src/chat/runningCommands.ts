/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runningCommandMessage, shellTimeout } from './toolPresentation';

interface RunningCommand {
	readonly shellID: string;
	readonly running: string;
	readonly timeout: number;
	readonly started: number;
	output: string;
	reading: boolean;
}

/**
 * Keeps the line of each shell command that is still running current: how long it has run, its
 * timeout, and the last line it printed, so a long build or test run does not look stalled.
 *
 * OpenCode reports the shell a command runs in once it starts (`session.tool.progress`), and what
 * it printed so far can be read while it runs (`GET /api/shell/:id/output`).
 */
export class RunningCommands {
	private readonly commands = new Map<string, RunningCommand>();
	private timer: ReturnType<typeof setInterval> | undefined;

	/**
	 * @param tail Reads the end of what a shell has printed so far.
	 * @param show Shows the line for a tool call.
	 * @param interval How often the lines update, in milliseconds; 0 updates them only on `tick`.
	 */
	constructor(
		private readonly tail: (shellID: string) => Promise<string>,
		private readonly show: (id: string, message: string) => void,
		private readonly now: () => number = Date.now,
		private readonly interval = 1000,
	) { }

	/** Starts updating the line of tool call `id`, a command running in shell `shellID`. */
	start(id: string, shellID: string, running: string, input: Record<string, unknown>): void {
		const command: RunningCommand = { shellID, running, timeout: shellTimeout(input), started: this.now(), output: '', reading: false };
		this.commands.set(id, command);
		this.show(id, runningCommandMessage(running, 0, command.timeout, ''));
		if (this.interval && !this.timer) {
			this.timer = setInterval(() => void this.tick(), this.interval);
		}
	}

	/** Stops updating the line of tool call `id`, which finished. */
	stop(id: string): void {
		this.commands.delete(id);
		if (!this.commands.size) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	dispose(): void {
		this.commands.clear();
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Reads each command's output, unless a read is still under way, and shows its line. */
	async tick(): Promise<void> {
		await Promise.all([...this.commands].map(async ([id, command]) => {
			if (!command.reading) {
				command.reading = true;
				try {
					command.output = await this.tail(command.shellID);
				} catch {
					// The line still shows the time; the output is read again on the next tick.
				} finally {
					command.reading = false;
				}
			}
			if (this.commands.get(id) === command) {
				this.show(id, runningCommandMessage(command.running, this.now() - command.started, command.timeout, command.output));
			}
		}));
	}
}
