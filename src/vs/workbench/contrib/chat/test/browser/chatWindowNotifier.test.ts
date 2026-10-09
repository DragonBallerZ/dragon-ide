/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FocusMode } from '../../../../../platform/native/common/native.js';
import { INotificationHandle, IPromptChoice, NoOpNotification, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IChatWidget, IChatWidgetService } from '../../browser/chat.js';
import { ChatWindowNotifier } from '../../browser/chatWindowNotifier.js';
import { IChatQuestionAnswers, IChatResponseErrorDetails, IChatService } from '../../common/chatService/chatService.js';
import { ChatConfiguration, ChatNotificationMode } from '../../common/constants.js';
import { IChatModel, IChatPendingRequest, IChatProgressResponseContent, IChatRequestModel, IChatRequestNeedsInputInfo, IChatResponseModel, IResponse } from '../../common/model/chatModel.js';
import { ChatQuestionCarouselData } from '../../common/model/chatProgressTypes/chatQuestionCarouselData.js';
import { IChatAgentResult } from '../../common/participants/chatAgents.js';
import { IHostService, IToastOptions, IToastResult } from '../../../../services/host/browser/host.js';

class TestHostService extends mock<IHostService>() {
	override readonly onDidChangeFocus = Event.None;
	override readonly onDidChangeActiveWindow = Event.None;
	override readonly onDidChangeFullScreen = Event.None;
	override hasFocus = false;
	readonly toasts: IToastOptions[] = [];

	override async hadLastFocus(): Promise<boolean> {
		return true;
	}

	override async focus(_targetWindow: Window, _options?: { mode?: FocusMode }): Promise<void> { }

	override async showToast(options: IToastOptions, _token: CancellationToken): Promise<IToastResult> {
		this.toasts.push(options);
		return { supported: true, clicked: false };
	}
}

class TestChatService extends mock<IChatService>() {
	override readonly chatModels = observableValue<readonly IChatModel[]>('chatModels', []);
	readonly carouselAnswers: { requestId: string; resolveId: string; answers: IChatQuestionAnswers | undefined }[] = [];

	override notifyQuestionCarouselAnswer(requestId: string, resolveId: string, answers: IChatQuestionAnswers | undefined): void {
		this.carouselAnswers.push({ requestId, resolveId, answers });
	}

	override getSession(sessionResource: URI): IChatModel | undefined {
		return this.chatModels.get().find(model => model.sessionResource.toString() === sessionResource.toString());
	}
}

class TestChatWidgetService extends mock<IChatWidgetService>() {
	readonly widget: IChatWidget;

	constructor(visible = true) {
		super();
		this.widget = new class extends mock<IChatWidget>() {
			override readonly domNode = document.createElement('div');
			override readonly visible = visible;
		};
	}

	override getWidgetBySessionResource(_sessionResource: URI): IChatWidget {
		return this.widget;
	}
}

class TestPromptNotificationService extends TestNotificationService {
	readonly prompts: { message: string; choices: IPromptChoice[]; closed: boolean }[] = [];

	override prompt(_severity: Severity, message: string, choices: IPromptChoice[]): INotificationHandle {
		const prompt = { message, choices, closed: false };
		this.prompts.push(prompt);
		return new class extends NoOpNotification {
			override close(): void {
				prompt.closed = true;
			}
		};
	}
}

