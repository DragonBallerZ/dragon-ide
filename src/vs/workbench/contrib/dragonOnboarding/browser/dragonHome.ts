/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

/** An explicit setup action on the Welcome page, independent of keyboard shortcut tips. */
export class DragonHomeActions extends Disposable {
	constructor(
		container: HTMLElement,
		@ICommandService commandService: ICommandService,
		@IConfigurationService configurationService: IConfigurationService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		const actions = append(container, $('.dragon-home-actions'));
		append(actions, $('.dragon-home-title', undefined, 'Dragon IDE'));
		const connect = append(actions, $('button.dragon-home-connect', { type: 'button' }));
		const refresh = () => {
			connect.textContent = configurationService.getValue<string>('dragon.model')?.trim()
				? localize('dragon.home.manage', "Manage AI")
				: localize('dragon.home.connect', "Connect AI");
		};
		refresh();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dragon.model')) {
				refresh();
			}
		}));
		this._register(addDisposableListener(connect, EventType.CLICK, () => {
			void commandService.executeCommand('dragon.connectAI').catch(error => notificationService.error(error));
		}));
	}
}
