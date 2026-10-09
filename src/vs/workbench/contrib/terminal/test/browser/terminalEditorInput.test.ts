/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual } from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ITerminalLaunchError, TerminalExitReason } from '../../../../../platform/terminal/common/terminal.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ITerminalInstance } from '../../browser/terminal.js';
import { TerminalEditorInput } from '../../browser/terminalEditorInput.js';

/**
 * A terminal whose process exits as `TerminalInstance._onProcessExit` handles it: `onExit` fires
 * first, and then, unless something disposed the terminal meanwhile or it waits on exit, the
 * terminal disposes itself with the reason `Process`.
 */
class ExitingTerminal {
	private readonly _store = new DisposableStore();
	private readonly _onExit = this._store.add(new Emitter<number | ITerminalLaunchError | undefined>());
	private readonly _onDisposed = this._store.add(new Emitter<ITerminalInstance>());
	private readonly _unused = this._store.add(new Emitter<never>());
	readonly onExit = this._onExit.event;
	readonly onDisposed = this._onDisposed.event;
	readonly onDidFocus = this._unused.event;
	readonly onDidBlur = this._unused.event;
	readonly onTitleChanged = this._unused.event;
	readonly onIconChanged = this._unused.event;
	readonly statusList = { onDidChangePrimaryStatus: this._unused.event };
	exitReason: TerminalExitReason | undefined;

	constructor(readonly waitOnExit: boolean) { }

	exitProcess(code: number): void {
		this._onExit.fire(code);
		if (this.exitReason === undefined && !this.waitOnExit) {
			this.dispose(TerminalExitReason.Process);
		}
	}

	dispose(reason?: TerminalExitReason): void {
		if (this.exitReason !== undefined) {
			return;
		}
		this.exitReason = reason ?? TerminalExitReason.Unknown;
		this._onDisposed.fire(this as unknown as ITerminalInstance);
		this._store.dispose();
	}
}

suite('Workbench - TerminalEditorInput', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a terminal in the editor area keeps the reason its process ended', () => {
		const instantiationService = workbenchInstantiationService(undefined, store);
		const outcome = (waitOnExit: boolean, end: (terminal: ExitingTerminal, input: TerminalEditorInput) => void) => {
			const terminal = new ExitingTerminal(waitOnExit);
			const input = instantiationService.createInstance(TerminalEditorInput, URI.parse('vscode-terminal:/1/1'), terminal as unknown as ITerminalInstance);
			end(terminal, input);
			const result = { exitReason: terminal.exitReason === undefined ? undefined : TerminalExitReason[terminal.exitReason], editorClosed: input.isDisposed() };
			input.dispose();
			terminal.dispose();
			return result;
		};
		deepStrictEqual({
			processExited: outcome(false, terminal => terminal.exitProcess(1)),
			processExitedWaiting: outcome(true, terminal => terminal.exitProcess(1)),
			editorClosed: outcome(false, (_terminal, input) => input.dispose()),
		}, {
			processExited: { exitReason: 'Process', editorClosed: true },
			processExitedWaiting: { exitReason: undefined, editorClosed: false },
			editorClosed: { exitReason: 'User', editorClosed: true },
		});
	});
});
