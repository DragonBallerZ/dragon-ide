/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DEFAULT_EMBEDDING_MODEL, hasOllamaModel, OllamaStatus } from './ollama/ollama';
import type { OllamaService } from './ollama/ollamaCommands';

const DISMISSED_KEY = 'dragon.semanticSearch.offerDismissedAt';
const TURNS_KEY = 'dragon.completedTurns';
const NOT_NOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sets up semantic search: the OpenCode plugin does the indexing, this only makes sure Ollama
 * has the embedding model. It offers the download once when Ollama runs without the model, but
 * only after the agent has completed a turn, so the offer never covers onboarding or the chat
 * input on first run. Nothing is downloaded without a click.
 */
export class SemanticSetup implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private offered = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly ollama: OllamaService,
		private readonly model: () => string,
		private readonly instantGrep: () => boolean,
		onDidCompleteTurn: vscode.Event<void>,
	) {
		this.disposables.push(
			ollama.onDidChange(status => void this.maybeOffer(status)),
			onDidCompleteTurn(async () => {
				await this.context.globalState.update(TURNS_KEY, this.context.globalState.get<number>(TURNS_KEY, 0) + 1);
				void this.maybeOffer(this.ollama.status);
			}),
		);
	}

	private enabled(): boolean {
		return vscode.workspace.getConfiguration('dragon.semanticSearch').get<boolean>('enabled', true);
	}

	private async maybeOffer(status: OllamaStatus): Promise<void> {
		const dismissedAt = this.context.globalState.get<number>(DISMISSED_KEY);
		if (this.offered || !status.running || !this.enabled() || !this.instantGrep() || !vscode.workspace.workspaceFolders?.length
			|| this.context.globalState.get<number>(TURNS_KEY, 0) < 1
			|| (dismissedAt !== undefined && (dismissedAt < 0 || Date.now() - dismissedAt < NOT_NOW_MS))
			|| hasOllamaModel(status.models.map(m => m.name), this.model())) {
			return;
		}
		this.offered = true;
		const model = this.model();
		const size = model === DEFAULT_EMBEDDING_MODEL ? ' (about 640 MB)' : '';
		const enable = vscode.l10n.t('Download and Enable');
		const notNow = vscode.l10n.t('Not Now');
		const never = vscode.l10n.t('Don\'t Ask Again');
		const pick = await vscode.window.showInformationMessage(
			vscode.l10n.t('Turn on semantic codebase search? Dragon downloads the local embedding model {0}{1} and indexes this workspace on your machine. Nothing is uploaded.', model, size),
			enable, notNow, never);
		if (pick === enable) {
			await this.setUp();
		} else if (pick === never) {
			await this.context.globalState.update(DISMISSED_KEY, -1);
		} else {
			await this.context.globalState.update(DISMISSED_KEY, Date.now());
		}
	}

	/** Makes sure Ollama runs, Instant Grep is on and the embedding model is installed. */
	async setUp(): Promise<boolean> {
		const status = await this.ollama.refresh();
		if (!status.running) {
			const download = vscode.l10n.t('Download Ollama');
			const pick = await vscode.window.showInformationMessage(vscode.l10n.t('Semantic search runs a local embedding model through Ollama, which is not running.'), download);
			if (pick === download) {
				await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
			}
			return false;
		}
		if (!this.instantGrep()) {
			await vscode.workspace.getConfiguration('dragon.instantGrep').update('enabled', true, vscode.ConfigurationTarget.Global);
		}
		const model = this.model();
		if (!hasOllamaModel(status.models.map(m => m.name), model) && !(await this.ollama.pull(model))) {
			return false;
		}
		if (!this.enabled()) {
			await vscode.workspace.getConfiguration('dragon.semanticSearch').update('enabled', true, vscode.ConfigurationTarget.Global);
		}
		vscode.window.showInformationMessage(vscode.l10n.t('Semantic search is on. OpenCode is indexing this workspace with {0} in the background, and the agent can use codebase_search.', model));
		return true;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
