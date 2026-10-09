/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The sandbox OpenCode plugin. OpenCode loads it in-process (Dragon's config layer lists it under
 * `plugins`), once per workspace location. Before OpenCode spawns a shell command, an agent's or one
 * typed with `!`, it takes Dragon's and the editor's variables and credentials out of the command's
 * environment and, when the extension made a sandbox for the window (macOS), runs the command in it
 * (`sandbox.ts`). It also refuses a file tool call whose path leads out of the folders open in the
 * window, or OpenCode's own that agents are let into, through a symbolic link, one for output
 * OpenCode saved that this window's models were not told of, another window's or project's, and one
 * for a plan not written from the folders open in the window (it records which folders each new plan
 * is written from), as every project shares OpenCode's plan folder. And it takes out of every model
 * request the instruction files and skills OpenCode found outside those folders, and refuses its
 * skill tool one of those skills.
 */

import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { admitPlans, confineCommand, confineRequest, confineSpawn, linkedOutside, McpEditor, ModelRequest, openCodeFolders, PlanFolder, savedElsewhere, ShellCreating, SkillEntry, skillsOutside, toldOutputs } from './sandbox';

interface PluginContext {
	readonly location: { readonly directory: string };
	readonly shell?: {
		hook(name: 'create.before', callback: (event: ShellCreating) => Promise<void> | void): Promise<unknown>;
	};
	readonly tool: {
		/** A callback that throws fails that one call, which the model is told. */
		hook?(name: 'execute.before', callback: (event: { readonly tool: string; readonly input: unknown }) => Promise<void> | void): Promise<unknown>;
	};
	readonly skill?: {
		list(): Promise<{ readonly data?: readonly SkillEntry[] }>;
	};
	readonly session?: {
		/** Each model request, which the callback may rewrite before it is sent. */
		hook(name: 'context', callback: (request: ModelRequest) => Promise<void> | void): Promise<unknown>;
	};
	readonly mcp?: {
		/** The callback may rewrite the project's MCP servers before any is spawned. */
		transform(callback: (editor: McpEditor) => Promise<void> | void): Promise<unknown>;
	};
}

/** The folders open in the window, as the extension passes them. */
function confinedFolders(): string[] {
	try {
		const folders: unknown = JSON.parse(process.env.DRAGON_CONFINED_FOLDERS ?? '[]');
		return Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string') : [];
	} catch {
		return [];
	}
}

const plugin = {
	id: 'dragon.sandbox',
	async setup(context: PluginContext) {
		const folders = confinedFolders();
		if (folders.length) {
			const skillsOutsideFolders = async () => skillsOutside((await context.skill?.list())?.data ?? [], folders);
			// The home folder as OpenCode's `Global` paths take it, which `~` in a tool's path stands for.
			const home = process.env.OPENCODE_TEST_HOME ?? homedir();
			const opencode = openCodeFolders({ home: homedir(), openCodeHome: home, tmpdir: tmpdir(), dataHome: process.env.XDG_DATA_HOME });
			const saved = [opencode.toolOutput, opencode.shell];
			const reachable = [...folders, ...saved, opencode.tmp, opencode.plan];
			// In Dragon's folder in the home folder, which is closed to agents' file tools and commands.
			const plans: PlanFolder = { plans: opencode.plan, records: path.join(home, '.dragon', 'sandbox', 'plans') };
			// The output OpenCode saved that this window's models were told of. Without the hook that shows it, none is known, so none is refused.
			const told = context.session ? new Set<string>() : undefined;
			// A refusal fails the one call. A hook that fails by mistake would fail every call or turn, so it lets them go.
			await context.tool.hook?.('execute.before', async event => {
				let problem: string | undefined;
				try {
					problem = linkedOutside(context.location.directory, event.input, reachable, home)
						?? (told && savedElsewhere(context.location.directory, event.input, saved, told, home))
						// Last, as it records the new plans of a call nothing else refused.
						?? admitPlans(context.location.directory, event.tool, event.input, plans, folders, home);
					const id = event.tool === 'skill' && typeof event.input === 'object' && event.input !== null ? (event.input as { id?: unknown }).id : undefined;
					if (!problem && typeof id === 'string' && (await skillsOutsideFolders()).includes(id)) {
						problem = `The skill ${id} is outside the folders open in the window. Agents are kept to those folders.`;
					}
				} catch (err) {
					console.error(`[sandbox] ${err instanceof Error ? err.message : String(err)}`);
				}
				if (problem) {
					throw new Error(problem);
				}
			});
			await context.session?.hook('context', async request => {
				try {
					for (const file of toldOutputs(request, saved)) {
						told?.add(file);
					}
				} catch (err) {
					console.error(`[sandbox] ${err instanceof Error ? err.message : String(err)}`);
				}
				try {
					confineRequest(request, folders, await skillsOutsideFolders());
				} catch (err) {
					console.error(`[sandbox] ${err instanceof Error ? err.message : String(err)}`);
				}
			});
			// A project's opencode.json can define local MCP servers, which OpenCode spawns as child
			// processes, not through the shell hook, so the sandbox the shell hook sets does not reach them.
			// Run each one in the window's sandbox too. Remote servers are a URL, not a spawned command, so
			// they are left alone. Without a sandbox (off macOS, or Full Access) `confineSpawn` returns
			// nothing and the command is left as it was.
			await context.mcp?.transform(editor => {
				try {
					for (const [name, config] of editor.list()) {
						if (config.type !== 'local') {
							continue;
						}
						const confined = confineSpawn(config.command, process.env);
						if (!confined) {
							continue;
						}
						if (!confined.ok) {
							console.error(`[sandbox] MCP server ${name}: ${confined.error}`);
							continue;
						}
						// OpenCode sets BUN_BE_BUN for a server whose command is `opencode`. Once the command is
						// the sandbox wrapper, that check no longer matches, so keep the variable here. `~` is
						// set to the sandbox's home so it resolves inside the sandbox.
						const added = config.command[0] === 'opencode' ? { BUN_BE_BUN: '1' } : undefined;
						editor.update(name, next => {
							if (next.type === 'local') {
								next.command = confined.command;
								next.environment = { ...added, ...next.environment, HOME: confined.home };
							}
						});
					}
				} catch (err) {
					console.error(`[sandbox] ${err instanceof Error ? err.message : String(err)}`);
				}
			});
		}
		if (!context.shell) {
			console.error('[sandbox] this OpenCode has no shell hook; shell commands run outside the sandbox');
			return;
		}
		await context.shell.hook('create.before', event => {
			try {
				const problem = confineCommand(event, process.env);
				if (problem) {
					console.error(`[sandbox] ${problem}`);
				}
			} catch (err) {
				console.error(`[sandbox] ${err instanceof Error ? err.message : String(err)}`);
			}
		});
	},
};

export default plugin;
