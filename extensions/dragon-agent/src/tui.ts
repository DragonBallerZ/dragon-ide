/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { OpenCodeServer, resolveBinary, tuiArgs } from './opencode/server';

/**
 * The OpenCode TUI as a terminal profile. It attaches to the same server as the chat view, so
 * the two surfaces share sessions: a turn started in one is visible in the other.
 */
export class OpenCodeTui implements vscode.TerminalProfileProvider, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly server: OpenCodeServer, private readonly extensionPath: string, private readonly directory: () => string) {
		this.disposables.push(vscode.window.registerTerminalProfileProvider('dragon.opencode', this));
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

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
