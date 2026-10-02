/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { autorun } from '../../../../../../../base/common/observable.js';
import { IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { ToolCallCard } from '../../../../../dragonShared/browser/toolCallCard.js';
import { toolInvocationToCardModel } from '../../../../../dragonShared/browser/agentTurnActivityModel.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/**
 * Dragon live activity card for non-terminal tool work.
 *
 * Terminal tools keep the stock terminal renderer because it has deep terminal
 * integration. This card covers the rest of the live agent work stream:
 * context reads, code-edit tools, validation helpers, browser actions, and
 * sub-agents.
 */
export class ChatDragonToolCardSubPart extends BaseChatToolInvocationSubPart {
	public readonly domNode: HTMLElement;
	public override readonly codeblocks: IChatCodeBlockInfo[] = [];

	private readonly _startedAt = Date.now();

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
	) {
		super(toolInvocation);

		this.domNode = document.createElement('div');
		this.domNode.className = 'dragon-live-tool-invocation';

		const card = this._register(new ToolCallCard(
			this.domNode,
			toolInvocationToCardModel(toolInvocation, undefined, { startedAt: this._startedAt }),
		));

		if (toolInvocation.kind === 'toolInvocation') {
			this._register(autorun(reader => {
				card.update(toolInvocationToCardModel(toolInvocation, reader, { startedAt: this._startedAt }));
			}));
		}
	}
}
