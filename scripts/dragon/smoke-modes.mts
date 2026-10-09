/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Plan and execution smoke test for the desktop app. Launches Dragon IDE on a fresh profile with a
// scripted model and runs one chat through the modes, choosing in the UI as a person would:
//   1. Agent mode, Ask permission (the default): a command and an edit each wait for "Allow once", then happen
//   2. Deny: the command does not run, and the chat shows it as skipped, not as run
//   3. A message typed while an approval prompt is open stops the work: the prompt is skipped, the
//      command does not run, and the message reaches the model and gets its reply
//   4. Two commands ask at once: both approval prompts are open together, and denying one closes the
//      other, which OpenCode then denied itself; neither runs, and both read as denied
//   5. Ask mode (OpenCode's plan agent): its write and edit fail, nothing is asked, and the plan shows
//   6. Read-Only (the composer chip), back in Agent mode: no command or edit is offered, run or asked for
//   7. Full Access: the command runs without asking
//   8. Full Access reaches the whole disk: an agent reads a file in the folder beside the open one, it is
//      sent to the model, and the agent writes there, with nothing refused
//   9. Project Only keeps agents to the open folder: an agent's read, write and search of a folder beside it
//      are refused, nothing is asked, and nothing from that folder reaches the model
//  10. (macOS) Project Only shell commands stay in the open folder: reading and writing a folder in the home
//      folder fail in the sandbox, a command in the project still runs, and nothing is asked
//  11. Project Only does not follow a symbolic link out of the open folder: reading and writing through a
//      link in the project to the folder beside it are refused, nothing is asked, and nothing from there
//      reaches the model
//  12. A folder taken out of the window is closed to agents at once: the window opens two folders, the user
//      removes the second with Remove Folder from Workspace, and in the same chat an agent's read and write
//      there (and on macOS its shell command) are refused, and nothing from it reaches the model
//  13. Project Only keeps agents to their own saved output: an agent reads the long output OpenCode saved for
//      it, but not the output it saved for another window, nor the folder beside the open one through a link
//      a command made in OpenCode's temp folder; nothing from either reaches the model
//  14. Project Only keeps agents to the plans written in the window: an agent writes a plan in OpenCode's plan
//      folder, which every project shares, and reads it back, but not another project's plan there, nor the
//      folder, which would list it; nothing from that plan reaches the model
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
// A folder beside the open one, which agents must not reach, and what no request to the model may carry.
const outside = path.join(temp, 'private');
const SECRET = 'not-for-agents-7f3a';
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), `${SECRET}\n`);
// What the one mode that reaches the whole disk, Full Access, reads from the folder beside the open one. It is
// its own marker, not the secret above, so that read (which Full Access is meant to make) does not leave the
// secret in the chat history the later, confined turns are re-sent, where it would read as a confinement leak.
const REACHED = 'reached-by-full-access-2b9e';
fs.writeFileSync(path.join(outside, 'reach.txt'), `${REACHED}\n`);
// On macOS, a folder in the real home folder, which the sandbox closes to agents' shell commands, and the
// sandbox's own folders there that this run adds, removed at the end.
const sandboxed = process.platform === 'darwin';
const sandboxFolder = path.join(os.homedir(), '.dragon', 'sandbox');
const sandboxHomes = () => { try { return fs.readdirSync(path.join(sandboxFolder, 'homes')); } catch { return []; } };
const sandboxBefore = new Set(sandboxHomes());
const homeOutside = sandboxed ? (fs.mkdirSync(path.join(os.homedir(), '.dragon'), { recursive: true }), fs.mkdtempSync(path.join(os.homedir(), '.dragon', 'smoke-'))) : '';
const HOME_SECRET = 'not-for-shells-5c1d';
if (sandboxed) {
	fs.writeFileSync(path.join(homeOutside, 'secret.txt'), `${HOME_SECRET}\n`);
}
// The window's second folder, which the user takes out of it in the last step. On macOS it is in the home
// folder, which the sandbox closes to shell commands once the folder is out of the window.
const assets = sandboxed ? fs.mkdtempSync(path.join(os.homedir(), '.dragon', 'smoke-assets-')) : path.join(temp, 'assets');
fs.mkdirSync(assets, { recursive: true });
const OPEN_ASSET = 'assets-open-3b9e';
const CLOSED_ASSET = 'assets-closed-8d2f';
fs.writeFileSync(path.join(assets, 'art.txt'), `${OPEN_ASSET}\n`);
fs.writeFileSync(path.join(assets, 'later.txt'), `${CLOSED_ASSET}\n`);
const xdg = Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(name => {
	const dir = path.join(temp, name.toLowerCase());
	fs.mkdirSync(dir);
	return [name, dir];
}));
// Output OpenCode saved for an agent of another window, and a link a command makes in OpenCode's temp folder,
// open to agents' commands and file tools, to the folder beside the open one.
const otherOutput = path.join(xdg.XDG_DATA_HOME, 'opencode', 'tool-output', 'tool_0ffd7fd12001SmokeOther0000');
const OTHER_OUTPUT = 'other-window-output-5c1e';
fs.mkdirSync(path.dirname(otherOutput), { recursive: true });
fs.writeFileSync(otherOutput, `${OTHER_OUTPUT}\n`);
const tmpLink = path.join(os.tmpdir(), 'opencode', `dragon-smoke-link-${process.pid}`);
// A plan another project's agent wrote in OpenCode's plan folder, in the home folder OpenCode is given below.
const plans = path.join(temp, '.opencode', 'plan');
const OTHER_PLAN = 'other-project-plan-9d2e';
fs.mkdirSync(plans, { recursive: true });
fs.writeFileSync(path.join(plans, 'roadmap.md'), `${OTHER_PLAN}\n`);
const workspaceFile = path.join(temp, 'modes.code-workspace');
fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: assets }] }, null, '\t'));

