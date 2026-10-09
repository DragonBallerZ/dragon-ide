/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ToolCallCard } from '../../browser/toolCallCard.js';

suite('ToolCallCard', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('a running tool counts up how long it has run, outside the status the screen reader announces, until it ends', async () => {
		let now = 10_000;
		const container = mainWindow.document.createElement('div');
		const card = store.add(new ToolCallCard(container, { id: 'call_1', tool: 'Terminal', status: 'running', startedAt: 10_000 }, () => now, 5));
		const shown = () => ({
			status: container.querySelector('.dragon-tool-card-status')?.textContent,
			elapsed: container.querySelector('.dragon-tool-card-elapsed')?.textContent,
			announced: container.querySelector('.dragon-tool-card-elapsed')?.getAttribute('aria-hidden'),
		});
		const seen = [shown()];
		now = 75_400;
		await timeout(40);
		seen.push(shown());
		now = 3_735_000;
		await timeout(40);
		seen.push(shown());
		card.update({ status: 'success' });
		await timeout(40);
		seen.push(shown());

		assert.deepStrictEqual(seen, [
			{ status: 'running…', elapsed: '', announced: 'true' },
			{ status: 'running…', elapsed: '1m 5s', announced: 'true' },
			{ status: 'running…', elapsed: '1h 2m', announced: 'true' },
			{ status: 'done', elapsed: '', announced: 'true' },
		]);
	});
});
