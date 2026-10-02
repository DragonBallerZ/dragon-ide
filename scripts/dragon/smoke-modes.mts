/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan and execution smoke test for the desktop app. Launches Dragon IDE on a fresh profile with a
// scripted model and runs one chat through the modes, choosing in the UI as a person would:
//   1. Agent mode, Ask permission (the default): a command and an edit each wait for "Allow once", then happen
//   2. Deny: the command does not run, and the chat shows it as skipped, not as run
//   3. Ask mode (OpenCode's plan agent): its write and edit fail, nothing is asked, and the plan shows
//   4. Read-Only (the composer chip), back in Agent mode: no command or edit is offered, run or asked for
//   5. Full Access: the command runs without asking
// Every step checks the workspace on disk and what the model was sent, not only the chat.
//
// Usage: node scripts/dragon/smoke-modes.mts [--app <packaged app dir>] [--out <dir>]
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
		throw new Error(`Unknown argument: ${process.argv[i]}. Usage: smoke-modes.mts [--app <dir>] [--out <dir>]`);
	}
	args[match[1]] = process.argv[++i];
}
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-modes-smoke-')));
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-modes-run-'));
const workspace = path.join(temp, 'work');
const userData = path.join(temp, 'user-data');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'notes.txt'), 'todo\n');

