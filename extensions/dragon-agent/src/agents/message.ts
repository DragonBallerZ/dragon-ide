/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* The shape of a message between agents, as OpenCode stores it and as the chat view shows it. */

/** `metadata.source` of the synthetic OpenCode messages that agents send each other. */
export const METADATA_SOURCE = 'dragon.agent';

/** Wraps a message for the recipient's model. The sender attributes come from the hub, never from the model. */
export function wrapMessage(sender: { readonly id: string; readonly name: string }, body: string): string {
	// A body that contains the wrapper's own tags could pass itself off as a message from another agent.
	const safe = body.replace(/<(?<slash>\/?)agent-message/gi, '<$<slash>agent-message​');
	return `<agent-message from="${sender.name}" session="${sender.id}">\n${safe}\n</agent-message>`;
}

/** The sender's own words from a wrapped message. */
export function unwrapMessage(text: string): string {
	return /^<agent-message [^>]*>\n(?<body>[\s\S]*)\n<\/agent-message>$/.exec(text)?.groups?.body ?? text;
}

/** The text of the newest assistant message in a session's message list (`GET /api/session/{id}/message`). */
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
	const assistants = (messages as { type?: string; time?: { created?: number }; content?: { type?: string; text?: string }[] }[]).filter(m => m?.type === 'assistant');
	const newest = assistants.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0)).at(-1);
	const text = newest?.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('');
	return text || undefined;
}
