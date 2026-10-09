/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Checks that an `opencode` binary's terminal UI starts, as signed: it serves on a free port, the
// terminal UI attaches in a pseudo-terminal, and it must draw its prompt and keep running. A binary
// signed with the hardened runtime but not allowed to load libraries signed by others fails here,
// as OpenCode's terminal UI did in Dragon IDE 1.1.5 and earlier.
//
// Usage: node scripts/dragon/check-opencode-tui.mts <opencode binary>   (macOS)

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const binary = process.argv[2] && path.resolve(process.argv[2]);
if (process.platform !== 'darwin' || !binary || !fs.existsSync(binary)) {
	throw new Error('Usage: node scripts/dragon/check-opencode-tui.mts <opencode binary> (macOS)');
}
const TIMEOUT = 60_000;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dragon-tui-check-'));
// OpenCode keeps its data and config under the XDG directories; keep them out of the user's.
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_PASSWORD: 'check', OPENCODE_DISABLE_AUTOUPDATE: '1', TERM: 'xterm-256color' };
for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
	env[name] = path.join(temp, name.toLowerCase());
}
const work = path.join(temp, 'work');
fs.mkdirSync(work);
const screen = path.join(temp, 'screen.txt');
/** What the terminal UI drew, without escape sequences. */
const drawn = () => fs.existsSync(screen) ? fs.readFileSync(screen, 'utf8').replace(/\x1b\[[0-9;?<>=$]*[a-zA-Z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()][A-Z0-9]?/g, '') : '';

const children: ChildProcess[] = [];
let failure: string | undefined;
try {
	const server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(server);
	const url = await new Promise<string>((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error(`the server did not start: ${output.trim().slice(0, 400)}`)), TIMEOUT);
		const read = (chunk: Buffer) => {
			output += chunk.toString();
			const listening = /listening on (?<url>http:\/\/\S+)/.exec(output)?.groups?.url;
			if (listening) {
				clearTimeout(timer);
				resolve(listening);
			}
		};
		server.stdout.on('data', read);
		server.stderr.on('data', read);
		server.on('exit', code => reject(new Error(`the server exited with ${code}: ${output.trim().slice(0, 400)}`)));
	});
	// `script` gives the terminal UI a pseudo-terminal and records what it draws. Its input is a pipe
	// that stays open: at the end of its input `script` would type Ctrl+D into the terminal UI.
	const tui = spawn('/bin/bash', ['-c', 'exec script -q "$0" "$1" --server "$2" < <(sleep 3600)', screen, binary, url], { cwd: work, env, stdio: 'ignore', detached: true });
	children.push(tui);
	let exited: number | null | undefined;
	tui.on('exit', code => { exited = code; });
	for (const end = Date.now() + TIMEOUT; !drawn().includes('Ask anything');) {
		if (exited !== undefined || Date.now() > end) {
			const said = drawn().split('\n').map(line => line.trim()).find(line => line.startsWith('Error')) ?? drawn().trim().slice(0, 400);
			throw new Error(`OpenCode's terminal UI ${exited !== undefined ? `exited with ${exited}` : 'drew no prompt'}: ${said.slice(0, 600)}`);
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	// Drawn once is not running: it must still be up a moment later.
	await new Promise(resolve => setTimeout(resolve, 2000));
	if (exited !== undefined) {
		throw new Error(`OpenCode's terminal UI drew its prompt and then exited with ${exited}`);
	}
} catch (err) {
	failure = err instanceof Error ? err.message : String(err);
} finally {
	// `script` runs the terminal UI in a session of its own, so it is ended first, by its parent.
	if (children[1]?.pid) {
		spawnSync('pkill', ['-KILL', '-P', String(children[1].pid)]);
	}
	for (const child of children) {
		try {
			// `script` runs in a process group of its own with `sleep`.
			process.kill(child === children[1] ? -child.pid! : child.pid!, 'SIGKILL');
		} catch {
			// Already gone.
		}
	}
	fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}
if (failure) {
	console.error(`FAIL  ${binary}: ${failure}`);
	process.exit(1);
}
console.log(`PASS  OpenCode's terminal UI starts and draws its prompt: ${binary}`);
