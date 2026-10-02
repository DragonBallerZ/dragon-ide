/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IOSProperties } from '../../../native/common/native.js';
import product from '../../../product/common/product.js';
import { IProductService } from '../../../product/common/productService.js';
import { createNativeAboutDialogDetails } from '../../electron-browser/dialog.js';

suite('Dialog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const osProperties: IOSProperties = {
		type: 'Test OS',
		release: '1.0',
		arch: 'test-arch',
		platform: 'test',
		cpus: []
	};

	// DRAGON: the About dialog shows Dragon IDE's version and no Copilot runtime (Copilot does not ship).
	function aboutLines(overrides: Partial<IProductService>): { details: string[]; detailsToCopy: string[] } {
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
			...overrides
		};
		const { details, detailsToCopy } = createNativeAboutDialogDetails(productService, osProperties);
		return { details: details.split('\n'), detailsToCopy: detailsToCopy.split('\n') };
	}

	test('never lists the Copilot runtime', () => {
		const { details, detailsToCopy } = aboutLines({ copilotVersions: { runtime: '1.0.84', sdk: '0.1.23' } });
		assert.deepStrictEqual([...details, ...detailsToCopy].filter(line => line.includes('copilot')), []);
	});

	test('shows the Dragon IDE version first', () => {
		const { details } = aboutLines({ version: '1.139.1', dragonVersion: '0.2.0' });
		assert.strictEqual(details[0], 'Version: 0.2.0 (1.139.1)');
	});

	test('falls back to the editor version', () => {
		const { details } = aboutLines({ version: '1.139.1', dragonVersion: undefined });
		assert.strictEqual(details[0], 'Version: 1.139.1');
	});
});
