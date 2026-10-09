/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** How much of the end of each log file is searched: the log is shared and grows to 50 MB. */
const TAIL_BYTES = 1024 * 1024;

/** Where OpenCode writes its log files: `<XDG data>/opencode/log`, as `global-roots.ts` resolves it. */
export function openCodeLogDirectory(env: NodeJS.ProcessEnv, home: string): string {
	return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'log');
}

/**
 * Why an `opencode` command run with `args` failed, from the `cli process failed` line it logged
 * at or after `since` (ms). Undefined when the log has no such line.
 */
export function cliFailure(log: string, args: readonly string[], since: number): string | undefined {
	let reason: string | undefined;
	for (const line of log.split('\n')) {
		if (!line.includes('message="cli process failed"')) {
			continue;
		}
		const fields = logFields(line);
		const cause = fields.get('cause');
		if (fields.get('role') === 'cli' && Date.parse(fields.get('timestamp') ?? '') >= since && fields.get('args') === JSON.stringify(args) && cause) {
			reason = causeMessage(cause);
		}
	}
	return reason;
}

/**
 * {@link cliFailure} over the OpenCode log files in `directory` changed since `since`, with the
 * file it came from.
 */
export async function readCliFailure(directory: string, args: readonly string[], since: number): Promise<{ reason: string; file: string } | undefined> {
	let names: string[];
	try {
		names = (await fs.readdir(directory)).filter(name => name.endsWith('.log'));
	} catch {
		return undefined;
	}
	for (const name of names) {
		const file = path.join(directory, name);
		try {
			const handle = await fs.open(file, 'r');
			try {
				const { size, mtimeMs } = await handle.stat();
				if (mtimeMs < since) {
					continue;
				}
				const length = Math.min(size, TAIL_BYTES);
				const tail = Buffer.alloc(length);
				await handle.read(tail, 0, length, size - length);
				const reason = cliFailure(tail.toString('utf8'), args, since);
				if (reason) {
					return { reason, file };
				}
			} finally {
				await handle.close();
			}
		} catch {
			// A log file that cannot be read has nothing to say.
		}
	}
	return undefined;
}

/** The `key=value` fields of one log line. A value with spaces or quotes is a JSON string. */
function logFields(line: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const match of line.matchAll(/(?<key>[\w.]+)=(?<value>"(?:[^"\\]|\\.)*"|\S*)/g)) {
		const { key, value } = match.groups!;
		try {
			fields.set(key, value.startsWith('"') ? JSON.parse(value) : value);
		} catch {
			// A value that is not valid JSON is left out.
		}
	}
	return fields;
}

/** The first error's own message from `Cause([Fail(Error: <message> (cause: <inner>))])`. */
function causeMessage(cause: string): string {
	let message = cause.replace(/^Cause\(\[\w+\((?:\w*Error: )?/, '').replace(/\)\]\)$/, '');
	const inner = message.indexOf(' (cause: ');
	if (inner >= 0) {
		message = message.slice(0, inner);
	}
	// dlopen lists every path it tried; macOS's reason for refusing the library is what matters.
	const dlopen = message.indexOf(': dlopen(');
	if (dlopen >= 0) {
		const refused = /not valid for use in process: (?<reason>.*?)\)(?:, '|$)/.exec(message)?.groups?.reason;
		message = message.slice(0, dlopen) + (refused ? `: ${refused}` : '');
	}
	return message;
}
