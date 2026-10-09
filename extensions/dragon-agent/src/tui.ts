/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as vscode from 'vscode';
import { openCodeLogDirectory, readCliFailure } from './opencode/logs';
import { OpenCodeServer, resolveBinary, tuiArgs } from './opencode/server';

/** How long before its terminal opened a terminal UI may have started logging. */
const LAUNCH_SLACK_MS = 5_000;

/**
 * The OpenCode TUI as a terminal profile. It attaches to the same server as the chat view, so
 * the two surfaces share sessions: a turn started in one is visible in the other.
 */
export class OpenCodeTui implements vscode.TerminalProfileProvider, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	/** When each terminal UI's terminal opened. */
	private readonly openedAt = new Map<vscode.Terminal, number>();

	constructor(private readonly server: OpenCodeServer, private readonly extensionPath: string, private readonly directory: () => string) {
		this.disposables.push(
			vscode.window.registerTerminalProfileProvider('dragon.opencode', this),
			vscode.window.onDidOpenTerminal(terminal => {
				if (terminalArgs(terminal)) {
					this.openedAt.set(terminal, Date.now());
				}
			}),
			vscode.window.onDidCloseTerminal(terminal => this.closed(terminal)),
		);
	}

	async options(sessionID?: string): Promise<vscode.TerminalOptions> {
		await this.server.ensure();
		const state = this.server.state;
		if (state.kind !== 'ready') {
			throw new Error('OpenCode is not running.');
		}
		const binary = resolveBinary({ configuredBinary: vscode.workspace.getConfiguration('dragon.opencode').get<string>('path'), extensionPath: this.extensionPath });
		if (!binary) {
			throw new Error('The OpenCode binary was not found.');
		}
		return {
			name: 'OpenCode',
			shellPath: binary,
			shellArgs: tuiArgs(state.url, sessionID),
			cwd: this.directory(),
			iconPath: new vscode.ThemeIcon('flame'),
			env: {
				OPENCODE_PASSWORD: this.server.serverPassword,
				OPENCODE_DISABLE_AUTOUPDATE: '1',
			},
			isTransient: true,
		};
	}

	async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
		return new vscode.TerminalProfile(await this.options());
	}

	async open(sessionID?: string): Promise<void> {
		const terminal = vscode.window.createTerminal({ ...(await this.options(sessionID)), location: vscode.TerminalLocation.Editor });
		terminal.show();
	}

	/**
	 * A terminal UI that fails closes its terminal, and with it what it printed, so the reason
	 * OpenCode logged for that run is shown instead.
	 */
	private async closed(terminal: vscode.Terminal): Promise<void> {
		const openedAt = this.openedAt.get(terminal);
		this.openedAt.delete(terminal);
		const args = terminalArgs(terminal);
		const exit = terminal.exitStatus;
		if (openedAt === undefined || !args || exit?.reason !== vscode.TerminalExitReason.Process || !exit.code) {
			return;
		}
		const failure = await readCliFailure(openCodeLogDirectory(process.env, os.homedir()), args, openedAt - LAUNCH_SLACK_MS);
		if (!failure) {
			return;
		}
		const showLog = vscode.l10n.t('Show Log');
		const message = /different Team IDs|code signature/.test(failure.reason)
			? vscode.l10n.t('OpenCode\'s terminal UI stopped: macOS would not load a library it unpacked, because of how OpenCode is signed. {0}', failure.reason)
			: vscode.l10n.t('OpenCode\'s terminal UI stopped: {0}', failure.reason);
		if (await vscode.window.showErrorMessage(message, showLog) === showLog) {
			await vscode.window.showTextDocument(vscode.Uri.file(failure.file), { preview: true });
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

/** The arguments of a terminal running the terminal UI, or undefined for any other terminal. */
function terminalArgs(terminal: vscode.Terminal): string[] | undefined {
	const options = terminal.creationOptions as vscode.TerminalOptions;
	const args = options.shellArgs;
	return options.name === 'OpenCode' && Array.isArray(args) && args[0] === '--server' ? args : undefined;
}
