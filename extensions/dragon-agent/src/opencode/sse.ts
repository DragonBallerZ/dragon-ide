/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incremental parser for the OpenCode event stream.
 *
 * The server frames every event as `data: <json>\n\n` with no `event:` line, and sends
 * `: heartbeat` comments every 15 seconds. Frames can arrive split across chunks.
 */
export class SseParser {
	private buffer = '';

	/** Feeds a chunk of text and returns every complete JSON payload it finished. */
	push(chunk: string): unknown[] {
		this.buffer += chunk.replace(/\r\n/g, '\n');
		const out: unknown[] = [];
		let index: number;
		while ((index = this.buffer.indexOf('\n\n')) !== -1) {
			const frame = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 2);
			const data = frame
				.split('\n')
				.filter(line => line.startsWith('data:'))
				.map(line => line.slice(5).replace(/^ /, ''))
				.join('\n');
			if (!data) {
				continue; // heartbeat or comment
			}
			try {
				out.push(JSON.parse(data));
			} catch {
				// A malformed frame is dropped; the stream itself stays usable.
			}
		}
		return out;
	}
}

/** Reads a fetch body as parsed SSE payloads until it ends or the signal aborts. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parser = new SseParser();
	try {
		while (!signal?.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			for (const event of parser.push(decoder.decode(value, { stream: true }))) {
				yield event;
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// already closed
		}
	}
}
