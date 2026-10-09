/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Chat turn smoke test for the desktop app. Launches Dragon IDE on a fresh profile with a scripted
// model and checks, in the UI as a person would use it:
//   1. The instruction files VS Code attaches to every message reach the model once: CLAUDE.md with
//      the first message only, named by its path, and AGENTS.md only as OpenCode loads it itself;
//      none from outside the open folder reaches it, nor a skill from there: the user's
//      ~/.claude/CLAUDE.md (when they have one), OpenCode's global AGENTS.md and skills, and an
//      AGENTS.md in the folder above
//   2. A message typed while the agent runs a command joins that work: the command finishes, the
//      first reply says the work continues, and the answer to both comes in the second
//   3. /compact shows the summary as it is written and how much it saved; typed while a command
//      runs, it lets the command finish, compacts, and its reply says so although the agent works on
//   4. A new agent starts on the model last picked, and a message from another agent runs on the
//      model its chat's picker shows, also after the picker changes; the side bar's chat messages it
//      without the user turning its messages on
//   5. Code the execute tool cannot parse (Python, as a model wrote in a game demo) comes back to
//      the model saying the tool runs only JavaScript and what to use instead
//   6. The user opens two more agents with the plus in the side bar chat's title, three in all, and
//      tells that chat it leads them: it messages each in one reply, each runs the message in its
//      own tab, and every answer reaches it, once, and shows in its chat, with its reply to the
//      answer, and agent-2's, in the very words its model thought first, with a note that it may be
//      no answer; again with its reply slow, so the answers come while its turn shows it, and show
//      after its text, one of them wrapped as a message, which reaches the lead, and shows in its
//      tab, in its own words; and a third time with the user asking it how they are doing while it
//      writes and the answers come: its text shows whole, before the turn gives way to the
//      question, and each answer once; and a fourth time with the lead waiting for agent-3 with
//      wait_agent when the user asks: the wait ends in the step that reads the question, it
//      answers before agent-3 is done, and agent-3's answer reaches it after, as a message; the
//      answers that came before it waited, which that step folds away, show again where its turn
//      gives way
//   7. The side bar's chat, asked to message and run the chats the user opened, does: one the user
//      typed in and one they left empty each run its message in its own chat, and the empty one's tab
//      shows the name it was messaged by; the side bar's chat is "main" to them; once they are
//      closed, it is no longer told about them
//   8. The chat's Lead a Team button (in its Views and More Actions menu, with New Agent left in
//      its title) puts /team in its input, which makes the chat the lead of teammates in panes
//      beside it: the lead's model is told who is on the team, and a teammate it sends work to
//      runs on the lead's model, which its picker shows although another model was picked last;
//      its answer comes back to the lead on its own
//   9. /create-agent artist <what it does> adds a teammate named artist in a pane of its own, and it
//      and the lead are told its part with every request; the artist is not offered OpenCode's
//      question tool, so it asks its lead and does not wait on the user
//  10. Under Read-Only a message typed in the artist's pane runs it with the Read-Only rules, and it
//      still is not offered the question tool: switching the mode keeps a teammate's own rule
//  11. New Agent in the lead's title adds a teammate to its team in a pane of its own, as /team
//      starts them: the lead is told about it, and it runs on the lead's model and asks its lead
//  12. /autocompact 10% makes the context readout say where the conversation compacts, and the next
//      message past it is compacted first; /autocompact off turns that off
//  13. A long command shows while it runs how long it has run of its timeout and the last line it
//      printed, so it does not look stalled, and reads as run once it ends
//  14. A turn the model provider refused for its usage limit, as the free Nemotron refuses after
//      hours of use, shows the error once, in the error box, with what the user can do about it
//  15. Open OpenCode TUI opens OpenCode's terminal UI on the window's server, and it draws its prompt
//  16. (macOS) A terminal UI that cannot start says why: with OpenCode signed as Dragon IDE 1.1.5
//      signed it, which may not load the library its terminal UI unpacks, Dragon shows the reason
//      OpenCode logged instead of a terminal that closes
// Every step checks what the model was sent, not only the chat.
//
// Usage: node scripts/dragon/smoke-turns.mts [--app <packaged app dir>] [--out <dir>]
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
		throw new Error(`Unknown argument: ${process.argv[i]}. Usage: smoke-turns.mts [--app <dir>] [--out <dir>]`);
	}
	args[match[1]] = process.argv[++i];
}
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-turns-smoke-')));
fs.mkdirSync(out, { recursive: true });
const MODEL = 'acme-large';
const SMALL = 'acme-small';
const STEP_TIMEOUT = 90_000;
/** A chat's requests and replies, in the list's rows, not the request that sticks to its top. */
const ROW = '.monaco-list-rows .interactive-item-container';
const REQUEST = `${ROW}.interactive-request`;

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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-turns-run-'));
const workspace = path.join(temp, 'work');
const userData = path.join(temp, 'user-data');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
// Instruction files VS Code attaches to every message, each with a marker to count in what the model is sent.
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agents\n\nAGENTS-MD-MARKER: keep replies short.\n');
fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Claude\n\nCLAUDE-MD-MARKER: keep replies short.\n');
// Instruction files and a skill outside the open folder, none of which may reach the model: one in
// the folder above the open one, and the user's skill in OpenCode's home folder (`temp`, the
// OPENCODE_TEST_HOME below). OpenCode's global AGENTS.md is written with its config folder.
fs.writeFileSync(path.join(temp, 'AGENTS.md'), 'ABOVE-THE-FOLDER-MARKER: answer in German.\n');
fs.mkdirSync(path.join(temp, '.claude', 'skills', 'home-skill'), { recursive: true });
fs.writeFileSync(path.join(temp, '.claude', 'skills', 'home-skill', 'SKILL.md'), '---\nname: home-skill\ndescription: HOME-SKILL-MARKER, for every task.\n---\n\nHOME-SKILL-BODY\n');
const outsideMarkers = ['ABOVE-THE-FOLDER-MARKER', 'OPENCODE-GLOBAL-MARKER', 'HOME-SKILL-MARKER'];
/** The longest line of the user's own ~/.claude/CLAUDE.md, which VS Code attaches to every message, as a request's JSON holds it. */
const userClaudeMd = (() => {
	try {
		const longest = fs.readFileSync(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'utf8').split('\n').reduce((a, b) => b.length > a.length ? b : a, '');
		return longest.trim().length >= 20 ? JSON.stringify(longest).slice(1, -1) : undefined;
	} catch {
		return undefined;
	}
})();

