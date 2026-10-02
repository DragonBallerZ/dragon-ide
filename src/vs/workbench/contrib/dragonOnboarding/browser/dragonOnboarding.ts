/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/dragonOnboarding.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';

export const DRAGON_ONBOARDING_COMPLETED_KEY = 'dragon.onboarding.completed';

/** A credential-free entrance. Provider setup lives in the workbench's Connect AI action. */
export class DragonOnboarding extends Disposable implements IOnboardingService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidDismiss = this._register(new Emitter<void>());
	readonly onDidDismiss = this._onDidDismiss.event;
	private readonly visible = this._register(new DisposableStore());
	private root: HTMLElement | undefined;
	private leaving = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
	}

	get isVisible(): boolean {
		return !!this.root;
	}

	show(): void {
		if (this.root) {
			return;
		}
		const previousFocus = mainWindow.document.activeElement;
		const root = this.root = $('.dragon-onboarding', {
			role: 'dialog', 'aria-modal': 'true',
			'aria-label': localize('dragonOnboarding.label', "Welcome to Dragon IDE"),
		});
		const panel = append(root, $('.dragon-onboarding-panel'));
		append(panel, $('p.dragon-onboarding-eyebrow', undefined, localize('dragonOnboarding.eyebrow', "YOUR IDE. YOUR AI. YOUR RULES.")));
		const logo = append(panel, $('.dragon-onboarding-logo', { 'aria-hidden': 'true' }));
		logo.style.backgroundImage = `url("${FileAccess.asBrowserUri('vs/workbench/browser/parts/editor/media/dragon-mark.png').toString(true)}")`;
		append(panel, $('h1.dragon-onboarding-title', undefined, 'Dragon IDE'));
		append(panel, $('p.dragon-onboarding-copy', undefined, localize('dragonOnboarding.copy', "Build whatever comes next.")));
		const enter = append(panel, $('button.dragon-onboarding-enter', { type: 'button' }, localize('dragonOnboarding.enter', "Enter FREEDOM AI")));
		append(enter, $('span.dragon-onboarding-arrow', { 'aria-hidden': 'true' }, '\u2197'));
		append(panel, $('p.dragon-onboarding-hint', undefined, localize('dragonOnboarding.hint', "No account needed. Connect your AI whenever you\u2019re ready.")));
		this.visible.add(addDisposableListener(enter, EventType.CLICK, () => this.dismiss(previousFocus)));
		this.visible.add(addDisposableListener(root, EventType.KEY_DOWN, e => {
			const event = e as KeyboardEvent;
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.dismiss(previousFocus);
			} else if (event.key === 'Tab') {
				// The entrance has exactly one control; keep keyboard focus within the dialog.
				event.preventDefault();
				enter.focus();
			}
		}));
		this.layoutService.mainContainer.appendChild(root);
		this.visible.add(toDisposable(() => root.remove()));
		enter.focus();
	}

	private dismiss(previousFocus: Element | null): void {
		const root = this.root;
		if (!root || this.leaving) {
			return;
		}
		this.leaving = true;
		this.storageService.store(DRAGON_ONBOARDING_COMPLETED_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
		root.classList.add('dragon-onboarding-leaving');
		const delay = mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260;
		const timer = mainWindow.setTimeout(() => {
			this.visible.clear();
			this.root = undefined;
			this.leaving = false;
			if (previousFocus instanceof mainWindow.HTMLElement && previousFocus.isConnected && previousFocus !== mainWindow.document.body) {
				previousFocus.focus();
			} else {
				this.layoutService.mainContainer.focus();
			}
			this._onDidDismiss.fire();
		}, delay);
		this.visible.add(toDisposable(() => mainWindow.clearTimeout(timer)));
	}
}
