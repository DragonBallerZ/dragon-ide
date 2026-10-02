/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isLoopbackOrigin } from '../ollama/ollama';
export const SPLASH_ORIGIN = 'http://127.0.0.1:8000';
export interface SplashModel { id: string; context: number; input: string[] }
export async function splashModels(origin = SPLASH_ORIGIN, fetchImpl: typeof fetch = fetch): Promise<SplashModel[]> {
	if (!isLoopbackOrigin(origin) || !/^https?:/.test(origin)) { return []; }
	try {
		const response = await fetchImpl(`${origin}/v1/models`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
		if (!response.ok) { return []; }
		const body = await response.json() as { data?: { id?: string; owned_by?: string; context_length?: number; input_modalities?: string[] }[] };
		return (Array.isArray(body.data) ? body.data : []).filter(m => m.owned_by === 'splash' && typeof m.id === 'string' && Number.isSafeInteger(m.context_length) && m.context_length! >= 32768)
			.map(m => ({ id: m.id!, context: m.context_length!, input: m.input_modalities?.filter(v => ['text', 'image', 'pdf'].includes(v)) ?? ['text'] }));
	} catch { return []; }
}
export function splashProvider(models: readonly SplashModel[]): object {
	return { name: 'Splash', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${SPLASH_ORIGIN}/v1`, apiKey: 'local' }, models: Object.fromEntries(models.map(m => [m.id, { name: m.id, limit: { context: m.context, output: 8192 }, capabilities: { tools: true, input: m.input, output: ['text'] } }])) };
}
