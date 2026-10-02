/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { hasOllamaModel } from '../ollama/ollama';
import { OllamaService, ollamaOrigin } from '../ollama/ollamaCommands';
import { complete, DEFAULT_COMPLETION_MODEL, PREFIX_CHARS, SUFFIX_CHARS } from './fim';

const DEBOUNCE_MS = 120;

/**
 * Tab completions (ghost text) from a small local model through Ollama. They run only when
 * `dragon.completions.enabled` is on and the model is installed; otherwise the provider is silent.
 */
export class TabCompletions implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private readonly registration: vscode.Disposable;

	constructor(private readonly ollama: OllamaService) {
		this.registration = vscode.languages.registerInlineCompletionItemProvider([{ scheme: 'file' }, { scheme: 'untitled' }], this);
	}

	static model(): string {
		return vscode.workspace.getConfiguration('dragon.completions').get<string>('model')?.trim() || DEFAULT_COMPLETION_MODEL;
	}

	private ready(): string | undefined {
		const config = vscode.workspace.getConfiguration('dragon');
		const model = TabCompletions.model();
		const status = this.ollama.status;
		const on = config.get<boolean>('completions.enabled', true) && config.get<boolean>('ollama.enabled', true);
		return on && status.running && hasOllamaModel(status.models.map(m => m.name), model) ? model : undefined;
	}

	async provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
		const model = this.ready();
		if (!model) {
			return undefined;
		}
		if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
			await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));
		}
		if (token.isCancellationRequested) {
			return undefined;
		}
		const offset = document.offsetAt(position);
		const prefix = document.getText(new vscode.Range(document.positionAt(Math.max(0, offset - PREFIX_CHARS)), position));
		const suffix = document.getText(new vscode.Range(position, document.positionAt(offset + SUFFIX_CHARS)));
		const controller = new AbortController();
		const cancel = token.onCancellationRequested(() => controller.abort());
		try {
			const text = await complete(ollamaOrigin(), model, { prefix, suffix }, controller.signal);
			if (!text || token.isCancellationRequested) {
				return undefined;
			}
			return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
		} finally {
			cancel.dispose();
		}
	}

	/** Downloads the completion model and turns completions on. */
	async setUp(): Promise<boolean> {
		const status = await this.ollama.refresh();
		if (!status.running) {
			const download = vscode.l10n.t('Download Ollama');
			if (await vscode.window.showInformationMessage(vscode.l10n.t('Tab completions run a small local model through Ollama, which is not running.'), download) === download) {
				await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
			}
			return false;
		}
		const model = TabCompletions.model();
		if (!hasOllamaModel(status.models.map(m => m.name), model) && !(await this.ollama.pull(model))) {
			return false;
		}
		await vscode.workspace.getConfiguration('dragon.completions').update('enabled', true, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(vscode.l10n.t('Tab completions are on, using {0} on this machine. Press Tab to accept a suggestion.', model));
		return true;
	}

	dispose(): void {
		this.registration.dispose();
	}
}
