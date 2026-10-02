/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/** Directories never worth indexing even if a repository forgets to ignore them. */
export const ALWAYS_SKIPPED = ['.git', 'node_modules', '.hg', '.svn', '.dragon-ide'];

/** Candidate ripgrep binaries: an explicit path, VS Code's bundled copy, then PATH. */
export function findRipgrep(options: { explicit?: string; appRoot?: string; platform?: NodeJS.Platform; arch?: string; env?: NodeJS.ProcessEnv }): string | undefined {
	const platform = options.platform ?? process.platform;
	const exe = platform === 'win32' ? 'rg.exe' : 'rg';
	const candidates: string[] = [];
	if (options.explicit) {
		candidates.push(options.explicit);
	}
	if (options.appRoot) {
		const sub = path.join('@vscode', 'ripgrep-universal', 'bin', `${platform}-${options.arch ?? process.arch}`, exe);
		candidates.push(path.join(options.appRoot, 'node_modules.asar.unpacked', sub), path.join(options.appRoot, 'node_modules', sub));
	}
	const env = options.env ?? process.env;
	for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(dir, exe));
	}
	return candidates.find(c => existsSync(c));
}

export interface RgResult {
	readonly stdout: string;
	readonly code: number | null;
}

/** Runs ripgrep and collects stdout. Exit code 1 means "no matches", not an error. */
export function runRipgrep(rg: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RgResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(rg, args, { cwd, signal, windowsHide: true });
		const chunks: Buffer[] = [];
		let stderr = '';
		child.stdout.on('data', (b: Buffer) => chunks.push(b));
		child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
		child.on('error', reject);
		child.on('close', code => {
			if (code !== 0 && code !== 1 && !chunks.length) {
				reject(new Error(stderr.trim() || `ripgrep exited with ${code}`));
				return;
			}
			resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code });
		});
	});
}

/** Lists searchable files the way OpenCode's grep sees them: honours .gitignore, includes hidden files. */
export async function listFiles(rg: string, root: string, signal?: AbortSignal): Promise<string[]> {
	const args = ['--files', '--hidden', '--no-messages', ...ALWAYS_SKIPPED.flatMap(d => ['-g', `!**/${d}/**`])];
	const { stdout } = await runRipgrep(rg, args, root, signal);
	return stdout.split('\n').filter(Boolean).map(p => p.replace(/\\/g, '/'));
}

/**
 * Streams ripgrep's stdout line by line. `onLine` returns false to stop early, which kills the
 * process: enough results were collected.
 */
export function streamRipgrep(rg: string, args: string[], cwd: string, onLine: (line: string) => boolean, signal?: AbortSignal): Promise<{ stopped: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(rg, args, { cwd, signal, windowsHide: true });
		let buffer = '';
		let stopped = false;
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (stopped) {
				return;
			}
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!onLine(line)) {
					stopped = true;
					child.kill();
					return;
				}
			}
		});
		child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
		child.on('error', err => stopped ? resolve({ stopped }) : reject(err));
		child.on('close', code => {
			if (!stopped && buffer) {
				onLine(buffer);
			}
			// Exit code 2 with nothing on stderr means only errors hidden by --no-messages occurred, such
			// as a candidate deleted since it was reported changed: the results for every other file stand.
			if (!stopped && code !== 0 && code !== 1 && (code !== 2 || stderr.trim())) {
				reject(new Error(stderr.trim() || `ripgrep exited with ${code}`));
				return;
			}
			resolve({ stopped });
		});
	});
}
