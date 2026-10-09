/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Onboarding smoke test for the desktop app: launches Dragon IDE on a fresh profile and an
// untrusted folder, with a scripted fake Ollama, and walks the first-run flow a user sees:
//   1. the dragon splash
//   2. one-button entry without credentials, including keyboard focus containment
//   3. Connect AI inside the app, then the normal workspace trust dialog
//   4. picking a local model in-app, which creates its agent variant (with a larger context window)
//   5. a Dragon turn that reads and edits a file, approving the edit when Dragon asks (the default
//      permission mode asks first), with Dragon tool cards and the diff, and the whole answer shown
//      outside its reasoning when the model reports the reasoning ended after the answer started
// Every step asserts on the app itself, and the file on disk and the requests the fake Ollama
// received are checked too, so a turn answered by some other model cannot pass.
// On a machine too small for the model (an 8 GB CI runner), step 4 checks that the app refuses it
// with the reason instead, and step 5 is reported as skipped.
//
// Usage: node scripts/dragon/smoke-onboarding.mts [--app <packaged app dir>] [--out <dir>]
//   Without --app it runs the development build (after `npm run compile` and `npm run electron`).
//   Linux: run under xvfb-run. Screenshots, the OpenCode log and the app's logs go to --out.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import { detectHardware, LOCAL_MODELS, unsupportedReason } from '../../extensions/dragon-agent/src/localAI/catalog.ts';
import { startMockOllama } from '../../extensions/dragon-agent/src/test/mockOllama.ts';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright') as typeof import('playwright');
const root = path.resolve(import.meta.dirname, '..', '..');
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
	const match = /^--(app|out)$/.exec(process.argv[i]);
	if (!match || i + 1 >= process.argv.length) {
		throw new Error(`Unknown argument: ${process.argv[i]}. Usage: smoke-onboarding.mts [--app <dir>] [--out <dir>]`);
	}
	args[match[1]] = process.argv[++i];
}
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-smoke-')));
fs.mkdirSync(out, { recursive: true });

/** The model the fake Ollama serves. Onboarding creates `<MODEL>-dragon-<n>k` from it. */
const MODEL = 'qwen2.5-coder:7b';
const STEP_TIMEOUT = 90_000;
/** Why the app will not run MODEL on this machine (the rule its model picker uses), if it will not. */
const tooSmall = unsupportedReason(LOCAL_MODELS.find(m => m.runtime === 'ollama' && m.id === MODEL)!, await detectHardware(), true);

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
	const dev = { args: [root], env: { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' } };
	switch (process.platform) {
		case 'darwin': return { path: path.join(root, '.build', 'electron', `${product.nameLong}.app`, 'Contents', 'MacOS', product.nameShort), ...dev };
		case 'linux': return { path: path.join(root, '.build', 'electron', product.applicationName), ...dev };
		default: return { path: path.join(root, '.build', 'electron', `${product.nameShort}.exe`), ...dev };
	}
}

/** Fails with a readable message, after a screenshot of what was on screen. */
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

class StepError extends Error { }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-smoke-run-'));
const workspace = path.join(temp, 'work');
const userData = path.join(temp, 'user-data');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hello world\n');
// Only local models: without this, OpenCode also offers its free hosted models, and a turn could
// go to one of those (over the network) instead of the model onboarding set up.
fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', enabled_providers: ['ollama'] }, null, '\t') + '\n');

const mock = await startMockOllama([
	{ kind: 'tool', name: 'read', args: { path: 'hello.txt' } },
	{ kind: 'tool', name: 'edit', args: { path: 'hello.txt', oldString: 'hello world', newString: 'hello dragon' } },
	// Slow, as Nemotron on OpenCode Zen is: OpenCode publishes the start of the answer before it reports
	// the reasoning ended, and the answer must still show in full, not folded away with the reasoning.
	{ kind: 'text', reasoning: ['The file now greets the dragon.'], chunks: ['Changed ', 'hello.txt ', 'to greet the dragon.'], pause: 500 },
], MODEL);

fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'window.dialogStyle': 'custom', // native dialogs cannot be driven from the page
	'dragon.ollama.origin': mock.origin,
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
	throw new Error(`Dragon IDE not found at ${exe.path}. ${args.app ? 'Check --app.' : 'Run `npm run compile` and `npm run electron` first, or pass --app.'}`);
}
// OpenCode keeps its data, config and cache under the XDG directories; keep them out of the user's.
const xdg = Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(name => {
	const dir = path.join(temp, name.toLowerCase());
	fs.mkdirSync(dir);
	return [name, dir];
}));

