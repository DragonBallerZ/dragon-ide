/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { availableUpdate, DragonProduct } from './release';

const SKIPPED_KEY = 'dragon.updates.skippedVersion';
const LAST_CHECK_KEY = 'dragon.updates.lastCheck';
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30_000;

/**
 * Tells the user when a newer Dragon IDE release is published. Once a day, and only when
 * `dragon.updates.check` is on, it makes one anonymous request to the release feed named in
 * product.json. Nothing is downloaded or installed without a click.
 */
export class UpdateChecker implements vscode.Disposable {
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly product: DragonProduct, private readonly log: vscode.LogOutputChannel) { }

	private enabled(): boolean {
		return vscode.workspace.getConfiguration('dragon.updates').get<boolean>('check', true);
	}

	start(): void {
		const lastCheck = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
		const due = Math.max(FIRST_CHECK_DELAY_MS, lastCheck + DAY_MS - Date.now());
		this.timer = setTimeout(() => {
			void this.check(false);
			this.timer = setInterval(() => void this.check(false), DAY_MS);
		}, due);
	}

	/** Checks now. Interactive checks also report "up to date" and errors. */
	async check(interactive: boolean): Promise<void> {
		if (!interactive && !this.enabled()) {
			return;
		}
		if (!this.product.version || !this.product.updateFeed) {
			if (interactive) {
				vscode.window.showInformationMessage(vscode.l10n.t('This build of Dragon IDE has no release feed, so it cannot check for updates.'));
			}
			return;
		}
		await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
		try {
			const update = await availableUpdate(this.product);
			if (!update) {
				this.log.info(`[updates] ${this.product.version} is up to date`);
				if (interactive) {
					vscode.window.showInformationMessage(vscode.l10n.t('Dragon IDE {0} is the latest version.', this.product.version));
				}
				return;
			}
			if (!interactive && this.context.globalState.get<string>(SKIPPED_KEY) === update.version) {
				return;
			}
			this.log.info(`[updates] ${update.version} is available (running ${this.product.version})`);
			const download = vscode.l10n.t('Download');
			const skip = vscode.l10n.t('Skip This Version');
			const pick = await vscode.window.showInformationMessage(
				vscode.l10n.t('Dragon IDE {0} is available. You have {1}.', update.version, this.product.version),
				download, skip);
			if (pick === download) {
				await vscode.env.openExternal(vscode.Uri.parse(update.url));
			} else if (pick === skip) {
				await this.context.globalState.update(SKIPPED_KEY, update.version);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log.info(`[updates] check failed: ${message}`);
			if (interactive) {
				vscode.window.showWarningMessage(vscode.l10n.t('Could not check for updates: {0}.', message));
			}
		}
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			clearInterval(this.timer);
		}
	}
}