// Each turn's prompt names its script with a `[[mock:<name>]]` marker.
const edit = (newString: string): ScriptStep => ({ kind: 'tool', name: 'edit', args: { path: 'notes.txt', oldString: 'todo', newString } });
const shell = (command: string): ScriptStep => ({ kind: 'tool', name: 'shell', args: { command } });
// Node rather than `touch` or `>>`: OpenCode runs PowerShell on Windows, and the bytes must match on every platform.
const append = (file: string, line: string) => shell(`node -e "require('fs').appendFileSync('${file}', '${line}\\n')"`);
const create = (file: string) => shell(`node -e "require('fs').writeFileSync('${file}', '')"`);
const say = (text: string): ScriptStep => ({ kind: 'text', chunks: [text] });
const mock = await startMockOllama([say('No scenario.')], MODEL, 0, {
	scenarios: {
		agent: [append('shell.log', 'agent'), edit('todo: done'), say('Agent turn finished.')],
		deny: [create('denied.txt'), say('Deny turn went on.')],
		plan: [{ kind: 'tool', name: 'write', args: { path: 'plan.txt', content: 'plan\n' } }, edit('todo: planned'), say('The plan: read notes.txt, then mark it done.')],
		readonly: [create('readonly.txt'), edit('todo: read-only'), say('Read-only turn finished.')],
		full: [create('full.txt'), say('Full access turn finished.')],
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
// No `dragon.permissionMode`: the default (Ask) is what a new user gets.
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'window.dialogStyle': 'custom',
	'security.workspace.trust.enabled': false,
	'dragon.model': `acme/${MODEL}`,
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

/** The workspace files a turn may have touched, as they are on disk. */
function disk(): Record<string, string | null> {
	const read = (name: string) => fs.existsSync(path.join(workspace, name)) ? fs.readFileSync(path.join(workspace, name), 'utf8') : null;
	return Object.fromEntries(['notes.txt', 'shell.log', 'denied.txt', 'plan.txt', 'readonly.txt', 'full.txt'].map(name => [name, read(name)]));
}

function expectDisk(expected: Record<string, string | null>): void {
	const actual = disk();
	for (const [name, content] of Object.entries(expected)) {
		if (actual[name] !== content) {
			throw new Error(`${name} is ${JSON.stringify(actual[name])}, expected ${JSON.stringify(content)}`);
		}
	}
}

/** What the model was offered and told since request `from`. */
function sentSince(from: number): { tools: Set<string>; text: string } {
	const bodies = mock.requests.slice(from).filter(r => r.path.startsWith('/v1/chat/completions')).map(r => r.body as { tools?: { function?: { name?: string } }[] } | undefined);
	const withTools = bodies.filter(b => b?.tools?.length);
	if (!withTools.length) {
		throw new Error('the model was not asked anything with tools');
	}
	return { tools: new Set(withTools.flatMap(b => b!.tools!.map(t => t.function?.name ?? ''))), text: JSON.stringify(withTools) };
}

const INPUT = '.interactive-input-part .monaco-editor[role="code"]';
/** An approval prompt still waiting for an answer (it shows above the composer; answered ones lose their Submit button). */
const PENDING = '.chat-question-carousel-container:has(.chat-question-submit-button)';

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
	const responses = win.locator('.interactive-item-container.interactive-response');

	/** Sends a prompt and returns the new response, once a new one exists. */
	// The chat list is virtual: earlier turns leave the DOM, so a turn is found by its request, not by counting.
	const send = async (text: string): Promise<{ response: Locator; from: number }> => {
		const from = mock.requests.length;
		await win.click(INPUT);
		await win.keyboard.insertText(text);
		await win.keyboard.press('Enter');
		await win.waitForFunction(request => {
			const items = [...document.querySelectorAll('.interactive-item-container')];
			const index = items.findLastIndex(item => item.classList.contains('interactive-request') && item.textContent?.includes(request));
			return index >= 0 && items.slice(index + 1).some(item => item.classList.contains('interactive-response'));
		}, text, { timeout: STEP_TIMEOUT });
		return { response: responses.last(), from };
	};
	const finished = async (response: Locator, text: string) => {
		await response.locator('.rendered-markdown', { hasText: text }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await win.waitForFunction(() => !document.querySelector('.interactive-item-container.interactive-response.chat-response-loading'), undefined, { timeout: STEP_TIMEOUT });
	};
	/** Answers the approval prompt, after checking it names what OpenCode wants to do. */
	const answer = async (expect: string, option: 'Allow once' | 'Deny') => {
		const pending = win.locator(PENDING).first();
		await pending.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		const text = (await pending.innerText()).replace(/\s+/g, ' ');
		if (!text.includes(expect)) {
			throw new Error(`the approval prompt reads ${JSON.stringify(text)}, not about ${JSON.stringify(expect)}`);
		}
		// OpenCode ignores a note sent with a denial, so the prompt must not offer a text box.
		if (await pending.locator('.chat-question-freeform').count()) {
			throw new Error('the approval prompt offers a text box');
		}
		// Picking an option answers a one-question prompt; Submit is only needed when it does not.
		await pending.locator('.chat-question-list-item', { hasText: option }).first().click();
		const submit = pending.locator('.chat-question-submit-button');
		if (await submit.isVisible().catch(() => false)) {
			await submit.click({ timeout: 2000 }).catch(() => undefined);
		}
		await win.waitForFunction(selector => !document.querySelector(selector), PENDING, { timeout: STEP_TIMEOUT });
	};
	const expectNotAsked = async (turn: { response: Locator }) => {
		const asked = await turn.response.locator('.chat-question-carousel-container').count() + await win.locator(PENDING).count();
		if (asked) {
			throw new Error(`the chat asked for approval (${asked} prompt(s))`);
		}
	};
	const permission = win.locator('.interactive-input-part .dragon-permission-toggle');
	const setPermission = async (mode: 'readonly' | 'ask' | 'full') => {
		for (let i = 0; i < 3 && !(await permission.getAttribute('class'))?.includes(`dragon-permission-${mode}`); i++) {
			const before = await permission.getAttribute('class');
			await permission.click();
			await win.waitForFunction(([selector, previous]) => document.querySelector(selector!)?.getAttribute('class') !== previous, ['.interactive-input-part .dragon-permission-toggle', before], { timeout: STEP_TIMEOUT });
		}
		if (!(await permission.getAttribute('class'))?.includes(`dragon-permission-${mode}`)) {
			throw new Error(`the permission chip did not reach ${mode}: ${await permission.getAttribute('class')}`);
		}
	};
	const modePicker = win.locator('.interactive-input-part .chat-mode-picker-item');
	const setMode = async (label: 'Agent' | 'Ask') => {
		await modePicker.click();
		// Match the row's label alone: the row's text runs on into its keybinding ("AgentCtrl+Shift+Alt+I" off macOS).
		await win.locator('.action-widget .monaco-list-row .title', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).first().click({ timeout: STEP_TIMEOUT });
		await modePicker.filter({ hasText: label }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
	};

	await step(win, 'enter the workbench and open the chat', async () => {
		// A fresh profile starts on the one-button entrance.
		await win.waitForSelector('.dragon-onboarding[role=dialog]', { state: 'visible', timeout: STEP_TIMEOUT });
		await win.getByRole('button', { name: 'Enter FREEDOM AI', exact: true }).click();
		await win.waitForSelector('.dragon-onboarding', { state: 'detached', timeout: STEP_TIMEOUT });
		await win.waitForSelector('.monaco-workbench', { timeout: STEP_TIMEOUT });
		await runCommand(win, 'Chat: Open Chat');
		await win.waitForSelector(INPUT, { state: 'visible', timeout: STEP_TIMEOUT });
		// Send only once the picker shows the scripted model, as a person would.
		const picker = win.locator('.interactive-input-part .chat-input-toolbars');
		await picker.getByText('Acme Large', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the model picker shows ${JSON.stringify((await picker.innerText().catch(() => '')).replace(/\s+/g, ' ').trim())}, not Acme Large`, { cause: err });
		});
		await permission.and(win.locator('.dragon-permission-ask')).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`a new profile should start in Ask permission mode; the chip is ${await permission.getAttribute('class')}`, { cause: err });
		});
		await modePicker.filter({ hasText: 'Agent' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		// Toasts (such as the running-as-root warning in containers) sit over the composer.
		await runCommand(win, 'Notifications: Clear All Notifications');
	});

	await step(win, 'Agent mode asks before a command and an edit, then runs them', async () => {
		const turn = await send('[[mock:agent]] Log a line and mark notes.txt done.');
		await answer('shell.log', 'Allow once');
		await answer('notes.txt', 'Allow once');
		await finished(turn.response, 'Agent turn finished.');
		expectDisk({ 'notes.txt': 'todo: done\n', 'shell.log': 'agent\n' });
		const sent = sentSince(turn.from);
		if (!sent.tools.has('shell') || !sent.tools.has('edit') || sent.text.includes('You are in Plan mode')) {
			throw new Error(`Agent mode should run the build agent with shell and edit: tools ${[...sent.tools].join(', ')}`);
		}
		await turn.response.getByText('Changed 1 file', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await shot(win, 'agent-mode-approved');
	});

	await step(win, 'Deny keeps the command from running', async () => {
		const turn = await send('[[mock:deny]] Create denied.txt.');
		await answer('denied.txt', 'Deny');
		await win.waitForFunction(() => !document.querySelector('.interactive-item-container.interactive-response.chat-response-loading'), undefined, { timeout: STEP_TIMEOUT });
		expectDisk({ 'denied.txt': null, 'notes.txt': 'todo: done\n', 'shell.log': 'agent\n' });
		if (await turn.response.getByText('Deny turn went on.').count()) {
			throw new Error('the turn went on after Deny');
		}
		await turn.response.locator('.dragon-tool-card-error').getByText('Skipped running').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		// The check the later steps rely on must see an answered prompt where there is one.
		if (await turn.response.locator('.chat-question-carousel-container').count() !== 1) {
			throw new Error('the answered approval prompt is not in the response');
		}
		if (await turn.response.getByText(/\bRan\b/).count()) {
			throw new Error('the denied command reads as run');
		}
		await shot(win, 'agent-mode-denied');
	});

	await step(win, 'Ask mode plans without changing files', async () => {
		await setMode('Ask');
		const turn = await send('[[mock:plan]] How should I finish notes.txt?');
		await finished(turn.response, 'The plan: read notes.txt, then mark it done.');
		await expectNotAsked(turn);
		expectDisk({ 'notes.txt': 'todo: done\n', 'plan.txt': null });
		if (!sentSince(turn.from).text.includes('You are in Plan mode')) {
			throw new Error('Ask mode did not run the plan agent');
		}
		await shot(win, 'ask-mode-plan');
	});

	await step(win, 'Read-Only runs no command or edit, even in Agent mode', async () => {
		await setMode('Agent');
		await setPermission('readonly');
		const turn = await send('[[mock:readonly]] Create readonly.txt and edit notes.txt.');
		await finished(turn.response, 'Read-only turn finished.');
		await expectNotAsked(turn);
		expectDisk({ 'readonly.txt': null, 'notes.txt': 'todo: done\n', 'shell.log': 'agent\n' });
		const sent = sentSince(turn.from);
		if (sent.tools.has('shell') || sent.tools.has('edit') || sent.tools.has('write') || !sent.text.includes('You are in Plan mode')) {
			throw new Error(`Read-Only should offer the plan agent no shell or edit tools: tools ${[...sent.tools].join(', ')}`);
		}
		await shot(win, 'read-only');
	});

	await step(win, 'Full Access runs the command without asking', async () => {
		await setPermission('full');
		const turn = await send('[[mock:full]] Create full.txt.');
		await finished(turn.response, 'Full access turn finished.');
		await expectNotAsked(turn);
		expectDisk({ 'full.txt': '', 'notes.txt': 'todo: done\n' });
		await shot(win, 'full-access');
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
console.log(failed ? 'Modes smoke test failed.' : 'Modes smoke test passed.');
console.log(`Screenshots and logs: ${out}`);
process.exitCode = failed ? 1 : 0;
