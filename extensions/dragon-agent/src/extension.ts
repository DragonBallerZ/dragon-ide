/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { DragonChat, moveSession } from './chat/participant';
import { existsSync, statSync } from 'node:fs';
import { buildDragonConfig, writeDragonConfig, writeSearchPlugin } from './dragonConfig';
import { findRipgrep } from './search/ripgrep';
import { DragonModels } from './models';
import { OllamaService, ollamaOrigin } from './ollama/ollamaCommands';
import { SplashService } from './localAI/splashService';
import { DEFAULT_EMBEDDING_MODEL } from './ollama/ollama';
import { SemanticSetup } from './semanticSetup';
import { TabCompletions } from './completions/tabCompletions';
import { readDragonProduct } from './updates/release';
import { UpdateChecker } from './updates/updateChecker';
import { Onboarding } from './onboarding';
import { OpenCodeServer, ServerState } from './opencode/server';
import { SessionBridge } from './opencode/sessionBridge';
import { UsageService } from './usage/usageService';
import { OpenCodeTui } from './tui';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = vscode.window.createOutputChannel('OpenCode', { log: true });
	context.subscriptions.push(log);

	const directory = () => DragonChat.directory();
	const configFile = path.join(context.globalStorageUri.fsPath, 'opencode', 'dragon.json');
	const ollama = new OllamaService(log);
	const splash = new SplashService(context.extensionPath, log);
	context.subscriptions.push(ollama, splash);

	// Instant Grep: an index-backed replacement for OpenCode's grep/glob, loaded as an OpenCode plugin.
	const rgPath = findRipgrep({ appRoot: vscode.env.appRoot });
	const compiledPlugin = newest([path.join(context.extensionPath, 'dist', 'opencodePlugin.js'), path.join(context.extensionPath, 'out', 'search', 'opencodePlugin.js')]);
	const searchPluginDir = path.join(context.globalStorageUri.fsPath, 'opencode', 'instant-grep');
	const instantGrep = () => vscode.workspace.getConfiguration('dragon.instantGrep').get<boolean>('enabled', true) && !!rgPath && !!compiledPlugin;
	if (compiledPlugin) {
		await writeSearchPlugin(searchPluginDir, compiledPlugin);
	}
	log.info(`[instant-grep] ${instantGrep() ? `enabled (ripgrep: ${rgPath})` : `disabled${!rgPath ? ': ripgrep not found' : !compiledPlugin ? ': plugin not built' : ''}`}`);

	const syncConfig = async () => {
		const model = vscode.workspace.getConfiguration('dragon').get<string>('model')?.trim() || undefined;
		const config = buildDragonConfig({ model, ollamaOrigin: ollamaOrigin(), ollamaModels: ollama.status.models, splashModels: splash.models, searchPluginDir: instantGrep() ? searchPluginDir : undefined });
		if (await writeDragonConfig(configFile, config)) {
			log.info(`[config] wrote ${configFile}`);
		}
	};
	// Semantic search settings, read by the plugin on every use so changes apply without a restart.
	const semanticConfigFile = path.join(context.globalStorageUri.fsPath, 'opencode', 'semantic.json');
	const semanticModel = () => vscode.workspace.getConfiguration('dragon.semanticSearch').get<string>('model')?.trim() || DEFAULT_EMBEDDING_MODEL;
	const syncSemantic = async () => {
		const enabled = vscode.workspace.getConfiguration('dragon.semanticSearch').get<boolean>('enabled', true) && vscode.workspace.getConfiguration('dragon.ollama').get<boolean>('enabled', true);
		await writeDragonConfig(semanticConfigFile, { enabled, model: semanticModel(), origin: ollamaOrigin() });
	};
	await Promise.all([ollama.refresh(), splash.refresh()]);
	await syncConfig();
	await syncSemantic();

	const server = new OpenCodeServer({
		configuredBinary: vscode.workspace.getConfiguration('dragon.opencode').get<string>('path'),
		extensionPath: context.extensionPath,
		cwd: directory(),
		configFile,
		extraEnv: {
			...(rgPath ? { DRAGON_RG_PATH: rgPath } : {}),
			DRAGON_SEARCH_STORAGE: path.join(context.globalStorageUri.fsPath, 'instant-grep'),
			DRAGON_SEMANTIC_CONFIG: semanticConfigFile,
		},
		log: line => log.info(line),
	});
	context.subscriptions.push({ dispose: () => server.dispose() });

	// One event stream from OpenCode, for the model picker and the composer's usage readout.
	const bridge = new SessionBridge(() => server.ensure(), line => log.info(line));
	const models = new DragonModels(server, bridge, directory, log);
	const chat = new DragonChat(server, context, log);
	// The composer's usage readout (context, cache hits, prices), for every provider OpenCode reports usage for.
	const usage = new UsageService(() => server.ensure(), bridge, directory);
	context.subscriptions.push(bridge, usage, vscode.commands.registerCommand('dragon.usage.summary', async (args?: { sessionResource?: string; sessionID?: string; vendor?: string; model?: string }) => {
		if (server.state.kind !== 'ready') {
			return undefined; // never start OpenCode just to draw the readout
		}
		const sessionID = args?.sessionID ?? (args?.sessionResource ? chat.sessionFor(args.sessionResource) : undefined);
		const model = args?.vendor === undefined || args.vendor === 'dragon' ? args?.model : undefined;
		if (!sessionID && !model) {
			return undefined;
		}
		return usage.summary({ sessionID, model }).catch(() => undefined);
	}));
	const tui = new OpenCodeTui(server, context.extensionPath, directory);
	const onboarding = new Onboarding(server, ollama, directory, log, splash);
	const semanticSetup = new SemanticSetup(context, ollama, semanticModel, () => instantGrep(), chat.onDidCompleteTurn);
	const updates = new UpdateChecker(context, readDragonProduct(vscode.env.appRoot), log);
	const completions = new TabCompletions(ollama);
	context.subscriptions.push(models, chat, tui, onboarding, semanticSetup, updates, completions);

	// Status bar: the state of the window's OpenCode server.
	const status = vscode.window.createStatusBarItem('dragon.server', vscode.StatusBarAlignment.Right, 100);
	status.name = 'OpenCode';
	status.command = 'dragon.showLog';
	const renderStatus = (state: ServerState) => {
		switch (state.kind) {
			case 'ready':
				status.text = '$(flame) OpenCode';
				status.tooltip = `OpenCode ${state.version} is running at ${state.url}`;
				status.backgroundColor = undefined;
				break;
			case 'starting':
				status.text = '$(loading~spin) OpenCode';
				status.tooltip = 'OpenCode is starting…';
				status.backgroundColor = undefined;
				break;
			case 'failed':
				status.text = '$(error) OpenCode';
				status.tooltip = state.message;
				status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
				break;
			default:
				status.text = '$(circle-slash) OpenCode';
				status.tooltip = 'OpenCode is not running';
				status.backgroundColor = undefined;
		}
		status.show();
	};
	renderStatus(server.state);
	context.subscriptions.push(status, server.onDidChangeState(renderStatus));

	context.subscriptions.push(
		splash.onDidChange(() => { void syncConfig().then(() => models.refresh()); }),
		ollama.onDidChange(() => { void syncConfig(); models.refresh(); usage.invalidateModels(); }),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dragon.model') || e.affectsConfiguration('dragon.ollama') || e.affectsConfiguration('dragon.instantGrep')) {
				void syncConfig().then(() => models.refresh());
			}
			if (e.affectsConfiguration('dragon.semanticSearch') || e.affectsConfiguration('dragon.ollama')) {
				void syncSemantic();
			}
			if (e.affectsConfiguration('dragon.opencode.path')) {
				// New sessions pick up `dragon.workingDirectory` on their own; only a new binary needs a restart.
				server.update({ configuredBinary: vscode.workspace.getConfiguration('dragon.opencode').get<string>('path'), cwd: directory() });
				void server.restart().catch(err => log.error(`[server] restart failed: ${err instanceof Error ? err.message : String(err)}`));
			}
		}),
		vscode.commands.registerCommand('dragon.showLog', () => log.show()),
		vscode.commands.registerCommand('dragon.restartServer', () => server.restart()),
		vscode.commands.registerCommand('dragon.openTui', (sessionID?: string) => tui.open(typeof sessionID === 'string' ? sessionID : undefined)),
		vscode.commands.registerCommand('dragon.continueInTui', () => tui.open(chat.currentSessionId())),
		vscode.commands.registerCommand('dragon.continueInChat', () => chat.continueInChat()),
		vscode.commands.registerCommand('dragon.newChat', () => vscode.commands.executeCommand('workbench.action.chat.newChat')),
		vscode.commands.registerCommand('dragon.ollama.pull', () => ollama.chooseAndPull()),
		vscode.commands.registerCommand('dragon.semanticSearch.setup', () => semanticSetup.setUp()),
		vscode.commands.registerCommand('dragon.checkForUpdates', () => updates.check(true)),
		vscode.commands.registerCommand('dragon.completions.setup', () => completions.setUp()),
		vscode.commands.registerCommand('dragon.moveSession', () => moveSession()),
		vscode.commands.registerCommand('dragon.serverInfo', async () => {
			await server.ensure();
			const state = server.state;
			return state.kind === 'ready' ? { url: state.url, version: state.version } : undefined;
		}),
	);

	ollama.start();
	splash.start();
	updates.start();
	// Start eagerly so the first message does not wait for the server.
	void server.ensure().then(() => bridge.start()).catch(err => log.error(`[server] ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * The most recently built of several builds of a plugin. A release ships only `dist/`; in a
 * development checkout an old `dist/` bundle must not shadow fresher `tsc` output.
 */
function newest(candidates: string[]): string | undefined {
	return candidates.filter(p => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export function deactivate(): void {
	// Disposables stop the server.
}
