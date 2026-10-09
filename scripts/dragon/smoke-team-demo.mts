/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Team demo smoke test for the desktop app, on a real model: the free Nemotron a game-making team
// demo ran on. Launches Dragon IDE on a fresh profile, with no provider credentials, and checks in
// the UI as a person would use it:
//   1. The chat starts on opencode/nemotron-3.5-lightning-free, which OpenCode offers without an account
//   2. The user opens three agents with New Agent in the chat's title, each tab's Messages chip
//      naming its agent at once, and tells the chat, in plain words and without their names, that it
//      leads them and runs them itself. The chat, "main" to them, messages each; each runs a Nemotron
//      turn in its own tab from that message, every answer reaches main, and main reports what each
//      came up with. OpenCode's own record shows who messaged whom and what reached main
//   3. The user tells main to have them build the game: main has each agent write one of its files
//      (index.html, style.css, game.js) in the folder they share. OpenCode's record shows each agent
//      wrote one and only one, which no other agent and not main wrote, and the three make one game: opened in a window, the page loads its style and
//      script without errors, the script draws on the page's one canvas, and the style styles the page
//   4. In a new chat, /team 4 makes the chat the lead of four teammates in panes beside it; the lead hands each
//      a task with send_message, and each teammate runs a Nemotron turn from the lead's message.
//      OpenCode's own record shows the message, from the lead, and the model that answered it.
//      No teammate waits on a question card in its pane: it asks its lead, not the user
//   5. /compact in the lead's chat shows the summary and how much it saved
//   6. Open OpenCode TUI opens OpenCode's terminal UI on the window's server, and it draws its prompt
// It needs the network: it sends short test prompts to the free Nemotron model on OpenCode Zen. A
// free model can be slow or busy, so its steps wait minutes, and a lead that leaves a teammate
// without work is reminded once, as a person would. OpenCode's database is kept with the logs.
//
// Usage: node scripts/dragon/smoke-team-demo.mts [--app <packaged app dir>] [--out <dir>] [--steps <n>] [--git] [--ask]
//   Without --app it runs the development build (after `npm run compile` and `npm run electron`).
//   --steps 3 runs only the first three steps, the team of agents opened with New Agent, to run it again and again.
//   --git makes the folder a Git repository, as a developer's folders often are: New Agent then gives each
//   agent opened from a chat with no team a worktree of its own.
//   --ask runs in Ask permission mode, Dragon's default, not Full Access: the user answers each approval
//   the agents ask for as a person who talks only to main would, where the window shows it. Steps 2 and 3
//   fail when one shows only in an agent's tab that is not on screen, which the user opens to find it.
//   Linux: run under xvfb-run.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Locator, Page } from 'playwright';

