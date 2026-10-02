/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Usage readout smoke test for the desktop app. Launches Dragon IDE on a fresh profile with a
// scripted OpenAI-compatible provider that has prices and reports cached prompt tokens, and checks,
// in the running app:
//   1. a chat turn, then the composer's usage readout: context ring, "80% cache hit", "$3 / $15 per 1M",
//      uncovered in the default (narrow) side bar and on the chips' row in a wide one
// A workspace plugin that loads slowly holds back OpenCode's provider loading, as a slow machine does: until then
// OpenCode lists no models or only its built-in ones, so the model picker must catch up before the turn is sent.
//
// Usage: node scripts/dragon/smoke-usage.mts [--app <packaged app dir>] [--out <dir>]
//   Without --app it runs the development build (after `npm run compile` and `npm run electron`).
//   Linux: run under xvfb-run.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';
import { startMockOllama } from '../../extensions/dragon-agent/src/test/mockOllama.ts';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright') as typeof import('playwright');
const root = path.resolve(import.meta.dirname, '..', '..');
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
	const match = /^--(app|out)$/.exec(process.argv[i]);
	if (!match || i + 1 >= process.argv.length) {
		throw new Error(`Unknown argument: ${process.argv[i]}. Usage: smoke-usage.mts [--app <dir>] [--out <dir>]`);
	}
	args[match[1]] = process.argv[++i];
}
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-usage-smoke-')));
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-usage-run-'));
const workspace = path.join(temp, 'work');
const userData = path.join(temp, 'user-data');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'todo\n');
const slowPlugin = path.join(temp, 'slow-plugin');
fs.mkdirSync(slowPlugin);
fs.writeFileSync(path.join(slowPlugin, 'index.mjs'), 'await new Promise(resolve => setTimeout(resolve, 8000));\nexport default async () => ({});\n');

// A hosted-style provider: prices in the config, and 8,000 of every 10,000 prompt tokens cached.
const mock = await startMockOllama([{ kind: 'text', chunks: ['Hi from the chat.'] }], MODEL, 0, {
	usage: { prompt: 10_000, completion: 500, cached: 8_000 },
});
fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({
	$schema: 'https://opencode.ai/config.json',
	enabled_providers: ['acme'],
	plugins: [pathToFileURL(slowPlugin).href],
	providers: {
		acme: {
			name: 'Acme', package: '@opencode/ai/providers/openai-compatible',
			settings: { baseURL: `${mock.origin}/v1`, apiKey: 'test' },
			models: { [MODEL]: { name: 'Acme Large', limit: { context: 200_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] }, cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }] } },
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

let app: ElectronApplication | undefined;
let failed = false;
try {
	app = await _electron.launch({
		executablePath: exe.path,
		args: [
			...exe.args,
			...(process.platform === 'linux' ? ['--no-sandbox'] : []),
			'--use-inmemory-secretstorage', '--disable-gpu', '--skip-release-notes', '--disable-telemetry',
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

	await step(win, 'enter the workbench', async () => {
		// A fresh profile starts on the one-button entrance.
		await win.waitForSelector('.dragon-onboarding[role=dialog]', { state: 'visible', timeout: STEP_TIMEOUT });
		await win.getByRole('button', { name: 'Enter FREEDOM AI', exact: true }).click();
		await win.waitForSelector('.dragon-onboarding', { state: 'detached', timeout: STEP_TIMEOUT });
		await win.waitForSelector('.monaco-workbench', { timeout: STEP_TIMEOUT });
	});

	await step(win, 'chat turn and the composer usage readout', async () => {
		await runCommand(win, 'Chat: Open Chat');
		const input = '.interactive-input-part .monaco-editor[role="code"]';
		await win.waitForSelector(input, { state: 'visible', timeout: STEP_TIMEOUT });
		// Send only once the picker shows the scripted model, as a person would. Before Dragon is ready the chat
		// has no agent to send to, and while OpenCode loads the workspace's providers it lists other models.
		const picker = win.locator('.interactive-input-part .chat-input-toolbars');
		await picker.getByText('Acme Large', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the model picker shows ${JSON.stringify((await picker.innerText().catch(() => '')).replace(/\s+/g, ' ').trim())}, not Acme Large`, { cause: err });
		});
		await win.click(input);
		await win.keyboard.insertText('[[chat]] Say hi.');
		await win.keyboard.press('Enter');
		await win.waitForSelector('.interactive-item-container.interactive-response:not(.chat-response-loading):has(.rendered-markdown:has-text("Hi from the chat"))', { timeout: STEP_TIMEOUT });
		const usage = win.locator('.interactive-input-part .dragon-usage');
		await usage.locator('.dragon-usage-cache', { hasText: '80% cache hit' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await usage.locator('.dragon-usage-price', { hasText: '$3 / $15 per 1M' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		const context = await usage.locator('.dragon-usage-context').textContent();
		if (!/^\d+%$/.test((context ?? '').trim()) || (context ?? '').trim() === '0%') {
			throw new Error(`the context ring reads ${JSON.stringify(context)}`);
		}
		const tooltip = await usage.locator('.dragon-usage-cache').getAttribute('title');
		if (!tooltip?.includes('Cache read 8,000')) {
			throw new Error(`cache tooltip: ${tooltip}`);
		}
		// Toasts (such as the running-as-root warning in containers) sit over the composer.
		await runCommand(win, 'Notifications: Clear All Notifications');
		await win.locator('.notifications-toasts .notification-toast').first().waitFor({ state: 'hidden', timeout: STEP_TIMEOUT });
		const expectUncovered = async () => {
			for (const pill of ['.dragon-usage-context', '.dragon-usage-cache', '.dragon-usage-price']) {
				const onTop = await usage.locator(pill).evaluate(element => {
					const box = element.getBoundingClientRect();
					const hit = element.ownerDocument.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
					return !!hit && element.contains(hit);
				});
				if (!onTop) {
					throw new Error(`${pill} is covered or outside the window`);
				}
			}
		};
		// The default side bar is too narrow for one row: the readout takes a row of its own.
		await expectUncovered();
		await shot(win, 'composer-usage');
		// A wide composer fits the chips and the readout on one row.
		await runCommand(win, 'View: Maximize Secondary Side Bar');
		const chips = win.locator('.interactive-input-part .dragon-composer-chips');
		await win.waitForFunction(() => (document.querySelector('.interactive-input-part .dragon-composer-chips')?.getBoundingClientRect().width ?? 0) > 0 && (document.querySelector('.interactive-input-part .chat-secondary-toolbar')?.getBoundingClientRect().width ?? 0) > 900, undefined, { timeout: STEP_TIMEOUT });
		await expectUncovered();
		const [chipsTop, usageTop] = [(await chips.boundingBox())?.y ?? -1, (await usage.boundingBox())?.y ?? -2];
		if (Math.abs(chipsTop - usageTop) > 4) {
			throw new Error(`in a wide composer the readout is not on the chips' row (${chipsTop} vs ${usageTop})`);
		}
		await shot(win, 'composer-usage-wide');
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
console.log(failed ? 'Usage smoke test failed.' : 'Usage smoke test passed.');
console.log(`Screenshots and logs: ${out}`);
process.exitCode = failed ? 1 : 0;
