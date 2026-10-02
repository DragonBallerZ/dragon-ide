/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual } from 'assert';
import { localize, localize2, rebrand } from '../../../../nls.js';
import { localizeManifest } from '../../common/extensionNls.js';
import { IExtensionManifest } from '../../../extensions/common/extensions.js';
import { NullLogger } from '../../../log/common/log.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('Dragon rebrand', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('names VS Code as Dragon IDE', () => {
		strictEqual(rebrand('Restart VS Code to apply.'), 'Restart Dragon IDE to apply.');
		strictEqual(rebrand('VS Code\'s TypeScript version'), 'Dragon IDE\'s TypeScript version');
		strictEqual(rebrand('Visual Studio Code is up to date'), 'Dragon IDE is up to date');
		strictEqual(rebrand('Visual Studio Code - Insiders'), 'Dragon IDE');
		strictEqual(rebrand('Welcome to VSCode'), 'Welcome to Dragon IDE');
		strictEqual(rebrand('VS Code and VS Code'), 'Dragon IDE and Dragon IDE');
	});

	test('leaves identifiers and other words alone', () => {
		for (const text of ['vscode.git', '.vscode/settings.json', 'vscode://file', 'Code', 'Codespaces', 'code --help', 'VS Codes', 'MS Code']) {
			strictEqual(rebrand(text), text);
		}
	});

	test('localize rebrands the message, not its arguments', () => {
		strictEqual(localize('dragonRebrand1', "Open {0} in VS Code", 'VS Code Projects'), 'Open VS Code Projects in Dragon IDE');
		const both = localize2('dragonRebrand2', "Reload VS Code");
		strictEqual(both.value, 'Reload Dragon IDE');
		strictEqual(both.original, 'Reload Dragon IDE');
	});

	test('extension manifests are rebranded, commands keep both values', () => {
		const manifest = {
			name: 'git', publisher: 'vscode', version: '1.0.0', engines: { vscode: '*' },
			description: '%description%',
			contributes: { commands: [{ command: 'git.x', title: '%title%' }] },
		} as unknown as IExtensionManifest;
		const localized = localizeManifest(new NullLogger(), manifest, { description: 'Git SCM for VS Code', title: 'Hilfe zu VS Code' }, { description: 'Git SCM for VS Code', title: 'Help with VS Code' });
		strictEqual(localized.description, 'Git SCM for Dragon IDE');
		const title = (localized.contributes?.commands as unknown as { title: { value: string; original: string } }[])[0].title;
		strictEqual(title.value, 'Hilfe zu Dragon IDE');
		strictEqual(title.original, 'Help with Dragon IDE');
	});
});
