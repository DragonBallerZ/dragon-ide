/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Launches the development desktop app (after `npm run compile`) and fails if "VS Code" or
// "Visual Studio Code" appears on the main user-facing surfaces: every setting description (the
// default settings JSON, case-sensitive), the settings editor, the command palette, the Editor
// Playground, the built-in extensions and their details, the welcome page, About and the issue
// reporter. Screenshots go to the directory given as the first argument (default: a temp dir).
//
// Usage: node scripts/dragon/check-ui-branding.mts [screenshot-dir]   (Linux: run under xvfb-run)
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Page } from 'playwright';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright') as typeof import('playwright');
const root = path.resolve(import.meta.dirname, '..', '..');
const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')) as { applicationName: string; nameLong: string; nameShort: string };
const SP = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-ui-'));
fs.mkdirSync(path.join(SP, 'shots'), { recursive: true });
const BAD = /Visual Studio Code|VS ?Code|\b(?:GitHub )?Copilot\b/;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shot = (page: Page, n: string) => page.screenshot({ path: `${SP}/shots/${n}.png` });
const results: { surface: string; ok: boolean; detail: string }[] = [];
const record = (surface: string, text: string | null) => {
	const hit = BAD.exec(text || '');
	results.push({ surface, ok: !!text?.trim() && !hit, detail: hit && text ? text.slice(Math.max(0, hit.index - 80), hit.index + 80).replace(/\s+/g, ' ') : `${(text || '').length} chars` });
};

