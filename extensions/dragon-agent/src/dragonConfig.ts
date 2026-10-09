/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { splashProvider, SplashModel } from './localAI/splash';
import { ollamaConfig, OllamaModel } from './ollama/ollama';
import type { PermissionRule } from './opencode/types';
import { openCodeFolders } from './sandbox/sandbox';

/**
 * OpenCode allows every tool by default. Dragon's permission modes decide file edits and shell
 * commands in the chat (Ask shows the approval prompt, Full Access approves it, Read-Only denies
 * it), so OpenCode has to ask for them first.
 */
const ASK_PERMISSIONS: readonly PermissionRule[] = [
	{ action: 'edit', resource: '*', effect: 'ask' },
	{ action: 'shell', resource: '*', effect: 'ask' },
];

/**
 * The plan agent's own edit rules (from OpenCode's `opencode.plan` plugin), restated: config rules
 * come after an agent's rules, so the `edit` question above would otherwise replace its denial.
 */
const PLAN_PERMISSIONS: readonly PermissionRule[] = [
	{ action: 'edit', resource: '*', effect: 'deny' },
	{ action: 'edit', resource: '~/.opencode/plan/*', effect: 'allow' },
];

/**
 * Session rules for Read-Only. OpenCode checks session denials before the commands a user chose
 * to "Always allow", and drops wholly denied tools from what the model is offered. Subagents run in
 * sessions of their own without these rules, so only the explore agent, which only reads, may run.
 */
export const READ_ONLY_PERMISSIONS: readonly PermissionRule[] = [
	{ action: 'edit', resource: '*', effect: 'deny' },
	{ action: 'shell', resource: '*', effect: 'deny' },
	{ action: 'subagent', resource: '*', effect: 'deny' },
	{ action: 'subagent', resource: 'explore', effect: 'allow' },
];

/**
 * How much an agent may do without asking, and whether it is kept to the open folders:
 *   read-only    - plans and answers only; confined to the open folders
 *   ask          - asks before edits and commands; confined to the open folders
 *   project      - edits and runs commands without asking; confined to the open folders
 *   full-access  - edits and runs commands without asking; reaches the whole disk
 * The composer's permission chip cycles `dragon.permissionMode` through these.
 */
export type PermissionMode = 'read-only' | 'ask' | 'project' | 'full-access';

/**
 * Whether a mode keeps agents to the folders open in the window. Only Full Access reaches the rest
 * of the disk; Read-Only, Ask and Project Only are confined.
 */
export function confinesToFolders(mode: PermissionMode): boolean {
	return mode !== 'full-access';
}

/**
 * Session rules for a teammate, which answers to its lead. OpenCode's question tool would leave it
 * waiting on a card in its pane while the lead waits for its report, so it is not offered, as it is
 * not to OpenCode's own subagents; the roster tells a teammate to ask its lead instead.
 */
const TEAMMATE_PERMISSIONS: readonly PermissionRule[] = [
	{ action: 'question', resource: '*', effect: 'deny' },
];

/** The session rules for an agent under Read-Only or not, and a teammate or not. */
export function sessionPermissions(readOnly: boolean, teammate: boolean): readonly PermissionRule[] {
	return [...(readOnly ? READ_ONLY_PERMISSIONS : []), ...(teammate ? TEAMMATE_PERMISSIONS : [])];
}

export interface ConfinementInput {
	/** The folders agents may use: those open in the window, and the folders of their worktrees. */
	readonly folders: readonly string[];
	readonly home: string;
	/** `os.tmpdir()` as the server process sees it. */
	readonly tmpdir: string;
	/** `XDG_DATA_HOME` as the server process sees it. */
	readonly dataHome?: string;
	/** `OPENCODE_TEST_HOME` as the server process sees it: OpenCode's own home folder, which its plan folder is in. */
	readonly openCodeHome?: string;
	/**
	 * The plugin directories Dragon loads, which it trusts to run in OpenCode's process. Under
	 * confinement OpenCode loads only these, dropping a project's own in-process plugins, which
	 * cannot be sandboxed. Left out in Full Access.
	 */
	readonly trustedPlugins?: readonly string[];
}

/**
 * The config layer that keeps agents' file tools to the folders open in the window. OpenCode asks
 * before a tool reads, lists or writes outside the session's folder, and Full Access answers yes,
 * so the rest of the disk is denied instead. Left open are the files OpenCode writes long tool
 * output and shell output to, which the model is told to read (the sandbox plugin keeps a window
 * to its own), its temp folder, and the plan agent's plan folder (the plugin keeps a window to the
 * plans written in it). It goes in `OPENCODE_CONFIG_CONTENT`, the layer OpenCode applies last, so a
 * project's own `opencode.json` cannot open the rest of the disk again.
 */
export function confinementConfig(input: ConfinementInput): { permissions: PermissionRule[] } {
	const opencode = openCodeFolders(input);
	const open = [
		path.join(opencode.toolOutput, '*'),
		path.join(opencode.shell, '*', '*'),
		path.join(opencode.tmp, '*'),
		path.join(opencode.plan, '*'),
		...input.folders.map(folder => path.join(folder, '*')),
	];
	return {
		permissions: [
			{ action: 'external_directory', resource: '*', effect: 'deny' },
			// OpenCode matches paths with forward slashes on every platform.
			...open.map((resource): PermissionRule => ({ action: 'external_directory', resource: resource.replaceAll('\\', '/'), effect: 'allow' })),
		],
	};
}

