/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * Coalesces high-frequency agent stream updates into one render per frame.
 *
 * Tool streams can emit many small deltas. Rendering every delta makes the chat
 * feel busy and can cause layout jitter, so live cards update through this
 * scheduler and keep their DOM stable between frames.
 */
export class LiveActivityUpdateScheduler extends Disposable {
	private _pending = false;
	private _frame = 0;

	constructor(private readonly _render: () => void) {
		super();
		this._register(toDisposable(() => this._cancel()));
	}

	schedule(): void {
		if (this._pending) {
			return;
		}
		this._pending = true;
		this._frame = mainWindow.requestAnimationFrame(() => {
			this._frame = 0;
			this._pending = false;
			this._render();
		});
	}

	flush(): void {
		if (!this._pending) {
			return;
		}
		this._cancel();
		this._render();
	}

	private _cancel(): void {
		if (this._frame) {
			mainWindow.cancelAnimationFrame(this._frame);
			this._frame = 0;
		}
		this._pending = false;
	}
}
