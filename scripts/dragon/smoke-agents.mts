/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Agent messaging smoke test for the desktop app. Launches Dragon IDE on a fresh profile with a
// scripted model and runs one team, in the UI as a person would:
//   1. Dragon: New Team opens the lead's chat beside a grid of panes, with messaging on for the lead
//   2. The lead starts a teammate with spawn_teammate: it opens in its own pane, and its task shows
//      there as a "From lead" turn, not as something the user typed
//   3. The teammate reports with send_message: the report shows in the lead's chat, attributed to it
//   4. Stop on the teammate: the lead's next message is kept for it, and does not start it again
//   5. The Messages chip in another chat cycles Off, On, Muted
// It also checks what the model was sent: who is the lead, and who a message is from.
//
// Usage: node scripts/dragon/smoke-agents.mts [--app <packaged app dir>] [--out <dir>]
//   Without --app it runs the development build (after `npm run compile` and `npm run electron`).
//   Linux: run under xvfb-run.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from 'playwright';
import { type ScriptStep, startMockOllama } from '../../extensions/dragon-agent/src/test/mockOllama.ts';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright') as typeof import('playwright');
const root = path.resolve(import.meta.dirname, '..', '..');
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
	const match = /^--(app|out)$/.exec(process.argv[i]);
	if (!match || i + 1 >= process.argv.length) {
		throw new Error(`Unknown argument: ${process.argv[i]}. Usage: smoke-agents.mts [--app <dir>] [--out <dir>]`);
	}
	args[match[1]] = process.argv[++i];
}
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-agents-smoke-')));
fs.mkdirSync(out, { recursive: true });
const MODEL = 'acme-large';
const STEP_TIMEOUT = 90_000;

let shots = 0;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(out, `${String(++shots).padStart(2, '0')}-${name}.png`) }).catch(() => undefined);

function executable(): { path: string; args: string[]; env: Record<string, string> } {
	if (args.app) {
		const app = path.resolve(args.app);
		const product = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8')) as { nameShort: string; applicationName: string };
		switch (process.platform) {
			case 'darwin': return { path: path.join(app, 'Contents', 'MacOS', product(path.join(app, 'Contents', 'Resources', 'app', 'product.json')).nameShort), args: [], env: {} };
			case 'linux': return { path: path.join(app, product(path.join(app, 'resources', 'app', 'product.json')).applicationName), args: [], env: {} };
			default: return { path: path.join(app, `${product(path.join(app, 'resources', 'app', 'product.json')).nameShort}.exe`), args: [], env: {} };
		}
	}
	const product = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')) as { nameShort: string; nameLong: string; applicationName: string };
	const dev = { args: [root], env: { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ELECTRON_ENABLE_LOGGING: '1' } };
	switch (process.platform) {
		case 'darwin': return { path: path.join(root, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', product.nameShort), ...dev };
		case 'linux': return { path: path.join(root, '.build', 'electron', product.applicationName), ...dev };
		default: return { path: path.join(root, '.build', 'electron', `${product.nameShort}.exe`), ...dev };
	}
}

class StepError extends Error { }
async function step<T>(page: Page | undefined, name: string, run: () => Promise<T>): Promise<T> {
	const started = Date.now();
	try {
		const result = await run();
		console.log(`PASS  ${name} (${Date.now() - started} ms)`);
		return result;
	} catch (err) {
		console.log(`FAIL  ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
		if (page) {
			await shot(page, `failed-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
		}
		throw new StepError(name, { cause: err });
	}
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-agents-run-'));
const workspace = path.join(temp, 'work');
const userData = path.join(temp, 'user-data');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'todo\n');

// Each agent's prompt names its script with a `[[mock:<name>]]` marker.
const say = (text: string): ScriptStep => ({ kind: 'text', chunks: [text] });
const REPORT = 'Scout report: notes.txt has one line.';
const mock = await startMockOllama([say('No scenario.')], MODEL, 0, {
	scenarios: {
		lead: [
			{ kind: 'tool', name: 'spawn_teammate', args: { name: 'scout', prompt: '[[mock:scout]] Read notes.txt and report what is in it.' } },
			{ kind: 'tool', name: 'wait_agent', args: { agent: 'scout', timeoutSeconds: 60 } },
			say('Lead finished.'),
		],
		scout: [
			{ kind: 'tool', name: 'send_message', args: { to: 'lead', message: REPORT } },
			say('Scout reported.'),
		],
		// A command that outlasts the test, for the user to stop.
		busy: [{ kind: 'tool', name: 'shell', args: { command: 'node -e "setTimeout(() => {}, 120000)"' } }, say('Busy turn went on.')],
		nudge: [{ kind: 'tool', name: 'send_message', args: { to: 'scout', message: 'Carry on with the next file.' } }, say('Nudge sent.')],
	},
});
fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({
	$schema: 'https://opencode.ai/config.json',
	enabled_providers: ['acme'],
	providers: {
		acme: {
			name: 'Acme', package: '@opencode/ai/providers/openai-compatible',
			settings: { baseURL: `${mock.origin}/v1`, apiKey: 'test' },
			models: { [MODEL]: { name: 'Acme Large', limit: { context: 200_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } } },
		},
	},
}, null, '\t'));
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'window.dialogStyle': 'custom',
	'security.workspace.trust.enabled': false,
	'dragon.model': `acme/${MODEL}`,
	'dragon.permissionMode': 'full-access',
	'dragon.ollama.enabled': false,
	'dragon.semanticSearch.enabled': false,
	'dragon.completions.enabled': false,
	'dragon.updates.check': false,
	'update.mode': 'none',
	'telemetry.telemetryLevel': 'off',
	'extensions.autoCheckUpdates': false,
	'workbench.tips.enabled': false,
}, null, '\t'));

