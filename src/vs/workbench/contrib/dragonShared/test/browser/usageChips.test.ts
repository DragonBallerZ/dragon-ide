/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { DRAGON_USAGE_COMMAND, DragonUsageChips, DragonUsageSummary } from '../../browser/usageChips.js';

suite('DragonUsageChips', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(summary: DragonUsageSummary | undefined, model: { vendor: string; id: string } | undefined = { vendor: 'dragon', id: 'anthropic/claude' }) {
		const calls: { id: string; args: unknown }[] = [];
		const commandService = {
			executeCommand: async (id: string, args: unknown) => {
				calls.push({ id, args });
				return summary;
			},
		} as unknown as ICommandService;
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		store.add({ dispose: () => container.remove() });
		const chips = store.add(new DragonUsageChips(container, { sessionResource: () => URI.parse('vscode-chat-session://local/abc'), model: () => model }, commandService));
		return { chips, calls, container };
	}

	const tick = () => new Promise(resolve => setTimeout(resolve, 0));

	test('renders the context ring, cache hit and price from the extension', async () => {
		const { chips, calls } = setup({
			context: { percent: 92, text: '92%', tooltip: '92% of the context window used' },
			cache: { text: '86% cache hit', tooltip: '86% of prompt input was read from cache\nCache read 90,000' },
			price: { text: '$3 / $15 per 1M', tooltip: 'Input $3 · Output $15' },
		});
		await tick();
		assert.deepStrictEqual(calls[0], { id: DRAGON_USAGE_COMMAND, args: { sessionResource: 'vscode-chat-session://local/abc', vendor: 'dragon', model: 'anthropic/claude' } });
		const text = chips.domNode.textContent;
		assert.ok(text?.includes('92%') && text.includes('86% cache hit') && text.includes('$3 / $15 per 1M'), text ?? '');
		assert.notStrictEqual(chips.domNode.style.display, 'none');
		const fill = chips.domNode.querySelector('.dragon-ring-fill')!;
		assert.ok(fill.classList.contains('dragon-ring-high'), 'a nearly full window is flagged');
		const dash = Number(fill.getAttribute('stroke-dasharray')!.split(' ')[0]);
		assert.ok(Math.abs(dash - 2 * Math.PI * 5.5 * 0.92) < 1e-6);
		const cache = chips.domNode.querySelector('.dragon-usage-cache') as HTMLElement;
		assert.strictEqual(cache.title, '86% of prompt input was read from cache\nCache read 90,000');
		assert.strictEqual(cache.getAttribute('aria-label'), '86% of prompt input was read from cache');
	});

	test('hides what the provider does not report, and everything for other vendors', async () => {
		const partial = setup({ price: { text: 'Local · free', tooltip: 'free' } });
		await tick();
		assert.strictEqual((partial.chips.domNode.querySelector('.dragon-usage-context') as HTMLElement).style.display, 'none');
		assert.strictEqual((partial.chips.domNode.querySelector('.dragon-usage-cache') as HTMLElement).style.display, 'none');
		assert.ok(partial.chips.domNode.textContent?.includes('Local · free'));

		const other = setup({ price: { text: 'x', tooltip: 'x' } }, { vendor: 'copilot', id: 'gpt' });
		await tick();
		assert.strictEqual(other.calls.length, 0, 'the extension is not asked about other vendors\' models');
		assert.strictEqual(other.chips.domNode.style.display, 'none');

		const none = setup(undefined);
		await tick();
		assert.strictEqual(none.chips.domNode.style.display, 'none');
	});
});
