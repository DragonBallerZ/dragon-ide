/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { distinct } from '../../../../../base/common/arrays.js';
import { raceTimeout } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { waitForState } from '../../../../../base/common/observable.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, IEditorService, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { ChatSendResult, IChatService } from '../../common/chatService/chatService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { ChatViewId, IChatWidgetService } from '../chat.js';
import { ChatEditorInput } from '../widgetHosts/editor/chatEditorInput.js';
import { ChatViewPane } from '../widgetHosts/viewPane/chatViewPane.js';

/*
 * DRAGON: what the dragon-agent extension needs from the chat workbench to show agents that
 * message each other. An extension can answer a request in a chat, but it cannot start a turn the
 * user did not type, nor open a chat editor and learn which session it shows.
 */

/** Starts a turn in a chat that the user did not type, shown as a labelled notice (for example "From lead"). */
export const DRAGON_SEND_SYSTEM_REQUEST_COMMAND = '_dragon.chat.sendSystemRequest';
/** Opens a new chat editor and returns the session resource it shows. */
export const DRAGON_OPEN_AGENT_EDITOR_COMMAND = '_dragon.chat.openAgentEditor';
/** Shows the chat with this session resource, opening its editor again if it was closed. */
export const DRAGON_REVEAL_CHAT_COMMAND = '_dragon.chat.reveal';
/** The session resource of the chat an editor shows, by the editor's resource, which its title buttons are given. */
export const DRAGON_EDITOR_SESSION_COMMAND = '_dragon.chat.editorSession';
/**
 * The session resource of the chat the Chat view shows. Its title buttons are given it, but the
 * extension host drops it before an extension's command runs.
 */
export const DRAGON_VIEW_SESSION_COMMAND = '_dragon.chat.viewSession';
/**
 * The session resources of the local chats open in this window: every chat editor, open in a group
 * or as a tab behind another, and the Chat view's chat while the view shows.
 */
export const DRAGON_OPEN_CHATS_COMMAND = '_dragon.chat.openChats';
/** Names a chat, as its editor's tab and the chat history show it. */
export const DRAGON_SET_CHAT_TITLE_COMMAND = '_dragon.chat.setTitle';

interface IDragonSystemRequest {
	readonly sessionResource: string;
	/** The request text the participant receives. The transcript shows `label` instead. */
	readonly message: string;
	readonly label: string;
	/** The participant to answer when the chat has no turn to continue from. */
	readonly agentId?: string;
	/** How long a chat busy with another request may take to finish it, in milliseconds; without it, a busy chat refuses at once. */
	readonly waitMs?: number;
}

interface IDragonOpenAgentEditor {
	readonly title?: string;
	/** Open next to the active editor instead of in its group. */
	readonly toSide?: boolean;
	/** Open in the editor group at this position in the grid (0 is the first), when there is one. */
	readonly group?: number;
	readonly preserveFocus?: boolean;
	/**
	 * The model the agent's session runs on, by its provider's vendor and model id. The new chat's
	 * picker shows it instead of the last model picked, and the user's pick is left as it was.
	 */
	readonly model?: { readonly vendor: string; readonly id: string };
}