const require = createRequire(import.meta.url);
const { _electron } = require('playwright') as typeof import('playwright');
const root = path.resolve(import.meta.dirname, '..', '..');
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] === '--git' || process.argv[i] === '--ask') {
		args[process.argv[i].slice(2)] = 'yes';
		continue;
	}
	const match = /^--(app|out|steps)$/.exec(process.argv[i]);
	if (!match || i + 1 >= process.argv.length) {
		throw new Error(`Unknown argument: ${process.argv[i]}. Usage: smoke-team-demo.mts [--app <dir>] [--out <dir>] [--steps <n>] [--git] [--ask]`);
	}
	args[match[1]] = process.argv[++i];
}
/** How many of the steps to run, from the first. */
const STEPS = args.steps === undefined ? Infinity : Number(args.steps);
if (args.steps !== undefined && (!Number.isInteger(STEPS) || STEPS < 1)) {
	throw new Error(`--steps takes a whole number of steps, not ${args.steps}`);
}
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-team-demo-smoke-')));
fs.mkdirSync(out, { recursive: true });
const MODEL = { providerID: 'opencode', id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free' };
const TEAMMATES = ['teammate-1', 'teammate-2', 'teammate-3', 'teammate-4'];
/** The agent extension's ID, which names its folder in the workspace storage. */
const EXTENSION_ID = 'vscode.dragon-agent';
const STEP_TIMEOUT = 90_000;
/** A chat's requests and replies, in the list's rows, not the request that sticks to its top. */
const ROW = '.monaco-list-rows .interactive-item-container';
const REQUEST = `${ROW}.interactive-request`;
/** How long a real model gets for a team's turns, or a compaction. */
const MODEL_TIMEOUT = 6 * 60_000;

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
let stepsRun = 0;
async function step<T>(page: Page | undefined, name: string, run: () => Promise<T>): Promise<T | undefined> {
	if (++stepsRun > STEPS) {
		console.log(`SKIP  ${name}`);
		return undefined;
	}
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

/** Waits until `check` returns true, or fails with what `describe` says. */
async function until(check: () => boolean | Promise<boolean>, describe: () => string | Promise<string>, timeout = STEP_TIMEOUT): Promise<void> {
	for (const end = Date.now() + timeout; !await check();) {
		if (Date.now() > end) {
			throw new Error(await describe());
		}
		await new Promise(resolve => setTimeout(resolve, 500));
	}
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-team-demo-run-'));
const workspace = path.join(temp, 'work');
const userData = path.join(temp, 'user-data');
/**
 * The app's home folder, empty. With the user's own, the workbench attached their ~/.claude/CLAUDE.md
 * to the first message, which went to the free model on OpenCode Zen.
 */
const home = path.join(temp, 'home');
fs.mkdirSync(home);
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Dragon Dash\n\nA tiny browser game, made by a team of agents.\n');
if (args.git) {
	// With the run's own home folder, not the user's Git configuration, which may sign commits.
	for (const command of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Dragon Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-q', '-m', 'Dragon Dash']]) {
		const result = spawnSync('git', command, { cwd: workspace, encoding: 'utf8', env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
		if (result.status !== 0) {
			throw new Error(`git ${command.join(' ')} failed in ${workspace}: ${result.stderr}`);
		}
	}
}
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
	'window.dialogStyle': 'custom',
	'security.workspace.trust.enabled': false,
	'workbench.startupEditor': 'none',
	'dragon.model': `${MODEL.providerID}/${MODEL.id}`,
	'dragon.permissionMode': args.ask ? 'ask' : 'full-access',
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
const xdg = Object.fromEntries(['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].map(name => {
	const dir = path.join(temp, name.toLowerCase());
	fs.mkdirSync(dir);
	return [name, dir];
}));

/** What OpenCode's own record says each teammate got from the lead, which models answered it, and whether it reported to the lead. */
interface TeammateRun {
	readonly fromLead: boolean;
	readonly answeredBy: string[];
	readonly reported: boolean;
}

/** All the strings in a stored message, wherever its text sits. */
function strings(value: unknown): string[] {
	if (typeof value === 'string') {
		return [value];
	}
	if (value && typeof value === 'object') {
		return Object.values(value).flatMap(strings);
	}
	return [];
}

/** OpenCode's data folder, where its database (`opencode*.db`) and logs are. */
const openCodeData = path.join(xdg.XDG_DATA_HOME, 'opencode');

/** Reads OpenCode's database: for each teammate, the lead's message to it, the models that answered after it, and its report in another session. */
function teamRuns(): Record<string, TeammateRun> {
	const file = fs.existsSync(openCodeData) ? fs.readdirSync(openCodeData).find(name => /^opencode.*\.db$/.test(name)) : undefined;
	if (!file) {
		return {};
	}
	const db = new DatabaseSync(path.join(openCodeData, file), { readOnly: true });
	try {
		const rows = db.prepare(`select s.title as title, m.type as type, m.data as data from session_message m join session_v2 s on s.id = m.session_id order by s.title, m.seq`).all() as { title: string; type: string; data: string }[];
		const runs: Record<string, { fromLead: boolean; answeredBy: string[]; reported: boolean }> = Object.fromEntries(TEAMMATES.map(name => [name, { fromLead: false, answeredBy: [], reported: false }]));
		for (const row of rows) {
			const data = JSON.parse(row.data) as { model?: { providerID?: string; id?: string }; time?: { completed?: number } };
			const texts = strings(data);
			const run = runs[row.title];
			if (!run) {
				for (const name of TEAMMATES.filter(name => texts.some(text => text.includes(`<agent-message from="${name}"`)))) {
					runs[name].reported = true;
				}
			} else if (texts.some(text => text.includes('<agent-message from="lead"'))) {
				run.fromLead = true;
			} else if (run.fromLead && row.type === 'assistant' && data.time?.completed && data.model) {
				run.answeredBy.push(`${data.model.providerID}/${data.model.id}`);
			}
		}
		return runs;
	} finally {
		db.close();
	}
}

/** The agents' names by OpenCode session, from the registry the agent extension keeps for the workspace. */
function hubNames(): Record<string, string> {
	const storage = path.join(userData, 'User', 'workspaceStorage');
	for (const folder of fs.existsSync(storage) ? fs.readdirSync(storage) : []) {
		const file = path.join(storage, folder, EXTENSION_ID, 'agents.json');
		if (fs.existsSync(file)) {
			const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { agents?: Record<string, { name: string }> };
			return Object.fromEntries(Object.entries(state.agents ?? {}).map(([id, agent]) => [id, agent.name]));
		}
	}
	return {};
}

/** What OpenCode's record shows for a session: who messaged it, and the models that answered after the first message. */
interface SessionRecord {
	readonly from: string[];
	readonly answeredBy: string[];
	/** What other agents told it, and which agent: the messages it got, and what its wait_agent calls returned. */
	readonly heard: { readonly from?: string; readonly text: string }[];
	/** The text of each of its answers. */
	readonly answers: string[];
	/** The text of its last answer. */
	said?: string;
}

/** Reads OpenCode's database for every session's record. */
function sessionRecords(database = openCodeDatabase()): Record<string, SessionRecord> {
	if (!database) {
		return {};
	}
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		const rows = db.prepare(`select session_id as session, type, data from session_message order by session_id, seq`).all() as { session: string; type: string; data: string }[];
		const records: Record<string, SessionRecord> = {};
		for (const row of rows) {
			const record = records[row.session] ??= { from: [], answeredBy: [], heard: [], answers: [] };
			const data = JSON.parse(row.data) as { model?: { providerID?: string; id?: string }; time?: { completed?: number }; content?: { type: string; text?: string; name?: string; state?: { input?: { agent?: string; to?: string }; content?: { text?: string }[] } }[] };
			if (row.type !== 'assistant') {
				for (const text of strings(data).filter(text => text.includes('<agent-message from="'))) {
					const from = text.match(/<agent-message from="(?<name>[^"]+)"/)!.groups!.name;
					record.heard.push({ from, text });
					if (!record.from.includes(from)) {
						record.from.push(from);
					}
				}
				continue;
			}
			if (record.from.length && data.time?.completed && data.model) {
				record.answeredBy.push(`${data.model.providerID}/${data.model.id}`);
			}
			const parts = data.content ?? [];
			for (const part of parts.filter(part => part.type === 'tool' && part.name === 'wait_agent')) {
				record.heard.push(...(part.state?.content ?? []).map(content => ({ from: part.state?.input?.agent ?? part.state?.input?.to, text: content.text ?? '' })));
			}
			const said = parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim();
			if (said) {
				record.said = said;
				record.answers.push(said);
			}
		}
		return records;
	} finally {
		db.close();
	}
}

/**
 * What each of `mates` told `leader`, as OpenCode's record shows it: every answer of its that reached
 * `leader`, not only its last. Two agents that had answered main went on to talk to each other, one
 * asking the other for the hero's name, and their last answers were to each other, not to main.
 */
function answersTo(leader: string, mates: readonly string[], records: Record<string, SessionRecord>, ids: Record<string, string>) {
	const empty: SessionRecord = { from: [], answeredBy: [], heard: [], answers: [] };
	const lead = records[ids[leader]] ?? empty;
	return {
		mates: Object.fromEntries(mates.map(mate => {
			const record = records[ids[mate]] ?? empty;
			const reached = record.answers.filter(answer => lead.heard.some(heard => heard.from === mate && heard.text.includes(answer)));
			return [mate, { from: record.from, answeredBy: record.answeredBy, said: record.said, reached }];
		})),
		mainSaid: lead.said,
	};
}

/**
 * The agents none of whose answers to the leader has a part in its report: a line of it, or a name it
 * quotes or puts in bold. One agent answered 'How about "Ignis" — short, punchy, and fire-themed…', and
 * main reported "Hero: Ignis". A part that is only a phrase of the user's message, such as a line of its
 * own ("The hero:") or the game's name, is not one, so a villain named only "Dragon" in Dragon Dash is
 * not found. A name in backticks is not one either: it is mostly a file's, which main can cite without
 * what the file says.
 */
function unreported(answers: ReturnType<typeof answersTo>, asked: string): string[] {
	const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
	const report = words(answers.mainSaid ?? '');
	// allow-any-unicode-next-line
	const parts = (answer: string) => [...answer.split('\n'), ...[...answer.matchAll(/["“*]+(?<name>[^"“”*\n]+)["”*]+/g)].map(match => match.groups!.name)]
		.map(words).filter(part => part.trim() && !words(asked).includes(part));
	return Object.entries(answers.mates).filter(([, mate]) => !mate.reached.some(answer => parts(answer).some(part => report.includes(part)))).map(([name]) => name);
}

/** What the user tells the side bar's chat in step 2: as a person would say it, with no names and no tool names. */
const NAMING = 'You are the team leader. The three agents I opened are your team, and you run them yourself by messaging them. We are making a tiny browser game called Dragon Dash: have one name the hero, one name the villain and one name the first level, each in one line. When they have all answered, tell me what the team came up with.';

/** What the game's page holds once its script has run: its canvases, and the rules of its style.css that style it. */
interface GamePage {
	readonly canvases: { readonly width: number; readonly height: number; readonly drawn: boolean }[];
	/** The selectors of style.css that match an element other than the page itself (html, body or `*`). */
	readonly styled: string[];
}

/**
 * Run in the game's page. A canvas is drawn on when it differs from a blank one of its size. The
 * style sheet's rules are read from the page, which may read its own file: style sheets.
 */
const GAME_PAGE = `(() => {
	const canvases = [...document.querySelectorAll('canvas')].map(canvas => {
		const blank = document.createElement('canvas');
		blank.width = canvas.width;
		blank.height = canvas.height;
		return { width: canvas.width, height: canvas.height, drawn: canvas.width > 0 && canvas.height > 0 && canvas.toDataURL() !== blank.toDataURL() };
	});
	const page = new Set([document.documentElement, document.body]);
	const sheet = [...document.styleSheets].find(sheet => sheet.href && sheet.href.endsWith('/style.css'));
	const selectors = sheet ? [...sheet.cssRules].map(rule => rule.selectorText).filter(selector => selector && !/^[*\\s,]*$/.test(selector)) : [];
	const styled = selectors.filter(selector => {
		try {
			return [...document.querySelectorAll(selector)].some(element => !page.has(element));
		} catch {
			return false;
		}
	});
	return { canvases, styled };
})()`;

/**
 * Reads OpenCode's database for the sessions that wrote each of `files`: with the write, edit or patch
 * tool, or a command that sends its output to the file.
 */
function writers(files: readonly string[]): Record<string, string[]> {
	const found: Record<string, string[]> = Object.fromEntries(files.map(name => [name, []]));
	const file = fs.existsSync(openCodeData) ? fs.readdirSync(openCodeData).find(name => /^opencode.*\.db$/.test(name)) : undefined;
	if (!file) {
		return found;
	}
	const db = new DatabaseSync(path.join(openCodeData, file), { readOnly: true });
	try {
		const rows = db.prepare(`select session_id as session, data from session_message where type = 'assistant' order by seq`).all() as { session: string; data: string }[];
		for (const row of rows) {
			const data = JSON.parse(row.data) as { content?: { type: string; name?: string; state?: { status?: string; input?: Record<string, unknown> } }[] };
			for (const part of data.content ?? []) {
				if (part.type !== 'tool' || part.state?.status !== 'completed') {
					continue;
				}
				const input = part.state.input ?? {};
				// The file a write or edit changes, not the files its content names, as a page names its script.
				const target = typeof input.path === 'string' ? input.path : typeof input.filePath === 'string' ? input.filePath : undefined;
				const command = part.name === 'shell' && typeof input.command === 'string' ? input.command : undefined;
				for (const name of files) {
					const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
					const wrote = part.name === 'write' || part.name === 'edit' ? !!target && path.basename(target) === name
						: part.name === 'patch' ? strings(input).some(text => new RegExp(`^\\*\\*\\* (?:Add|Update) File: .*\\b${escaped}$`, 'm').test(text))
							: !!command && new RegExp(`(?:>>?|\\btee\\s+(?:-a\\s+)?)\\s*['"]?[^\\s'"<>]*\\b${escaped}\\b`).test(command);
					if (wrote && !found[name].includes(row.session)) {
						found[name].push(row.session);
					}
				}
			}
		}
		return found;
	} finally {
		db.close();
	}
}

/** Files from the user's real home folder attached to a message an agent got, as OpenCode's database records them. */
function fromRealHome(database = openCodeDatabase()): string[] {
	if (!database) {
		return [];
	}
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		const prefix = `${pathToFileURL(os.homedir()).href}/`;
		const rows = db.prepare(`select data from session_message where type != 'assistant'`).all() as { data: string }[];
		return [...new Set(rows.flatMap(row => strings(JSON.parse(row.data)).filter(text => text.startsWith(prefix))))];
	} finally {
		db.close();
	}
}

/**
 * The sessions whose turn has not ended: a message to them, or their model's reply, came after
 * the last time they went idle. An agent working in a tab that is not shown has no response on
 * screen, so the window alone looked quiet while one answered main's second message.
 */
function busySessions(database = openCodeDatabase()): string[] {
	if (!database) {
		return [];
	}
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		const rows = db.prepare(`select session_id as session, type from session_message where type in ('user', 'synthetic', 'assistant', 'idle') order by session_id, seq`).all() as { session: string; type: string }[];
		const last = new Map(rows.map(row => [row.session, row.type]));
		return [...last].filter(([, type]) => type !== 'idle').map(([session]) => session);
	} finally {
		db.close();
	}
}

/** OpenCode's database file, once it has one. */
function openCodeDatabase(): string | undefined {
	const file = fs.existsSync(openCodeData) ? fs.readdirSync(openCodeData).find(name => /^opencode.*\.db$/.test(name)) : undefined;
	return file && path.join(openCodeData, file);
}

const INPUT = '.interactive-input-part .monaco-editor[role="code"]';
/** An approval card waiting for its answer. */
const PENDING = '.chat-question-carousel-container:has(.chat-question-submit-button)';
let app: ElectronApplication | undefined;
let failed = false;
try {
	const exe = executable();
	if (!fs.existsSync(exe.path)) {
		throw new Error(`Dragon IDE not found at ${exe.path}. Run \`npm run compile\` and \`npm run electron\` first, or pass --app.`);
	}
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
		// in OpenCode; the demo is about the free model a fresh install offers.
		env: Object.fromEntries(Object.entries({ ...process.env, ...exe.env, ...xdg, OPENCODE_TEST_HOME: temp, HOME: home, USERPROFILE: home })
			.filter((e): e is [string, string] => e[1] !== undefined && !/^(AWS_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AZURE_|OPENROUTER_|GROQ_|MISTRAL_|XAI_|DEEPSEEK_|GITHUB_TOKEN$|GH_TOKEN$)/.test(e[0]))),
		timeout: STEP_TIMEOUT,
	});
	const win = await app.firstWindow({ timeout: STEP_TIMEOUT });
	await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => undefined);
	// The lead is the chat in the side bar.
	const main = win.locator('.part.auxiliarybar, .part.panel, .part.sidebar').filter({ has: win.locator(INPUT) }).first();
	const picker = (scope: Locator) => scope.locator('.interactive-input-part .chat-input-toolbars');
	/** The editor group whose active tab is `name`'s chat. */
	const pane = (name: string) => win.locator('.editor-group-container').filter({ has: win.locator('.tab.active', { hasText: name }) }).first();

	async function runCommand(label: string): Promise<void> {
		await win.keyboard.press('F1');
		const input = win.locator('.quick-input-widget input.input');
		await input.waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await input.fill(`>${label}`);
		await win.locator('.quick-input-widget .monaco-list-row').filter({ hasText: label }).first().click({ timeout: STEP_TIMEOUT });
	}
	/** What a chat's input holds. */
	const typed = async (scope: Locator) => (await scope.locator(`${INPUT} .view-lines`).innerText()).replace(/\s+/g, ' ').trim();
	/**
	 * Sends a message or a slash command (whose suggestions take the first Enter): presses Enter until
	 * the input is empty, so it went, and waits for a request with `shown`. The list draws only the
	 * rows in view, so counting them would not say a new one came.
	 */
	const send = async (scope: Locator, text: string, shown = text) => {
		await scope.locator(INPUT).click();
		await win.keyboard.insertText(text);
		// The editor draws what was typed on a later frame, and until then its input reads as empty.
		await until(async () => !!await typed(scope), async () => `${text.split(' ')[0]} never showed in the chat's input`);
		for (let attempt = 0; await typed(scope); attempt++) {
			if (attempt === 3) {
				throw new Error(`${text.split(' ')[0]} was not sent`);
			}
			await win.keyboard.press('Enter');
			await win.waitForTimeout(1000);
		}
		await scope.locator(REQUEST, { hasText: shown }).last().waitFor({ state: 'attached', timeout: STEP_TIMEOUT });
	};
	/** The text of the reply to the last request holding `request`. */
	const reply = (scope: Locator, request: string) => scope.evaluate((element, { request, ROW }) => {
		// Not the copy of a request that sticks to the top of the list as its reply scrolls by: it comes after the list's rows.
		const items = [...element.querySelectorAll<HTMLElement>(ROW)];
		const index = items.findLastIndex(item => item.classList.contains('interactive-request') && item.textContent?.includes(request));
		return (index < 0 ? undefined : items.slice(index + 1).find(item => item.classList.contains('interactive-response')))?.innerText.replace(/\s+/g, ' ') ?? '';
	}, { request, ROW });
	/** Waits until no chat in the window is working, for a few seconds running, as the team settles. */
	const settled = async (timeout: number) => {
		let quietSince = Date.now();
		await until(async () => {
			if (busySessions().length || await win.locator('.interactive-item-container.interactive-response.chat-response-loading').count()) {
				quietSince = Date.now();
			}
			return Date.now() - quietSince > 8_000;
		}, () => `the team was still working: ${JSON.stringify(busySessions())}`, timeout);
	};
	const describeRuns = () => JSON.stringify(teamRuns());
	/** What `name`'s pane shows: the message from `sender` as a request, the model, and a question card left open. */
	const shownIn = async (name: string, sender = 'lead') => {
		const scope = pane(name);
		// The list draws only the rows in view, and the lead's first message is at the top. A chat
		// that is still working scrolls to its end as it goes, so this scrolls up again a few times.
		let fromLead = false;
		for (let attempt = 0; attempt < 5 && !fromLead; attempt++) {
			await scope.locator('.interactive-list').first().hover({ timeout: 5_000 }).catch(() => undefined);
			for (let i = 0; i < 10; i++) {
				await win.mouse.wheel(0, -5_000);
			}
			fromLead = await scope.locator('.interactive-item-container.interactive-request', { hasText: `From ${sender}` }).first().waitFor({ state: 'attached', timeout: 5_000 }).then(() => true, () => false);
		}
		const picked = (await picker(scope).innerText().catch(() => '')).includes(MODEL.name);
		const asking = await scope.locator('[aria-roledescription="chat question"]:not(.chat-question-carousel-used)').count() > 0;
		return { name, fromLead, picker: picked, asking };
	};
	/**
	 * The approvals the window shows, each answered Allow once: in a notification (an agent's chat that is not on
	 * screen asks in one) or a chat on screen.
	 */
	const approveShown = async (): Promise<string[]> => {
		const answered: string[] = [];
		for (const toast of await win.locator('.notifications-toasts .notification-toast', { hasText: ' asks: ' }).all()) {
			const text = (await toast.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
			if (await toast.getByRole('button', { name: 'Allow Once' }).click({ timeout: 2_000 }).then(() => true, () => false)) {
				answered.push(`a notification: ${text.slice(0, 160)}`);
			}
		}
		for (const card of await win.locator(PENDING).all()) {
			if (!await card.isVisible().catch(() => false)) {
				continue;
			}
			const where = await card.evaluate(element => element.closest('.part.auxiliarybar') ? 'main' : element.closest('.editor-group-container')?.querySelector('.tab.active .label-name')?.textContent?.trim() ?? 'a chat');
			const text = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
			// A question to the user is not an approval: the step after says when one is left open.
			if (!text.includes('Allow once')) {
				continue;
			}
			await card.locator('.chat-question-list-item', { hasText: 'Allow once' }).first().click({ timeout: 2_000 }).catch(() => undefined);
			const submit = card.locator('.chat-question-submit-button');
			if (await submit.isVisible().catch(() => false)) {
				await submit.click({ timeout: 2_000 }).catch(() => undefined);
			}
			answered.push(`${where}'s chat: ${text.slice(0, 160)}`);
		}
		return answered;
	};
	/**
	 * In Ask mode, answers the team's approvals as a user who talks only to main: those the window shows,
	 * and, when the team has waited a minute with none on screen, those in each agent's tab, opened in turn
	 * as that user would to look for what holds the team up.
	 */
	const approver = (mates: readonly string[]) => {
		const shown: string[] = [];
		const hidden: string[] = [];
		let stopped = false;
		const running = (async () => {
			let quietSince = Date.now();
			// A failed step closes the window, and with it this.
			while (!stopped && !win.isClosed()) {
				const answered = await approveShown();
				shown.push(...answered);
				if (answered.length) {
					quietSince = Date.now();
				} else if (Date.now() - quietSince > 60_000 && busySessions().length) {
					for (const mate of mates) {
						await win.locator('.editor-group-container .tab').filter({ has: win.locator('.label-name', { hasText: new RegExp(`^${mate}$`) }) }).first().click({ timeout: 5_000 }).catch(() => undefined);
						await new Promise(resolve => setTimeout(resolve, 1_500));
						hidden.push(...(await approveShown()).map(text => `after opening ${mate}'s tab, ${text}`));
					}
					quietSince = Date.now();
				}
				await new Promise(resolve => setTimeout(resolve, 2_000));
			}
		})().catch(err => console.log(`      the approver stopped: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`));
		return {
			/** Stops answering, and says what it answered, whether or not the step failed. */
			async stop(): Promise<void> {
				stopped = true;
				await running;
				console.log(`      approvals: ${shown.length} on screen, ${hidden.length} only in an agent's tab: ${JSON.stringify([...shown, ...hidden])}`);
			},
			/** Fails when an approval showed only in a tab the user had to open. */
			allSeen(): void {
				if (hidden.length) {
					throw new Error(`the user, talking only to main, did not see ${hidden.length} approval(s) the team waited on: ${JSON.stringify(hidden)}`);
				}
			},
		};
	};

	await step(win, 'the chat starts on the free Nemotron model, without an account', async () => {
		// A fresh profile starts on the one-button entrance.
		await win.waitForSelector('.dragon-onboarding[role=dialog]', { state: 'visible', timeout: STEP_TIMEOUT });
		await win.getByRole('button', { name: 'Enter FREEDOM AI', exact: true }).click();
		await win.waitForSelector('.dragon-onboarding', { state: 'detached', timeout: STEP_TIMEOUT });
		await runCommand('Chat: Open Chat');
		await main.locator(INPUT).waitFor({ state: 'visible', timeout: STEP_TIMEOUT });
		await picker(main).getByText(MODEL.name, { exact: true }).waitFor({ state: 'visible', timeout: STEP_TIMEOUT }).catch(async err => {
			throw new Error(`the model picker shows ${JSON.stringify((await picker(main).innerText().catch(() => '')).replace(/\s+/g, ' ').trim())}, not ${MODEL.name}`, { cause: err });
		});
		await shot(win, 'nemotron');
	});

	// The side bar's chat is the one the user talks to: the others hear from "main".
	const leader = 'main';
	const ids = () => Object.fromEntries(Object.entries(hubNames()).map(([id, name]) => [name, id]));
	const opened = await step(win, 'the user opens three agents with New Agent and tells the side bar\'s chat it leads them: "main" messages each, each runs a Nemotron turn in its tab, every answer reaches main, and main reports them all', async () => {
		const title = win.locator('.part.auxiliarybar .composite.title');
		const tabNames = async () => (await win.locator('.editor-group-container .tab .label-name').allInnerTexts()).map(name => name.trim());
		const activeChip = win.locator('.editor-group-container.active .interactive-input-part .dragon-messaging-toggle');
		for (let opened = 1; opened <= 3; opened++) {
			await title.getByRole('button', { name: 'New Agent', exact: true }).click({ timeout: STEP_TIMEOUT });
			await until(async () => (await tabNames()).length === opened, async () => `after New Agent ${opened} time(s) the tabs read ${JSON.stringify(await tabNames())}`);
			// Its messaging is on, and the chip names it from the start, not at its next refresh (3 s):
			// the editor keeps its composer when it shows the new chat.
			const name = (await win.locator('.editor-group-container.active .tab.active .label-name').innerText()).trim();
			await activeChip.and(win.locator('.dragon-messaging-on')).filter({ hasText: new RegExp(`^\\W*${name}$`) }).waitFor({ state: 'visible', timeout: 1_500 }).catch(async err => {
				throw new Error(`New Agent ${opened}'s Messages chip is ${await activeChip.getAttribute('class').catch(() => 'missing')} and reads ${JSON.stringify(await activeChip.innerText().catch(() => ''))}, not ${name}`, { cause: err });
			});
		}
		const mates = await tabNames();
		await shot(win, 'three-agents');
		const progress = () => ({ names: Object.values(hubNames()), ...answersTo(leader, mates, sessionRecords(), ids()) });
		const done = () => {
			const now = progress();
			return mates.every(mate => now.mates[mate].from.includes(leader) && now.mates[mate].answeredBy.includes(`${MODEL.providerID}/${MODEL.id}`) && now.mates[mate].reached.length > 0);
		};
		const approvals = args.ask ? approver(mates) : undefined;
		try {
			await send(main, NAMING, 'Dragon Dash');
			await until(done, () => `main did not run every agent it was given, or not every answer reached it: ${JSON.stringify(progress())}`, MODEL_TIMEOUT);
			// The user's own instruction files stay on their machine: the free model is someone else's.
			const leaked = fromRealHome();
			if (leaked.length) {
				throw new Error(`files from the user's home folder reached the model: ${JSON.stringify(leaked)}`);
			}
			await settled(MODEL_TIMEOUT).catch(() => undefined);
		} finally {
			await approvals?.stop();
		}
		approvals?.allSeen();
		// Main reports what each agent came up with, as the user asked, in its own words around them.
		const final = progress();
		const left = unreported(final, NAMING);
		if (left.length) {
			throw new Error(`main's report leaves out what ${left.join(', ')} came up with: ${JSON.stringify(final)}`);
		}
		const panes = [];
		for (const mate of mates) {
			await win.locator('.editor-group-container .tab', { hasText: mate }).first().click();
			panes.push(await shownIn(mate, leader));
		}
		const shownWrong = panes.filter(shown => !shown.fromLead || !shown.picker || shown.asking);
		if (shownWrong.length) {
			throw new Error(`an agent's tab does not show the leader's message on ${MODEL.name}, or waits on a question to the user: ${JSON.stringify(shownWrong)}`);
		}
		const said = await main.evaluate(element => [...element.querySelectorAll<HTMLElement>('.interactive-item-container.interactive-response')].at(-1)?.innerText.replace(/\s+/g, ' ').trim() ?? '');
		console.log(`      OpenCode's record: ${JSON.stringify(progress())}`);
		console.log(`      main's last words as the chat shows them: ${JSON.stringify(said.slice(0, 600))}`);
		await shot(win, 'leader-ran-the-team');
		return mates;
	});

	await step(win, 'main has the three agents build the game, each writing its own file in the folder they share, and the game loads and draws', async () => {
		const mates = opened ?? [];
		const files = ['index.html', 'style.css', 'game.js'];
		const progress = () => {
			const names = hubNames();
			const by = writers(files);
			return Object.fromEntries(files.map(file => [file, { exists: fs.existsSync(path.join(workspace, file)), by: by[file].map(id => names[id] ?? id) }]));
		};
		const approvals = args.ask ? approver(mates) : undefined;
		try {
			// As a person would say it, after the names came back.
			await send(main, 'Great. Now have the team build Dragon Dash in this folder as a small canvas game where the hero dodges the villain: one agent writes index.html, one writes style.css and one writes game.js, each only its own file. When they are done, check that index.html loads style.css and game.js, and tell me when the game is ready.', 'canvas game');
			await until(() => {
				const now = progress();
				return files.every(file => now[file].exists && now[file].by.some(name => mates.includes(name)));
			}, () => `the agents did not write every file of the game: ${JSON.stringify(progress())}`, MODEL_TIMEOUT);
			await settled(MODEL_TIMEOUT).catch(() => undefined);
		} finally {
			await approvals?.stop();
		}
		approvals?.allSeen();
		const built = progress();
		// As the user asked: one file each, which no other agent writes. An agent that wrote all three
		// first left the others to overwrite its guesses.
		const wrote = Object.fromEntries(mates.map(mate => [mate, files.filter(file => built[file].by.includes(mate))]));
		if (mates.some(mate => wrote[mate].length !== 1) || files.some(file => built[file].by.filter(name => mates.includes(name)).length !== 1)) {
			throw new Error(`the agents did not each write one file of their own: ${JSON.stringify(wrote)}`);
		}
		// main runs the team: a part that needs fixing goes back to its agent. One main that found its own
		// instructions had the script written into index.html wrote all three files over the agents'.
		const byLeader = files.filter(file => built[file].by.includes(leader));
		if (byLeader.length) {
			throw new Error(`main wrote ${byLeader.join(', ')} itself instead of having its agent change it: ${JSON.stringify(built)}`);
		}
		// The game as a player would open it: in a window of its own, whose page loads the agents' style
		// and script and draws on a canvas without errors. The window's session is its own, as the
		// workbench's refuses file: URLs.
		const played = await app!.evaluate(async ({ BrowserWindow }, { file, script }) => {
			const game = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, partition: 'dragon-smoke-game' } });
			const errors: string[] = [];
			const loaded: string[] = [];
			// A script or style sheet that is not found does not say so in the console.
			game.webContents.session.webRequest.onCompleted((details: { url: string }) => loaded.push(details.url));
			game.webContents.session.webRequest.onErrorOccurred((details: { url: string; error: string }) => errors.push(`${details.url}: ${details.error}`));
			// Electron passes the details of a console message, an uncaught error among them, in one object.
			game.webContents.on('console-message', (details: { level: string; message: string }) => {
				if (details.level === 'error') {
					errors.push(details.message);
				}
			});
			game.webContents.on('did-fail-load', (_event: unknown, _code: number, description: string, url: string) => errors.push(`${url}: ${description}`));
			try {
				await game.loadFile(file);
				// A game can end within the wait, and clear its canvas, if nobody plays it: one whose villain starts
				// in the hero's row did, in 1.8 s, at this Mac's 120 frames a second. So the canvas counts as drawn
				// on when it was at any of the looks taken from load to the end of the wait.
				const pages: GamePage[] = [];
				for (const started = Date.now(); !pages.length || Date.now() - started < 2_000;) {
					pages.push(await game.webContents.executeJavaScript(script) as GamePage);
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				const last = pages[pages.length - 1];
				const page = { ...last, canvases: last.canvases.map((canvas, i) => ({ ...canvas, drawn: pages.some(look => look.canvases[i]?.drawn) })) };
				return { errors, page, loaded: loaded.map(url => decodeURIComponent(new URL(url).pathname)) };
			} finally {
				game.destroy();
			}
		}, { file: path.join(workspace, 'index.html'), script: GAME_PAGE });
		const unloaded = ['style.css', 'game.js'].filter(file => !played.loaded.some(loaded => loaded.endsWith(`/${path.basename(workspace)}/${file}`)));
		// The three files make one game: the script draws on the page's one canvas, not a second canvas of
		// its own under the page's empty one, and the style sheet styles the page, not a page it guessed.
		const { canvases, styled } = played.page;
		if (unloaded.length || played.errors.length || canvases.length !== 1 || !canvases[0].drawn || !styled.length) {
			const files = Object.fromEntries(['index.html', 'style.css'].map(file => [file, fs.readFileSync(path.join(workspace, file), 'utf8').slice(0, 600)]));
			throw new Error(`the agents' files do not make one game: ${JSON.stringify(played)}; ${JSON.stringify(files)}`);
		}
		const said = sessionRecords()[ids()[leader]]?.said ?? '';
		console.log(`      who wrote what: ${JSON.stringify(built)}; the game drew on a ${canvases[0].width}x${canvases[0].height} canvas, styled by ${JSON.stringify(styled)}`);
		console.log(`      main's last words: ${JSON.stringify(said.slice(0, 600))}`);
		// The user reads main's report, not the files. When the free model's endpoint cut off main's
		// reply one word in, OpenCode had it continue, and the report the user got was one other word.
		const unnamed = files.filter(file => !said.includes(file));
		if (unnamed.length) {
			throw new Error(`main's report to the user does not name ${unnamed.join(', ')}`);
		}
		await shot(win, 'team-built-the-game');
		// The next step starts a team in a chat of its own.
		await runCommand('View: Close All Editors');
		// Dragon's plus in the chat's title is New Agent; New Chat is its key in the chat's input.
		await main.locator(INPUT).click();
		await win.keyboard.press('ControlOrMeta+N');
		await until(async () => !await main.locator('.interactive-item-container').count(), () => 'New Chat did not empty the chat');
	});

	const task = 'We are making a tiny browser game called Dragon Dash. Hand out the work now: call send_message once for each of teammate-1, teammate-2, teammate-3 and teammate-4. teammate-1 names the hero, teammate-2 names the villain, teammate-3 names the first level, and teammate-4 writes a one-line tagline. Tell each to answer you in one line. Do not do these tasks yourself.';
	await step(win, '/team 4 starts four teammates, the lead hands each a task, and each runs a Nemotron turn from the lead\'s message', async () => {
		await send(main, `/team 4 ${task}`, 'Dragon Dash');
		await until(async () => (await reply(main, 'Dragon Dash')).includes('This chat leads the team'), async () => `the reply to /team says ${JSON.stringify((await reply(main, 'Dragon Dash')).slice(0, 400))}`);
		const missing = () => TEAMMATES.filter(name => !teamRuns()[name]?.fromLead);
		const done = () => TEAMMATES.every(name => teamRuns()[name]?.answeredBy.includes(`${MODEL.providerID}/${MODEL.id}`));
		// A small model may leave someone out; a person would remind it once.
		await settled(MODEL_TIMEOUT).catch(() => undefined);
		let reminded: string[] = [];
		if (missing().length) {
			reminded = missing();
			await send(main, `Use send_message now to give ${reminded.join(', ')} their tasks.`, 'their tasks.');
		}
		await until(done, () => `not every teammate ran a ${MODEL.id} turn from the lead's message: ${describeRuns()}`, MODEL_TIMEOUT);
		// Teammates may still be reporting; their panes are read once the team is quiet.
		await settled(MODEL_TIMEOUT).catch(() => undefined);
		const panes = [];
		for (const name of TEAMMATES) {
			panes.push(await shownIn(name));
		}
		const shownWrong = panes.filter(shown => !shown.fromLead || !shown.picker || shown.asking);
		if (shownWrong.length) {
			throw new Error(`a teammate's pane does not show the lead's message on ${MODEL.name}, or waits on a question to the user: ${JSON.stringify(shownWrong)}`);
		}
		console.log(`      ${reminded.length ? `the lead was reminded once about ${reminded.join(', ')}` : 'the lead handed out every task without a reminder'}; OpenCode's record: ${describeRuns()}`);
		await settled(MODEL_TIMEOUT).catch(() => undefined);
		await shot(win, 'team');
	});

	await step(win, '/compact in the lead\'s chat shows the summary and how much it saved', async () => {
		await send(main, '/compact');
		await until(async () => /Compacted the conversation: \S+ tokens of history became a \S+-token summary\./.test(await reply(main, '/compact')), async () => `the reply to /compact says ${JSON.stringify((await reply(main, '/compact')).slice(0, 600))}`, MODEL_TIMEOUT);
		const shown = await reply(main, '/compact');
		if (shown.includes('finished without a reply')) {
			throw new Error(`the compaction does not show its summary: ${JSON.stringify(shown.slice(0, 600))}`);
		}
		await shot(win, 'compacted');
	});

	const screen = win.locator('.terminal-editor .xterm-rows').first();
	const drawn = async () => (await screen.innerText({ timeout: 500 }).catch(() => '')).replace(/\s+/g, ' ');
	await step(win, 'Open OpenCode TUI opens the terminal UI on this window\'s server, and it draws its prompt', async () => {
		await runCommand('Open OpenCode TUI');
		await until(async () => (await drawn()).includes('Ask anything'), async () => `the terminal UI drew ${JSON.stringify((await drawn()).slice(0, 600))}`);
		await shot(win, 'tui');
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
	const openCodeLogs = path.join(openCodeData, 'log');
	if (fs.existsSync(openCodeLogs)) {
		fs.cpSync(openCodeLogs, path.join(out, 'opencode-logs'), { recursive: true });
	}
	// The team's sessions, to look into what each agent was sent and did (the profile has no credentials).
	for (const name of fs.existsSync(openCodeData) ? fs.readdirSync(openCodeData).filter(name => /^opencode.*\.db(-wal|-shm)?$/.test(name)) : []) {
		fs.mkdirSync(path.join(out, 'opencode-data'), { recursive: true });
		fs.copyFileSync(path.join(openCodeData, name), path.join(out, 'opencode-data', name));
	}
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
console.log(failed ? 'Team demo smoke test failed.' : 'Team demo smoke test passed.');
console.log(`Screenshots and logs: ${out}`);
process.exitCode = failed ? 1 : 0;