function createModel(store: Pick<DisposableStore, 'add'>, id: string, options: { requestInProgress?: boolean; hasRequest?: boolean; parts?: IChatProgressResponseContent[] } = {}): {
	model: IChatModel;
	requestInProgress: ReturnType<typeof observableValue<boolean>>;
	requestNeedsInput: ReturnType<typeof observableValue<IChatRequestNeedsInputInfo | undefined>>;
	setPendingRequestCount: (count: number) => void;
	endLastResponse: (outcome?: { isCanceled?: boolean; errorDetails?: IChatResponseErrorDetails; completionTimestamp?: number | null }) => void;
} {
	const requestInProgress = observableValue<boolean>(`in-progress-${id}`, options.requestInProgress ?? true);
	const requestNeedsInput = observableValue<IChatRequestNeedsInputInfo | undefined>(`needs-input-${id}`, undefined);
	const onDidChangePendingRequests = store.add(new Emitter<void>());
	let pendingRequests: readonly IChatPendingRequest[] = [];
	const response = new class extends mock<IChatResponseModel>() {
		override isCanceled = false;
		override result: IChatAgentResult | undefined = undefined;
		override completionTimestamp: number | undefined = undefined;
		override readonly response = new class extends mock<IResponse>() {
			override readonly value = options.parts ?? [];
		};
	};
	const lastRequest = options.hasRequest === false ? undefined : new class extends mock<IChatRequestModel>() {
		override readonly id = `request-${id}`;
		override readonly response = response;
	};
	const lastRequestObs = observableValue<IChatRequestModel | undefined>(`last-request-${id}`, lastRequest);
	const model = new class extends mock<IChatModel>() {
		override readonly sessionResource = URI.parse(`test:///${id}`);
		override readonly title = `Fix ${id}`;
		override readonly lastRequest = lastRequest;
		override readonly lastRequestObs = lastRequestObs;
		override readonly requestInProgress = requestInProgress;
		override readonly requestNeedsInput = requestNeedsInput;
		override readonly onDidChangePendingRequests = onDidChangePendingRequests.event;
		override getPendingRequests(): readonly IChatPendingRequest[] {
			return pendingRequests;
		}
	};
	const setPendingRequestCount = (count: number) => {
		pendingRequests = Array.from({ length: count }, () => new class extends mock<IChatPendingRequest>() { });
		onDidChangePendingRequests.fire();
	};
	const endLastResponse = (outcome: { isCanceled?: boolean; errorDetails?: IChatResponseErrorDetails; completionTimestamp?: number | null } = {}) => {
		response.isCanceled = outcome.isCanceled ?? false;
		response.result = outcome.errorDetails ? { errorDetails: outcome.errorDetails } : undefined;
		response.completionTimestamp = outcome.completionTimestamp === null ? undefined : outcome.completionTimestamp ?? Date.now();
		requestInProgress.set(false, undefined);
	};
	return { model, requestInProgress, requestNeedsInput, setPendingRequestCount, endLastResponse };
}

