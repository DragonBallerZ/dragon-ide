/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A Git worktree made for one agent. */
export interface AgentWorktree {
	/** The agent's name, and the last part of its branch and folder. */
	readonly name: string;
	/** `dragon/<name>`, created at the repository's current commit. */
	readonly branch: string;
	/** The worktree's root folder. */
	readonly root: string;
	/** The folder inside the worktree that matches the one the agent was asked to work in. */
	readonly directory: string;
	/** The root of the repository's main working tree. */
	readonly repository: string;
}

function git(cwd: string, ...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()));
	});
}

/**
 * Makes a worktree of the repository that holds `directory`, on a new branch at its current commit,
 * in a folder of its own under `home`. Resolves to undefined when `directory` is not in a Git
 * repository with a commit, or Git is not installed. Changes that are not committed stay behind
 * in the main working tree.
 */
export async function createAgentWorktree(directory: string, home: string): Promise<AgentWorktree | undefined> {
	let repository: string;
	try {
		repository = await git(directory, 'rev-parse', '--show-toplevel');
		await git(repository, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
	} catch {
		return undefined;
	}
	// Two repositories with the same folder name must not share worktree folders.
	const parent = path.join(home, `${path.basename(repository)}-${createHash('sha1').update(repository).digest('hex').slice(0, 8)}`);
	const branches = new Set((await git(repository, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/dragon')).split('\n'));
	let number = 1;
	while (branches.has(`dragon/agent-${number}`) || fs.existsSync(path.join(parent, `agent-${number}`))) {
		number++;
	}
	const name = `agent-${number}`;
	const branch = `dragon/${name}`;
	const root = path.join(parent, name);
	await fs.promises.mkdir(parent, { recursive: true });
	await git(repository, 'worktree', 'add', '-b', branch, root, 'HEAD');
	// Git reports the repository's real path, which a symlinked `directory` is not under.
	const inside = path.relative(await fs.promises.realpath(repository), await fs.promises.realpath(directory));
	return { name, branch, root, directory: path.join(root, inside), repository };
}