let app: ElectronApplication | undefined;
let page: Page | undefined;
let failed = false;
let skipped = false;
try {
	app = await _electron.launch({
		executablePath: exe.path,
		args: [
			...exe.args,
			...(process.platform === 'linux' ? ['--no-sandbox'] : []),
			'--use-inmemory-secretstorage', // Test profile never accesses the user's macOS Keychain.
			'--disable-gpu', '--skip-release-notes', '--disable-telemetry',
			'--shared-data-dir', path.join(temp, 'shared-data'),
			'--user-data-dir', userData, '--extensions-dir', path.join(temp, 'extensions'),
			workspace,
		],
		cwd: args.app ? temp : root,
		env: Object.fromEntries(Object.entries({ ...process.env, ...exe.env, ...xdg, OPENCODE_TEST_HOME: temp }).filter((e): e is [string, string] => e[1] !== undefined)),
		timeout: STEP_TIMEOUT,
	});
	page = await app.firstWindow({ timeout: STEP_TIMEOUT });
	const win = page;
	await win.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);

	await step(win, 'splash', async () => {
		await win.waitForSelector('#monaco-parts-splash .dragon-doom-loader', { state: 'attached', timeout: STEP_TIMEOUT });
		await shot(win, 'splash');
	});

	await step(win, 'credential-free entry', async () => {
		await win.waitForSelector('.dragon-onboarding[role=dialog]', { state: 'visible', timeout: STEP_TIMEOUT });
		if (await win.locator('.dragon-onboarding input, .dragon-onboarding select, .dragon-onboarding-card').count()) {
			throw new Error('provider setup is still on the entrance');
		}
		const title = (await win.textContent('.dragon-onboarding-title'))?.trim();
		if (title !== 'Dragon IDE') {
			throw new Error(`the entrance is headed ${JSON.stringify(title)}, not "Dragon IDE"`);
		}
		if (await win.locator('.dragon-onboarding button').count() !== 1) {
			throw new Error('the entrance must contain exactly one button');
		}
		const enter = win.getByRole('button', { name: 'Enter FREEDOM AI', exact: true });
		await enter.focus();
		await win.keyboard.press('Shift+Tab');
		if (!await enter.evaluate(el => el === document.activeElement)) {
			throw new Error('focus escaped the entrance');
		}
		await win.emulateMedia({ reducedMotion: 'reduce' });
		if (!await enter.evaluate(el => getComputedStyle(el).transitionDuration === '0s')) {
			throw new Error('entry animation ignores reduced motion');
		}
		await win.emulateMedia({ reducedMotion: 'no-preference' });
		await win.setViewportSize({ width: 640, height: 640 });
		await shot(win, 'freedom-entry-compact');
		await win.setViewportSize({ width: 1440, height: 900 });
		await shot(win, 'freedom-entry');
		await win.keyboard.press('Enter');
		await win.waitForSelector('.dragon-onboarding', { state: 'detached', timeout: STEP_TIMEOUT });
		await win.waitForFunction(() => getComputedStyle(document.querySelector('.monaco-workbench')!).getPropertyValue('--vscode-button-background').trim().toLowerCase() === '#f59a45', undefined, { timeout: STEP_TIMEOUT });
		await win.locator('.gettingStartedContainer .dragon-home-connect').waitFor({ state: 'visible' });
		// The Welcome page shows the product name, which development builds suffix with " Dev".
		const heading = (await win.textContent('.gettingStartedContainer .dragon-welcome-header .product-name'))?.trim();
		if (!/^Dragon IDE( Dev)?$/.test(heading ?? '')) {
			throw new Error(`the Welcome page is headed ${JSON.stringify(heading)}, not "Dragon IDE"`);
		}
		if (await win.locator('[id="chat.statusBarEntry"]').count()) {
			throw new Error('subscription status control is still visible');
		}
		await shot(win, 'freedom-home');
	});

	await step(win, 'connect inside the workspace and request trust', async () => {
		await win.locator('.gettingStartedContainer .dragon-home-connect').click();
		const dialog = await win.waitForSelector('.monaco-dialog-box', { state: 'visible', timeout: STEP_TIMEOUT });
		await shot(win, 'trust-dialog');
		await (await dialog.waitForSelector('a.monaco-button:has-text("Trust Folder")')).click();
		await win.waitForSelector('.monaco-dialog-box', { state: 'detached', timeout: STEP_TIMEOUT });
	});

	const variant = await step(win, 'pick a local model inside the app', async () => {
		const options = win.locator('.quick-input-widget .monaco-list-row');
		await options.filter({ hasText: 'Connect a provider with an API key' }).waitFor({ timeout: STEP_TIMEOUT });
		await options.filter({ hasText: 'Sign in to a provider' }).waitFor({ timeout: STEP_TIMEOUT });
		await shot(win, 'connect-ai-options');
		await options.filter({ hasText: 'Run a model locally with Splash' }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await options.filter({ hasText: 'Run a model locally with Ollama' }).click();
		await shot(win, 'hardware-aware-local-models');
		if (tooSmall) {
			await options.filter({ hasText: 'Qwen2.5 Coder 7B' }).filter({ hasText: tooSmall }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
			console.log(`note: the app refuses Qwen2.5 Coder 7B on this machine, as it should: ${tooSmall}`);
			return undefined;
		}
		await options.filter({ hasText: 'Qwen2.5 Coder 7B' }).first().click({ timeout: STEP_TIMEOUT });
		await win.waitForSelector('.interactive-input-part .monaco-editor[role="code"]', { state: 'visible', timeout: STEP_TIMEOUT });
		const deadline = Date.now() + STEP_TIMEOUT;
		while (!mock.requests.some(r => r.path === '/api/create') && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		const create = mock.requests.find(r => r.path === '/api/create')?.body as { model?: string; from?: string; parameters?: { num_ctx?: number } } | undefined;
		if (!create?.model || create.from !== MODEL || !create.model.startsWith(`${MODEL}-dragon-`) || !create.parameters?.num_ctx) {
			throw new Error(`no agent variant was created from ${MODEL}: ${JSON.stringify(create)}`);
		}
		return create.model;
	});

	if (!variant) {
		console.log(`SKIP  Dragon turn reads and edits a file: it needs the local model (${tooSmall})`);
		skipped = true;
	} else {
		await step(win, 'Dragon turn reads and edits a file', async () => {
			const input = '.interactive-input-part .monaco-editor[role="code"]';
			await win.waitForSelector(input, { state: 'visible', timeout: STEP_TIMEOUT });
			// The chat model picker shows the model onboarding set up before the user types, as a user
			// would see it. The side bar's chat is too narrow for the picker, which moves into More Actions,
			// so the chat is maximized first. Its label ("Models, <model>") names the model.
			// Its title bar button, unlike the Command Palette, is not closed when Connect AI focuses the chat.
			if (await win.locator('.part.auxiliarybar .interactive-input-part').count()) {
				await win.locator('.part.auxiliarybar .action-label[aria-label^="Maximize Secondary Side Bar"]').click({ timeout: STEP_TIMEOUT });
			}
			const picker = win.locator('.interactive-input-part .model-picker-split');
			const pickerLabel = async () => (await picker.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? ''))).join(' | ');
			const wanted = variant.split(':').pop()!;
			for (const end = Date.now() + STEP_TIMEOUT; !(await pickerLabel()).includes(wanted) && Date.now() < end;) {
				await win.waitForTimeout(250);
			}
			if (!(await pickerLabel()).includes(wanted)) {
				throw new Error(`the model picker reads ${JSON.stringify(await pickerLabel())}, not the new variant ${wanted}`);
			}
			await win.click(input);
			// Dragon answers in Agent mode without an @-mention. The text is inserted rather than typed
			// key by key, so the completion widget cannot turn it into a slash command.
			await win.keyboard.insertText('In hello.txt, change "hello world" to "hello dragon".');
			await win.keyboard.press('Enter');
			// The default permission mode asks before an edit. Approve it as a user would; a turn that edits
			// without asking never shows this prompt and fails here.
			const approval = await win.waitForSelector('.chat-question-carousel-container:has(.chat-question-submit-button)', { state: 'visible', timeout: STEP_TIMEOUT });
			const asked = ((await approval.textContent()) ?? '').replace(/\s+/g, ' ');
			if (!asked.includes('hello.txt')) {
				throw new Error(`the approval prompt reads ${JSON.stringify(asked)}, not about hello.txt`);
			}
			// Picking an option answers a one-question prompt; Submit is only needed when it does not.
			await (await approval.waitForSelector('.chat-question-list-item:has-text("Allow once")')).click();
			const submit = await approval.$('.chat-question-submit-button');
			if (await submit?.isVisible().catch(() => false)) {
				await submit?.click({ timeout: 2000 }).catch(() => undefined);
			}
			const response = await win.waitForSelector('.interactive-item-container.interactive-response:not(.chat-response-loading):has(.rendered-markdown:has-text("to greet the dragon"))', { timeout: STEP_TIMEOUT });
			const responder = (await response.$eval('.username', el => el.textContent).catch(() => null))?.trim();
			if (responder !== 'Dragon') {
				throw new Error(`the response came from ${JSON.stringify(responder)}, not Dragon`);
			}
			const answer = await response.$$eval('.rendered-markdown', els => els
				.filter(el => !el.closest('.completed-response-disclosure, .chat-thinking-box'))
				.map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim()).join(' '));
			if (!answer.includes('Changed hello.txt to greet the dragon.')) {
				throw new Error(`the answer outside the steps and the reasoning reads ${JSON.stringify(answer)}, not the whole reply`);
			}
			const readCards = () => win.$$eval('.dragon-tool-card', els => els.map(el => ({ ok: el.classList.contains('dragon-tool-card-success'), text: (el.textContent ?? '').replace(/\s+/g, ' ').trim() })));
			let cards = await readCards();
			if (cards.length < 2) {
				// A response that is already complete when its steps are drawn (a slow machine, Rosetta) starts
				// with them collapsed, and collapsed steps are only rendered on first expand. Open them as a user would.
				const disclosure = await response.$('details.completed-response-disclosure:not([open]) > summary');
				await disclosure?.click();
				for (let round = 0; round < 3 && cards.length < 2; round++) {
					for (const header of await response.$$('.chat-used-context-label [aria-expanded="false"]')) {
						await header.click().catch(() => undefined);
					}
					await win.waitForTimeout(500);
					cards = await readCards();
				}
				console.log(`note: the steps were collapsed; opened them and found ${cards.length} tool cards`);
			}
			if (cards.length < 2 || !cards.every(c => c.ok) || !cards.some(c => /hello\.txt/.test(c.text))) {
				throw new Error(`expected successful Dragon tool cards for the read and the edit of hello.txt, got ${JSON.stringify(cards)}`);
			}
			await win.waitForSelector('.checkpoint-file-changes-summary', { state: 'visible', timeout: STEP_TIMEOUT });
			await shot(win, 'chat-turn');
			const content = fs.readFileSync(path.join(workspace, 'hello.txt'), 'utf8');
			if (content !== 'hello dragon\n') {
				throw new Error(`hello.txt was not edited: ${JSON.stringify(content)}`);
			}
			const turns = mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && (r.body as { tools?: unknown[] })?.tools?.length);
			const models = [...new Set(turns.map(r => (r.body as { model?: string }).model))];
			if (turns.length < 3 || models.length !== 1 || models[0] !== variant) {
				throw new Error(`the turn did not run on ${variant} through the fake Ollama: ${turns.length} requests, models ${JSON.stringify(models)}`);
			}
		});
	}
} catch (err) {
	failed = true;
	if (!(err instanceof StepError)) {
		console.log(`FAIL  launch: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
	}
} finally {
	if (app) {
		// A prompt on close (such as keeping the chat's edits) can veto a graceful quit; don't wait on it.
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
	if (fs.existsSync(openCodeLogs)) { fs.cpSync(openCodeLogs, path.join(out, 'opencode-logs'), { recursive: true }); }
	await mock.close();
	// Keep the logs, OpenCode's included, next to the screenshots.
	if (fs.existsSync(path.join(userData, 'logs'))) {
		fs.cpSync(path.join(userData, 'logs'), path.join(out, 'logs'), { recursive: true, force: true });
	}
	try {
		fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
	} catch (err) {
		// Windows can keep an ended process's files in use a little longer; a leftover temp folder fails no check.
		console.log(`note: could not remove ${temp}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
console.log(failed ? 'Onboarding smoke test failed.' : skipped ? 'Onboarding smoke test passed, with the local-model turn skipped (see SKIP above).' : 'Onboarding smoke test passed.');
console.log(`Screenshots and logs: ${out}`);
process.exitCode = failed ? 1 : 0;