const exe = executable();
if (!fs.existsSync(exe.path)) {
	throw new Error(`Dragon IDE not found at ${exe.path}. Run \`npm run compile\` and \`npm run electron\` first, or pass --app.`);
}
const xdg = Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(name => {
	const dir = path.join(temp, name.toLowerCase());
	fs.mkdirSync(dir);
	return [name, dir];
}));

async function runCommand(win: Page, label: string): Promise<void> {
	await win.keyboard.press('F1');
	const input = win.locator('.quick-input-widget input.input');
	await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
	await input.fill(`>${label}`);
	await win.locator('.quick-input-widget .monaco-list-row').filter({ hasText: label }).first().click({ timeout: STEP_TIMEOUT });
}

/** Waits until the model has been sent `text`. */
async function mockSaw(text: string): Promise<void> {
	for (const until = Date.now() + STEP_TIMEOUT; !sent().includes(text);) {
		if (Date.now() > until) {
			throw new Error(`the model was never sent ${JSON.stringify(text)}`);
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

/** Everything the model was sent, as text. */
const sent = () => JSON.stringify(mock.requests.filter(r => r.path.startsWith('/v1/chat/completions')).map(r => r.body));

const INPUT = '.interactive-input-part .monaco-editor[role="code"]';
let app: ElectronApplication | undefined;
let failed = false;
try {
	app = await _electron.launch({
		executablePath: exe.path,
		args: [
			...exe.args,
			...(process.platform === 'linux' ? ['--no-sandbox'] : []),
			'--use-inmemory-secretstorage', '--disable-gpu', '--skip-release-notes', '--disable-telemetry', '--log', 'debug',
			'--shared-data-dir', path.join(temp, 'shared-data'),
			'--user-data-dir', userData, '--extensions-dir', path.join(temp, 'extensions'),
			workspace,
		],
		cwd: args.app ? temp : root,
		// Provider credentials in the environment (AWS, Anthropic, OpenAI, …) would enable real providers
		// in OpenCode and let the chat pick one of their models instead of the scripted one.
		env: Object.fromEntries(Object.entries({ ...process.env, ...exe.env, ...xdg, OPENCODE_TEST_HOME: temp })
			.filter((e): e is [string, string] => e[1] !== undefined && !/^(AWS_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AZURE_|OPENROUTER_|GROQ_|MISTRAL_|XAI_|DEEPSEEK_|GITHUB_TOKEN$|GH_TOKEN$)/.test(e[0]))),
		timeout: STEP_TIMEOUT,
	});
	const win = await app.firstWindow({ timeout: STEP_TIMEOUT });
	await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => undefined);
	const groups = win.locator('.editor-group-container');
	const chip = (scope: Locator) => scope.locator('.interactive-input-part .dragon-messaging-toggle');
	const idle = (scope: Locator) => scope.locator('.interactive-item-container.interactive-response.chat-response-loading').waitFor({ state: 'detached', timeout: STEP_TIMEOUT });

	await step(win, 'enter the workbench', async () => {
		// A fresh profile starts on the one-button entrance.
		await win.waitForSelector('.dragon-onboarding[role=dialog]', { state: 'visible', timeout: STEP_TIMEOUT });
		await win.getByRole('button', { name: 'Enter FREEDOM AI', exact: true }).click();
		await win.waitForSelector('.dragon-onboarding', { state: 'detached', timeout: STEP_TIMEOUT });
		await win.waitForSelector('.monaco-workbench', { timeout: STEP_TIMEOUT });
		await runCommand(win, 'Notifications: Clear All Notifications');
	});

	await step(win, 'New Team opens the lead beside two teammate panes, with messaging on', async () => {
		await runCommand(win, 'Dragon: New Team');
		await win.locator('.quick-input-widget .monaco-list-row').filter({ hasText: '2 teammate panes' }).first().click({ timeout: STEP_TIMEOUT });
		// The size picker closes before the name box opens: wait for the box itself.
		await win.locator('.quick-input-widget', { hasText: 'A name for the team' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		const name = win.locator('.quick-input-widget input.input');
		await name.fill('crew');
		await name.press('Enter');
		await groups.first().locator(INPUT).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		if (await groups.count() !== 3) {
			throw new Error(`expected the lead and 2 teammate panes, found ${await groups.count()} editor groups`);
		}
		await chip(groups.first()).and(win.locator('.dragon-messaging-on')).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the lead's Messages chip is ${await chip(groups.first()).getAttribute('class').catch(() => 'missing')}`, { cause: err });
		});
		await groups.first().locator('.interactive-input-part .chat-input-toolbars').getByText('Acme Large', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await shot(win, 'new-team');
	});

	await step(win, 'the lead starts a teammate, which opens in its own pane with the task shown as from the lead', async () => {
		const lead = groups.first();
		await lead.locator(INPUT).click();
		await win.keyboard.insertText('[[mock:lead]] Find out what is in notes.txt.');
		await win.keyboard.press('Enter');
		const scout = groups.nth(1);
		await scout.locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: 'Scout reported.' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await idle(scout);
		const text = (await scout.locator('.interactive-session').innerText()).replace(/\s+/g, ' ');
		if (!text.includes('From lead') || !text.includes('Read notes.txt and report what is in it.')) {
			throw new Error(`the teammate's chat does not say who its task is from: ${JSON.stringify(text.slice(0, 400))}`);
		}
		// A task from the lead must not look like a message the user typed.
		if (await scout.locator('.interactive-item-container.interactive-request:not(.system-initiated-request)', { hasText: 'Read notes.txt' }).count()) {
			throw new Error('the task from the lead shows as a message typed by the user');
		}
		await chip(scout).and(win.locator('.dragon-messaging-on')).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the teammate's Messages chip is ${await chip(scout).getAttribute('class').catch(() => 'missing')}`, { cause: err });
		});
		await shot(win, 'teammate-pane');
	});

	await step(win, 'the teammate\'s report shows in the lead\'s chat, attributed to it', async () => {
		const lead = groups.first();
		await lead.locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: 'Lead finished.' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await idle(lead);
		const text = (await lead.locator('.interactive-item-container.interactive-response').last().innerText()).replace(/\s+/g, ' ');
		if (!text.includes('From scout') || !text.includes(REPORT)) {
			throw new Error(`the lead's chat does not show the report from scout: ${JSON.stringify(text.slice(0, 600))}`);
		}
		const model = sent();
		for (const expected of ['the lead of the team \\"crew\\"', '<agent-message from=\\"scout\\"', '<agent-message from=\\"lead\\"', 'a teammate on the team \\"crew\\"']) {
			if (!model.includes(expected)) {
				throw new Error(`the model was never sent ${expected}`);
			}
		}
		await shot(win, 'report-in-lead');
	});

	await step(win, 'a teammate the user stopped is not woken by the lead\'s next message', async () => {
		const lead = groups.first();
		const scout = groups.nth(1);
		await scout.locator(INPUT).click();
		await win.keyboard.insertText('[[mock:busy]] Wait for a while.');
		await win.keyboard.press('Enter');
		await scout.locator('.interactive-item-container.interactive-response.chat-response-loading').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
			// The model has answered with the command once it was asked; give the command a moment to start.
		await mockSaw('[[mock:busy]]');
		await win.waitForTimeout(1500);
		await scout.locator('.interactive-input-part').getByRole('button', { name: /^Cancel/ }).first().click({ timeout: STEP_TIMEOUT });
		await idle(scout);
		const rows = await scout.locator('.interactive-item-container.interactive-request').count();
		await lead.locator(INPUT).click();
		await win.keyboard.insertText('[[mock:nudge]] Tell scout to carry on.');
		await win.keyboard.press('Enter');
		await lead.locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: 'Nudge sent.' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await idle(lead);
		if (!sent().includes('but it was not woken: the user stopped it')) {
			throw new Error('the lead was not told that scout is stopped');
		}
		// Long enough for a turn to have started had the message woken it.
		await win.waitForTimeout(3000);
		const after = await scout.locator('.interactive-item-container.interactive-request').count();
		if (after !== rows || await scout.locator('.chat-response-loading').count() || sent().includes('Busy turn went on.')) {
			throw new Error(`the stopped teammate started working again (${rows} -> ${after} requests in its chat)`);
		}
		await shot(win, 'stopped-not-woken');
	});

	await step(win, 'the Messages chip in another chat cycles Off, On, Muted', async () => {
		await runCommand(win, 'Chat: Open Chat');
		const panel = win.locator('.part.auxiliarybar, .part.panel, .part.sidebar').filter({ has: win.locator(INPUT) }).first();
		const messages = chip(panel);
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			const before = await messages.getAttribute('class');
			seen.push(/dragon-messaging-(?<mode>off|on|muted)/.exec(before ?? '')?.groups?.mode ?? 'none');
			await messages.click();
			await win.waitForFunction(previous => [...document.querySelectorAll('.part.auxiliarybar .dragon-messaging-toggle, .part.panel .dragon-messaging-toggle, .part.sidebar .dragon-messaging-toggle')].some(el => el.getAttribute('class') !== previous), before, { timeout: STEP_TIMEOUT });
		}
		if (seen.join(',') !== 'off,on,muted') {
			throw new Error(`the chip went through ${seen.join(', ')}`);
		}
		await shot(win, 'messages-chip');
	});

} catch (err) {
	failed = true;
	if (!(err instanceof StepError)) {
		console.log(`FAIL  launch: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
	}
} finally {
	if (app) {
		const closed = await Promise.race([app.close().then(() => true, () => false), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 15_000))]);
		if (!closed) {
			// On Windows a kill ends only the main process, and the OpenCode server it started keeps the workspace
			// (its working folder) in use, so end the whole tree.
			if (process.platform === 'win32') {
				spawnSync('taskkill', ['/pid', String(app.process().pid), '/t', '/f']);
			} else {
				app.process().kill('SIGKILL');
			}
		}
	}
	fs.writeFileSync(path.join(out, 'mock-requests.json'), JSON.stringify(mock.requests, null, 2));
	const openCodeLogs = path.join(xdg.XDG_DATA_HOME, 'opencode', 'log');
	if (fs.existsSync(openCodeLogs)) {
		fs.cpSync(openCodeLogs, path.join(out, 'opencode-logs'), { recursive: true });
	}
	if (fs.existsSync(path.join(userData, 'logs'))) {
		fs.cpSync(path.join(userData, 'logs'), path.join(out, 'logs'), { recursive: true, force: true });
	}
	await mock.close();
	try {
		fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
	} catch (err) {
		// Windows can keep an ended process's files in use a little longer; a leftover temp folder fails no check.
		console.log(`note: could not remove ${temp}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
console.log(failed ? 'Agents smoke test failed.' : 'Agents smoke test passed.');
console.log(`Screenshots and logs: ${out}`);
process.exitCode = failed ? 1 : 0;