suite('ChatWindowNotifier', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class TestChatWindowNotifier extends ChatWindowNotifier {
		protected override _getIdleNotificationDelay(): number {
			return 0;
		}

		protected override _getBackgroundNotificationDelay(): number {
			return 0;
		}
	}

	/**
	 * Drains the chained zero-delay timers a notification passes through: the idle
	 * debounce and the background-window delay.
	 */
	async function flushNotifications(): Promise<void> {
		await timeout(0);
		await timeout(0);
		await timeout(0);
	}

	function createNotifierWith(model: IChatModel, options: { visible?: boolean; confirmation?: ChatNotificationMode } = {}) {
		const chatService = new TestChatService();
		chatService.chatModels.set([model], undefined);
		const host = new TestHostService();
		const notifications = new TestPromptNotificationService();
		store.add(new TestChatWindowNotifier(
			chatService,
			new TestChatWidgetService(options.visible),
			host,
			new TestConfigurationService({
				[ChatConfiguration.NotifyWindowOnResponseReceived]: ChatNotificationMode.Always,
				[ChatConfiguration.NotifyWindowOnConfirmation]: options.confirmation ?? ChatNotificationMode.Always,
			}),
			notifications,
		));
		return { chatService, host, notifications };
	}

	function createNotifier(model: IChatModel): TestHostService {
		return createNotifierWith(model).host;
	}

	/** An approval card as the Dragon agent extension asks one: a single question with options. */
	function approvalCard(): ChatQuestionCarouselData {
		return new ChatQuestionCarouselData([{
			id: 'decision',
			type: 'singleSelect',
			title: 'Allow this?',
			message: 'OpenCode wants to run `ls -la`.',
			options: [
				{ id: 'once', label: 'Allow once', value: 'once' },
				{ id: 'reject', label: 'Deny', value: 'reject' },
			],
		}], false, 'resolve-approval');
	}

	test('does not notify while a queued request remains', async () => {
		const { model, requestInProgress, setPendingRequestCount } = createModel(store, 'queued');
		const host = createNotifier(model);

		setPendingRequestCount(1);
		requestInProgress.set(false, undefined);
		await flushNotifications();

		assert.deepStrictEqual(host.toasts, []);
	});

	test('does not notify for an idle model that has never run', async () => {
		const { model } = createModel(store, 'never-ran', { requestInProgress: false, hasRequest: false });
		const host = createNotifier(model);

		await flushNotifications();

		assert.deepStrictEqual(host.toasts, []);
	});

	test('notifies when a queue is left blocked by an error or a cancellation', async () => {
		const failed = createModel(store, 'failed');
		const failedHost = createNotifier(failed.model);
		const cancelled = createModel(store, 'cancelled');
		const cancelledHost = createNotifier(cancelled.model);

		failed.setPendingRequestCount(1);
		failed.endLastResponse({ errorDetails: { message: 'boom' } });
		cancelled.setPendingRequestCount(1);
		cancelled.endLastResponse({ isCanceled: true });
		await flushNotifications();

		assert.deepStrictEqual([
			failedHost.toasts.map(toast => toast.dedupeKey),
			cancelledHost.toasts.map(toast => toast.dedupeKey),
		], [
			['chat-session:test:/failed:idle'],
			['chat-session:test:/cancelled:idle'],
		]);
	});

	test('notifies after a model becomes fully idle', async () => {
		const { model, endLastResponse } = createModel(store, 'idle');
		const host = createNotifier(model);

		endLastResponse();
		await flushNotifications();

		assert.deepStrictEqual(host.toasts, [{
			title: 'Session: Fix idle',
			body: 'Session finished.',
			actions: ['Open Session'],
			dedupeKey: 'chat-session:test:/idle:idle',
		}]);
	});

	test('does not notify when a session replays history as it loads', async () => {
		const restoredWithTime = createModel(store, 'restored');
		const restoredHost = createNotifier(restoredWithTime.model);
		const restoredWithoutTime = createModel(store, 'restored-untimed');
		const restoredWithoutTimeHost = createNotifier(restoredWithoutTime.model);

		// Replaying history completes each response with the time it originally
		// finished, or with none at all when that time was never recorded.
		restoredWithTime.endLastResponse({ completionTimestamp: Date.now() - 60_000 });
		restoredWithoutTime.endLastResponse({ completionTimestamp: null });
		await flushNotifications();

		assert.deepStrictEqual([restoredHost.toasts, restoredWithoutTimeHost.toasts], [[], []]);
	});

	test('only notifies for needed input when a request ends needing input', async () => {
		const { model, requestInProgress, requestNeedsInput } = createModel(store, 'needs-input');
		const host = createNotifier(model);

		requestNeedsInput.set({ title: 'Fix needs-input' }, undefined);
		requestInProgress.set(false, undefined);
		await flushNotifications();

		assert.deepStrictEqual(host.toasts.map(toast => toast.dedupeKey), [
			'chat-session:test:/needs-input:needsInput',
		]);
	});

	test('a chat that needs input off screen asks in the window with its card\'s choices, and the prompt closes once it no longer does', async () => {
		const card = approvalCard();
		const { model, requestNeedsInput } = createModel(store, 'off-screen', { parts: [card] });
		const { chatService, notifications } = createNotifierWith(model, { visible: false, confirmation: ChatNotificationMode.WindowNotFocused });

		requestNeedsInput.set({ title: 'agent-2' }, undefined);
		await flushNotifications();
		const shown = notifications.prompts.map(prompt => ({ message: prompt.message, choices: prompt.choices.map(choice => choice.label), closed: prompt.closed }));
		notifications.prompts[0]?.choices[0].run();
		requestNeedsInput.set(undefined, undefined);

		assert.deepStrictEqual({ shown, card: { isUsed: card.isUsed, data: card.data }, carouselAnswers: chatService.carouselAnswers, closed: notifications.prompts.map(prompt => prompt.closed) }, {
			shown: [{ message: 'agent-2 asks: OpenCode wants to run `ls -la`. Allow this?', choices: ['Allow once', 'Deny', 'Show Chat'], closed: false }],
			card: { isUsed: true, data: { decision: { selectedValue: 'once' } } },
			carouselAnswers: [{ requestId: 'request-off-screen', resolveId: 'resolve-approval', answers: { decision: { selectedValue: 'once' } } }],
			closed: [true],
		});
	});

	test('a chat on screen, or one whose confirmations notify nothing, does not ask in the window', async () => {
		const onScreen = createModel(store, 'on-screen', { parts: [approvalCard()] });
		const onScreenNotifier = createNotifierWith(onScreen.model, { visible: true, confirmation: ChatNotificationMode.WindowNotFocused });
		const off = createModel(store, 'off', { parts: [approvalCard()] });
		const offNotifier = createNotifierWith(off.model, { visible: false, confirmation: ChatNotificationMode.Off });

		onScreen.requestNeedsInput.set({ title: 'main' }, undefined);
		off.requestNeedsInput.set({ title: 'agent' }, undefined);
		await flushNotifications();

		assert.deepStrictEqual([onScreenNotifier.notifications.prompts, offNotifier.notifications.prompts], [[], []]);
	});
});
