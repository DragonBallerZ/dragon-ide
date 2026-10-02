/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import { chooseLocalModel } from '../localAI/picker';
import { detectHardware, LOCAL_MODELS, unsupportedReason } from '../localAI/catalog';
import * as vscode from 'vscode';
import { agentContextFor, createAgentVariant, DEFAULT_OLLAMA_ORIGIN, isLoopbackOrigin, modelContextLength, OllamaStatus, ollamaStatus, pullModel, variantContext } from './ollama';

export function ollamaOrigin(): string {
	const configured = vscode.workspace.getConfiguration('dragon.ollama').get<string>('origin')?.trim() || DEFAULT_OLLAMA_ORIGIN;
	return isLoopbackOrigin(configured) ? configured.replace(/\/$/, '') : DEFAULT_OLLAMA_ORIGIN;
}

/**
 * Local models through Ollama. Nothing is installed, downloaded or started without an explicit
 * click; detection is read-only.
 */
export class OllamaService implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<OllamaStatus>();
	readonly onDidChange = this.changed.event;
	private last: OllamaStatus = { running: false, models: [] };
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly log: vscode.LogOutputChannel) { }

	get status(): OllamaStatus {
		return this.last;
	}

	/** Polls the daemon every 30 seconds, like OpenCode's own discovery. */
	start(): void {
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), 30_000);
	}

	async refresh(): Promise<OllamaStatus> {
		if (!vscode.workspace.getConfiguration('dragon.ollama').get<boolean>('enabled', true)) {
			return this.last = { running: false, models: [] };
		}
		const next = await ollamaStatus(ollamaOrigin());
		const before = JSON.stringify(this.last);
		this.last = next;
		if (JSON.stringify(next) !== before) {
			this.log.info(`[ollama] ${next.running ? `running${next.version ? ` ${next.version}` : ''}, ${next.models.length} model(s)` : 'not running'}`);
			this.changed.fire(next);
		}
		return next;
	}

	/** Offers the models that fit this machine and downloads the chosen one. Returns its name. */
	async chooseAndPull(): Promise<string | undefined> {
		const status = await this.refresh();
		if (!status.running) {
			const pick = await vscode.window.showInformationMessage(
				'Ollama is not running. Install or start Ollama to run models on this machine.',
				{ modal: false },
				'Download Ollama', 'Retry');
			if (pick === 'Download Ollama') {
				await vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
			} else if (pick === 'Retry') {
				return this.chooseAndPull();
			}
			return undefined;
		}
		const installed = new Set(status.models.map(m => m.name));
		const picked = await chooseLocalModel('ollama', [...installed]);
		if (!picked) { return undefined; }
		if (!installed.has(picked.id)) {
			const action = await vscode.window.showInformationMessage(`${picked.name}: about ${picked.download} GB download, ${picked.memory} GB AI memory. Model license: Apache-2.0.`, { modal: true }, 'Download model', 'Model details');
			if (action === 'Model details') { await vscode.env.openExternal(vscode.Uri.parse(`https://huggingface.co/${picked.hf}`)); return undefined; }
			if (action !== 'Download model' || !(await this.pull(picked.id))) { return undefined; }
		}
		return picked.id;
	}

	/**
	 * The agent variant of `model` with a context window large enough for OpenCode (see
	 * ollama.ts), created if needed. Falls back to `model` itself when Ollama cannot create it.
	 */
	async prepareForAgent(model: string): Promise<string> {
		if (variantContext(model)) {
			return model;
		}
		const origin = ollamaOrigin();
		const maximum = await modelContextLength(model, origin);
		// Curated memory estimates include a 32k window, including on larger machines.
		const curated = LOCAL_MODELS.some(item => item.runtime === 'ollama' && item.id === model);
		const context = agentContextFor(os.totalmem(), curated ? Math.min(maximum ?? 32768, 32768) : maximum);
		try {
			const variant = await createAgentVariant(model, context, origin);
			this.log.info(`[ollama] ${variant}: ${model} with a ${context}-token context window`);
			await this.refresh();
			return variant;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log.warn(`[ollama] could not create an agent variant of ${model}: ${message}`);
			vscode.window.showWarningMessage(vscode.l10n.t('Dragon could not give {0} a {1}k context window ({2}). Long agent prompts may be cut off: update Ollama, or start it with OLLAMA_CONTEXT_LENGTH={3}.', model, Math.round(context / 1024), message, context));
			return model;
		}
	}

	async pull(name: string): Promise<boolean> {
		const model = LOCAL_MODELS.find(m => m.runtime === 'ollama' && m.id === name);
		if (model) {
			const reason = unsupportedReason(model, await detectHardware());
			if (reason) { await vscode.window.showWarningMessage(reason); return false; }
		}
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Downloading ${name}`, cancellable: true }, async (progress, token) => {
				const controller = new AbortController();
				token.onCancellationRequested(() => controller.abort());
				let reported = 0;
				await pullModel(name, update => {
					const percent = update.fraction !== undefined ? Math.floor(update.fraction * 100) : undefined;
					const increment = percent !== undefined ? Math.max(0, percent - reported) : undefined;
					if (percent !== undefined) {
						reported = Math.max(reported, percent);
					}
					progress.report({ message: percent !== undefined ? `${update.status} ${percent}%` : update.status, increment });
				}, controller.signal, ollamaOrigin());
			});
			await this.refresh();
			vscode.window.showInformationMessage(`${name} is ready.`);
			return true;
		} catch (err) {
			if (!(err instanceof Error && err.name === 'AbortError')) {
				vscode.window.showErrorMessage(`Could not download ${name}: ${err instanceof Error ? err.message : String(err)}`);
			}
			return false;
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
		}
		this.changed.dispose();
	}
}
