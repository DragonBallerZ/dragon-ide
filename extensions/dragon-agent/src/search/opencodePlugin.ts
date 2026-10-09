/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The Instant Grep OpenCode plugin. OpenCode loads it in-process (Dragon's config layer lists
 * it under `plugins`), once per workspace location. It replaces the built-in `grep` and `glob`
 * tools, which spawn ripgrep over the whole tree on every call, with index-backed versions that
 * keep the same parameters, and adds `find_files` for fuzzy path lookup.
 *
 * Because the tools keep their names, every agent that may use grep (build, plan, the explore
 * subagent) gets the fast version, in the chat view and in the TUI alike.
 *
 * It also adds `codebase_search`, semantic search over a local embedding model (Ollama), fused
 * with Instant Grep keyword hits. Its index is built in the background and kept current by the
 * same file watcher.
 */

import * as path from 'node:path';
import { formatGrep, SearchEngine } from './engine';
import { findRipgrep } from './ripgrep';
import { formatSemantic, SemanticIndex } from './semantic';

interface PluginContext {
	readonly location: { readonly directory: string };
	readonly tool: {
		transform(callback: (editor: ToolEditor) => void): Promise<unknown>;
	};
}

interface ToolEditor {
	add(tool: {
		name: string;
		description: string;
		input: object;
		options?: { codemode: boolean; permission?: string };
		execute(input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<{ content: string; metadata?: Record<string, unknown> }>;
	}): void;
}

const engines = new Map<string, SearchEngine>();
const semantics = new Map<string, SemanticIndex>();

function engineFor(root: string): SearchEngine {
	let engine = engines.get(root);
	if (!engine) {
		const rg = findRipgrep({ explicit: process.env.DRAGON_RG_PATH });
		if (!rg) {
			throw new Error('ripgrep was not found; Instant Grep needs it to verify matches.');
		}
		engine = new SearchEngine(root, rg, process.env.DRAGON_SEARCH_STORAGE, line => console.error(line));
		engines.set(root, engine);
		void engine.start().catch(err => console.error(`[instant-grep] ${err instanceof Error ? err.message : String(err)}`));
	}
	return engine;
}

function semanticFor(root: string, engine: SearchEngine): SemanticIndex {
	let index = semantics.get(root);
	if (!index) {
		index = new SemanticIndex(root, engine, process.env.DRAGON_SEARCH_STORAGE, line => console.error(line));
		semantics.set(root, index);
		index.start();
	}
	return index;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * `path` in a tool call may be absolute or relative; turn it into a root-relative prefix. A path
 * outside the workspace is refused: ripgrep would search it, and agents are kept to the workspace.
 */
export function relativeTo(root: string, value: string | undefined): string | undefined {
	if (!value || value === '.' || value === 'undefined' || value === 'null') {
		return undefined;
	}
	const rel = path.relative(root, path.resolve(root, value));
	if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		throw new Error(`${value} is outside the workspace (${root}). Search inside the workspace.`);
	}
	return rel.replace(/\\/g, '/') || undefined;
}

export const GREP_DESCRIPTION = [
	'Search file contents with ripgrep regex syntax (or literal text), answered from a local trigram index in milliseconds on any repository size.',
	'Results are identical to ripgrep: .gitignore is honoured and hidden files are included.',
	'Use it freely and often: it is the fastest way to find definitions, usages, strings and TODOs.',
	'Narrow with `path` (a directory or file) or `include` (a glob such as "*.{ts,tsx}" or "src/**/*.py"); use `context` for surrounding lines and `filesOnly` to list matching files.',
].join(' ');

export const SEMANTIC_DESCRIPTION = [
	'Semantic code search: find code by meaning, for example "where are failed uploads retried?" or "how is the session token validated?".',
	'Returns the most relevant code chunks with line numbers, ranked by a local embedding model together with keyword matches for any identifiers in the query.',
	'Use it to explore unfamiliar code or when you do not know the exact names; use grep for exact text and known identifiers.',
].join(' ');

const plugin = {
	id: 'dragon.instant-grep',
	async setup(context: PluginContext) {
		const root = context.location.directory;
		const engine = engineFor(root);
		const semantic = semanticFor(root, engine);

		await context.tool.transform(editor => {
			editor.add({
				name: 'grep',
				description: GREP_DESCRIPTION,
				options: { codemode: false, permission: 'grep' },
				input: {
					type: 'object',
					properties: {
						pattern: { type: 'string', minLength: 1, description: 'Regular expression (ripgrep syntax) or literal text to find.' },
						path: { type: 'string', description: 'File or directory to search, relative to the workspace. Defaults to the whole workspace.' },
						include: { type: 'string', description: 'Glob the file path must match, e.g. "*.{ts,tsx}" or "src/**/*.go".' },
						exclude: { type: 'string', description: 'Glob of paths to leave out, e.g. "**/*.test.ts".' },
						literal: { type: 'boolean', description: 'Treat the pattern as literal text instead of a regex. Default false.' },
						caseSensitive: { type: 'boolean', description: 'Match case exactly. Default true.' },
						context: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines of context around each match. Default 0.' },
						multiline: { type: 'boolean', description: 'Allow the regex to span lines (. matches newlines). Default false.' },
						filesOnly: { type: 'boolean', description: 'Only list the files that match. Default false.' },
						limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum matching lines to return. Default 100.' },
					},
					required: ['pattern'],
					additionalProperties: false,
				},
				async execute(input, toolContext) {
					const pattern = String(input.pattern ?? '');
					const params = {
						pattern,
						under: relativeTo(root, str(input.path)),
						fixedStrings: input.literal === true,
						caseSensitive: input.caseSensitive === false ? false : true,
						include: str(input.include) ? [String(input.include)] : [],
						exclude: str(input.exclude) ? [String(input.exclude)] : [],
						context: num(input.context),
						multiline: input.multiline === true,
						filesOnly: input.filesOnly === true,
						maxResults: num(input.limit) ?? 100,
					};
					const result = await engine.grep(params, toolContext.signal);
					return {
						content: formatGrep(result, params),
						metadata: { matches: result.totalMatches, files: result.files.length, truncated: result.truncated, mode: result.mode, candidates: result.candidates, elapsedMs: result.elapsedMs },
					};
				},
			});

			editor.add({
				name: 'glob',
				description: 'Find files by glob pattern (examples: "**/*.ts", "src/**/*.tsx"), answered from the Instant Grep file index. Honours .gitignore.',
				options: { codemode: false, permission: 'glob' },
				input: {
					type: 'object',
					properties: {
						pattern: { type: 'string', minLength: 1, description: 'Glob pattern, e.g. "**/*.ts".' },
						path: { type: 'string', description: 'Directory to search in, relative to the workspace.' },
						hidden: { type: 'boolean', description: 'Include hidden files and directories. Default false.' },
						limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum files to return. Default 100.' },
					},
					required: ['pattern'],
					additionalProperties: false,
				},
				async execute(input) {
					const under = relativeTo(root, str(input.path));
					const raw = String(input.pattern ?? '');
					const pattern = under ? `${under}/${raw.replace(/^\.?\//, '')}` : raw;
					const limit = num(input.limit) ?? 100;
					const files = await engine.findFiles(pattern.includes('*') || pattern.includes('?') || pattern.includes('{') || pattern.includes('[') ? pattern : `**/${pattern}`, limit + 1, { hidden: input.hidden === true });
					const truncated = files.length > limit;
					const shown = files.slice(0, limit);
					return {
						content: shown.length
							? shown.join('\n') + (truncated ? `\n\n(Showing the first ${limit} files. Use a more specific pattern or path.)` : '')
							: 'No files found',
						metadata: { count: shown.length, truncated },
					};
				},
			});

			editor.add({
				name: 'find_files',
				description: 'Fuzzy-find files by (partial) name or path, like an editor\'s quick open: "usrctl" finds "src/user/controller.ts". Best matches first. Use it when you know roughly what a file is called but not where it is.',
				options: { codemode: false, permission: 'glob' },
				input: {
					type: 'object',
					properties: {
						query: { type: 'string', minLength: 1, description: 'Part of a file name or path.' },
						limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum files to return. Default 20.' },
					},
					required: ['query'],
					additionalProperties: false,
				},
				async execute(input) {
					const files = await engine.findFiles(String(input.query ?? ''), num(input.limit) ?? 20, { hidden: true });
					return { content: files.length ? files.join('\n') : 'No files found', metadata: { count: files.length } };
				},
			});

			editor.add({
				name: 'codebase_search',
				description: SEMANTIC_DESCRIPTION,
				options: { codemode: false, permission: 'grep' },
				input: {
					type: 'object',
					properties: {
						query: { type: 'string', minLength: 3, description: 'A question or description in natural language, e.g. "where are uploads retried after a network error?". Include identifiers you already know.' },
						path: { type: 'string', description: 'Directory to search in, relative to the workspace. Defaults to the whole workspace.' },
						limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum code chunks to return. Default 10.' },
					},
					required: ['query'],
					additionalProperties: false,
				},
				async execute(input, toolContext) {
					const query = String(input.query ?? '');
					const result = await semantic.search(query, { under: relativeTo(root, str(input.path)), limit: num(input.limit) ?? 10, signal: toolContext.signal });
					return {
						content: await formatSemantic(root, result, query),
						metadata: { mode: result.mode, results: result.hits.length, keywords: result.keywords, indexedFiles: result.indexedFiles, candidateFiles: result.candidateFiles, chunks: result.chunks, elapsedMs: result.elapsedMs },
					};
				},
			});
		});

		return () => {
			semantics.get(root)?.dispose();
			semantics.delete(root);
			engines.get(root)?.dispose();
			engines.delete(root);
		};
	},
};

export default plugin;
