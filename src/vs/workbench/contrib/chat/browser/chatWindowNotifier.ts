/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler, timeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableResourceMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorunDelta, autorunIterableDelta, IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IChatModel, IChatRequestNeedsInputInfo } from '../common/model/chatModel.js';
import { observeChatModelIsIdle } from '../common/model/chatModelIdle.js';
import { IChatQuestionAnswers, IChatQuestionCarousel, IChatService, IChatToolInvocation, ToolConfirmKind } from '../common/chatService/chatService.js';
import { ChatQuestionCarouselData } from '../common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { migrateLegacyTerminalToolSpecificData } from '../common/chat.js';
import { ChatNotificationKind, getChatNotificationDedupeKey } from '../common/chatNotification.js';
import { ChatConfiguration, ChatNotificationMode } from '../common/constants.js';
import { IChatWidgetService } from './chat.js';

/**
 * Whether the session's last response finished while this window was watching it.
 *
 * Loading a session replays its history through the same add-request-then-complete
 * path that live work uses, so the busy -> idle transition alone cannot tell a
 * session that was restored from one that just finished. A replayed response keeps
 * the completion time it originally had, or has none at all when that time was
 * never recorded, while a response completing here is stamped as it finishes.
 */
function hasCompletedSince(model: IChatModel, watchingSince: number): boolean {
	const completedAt = model.lastRequest?.response?.completionTimestamp;
	return completedAt !== undefined && completedAt >= watchingSince;
}

/**
 * Observes all live chat models and triggers OS notifications when any model
 * transitions to needing input or becomes idle.
 */