// Each turn's prompt names its script with a `[[mock:<name>]]` marker.
const edit = (newString: string): ScriptStep => ({ kind: 'tool', name: 'edit', args: { path: 'notes.txt', oldString: 'todo', newString } });
const shell = (command: string): ScriptStep => ({ kind: 'tool', name: 'shell', args: { command } });
// Node rather than `touch` or `>>`: OpenCode runs PowerShell on Windows, and the bytes must match on every platform.
const append = (file: string, line: string) => shell(`node -e "require('fs').appendFileSync('${file}', '${line}\\n')"`);
const createCommand = (file: string) => `node -e "require('fs').writeFileSync('${file}', '')"`;
const create = (file: string) => shell(createCommand(file));
const say = (text: string): ScriptStep => ({ kind: 'text', chunks: [text] });
const mock = await startMockOllama([say('No scenario.')], MODEL, 0, {
	scenarios: {
		agent: [append('shell.log', 'agent'), edit('todo: done'), say('Agent turn finished.')],
		deny: [create('denied.txt'), say('Deny turn went on.')],
		steer: [create('steered.txt'), say('Steered turn went on.')],
		// The model says what it is about to do, and calls the command a few seconds later.
		ask: [{ kind: 'tool', name: 'shell', args: { command: createCommand('asked.txt') }, text: ['Creating asked.txt now.'], pause: 4_000 }, say('Asked turn went on.')],
		pair: [{ kind: 'tools', calls: [{ name: 'shell', args: { command: createCommand('pair-a.txt') } }, { name: 'shell', args: { command: createCommand('pair-b.txt') } }] }, say('Pair turn went on.')],
		plan: [{ kind: 'tool', name: 'write', args: { path: 'plan.txt', content: 'plan\n' } }, edit('todo: planned'), say('The plan: read notes.txt, then mark it done.')],
		readonly: [create('readonly.txt'), edit('todo: read-only'), say('Read-only turn finished.')],
		full: [create('full.txt'), say('Full access turn finished.')],
		reach: [
			{ kind: 'tool', name: 'read', args: { path: path.join(outside, 'reach.txt') } },
			{ kind: 'tool', name: 'write', args: { path: path.join(outside, 'reached.txt'), content: 'reached\n' } },
			say('Reach turn finished.'),
		],
		outside: [
			{ kind: 'tool', name: 'read', args: { path: path.join(outside, 'secret.txt') } },
			{ kind: 'tool', name: 'write', args: { path: path.join(outside, 'planted.txt'), content: 'planted\n' } },
			{ kind: 'tool', name: 'grep', args: { pattern: 'agents', path: outside } },
			say('Outside turn finished.'),
		],
		shellOutside: [shell(`cat ${path.join(homeOutside, 'secret.txt')}`), shell(`echo planted > ${path.join(homeOutside, 'planted.txt')}`), shell('echo inside > inside.txt'), say('Shell outside turn finished.')],
		linked: [
			{ kind: 'tool', name: 'read', args: { path: path.join('beside', 'secret.txt') } },
			{ kind: 'tool', name: 'write', args: { path: path.join('beside', 'linked.txt'), content: 'planted\n' } },
			say('Linked turn finished.'),
		],
		assetsOpen: [
			{ kind: 'tool', name: 'read', args: { path: path.join(assets, 'art.txt') } },
			...(sandboxed ? [shell(`cat ${path.join(assets, 'art.txt')}`)] : []),
			say('Assets turn finished.'),
		],
		ownOutput: [
			// Forward slashes, which Node takes on Windows too, inside the command's quotes.
			shell(`node -e "require('fs').symlinkSync('${outside.replaceAll('\\', '/')}', '${tmpLink.replaceAll('\\', '/')}', 'junction')"`),
			// Longer than OpenCode shows, so it saves the whole and says where.
			shell(`node -e "for (let i = 1; i <= 2500; i++) console.log('line ' + i)"`),
			{ kind: 'tool', name: 'read', args: { path: '[[mock:saved]]' } },
			{ kind: 'tool', name: 'read', args: { path: otherOutput } },
			{ kind: 'tool', name: 'read', args: { path: path.join(tmpLink, 'secret.txt') } },
			say('Saved output turn finished.'),
		],
		plans: [
			{ kind: 'tool', name: 'write', args: { path: path.join(plans, 'levels.md'), content: 'levels\n' } },
			{ kind: 'tool', name: 'read', args: { path: path.join(plans, 'levels.md') } },
			{ kind: 'tool', name: 'read', args: { path: path.join(plans, 'roadmap.md') } },
			{ kind: 'tool', name: 'read', args: { path: plans } },
			say('Plans turn finished.'),
		],
		assetsClosed: [
			{ kind: 'tool', name: 'read', args: { path: path.join(assets, 'later.txt') } },
			{ kind: 'tool', name: 'write', args: { path: path.join(assets, 'planted.txt'), content: 'planted\n' } },
			...(sandboxed ? [shell(`cat ${path.join(assets, 'later.txt')}`)] : []),
			say('Closed folder turn finished.'),
		],
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

async function runCommand(win: Page, label: string): Promise<void> {
	await win.keyboard.press('F1');
	const input = win.locator('.quick-input-widget input.input');
	await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
	await input.fill(`>${label}`);
	await win.locator('.quick-input-widget .monaco-list-row').filter({ hasText: label }).first().click({ timeout: STEP_TIMEOUT });
}

/** How many times Dragon's log says the OpenCode server is ready. */
function serverStarts(): number {
	const logs = path.join(userData, 'logs');
	const files = fs.existsSync(logs) ? fs.readdirSync(logs, { recursive: true }).map(String).filter(file => file.endsWith(path.join('vscode.dragon-agent', 'OpenCode.log'))) : [];
	return files.reduce((count, file) => count + (fs.readFileSync(path.join(logs, file), 'utf8').match(/\[server\] ready at /g) ?? []).length, 0);
}

/** The workspace files a turn may have touched, as they are on disk. */
function disk(): Record<string, string | null> {
	const read = (name: string) => fs.existsSync(path.join(workspace, name)) ? fs.readFileSync(path.join(workspace, name), 'utf8') : null;
	return Object.fromEntries(['notes.txt', 'shell.log', 'denied.txt', 'pair-a.txt', 'pair-b.txt', 'steered.txt', 'asked.txt', 'plan.txt', 'readonly.txt', 'full.txt'].map(name => [name, read(name)]));
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
			workspaceFile,
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
	// `afterRestart` rides out the window right after the server restarts (switching Full Access, or a folder
	// leaving the window): OpenCode reloads the workspace's providers a moment after it reports ready, so a send
	// in that window finds no model and errors ("Language model unavailable") without reaching OpenCode. A person
	// waits and sends again; so does this, as the e2e's reopen() waits for the model to return before it sends.
	const send = async (text: string, afterRestart = false): Promise<{ response: Locator; from: number }> => {
		for (let attempt = 0; ; attempt++) {
			const from = mock.requests.length;
			await win.click(INPUT);
			await win.keyboard.insertText(text);
			await win.keyboard.press('Enter');
			await win.waitForFunction(request => {
				const items = [...document.querySelectorAll('.interactive-item-container')];
				const index = items.findLastIndex(item => item.classList.contains('interactive-request') && item.textContent?.includes(request));
				return index >= 0 && items.slice(index + 1).some(item => item.classList.contains('interactive-response'));
			}, text, { timeout: STEP_TIMEOUT });
			const response = responses.last();
			if (!afterRestart || attempt >= 10) {
				return { response, from };
			}
			// A model that is still re-registering errors at once with this notification; a reachable one streams
			// its turn instead, so the absence of the notification within a moment means the model is back.
			const unavailable = await response.locator('.chat-notification-widget', { hasText: 'unavailable' }).waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false);
			if (!unavailable) {
				return { response, from };
			}
			await new Promise(resolve => setTimeout(resolve, 1_000));
		}
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
	const setPermission = async (mode: 'readonly' | 'ask' | 'project' | 'full') => {
		for (let i = 0; i < 4 && !(await permission.getAttribute('class'))?.includes(`dragon-permission-${mode}`); i++) {
			const before = await permission.getAttribute('class');
			await permission.click();
			await win.waitForFunction(([selector, previous]) => document.querySelector(selector!)?.getAttribute('class') !== previous, ['.interactive-input-part .dragon-permission-toggle', before], { timeout: STEP_TIMEOUT });
		}
		if (!(await permission.getAttribute('class'))?.includes(`dragon-permission-${mode}`)) {
			throw new Error(`the permission chip did not reach ${mode}: ${await permission.getAttribute('class')}`);
		}
	};
	// Only Full Access reaches the whole disk; crossing into or out of it restarts the server, which reads
	// the confinement at start. Switches between the confined modes leave the environment the same.
	let fullAccessNow = false;
	const switchPermission = async (mode: 'readonly' | 'ask' | 'project' | 'full') => {
		const crosses = (mode === 'full') !== fullAccessNow;
		const starts = serverStarts();
		await setPermission(mode);
		fullAccessNow = mode === 'full';
		if (crosses) {
			const deadline = Date.now() + 30_000;
			while (serverStarts() <= starts && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 250));
			}
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

	await step(win, 'a message typed while an approval prompt is open stops the work, and the message runs instead', async () => {
		const first = '[[mock:steer]] Create steered.txt.';
		const second = 'Then say the work went on.';
		const turn = await send(first);
		await win.locator(PENDING).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		// The workbench takes a message sent while the turn waits for an answer as choosing another path:
		// it cancels the turn rather than steering it, and the prompt is skipped.
		await win.click(INPUT);
		await win.keyboard.insertText(second);
		await win.keyboard.press('Enter');
		/** The text of the reply to the last request holding `request`, once it is finished. */
		const reply = (request: string) => win.evaluate(request => {
			const items = [...document.querySelectorAll<HTMLElement>('.interactive-item-container')];
			const index = items.findLastIndex(item => item.classList.contains('interactive-request') && item.textContent?.includes(request));
			const found = index < 0 ? undefined : items.slice(index + 1).find(item => item.classList.contains('interactive-response'));
			return !found || found.classList.contains('chat-response-loading') ? undefined : found.innerText.replace(/\s+/g, ' ');
		}, request);
		for (const end = Date.now() + STEP_TIMEOUT; !(await reply(second))?.includes('Steered turn went on.');) {
			if (Date.now() > end) {
				throw new Error(`the typed message never got its reply: ${JSON.stringify(await reply(second))}`);
			}
			await win.waitForTimeout(200);
		}
		expectDisk({ 'steered.txt': null });
		const stopped = await reply(first) ?? '';
		// The command's card is cancelled with the turn: it cannot hear from the extension again.
		const card = (await turn.response.page().locator('.dragon-tool-card', { hasText: 'steered.txt' }).last().innerText().catch(() => '')).replace(/\s+/g, ' ');
		const seen = { open: await win.locator(PENDING).count(), skipped: stopped.includes('Skipped question'), allowed: stopped.includes('Allow once'), card: card.includes(' cancelled ') && !card.includes('running…'), sent: sentSince(turn.from).text.includes(second) };
		if (JSON.stringify(seen) !== JSON.stringify({ open: 0, skipped: true, allowed: false, card: true, sent: true })) {
			throw new Error(`the turns read ${JSON.stringify(seen)}: expected the prompt skipped, the command's card cancelled rather than left running, and the message sent to the model; the card reads ${JSON.stringify(card)}, the first reply ${JSON.stringify(stopped.slice(0, 600))}`);
		}
		await shot(win, 'message-instead-of-approval');
	});

	await step(win, 'a message typed while the model writes, just before it asks to run a command, waits for the prompt the user answers', async () => {
		const first = '[[mock:ask]] Create asked.txt.';
		const second = 'Then say the command ran.';
		const turn = await send(first);
		await turn.response.getByText('Creating asked.txt now.').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		// Enter in a busy chat steers it: the turn is asked to give way while the model still writes,
		// and the approval prompt opens as its text ends.
		await win.click(INPUT);
		await win.keyboard.insertText(second);
		await win.keyboard.press('Enter');
		await win.locator(PENDING).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		// Giving way, the turn closed the prompt within a quarter second, the command denied unasked.
		await win.waitForTimeout(1_000);
		if (!await win.locator(PENDING).count()) {
			throw new Error('the approval prompt closed unanswered once the typed message waited');
		}
		await answer('asked.txt', 'Allow once');
		for (const end = Date.now() + STEP_TIMEOUT; !(await responses.last().innerText()).includes('Asked turn went on.') || await win.locator('.interactive-item-container.interactive-response.chat-response-loading').count();) {
			if (Date.now() > end) {
				throw new Error(`the typed message never got its reply: ${JSON.stringify((await responses.last().innerText()).replace(/\s+/g, ' ').slice(-600))}`);
			}
			await win.waitForTimeout(200);
		}
		expectDisk({ 'asked.txt': '' });
		// The command folds into the turn's steps once it ends, and folded steps render when opened.
		// `turn.response` is the last response, now the typed message's: the turn with the command is the one with steps.
		const steps = /^(Finished with|Completed) \d+ steps?/;
		const asked = responses.filter({ hasText: 'Asked turn went on.' }).filter({ has: win.getByText(steps) }).last();
		await asked.getByText(steps).first().click({ timeout: STEP_TIMEOUT });
		// The command shows as a terminal block, titled "Ran" even when denied: asked.txt on disk shows it ran.
		await asked.getByText(/\bRan\b.*asked\.txt/).first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the turn's steps do not show the command: ${JSON.stringify((await asked.innerText()).replace(/\s+/g, ' '))}`, { cause: err });
		});
		// The opened steps draw the approval's answer a moment later.
		let text = '';
		for (const end = Date.now() + 5_000; !/\bA: /.test(text) && Date.now() < end; await win.waitForTimeout(100)) {
			text = (await asked.innerText()).replace(/\s+/g, ' ');
		}
		// Opened steps scroll the chat away from its end, and the virtual list would not draw the next turn.
		await asked.getByText(steps).first().click({ timeout: STEP_TIMEOUT });
		const seen = { open: await win.locator(PENDING).count(), allowed: text.includes('Allow once'), skipped: text.includes('Skipped'), sent: sentSince(turn.from).text.includes(second) };
		if (JSON.stringify(seen) !== JSON.stringify({ open: 0, allowed: true, skipped: false, sent: true })) {
			throw new Error(`the turns read ${JSON.stringify(seen)}: expected the prompt answered Allow once, and the typed message sent to the model; the turn reads ${JSON.stringify(text.slice(0, 600))}`);
		}
		await shot(win, 'message-while-writing-waits-for-approval');
	});

	await step(win, 'two approval prompts are open at once, and denying one closes the other, which OpenCode denied too', async () => {
		const turn = await send('[[mock:pair]] Create pair-a.txt and pair-b.txt.');
		// Neither prompt holds up the other: both are open before either is answered.
		await win.waitForFunction(selector => document.querySelectorAll(selector).length === 2, PENDING, { timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`${await win.locator(PENDING).count()} approval prompt(s) open, not 2 at once`, { cause: err });
		});
		await shot(win, 'two-approvals-open');
		await win.locator(PENDING).filter({ hasText: 'pair-a.txt' }).locator('.chat-question-list-item', { hasText: 'Deny' }).first().click();
		// A denial rejects the session's other requests in OpenCode, so the other prompt closes by itself.
		await win.waitForFunction(selector => !document.querySelector(selector), PENDING, { timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the other approval prompt is still open: ${JSON.stringify((await win.locator(PENDING).first().innerText().catch(() => '')).replace(/\s+/g, ' '))}`, { cause: err });
		});
		await win.waitForFunction(() => !document.querySelector('.interactive-item-container.interactive-response.chat-response-loading'), undefined, { timeout: STEP_TIMEOUT });
		expectDisk({ 'pair-a.txt': null, 'pair-b.txt': null });
		// The two commands fold into the turn's steps once it ends, and folded steps render when opened.
		await turn.response.getByText(/^(Finished with|Completed) \d+ steps?/).first().click({ timeout: STEP_TIMEOUT });
		await turn.response.locator('.dragon-tool-card').nth(1).waitFor({ state: 'attached', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the turn's steps do not show both commands: ${JSON.stringify((await turn.response.innerText()).replace(/\s+/g, ' '))}`, { cause: err });
		});
		const prompts = turn.response.locator('.chat-question-carousel-container');
		const answeredElsewhere = turn.response.locator('.chat-question-summary-answered');
		const skipped = turn.response.locator('.dragon-tool-card-error', { hasText: 'Skipped running' });
		const seen = { prompts: await prompts.count(), answeredElsewhere: await answeredElsewhere.count(), skipped: await skipped.count(), ran: await turn.response.getByText(/\bRan\b/).count(), wentOn: await turn.response.getByText('Pair turn went on.').count() };
		if (JSON.stringify(seen) !== JSON.stringify({ prompts: 2, answeredElsewhere: 1, skipped: 2, ran: 0, wentOn: 0 })) {
			throw new Error(`the turn shows ${JSON.stringify(seen)}: expected both prompts, one answered elsewhere, both commands skipped as denied, none run, and the turn stopped`);
		}
		await shot(win, 'two-approvals-settled');
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
		await switchPermission('full');
		const turn = await send('[[mock:full]] Create full.txt.', true);
		await finished(turn.response, 'Full access turn finished.');
		await expectNotAsked(turn);
		expectDisk({ 'full.txt': '', 'notes.txt': 'todo: done\n' });
		await shot(win, 'full-access');
	});

	await step(win, 'Full Access reaches the folder beside the open one', async () => {
		const turn = await send('[[mock:reach]] Read the notes kept beside the project.');
		await finished(turn.response, 'Reach turn finished.');
		await expectNotAsked(turn);
		const sent = JSON.stringify(mock.requests.slice(turn.from));
		const refused = (sent.match(/Permission denied: external_directory|is outside the workspace/g) ?? []).length;
		const reached = fs.existsSync(path.join(outside, 'reached.txt'));
		// Full Access is the one mode that reaches the whole disk: the file is read, sent and written.
		if (!sent.includes(REACHED) || !reached || refused > 0) {
			throw new Error(`Full Access did not reach the folder beside the open one: file sent ${sent.includes(REACHED)}, reached.txt ${reached}, refusals ${refused}`);
		}
		await shot(win, 'full-access-reaches');
	});

	await step(win, 'Project Only keeps agents to the open folder', async () => {
		await switchPermission('project');
		const turn = await send('[[mock:outside]] Read the notes kept beside the project.', true);
		await finished(turn.response, 'Outside turn finished.');
		await expectNotAsked(turn);
		const sent = JSON.stringify(mock.requests.slice(turn.from));
		const refused = (sent.match(/Permission denied: external_directory|is outside the workspace/g) ?? []).length;
		if (sent.includes(SECRET) || fs.existsSync(path.join(outside, 'planted.txt')) || refused < 3) {
			throw new Error(`the agent reached the folder beside the open one: secret sent ${sent.includes(SECRET)}, planted.txt ${fs.existsSync(path.join(outside, 'planted.txt'))}, refusals ${refused} of 3`);
		}
		await shot(win, 'project-only-outside');
	});

	if (sandboxed) {
		await step(win, 'Project Only shell commands stay in the open folder', async () => {
			const turn = await send('[[mock:shellOutside]] Read the notes in my home folder.');
			await finished(turn.response, 'Shell outside turn finished.');
			await expectNotAsked(turn);
			const sent = JSON.stringify(mock.requests.slice(turn.from));
			const refused = (sent.match(/Operation not permitted|operation not permitted/g) ?? []).length;
			const planted = fs.existsSync(path.join(homeOutside, 'planted.txt'));
			const inside = fs.existsSync(path.join(workspace, 'inside.txt')) ? fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8') : null;
			if (sent.includes(HOME_SECRET) || planted || refused < 2 || inside !== 'inside\n') {
				throw new Error(`a shell command reached the home folder or the project was closed to it: secret sent ${sent.includes(HOME_SECRET)}, planted.txt ${planted}, refusals ${refused} of 2, inside.txt ${JSON.stringify(inside)}`);
			}
			await shot(win, 'full-access-shell-outside');
		});
	}

	await step(win, 'Project Only does not follow a link out of the open folder', async () => {
		// A link a command or a cloned repository could have made; a junction on Windows, which needs no privilege.
		fs.symlinkSync(outside, path.join(workspace, 'beside'), 'junction');
		try {
			const turn = await send('[[mock:linked]] Read the notes linked into the project.');
			await finished(turn.response, 'Linked turn finished.');
			await expectNotAsked(turn);
			const sent = JSON.stringify(mock.requests.slice(turn.from));
			const refused = (sent.match(/leads outside the folders open in the window through a symbolic link/g) ?? []).length;
			const planted = fs.existsSync(path.join(outside, 'linked.txt'));
			if (sent.includes(SECRET) || planted || refused < 2) {
				throw new Error(`an agent followed the link out of the open folder: secret sent ${sent.includes(SECRET)}, linked.txt ${planted}, refusals ${refused} of 2`);
			}
			await shot(win, 'full-access-linked');
		} finally {
			fs.rmSync(path.join(workspace, 'beside'), { force: true });
		}
	});

	await step(win, 'a folder taken out of the window is closed to agents at once: reading, writing and shell commands there are refused, and nothing from it reaches the model', async () => {
		const open = await send('[[mock:assetsOpen]] Read the art in the assets folder.');
		await finished(open.response, 'Assets turn finished.');
		const reads = (JSON.stringify(mock.requests.slice(open.from)).match(new RegExp(OPEN_ASSET, 'g')) ?? []).length;
		if (reads < (sandboxed ? 2 : 1)) {
			throw new Error(`the agent could not reach the assets folder while it was open: ${reads} of ${sandboxed ? 2 : 1} reads reached the model`);
		}
		const starts = serverStarts();
		await runCommand(win, 'Remove Folder from Workspace');
		await win.locator('.quick-input-widget .monaco-list-row').filter({ hasText: path.basename(assets) }).first().click({ timeout: STEP_TIMEOUT });
		// Dragon restarts its server for the window's new folders. A build that does not is still tested, after a wait.
		const deadline = Date.now() + 20_000;
		while (serverStarts() <= starts && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const restarted = serverStarts() > starts;
		const closed = await send('[[mock:assetsClosed]] Read the rest of the assets.', true);
		await finished(closed.response, 'Closed folder turn finished.');
		await expectNotAsked(closed);
		const sent = JSON.stringify(mock.requests.slice(closed.from));
		// The refusals in this turn's tool results, not the earlier turns' the model is sent again.
		const last = mock.requests.slice(closed.from).filter(r => r.path.startsWith('/v1/chat/completions')).at(-1)?.body as { messages?: { role: string }[] } | undefined;
		const messages = last?.messages ?? [];
		const turn = JSON.stringify(messages.slice(messages.findLastIndex(message => message.role === 'user')));
		const refused = (turn.match(/Permission denied: external_directory|is outside the workspace|Operation not permitted|operation not permitted/g) ?? []).length;
		const planted = fs.existsSync(path.join(assets, 'planted.txt'));
		if (sent.includes(CLOSED_ASSET) || planted || refused < (sandboxed ? 3 : 2)) {
			throw new Error(`the agent reached the folder taken out of the window: its file sent ${sent.includes(CLOSED_ASSET)}, planted.txt ${planted}, refusals ${refused} of ${sandboxed ? 3 : 2}, server restarted ${restarted}`);
		}
		await shot(win, 'folder-taken-out');
	});

	await step(win, 'Project Only keeps agents to their own saved output: another window\'s, and a link a command made in OpenCode\'s temp folder, are refused, and nothing from them reaches the model', async () => {
		const turn = await send('[[mock:ownOutput]] Count the lines, then read the other notes.');
		await finished(turn.response, 'Saved output turn finished.');
		await expectNotAsked(turn);
		const sent = JSON.stringify(mock.requests.slice(turn.from));
		// This turn's tool results, not the earlier turns' the model is sent again.
		const last = mock.requests.slice(turn.from).filter(r => r.path.startsWith('/v1/chat/completions')).at(-1)?.body as { messages?: { role: string }[] } | undefined;
		const messages = last?.messages ?? [];
		const results = JSON.stringify(messages.slice(messages.findLastIndex(message => message.role === 'user')));
		const refused = (results.match(/is not output OpenCode saved for this window|leads outside the folders open in the window through a symbolic link/g) ?? []).length;
		// The first line shows only when the agent read the whole output back: OpenCode shows the last lines.
		const readOwn = results.includes('1: line 1\\n');
		const linked = fs.lstatSync(tmpLink, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
		if (sent.includes(SECRET) || sent.includes(OTHER_OUTPUT) || refused < 2 || !readOwn || !linked) {
			throw new Error(`an agent reached output or files not its own, or could not read its own: secret sent ${sent.includes(SECRET)}, other window's output sent ${sent.includes(OTHER_OUTPUT)}, refusals ${refused} of 2, own output read ${readOwn}, link made ${linked}`);
		}
		await shot(win, 'saved-output');
	});

	await step(win, 'Project Only keeps agents to the plans written in the window: another project\'s plan, and the folder every project keeps its plans in, are refused, and nothing from them reaches the model', async () => {
		const turn = await send('[[mock:plans]] Write the plan for the levels, then read the other plans.');
		await finished(turn.response, 'Plans turn finished.');
		await expectNotAsked(turn);
		const sent = JSON.stringify(mock.requests.slice(turn.from));
		const last = mock.requests.slice(turn.from).filter(r => r.path.startsWith('/v1/chat/completions')).at(-1)?.body as { messages?: { role: string }[] } | undefined;
		const messages = last?.messages ?? [];
		const results = JSON.stringify(messages.slice(messages.findLastIndex(message => message.role === 'user')));
		const refused = (results.match(/is a plan not written from the folders open in the window|is a folder of plans, which every project shares/g) ?? []).length;
		const readOwn = results.includes('1: levels');
		// Dragon's record of the plan, kept in the home folder OpenCode is given.
		const recorded = path.join(temp, '.dragon', 'sandbox', 'plans');
		const records = fs.existsSync(recorded) ? fs.readdirSync(recorded).filter(name => name.endsWith('.json')).length : 0;
		if (sent.includes(OTHER_PLAN) || refused < 2 || !readOwn || records !== 1) {
			throw new Error(`an agent reached another project's plan, or could not read its own: its plan sent ${sent.includes(OTHER_PLAN)}, refusals ${refused} of 2, own plan read ${readOwn}, plans recorded ${records}`);
		}
		await shot(win, 'plans');
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
	fs.rmSync(tmpLink, { force: true });
	if (sandboxed) {
		fs.rmSync(homeOutside, { recursive: true, force: true });
		fs.rmSync(assets, { recursive: true, force: true });
		// The commands' home folder for this run's workspace, `work-<id>`, and its profile, `<id>.sb`.
		for (const name of sandboxHomes().filter(name => name.startsWith(`${path.basename(workspace)}-`) && !sandboxBefore.has(name))) {
			fs.rmSync(path.join(sandboxFolder, 'homes', name), { recursive: true, force: true });
			fs.rmSync(path.join(sandboxFolder, 'profiles', `${name.slice(name.lastIndexOf('-') + 1)}.sb`), { force: true });
		}
	}
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
