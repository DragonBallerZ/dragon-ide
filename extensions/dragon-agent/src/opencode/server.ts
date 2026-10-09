/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { OpenCodeClient } from './client';

export type ServerState =
	| { readonly kind: 'stopped' }
	| { readonly kind: 'starting' }
	| { readonly kind: 'ready'; readonly url: string; readonly version: string }
	| { readonly kind: 'failed'; readonly message: string };

export interface ServerOptions {
	/** Explicit path from the `dragon.opencode.path` setting, if any. */
	readonly configuredBinary?: string;
	/** The extension's own directory; the bundled binary lives in `bin/`. */
	readonly extensionPath: string;
	/** Working directory for the server: the first workspace folder. */
	readonly cwd: string;
	/** Dragon-owned OpenCode config file (`OPENCODE_CONFIG`); OpenCode watches it for changes. */
	readonly configFile?: string;
	/** Extra environment for the server (for example the ripgrep path for Instant Grep). */
	readonly extraEnv?: Record<string, string>;
	readonly log: (line: string) => void;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
}

/** Candidate binaries in priority order: setting, bundled, then PATH. */
export function binaryCandidates(options: Pick<ServerOptions, 'configuredBinary' | 'extensionPath' | 'platform' | 'env'>): string[] {
	const exe = (options.platform ?? process.platform) === 'win32' ? 'opencode.exe' : 'opencode';
	const candidates: string[] = [];
	if (options.configuredBinary?.trim()) {
		candidates.push(options.configuredBinary.trim());
	}
	candidates.push(path.join(options.extensionPath, 'bin', exe));
	const pathVar = (options.env ?? process.env)[(options.platform ?? process.platform) === 'win32' ? 'Path' : 'PATH'] ?? (options.env ?? process.env).PATH ?? '';
	for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
		candidates.push(path.join(dir, exe));
	}
	return candidates;
}

export function resolveBinary(options: Pick<ServerOptions, 'configuredBinary' | 'extensionPath' | 'platform' | 'env'>, exists: (p: string) => boolean = existsSync): string | undefined {
	return binaryCandidates(options).find(candidate => exists(candidate));
}

/** Arguments for the OpenCode TUI attached to the window's server. */
export function tuiArgs(serverUrl: string, sessionID?: string): string[] {
	return ['--server', serverUrl, ...(sessionID ? ['--session', sessionID] : [])];
}

/**
 * Reads the listening URL from `opencode serve --stdio` output. The server prints one JSON
 * line, `{"url":"http://127.0.0.1:NNNN"}`; the plain-text form of `serve` is accepted too.
 */
export function parseListenLine(line: string): string | undefined {
	const trimmed = line.trim();
	if (trimmed.startsWith('{')) {
		try {
			const url = JSON.parse(trimmed)?.url;
			return typeof url === 'string' ? url : undefined;
		} catch {
			return undefined;
		}
	}
	return /server listening on (\S+)/.exec(trimmed)?.[1];
}

/** The environment for the server process. The password never appears on a command line. */
export function serverEnv(base: NodeJS.ProcessEnv, password: string, configFile?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...base,
		OPENCODE_PASSWORD: password,
		OPENCODE_DISABLE_AUTOUPDATE: '1',
		OPENCODE_CLIENT: 'dragon-ide',
	};
	delete env.OPENCODE_SERVER_PASSWORD;
	if (configFile) {
		env.OPENCODE_CONFIG = configFile;
	}
	return env;
}

/**
 * Owns the one OpenCode server of a window. The chat view and the TUI terminal both talk to
 * it, so they share sessions, models and credentials.
 */
export class OpenCodeServer {
	private process: ChildProcess | undefined;
	private readonly password = randomBytes(24).toString('base64url');
	private starting: Promise<OpenCodeClient> | undefined;
	private client: OpenCodeClient | undefined;
	private _state: ServerState = { kind: 'stopped' };
	private readonly listeners = new Set<(state: ServerState) => void>();
	private restarts = 0;
	private disposed = false;

	constructor(private options: ServerOptions) { }

	get state(): ServerState {
		return this._state;
	}

	get serverPassword(): string {
		return this.password;
	}

