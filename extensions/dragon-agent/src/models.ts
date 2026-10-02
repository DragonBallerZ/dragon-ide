/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { OpenCodeServer } from './opencode/server';
import { changesModels, SessionBridge } from './opencode/sessionBridge';
import type { ModelInfo } from './opencode/types';
import { sortModels } from './catalog';

/** Vendor id the chat model picker groups OpenCode's models under. */
export const DRAGON_VENDOR = 'dragon';

export function toChatInformation(model: ModelInfo, isDefault: boolean): vscode.LanguageModelChatInformation {
	const context = model.limit?.context ?? 128_000;
	const output = model.limit?.output ?? 8_192;
	const local = ['ollama', 'splash'].includes(model.providerID);
	return {
		id: `${model.providerID}/${model.id}`,
		name: model.name || model.id,
		family: model.family ?? model.providerID,
		version: model.id,
		detail: local ? `Local · ${model.providerID === 'splash' ? 'Splash' : 'Ollama'}` : model.providerID,
		tooltip: `${model.name} (${model.providerID}/${model.id}), served by OpenCode`,
		maxInputTokens: Math.max(1, context - output),
		maxOutputTokens: output,
		capabilities: {
			toolCalling: model.capabilities?.tools ?? true,
			imageInput: model.capabilities?.input?.includes('image') ?? false,
		},
		isUserSelectable: true,
		isDefault,
	};
}

/**
 * Publishes the models the OpenCode server can run into the chat model picker. The picker
 * only selects; turns always run inside OpenCode, so direct language-model requests from
 * other extensions are refused rather than silently served outside the agent.
 */
export class DragonModels implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changed.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly server: OpenCodeServer, bridge: Pick<SessionBridge, 'subscribe' | 'onDidConnect'>, private readonly directory: () => string, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(vscode.lm.registerLanguageModelChatProvider(DRAGON_VENDOR, this));
		this.disposables.push(this.server.onDidChangeState(state => { if (state.kind === 'ready') { this.refresh(); } }));
		// A list read while OpenCode was still loading the workspace's providers holds its built-in models
		// instead, and the picker would keep them. List again when OpenCode reports a change, and after the
		// event stream reconnects, since missed events are not replayed.
		this.disposables.push(
			bridge.subscribe(event => { if (changesModels(event)) { this.refresh(); } }),
			bridge.onDidConnect(() => this.refresh()),
		);
	}

	refresh(): void {
		this.changed.fire();
	}

	async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions, _token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		try {
			const client = await this.server.ensure();
			const directory = this.directory();
			const [models, fallback] = await Promise.all([client.models(directory), client.defaultModel(directory).catch(() => null)]);
			const preferred = vscode.workspace.getConfiguration('dragon').get<string>('model')?.trim();
			const defaultId = preferred || (fallback ? `${fallback.providerID}/${fallback.id}` : undefined);
			return sortModels(models).map(model => toChatInformation(model, `${model.providerID}/${model.id}` === defaultId));
		} catch (err) {
			this.log.warn(`[models] could not list OpenCode models: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	async provideLanguageModelChatResponse(): Promise<void> {
		throw new Error('Dragon models run inside OpenCode. Use @dragon in the chat view.');
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
		const raw = typeof text === 'string' ? text : JSON.stringify(text.content);
		return Math.ceil(raw.length / 4);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.changed.dispose();
	}
}