export function registerDragonAgentActions() {
	/**
	 * Resolves to false when the chat is not loaded in this window or is busy with another turn
	 * (past `waitMs`); the caller then delivers the message without the chat.
	 */
	CommandsRegistry.registerCommand(DRAGON_SEND_SYSTEM_REQUEST_COMMAND, async (accessor: ServicesAccessor, request: IDragonSystemRequest): Promise<boolean> => {
		const chatService = accessor.get(IChatService);
		const logService = accessor.get(ILogService);
		const chatWidgetService = accessor.get(IChatWidgetService);
		const sessionResource = URI.parse(request.sessionResource);
		const model = chatService.getSession(sessionResource);
		if (model?.requestInProgress.get() && request.waitMs) {
			// A turn that has stopped following its agent may still be finishing in the chat.
			const cancellation = new CancellationTokenSource();
			await raceTimeout(waitForState(model.requestInProgress, inProgress => !inProgress, undefined, cancellation.token).catch(() => undefined), request.waitMs, () => cancellation.cancel());
			cancellation.dispose();
		}
		if (!model || model.requestInProgress.get()) {
			logService.debug(`[dragon] no system request in ${request.sessionResource}: ${model ? 'a request is in progress' : 'the chat is not loaded'}`);
			return false;
		}
		// Continue with the participant and mode of the chat's last turn, as a typed message would, and
		// with the model its picker shows now: the user may have picked one since, or before any turn.
		const last = model.lastRequest;
		const selected = chatWidgetService.getWidgetBySessionResource(sessionResource)?.getSelectedModelRequestOptions();
		const result = await chatService.sendRequest(sessionResource, request.message, {
			isSystemInitiated: true,
			systemInitiatedLabel: request.label,
			agentIdSilent: last?.response?.agent?.id ?? request.agentId,
			modeInfo: last?.modeInfo,
			userSelectedModelId: selected?.userSelectedModelId ?? last?.modelId,
			userSelectedModelConfiguration: selected?.userSelectedModelId ? selected.userSelectedModelConfiguration : undefined,
		});
		if (ChatSendResult.isRejected(result)) {
			logService.debug(`[dragon] system request rejected in ${request.sessionResource}: ${result.reason}`);
			return false;
		}
		return true;
	});

	CommandsRegistry.registerCommand(DRAGON_OPEN_AGENT_EDITOR_COMMAND, async (accessor: ServicesAccessor, options?: IDragonOpenAgentEditor): Promise<string | undefined> => {
		const chatService = accessor.get(IChatService);
		const languageModelsService = accessor.get(ILanguageModelsService);
		const group = options?.group === undefined ? undefined : accessor.get(IEditorGroupsService).getGroups(GroupsOrder.GRID_APPEARANCE)[options.group];
		const widget = await accessor.get(IChatWidgetService).openSession(ChatEditorInput.getNewEditorUri(), group ?? (options?.toSide ? SIDE_GROUP : ACTIVE_GROUP), { pinned: true, preserveFocus: options?.preserveFocus });
		if (widget && !widget.viewModel) {
			await raceTimeout(Event.toPromise(widget.onDidChangeViewModel), 5000);
		}
		const wanted = options?.model;
		const identifier = wanted && languageModelsService.getLanguageModelIds().find(id => {
			const metadata = languageModelsService.lookupLanguageModel(id);
			return metadata?.vendor === wanted.vendor && metadata.id === wanted.id;
		});
		if (widget && identifier) {
			// Resolves once the picker has its models; a model that never shows up leaves the picker as it is.
			await raceTimeout(widget.input.requestModelByIdentifier(identifier), 5000);
		}
		const sessionResource = widget?.viewModel?.sessionResource;
		if (sessionResource && options?.title) {
			chatService.setSessionTitle(sessionResource, options.title);
		}
		return sessionResource?.toString();
	});

	CommandsRegistry.registerCommand(DRAGON_REVEAL_CHAT_COMMAND, async (accessor: ServicesAccessor, sessionResource: string): Promise<boolean> => {
		return !!await accessor.get(IChatWidgetService).openSession(URI.parse(sessionResource));
	});

	CommandsRegistry.registerCommand(DRAGON_EDITOR_SESSION_COMMAND, (accessor: ServicesAccessor, resource: UriComponents): string | undefined => {
		const editor = accessor.get(IEditorService).findEditors(URI.revive(resource)).map(identifier => identifier.editor).find((editor): editor is ChatEditorInput => editor instanceof ChatEditorInput);
		return editor?.sessionResource?.toString();
	});

	CommandsRegistry.registerCommand(DRAGON_VIEW_SESSION_COMMAND, (accessor: ServicesAccessor): string | undefined => {
		return accessor.get(IViewsService).getViewWithId<ChatViewPane>(ChatViewId)?.widget?.viewModel?.sessionResource.toString();
	});

	CommandsRegistry.registerCommand(DRAGON_OPEN_CHATS_COMMAND, (accessor: ServicesAccessor): string[] => {
		const viewsService = accessor.get(IViewsService);
		const editors = accessor.get(IEditorService).editors.map(editor => editor instanceof ChatEditorInput ? editor.sessionResource : undefined);
		const view = viewsService.isViewVisible(ChatViewId) ? viewsService.getViewWithId<ChatViewPane>(ChatViewId)?.widget?.viewModel?.sessionResource : undefined;
		const local = [...editors, view].filter((resource): resource is URI => !!resource && LocalChatSessionUri.isLocalSession(resource));
		return distinct(local.map(resource => resource.toString()));
	});

	CommandsRegistry.registerCommand(DRAGON_SET_CHAT_TITLE_COMMAND, (accessor: ServicesAccessor, sessionResource: string, title: string): void => {
		accessor.get(IChatService).setSessionTitle(URI.parse(sessionResource), title);
	});
}
