/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';
import { DRAGON_ONBOARDING_COMPLETED_KEY, DragonOnboarding } from './dragonOnboarding.js';

registerSingleton(IOnboardingService, DragonOnboarding, InstantiationType.Delayed);

/** Shows the onboarding screen on first launch, until the user enters the workspace. */
class DragonOnboardingStartup extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dragonOnboarding';

	constructor(
		@IOnboardingService onboardingService: IOnboardingService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		if (environmentService.skipWelcome || environmentService.isExtensionDevelopment) {
			return;
		}
		if (storageService.getBoolean(DRAGON_ONBOARDING_COMPLETED_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		if (configurationService.getValue<string>('dragon.model')?.trim()) {
			return; // a model is already configured
		}
		onboardingService.show();
	}
}

registerWorkbenchContribution2(DragonOnboardingStartup.ID, DragonOnboardingStartup, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'dragon.showOnboarding',
			title: localize2('dragon.showOnboarding', "Welcome to Dragon IDE"),
			category: localize2('dragon.category', "Dragon"),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IOnboardingService).show();
	}
});

/** Provider setup is available even before the agent extension activates in a trusted folder. */
registerAction2(class extends Action2 {
	private running = false;

	constructor() {
		super({
			id: 'dragon.connectAI',
			title: localize2('dragon.connectAI', "Connect AI"),
			category: localize2('dragon.category', "Dragon"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (this.running) {
			return;
		}
		const trust = accessor.get(IWorkspaceTrustRequestService);
		const commands = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);
		this.running = true;
		try {
			if (!await trust.requestWorkspaceTrust({
				message: localize('dragon.connect.trust', "Your AI can read and edit files and run commands in this folder. Trust it only if you trust its contents."),
			})) {
				return;
			}
			const model = await commands.executeCommand<string | undefined>('dragon.chooseModel');
			if (model) {
				// Select the newly connected model for the first turn, including Ollama's agent variant.
				await commands.executeCommand('workbench.action.chat.open', { modelSelector: { vendor: 'dragon', id: model } });
			}
		} catch (error) {
			notifications.error(error);
		} finally {
			this.running = false;
		}
	}
});

class DragonConnectStatus extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.dragonConnectStatus';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		const entry = () => {
			const configured = !!configurationService.getValue<string>('dragon.model')?.trim();
			const label = configured ? localize('dragon.manageAI', "Manage AI") : localize('dragon.connectAI', "Connect AI");
			return {
				name: 'FREEDOM AI', text: `$(flame) ${label}`, ariaLabel: label,
				tooltip: localize('dragon.connect.tooltip', "Connect an API key, sign in to a provider, or use a local model."),
				command: 'dragon.connectAI',
			};
		};
		const status = this._register(statusbarService.addEntry(entry(), 'dragon.connectAI', StatusbarAlignment.RIGHT, 110));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dragon.model')) {
				status.update(entry());
			}
		}));
	}
}

registerWorkbenchContribution2(DragonConnectStatus.ID, DragonConnectStatus, WorkbenchPhase.AfterRestored);
