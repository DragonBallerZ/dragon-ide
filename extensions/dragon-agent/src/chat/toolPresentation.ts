/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionDecision } from '../opencode/types';

/**
 * How an OpenCode tool call reads in the chat view. Tool names and input fields come from
 * `opencode/packages/core/src/tool/plugin/*.ts`; unknown tools (MCP, plugins) fall back to
 * their name.
 */
export interface ToolPresentation {
	/** Shown while the tool runs, e.g. "Reading `src/app.ts`". */
	readonly running: string;
	/** Shown once it finished, e.g. "Read `src/app.ts`". */
	readonly done: string;
	/** A workspace-relative file the tool acted on, when there is one. */
	readonly file?: string;
	/** A shell command, rendered as a terminal-style block. */
	readonly command?: string;
	/** Tools that change files. */
	readonly edits: boolean;
}

const code = (value: string) => '`' + value.replace(/`/g, '\u02cb') + '`';

function s(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncate(value: string, max = 80): string {
	const single = value.replace(/\s+/g, ' ');
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function presentTool(name: string, input: Record<string, unknown> = {}): ToolPresentation {
	const path = s(input, 'path');
	switch (name) {
		case 'read':
			return path
				? { running: `Reading ${code(path)}`, done: `Read ${code(path)}`, file: path, edits: false }
				: { running: 'Reading', done: 'Read', edits: false };
		case 'write':
			return path
				? { running: `Writing ${code(path)}`, done: `Wrote ${code(path)}`, file: path, edits: true }
				: { running: 'Writing a file', done: 'Wrote a file', edits: true };
		case 'edit':
			return path
				? { running: `Editing ${code(path)}`, done: `Edited ${code(path)}`, file: path, edits: true }
				: { running: 'Editing a file', done: 'Edited a file', edits: true };
		case 'patch':
			return { running: 'Applying a patch', done: 'Applied a patch', edits: true };
		case 'shell': {
			const command = s(input, 'command');
			return command
				? { running: `Running ${code(truncate(command))}`, done: `Ran ${code(truncate(command))}`, command, edits: false }
				: { running: 'Running a command', done: 'Ran a command', edits: false };
		}
		case 'glob': {
			const pattern = s(input, 'pattern');
			return { running: pattern ? `Finding files matching ${code(pattern)}` : 'Finding files', done: pattern ? `Found files matching ${code(pattern)}` : 'Found files', edits: false };
		}
		case 'grep': {
			const pattern = s(input, 'pattern');
			return { running: pattern ? `Searching for ${code(truncate(pattern, 60))}` : 'Searching', done: pattern ? `Searched for ${code(truncate(pattern, 60))}` : 'Searched', edits: false };
		}
		case 'find_files': {
			const query = s(input, 'query');
			return { running: query ? `Finding files like ${code(query)}` : 'Finding files', done: query ? `Found files like ${code(query)}` : 'Found files', edits: false };
		}
		case 'codebase_search': {
			const query = s(input, 'query');
			return { running: query ? `Searching the codebase for ${code(truncate(query, 60))}` : 'Searching the codebase', done: query ? `Searched the codebase for ${code(truncate(query, 60))}` : 'Searched the codebase', edits: false };
		}
		case 'webfetch': {
			const url = s(input, 'url');
			return { running: url ? `Fetching ${url}` : 'Fetching a page', done: url ? `Fetched ${url}` : 'Fetched a page', edits: false };
		}
		case 'websearch': {
			const query = s(input, 'query');
			return { running: query ? `Searching the web for ${code(truncate(query, 60))}` : 'Searching the web', done: query ? `Searched the web for ${code(truncate(query, 60))}` : 'Searched the web', edits: false };
		}
		case 'subagent': {
			const label = s(input, 'description') ?? s(input, 'agent') ?? 'a subagent';
			return { running: `Delegating: ${label}`, done: `Delegated: ${label}`, edits: false };
		}
		case 'question':
			return { running: 'Asking you a question', done: 'Asked you a question', edits: false };
		case 'skill': {
			const id = s(input, 'id');
			return { running: id ? `Loading skill ${code(id)}` : 'Loading a skill', done: id ? `Loaded skill ${code(id)}` : 'Loaded a skill', edits: false };
		}
		case 'session_rename': {
			const title = s(input, 'title');
			return { running: title ? `Renaming the session to ${code(truncate(title, 60))}` : 'Renaming the session', done: title ? `Renamed the session to ${code(truncate(title, 60))}` : 'Renamed the session', edits: false };
		}
		case 'session_move': {
			const directory = s(input, 'directory');
			return { running: directory ? `Moving the session to ${code(directory)}` : 'Moving the session', done: directory ? `Moved the session to ${code(directory)}` : 'Moved the session', edits: false };
		}
		case 'models':
			return { running: 'Looking up models', done: 'Looked up models', edits: false };
		case 'list_mcp_resources': {
			const server = s(input, 'server');
			return { running: server ? `Listing ${code(server)} resources` : 'Listing MCP resources', done: server ? `Listed ${code(server)} resources` : 'Listed MCP resources', edits: false };
		}
		case 'read_mcp_resource': {
			const uri = s(input, 'uri');
			return { running: uri ? `Reading ${code(truncate(uri, 60))}` : 'Reading an MCP resource', done: uri ? `Read ${code(truncate(uri, 60))}` : 'Read an MCP resource', edits: false };
		}
		default:
			return { running: `Running ${code(name)}`, done: `Ran ${code(name)}`, edits: false };
	}
}

/** The line for a tool call that never ran, e.g. "Skipped running `rm -rf dist`: denied". */
export function skippedMessage(running: string, reason: string): string {
	return `Skipped ${running.charAt(0).toLowerCase()}${running.slice(1)}: ${reason}`;
}

/** One answer from a question carousel: a string, or a `{ selectedValue, freeformValue }`-style object. */
export function answerValue(value: unknown): unknown {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		return record.freeformValue ?? record.selectedValues ?? record.selectedValue ?? record.value;
	}
	return value;
}

/** The reply to a permission request from the approval prompt's answer: anything but an allow denies it. */
export function permissionDecision(answer: unknown): PermissionDecision {
	const value = answerValue(answer);
	return value === 'once' || value === 'always' ? value : 'reject';
}

/** One-line description of a permission request, for the approval prompt. */
export function describePermission(action: string, resources: readonly string[]): string {
	const list = resources.slice(0, 3).map(code).join(', ') + (resources.length > 3 ? ` and ${resources.length - 3} more` : '');
	switch (action) {
		case 'edit':
		case 'write':
			return resources.length ? `OpenCode wants to change ${list}.` : 'OpenCode wants to change files.';
		case 'shell':
		case 'bash':
			return resources.length ? `OpenCode wants to run ${list}.` : 'OpenCode wants to run a command.';
		case 'read':
			return resources.length ? `OpenCode wants to read ${list}.` : 'OpenCode wants to read files.';
		case 'webfetch':
			return resources.length ? `OpenCode wants to fetch ${list}.` : 'OpenCode wants to fetch a web page.';
		case 'external_directory':
			return resources.length ? `OpenCode wants to access ${list}, outside this workspace.` : 'OpenCode wants to access files outside this workspace.';
		default:
			return resources.length ? `OpenCode wants permission for ${code(action)} on ${list}.` : `OpenCode wants permission for ${code(action)}.`;
	}
}
