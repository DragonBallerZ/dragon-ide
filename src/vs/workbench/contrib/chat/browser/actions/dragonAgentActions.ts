/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { raceTimeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { GroupsOrder, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { ACTIVE_GROUP, SIDE_GROUP } from '../../../../services/editor/common/editorService.js';
import { ChatSendResult, IChatService } from '../../common/chatService/chatService.js';
import { IChatWidgetService } from '../chat.js';
import { ChatEditorInput } from '../widgetHosts/editor/chatEditorInput.js';

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

interface IDragonSystemRequest {
	readonly sessionResource: string;
	/** The request text the participant receives. The transcript shows `label` instead. */
	readonly message: string;
	readonly label: string;
	/** The participant to answer when the chat has no turn to continue from. */
	readonly agentId?: string;
}

interface IDragonOpenAgentEditor {
	readonly title?: string;
	/** Open next to the active editor instead of in its group. */
	readonly toSide?: boolean;
	/** Open in the editor group at this position in the grid (0 is the first), when there is one. */
	readonly group?: number;
	readonly preserveFocus?: boolean;
}

export function registerDragonAgentActions() {
	/**
	 * Resolves to false when the chat is not loaded in this window or is busy with another turn;
	 * the caller then delivers the message without the chat.
	 */
	CommandsRegistry.registerCommand(DRAGON_SEND_SYSTEM_REQUEST_COMMAND, async (accessor: ServicesAccessor, request: IDragonSystemRequest): Promise<boolean> => {
		const chatService = accessor.get(IChatService);
		const logService = accessor.get(ILogService);
		const sessionResource = URI.parse(request.sessionResource);
		const model = chatService.getSession(sessionResource);
		if (!model || model.requestInProgress.get()) {
			logService.debug(`[dragon] no system request in ${request.sessionResource}: ${model ? 'a request is in progress' : 'the chat is not loaded'}`);
			return false;
		}
		// Continue with the participant, mode and model of the chat's last turn, as a typed message would.
		const last = model.lastRequest;
		const result = await chatService.sendRequest(sessionResource, request.message, {
			isSystemInitiated: true,
			systemInitiatedLabel: request.label,
			agentIdSilent: last?.response?.agent?.id ?? request.agentId,
			modeInfo: last?.modeInfo,
			userSelectedModelId: last?.modelId,
		});
		if (ChatSendResult.isRejected(result)) {
			logService.debug(`[dragon] system request rejected in ${request.sessionResource}: ${result.reason}`);
			return false;
		}
		return true;
	});

	CommandsRegistry.registerCommand(DRAGON_OPEN_AGENT_EDITOR_COMMAND, async (accessor: ServicesAccessor, options?: IDragonOpenAgentEditor): Promise<string | undefined> => {
		const chatService = accessor.get(IChatService);
		const group = options?.group === undefined ? undefined : accessor.get(IEditorGroupsService).getGroups(GroupsOrder.GRID_APPEARANCE)[options.group];
		const widget = await accessor.get(IChatWidgetService).openSession(ChatEditorInput.getNewEditorUri(), group ?? (options?.toSide ? SIDE_GROUP : ACTIVE_GROUP), { pinned: true, preserveFocus: options?.preserveFocus });
		if (widget && !widget.viewModel) {
			await raceTimeout(Event.toPromise(widget.onDidChangeViewModel), 5000);
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
}
