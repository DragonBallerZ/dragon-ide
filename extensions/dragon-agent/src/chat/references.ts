/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { outsideFolders } from '../sandbox/sandbox';

/** The id prefixes VS Code gives instruction files it attaches to a request (`PromptFileVariableKind`). */
const INSTRUCTION_ID_PREFIXES = ['vscode.instructions.file.root__', 'vscode.instructions.file.reference__'];

/** A file reference from a chat request, with what decides whether it is sent. */
export interface FileReference {
	readonly id: string;
	/** The `file:` URI sent to OpenCode, with the line range in its query for a selection. */
	readonly uri: string;
	/** The file's path on disk. */
	readonly path: string;
	/** Changes when the file's content does (its modification time), so an edited instruction file is sent again. */
	readonly version?: number;
}

/**
 * Picks the file references to send to OpenCode with a message.
 *
 * VS Code attaches the workspace's instruction files (AGENTS.md, CLAUDE.md, `*.instructions.md`)
 * to every request. OpenCode reads the AGENTS.md files from the session's folder up into each
 * request itself, so those are left out; other instruction files are sent once per session, and
 * again when they change. Sending them with every message put a copy in the conversation each
 * time, which filled the context window.
 *
 * Instruction files outside the folders open in the window, such as `~/.claude/CLAUDE.md` or the
 * user's own `.instructions.md` files, or reached from them through a link, are left out: agents are
 * kept to those folders. A file the user attached is sent wherever it is.
 *
 * Each is named by its path, which the model can read: relative to the session's folder when it is
 * in it. VS Code's names for references are not paths (`prompt:CLAUDE.md`), and a model told it had
 * been sent "prompt:CLAUDE.md" tried to read that file and failed.
 *
 * @param directory The session's working folder.
 * @param sent The instruction files already sent in this session.
 * @param folders The folders open in the window, and the session's own.
 * @returns The files to send, and the instruction files among them: they are added to `sent` once
 * the message reached OpenCode, so a message that failed to go does not leave them unsent.
 */
export function filesToSend(references: readonly FileReference[], directory: string, sent: ReadonlySet<string>, folders: readonly string[]): { files: { uri: string; name: string }[]; instructions: string[] } {
	const files: { uri: string; name: string }[] = [];
	const instructions: string[] = [];
	for (const reference of references) {
		if (isInstructionReference(reference.id)) {
			if (readByOpenCode(reference.path, directory) || outsideFolders(reference.path, folders)) {
				continue;
			}
			const key = `${reference.uri}#${reference.version ?? ''}`;
			if (sent.has(key) || instructions.includes(key)) {
				continue;
			}
			instructions.push(key);
		}
		files.push({ uri: reference.uri, name: readableName(reference.path, directory) });
	}
	return { files, instructions };
}

/** A file's path relative to `directory` when it is in it, else its absolute path. */
function readableName(file: string, directory: string): string {
	const relative = path.relative(directory, file);
	return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : file;
}

/** True for a reference to an instruction file that VS Code attached. */
export function isInstructionReference(id: string): boolean {
	return INSTRUCTION_ID_PREFIXES.some(prefix => id.startsWith(prefix));
}

/** True for an AGENTS.md in the session's folder or one of its parents: OpenCode loads those into every request. */
function readByOpenCode(file: string, directory: string): boolean {
	return path.basename(file) === 'AGENTS.md' && within(path.dirname(file), directory);
}

/** True when `file` is `folder` or in it. */
function within(folder: string, file: string): boolean {
	const relative = path.relative(folder, file);
	return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
