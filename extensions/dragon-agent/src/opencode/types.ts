/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * The subset of the OpenCode v2 HTTP API (`opencode/packages/protocol/openapi.json`) that
 * Dragon IDE uses. Field names are the server's; do not rename them.
 */

export interface ModelRef {
	readonly id: string;
	readonly providerID: string;
	readonly variant?: string;
}

export interface ModelInfo {
	readonly id: string;
	readonly modelID: string;
	readonly providerID: string;
	readonly name: string;
	readonly family?: string;
	readonly enabled: boolean;
	readonly status?: 'alpha' | 'beta' | 'deprecated' | 'active';
	readonly capabilities?: { readonly tools?: boolean; readonly input?: readonly string[]; readonly output?: readonly string[] };
	readonly limit?: { readonly context?: number; readonly input?: number; readonly output?: number };
	/** USD per million tokens; entries with `tier` apply above that context size. */
	readonly cost?: readonly {
		readonly tier?: { readonly type: 'context'; readonly size: number };
		readonly input: number;
		readonly output: number;
		readonly cache: { readonly read: number; readonly write: number };
	}[];
}

export interface ProviderInfo {
	readonly id: string;
	readonly name: string;
	readonly integrationID?: string;
	readonly activation: 'auto' | 'enabled' | 'disabled';
}

export interface AgentInfo {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly mode: 'subagent' | 'primary' | 'all';
	readonly hidden: boolean;
}

export interface SessionInfo {
	readonly id: string;
	readonly title?: string;
	readonly agent?: string;
	readonly model?: ModelRef;
	readonly location: { readonly directory: string };
	readonly time?: { readonly created: number; readonly updated: number };
	/** Set on subagent sessions (children of another session). */
	readonly parentID?: string;
	/** Running token totals, in OpenCode's buckets (`input` excludes cache reads and writes). */
	readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } };
	/** Running cost in USD, as OpenCode computed it from the model's prices. */
	readonly cost?: number;
}

export type IntegrationMethod =
	| { readonly type: 'key'; readonly label?: string }
	| { readonly type: 'env'; readonly names: readonly string[] }
	| { readonly type: 'oauth'; readonly id: string; readonly label: string; readonly form?: readonly FormField[] }
	| { readonly type: 'command'; readonly id: string; readonly label?: string };

export interface IntegrationInfo {
	readonly id: string;
	readonly name: string;
	readonly methods: readonly IntegrationMethod[];
	readonly connections: readonly unknown[];
}

export interface OAuthAttempt {
	readonly attemptID: string;
	readonly url: string;
	readonly instructions: string;
	readonly mode: 'auto' | 'code';
}

export interface FormOption {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface FormField {
	readonly key: string;
	readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
	readonly title?: string;
	readonly description?: string;
	readonly required?: boolean;
	readonly hidden?: boolean;
	readonly default?: unknown;
	readonly options?: readonly FormOption[];
	readonly custom?: boolean;
	readonly placeholder?: string;
}

export interface FormInfo {
	readonly id: string;
	readonly sessionID: string;
	readonly title: string;
	readonly fields: readonly FormField[];
}

export interface PermissionRequest {
	readonly id: string;
	readonly sessionID: string;
	readonly action: string;
	readonly resources: readonly string[];
	readonly message?: string;
	readonly source?: { readonly type: 'tool'; readonly messageID: string; readonly id: string };
}

export type PermissionDecision = 'once' | 'always' | 'reject';

/** One OpenCode permission rule. OpenCode applies the last rule that matches an action and resource. */
export interface PermissionRule {
	readonly action: string;
	readonly resource: string;
	readonly effect: 'allow' | 'ask' | 'deny';
}

export interface ToolContent {
	readonly type: 'text' | 'file';
	readonly text?: string;
	readonly uri?: string;
	readonly mime?: string;
	readonly name?: string;
}

export interface ServerError {
	readonly type?: string;
	readonly message: string;
	readonly status?: number;
}

/** One event from `GET /api/event`. */
export interface OpenCodeEvent {
	readonly id: string;
	readonly type: string;
	readonly created?: number;
	readonly data: Record<string, unknown>;
	readonly location?: { readonly directory: string };
}

/** `{location, data}` envelope returned by location-scoped routes. */
export interface Scoped<T> {
	readonly location?: { readonly directory: string };
	readonly data: T;
}