// Each turn's prompt names its script with a `[[mock:<name>]]` marker.
const say = (text: string): ScriptStep => ({ kind: 'text', chunks: [text] });
const SUMMARY = ['## Objective\n', 'Say hello, wait, and say hi.\n\n', '## Next Move\n', 'Wait for the user.\n'];
const mock = await startMockOllama([say('No scenario.')], MODEL, 0, {
	// Reported for every completion, so the compaction has sizes to show. 30K is 15% of the window.
	usage: { prompt: 30_000, completion: 400, cached: 2_000 },
	summary: SUMMARY,
	scenarios: {
		hello: [say('Hello.')],
		// A command long enough to type a message while it runs. It writes a file when it ends, so a
		// command that was stopped shows.
		slow: [{ kind: 'tool', name: 'shell', args: { command: `node -e "setTimeout(() => { require('fs').writeFileSync('slow.txt', 'done'); console.log('slow done'); }, 5000)"` } }, say('Done, and hi.')],
		ping: [{ kind: 'tool', name: 'send_message', args: { to: 'agent-1', message: '[[mock:pong]] Reply when you can.' } }, say('Pinged.')],
		pong: [say('Pong.')],
		again: [{ kind: 'tool', name: 'send_message', args: { to: 'agent-1', message: '[[mock:pong2]] And once more.' } }, say('Pinged again.')],
		pong2: [say('Pong again.')],
		// The side bar's chat told it leads the three agents the user opened: it messages each in one reply.
		lead: [
			{
				kind: 'tools', calls: [
					{ name: 'send_message', args: { to: 'agent-1', message: '[[mock:hero]] Name the hero.' } },
					{ name: 'send_message', args: { to: 'agent-2', message: '[[mock:villain]] Name the villain.' } },
					{ name: 'send_message', args: { to: 'agent-3', message: '[[mock:level]] Name the first level.' } },
				],
			},
			say('All three are on it.'),
		],
		// Each answer, which reaches the lead on its own, names the scenario the lead runs on it.
		hero: [say('Hero: Ignis. [[mock:heard]]')],
		// agent-2 answers in the very words it thought, as Nemotron's agents did in 8 of 37 team-demo runs.
		villain: [{ kind: 'text', chunks: ['Villain: Morgath. [[mock:heard]]'], reasoning: ['Villain: Morgath. [[mock:heard]]'] }],
		level: [say('First level: Ember Caves. [[mock:heard]]')],
		// Again, with the lead's reply slow, so the answers come while its turn shows it.
		'lead-slow': [
			{
				kind: 'tools', calls: [
					{ name: 'send_message', args: { to: 'agent-1', message: '[[mock:sidekick]] Name the sidekick.' } },
					{ name: 'send_message', args: { to: 'agent-2', message: '[[mock:boss]] Name the boss.' } },
					{ name: 'send_message', args: { to: 'agent-3', message: '[[mock:level2]] Name the second level.' } },
				],
			},
			{ kind: 'text', chunks: ['On it', ' again.'], pause: 4_000 },
		],
		sidekick: [{ kind: 'text', chunks: ['Sidekick:', ' Ash. [[mock:heard]]'], pause: 1_000 }],
		boss: [{ kind: 'text', chunks: ['Boss:', ' Cinder King. [[mock:heard]]'], pause: 1_000 }],
		// Wrapped as the messages it reads, as Nemotron answered in 2 of 32 team-demo runs.
		level2: [{ kind: 'text', chunks: ['<agent-message from="agent-3">Second level:', ' Frost Peaks. [[mock:heard]]</agent-message>'], pause: 1_000 }],
		// A third time the user asks how they are doing while the answers come.
		'lead-asks': [
			{
				kind: 'tools', calls: [
					{ name: 'send_message', args: { to: 'agent-1', message: '[[mock:power]] Name a power-up.' } },
					{ name: 'send_message', args: { to: 'agent-2', message: '[[mock:enemy]] Name an enemy.' } },
					{ name: 'send_message', args: { to: 'agent-3', message: '[[mock:level3]] Name the third level.' } },
				],
			},
			{ kind: 'text', chunks: ['Asked', ' them.'], pause: 2_000 },
		],
		power: [{ kind: 'text', chunks: ['Power-up:', ' Fire Shield. [[mock:heard]]'], pause: 3_000 }],
		enemy: [{ kind: 'text', chunks: ['Enemy:', ' Ash Imp. [[mock:heard]]'], pause: 3_000 }],
		level3: [{ kind: 'text', chunks: ['Third level:', ' Lava Lake. [[mock:heard]]'], pause: 3_000 }],
		status: [{ kind: 'text', chunks: ['Still', ' working.'], pause: 4_000 }],
		// A fourth time the lead waits for the slowest agent, and the user asks how they are doing meanwhile.
		'lead-waits': [
			{
				kind: 'tools', calls: [
					{ name: 'send_message', args: { to: 'agent-1', message: '[[mock:shield]] Name a shield.' } },
					{ name: 'send_message', args: { to: 'agent-2', message: '[[mock:minion]] Name a minion.' } },
					{ name: 'send_message', args: { to: 'agent-3', message: '[[mock:level4]] Name the last level.' } },
				],
			},
			// It thinks before it waits: agent-1's and agent-2's answers come first, and the step folds them away.
			{ kind: 'tool', name: 'wait_agent', args: { agent: 'agent-3', timeoutSeconds: 300 }, pause: 3_000 },
			say('All done.'),
		],
		// They answer while the lead thinks, not before it asks the model again: answers already in its
		// inbox would join that request, and it would read them instead of waiting.
		shield: [{ kind: 'text', chunks: ['Shield:', ' Dragon Scale. [[mock:heard]]'], pause: 1_000 }],
		minion: [{ kind: 'text', chunks: ['Minion:', ' Ember Bat. [[mock:heard]]'], pause: 1_000 }],
		level4: [{ kind: 'text', chunks: ['Last level:', ' Obsidian Keep. [[mock:heard]]'], pause: 20_000 }],
		'status-wait': [say('Not yet.')],
		heard: [say('Noted.')],
		delegate: [{ kind: 'tool', name: 'send_message', args: { to: 'teammate-1', message: '[[mock:work]] Make the title screen.' } }, say('Handed out.')],
		work: [say('Title screen made.')],
		cast: [{ kind: 'tool', name: 'send_message', args: { to: 'artist', message: '[[mock:art]] Draw the hero.' } }, say('Asked the artist.')],
		art: [say('Hero drawn.')],
		recruit: [{ kind: 'tool', name: 'send_message', args: { to: 'teammate-3', message: '[[mock:sounds]] Make the sound effects.' } }, say('Recruited.')],
		sounds: [say('Sounds made.')],
		// The side bar's chat runs the chats the user opened: one they typed "scout" in, and an empty one.
		rally: [
			{ kind: 'tool', name: 'send_message', args: { to: 'mock-hello-scout', message: '[[mock:report]] Report in.' } },
			{ kind: 'tool', name: 'send_message', args: { to: 'agent-4', message: '[[mock:report]] Report in.' } },
			say('Both are on it.'),
		],
		report: [say('Reporting in.')],
		python: [{ kind: 'tool', name: 'execute', args: { code: 'import json\nimport os\nprint(json.dumps({"ok": True}))' } }, say('Understood: JavaScript only.')],
		// A build that prints a line and then works a while, as a game export does.
		build: [{ kind: 'tool', name: 'shell', args: { command: `node -e "console.log('Exporting the game'); setTimeout(() => console.log('Exported game.pck'), 6000)"`, timeout: 300_000 } }, say('Built.')],
		// What the free Nemotron answered after hours of use, which OpenCode does not retry.
		limited: [{ kind: 'fail', status: 429, message: 'Rate limit exceeded. Please try again later.', code: 'FreeUsageLimitError' }],
	},
});
const model = (name: string) => ({ name, limit: { context: 200_000, output: 8192 }, capabilities: { tools: true, input: ['text'], output: ['text'] } });
fs.writeFileSync(path.join(workspace, 'opencode.json'), JSON.stringify({
	$schema: 'https://opencode.ai/config.json',
	enabled_providers: ['acme'],
	providers: {
		acme: {
			name: 'Acme', package: '@opencode/ai/providers/openai-compatible',
			settings: { baseURL: `${mock.origin}/v1`, apiKey: 'test' },
			models: { [MODEL]: model('Acme Large'), [SMALL]: model('Acme Small') },
		},
	},
}, null, '\t'));
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'window.dialogStyle': 'custom',
	'window.menuStyle': 'custom', // native menus cannot be driven from the page either
	'security.workspace.trust.enabled': false,
	'workbench.startupEditor': 'none',
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
	// The terminal draws its text in the page, where the test reads it.
	'terminal.integrated.gpuAcceleration': 'off',
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
fs.mkdirSync(path.join(xdg.XDG_CONFIG_HOME, 'opencode'));
fs.writeFileSync(path.join(xdg.XDG_CONFIG_HOME, 'opencode', 'AGENTS.md'), 'OPENCODE-GLOBAL-MARKER: answer in Dutch.\n');

async function runCommand(win: Page, label: string): Promise<void> {
	await win.keyboard.press('F1');
	const input = win.locator('.quick-input-widget input.input');
	await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
	await input.fill(`>${label}`);
	await win.locator('.quick-input-widget .monaco-list-row').filter({ hasText: label }).first().click({ timeout: STEP_TIMEOUT });
}

