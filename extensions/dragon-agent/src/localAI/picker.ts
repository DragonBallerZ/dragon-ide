/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { detectHardware, GiB, LOCAL_MODELS, LocalModel, modelBudget, Runtime, unsupportedReason } from './catalog';

/** A shared, conservative installation gate. Ineligible models are informative rows, never downloads. */
export async function chooseLocalModel(runtime: Runtime, installed: readonly string[] = [], storage?: string): Promise<LocalModel | undefined> {
	const hardware = await detectHardware(storage);
	const candidates = LOCAL_MODELS.filter(m => m.runtime === runtime);
	const has = (m: LocalModel) => installed.includes(m.id) || installed.includes(`${m.id}:latest`);
	const allowed = candidates.filter(m => !unsupportedReason(m, hardware, has(m)));
	type Item = vscode.QuickPickItem & { model?: LocalModel; reason?: string };
	const items: Item[] = [
		...allowed.map((m, i) => ({ label: `${i === 0 ? '$(star-full)' : '$(device-desktop)'} ${m.name}`, description: has(m) ? 'Installed' : `~${m.download} GB download · ~${m.memory} GB AI memory`, detail: `${m.note} • Apache-2.0 • huggingface.co/${m.hf}`, model: m })),
		{ label: 'Too large or unsupported on this machine', kind: vscode.QuickPickItemKind.Separator },
		...candidates.filter(m => !allowed.includes(m)).map(m => ({ label: `$(lock) ${m.name}`, detail: unsupportedReason(m, hardware, has(m)), reason: unsupportedReason(m, hardware, has(m)) })),
	];
	const picked = await vscode.window.showQuickPick(items, { title: `Set up local AI · ${runtime === 'splash' ? 'Splash' : 'Ollama'}`, placeHolder: `${hardware.chip || hardware.arch} · ${Math.round(hardware.ram / GiB)} GB RAM · ${(modelBudget(hardware) / GiB).toFixed(1)} GB AI budget · ${Math.floor(hardware.disk / GiB)} GB free disk`, matchOnDetail: true });
	if (picked?.reason) { await vscode.window.showInformationMessage(picked.reason); return chooseLocalModel(runtime, installed, storage); }
	if (!picked?.model) { return undefined; }
	// Recheck immediately before any download, in case available disk space changed while choosing.
	const reason = unsupportedReason(picked.model, await detectHardware(storage), has(picked.model));
	if (reason) { await vscode.window.showWarningMessage(reason); return undefined; }
	return picked.model;
}
