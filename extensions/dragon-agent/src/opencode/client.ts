/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readSse } from './sse';
import type {
	AgentInfo, FormInfo, IntegrationInfo, ModelInfo, ModelRef, OAuthAttempt, OpenCodeEvent,
	PermissionDecision, PermissionRule, ProviderInfo, Scoped, SessionInfo
} from './types';

export class OpenCodeHttpError extends Error {
	constructor(readonly method: string, readonly path: string, readonly status: number, readonly body: string) {
		super(`OpenCode ${method} ${path} failed with ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
	}
}

export interface RequestOptions {
	readonly query?: Record<string, string | number | boolean | undefined>;
	readonly body?: unknown;
	/** Workspace directory for location-scoped routes (`x-opencode-directory`). */
	readonly directory?: string;
	readonly signal?: AbortSignal;
}

/** A connection-level failure (reset or closed socket) rather than an HTTP error. */
export function isStaleConnection(err: unknown): boolean {
	const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
	return err instanceof TypeError && ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'].includes(cause?.code ?? '');
}

/** The server does not have what the request was about, such as a permission request it already settled. */
export function isNotFound(err: unknown): boolean {
	return err instanceof OpenCodeHttpError && err.status === 404;
}

/** The server always requires Basic auth with the fixed user name `opencode`. */
export function basicAuth(password: string): string {
	return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

/**
 * Thin client for the OpenCode v2 HTTP API. Every agent action goes through here: Dragon IDE
 * has no agent loop, tools, or model routing of its own.
 */
export class OpenCodeClient {
	constructor(readonly baseUrl: string, private readonly password: string, private readonly fetchImpl: typeof fetch = fetch) { }

	async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
		const url = new URL(path, this.baseUrl);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(key, String(value));
			}
		}
		const headers: Record<string, string> = { authorization: basicAuth(this.password), accept: 'application/json' };
		if (options.body !== undefined) {
			headers['content-type'] = 'application/json';
		}
		if (options.directory) {
			headers['x-opencode-directory'] = encodeURIComponent(options.directory);
		}
		const res = await this.fetch(url, {
			method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal,
		});
		if (!res.ok) {
			throw new OpenCodeHttpError(method, path, res.status, await res.text().catch(() => ''));
		}
		if (res.status === 204) {
			return undefined as T;
		}
		const text = await res.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	/**
	 * `fetch`, retried once when the connection itself failed. Node's fetch keeps sockets alive
	 * per origin, and a restarted server often gets the same port, so the first request after a
	 * restart can go out on a dead socket from the previous server. The request never reached a
	 * server, so sending it again is safe.
	 */
	private async fetch(url: URL, init: RequestInit): Promise<Response> {
		try {
			return await this.fetchImpl(url, init);
		} catch (err) {
			if (init.signal?.aborted || !isStaleConnection(err)) {
				throw err;
			}
			return this.fetchImpl(url, init);
		}
	}

	/** Yields every server event until the signal aborts. Subscribe before prompting. */
	async *events(signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
		const res = await this.fetch(new URL('/api/event', this.baseUrl), {
			headers: { authorization: basicAuth(this.password), accept: 'text/event-stream' },
			signal,
		});
		if (!res.ok || !res.body) {
			throw new OpenCodeHttpError('GET', '/api/event', res.status, await res.text().catch(() => ''));
		}
		for await (const payload of readSse(res.body as ReadableStream<Uint8Array>, signal)) {
			if (payload && typeof payload === 'object' && typeof (payload as OpenCodeEvent).type === 'string') {
				yield payload as OpenCodeEvent;
			}
		}
	}

	info(signal?: AbortSignal) {
		return this.request<{ version: string; pid: number; urls: string[] }>('GET', '/api/info', { signal });
	}

	async models(directory: string): Promise<ModelInfo[]> {
		return (await this.request<Scoped<ModelInfo[]>>('GET', '/api/model', { directory })).data;
	}

	async defaultModel(directory: string): Promise<ModelInfo | null> {
		return (await this.request<Scoped<ModelInfo | null>>('GET', '/api/model/default', { directory })).data;
	}

	async providers(directory: string): Promise<ProviderInfo[]> {
		return (await this.request<Scoped<ProviderInfo[]>>('GET', '/api/provider', { directory })).data;
	}

	async agents(directory: string): Promise<AgentInfo[]> {
		return (await this.request<Scoped<AgentInfo[]>>('GET', '/api/agent', { directory })).data;
	}

	async integrations(directory: string): Promise<IntegrationInfo[]> {
		return (await this.request<Scoped<IntegrationInfo[]>>('GET', '/api/integration', { directory })).data;
	}

	async createSession(input: { directory: string; title?: string; agent?: string; model?: ModelRef; permissions?: readonly PermissionRule[] }): Promise<SessionInfo> {
		const body = {
			location: { directory: input.directory },
			...(input.title ? { title: input.title } : {}),
			...(input.agent ? { agent: input.agent } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.permissions?.length ? { permissions: input.permissions } : {}),
		};
		return (await this.request<{ data: SessionInfo }>('POST', '/api/session', { body })).data;
	}

	/** Sessions in `directory`, newest first (the server's first page). */
	async sessions(directory: string): Promise<SessionInfo[]> {
		return (await this.request<{ data: SessionInfo[] }>('GET', '/api/session', { directory })).data;
	}

	async session(sessionID: string): Promise<SessionInfo> {
		return (await this.request<{ data: SessionInfo }>('GET', `/api/session/${encodeURIComponent(sessionID)}`)).data;
	}

	setModel(sessionID: string, model: ModelRef) {
		return this.request<void>('POST', `/api/session/${encodeURIComponent(sessionID)}/model`, { body: { model } });
	}

	setAgent(sessionID: string, agent: string) {
		return this.request<void>('POST', `/api/session/${encodeURIComponent(sessionID)}/agent`, { body: { agent } });
	}

	/** Replaces the session's own permission rules, which OpenCode applies after the agent's. */
	setPermissions(sessionID: string, permissions: readonly PermissionRule[]) {
		return this.request<void>('PATCH', `/api/session/${encodeURIComponent(sessionID)}`, { body: { permissions } });
	}

	prompt(sessionID: string, input: { text: string; files?: { uri: string; name?: string }[] }) {
		return this.request<{ data: { id: string } }>('POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
			body: { text: input.text, ...(input.files?.length ? { files: input.files } : {}) },
		});
	}

	/**
	 * Adds a message that is not the user's (for example one agent's message to another) to the
	 * session's inbox. It is stored durably; with `resume: false` the session is not woken for it.
	 */
	synthetic(sessionID: string, input: { text: string; description?: string; metadata?: Record<string, unknown>; resume?: boolean }) {
		return this.request<{ data: { id: string } }>('POST', `/api/session/${encodeURIComponent(sessionID)}/synthetic`, {
			body: { text: input.text, ...(input.description ? { description: input.description } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.resume === false ? { resume: false } : {}) },
		});
	}

	interrupt(sessionID: string) {
		return this.request<{ interrupted: boolean }>('POST', `/api/session/${encodeURIComponent(sessionID)}/interrupt`);
	}

	/** The session's most recent messages (the server's first page). */
	async messages(sessionID: string, limit = 100): Promise<unknown[]> {
		return (await this.request<{ data: unknown[] }>('GET', `/api/session/${encodeURIComponent(sessionID)}/message`, { query: { limit } })).data ?? [];
	}

	/** The end of what a shell command printed so far, at most `bytes` long. Readable while it runs. */
	async shellTail(directory: string | undefined, shellID: string, bytes = 4096): Promise<string> {
		const path = `/api/shell/${encodeURIComponent(shellID)}/output`;
		const { size } = (await this.request<Scoped<{ size: number }>>('GET', path, { directory, query: { cursor: Number.MAX_SAFE_INTEGER } })).data;
		return (await this.request<Scoped<{ output: string }>>('GET', path, { directory, query: { cursor: Math.max(0, size - bytes), limit: bytes } })).data.output;
	}

	replyPermission(sessionID: string, requestID: string, decision: PermissionDecision, message?: string) {
		return this.request<void>('POST', `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
			body: { decision, ...(message ? { message } : {}) },
		});
	}

	replyForm(sessionID: string, formID: string, answer: Record<string, unknown>) {
		return this.request<void>('POST', `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, { body: { answer } });
	}

	cancelForm(sessionID: string, formID: string) {
		return this.request<void>('DELETE', `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`);
	}

	async form(sessionID: string, formID: string): Promise<FormInfo> {
		return (await this.request<{ data: FormInfo }>('GET', `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`)).data;
	}

	connectKey(directory: string, integrationID: string, key: string) {
		return this.request<void>('POST', `/api/integration/${encodeURIComponent(integrationID)}/connect/key`, { directory, body: { key } });
	}

	async connectOAuth(directory: string, integrationID: string, methodID: string, answer?: Record<string, unknown>): Promise<OAuthAttempt> {
		return (await this.request<Scoped<OAuthAttempt>>('POST', `/api/integration/${encodeURIComponent(integrationID)}/connect/oauth`, {
			directory, body: { methodID, ...(answer ? { answer } : {}) },
		})).data;
	}

	async oauthStatus(directory: string, integrationID: string, attemptID: string): Promise<{ status: 'pending' | 'complete' | 'failed' | string; message?: string }> {
		return (await this.request<Scoped<{ status: string; message?: string }>>('GET', `/api/integration/${encodeURIComponent(integrationID)}/connect/oauth/${encodeURIComponent(attemptID)}`, { directory })).data;
	}

	completeOAuth(directory: string, integrationID: string, attemptID: string, code: string) {
		return this.request<void>('POST', `/api/integration/${encodeURIComponent(integrationID)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`, { directory, body: { code } });
	}
}

/** Parses a `provider/model` string (the model half may itself contain slashes). */
export function parseModelRef(value: string | undefined): ModelRef | undefined {
	const trimmed = value?.trim();
	if (!trimmed) {
		return undefined;
	}
	const slash = trimmed.indexOf('/');
	if (slash <= 0 || slash === trimmed.length - 1) {
		return undefined;
	}
	return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

export function formatModelRef(model: ModelRef): string {
	return `${model.providerID}/${model.id}`;
}
