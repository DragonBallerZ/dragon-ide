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
		execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => err ? reject(new Error(stderr.trim() || stdout.trim() || err.message)) : resolve(stdout.trim()));
	});
}

/** The folder under `home` that New Agent makes the worktrees of `repository` in. */
function worktreesParent(repository: string, home: string): string {
	// Two repositories with the same folder name must not share worktree folders.
	return path.join(home, `${path.basename(repository)}-${createHash('sha1').update(repository).digest('hex').slice(0, 8)}`);
}

/**
 * The folder under `home` that New Agent makes worktrees of the repository holding `directory` in,
 * whether or not it has made any; undefined outside a Git repository or without Git.
 */
export async function agentWorktreesFolder(directory: string, home: string): Promise<string | undefined> {
	try {
		return worktreesParent(await git(directory, 'rev-parse', '--show-toplevel'), home);
	} catch {
		return undefined;
	}
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
	const parent = worktreesParent(repository, home);
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

/** A worktree that New Agent made, as Git lists it now. */
export interface ListedAgentWorktree {
	readonly name: string;
	readonly branch: string;
	readonly root: string;
	/** The repository's main working tree, which the agent's work is merged into. */
	readonly repository: string;
	/** The branch checked out in the main working tree; undefined when its HEAD is detached. */
	readonly target: string | undefined;
	/** Commits on the agent's branch that the main working tree's HEAD does not have. */
	readonly ahead: number;
	/** Whether the worktree holds changes that are not committed. */
	readonly dirty: boolean;
}

/** The agent worktrees of the repository that holds `directory`: those on a `dragon/agent-N` branch. */
export async function listAgentWorktrees(directory: string): Promise<ListedAgentWorktree[]> {
	let listing: string;
	try {
		listing = await git(directory, 'worktree', 'list', '--porcelain');
	} catch {
		return [];
	}
	// Git lists the main working tree first.
	const entries = listing.split('\n\n').map(entry => ({
		root: /^worktree (?<root>.+)$/m.exec(entry)?.groups?.root,
		branch: /^branch refs\/heads\/(?<branch>.+)$/m.exec(entry)?.groups?.branch,
	}));
	const repository = entries[0]?.root;
	if (!repository) {
		return [];
	}
	const listed: ListedAgentWorktree[] = [];
	for (const entry of entries.slice(1)) {
		const name = /^dragon\/(?<name>agent-\d+)$/.exec(entry.branch ?? '')?.groups?.name;
		if (!name || !entry.root || !entry.branch || !fs.existsSync(entry.root)) {
			continue;
		}
		listed.push({
			name, branch: entry.branch, root: entry.root, repository, target: entries[0].branch,
			ahead: Number(await git(repository, 'rev-list', '--count', `HEAD..${entry.branch}`)),
			dirty: (await git(entry.root, 'status', '--porcelain')).length > 0,
		});
	}
	return listed;
}

/**
 * Brings an agent's work into the main working tree and removes its worktree and branch: commits what
 * the agent left uncommitted, merges its branch into the branch checked out in the main working tree,
 * then removes the worktree and deletes the branch. If the merge does not go through (a conflict, or
 * changes in the main working tree that it would overwrite), it is undone and the worktree is kept.
 * Resolves to the number of commits merged.
 */
export async function mergeAgentWorktree(worktree: Pick<ListedAgentWorktree, 'name' | 'branch' | 'root' | 'repository'>): Promise<number> {
	if ((await git(worktree.root, 'status', '--porcelain')).length > 0) {
		await git(worktree.root, 'add', '-A');
		await git(worktree.root, 'commit', '--quiet', '-m', `${worktree.name}: work from a Dragon agent`);
	}
	const merged = Number(await git(worktree.repository, 'rev-list', '--count', `HEAD..${worktree.branch}`));
	if (merged > 0) {
		try {
			await git(worktree.repository, 'merge', '--no-edit', '--quiet', worktree.branch);
		} catch (err) {
			// Only a merge that started leaves something to undo.
			await git(worktree.repository, 'merge', '--abort').catch(() => undefined);
			throw err;
		}
	}
	// What is left in the worktree is ignored files (build output, dependencies): nothing Git tracks.
	await git(worktree.repository, 'worktree', 'remove', '--force', worktree.root);
	await git(worktree.repository, 'branch', '-d', worktree.branch);
	return merged;
}