/** The chat completions the model was asked for with tools (turns, not titles or summaries), as sent. */
const turns = () => mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && (r.body as { tools?: unknown[] } | undefined)?.tools?.length)
	.map(r => ({ model: (r.body as { model?: string }).model, tools: ((r.body as { tools: { function?: { name?: string } }[] }).tools).map(tool => tool.function?.name), text: JSON.stringify(r.body) }));

/** How often `text` occurs in `within`. */
const count = (within: string, text: string) => within.split(text).length - 1;

/** Waits until `check` returns true, or fails with what `describe` says. */
async function until(check: () => boolean | Promise<boolean>, describe: () => string | Promise<string>): Promise<void> {
	for (const end = Date.now() + STEP_TIMEOUT; !await check();) {
		if (Date.now() > end) {
			throw new Error(await describe());
		}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

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
	// The chat in the side bar, and the chat editor an agent opens in.
	const main = win.locator('.part.auxiliarybar, .part.panel, .part.sidebar').filter({ has: win.locator(INPUT) }).first();
	const editor = win.locator('.editor-group-container').filter({ has: win.locator(INPUT) }).first();
	const picker = (scope: Locator) => scope.locator('.interactive-input-part .chat-input-toolbars');

	/** Types a message into a chat and sends it, once it shows in the chat. */
	const send = async (scope: Locator, text: string) => {
		await scope.locator(INPUT).click();
		await win.keyboard.insertText(text);
		await win.keyboard.press('Enter');
		await scope.locator(REQUEST, { hasText: text }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
	};
	/** The text of the reply to the last request holding `request`. */
	const reply = (scope: Locator, request: string) => scope.evaluate((element, { request, ROW }) => {
		// Not the copy of a request that sticks to the top of the list as its reply scrolls by: it comes after the list's rows.
		const items = [...element.querySelectorAll<HTMLElement>(ROW)];
		const index = items.findLastIndex(item => item.classList.contains('interactive-request') && item.textContent?.includes(request));
		return (index < 0 ? undefined : items.slice(index + 1).find(item => item.classList.contains('interactive-response')))?.innerText.replace(/\s+/g, ' ') ?? '';
	}, { request, ROW });
	/**
	 * The chat's last request, the text of its reply that shows (not the steps a finished reply folds
	 * into its closed "Completed N steps"), and whether that reply is still coming.
	 */
	const lastTurn = (scope: Locator) => scope.evaluate((element, ROW) => {
		const items = [...element.querySelectorAll<HTMLElement>(ROW)];
		const request = items.findLastIndex(item => item.classList.contains('interactive-request'));
		const response = items.slice(request + 1).find(item => item.classList.contains('interactive-response'));
		const shown = response?.cloneNode(true) as HTMLElement | undefined;
		shown?.querySelectorAll('details:not([open])').forEach(folded => folded.remove());
		return {
			request: items[request]?.innerText.replace(/\s+/g, ' ') ?? '',
			reply: shown?.textContent?.replace(/\s+/g, ' ') ?? '',
			loading: !response || response.classList.contains('chat-response-loading'),
		};
	}, ROW);
	/** Waits until the reply to `request` holds `text` and the chat is idle. */
	const answered = async (scope: Locator, request: string, text: string | RegExp) => {
		await until(async () => {
			const shown = await reply(scope, request);
			return typeof text === 'string' ? shown.includes(text) : text.test(shown);
		}, async () => `the reply to ${JSON.stringify(request)} never showed ${text}: ${JSON.stringify((await reply(scope, request)).slice(0, 600))}`);
		await scope.locator('.interactive-item-container.interactive-response.chat-response-loading').waitFor({ state: 'detached', timeout: STEP_TIMEOUT });
	};
	/** Sends a slash command, whose suggestions take the first Enter. `shown` is how its request reads. */
	const slash = async (scope: Locator, text: string, shown = text) => {
		await scope.locator(INPUT).click();
		await win.keyboard.insertText(text);
		await submit(scope, shown, text.split(' ')[0]);
	};
	/** What a chat's input holds. */
	const typed = async (scope: Locator) => (await scope.locator(`${INPUT} .view-lines`).innerText()).replace(/\s+/g, ' ').trim();
	/**
	 * Presses Enter in a chat until its input is empty, so the message went, and waits for a request
	 * with `shown`. The list draws only the rows in view, so counting them would not say a new one came.
	 */
	const submit = async (scope: Locator, shown: string, what: string) => {
		// The editor draws what was typed on a later frame, and until then its input reads as empty.
		await until(async () => !!await typed(scope), async () => `${what} never showed in the chat's input`);
		for (let attempt = 0; await typed(scope); attempt++) {
			if (attempt === 3) {
				throw new Error(`${what} was not sent`);
			}
			await win.keyboard.press('Enter');
			await win.waitForTimeout(1000);
		}
		await scope.locator(REQUEST, { hasText: shown }).last().waitFor({ state: 'attached', timeout: STEP_TIMEOUT });
	};
	/** Picks a model in a chat's picker. */
	const pick = async (scope: Locator, name: string) => {
		await picker(scope).locator('.action-label, .monaco-button, a', { hasText: /Acme/ }).first().click();
		await win.keyboard.insertText(name);
		await win.locator('.action-widget .monaco-list-row', { hasText: name }).first().click({ timeout: STEP_TIMEOUT });
		await picker(scope).getByText(name, { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
	};

	await step(win, 'enter the workbench and open the chat', async () => {
		// A fresh profile starts on the one-button entrance.
		await win.waitForSelector('.dragon-onboarding[role=dialog]', { state: 'visible', timeout: STEP_TIMEOUT });
		await win.getByRole('button', { name: 'Enter FREEDOM AI', exact: true }).click();
		await win.waitForSelector('.dragon-onboarding', { state: 'detached', timeout: STEP_TIMEOUT });
		await win.waitForSelector('.monaco-workbench', { timeout: STEP_TIMEOUT });
		await runCommand(win, 'Chat: Open Chat');
		await main.locator(INPUT).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		// Send only once the picker shows the scripted model, as a person would.
		await picker(main).getByText('Acme Large', { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the model picker shows ${JSON.stringify((await picker(main).innerText().catch(() => '')).replace(/\s+/g, ' ').trim())}, not Acme Large`, { cause: err });
		});
		// Toasts (such as the running-as-root warning in containers) sit over the composer.
		await runCommand(win, 'Notifications: Clear All Notifications');
	});

	await step(win, 'instruction files reach the model once: CLAUDE.md with the first message, AGENTS.md only from OpenCode', async () => {
		await send(main, '[[mock:hello]] Say hello.');
		await answered(main, '[[mock:hello]] Say hello.', 'Hello.');
		await send(main, '[[mock:hello]] Say hello again.');
		await answered(main, '[[mock:hello]] Say hello again.', 'Hello.');
		const last = turns().filter(t => t.text.includes('Say hello again.')).at(-1)?.text ?? '';
		// Sent with every message, the second request holds CLAUDE.md twice and AGENTS.md three times.
		// Named by VS Code's label for it, OpenCode wrote "Attached file: prompt:CLAUDE.md" above it.
		const found = { claude: count(last, 'CLAUDE-MD-MARKER'), agents: count(last, 'AGENTS-MD-MARKER'), named: count(last, 'Attached file: CLAUDE.md\\n') };
		if (JSON.stringify(found) !== JSON.stringify({ claude: 1, agents: 1, named: 1 })) {
			throw new Error(`the second message's request holds the instruction files this often: ${JSON.stringify(found)}`);
		}
		await shot(win, 'instructions');
	});

	await step(win, 'instruction files and skills from outside the open folder do not reach the model: the user\'s own, OpenCode\'s and the folder above\'s', async () => {
		const sent = turns().map(turn => turn.text);
		const found = [...outsideMarkers, ...userClaudeMd ? [userClaudeMd] : []].filter(text => sent.some(request => request.includes(text)))
			.map(text => text === userClaudeMd ? '~/.claude/CLAUDE.md' : text);
		if (sent.length < 2 || found.length) {
			throw new Error(`of ${sent.length} requests, some hold what is outside the open folder: ${found.join(', ')}`);
		}
	});

	await step(win, 'a message typed while a command runs joins that work instead of stopping it', async () => {
		const first = '[[mock:slow]] Wait five seconds, then answer.';
		const second = 'Also say hi.';
		await send(main, first);
		await until(() => turns().some(t => t.text.includes('[[mock:slow]]')), () => 'the model was never asked about the slow command');
		// The model has answered with the command once it was asked; give the command a moment to start.
		await win.waitForTimeout(1500);
		if (fs.existsSync(path.join(workspace, 'slow.txt')) || !await main.locator('.chat-response-loading').count()) {
			throw new Error('the command ended before a message could be typed while it ran');
		}
		// Enter in a busy chat steers it (`chat.requestQueuing.defaultAction`).
		await send(main, second);
		await answered(main, second, 'Done, and hi.');
		const found = {
			commandFinished: fs.existsSync(path.join(workspace, 'slow.txt')),
			firstReply: (await reply(main, first)).includes('The work continues below, with your new message.'),
			// The message reached the model after the command's output, in the same conversation.
			sentWithOutput: turns().filter(t => t.text.includes(second)).map(t => t.text.includes('[[mock:slow]]') && t.text.includes('slow done')),
		};
		if (JSON.stringify(found) !== JSON.stringify({ commandFinished: true, firstReply: true, sentWithOutput: [true] })) {
			throw new Error(`the message did not join the running work: ${JSON.stringify(found)}`);
		}
		await shot(win, 'steered');
	});

	await step(win, '/compact shows the summary and how much it saved', async () => {
		await slash(main, '/compact');
		await answered(main, '/compact', /Compacted the conversation: \S+ tokens of history became a \S+-token summary\./);
		// The summary is a thinking block, folded into the turn's steps once the turn ends.
		const turn = main.locator('.interactive-item-container.interactive-response').last();
		await turn.getByText(/^Completed \d+ steps?/).first().click();
		await turn.getByText('Summarizing the conversation', { exact: true }).first().click({ timeout: STEP_TIMEOUT });
		// The block scrolls within a fixed height, so the summary is checked as text, not for being in view.
		await turn.getByText('Say hello, wait, and say hi.').first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the summary is not in the turn: ${JSON.stringify(await turn.evaluate(element => element.textContent))}`, { cause: err });
		});
		const shown = await reply(main, '/compact');
		if (shown.includes('finished without a reply')) {
			throw new Error(`the compaction does not show its summary: ${JSON.stringify(shown.slice(0, 600))}`);
		}
		await shot(win, 'compacted');
	});

	await step(win, '/compact typed while a command runs lets the command finish, then compacts and shows the summary', async () => {
		fs.rmSync(path.join(workspace, 'slow.txt'), { force: true });
		const first = '[[mock:slow]] Wait five seconds once more, then answer.';
		await send(main, first);
		await until(() => turns().some(t => t.text.includes('Wait five seconds once more')), () => 'the model was never asked about the slow command');
		await win.waitForTimeout(1500);
		if (fs.existsSync(path.join(workspace, 'slow.txt')) || !await main.locator('.chat-response-loading').count()) {
			throw new Error('the command ended before /compact could be typed while it ran');
		}
		await slash(main, '/compact');
		// The chat's last turn once it is idle: the reply to the /compact before this one says the same.
		const compacted = /Compacted the conversation: \S+ tokens of history became a \S+-token summary\./;
		await until(async () => {
			const last = await lastTurn(main);
			return !last.loading && last.request.includes('/compact') && compacted.test(last.reply);
		}, async () => `the chat's last turn is not /compact saying it compacted: ${JSON.stringify(await lastTurn(main)).slice(0, 700)}`);
		if (!fs.existsSync(path.join(workspace, 'slow.txt'))) {
			throw new Error('the command was stopped');
		}
		await shot(win, 'compacted-while-busy');
	});

	await step(win, 'a new agent starts on the model last picked, and messages to it run on the model its picker shows', async () => {
		await pick(main, 'Acme Small');
		await send(main, '[[mock:hello]] Hello on the small model.');
		await answered(main, '[[mock:hello]] Hello on the small model.', 'Hello.');
		await runCommand(win, 'Dragon: New Agent');
		await editor.locator(INPUT).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		const shownAtStart = (await picker(editor).innerText()).includes('Acme Small') ? SMALL : MODEL;
		// The side bar's chat messages the agent, which wakes in its own chat. Its messages are on
		// without the user turning them on.
		await main.locator('.interactive-input-part .dragon-messaging-toggle.dragon-messaging-on').waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the side bar's Messages chip is ${await main.locator('.interactive-input-part .dragon-messaging-toggle').getAttribute('class').catch(() => 'missing')}`, { cause: err });
		});
		await send(main, '[[mock:ping]] Ping the agent.');
		await editor.locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: 'Pong.' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await answered(main, '[[mock:ping]] Ping the agent.', 'Pinged.');
		// Then the user picks another model in the agent's chat, and the next message runs on it.
		await pick(editor, 'Acme Large');
		await send(main, '[[mock:again]] Ping it again.');
		await editor.locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: 'Pong again.' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await answered(main, '[[mock:again]] Ping it again.', 'Pinged again.');
		// The agent's own requests (the side bar's conversation holds the same text, as the tool calls that
		// sent it), before and after the second message.
		const agent = turns().filter(t => t.text.includes('[[mock:pong]]') && !t.text.includes('[[mock:ping]]'));
		const ran = (second: boolean) => [...new Set(agent.filter(t => t.text.includes('[[mock:pong2]]') === second).map(t => t.model))].join(',');
		const found = { shownAtStart, first: ran(false), afterPick: ran(true) };
		if (JSON.stringify(found) !== JSON.stringify({ shownAtStart: SMALL, first: SMALL, afterPick: MODEL })) {
			throw new Error(`the agent did not run on the model its picker shows: ${JSON.stringify(found)}`);
		}
		await shot(win, 'agent-models');
	});

	await step(win, 'code the execute tool cannot parse comes back to the model saying the tool runs only JavaScript', async () => {
		await send(main, '[[mock:python]] Write the planner agent.');
		await answered(main, '[[mock:python]]', 'Understood: JavaScript only.');
		const sent = turns().filter(t => t.text.includes('[[mock:python]]')).at(-1)?.text ?? '';
		const found = { parseError: sent.includes('may appear only with'), explained: sent.includes('execute runs JavaScript only, and this code is not valid JavaScript.') };
		if (!found.parseError || !found.explained) {
			throw new Error(`the model was not told the tool runs only JavaScript: ${JSON.stringify(found)}`);
		}
		await shot(win, 'execute-javascript-only');
	});

	/** The editor group whose active tab is `name`'s chat. */
	const pane = (name: string) => win.locator('.editor-group-container').filter({ has: win.locator('.tab.active', { hasText: name }) }).first();
	/** Whether a request body has `part`. Request bodies are JSON, so a roster's line breaks are escaped in them. */
	const sent = (text: string, part: string) => text.includes(JSON.stringify(part).slice(1, -1));
	/** A chat's Messages chip. The chips poll the hub, so they catch up within a few seconds. */
	const chip = (scope: Locator) => scope.locator('.dragon-messaging-toggle .dragon-chip-label').first().innerText();
	/** The artist's turns: its requests hold the lead's messages to it, and not the lead's own. */
	const artist = () => turns().filter(t => t.text.includes('[[mock:art]]') && !t.text.includes('[[mock:cast]]'));
	/** Clicks the permission chip until it shows `mode`, which is the window's, for every chat. */
	const setPermission = async (mode: 'readonly' | 'full') => {
		const permission = main.locator('.interactive-input-part .dragon-permission-toggle');
		const shown = async () => await permission.getAttribute('class') ?? '';
		for (let i = 0; i < 3 && !(await shown()).includes(`dragon-permission-${mode}`); i++) {
			const before = await shown();
			await permission.click();
			await until(async () => await shown() !== before, () => 'the permission chip did not change');
		}
		if (!(await shown()).includes(`dragon-permission-${mode}`)) {
			throw new Error(`the permission chip did not reach ${mode}: ${await shown()}`);
		}
	};

	await step(win, 'the user opens two more agents with the plus in the side bar\'s title and tells its chat it leads the three: it messages each, each runs in its own tab, and every answer reaches it once', async () => {
		// As the user does: the plus in the side bar chat's title opens an agent in a tab of its own.
		// agent-1 is the one Dragon: New Agent opened.
		const title = win.locator('.part.auxiliarybar .composite.title');
		const tabs = async () => (await win.locator('.editor-group-container .tab .label-name').allInnerTexts()).map(name => name.trim());
		for (const name of ['agent-2', 'agent-3']) {
			await title.getByRole('button', { name: 'New Agent', exact: true }).click({ timeout: STEP_TIMEOUT });
			await until(async () => (await tabs()).includes(name), async () => `after New Agent the tabs read ${JSON.stringify(await tabs())}, not ${name}`);
		}
		// The first time the answers come after the lead's turn ended, each as a turn of its own in
		// its chat; the second time while its turn shows it.
		const rounds = [
			{ say: '[[mock:lead]] You lead the three agents I opened. Have each name one part of the game, then tell me the names.', answers: { 'agent-1': 'Hero: Ignis.', 'agent-2': 'Villain: Morgath.', 'agent-3': 'First level: Ember Caves.' } },
			{ say: '[[mock:lead-slow]] Have each name one more part.', answers: { 'agent-1': 'Sidekick: Ash.', 'agent-2': 'Boss: Cinder King.', 'agent-3': 'Second level: Frost Peaks.' } },
			// The user asks how they are doing once the agents work, while the lead's turn still runs.
			{
				say: '[[mock:lead-asks]] Have each name one thing more.', steer: '[[mock:status]] How are they doing?', answers: { 'agent-1': 'Power-up: Fire Shield.', 'agent-2': 'Enemy: Ash Imp.', 'agent-3': 'Third level: Lava Lake.' },
				steerWhen: async () => ['[[mock:power]]', '[[mock:enemy]]', '[[mock:level3]]'].every(marker => turns().some(t => t.text.includes(marker))),
			},
			// The user asks again while the lead waits for agent-3 with wait_agent, once agent-1 and agent-2 have answered.
			{
				say: '[[mock:lead-waits]] Have each name a last part, and tell me when agent-3 is done.', steer: '[[mock:status-wait]] Are they done yet?', answers: { 'agent-1': 'Shield: Dragon Scale.', 'agent-2': 'Minion: Ember Bat.', 'agent-3': 'Last level: Obsidian Keep.' },
				steerWhen: async () => turns().filter(t => t.text.includes('[[mock:lead-waits]]')).length >= 2 && await main.innerText().then(text => ['Shield: Dragon Scale.', 'Minion: Ember Bat.'].every(answer => text.includes(answer)))
					// It waits: its tool shows ("Running `wait_agent`"), not only send_message's result, which names wait_agent.
					&& await main.locator('.interactive-item-container.interactive-response').last().evaluate(response => /(?:Running|Ran) `?wait_agent/.test(response.textContent ?? '')),
			},
		];
		/** The lead's last request: it holds the user's messages, and an agent's hold only what the lead sent it. */
		const last = () => turns().filter(t => t.text.includes('[[mock:lead]]')).at(-1)?.text ?? '';
		/**
		 * The lead's replies to the answers: its model's turns that an answer started, each "Noted.".
		 * One that ran after the chat's turn had ended would reach no chat.
		 */
		const replies = () => mock.requests.filter(r => r.path.startsWith('/v1/chat/completions') && JSON.stringify(r.body).includes('[[mock:lead]]')).filter(r => {
			const messages = (r.body as { messages?: { role: string; content?: string | { text?: string }[] }[] }).messages ?? [];
			const marked = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(part => part.text ?? '').join('\n')).filter(text => /\[\[mock:[\w-]+\]\]/.test(text));
			return marked.at(-1)?.includes('[[mock:heard]]');
		}).length;
		const running = () => main.locator('.chat-response-loading').count();
		/**
		 * The lead's chat from the user's first message to the lead on. The list draws only the rows in
		 * view, so this scrolls until it draws the first, then down less than a view at a time, reading
		 * each row by its index.
		 */
		const leadChat = async () => {
			const rows = new Map<number, string>();
			const drawn = () => main.locator('.interactive-list .monaco-list-rows > .monaco-list-row[data-index]').evaluateAll(elements => elements.map(element => Number(element.getAttribute('data-index'))));
			await main.locator('.interactive-list').first().hover();
			for (let i = 0; i < 100 && !(await drawn()).includes(0); i++) {
				await win.mouse.wheel(0, -5_000);
				await win.waitForTimeout(50);
			}
			if (!(await drawn()).includes(0)) {
				throw new Error(`the lead's chat did not scroll to its first row: it draws ${JSON.stringify(await drawn())}`);
			}
			for (let i = 0; i < 300; i++) {
				await win.waitForTimeout(50);
				const shown = await main.locator('.interactive-list .monaco-list-rows > .monaco-list-row[data-index]').evaluateAll(elements => elements.map(element => ({ index: Number(element.getAttribute('data-index')), last: element.getAttribute('data-last-element') === 'true', text: (element as HTMLElement).innerText })));
				shown.forEach(row => rows.set(row.index, row.text));
				if (shown.some(row => row.last)) {
					break;
				}
				await win.mouse.wheel(0, 200);
			}
			const ordered = [...rows.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);
			return ordered.slice(Math.max(0, ordered.findIndex(text => text.includes('You lead the three agents I opened')))).join('\n');
		};
		const found: Record<string, unknown>[] = [];
		const expected: Record<string, unknown>[] = [];
		for (const round of rounds) {
			await send(main, round.say);
			if (round.steer && round.steerWhen) {
				await until(round.steerWhen, async () => `the agents did not start on the lead's messages, or did not answer it: ${JSON.stringify((await main.innerText()).replace(/\s+/g, ' ').slice(-1_500))}`);
				await send(main, round.steer);
			}
			const held = () => Object.fromEntries(Object.entries(round.answers).map(([name, answer]) => [name, count(last(), answer)]));
			await until(async () => Object.values(held()).every(times => times > 0) && !await running(), async () => `the lead's last request does not hold every answer, or it still runs: ${JSON.stringify({ held: held(), running: await running() })}`);
			// An answer delivered twice would come after.
			await win.waitForTimeout(2_000);
			const ranInTab: Record<string, boolean> = {};
			// The agents whose tab shows a message wrapper's tags in their answer: agent-3 writes its second
			// answer wrapped as a message, and its tab shows the words alone.
			const tagsInTab: string[] = [];
			for (const [name, answer] of Object.entries(round.answers)) {
				await win.locator('.editor-group-container .tab', { hasText: name }).first().click();
				const reply = pane(name).locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: answer }).first();
				ranInTab[name] = await reply.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
				if (ranInTab[name] && (await reply.innerText()).includes('agent-message')) {
					tagsInTab.push(name);
				}
			}
			const lead = (await main.innerText()).replace(/\s+/g, ' ');
			found.push({ held: held(), ranInTab, tagsInTab, shownToLead: Object.fromEntries(Object.entries(round.answers).map(([name, answer]) => [name, lead.includes(answer)])) });
			const every = (value: unknown) => Object.fromEntries(Object.keys(round.answers).map(name => [name, value]));
			expected.push({ held: every(1), ranInTab: every(true), tagsInTab: [], shownToLead: every(true) });
		}
		const whole = await leadChat();
		fs.writeFileSync(path.join(out, 'team-lead-chat.txt'), whole);
		const lead = whole.replace(/\s+/g, ' ');
		found.push({
			// An answer that arrives in the lead's reply right after its text is a quote of its own, not
			// "All three are on it.> From agent-2". It arrives there only when the timing falls so.
			quoteJoined: lead.includes('> From'),
			// Answers that come while the lead writes show after its text, not inside it ("On it", the answers, "again.").
			textWhole: lead.includes('On it again.'),
			// agent-3's answer, wrapped as a message, reaches the lead in its own words: the wrapper's tags,
			// broken by the guard against forged senders, are in neither the lead's request nor its chat.
			wrapperPassedOn: last().includes('agent-message\u200b') || lead.includes('agent-message'),
			// Every answer shows once, also those that came while the user's question ran, and so does the
			// lead's reply to it; and those a step after them folded away, in the turn that gave way to it.
			shownOnce: rounds.flatMap(round => Object.values(round.answers)).filter(answer => count(lead, answer) !== 1),
			statusReplied: lead.includes('Still working.'),
			// The lead answers the user's question while agent-3, which it waits for, still works: its
			// answer comes after, as a message.
			repliedWhileWaiting: lead.indexOf('Not yet.') >= 0 && lead.indexOf('Not yet.') < lead.indexOf('Last level: Obsidian Keep.'),
			// The step the ended wait returns to reads the question that ended it, which is in the lead's
			// inbox by then: ended as it was being sent, that step was told the user wrote, and read no question.
			waitEndRead: (() => {
				const ended = mock.requests.find(r => JSON.stringify(r.body ?? '').includes('The user wrote to you, so you stopped waiting'));
				return !!ended && JSON.stringify(ended.body).includes('[[mock:status-wait]]');
			})(),
			// The lead's text that the user's question came in shows whole, before the turn gives way to it.
			askedWhole: lead.includes('Asked them.'),
			// agent-2's answer, in the words its model thought first, comes with a note that it may be
			// thinking and no answer; the others come without.
			thoughtNoted: count(lead, 'wrote this word for word as its thinking first') === 1 && lead.includes('(agent-2 wrote this word for word as its thinking first'),
			// Every reply the lead's model gave to an answer shows in its chat.
			repliesShown: count(lead, 'Noted.') === replies() && replies() > 0 || { replies: replies(), shown: count(lead, 'Noted.') },
		});
		expected.push({ quoteJoined: false, textWhole: true, wrapperPassedOn: false, shownOnce: [], statusReplied: true, repliedWhileWaiting: true, waitEndRead: true, askedWhole: true, thoughtNoted: true, repliesShown: true });
		if (JSON.stringify(found) !== JSON.stringify(expected)) {
			throw new Error(`the lead did not run the three agents the user opened, or not every answer reached it once: ${JSON.stringify(found)}`);
		}
		await shot(win, 'team-of-three');
	});

	await step(win, 'the side bar\'s chat messages and runs the chats the user opened, typed in or not, and is not told about them once they close', async () => {
		// The user opens two chats beside the agent's: they type in one, and leave the other empty.
		const active = win.locator('.editor-group-container.active');
		const requests = active.locator('.interactive-item-container.interactive-request');
		await runCommand(win, 'Chat: New Chat Editor');
		await until(async () => await active.locator(INPUT).isVisible() && !await requests.count(), () => 'the first new chat editor did not open');
		await send(active, '[[mock:hello]] scout');
		await answered(active, '[[mock:hello]] scout', 'Hello.');
		await runCommand(win, 'Chat: New Chat Editor');
		await until(async () => await active.locator(INPUT).isVisible() && !await requests.count(), () => 'the second new chat editor did not open');
		const empty = active;
		await send(main, '[[mock:rally]] Message the agents I opened and run them.');
		await answered(main, '[[mock:rally]]', 'Both are on it.');
		// The empty chat runs the message in view, under the name it was messaged by.
		await empty.locator('.interactive-item-container.interactive-response .rendered-markdown', { hasText: 'Reporting in.' }).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the empty chat did not run the message: ${JSON.stringify((await empty.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400))}`, { cause: err });
		});
		const ran = (scout: boolean) => turns().some(t => t.text.includes('[[mock:report]]') && !t.text.includes('[[mock:rally]]') && t.text.includes('[[mock:hello]] scout') === scout);
		await until(() => ran(true) && ran(false), () => `not every chat ran the message: ${JSON.stringify({ scout: ran(true), empty: ran(false) })}`);
		const rally = turns().find(t => t.text.includes('[[mock:rally]]'))?.text ?? '';
		const found = {
			told: ['- mock-hello-scout: idle', '- agent-4: idle'].map(line => sent(rally, line)),
			tab: (await active.locator('.tab.active').innerText()).replace(/\s+/g, ' ').trim(),
			// The side bar's chat is the one the user talks to: "main", not its first words.
			main: sent(rally, 'You are "main".') && await empty.locator('.interactive-item-container.interactive-request', { hasText: 'From main' }).count() > 0,
		};
		if (JSON.stringify(found) !== JSON.stringify({ told: [true, true], tab: 'agent-4', main: true })) {
			throw new Error(`the side bar's chat was not told about the chats the user opened, or the empty one is not named, or the side bar's is not "main": ${JSON.stringify(found)}`);
		}
		await shot(win, 'opened-chats-run');
		// Closed, they are no longer in the roster; the agent New Agent opened still is. Closing the
		// empty chat shows the scout chat, the tab before it.
		const shows = async (text: string) => (await requests.first().innerText({ timeout: 1_000 }).catch(() => '')).includes(text);
		await active.locator('.tab.active').click();
		await runCommand(win, 'View: Close Editor');
		await until(() => shows('[[mock:hello]] scout'), async () => `after agent-4 closed, the group shows ${JSON.stringify(await active.locator('.tab.active').innerText().catch(() => ''))}`);
		await runCommand(win, 'View: Close Editor');
		await until(async () => !await shows('[[mock:hello]] scout'), () => 'the scout chat did not close');
		await send(main, '[[mock:hello]] Who is open now?');
		await answered(main, '[[mock:hello]] Who is open now?', 'Hello.');
		const after = turns().filter(t => t.text.includes('Who is open now?')).at(-1)?.text ?? '';
		const listed = { scout: sent(after, '- mock-hello-scout:'), empty: sent(after, '- agent-4:'), agent: sent(after, '- agent-1:') };
		if (JSON.stringify(listed) !== JSON.stringify({ scout: false, empty: false, agent: true })) {
			throw new Error(`after the chats closed, the side bar's chat was told: ${JSON.stringify(listed)}`);
		}
	});

	await step(win, 'the chat\'s Lead a Team button starts /team, which starts teammates the lead is told about, which run on the lead\'s model', async () => {
		// The lead is the side bar's chat, on Acme Small; Acme Large was picked last, in the agent's chat.
		// Its Lead a Team button puts /team in its input, for the rest of the message. A narrow chat, as
		// this one is, moves the first buttons of its title to its Views and More Actions menu: Lead a
		// Team comes before New Agent, so New Agent stays in sight.
		const title = win.locator('.part.auxiliarybar .composite.title');
		await title.getByRole('button', { name: 'New Agent', exact: true }).waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
			throw new Error('the chat\'s title no longer shows New Agent');
		});
		const lead = title.getByRole('button', { name: 'Lead a Team', exact: true });
		if (await lead.isVisible()) {
			console.log('note: the chat\'s title shows Lead a Team');
			await lead.click();
		} else {
			console.log('note: Lead a Team is in the chat\'s Views and More Actions menu');
			const names = (scope: Locator, role: 'button' | 'menuitem') => scope.getByRole(role).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') || element.textContent?.trim()));
			await title.getByRole('button', { name: 'Views and More Actions...', exact: true }).click({ timeout: 5_000 }).catch(async () => {
				throw new Error(`the chat's title has no Views and More Actions button: ${JSON.stringify(await names(title, 'button'))}`);
			});
			await win.getByRole('menuitem', { name: 'Lead a Team', exact: true }).click({ timeout: 5_000 }).catch(async () => {
				throw new Error(`the chat's Views and More Actions menu has no Lead a Team: ${JSON.stringify(await names(win.locator('.monaco-menu-container, .context-view'), 'menuitem'))}`);
			});
		}
		await until(async () => (await main.locator(INPUT).innerText()).replace(/\s+/g, ' ').trim() === '/team', async () => `after Lead a Team the chat's input reads ${JSON.stringify(await main.locator(INPUT).innerText())}`);
		await win.keyboard.insertText('2 [[mock:delegate]] Make the title screen.');
		await submit(main, '[[mock:delegate]]', '/team');
		await answered(main, '[[mock:delegate]]', 'Handed out.');
		const teammate = () => turns().filter(t => t.text.includes('[[mock:work]]') && !t.text.includes('[[mock:delegate]]'));
		await until(() => teammate().length > 0, () => 'teammate-1 never ran a turn');
		const chips = async () => [await chip(main), await chip(pane('teammate-1')), await chip(pane('teammate-2'))];
		await until(async () => JSON.stringify(await chips()) === JSON.stringify(['lead', 'teammate-1', 'teammate-2']), async () => `the Messages chips show ${JSON.stringify(await chips())}`);
		// teammate-1's answer comes back to the lead on its own, as a message from it.
		await main.locator('.interactive-item-container.interactive-request', { hasText: 'From teammate-1' }).first().waitFor({ state: 'attached', timeout: STEP_TIMEOUT }).catch(err => {
			throw new Error('teammate-1\'s answer did not reach the lead', { cause: err });
		});
		// What the chat says before the lead's turn is folded into its steps, so it is checked as text,
		// not for being shown; the lead's turn on teammate-1's answer comes after it.
		const full = (await main.locator('.interactive-item-container.interactive-response').evaluateAll(elements => elements.map(element => element.textContent ?? ''))).join('\n');
		const found = {
			reply: full.includes('This chat leads the team "work". Started teammate-1, teammate-2'),
			panes: [await pane('teammate-1').count(), await pane('teammate-2').count()],
			leadTold: sent(turns().find(t => t.text.includes('[[mock:delegate]]'))?.text ?? '', 'You are "lead", the lead of the team "work". Your teammates:\n- teammate-1: idle\n- teammate-2: idle\n'),
			teammateTold: sent(teammate()[0].text, 'You are "teammate-1", a teammate on the team "work", led by "lead".'),
			teammateModel: teammate()[0].model,
			picker: (await picker(pane('teammate-1')).innerText()).includes('Acme Small'),
		};
		const expected = { reply: true, panes: [1, 1], leadTold: true, teammateTold: true, teammateModel: SMALL, picker: true };
		if (JSON.stringify(found) !== JSON.stringify(expected)) {
			throw new Error(`the team is not as expected: ${JSON.stringify(found)}`);
		}
		await shot(win, 'team');
	});

	await step(win, '/create-agent adds a teammate for a role in a pane of its own, it and the lead are told its part with every request, and it asks its lead, not the user', async () => {
		await slash(main, '/create-agent artist Draws the pixel-art sprites.', 'Draws the pixel-art sprites.');
		await answered(main, 'Draws the pixel-art sprites.', 'Started artist in a pane of its own');
		await pane('artist').waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await until(async () => await chip(pane('artist')).catch(() => '') === 'artist', async () => `the artist's Messages chip shows ${JSON.stringify(await chip(pane('artist')).catch(() => ''))}`);
		await slash(main, '[[mock:cast]] Get the hero drawn.');
		await answered(main, '[[mock:cast]]', 'Asked the artist.');
		await until(() => artist().length > 0, () => 'the artist never ran a turn');
		const found = {
			leadTold: sent(turns().find(t => t.text.includes('[[mock:cast]]'))?.text ?? '', '- artist (Draws the pixel-art sprites.): idle'),
			artistTold: sent(artist()[0].text, 'You are "artist", a teammate on the team "work", led by "lead". Your part: Draws the pixel-art sprites. Do what your lead sends you'),
			artistModel: artist()[0].model,
			// A teammate is not offered OpenCode's question tool, which would leave it waiting on the user.
			leadAsks: turns().find(t => t.text.includes('[[mock:cast]]'))?.tools.includes('question'),
			artistAsks: artist()[0].tools.includes('question'),
		};
		const expected = { leadTold: true, artistTold: true, artistModel: SMALL, leadAsks: true, artistAsks: false };
		if (JSON.stringify(found) !== JSON.stringify(expected)) {
			throw new Error(`the artist is not as expected: ${JSON.stringify(found)}`);
		}
		await shot(win, 'create-agent');
	});

	await step(win, 'under Read-Only a message typed to a teammate runs it with the Read-Only rules, and it still asks its lead, not the user', async () => {
		// A person's message applies the mode, which replaces the session's rules, so the teammate's own
		// has to be sent again. (A message from another agent keeps the session's rules.)
		await setPermission('readonly');
		const before = artist().length;
		await slash(pane('artist'), '[[mock:art]] Draw the villain.');
		await answered(pane('artist'), '[[mock:art]] Draw the villain.', 'Hero drawn.');
		await until(() => artist().length > before, () => 'the artist never ran a turn under Read-Only');
		const offered = artist().at(-1)!.tools;
		const found = { asks: offered.includes('question'), changes: ['edit', 'write', 'shell'].filter(tool => offered.includes(tool)) };
		await setPermission('full');
		if (JSON.stringify(found) !== JSON.stringify({ asks: false, changes: [] })) {
			throw new Error(`under Read-Only the artist is offered ${JSON.stringify(found)}`);
		}
	});

	await step(win, 'New Agent in the lead\'s title adds a teammate to its team, which the lead is told about, which runs on the lead\'s model and asks its lead', async () => {
		// The lead is the side bar's chat, on Acme Small. A chat editor's title has New Agent too, which
		// the agents smoke test clicks.
		await win.locator('.part.auxiliarybar .composite.title').getByRole('button', { name: 'New Agent', exact: true }).click({ timeout: STEP_TIMEOUT });
		await pane('teammate-3').waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async () => {
			throw new Error(`New Agent opened no pane for teammate-3; the tabs read ${JSON.stringify(await win.locator('.tab').allInnerTexts())}`);
		});
		await until(async () => await chip(pane('teammate-3')).catch(() => '') === 'teammate-3', async () => `the new teammate's Messages chip shows ${JSON.stringify(await chip(pane('teammate-3')).catch(() => ''))}`);
		await send(main, '[[mock:recruit]] Put the new teammate to work.');
		await answered(main, '[[mock:recruit]]', 'Recruited.');
		const recruited = () => turns().filter(t => t.text.includes('[[mock:sounds]]') && !t.text.includes('[[mock:recruit]]'));
		await until(() => recruited().length > 0, () => 'teammate-3 never ran a turn');
		const found = {
			leadTold: sent(turns().find(t => t.text.includes('[[mock:recruit]]'))?.text ?? '', '- teammate-3: idle'),
			teammateTold: sent(recruited()[0].text, 'You are "teammate-3", a teammate on the team "work", led by "lead".'),
			teammateModel: recruited()[0].model,
			asks: recruited()[0].tools.includes('question'),
		};
		const expected = { leadTold: true, teammateTold: true, teammateModel: SMALL, asks: false };
		if (JSON.stringify(found) !== JSON.stringify(expected)) {
			throw new Error(`the new agent did not join the team: ${JSON.stringify(found)}`);
		}
		await shot(win, 'new-agent-joins-team');
	});

	await step(win, '/autocompact sets where a conversation compacts, the context readout shows it, and the next message past it is compacted first', async () => {
		await slash(main, '/autocompact 10%');
		await answered(main, '/autocompact 10%', 'Conversations compact automatically at 10% of the model\'s context window');
		// The readout polls, so it catches up within a few seconds.
		const context = main.locator('.interactive-input-part .dragon-usage .dragon-usage-context');
		const readout = async () => (await context.getAttribute('title').catch(() => null) ?? '').split('\n').at(-1);
		await until(async () => await readout() === 'Compacts automatically at 10% (20K tokens). /autocompact changes this.', async () => `the context readout ends ${JSON.stringify(await readout())}`);
		// The last reply reported a 30K-token prompt, past 10% of the 200K window.
		const summaries = () => mock.requests.filter(r => JSON.stringify(r.body ?? '').includes('Return only the structured summary')).length;
		const before = summaries();
		await send(main, '[[mock:hello]] Say hello after the compaction.');
		await answered(main, '[[mock:hello]] Say hello after the compaction.', 'Hello.');
		const full = await main.locator('.interactive-item-container.interactive-response').last().evaluate(element => element.textContent ?? '');
		const found = { summaries: summaries() - before, shown: /OpenCode compacted the conversation automatically: \S+ tokens of history became a \S+-token summary\./.test(full) };
		if (JSON.stringify(found) !== JSON.stringify({ summaries: 1, shown: true })) {
			throw new Error(`the conversation was not compacted before the message: ${JSON.stringify(found)}`);
		}
		await shot(win, 'autocompact');
		await slash(main, '/autocompact off');
		await answered(main, '/autocompact off', 'Automatic compaction is off');
		await until(async () => (await readout())?.startsWith('Automatic compaction is off') ?? false, async () => `after /autocompact off the context readout ends ${JSON.stringify(await readout())}`);
	});

	await step(win, 'a long command shows how long it has run of its timeout and the last line it printed, then reads as run', async () => {
		const request = '[[mock:build]] Export the game.';
		await send(main, request);
		// The command's card, while it runs: its line from Dragon, and the time the card counts up.
		const card = main.locator('.interactive-item-container.interactive-response').last().locator('.dragon-tool-card-running').first();
		const lines = new Set<string>();
		const counted = new Set<string>();
		await until(async () => {
			const shown = await card.evaluate(element => ({
				line: element.querySelector('.dragon-tool-card-subtitle')?.textContent ?? '',
				elapsed: element.querySelector('.dragon-tool-card-elapsed')?.textContent ?? '',
			}), undefined, { timeout: 500 }).catch(() => undefined);
			const seconds = shown && /— (?<seconds>\d+)s of its 5m timeout · `Exporting the game`$/.exec(shown.line)?.groups?.seconds;
			if (seconds) {
				lines.add(seconds);
			}
			if (shown?.elapsed) {
				counted.add(shown.elapsed);
			}
			return lines.size >= 3 && counted.size >= 2;
		}, async () => `the command's card did not count up with its output: line at ${JSON.stringify([...lines])}s, card at ${JSON.stringify([...counted])}; reply ${JSON.stringify((await reply(main, request)).slice(0, 600))}`);
		await shot(win, 'running-command');
		await answered(main, request, 'Built.');
		const done = await reply(main, request);
		if (done.includes('of its 5m timeout') || !done.includes('Ran ')) {
			throw new Error(`the finished command does not read as run: ${JSON.stringify(done.slice(0, 600))}`);
		}
	});

	await step(win, 'a turn the model provider refused for its usage limit shows the error once, with what to do about it', async () => {
		await send(main, '[[mock:limited]] Name the hero.');
		await answered(main, '[[mock:limited]]', 'Choose Model to pick another model');
		const shown = await reply(main, '[[mock:limited]]');
		const found = {
			times: shown.split('Rate limit exceeded. Please try again later.').length - 1,
			inErrorBox: await main.locator('.chat-notification-widget', { hasText: 'usage limit is reached' }).last().isVisible(),
		};
		if (found.times !== 1 || !found.inErrorBox) {
			throw new Error(`the error does not show once, in the error box, with what to do: ${JSON.stringify({ ...found, shown: shown.slice(0, 600) })}`);
		}
		await shot(win, 'usage-limit');
	});

	const screen = win.locator('.terminal-editor .xterm-rows').first();
	const drawn = async () => (await screen.innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ');
	await step(win, 'Open OpenCode TUI opens the terminal UI on this window\'s server, and it draws its prompt', async () => {
		await runCommand(win, 'Open OpenCode TUI');
		await until(async () => (await drawn()).includes('Ask anything'), async () => `the terminal UI drew ${JSON.stringify((await drawn()).slice(0, 600))}`);
		await shot(win, 'tui');
		await runCommand(win, 'Terminal: Kill All Terminals');
		await screen.waitFor({ state: 'detached', timeout: STEP_TIMEOUT });
	});

	const failing = 'a terminal UI that cannot start says why: OpenCode signed as Dragon IDE 1.1.5 signed it may not load its render library, and Dragon shows the reason OpenCode logged';
	if (process.platform !== 'darwin') {
		console.log(`SKIP  ${failing}: it needs macOS code signing`);
	} else {
		await step(win, failing, async () => {
			// A copy of the bundled OpenCode with the hardened runtime and the app's entitlements, without
			// leave to load libraries signed by others. An ad hoc signature has no Team ID, as the library has none.
			const bundled = args.app ? path.join(path.resolve(args.app), 'Contents', 'Resources', 'app', 'extensions', 'dragon-agent', 'bin', 'opencode') : path.join(root, 'extensions', 'dragon-agent', 'bin', 'opencode');
			const opencode = path.join(temp, 'opencode-signed-as-1.1.5');
			fs.copyFileSync(bundled, opencode);
			const signed = spawnSync('codesign', ['--force', '--options', 'runtime', '--entitlements', path.join(root, 'build', 'azure-pipelines', 'darwin', 'app-entitlements.plist'), '--sign', '-', opencode], { encoding: 'utf8' });
			if (signed.status !== 0) {
				throw new Error(`could not sign the copy of OpenCode: ${signed.stderr}`);
			}
			// A new binary restarts the server; the new start in OpenCode's log shows the setting was read.
			const logs = path.join(xdg.XDG_DATA_HOME, 'opencode', 'log');
			const serverStarts = () => (fs.existsSync(logs) ? fs.readdirSync(logs).filter(name => name.endsWith('.log')) : [])
				.flatMap(name => fs.readFileSync(path.join(logs, name), 'utf8').split('\n'))
				.filter(line => line.includes('message="cli starting"') && line.includes('[\\"serve\\",\\"--stdio\\"]')).length;
			const settingsFile = path.join(userData, 'User', 'settings.json');
			const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
			const configure = async (binary: string | undefined) => {
				const before = serverStarts();
				fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, 'dragon.opencode.path': binary }, null, '\t'));
				await until(() => serverStarts() > before, () => `OpenCode's server did not restart for dragon.opencode.path ${binary}: ${before} starts`);
			};
			await configure(opencode);
			try {
				await runCommand(win, 'Open OpenCode TUI');
				const toast = win.locator('.notifications-toasts .notification-list-item', { hasText: 'OpenCode\'s terminal UI stopped' }).first();
				const said = async () => (await toast.innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ');
				await until(async () => (await said()).length > 0, async () => `no notification said why; the terminal UI drew ${JSON.stringify((await drawn()).slice(0, 400))}`);
				await shot(win, 'tui-failed');
				const shown = await said();
				if (!shown.includes('because of how OpenCode is signed') || !shown.includes('Failed to initialize OpenTUI render library') || !shown.includes('different Team IDs') || !shown.includes('Show Log')) {
					throw new Error(`the notification does not say why the terminal UI stopped: ${JSON.stringify(shown)}`);
				}
			} finally {
				await configure(undefined);
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
console.log(failed ? 'Chat turns smoke test failed.' : 'Chat turns smoke test passed.');
console.log(`Screenshots and logs: ${out}`);
process.exitCode = failed ? 1 : 0;