export class ChatWindowNotifier extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatWindowNotifier';

	private readonly _activeNotifications = this._register(new DisposableResourceMap());

	/** DRAGON: the prompts in this window for chats that need input and are not on screen. */
	private readonly _offScreenPrompts = this._register(new DisposableResourceMap());

	constructor(
		@IChatService private readonly _chatService: IChatService,
		@IChatWidgetService private readonly _chatWidgetService: IChatWidgetService,
		@IHostService private readonly _hostService: IHostService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();

		const modelTrackers = this._register(new DisposableResourceMap());

		this._register(autorunIterableDelta(
			reader => this._chatService.chatModels.read(reader),
			({ addedValues, removedValues }) => {
				for (const model of addedValues) {
					modelTrackers.set(model.sessionResource, this._trackModel(model));
				}
				for (const model of removedValues) {
					modelTrackers.deleteAndDispose(model.sessionResource);
				}
			}
		));
	}

	/**
	 * Delay before an idle session is announced, to swallow the brief idle gap
	 * between a turn ending and the next queued turn starting. A method rather
	 * than a field so tests can override it before `_trackModel` runs during
	 * construction.
	 */
	protected _getIdleNotificationDelay(): number {
		return 500;
	}

	/**
	 * Delay before a toast from a window that is not showing the session, so that
	 * a window showing it notifies first.
	 */
	protected _getBackgroundNotificationDelay(): number {
		return 250;
	}

	private _trackModel(model: IChatModel) {
		const store = new DisposableStore();
		const isIdle = observeChatModelIsIdle(model);
		const watchingSince = Date.now();
		const idleScheduler = store.add(new RunOnceScheduler(() => void this._notifyIdleIfNeeded(model, isIdle, watchingSince), this._getIdleNotificationDelay()));
		store.add(autorunDelta(model.requestNeedsInput, ({ lastValue, newValue }) => {
			const currentNeedsInput = !!newValue;
			const previousNeedsInput = !!lastValue;

			// Only notify on transition from false -> true
			if (!previousNeedsInput && currentNeedsInput && newValue) {
				this._notifyIfNeeded(model.sessionResource, newValue);
				void this._promptIfOffScreen(model.sessionResource, newValue);
			} else if (previousNeedsInput && !currentNeedsInput) {
				// Clear any active notification for this session when input is no longer needed
				this._clearNotification(model.sessionResource);
				this._offScreenPrompts.deleteAndDispose(model.sessionResource);
			}
		}));
		store.add(autorunDelta(isIdle, ({ lastValue, newValue }) => {
			// Only notify on a genuine busy -> idle transition of a response that finished
			// here, never for a model that was created idle or one replaying its history.
			if (lastValue === false && newValue === true && hasCompletedSince(model, watchingSince)) {
				idleScheduler.schedule();
			} else if (!newValue) {
				idleScheduler.cancel();
			}
		}));
		return store;
	}

	private async _notifyIfNeeded(sessionResource: URI, info: IChatRequestNeedsInputInfo): Promise<void> {
		// Check configuration
		const mode = this._configurationService.getValue<ChatNotificationMode>(ChatConfiguration.NotifyWindowOnConfirmation);
		if (mode === ChatNotificationMode.Off) {
			return;
		}

		// Find the widget to determine the target window
		const widget = this._chatWidgetService.getWidgetBySessionResource(sessionResource);
		const targetWindow = widget ? dom.getWindow(widget.domNode) : mainWindow;
		await this._delayForBackgroundWindow(widget?.visible === true);
		if (!this._chatService.getSession(sessionResource)?.requestNeedsInput.get()) {
			return;
		}

		const isFocused = targetWindow.document.hasFocus();
		if (mode !== ChatNotificationMode.Always && isFocused) {
			return;
		}

		// Clear any existing notification for this session
		this._clearNotification(sessionResource);

		// Focus window in notify mode (flash taskbar/dock) if not already focused
		if (!isFocused) {
			await this._hostService.focus(targetWindow, { mode: FocusMode.Notify });
		}

		// Create OS notification
		const notificationTitle = info.title ? localize('chatTitle', "Session: {0}", info.title) : localize('chat.untitledChat', "Untitled Session");

		const cts = new CancellationTokenSource();
		this._activeNotifications.set(sessionResource, toDisposable(() => cts.dispose(true)));

		// Determine if the pending input is for a question carousel
		const isQuestionCarousel = this._isQuestionCarouselPending(sessionResource);

		try {
			const actionLabel = isQuestionCarousel
				? localize('openChatAction', "Open Session")
				: localize('allowAction', "Allow");

			const result = await this._hostService.showToast({
				title: this._sanitizeOSToastText(notificationTitle),
				body: this._getNotificationBody(sessionResource, info, isQuestionCarousel),
				actions: [actionLabel],
				dedupeKey: getChatNotificationDedupeKey(sessionResource, ChatNotificationKind.NeedsInput),
			}, cts.token);

			if (result.actionIndex === 0 && !isQuestionCarousel && this._confirmAllow(sessionResource)) {
				return; // skip focusing/opening chat if we successfully confirmed the tool invocation from the toast action
			}

			if (result.clicked || typeof result.actionIndex === 'number') {
				await this._hostService.focus(targetWindow, { mode: FocusMode.Force });

				const widget = await this._chatWidgetService.openSession(sessionResource);
				widget?.focusInput();
			}
		} finally {
			this._clearNotification(sessionResource);
		}
	}

	/**
	 * DRAGON: a chat that needs input and is not on screen, such as an agent's chat in a tab behind
	 * another, asks in this window too, whether or not it has focus. Its approval card shows only in
	 * that tab, and the agent waited there unseen while the user talked to the chat that leads it. The
	 * prompt offers the card's choices when it asks one question with options, and closes once the
	 * chat no longer needs input.
	 */
	private async _promptIfOffScreen(sessionResource: URI, info: IChatRequestNeedsInputInfo): Promise<void> {
		if (this._configurationService.getValue<ChatNotificationMode>(ChatConfiguration.NotifyWindowOnConfirmation) === ChatNotificationMode.Off) {
			return;
		}
		await timeout(this._getBackgroundNotificationDelay());
		const model = this._chatService.getSession(sessionResource);
		if (!model?.requestNeedsInput.get() || this._chatWidgetService.getWidgetBySessionResource(sessionResource)?.visible) {
			return;
		}
		const request = model.lastRequest;
		const carousel = request?.response?.response.value.find((part): part is IChatQuestionCarousel => part.kind === 'questionCarousel' && !part.isUsed);
		const question = carousel?.questions.length === 1 ? carousel.questions[0] : undefined;
		const choices: IPromptChoice[] = [];
		if (request && carousel && question?.type === 'singleSelect') {
			for (const option of question.options ?? []) {
				choices.push({ label: option.label, run: () => this._answerQuestion(request.id, carousel, { [question.id]: { selectedValue: option.value } }) });
			}
		}
		choices.push({
			label: localize('dragon.chatOffScreen.show', "Show Chat"),
			run: async () => (await this._chatWidgetService.openSession(sessionResource))?.focusInput(),
		});
		const title = info.title || localize('chat.untitledChat', "Untitled Session");
		const detail = typeof question?.message === 'string' ? question.message : question?.message?.value;
		const message = question && detail ? localize('dragon.chatOffScreen.asksAbout', "{0} asks: {1} {2}", title, detail, question.title)
			: localize('dragon.chatOffScreen.asks', "{0} asks: {1}", title, question?.title ?? info.detail ?? localize('notificationDetail', "Approval needed to continue."));
		const prompt = this._notificationService.prompt(Severity.Info, message, choices, { sticky: true });
		this._offScreenPrompts.set(sessionResource, toDisposable(() => prompt.close()));
	}

	/** DRAGON: answers a question card from outside the chat's list, as the card's own submit does. */
	private _answerQuestion(requestId: string, carousel: IChatQuestionCarousel, answers: IChatQuestionAnswers): void {
		if (carousel.isUsed) {
			return;
		}
		if (carousel instanceof ChatQuestionCarouselData) {
			carousel.dismiss(answers);
		} else {
			carousel.data = answers;
			carousel.isUsed = true;
		}
		if (carousel.resolveId) {
			this._chatService.notifyQuestionCarouselAnswer(requestId, carousel.resolveId, answers);
		}
	}

	private async _notifyIdleIfNeeded(model: IChatModel, isIdle: IObservable<boolean>, watchingSince: number): Promise<void> {
		if (!hasCompletedSince(model, watchingSince) || !isIdle.get() || model.requestNeedsInput.get()) {
			return;
		}
		const mode = this._configurationService.getValue<ChatNotificationMode>(ChatConfiguration.NotifyWindowOnResponseReceived);
		if (mode === ChatNotificationMode.Off) {
			return;
		}
		const widget = this._chatWidgetService.getWidgetBySessionResource(model.sessionResource);
		const targetWindow = widget ? dom.getWindow(widget.domNode) : mainWindow;
		await this._delayForBackgroundWindow(widget?.visible === true);
		if (!isIdle.get() || model.requestNeedsInput.get()) {
			return;
		}
		const isFocused = targetWindow.document.hasFocus();
		if (mode !== ChatNotificationMode.Always && isFocused) {
			return;
		}
		this._clearNotification(model.sessionResource);
		if (!isFocused) {
			await this._hostService.focus(targetWindow, { mode: FocusMode.Notify });
		}
		const cts = new CancellationTokenSource();
		this._activeNotifications.set(model.sessionResource, toDisposable(() => cts.dispose(true)));
		try {
			const title = model.title ? localize('chatTitle', "Session: {0}", model.title) : localize('chat.untitledChat', "Untitled Session");
			const result = await this._hostService.showToast({
				title: this._sanitizeOSToastText(title),
				body: localize('chat.idleNotificationDetail', "Session finished."),
				actions: [localize('openChatAction', "Open Session")],
				dedupeKey: getChatNotificationDedupeKey(model.sessionResource, ChatNotificationKind.Idle),
			}, cts.token);
			if (result.clicked || typeof result.actionIndex === 'number') {
				await this._hostService.focus(targetWindow, { mode: FocusMode.Force });
				const openedWidget = await this._chatWidgetService.openSession(model.sessionResource);
				openedWidget?.focusInput();
			}
		} finally {
			this._clearNotification(model.sessionResource);
		}
	}

	private async _delayForBackgroundWindow(isWidgetVisible: boolean): Promise<void> {
		if (isWidgetVisible && await this._hostService.hadLastFocus()) {
			return;
		}
		await timeout(this._getBackgroundNotificationDelay());
	}

	private _confirmAllow(sessionResource: URI): boolean {
		const model = this._chatService.getSession(sessionResource);
		const lastResponse = model?.lastRequest?.response;
		if (!lastResponse) {
			return false;
		}
		for (const part of lastResponse.response.value) {
			const state = part.kind === 'toolInvocation' ? part.state.get() : undefined;
			if (state?.type === IChatToolInvocation.StateKind.WaitingForConfirmation || state?.type === IChatToolInvocation.StateKind.WaitingForPostApproval) {
				state.confirm({ type: ToolConfirmKind.UserAction });
				return true;
			}
		}
		return false;
	}

	private _getNotificationBody(sessionResource: URI, info: IChatRequestNeedsInputInfo, isQuestionCarousel: boolean): string {
		if (isQuestionCarousel) {
			return localize('questionCarouselDetail', "Questions need your input.");
		}
		const terminalCommand = this._getPendingTerminalCommand(sessionResource);
		if (terminalCommand) {
			return this._sanitizeOSToastText(terminalCommand);
		}
		if (info.detail) {
			return this._sanitizeOSToastText(info.detail);
		}
		return localize('notificationDetail', "Approval needed to continue.");
	}

	private _getPendingTerminalCommand(sessionResource: URI): string | undefined {
		const model = this._chatService.getSession(sessionResource);
		const lastResponse = model?.lastRequest?.response;
		if (!lastResponse?.response?.value) {
			return undefined;
		}
		for (const part of lastResponse.response.value) {
			if (part.kind === 'toolInvocation' && part.toolSpecificData?.kind === 'terminal') {
				const state = part.state.get();
				if (state?.type !== IChatToolInvocation.StateKind.WaitingForConfirmation && state?.type !== IChatToolInvocation.StateKind.WaitingForPostApproval) {
					continue;
				}
				const terminalData = migrateLegacyTerminalToolSpecificData(part.toolSpecificData);
				return terminalData.commandLine.forDisplay ?? terminalData.commandLine.userEdited ?? terminalData.commandLine.toolEdited ?? terminalData.commandLine.original;
			}
		}
		return undefined;
	}

	private _isQuestionCarouselPending(sessionResource: URI): boolean {
		const model = this._chatService.getSession(sessionResource);
		const lastResponse = model?.lastRequest?.response;
		if (!lastResponse) {
			return false;
		}
		return lastResponse.response.value.some(
			part => part.kind === 'questionCarousel' && !part.isUsed
		);
	}

	private _sanitizeOSToastText(text: string): string {
		return text.replace(/`/g, '\''); // convert backticks to single quotes
	}

	private _clearNotification(sessionResource: URI): void {
		this._activeNotifications.deleteAndDispose(sessionResource);
	}
}
