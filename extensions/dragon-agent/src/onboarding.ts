/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { OpenCodeServer } from './opencode/server';
import type { SplashService } from './localAI/splashService';
import { sortModels, featuredIntegrations, pickDefaultModel, ProviderChoice, SignInChoice } from './catalog';
import type { OllamaService } from './ollama/ollamaCommands';
import { chatModelNames } from './ollama/ollama';

export interface OnboardingState {
	readonly serverReady: boolean;
	readonly serverError?: string;
	/** The model configured with `dragon.model`, if any. */
	readonly model?: string;
	readonly ollama: { readonly running: boolean; readonly models: readonly string[] };
	readonly keyProviders: readonly ProviderChoice[];
	readonly signInProviders: readonly SignInChoice[];
}

/**
 * Commands behind the Dragon onboarding screen (`contrib/dragonOnboarding` in the workbench)
 * and the "Dragon: Choose Model" command. Credentials are stored by OpenCode itself, so the
 * TUI sees the same setup.
 */
export class Onboarding implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly server: OpenCodeServer, private readonly ollama: OllamaService, private readonly directory: () => string, private readonly log: vscode.LogOutputChannel, private readonly splash: SplashService) {
		this.disposables.push(
			vscode.commands.registerCommand('dragon.onboarding.state', () => this.state()),
			vscode.commands.registerCommand('dragon.onboarding.useOllama', (model?: string) => this.useOllama(model)),
			vscode.commands.registerCommand('dragon.onboarding.connectKey', (integrationID?: string, key?: string) => this.connectKey(integrationID, key)),
			vscode.commands.registerCommand('dragon.onboarding.signIn', (integrationID?: string, methodID?: string) => this.signIn(integrationID, methodID)),
			vscode.commands.registerCommand('dragon.localAI.setup', () => this.chooseModel()),
			vscode.commands.registerCommand('dragon.onboarding.useSplash', () => this.useSplash()),
			vscode.commands.registerCommand('dragon.chooseModel', () => this.chooseModel()),
		);
	}

	async state(): Promise<OnboardingState> {
		const ollama = await this.ollama.refresh();
		const model = vscode.workspace.getConfiguration('dragon').get<string>('model')?.trim() || undefined;
		try {
			const client = await this.server.ensure();
			const { key, signIn } = featuredIntegrations(await client.integrations(this.directory()));
			return { serverReady: true, model, ollama: { running: ollama.running, models: chatModelNames(ollama.models) }, keyProviders: key, signInProviders: signIn };
		} catch (err) {
			return { serverReady: false, serverError: err instanceof Error ? err.message : String(err), model, ollama: { running: ollama.running, models: chatModelNames(ollama.models) }, keyProviders: [], signInProviders: [] };
		}
	}

	private async setModel(model: string): Promise<void> {
		await vscode.workspace.getConfiguration('dragon').update('model', model, vscode.ConfigurationTarget.Global);
		this.log.info(`[onboarding] default model set to ${model}`);
		await this.waitUntilListed(model);
	}

	/**
	 * Waits until OpenCode lists `model` (it reloads Dragon's config layer after the setting
	 * changes), so the chat opened next can select it. Without this, the chat keeps the model it
	 * picked before, and the first turn runs on that one. Gives up after 10 s: the setting stands.
	 */
	private async waitUntilListed(model: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			try {
				const client = await this.server.ensure();
				if ((await client.models(this.directory())).some(m => `${m.providerID}/${m.id}` === model)) {
					return;
				}
			} catch {
				// OpenCode may be reloading; try again
			}
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		this.log.warn(`[onboarding] OpenCode does not list ${model} yet; the chat may start on another model`);
	}

	async useOllama(model?: string): Promise<string | undefined> {
		const chosen = model ?? await this.ollama.chooseAndPull();
		if (!chosen) {
			return undefined;
		}
		if (!this.ollama.status.models.some(m => m.name === chosen) && !(await this.ollama.pull(chosen))) {
			return undefined;
		}
		const ref = `ollama/${await this.ollama.prepareForAgent(chosen)}`;
		await this.setModel(ref);
		return ref;
	}

	async useSplash(): Promise<string | undefined> {
		const model = await this.splash.chooseAndStart();
		if (!model) { return undefined; }
		const ref = `splash/${model}`;
		await this.setModel(ref);
		return ref;
	}

	async connectKey(integrationID?: string, key?: string): Promise<string | undefined> {
		const client = await this.server.ensure();
		const directory = this.directory();
		if (!integrationID) {
			const { key: providers } = featuredIntegrations(await client.integrations(directory));
			const picked = await vscode.window.showQuickPick(providers.map(p => ({ label: p.name, description: p.id, id: p.id })), { title: 'Connect a provider with an API key', matchOnDescription: true });
			if (!picked) {
				return undefined;
			}
			integrationID = picked.id;
		}
		key ??= await vscode.window.showInputBox({ title: `API key for ${integrationID}`, password: true, ignoreFocusOut: true, prompt: 'Stored by OpenCode in its own credential store on this machine.' });
		if (!key) {
			return undefined;
		}
		await client.connectKey(directory, integrationID, key.trim());
		return this.defaultAfterConnect(integrationID);
	}

	async signIn(integrationID?: string, methodID?: string): Promise<string | undefined> {
		const client = await this.server.ensure();
		const directory = this.directory();
		if (!integrationID || !methodID) {
			const { signIn } = featuredIntegrations(await client.integrations(directory));
			const picked = await vscode.window.showQuickPick(signIn.map(p => ({ label: p.label, description: p.name, p })), { title: 'Sign in to a provider' });
			if (!picked) {
				return undefined;
			}
			integrationID = picked.p.id;
			methodID = picked.p.methodID;
		}
		const attempt = await client.connectOAuth(directory, integrationID, methodID);
		await vscode.env.openExternal(vscode.Uri.parse(attempt.url));
		if (attempt.mode === 'code') {
			const code = await vscode.window.showInputBox({ title: 'Paste the code from your browser', prompt: attempt.instructions, ignoreFocusOut: true });
			if (!code) {
				return undefined;
			}
			await client.completeOAuth(directory, integrationID, attempt.attemptID, code.trim());
		} else {
			const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: attempt.instructions || 'Finish signing in in your browser…', cancellable: true }, async (_progress, token) => {
				const deadline = Date.now() + 10 * 60_000;
				while (!token.isCancellationRequested && Date.now() < deadline) {
					const status = await client.oauthStatus(directory, integrationID!, attempt.attemptID).catch(() => undefined);
					if (status?.status === 'complete') {
						return true;
					}
					if (status && status.status !== 'pending') {
						throw new Error(status.message ?? 'Sign-in failed.');
					}
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
				return false;
			});
			if (!done) {
				return undefined;
			}
		}
		return this.defaultAfterConnect(integrationID);
	}

	private async defaultAfterConnect(integrationID: string): Promise<string | undefined> {
		const client = await this.server.ensure();
		// Give the provider catalogue a moment to pick up the new credential.
		for (let attempt = 0; attempt < 10; attempt++) {
			const model = pickDefaultModel(await client.models(this.directory()), integrationID);
			if (model) {
				const ref = `${model.providerID}/${model.id}`;
				await this.setModel(ref);
				vscode.window.showInformationMessage(`Connected. Dragon will use ${model.name} by default; change it any time from the chat model picker.`);
				return ref;
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		vscode.window.showInformationMessage('Connected. Pick a model from the chat model picker.');
		return undefined;
	}

	async chooseModel(): Promise<string | undefined> {
		const client = await this.server.ensure();
		const models = await client.models(this.directory());
		type Item = vscode.QuickPickItem & { run?: () => Promise<string | undefined>; model?: string };
		const items: Item[] = [
			{ label: '$(device-desktop) Run a model locally with Ollama', run: () => this.useOllama() },
			{ label: '$(flame) Run a model locally with Splash', description: 'Apple M3 or newer', run: () => this.useSplash() },
			{ label: '$(key) Connect a provider with an API key', run: () => this.connectKey() },
			{ label: '$(account) Sign in to a provider', run: () => this.signIn() },
			{ label: 'Available models', kind: vscode.QuickPickItemKind.Separator },
			...sortModels(models).map(m => ({ label: m.name, description: `${m.providerID}/${m.id}`, model: `${m.providerID}/${m.id}` })),
		];
		const picked = await vscode.window.showQuickPick(items, { title: 'Choose the model Dragon uses', matchOnDescription: true });
		if (!picked) {
			return undefined;
		}
		if (picked.run) {
			return picked.run();
		}
		if (picked.model) {
			await this.setModel(picked.model);
			return picked.model;
		}
		return undefined;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