	onDidChangeState(listener: (state: ServerState) => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	/** Replaces the options used by the next start (for example after the default model changed). */
	update(options: Partial<ServerOptions>): void {
		this.options = { ...this.options, ...options };
	}

	/**
	 * Replaces the options, and restarts a running server whose environment they change. A server
	 * keeps agents to the folders it started with, so a folder taken out of the window would stay
	 * open to them until the next start.
	 */
	async reconfigure(options: Partial<ServerOptions>): Promise<void> {
		const before = JSON.stringify(this.options.extraEnv ?? {});
		this.update(options);
		if (JSON.stringify(this.options.extraEnv ?? {}) === before) {
			return;
		}
		// A server still starting started with the old environment.
		await this.starting?.catch(() => undefined);
		if (this.process) {
			this.options.log('[server] the environment changed; restarting');
			await this.restart();
		}
	}

	/** Returns a client for a ready server, starting it if needed. */
	ensure(): Promise<OpenCodeClient> {
		if (this.client && this._state.kind === 'ready') {
			return Promise.resolve(this.client);
		}
		this.starting ??= this.start().finally(() => { this.starting = undefined; });
		return this.starting;
	}

	async restart(): Promise<OpenCodeClient> {
		this.stop();
		this.restarts = 0;
		return this.ensure();
	}

	private setState(state: ServerState): void {
		this._state = state;
		for (const listener of this.listeners) {
			listener(state);
		}
	}

	private async start(): Promise<OpenCodeClient> {
		const binary = resolveBinary(this.options);
		if (!binary) {
			const message = 'The OpenCode binary was not found. Build it with `npm run dragon:build-opencode`, install `opencode` on your PATH, or set `dragon.opencode.path`.';
			this.setState({ kind: 'failed', message });
			throw new Error(message);
		}
		this.setState({ kind: 'starting' });
		this.options.log(`[server] starting ${binary} serve --stdio in ${this.options.cwd}`);
		const child = spawn(binary, ['serve', '--stdio'], {
			cwd: this.options.cwd,
			env: { ...serverEnv(this.options.env ?? process.env, this.password, this.options.configFile), ...this.options.extraEnv },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.process = child;

		const url = await new Promise<string>((resolve, reject) => {
			let buffer = '';
			const timer = setTimeout(() => reject(new Error('OpenCode did not report a listening address within 30 seconds.')), 30_000);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				buffer += chunk;
				let index: number;
				while ((index = buffer.indexOf('\n')) !== -1) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					const found = parseListenLine(line);
					if (found) {
						clearTimeout(timer);
						resolve(found);
					} else if (line.trim()) {
						this.options.log(`[server] ${line}`);
					}
				}
			});
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (chunk: string) => {
				for (const line of chunk.split('\n').filter(Boolean)) {
					this.options.log(`[server:err] ${line}`);
				}
			});
			child.once('error', err => { clearTimeout(timer); reject(err); });
			child.once('exit', code => { clearTimeout(timer); reject(new Error(`OpenCode exited during startup (code ${code}).`)); });
		}).catch(err => {
			this.setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
			child.kill();
			throw err;
		});

		const client = new OpenCodeClient(url, this.password);
		const info = await waitForReady(client);
		this.client = client;
		this.restarts = 0;
		this.options.log(`[server] ready at ${url} (opencode ${info.version})`);
		this.setState({ kind: 'ready', url, version: info.version });

		child.once('exit', code => {
			if (this.process !== child) {
				return;
			}
			this.process = undefined;
			this.client = undefined;
			this.options.log(`[server] exited (code ${code})`);
			if (this.disposed) {
				this.setState({ kind: 'stopped' });
				return;
			}
			// Restart with backoff so a crash does not leave the chat dead.
			const delay = Math.min(30_000, 1000 * 2 ** this.restarts++);
			this.setState({ kind: 'failed', message: `OpenCode stopped (code ${code}); restarting in ${Math.round(delay / 1000)}s.` });
			setTimeout(() => { if (!this.disposed && !this.process) { void this.ensure().catch(() => undefined); } }, delay);
		});
		return client;
	}

	stop(): void {
		const child = this.process;
		this.process = undefined;
		this.client = undefined;
		if (child) {
			// Closing stdin is the server's own shutdown signal in --stdio mode.
			child.stdin?.end();
			const timer = setTimeout(() => child.kill(), 3000);
			child.once('exit', () => clearTimeout(timer));
		}
		this.setState({ kind: 'stopped' });
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
		this.listeners.clear();
	}
}

async function waitForReady(client: OpenCodeClient): Promise<{ version: string }> {
	const deadline = Date.now() + 30_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			return await client.info(AbortSignal.timeout(5000));
		} catch (err) {
			lastError = err; // 503 while starting
		}
		await new Promise(resolve => setTimeout(resolve, 250));
	}
	throw new Error(`OpenCode did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
