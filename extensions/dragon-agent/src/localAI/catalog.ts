/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cpus, homedir, totalmem, platform, arch, release } from 'node:os';
import { statfs } from 'node:fs/promises';

export const GiB = 1024 ** 3;
export type Runtime = 'ollama' | 'splash';
export interface Hardware { ram: number; disk: number; platform: string; arch: string; chip: string; osMajor: number }
export interface LocalModel {
	id: string; name: string; runtime: Runtime; memory: number; disk: number; download: number; hf: string; note: string;
}

// Reviewed 2026-09-30. Memory includes weights, 32k context, runtime buffers and Splash's draft.
// Admission reserves a further max(6 GiB, 25% RAM) for macOS, the editor and other applications.
// Model licenses: Apache-2.0; source links are visible before downloading.
export const LOCAL_MODELS: readonly LocalModel[] = [
	{ id: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M', name: 'Qwen3.8 27B · Hugging Face', runtime: 'ollama', memory: 24, disk: 30, download: 16.5, hf: 'unsloth/Qwen3.8-27B-GGUF', note: 'Latest supported Qwen dense model from Hugging Face.' },
	{ id: 'qwen3.6:35b', name: 'Qwen3.6 35B-A3B', runtime: 'ollama', memory: 30, disk: 32, download: 23, hf: 'Qwen/Qwen3.6-35B-A3B', note: 'Fast mixture-of-experts coding model. All 35B weights must fit, despite 3B active parameters.' },
	{ id: 'qwen3.6:27b', name: 'Qwen3.6 27B', runtime: 'ollama', memory: 24, disk: 25, download: 18, hf: 'Qwen/Qwen3.6-27B', note: 'Strong reasoning and coding for larger machines.' },
	{ id: 'qwen3.5:9b', name: 'Qwen3.5 9B', runtime: 'ollama', memory: 11, disk: 12, download: 6.6, hf: 'Qwen/Qwen3.5-9B', note: 'Balanced local coding for 16-24 GB machines.' },
	{ id: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B', runtime: 'ollama', memory: 8, disk: 10, download: 4.7, hf: 'Qwen/Qwen2.5-Coder-7B-Instruct', note: 'Compact coding option; larger models handle complex tool use better.' },
	{ id: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M', name: 'Qwen3.8 27B · 4-bit', runtime: 'splash', memory: 27, disk: 55, download: 20, hf: 'unsloth/Qwen3.8-27B-GGUF', note: 'Latest supported Qwen dense model, with speculative decoding.' },
	{ id: 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M', name: 'Qwen3.6 35B-A3B · 4-bit', runtime: 'splash', memory: 30, disk: 65, download: 25, hf: 'unsloth/Qwen3.6-35B-A3B-GGUF', note: 'Fast coding model with a draft model; reserves room for both.' },
	{ id: 'unsloth/Qwen3.8-27B-GGUF:UD-IQ2_S', name: 'Qwen3.8 27B · compact 2-bit', runtime: 'splash', memory: 17, disk: 35, download: 12, hf: 'unsloth/Qwen3.8-27B-GGUF', note: 'Fits 24 GB Macs at a reduced precision; choose 4-bit when memory permits.' },
];

export async function detectHardware(storage = homedir()): Promise<Hardware> {
	const disk = await statfs(storage).then(s => s.bavail * s.bsize).catch(() => 0);
	return { ram: totalmem(), disk, platform: platform(), arch: arch(), chip: cpus()[0]?.model ?? '', osMajor: Number(release().split('.')[0]) };
}

export function modelBudget(hardware: Hardware): number {
	return Math.max(0, hardware.ram - Math.max(6 * GiB, hardware.ram * 0.25));
}

export function unsupportedReason(model: LocalModel, hardware: Hardware, installed = false): string | undefined {
	if (model.runtime === 'splash') {
		const generation = /Apple M(\d+)/.exec(hardware.chip);
		if (hardware.platform !== 'darwin' || hardware.arch !== 'arm64' || !generation || Number(generation[1]) < 3) { return 'Splash requires an Apple M3 or newer Mac'; }
		// Darwin 25 is macOS 26; the exact 26.4 requirement is checked before launching.
		if (hardware.osMajor < 25) { return 'Splash requires macOS 26.4 or newer'; }
	}
	if (model.memory * GiB > modelBudget(hardware)) { return `Needs about ${model.memory} GB for AI; this machine has ${(modelBudget(hardware) / GiB).toFixed(1)} GB after the system reserve`; }
	if (!installed && hardware.disk < (model.disk + 5) * GiB) { return `Needs ${model.disk + 5} GB free disk space, including download and system reserves`; }
	return undefined;
}