void (async () => {
	const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-ui-data-')); const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-ui-ext-'));
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-ui-ws-'));
	fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');
	fs.mkdirSync(UD + '/User', { recursive: true });
	fs.writeFileSync(UD + '/User/settings.json', JSON.stringify({ 'window.dialogStyle': 'custom', 'dragon.ollama.enabled': false, 'dragon.updates.check': false, 'dragon.semanticSearch.enabled': false }));
	const app = await _electron.launch({
		executablePath: process.platform === 'darwin'
			? path.join(root, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', product.nameShort)
			: path.join(root, '.build', 'electron', process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName),
		args: ['.', '--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--user-data-dir', UD, '--extensions-dir', EXT, workspace],
		cwd: root,
		env: { ...process.env, XDG_CONFIG_HOME: path.join(UD, 'config'), XDG_DATA_HOME: path.join(UD, 'data'), XDG_CACHE_HOME: path.join(UD, 'cache'), XDG_STATE_HOME: path.join(UD, 'state'), NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }, timeout: 120000,
	});
	const win = await app.firstWindow({ timeout: 120000 });
	await win.setViewportSize({ width: 1440, height: 900 }).catch(() => { });
	await win.waitForSelector('.monaco-workbench', { timeout: 120000 });
	await win.waitForSelector('.dragon-onboarding', { timeout: 60000 }).catch(() => { });
	await win.waitForTimeout(2000);
	const skip = await win.$('.dragon-onboarding-enter');
	if (skip) { await skip.click(); await win.waitForTimeout(1500); }

	const command = async (name: string) => {
		await win.keyboard.press('Escape');
		await win.keyboard.press('F1'); await win.waitForTimeout(400);
		await win.keyboard.type(name); await win.waitForTimeout(900);
		await win.keyboard.press('Enter'); await win.waitForTimeout(2500);
	};
	const findCount = async (term: string) => {
		await win.keyboard.press(`${mod}+F`); await win.waitForTimeout(400);
		const matchCase = await win.$('.editor-widget.find-widget .codicon-case-sensitive');
		if (matchCase && (await matchCase.getAttribute('aria-checked')) !== 'true') { await matchCase.click(); await win.waitForTimeout(300); }
		await win.keyboard.press(`${mod}+A`); await win.keyboard.type(term); await win.waitForTimeout(1500);
		const count = await win.textContent('.editor-widget.find-widget .matchesCount').catch(() => 'n/a');
		await win.keyboard.press('Escape');
		return (count || '').trim();
	};

	// 1. Every setting description (core and built-in extensions), in the default settings JSON.
	await command('Preferences: Open Default Settings (JSON)');
	await win.waitForTimeout(2000);
	const settingsTitle = (await win.textContent('.tab.active').catch(() => '')) ?? '';
	for (const term of ['VS Code', 'Visual Studio Code', 'VSCode']) {
		const c = await findCount(term);
		results.push({ surface: `Default settings JSON (${settingsTitle.trim()}): "${term}"`, ok: /No results/i.test(c), detail: c });
	}
	const dragonCount = await findCount('Dragon IDE');
	results.push({ surface: 'Default settings JSON: "Dragon IDE" appears', ok: !/No results/i.test(dragonCount), detail: dragonCount });
	await shot(win, 'r01-default-settings');

	// 2. The settings editor, searched for text that used to name VS Code.
	await command('Preferences: Open Settings (UI)');
	await win.keyboard.type('restart'); await win.waitForTimeout(2500);
	record('Settings editor (search "restart")', await win.textContent('.settings-editor').catch(() => ''));
	await shot(win, 'r02-settings');

	// 3. Command palette labels mentioning the product.
	await win.keyboard.press('Escape');
	await win.keyboard.press('F1'); await win.waitForTimeout(400); await win.keyboard.type('reload'); await win.waitForTimeout(1000);
	record('Command palette ("reload")', await win.textContent('.quick-input-list').catch(() => ''));
	await win.keyboard.press('Escape');

	await win.keyboard.press('F1'); await win.waitForTimeout(400); await win.keyboard.type('Copilot'); await win.waitForTimeout(1000);
	const commandLabels = await win.locator('.quick-input-list .label-name').allTextContents();
	results.push({ surface: 'No Copilot command labels', ok: commandLabels.every(label => !BAD.test(label)), detail: commandLabels.join(', ') || 'No commands' });
	await shot(win, 'r03-ai-commands');
	await win.keyboard.press('Escape');
	results.push({ surface: 'No subscription status entry', ok: await win.locator('[id="chat.statusBarEntry"]').count() === 0, detail: 'Dragon Connect AI replaces subscription status' });

	// 4. Editor Playground.
	await command('Help: Editor Playground');
	await win.waitForTimeout(1500);
	record('Editor Playground', await win.textContent('.walkThroughContent').catch(() => ''));
	await shot(win, 'r03-playground');

	// 5. Built-in extensions: publisher names and a built-in extension's details.
	await command('Extensions: Show Built-in Extensions');
	await win.waitForTimeout(3000);
	record('Built-in extensions list', await win.textContent('.extensions-viewlet').catch(() => ''));
	await shot(win, 'r04-builtin');
	const first = await win.$('.extensions-viewlet .extension-list-item');
	if (first) {
		await first.click(); await win.waitForTimeout(3500);
		const frames = win.frames();
		let readme = '';
		for (const f of frames) { readme += await f.evaluate(() => document.body?.innerText || '').catch(() => ''); }
		record('Built-in extension details (header + README)', (await win.textContent('.extension-editor').catch(() => '')) + readme);
		await shot(win, 'r05-builtin-details');
	}

	// 6. Welcome / Get Started page.
	await command('Help: Welcome');
	await win.waitForTimeout(2000);
	record('Welcome page', await win.textContent('.gettingStartedContainer').catch(() => ''));
	await shot(win, 'r06-welcome');

	// 7. About dialog.
	await command('Help: About');
	await win.waitForTimeout(1500);
	record('About dialog', await win.textContent('.monaco-dialog-box').catch(() => ''));
	await shot(win, 'r07-about');
	await win.keyboard.press('Escape');

	// 8. Report Issue.
	await command('Help: Report Issue');
	await win.waitForTimeout(2500);
	record('Issue reporter', await win.evaluate(() => document.body.innerText).catch(() => ''));
	await shot(win, 'r08-issue');

	for (const r of results) {
		console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.surface}  ${r.detail}`);
	}
	const clean = results.every(r => r.ok);
	console.log(clean ? 'UI branding check passed.' : 'UI branding check failed: a surface is missing or still names an upstream product.');
	console.log(`Screenshots: ${path.join(SP, 'shots')}`);
	await app.close();
	process.exitCode = clean ? 0 : 1;
})().catch((e: unknown) => { console.error(e); process.exit(1); });
