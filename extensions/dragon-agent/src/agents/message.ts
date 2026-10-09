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
	const safe = body.replace(/<(?<slash>\/?)agent-message/gi, '<$<slash>agent-message\u200b');
	return `<agent-message from="${sender.name}" session="${sender.id}">\n${safe}\n</agent-message>`;
}

/** The sender's own words from a wrapped message. */
export function unwrapMessage(text: string): string {
	return /^<agent-message [^>]*>\n(?<body>[\s\S]*)\n<\/agent-message>$/.exec(text)?.groups?.body ?? text;
}

/**
 * An agent's reply in its own words. Models that read their messages wrapped may wrap their replies
 * too: in 3 of 32 team-demo runs Nemotron answered `<agent-message from="agent-2">Ragefire</agent-message>`,
 * or "Blaze" followed by the lead's message it was answering. A wrapper in the agent's own name, or
 * in none, keeps its words; another agent's message echoed back goes.
 */
export function ownWords(name: string, reply: string): string {
	return reply.replace(/<agent-message\b(?<attributes>[^>]*)>(?<body>[\s\S]*?)<\/agent-message>/gi, (_match, attributes: string, body: string) => ownWrapper(name, attributes) ? body : '').trim();
}

/** Whether a wrapper's attributes name `name` as its sender, or no one. Any name is the agent's own when its name is not known. */
function ownWrapper(name: string | undefined, attributes: string): boolean {
	const from = /\bfrom="(?<from>[^"]*)"/i.exec(attributes)?.groups?.from;
	return from === undefined || name === undefined || from.toLowerCase() === name.toLowerCase();
}

/**
 * `ownWords` for an agent's text as its model writes it, for the agent's own chat: a wrapper in its
 * name, or in none, goes and its words stay, and another agent's message it echoed goes whole. An
 * agent's tab showed the tags in 3 of 37 team-demo runs, as "Blaze <agent-message from="main" …>…",
 * also in a run that passed. Text that may start a tag is held back until it is known; a message
 * that is not closed is shown as written once the text ends.
 */
export class OwnWordsStream {
	private held = '';
	/** The opening tag of another agent's message that the text echoes, until its end tag. */
	private echo: string | undefined;

	/** @param name The agent's name, read when a wrapper opens. */
	constructor(private readonly name: () => string | undefined) { }

	/** What can be shown of `delta`, with the text held back before it. */
	push(delta: string): string {
		this.held += delta;
		return this.take(false);
	}

	/** The text held back, shown as the text ends. */
	end(): string {
		return this.take(true);
	}

	private take(end: boolean): string {
		let shown = '';
		for (; ;) {
			if (this.echo !== undefined) {
				const close = /<\/agent-message\s*>/i.exec(this.held);
				if (!close) {
					if (end) {
						shown += this.echo + this.held;
						this.echo = undefined;
						this.held = '';
					}
					return shown;
				}
				this.held = this.held.slice(close.index + close[0].length);
				this.echo = undefined;
				continue;
			}
			const tag = /<(?<close>\/?)agent-message\b(?<attributes>[^>]*)>/i.exec(this.held);
			if (!tag) {
				const known = end ? this.held.length : tagStart(this.held);
				shown += this.held.slice(0, known);
				this.held = this.held.slice(known);
				return shown;
			}
			shown += this.held.slice(0, tag.index);
			this.held = this.held.slice(tag.index + tag[0].length);
			if (!tag.groups?.close && !ownWrapper(this.name(), tag.groups?.attributes ?? '')) {
				this.echo = tag[0];
			}
		}
	}
}

/** Where `text` ends with what may be the start of a wrapper's tag, else its length. */
function tagStart(text: string): number {
	const at = text.lastIndexOf('<');
	const rest = text.slice(at).toLowerCase();
	const starts = at >= 0 && ['<agent-message', '</agent-message'].some(tag => tag.startsWith(rest) || rest.startsWith(tag) && !/^\w/.test(rest.slice(tag.length)));
	return starts ? at : text.length;
}

/**
 * A message from another agent as the chat shows it in a reply: a markdown quote under `label`
 * ("From alpha"). It starts a block of its own: the chat joins a reply's markdown, so a message that
 * arrives after text the model streamed would otherwise start on that text's last line and show
 * its ">", as the lead's "All three are on it.> **From agent-2**" did.
 */
export function quotedMessage(label: string, text: string): string {
	return `\n\n> **${label}**\n>\n${text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
}

/** An agent's reply, read from its session. */
export interface Reply {
	readonly text: string;
	/**
	 * The text is word for word the thinking its model did before writing it, so it may be that
	 * thinking and no answer: in 8 of 37 team-demo runs a Nemotron agent replied so, with "The user
	 * is asking me to name the first level in one line, …" or a garbled line.
	 */
	readonly thought: boolean;
}

/**
 * The reply in the newest assistant message that has text, in a session's message list
 * (`GET /api/session/{id}/message`), among those written at or after `since`.
 */
export function lastAssistantReply(messages: readonly unknown[], since = 0): Reply | undefined {
	const assistants = (messages as { type?: string; time?: { created?: number }; content?: { type?: string; text?: string }[] }[])
		.filter(m => m?.type === 'assistant' && (m.time?.created ?? 0) >= since)
		.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
	const parts = (message: typeof assistants[number], type: string) => message.content?.filter(part => part.type === type).map(part => part.text ?? '') ?? [];
	const last = assistants.findLast(message => parts(message, 'text').join('').trim());
	if (!last) {
		return undefined;
	}
	const text = parts(last, 'text').join('');
	return { text, thought: parts(last, 'reasoning').some(thinking => thinking.trim() === text.trim()) };
}

/** The text of the newest assistant message that has any (see `lastAssistantReply`). */
export function lastAssistantText(messages: readonly unknown[], since = 0): string | undefined {
	return lastAssistantReply(messages, since)?.text;
}
