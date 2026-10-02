/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chooseLocalModel } from './picker';
import { detectHardware, GiB, modelBudget, unsupportedReason } from './catalog';
import { SplashModel, splashModels } from './splash';

export class SplashService implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private timer: NodeJS.Timeout | undefined;
	private terminal: vscode.Terminal | undefined;
	models: SplashModel[] = [];
	constructor(private readonly extensionPath: string, private readonly log: vscode.LogOutputChannel) { }

	async refresh(): Promise<void> {
		const next = await splashModels();
		if (JSON.stringify(next) !== JSON.stringify(this.models)) { this.models = next; this.changed.fire(); }
	}
	start(): void { this.timer = setInterval(() => void this.refresh(), 30_000); }

	async chooseAndStart(): Promise<string | undefined> {
		await this.refresh();
		if (this.models.length) {
			const pick = await vscode.window.showQuickPick(this.models.map(m => ({ label: m.id, id: m.id })), { title: 'Use the running Splash model' });
			return pick?.id;
		}
		const selected = await chooseLocalModel('splash');
		if (!selected) { return undefined; }
		const hardware = await detectHardware();
		const reason = unsupportedReason(selected, hardware);
		if (reason) { await vscode.window.showWarningMessage(reason); return undefined; }
		const version = await promisify(execFile)('/usr/bin/sw_vers', ['-productVersion']).then(r => r.stdout.trim()).catch(() => '0');
		const [major, minor] = version.split('.').map(Number);
		if (major < 26 || (major === 26 && minor < 4)) { await vscode.window.showWarningMessage('Splash needs macOS 26.4 or later. Ollama is also available.'); return undefined; }
		const bundled = path.join(this.extensionPath, 'bin', 'splash');
		const python = path.join(bundled, 'python', 'bin', 'python3');
		if (!existsSync(python)) {
			await vscode.window.showInformationMessage('This build does not include Splash. Install it from the official project, then start a model and choose Splash again.', 'Open Splash').then(p => p && vscode.env.openExternal(vscode.Uri.parse('https://github.com/incoai/splash')));
			return undefined;
		}
		const action = await vscode.window.showInformationMessage(`${selected.name} will download about ${selected.download} GB from Hugging Face, plus its draft and tokenizer. Model license: Apache-2.0. Downloads and prepared weights stay on this Mac.`, { modal: true }, 'Download and start', 'Model details');
		if (action === 'Model details') { await vscode.env.openExternal(vscode.Uri.parse(`https://huggingface.co/${selected.hf}`)); return undefined; }
		if (action !== 'Download and start') { return undefined; }
		const fresh = await detectHardware();
		const latestReason = unsupportedReason(selected, fresh);
		if (latestReason) { await vscode.window.showWarningMessage(latestReason); return undefined; }
		this.terminal?.dispose();
		this.terminal = vscode.window.createTerminal({ name: 'Splash · Local AI', shellPath: python, shellArgs: ['-u', path.join(bundled, 'install', 'launcher.py'), 'serve', '--model', selected.id, '--max-context', '32768', '--max-memory', `${Math.floor(modelBudget(fresh) / GiB)}G`, '--language-only'], cwd: os.homedir(), env: { PYTHONDONTWRITEBYTECODE: '1' } });
		const terminal = this.terminal;
		terminal.show();
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Setting up ${selected.name} · download progress is in the Splash terminal`, cancellable: true }, async (_progress, token) => {
			const deadline = Date.now() + 60 * 60_000;
			while (!token.isCancellationRequested && Date.now() < deadline && terminal.exitStatus === undefined) {
				await this.refresh();
				if (this.models.length) { this.log.info('[splash] local model ready'); return this.models[0].id; }
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
			terminal.dispose();
			if (!token.isCancellationRequested) { await vscode.window.showErrorMessage('Splash did not become ready. Check the Splash terminal and retry.'); }
			return undefined;
		});
	}
	dispose(): void { if (this.timer) { clearInterval(this.timer); } this.terminal?.dispose(); this.changed.dispose(); }
}
