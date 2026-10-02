/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Fails when a name or endpoint that must not ship finds its way into Dragon IDE, and when Copilot is
// wired back into the build. The names are not kept in the repository: set DRAGON_FORBIDDEN_NAMES to a
// regular expression (CI reads it from a repository secret). Without it, that check is skipped.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const forbidden = process.env.DRAGON_FORBIDDEN_NAMES?.trim();
const excluded = [':!extensions/copilot', ':!opencode'];

const problems: string[] = [];
if (forbidden) {
	let out = '';
	try {
		out = execFileSync('git', ['grep', '-n', '-I', '-i', '-E', forbidden, '--', '.', ...excluded], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		if ((err as { status?: number }).status !== 1) { // 1 = no matches
			throw err;
		}
	}
	for (const line of out.split('\n').filter(Boolean)) {
		problems.push(line.slice(0, 200));
	}
} else {
	console.log('DRAGON_FORBIDDEN_NAMES is not set; skipping the forbidden-names check.');
}

// Copilot must not be installed, compiled or shipped.
if (existsSync(path.join(root, 'extensions', 'copilot'))) {
	problems.push('extensions/copilot exists; Dragon IDE does not ship Copilot');
}
const dirs = readFileSync(path.join(root, 'build', 'npm', 'dirs.ts'), 'utf8');
if (/'extensions\/copilot'/.test(dirs)) {
	problems.push('build/npm/dirs.ts: extensions/copilot is back in the npm install list');
}
const product = JSON.parse(readFileSync(path.join(root, 'product.json'), 'utf8'));
if (product.defaultChatAgent) {
	problems.push('product.json: defaultChatAgent is set; Dragon IDE has no Copilot default agent');
}

// Linux packages must not register Microsoft's package repository or carry VS Code's identity.
let packaging = '';
try {
	packaging = execFileSync('git', ['grep', '-n', '-I', '-i', '-E', 'packages\\.microsoft\\.com|microsoft\\.gpg|vscode-linux@|code\\.visualstudio\\.com|Visual Studio Code', '--', 'resources/linux/debian', 'resources/linux/rpm', 'resources/linux/code.appdata.xml'], { cwd: root, encoding: 'utf8' });
} catch (err) {
	if ((err as { status?: number }).status !== 1) { // 1 = no matches
		throw err;
	}
}
for (const line of packaging.split('\n').filter(Boolean)) {
	problems.push(`${line.slice(0, 200)}  (Linux packages must carry Dragon's identity, not VS Code's)`);
}

// The UI names Dragon IDE, never VS Code: every path that turns text into UI must keep its rebrand hook.
const rebrandHooks: [file: string, marker: string][] = [
	['src/vs/nls.ts', 'message = rebrand(message);'],
	['src/vs/platform/extensionManagement/common/extensionNls.ts', 'rebrand(translatedMessage)'],
	['src/vs/platform/extensionManagement/common/extensionsScannerService.ts', 'rebrandManifestText(manifest)'],
	['src/vs/workbench/api/common/extHostLocalizationService.ts', 'format2(rebrand('],
	['src/vs/workbench/contrib/welcomeWalkthrough/common/walkThroughContentProvider.ts', 'rebrand(provider(accessor))'],
	['src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts', 'nls.rebrand(content.value.toString())'],
];
for (const [file, marker] of rebrandHooks) {
	if (!readFileSync(path.join(root, file), 'utf8').includes(marker)) {
		problems.push(`${file}: the "${marker}" rebrand hook is missing, so VS Code's name would reach the UI`);
	}
}

if (problems.length) {
	console.error(`Branding check failed (${problems.length}):\n${problems.join('\n')}`);
	process.exit(1);
}
console.log('Branding check passed.');