/**
 * The part of the OpenCode server environment that keeps agents to the open folders, for a mode.
 * Full Access reaches the whole disk, so it gets none of it: no sandbox for shell commands, no
 * `external_directory` denial, and no confined-folders list for the plugin's file-tool and model
 * filters. Every other mode gets all three. The server is restarted when a mode crosses this line,
 * as the environment is read only at start. `sandboxVariables` are the prepared shell-sandbox
 * variables (empty off macOS or when it could not be set up); they are left out for Full Access.
 */
export function confinementEnv(mode: PermissionMode, input: ConfinementInput, sandboxVariables: Record<string, string>): Record<string, string> {
	if (!confinesToFolders(mode)) {
		return {};
	}
	return {
		...sandboxVariables,
		OPENCODE_CONFIG_CONTENT: JSON.stringify(confinementConfig(input)),
		DRAGON_CONFINED_FOLDERS: JSON.stringify(input.folders),
		// Only Dragon's own plugins run in the server's process under confinement. Left out when there
		// are none, so OpenCode's gate stays off and never drops the sandbox plugin that confinement needs.
		...(input.trustedPlugins?.length ? { DRAGON_TRUSTED_PLUGINS: JSON.stringify(input.trustedPlugins) } : {}),
	};
}

export interface DragonConfigInput {
	/** `provider/model` chosen in onboarding or `dragon.model`. */
	readonly model?: string;
	readonly ollamaOrigin: string;
	readonly ollamaModels: readonly OllamaModel[];
	readonly splashModels?: readonly SplashModel[];
	/** Directory of the Instant Grep OpenCode plugin, when enabled. */
	readonly searchPluginDir?: string;
	/** Directory of the agent messaging OpenCode plugin, when it was built. */
	readonly agentsPluginDir?: string;
	/** Directory of the OpenCode plugin that confines shell commands, when it was built. */
	readonly sandboxPluginDir?: string;
	/** `dragon.compaction.autoAt`: the percentage of the context window to compact at, or 0 for never. */
	readonly autoCompactAt?: number;
}

/** `dragon.compaction.autoAt`'s default, and what `/autocompact on` sets. */
export const DEFAULT_AUTO_COMPACT_AT = 75;

/**
 * Builds the OpenCode config layer Dragon IDE owns. It is merged by OpenCode on top of the
 * user's own `opencode.json`, and OpenCode watches the file, so edits apply without a restart.
 */
export function buildDragonConfig(input: DragonConfigInput): object {
	const plugins = [input.searchPluginDir, input.agentsPluginDir, input.sandboxPluginDir].filter((dir): dir is string => !!dir);
	return {
		$schema: 'https://opencode.ai/config.json',
		...(input.model ? { model: input.model } : {}),
		providers: {
			...(ollamaConfig(input.ollamaOrigin, input.ollamaModels) as { providers: object }).providers,
			...(input.splashModels?.length ? { splash: splashProvider(input.splashModels) } : {}),
		},
		...(plugins.length ? { plugins } : {}),
		// `threshold` is Dragon's addition to OpenCode (opencode-patches/0003). With `auto` off, a
		// request that no longer fits fails instead of being compacted.
		...(input.autoCompactAt === undefined ? {} : { compaction: input.autoCompactAt > 0 ? { auto: true, threshold: input.autoCompactAt / 100 } : { auto: false } }),
		permissions: ASK_PERMISSIONS,
		agents: { plan: { permissions: PLAN_PERMISSIONS } },
	};
}

/**
 * Reads `/autocompact`'s argument: `off` or 0, `on` (the default), or a whole percentage from 10
 * to 100 ("60%" or "60"). Lower ones would compact again after nearly every reply.
 */
export function parseAutoCompactAt(text: string): number | undefined {
	const value = text.trim().toLowerCase();
	if (value === 'off' || value === '0') {
		return 0;
	}
	if (value === 'on') {
		return DEFAULT_AUTO_COMPACT_AT;
	}
	const percent = /^(?<percent>\d{2,3})\s*%?$/.exec(value)?.groups?.percent;
	return percent && Number(percent) >= 10 && Number(percent) <= 100 ? Number(percent) : undefined;
}

/**
 * Writes the directory OpenCode loads one of Dragon's plugins from (Instant Grep by default).
 * OpenCode wants a plugin directory with an `index` entry; it re-exports the compiled plugin
 * shipped with the extension.
 */
export async function writeSearchPlugin(dir: string, compiledPlugin: string, name = 'Instant Grep'): Promise<void> {
	await mkdir(dir, { recursive: true });
	const entry = `// Generated by Dragon IDE. Loads the ${name} plugin shipped with the dragon-agent extension.\nexport { default } from ${JSON.stringify(pathToFileURL(compiledPlugin).href)};\n`;
	const file = path.join(dir, 'index.mjs');
	const current = await readFile(file, 'utf8').catch(() => undefined);
	if (current !== entry) {
		await writeFile(file, entry, 'utf8');
	}
}

/** Writes the config file only when its content changed, so OpenCode is not reloaded for nothing. */
export async function writeDragonConfig(file: string, config: object): Promise<boolean> {
	const next = JSON.stringify(config, null, '\t') + '\n';
	const current = await readFile(file, 'utf8').catch(() => undefined);
	if (current === next) {
		return false;
	}
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, next, 'utf8');
	return true;
}
