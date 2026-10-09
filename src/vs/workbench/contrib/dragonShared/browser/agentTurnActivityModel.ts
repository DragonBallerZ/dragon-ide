/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Vellora AI and Dragon IDE contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IMarkdownString } from '../../../../base/common/htmlContent.js';
import type { IReader } from '../../../../base/common/observable.js';
import { hasKey } from '../../../../base/common/types.js';
import { IChatToolInvocation, ToolConfirmKind, type IChatTerminalToolInvocationData, type IChatToolInvocationSerialized } from '../../chat/common/chatService/chatService.js';
import type { IToolResultInputOutputDetails } from '../../chat/common/tools/languageModelToolsService.js';
import type { IToolCardModel, ToolCardKind, ToolCardStatus } from './toolCallCard.js';

export interface IToolCardProjectionOptions {
	readonly startedAt?: number;
	readonly now?: number;
}

const MAX_PREVIEW = 2400;
const FILE_PATH_RE = /(?:^|[\s"'`(])((?:~|\.{1,2}|\/|[\w@-])[\w@./ -]*\.[\w-]{1,16})(?=$|[\s"'`,:)])/g;

export function toolInvocationToCardModel(
	invocation: IChatToolInvocation | IChatToolInvocationSerialized,
	reader?: IReader,
	options: IToolCardProjectionOptions = {},
): IToolCardModel {
	const state = invocation.kind === 'toolInvocation' ? invocation.state.read(reader) : undefined;
	const message = state?.type === IChatToolInvocation.StateKind.Streaming
		? stringOrMarkdownToText(state.streamingMessage.read(reader)) || stringOrMarkdownToText(invocation.invocationMessage)
		: state?.type === IChatToolInvocation.StateKind.Executing
			? stringOrMarkdownToText(state.progress.read(reader).message) || stringOrMarkdownToText(invocation.invocationMessage)
			: IChatToolInvocation.isComplete(invocation, reader)
				? stringOrMarkdownToText(invocation.pastTenseMessage) || stringOrMarkdownToText(invocation.invocationMessage)
				: stringOrMarkdownToText(invocation.invocationMessage);

	const inputText = getInputPreview(invocation, state, reader);
	const outputText = getOutputPreview(invocation, reader);
	const toolKind = getToolCardKind(invocation, inputText, message);
	const filePaths = unique([
		...extractFilePaths(inputText),
		...extractFilePaths(message),
		...extractFilePaths(outputText),
	]).slice(0, 6);
	const terminalData = getTerminalData(invocation);
	const status = getCardStatus(invocation, reader);
	const title = getTitle(invocation, toolKind);
	const now = options.now ?? Date.now();
	const durationMs = status === 'running' && options.startedAt ? now - options.startedAt : undefined;

	return {
		id: invocation.toolCallId,
		tool: title,
		toolKind,
		subtitle: getSubtitle(toolKind, message, filePaths, terminalData),
		args: inputText,
		output: outputText,
		status,
		durationMs,
		startedAt: status === 'running' ? options.startedAt : undefined,
		errorMessage: getErrorMessage(invocation, reader),
		command: terminalData?.commandLine.userEdited ?? terminalData?.commandLine.toolEdited ?? terminalData?.commandLine.original,
		exitCode: terminalData?.terminalCommandState?.exitCode,
		filePaths,
	};
}

export function stringOrMarkdownToText(value: string | IMarkdownString | undefined): string {
	if (!value) {
		return '';
	}
	return typeof value === 'string' ? value : value.value;
}

export function getToolCardKind(invocation: IChatToolInvocation | IChatToolInvocationSerialized, inputText = '', message = ''): ToolCardKind {
	const dataKind = invocation.toolSpecificData?.kind;
	const haystack = `${invocation.toolId} ${dataKind ?? ''} ${inputText} ${message}`.toLowerCase();
	if (dataKind === 'subagent' || haystack.includes('subagent')) {
		return 'subagent';
	}
	if (dataKind === 'terminal' || /\b(shell|terminal|bash|command|runcommand|run_command|npm|pnpm|yarn|make|cargo|go test)\b/.test(haystack)) {
		return 'terminal';
	}
	if (/\b(browser|screenshot|click|navigate|page|dom|viewport)\b/.test(haystack)) {
		return 'browser';
	}
	if (/\b(test|lint|typecheck|validate|verify|diagnostic|preflight)\b/.test(haystack)) {
		return 'validation';
	}
	if (/\b(edit|write|replace|patch|create|delete|apply|notebook)\b/.test(haystack)) {
		return 'code';
	}
	if (/\b(read|search|grep|find|list|semantic|glob|context|symbol)\b/.test(haystack)) {
		return 'context';
	}
	if (/\bcheckpoint|restore|undo\b/.test(haystack)) {
		return 'checkpoint';
	}
	return 'tool';
}

function getTitle(invocation: IChatToolInvocation | IChatToolInvocationSerialized, kind: ToolCardKind): string {
	if (kind === 'terminal') {
		return 'Terminal';
	}
	if (kind === 'code') {
		return 'Writing code';
	}
	if (kind === 'context') {
		return 'Reading context';
	}
	if (kind === 'browser') {
		return 'Browser action';
	}
	if (kind === 'validation') {
		return 'Validation';
	}
	if (kind === 'subagent') {
		const data = invocation.toolSpecificData?.kind === 'subagent' ? invocation.toolSpecificData : undefined;
		return data?.agentName ? `Sub-agent: ${data.agentName}` : 'Sub-agent';
	}
	if (kind === 'checkpoint') {
		return 'Checkpoint';
	}
	return invocation.toolId || 'Tool';
}

function getSubtitle(kind: ToolCardKind, message: string, filePaths: readonly string[], terminalData: IChatTerminalToolInvocationData | undefined): string {
	if (kind === 'terminal') {
		const command = terminalData?.commandLine.userEdited ?? terminalData?.commandLine.toolEdited ?? terminalData?.commandLine.original;
		return command || message || 'Running command';
	}
	if (kind === 'code' && filePaths.length) {
		return filePaths.length === 1 ? filePaths[0] : `${filePaths.length} files changing`;
	}
	if (kind === 'context' && filePaths.length) {
		return filePaths.length === 1 ? filePaths[0] : `${filePaths.length} files in context`;
	}
	return message;
}

function getCardStatus(invocation: IChatToolInvocation | IChatToolInvocationSerialized, reader?: IReader): ToolCardStatus {
	if (invocation.kind === 'toolInvocationSerialized') {
		const confirmed = invocation.isConfirmed;
		return confirmed === false || isDeniedOrSkipped(confirmed) ? 'cancelled' : 'success';
	}
	const state = invocation.state.read(reader);
	switch (state.type) {
		case IChatToolInvocation.StateKind.Streaming:
		case IChatToolInvocation.StateKind.Executing:
			return 'running';
		case IChatToolInvocation.StateKind.WaitingForConfirmation:
		case IChatToolInvocation.StateKind.WaitingForPostApproval:
		case IChatToolInvocation.StateKind.WaitingForAuthentication:
			return 'waiting';
		case IChatToolInvocation.StateKind.Completed: {
			const details = IChatToolInvocation.resultDetails(invocation, reader);
			return isInputOutputDetails(details) && details.isError ? 'error' : 'success';
		}
		case IChatToolInvocation.StateKind.Cancelled:
			return 'cancelled';
	}
}

function getErrorMessage(invocation: IChatToolInvocation | IChatToolInvocationSerialized, reader?: IReader): string | undefined {
	if (invocation.kind !== 'toolInvocation') {
		return undefined;
	}
	const state = invocation.state.read(reader);
	if (state.type === IChatToolInvocation.StateKind.Cancelled) {
		return stringOrMarkdownToText(state.reasonMessage) || 'Cancelled';
	}
	const details = IChatToolInvocation.resultDetails(invocation, reader);
	if (isInputOutputDetails(details) && details.isError) {
		return outputDetailsToText(details);
	}
	return undefined;
}

function getInputPreview(invocation: IChatToolInvocation | IChatToolInvocationSerialized, state: IChatToolInvocation.State | undefined, reader?: IReader): string | undefined {
	if (state?.type === IChatToolInvocation.StateKind.Streaming) {
		return stringifyPreview(state.partialInput.read(reader));
	}
	if (invocation.toolSpecificData?.kind === 'input') {
		return stringifyPreview(invocation.toolSpecificData.rawInput);
	}
	if (invocation.toolSpecificData?.kind === 'simpleToolInvocation') {
		return trimPreview(invocation.toolSpecificData.input);
	}
	const params = invocation.kind === 'toolInvocation' ? IChatToolInvocation.getParameters(invocation, reader) : undefined;
	return stringifyPreview(params);
}

function getOutputPreview(invocation: IChatToolInvocation | IChatToolInvocationSerialized, reader?: IReader): string | undefined {
	const terminalData = getTerminalData(invocation);
	if (terminalData) {
		const output = terminalData.terminalCommandOutput?.text;
		if (output) {
			return trimPreview(output);
		}
	}
	if (invocation.toolSpecificData?.kind === 'simpleToolInvocation') {
		return trimPreview(invocation.toolSpecificData.output);
	}
	if (invocation.toolSpecificData?.kind === 'subagent' && invocation.toolSpecificData.result) {
		return trimPreview(invocation.toolSpecificData.result);
	}
	const details = IChatToolInvocation.resultDetails(invocation, reader);
	if (isInputOutputDetails(details)) {
		return outputDetailsToText(details);
	}
	return undefined;
}

function outputDetailsToText(details: IToolResultInputOutputDetails): string | undefined {
	const output = details.output
		.map(part => part.type === 'embed' && part.isText ? part.value : part.type === 'ref' ? part.uri.toString() : '')
		.filter(Boolean)
		.join('\n');
	return trimPreview(output);
}

function isInputOutputDetails(value: unknown): value is IToolResultInputOutputDetails {
	return !!value && typeof value === 'object' && Array.isArray((value as { output?: unknown }).output);
}

function getTerminalData(invocation: IChatToolInvocation | IChatToolInvocationSerialized): IChatTerminalToolInvocationData | undefined {
	return invocation.toolSpecificData?.kind === 'terminal' && hasKey(invocation.toolSpecificData, { commandLine: true })
		? invocation.toolSpecificData as IChatTerminalToolInvocationData
		: undefined;
}

function stringifyPreview(value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	if (typeof value === 'string') {
		return trimPreview(value);
	}
	try {
		return trimPreview(JSON.stringify(value, null, 2));
	} catch {
		return trimPreview(String(value));
	}
}

function trimPreview(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	return value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW)}\n...` : value;
}

function extractFilePaths(value: string | undefined): string[] {
	if (!value) {
		return [];
	}
	const paths: string[] = [];
	for (const match of value.matchAll(FILE_PATH_RE)) {
		const candidate = match[1].trim();
		if (candidate.length > 2 && !candidate.includes('://')) {
			paths.push(candidate);
		}
	}
	return paths;
}

function unique(values: readonly string[]): string[] {
	return Array.from(new Set(values));
}

function isDeniedOrSkipped(value: IChatToolInvocationSerialized['isConfirmed']): boolean {
	return typeof value === 'object' && !!value && (value.type === ToolConfirmKind.Denied || value.type === ToolConfirmKind.Skipped);
}
