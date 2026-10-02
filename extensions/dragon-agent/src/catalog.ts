/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IntegrationInfo, ModelInfo } from './opencode/types';

/** Providers listed first in the picker, in this order. Everything else follows by name. */
const PROVIDER_ORDER = ['ollama', 'splash', 'opencode', 'anthropic', 'openai', 'google', 'openrouter'];

// Copilot connections remain owned by OpenCode, but are not offered in Dragon's UI.
const isVisibleProvider = (id: string) => !/(?:^|-)copilot(?:-|$)/i.test(id);

export function sortModels(models: readonly ModelInfo[]): ModelInfo[] {
	const rank = (providerID: string) => {
		const index = PROVIDER_ORDER.indexOf(providerID);
		return index === -1 ? PROVIDER_ORDER.length : index;
	};
	// An Ollama model with a Dragon agent variant (a bigger context window) is shown only as the variant.
	const ollamaIds = models.filter(model => model.providerID === 'ollama').map(model => model.id);
	const hasAgentVariant = (model: ModelInfo) => model.providerID === 'ollama' && ollamaIds.some(id => id.startsWith(`${model.id}-dragon-`));
	return [...models]
		.filter(model => isVisibleProvider(model.providerID) && model.enabled && model.status !== 'deprecated' && !hasAgentVariant(model))
		.sort((a, b) => rank(a.providerID) - rank(b.providerID) || a.providerID.localeCompare(b.providerID) || a.name.localeCompare(b.name));
}

/** Providers offered first when connecting with a key or a sign-in. */
export const FEATURED_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'opencode', 'xai', 'gitlab'];

export interface ProviderChoice {
	readonly id: string;
	readonly name: string;
}

export interface SignInChoice extends ProviderChoice {
	readonly methodID: string;
	readonly label: string;
}

export function featuredIntegrations(integrations: readonly IntegrationInfo[]): { key: ProviderChoice[]; signIn: SignInChoice[] } {
	const rank = (id: string) => {
		const index = FEATURED_PROVIDERS.indexOf(id);
		return index === -1 ? FEATURED_PROVIDERS.length : index;
	};
	const sorted = integrations.filter(i => isVisibleProvider(i.id)).sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
	const key = sorted.filter(i => i.methods.some(m => m.type === 'key')).map(i => ({ id: i.id, name: i.name }));
	const signIn = sorted.flatMap(i => i.methods.filter(m => m.type === 'oauth').map(m => ({ id: i.id, name: i.name, methodID: (m as { id: string }).id, label: (m as { label: string }).label })));
	return { key, signIn };
}

/** The best model to default to after a provider was connected. */
export function pickDefaultModel(models: readonly ModelInfo[], providerID: string): ModelInfo | undefined {
	const candidates = models.filter(m => isVisibleProvider(m.providerID) && m.providerID === providerID && m.enabled && m.status !== 'deprecated' && m.capabilities?.tools !== false);
	return candidates.find(m => m.status === 'active' || m.status === undefined) ?? candidates[0];
}
