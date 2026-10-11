/**
 * ACP → collab wire, as pure functions: what a vendor agent says over the Agent Client Protocol becomes
 * the assistant messages, tool cards, events and approval prompts the app already renders for omp.
 *
 * Tool calls map to omp's tool names where an ACP `kind` says what they are (`read`, `edit`/`write`,
 * `execute` → `bash`, `search` → `grep`/`glob`, `fetch` → `fetch`/`web_search`) so the app's renderers
 * show them; any other call is a generic card. A plan becomes a `todo` call and result, so the app's task
 * list follows it. Nothing here touches a process, a file or a socket: `./foreign-host.ts` owns those.
 */

import type {
	AssistantContent,
	AssistantMessage,
	CollabApprovalChoiceKind,
	CollabCommand,
	CollabUiApproval,
	ImageContent,
	SessionEntry,
	StopReason as WireStopReason,
	TextContent,
	ToolResultMessage,
	WireMessage,
	WireModel,
	WireUsage,
	AgentEvent,
} from "@oh-my-pi/pi-wire";
import type {
	AvailableCommand,
	ContentBlock,
	PermissionOption,
	PlanEntry,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionModeState,
	SessionUpdate,
	StopReason,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolCallStatus,
	ToolCallUpdate,
	ToolKind,
	Usage,
} from "@oh-my-pi/pi-utils/acp/protocol";
import { isRecord, str } from "../../src/tool-render/util";
import { describeGrants, deriveSessionGrants, type SessionGrant } from "./grants";

// ═══════════════════════════════════════════════════════════════════════════
// Stop reasons, usage
// ═══════════════════════════════════════════════════════════════════════════

/** ACP stop reason → the wire's: `end_turn` stop, `max_tokens` length, `cancelled` aborted, a refusal an error. */
export function wireStopReason(reason: StopReason): WireStopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
		case "max_turn_requests":
			return "length";
		case "cancelled":
			return "aborted";
		case "refusal":
			return "error";
	}
}

/** Human text for a stop reason that is not a normal end of turn; null when the turn simply ended. */
export function stopMessage(reason: StopReason): string | null {
	switch (reason) {
		case "end_turn":
			return null;
		case "max_tokens":
			return "the agent stopped at its output token limit";
		case "max_turn_requests":
			return "the agent stopped at its limit of model requests for one turn";
		case "refusal":
			return "the agent refused to continue";
		case "cancelled":
			return null;
	}
}

export function zeroUsage(): WireUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
}

/** The wire usage of one turn from the agent's end-of-turn token counts and the cost the turn added. */
export function wireUsage(usage: Usage | null | undefined, costUsd: number): WireUsage {
	const input = usage?.inputTokens ?? 0;
	const output = usage?.outputTokens ?? 0;
	const cacheRead = usage?.cachedReadTokens ?? 0;
	const cacheWrite = usage?.cachedWriteTokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: { total: costUsd },
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Diffs
// ═══════════════════════════════════════════════════════════════════════════

const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_LINES = 1_500;

/**
 * A unified-style diff of one changed region of `oldText` → `newText` (what the app's diff block draws):
 * the common head and tail are trimmed, three lines of context stay. `null` old text is a new file.
 */
export function unifiedDiff(
	oldText: string | null | undefined,
	newText: string,
): { diff: string; firstChangedLine: number } {
	const before = oldText == null || oldText === "" ? [] : oldText.split("\n");
	const after = newText === "" ? [] : newText.split("\n");
	let head = 0;
	while (head < before.length && head < after.length && before[head] === after[head]) head++;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	) {
		tail++;
	}
	const removed = before.slice(head, before.length - tail);
	const added = after.slice(head, after.length - tail);
	const contextBefore = before.slice(Math.max(0, head - DIFF_CONTEXT_LINES), head);
	const contextAfter = before.slice(before.length - tail, before.length - tail + DIFF_CONTEXT_LINES);
	const startOld = head - contextBefore.length + 1;
	const lines = [
		`@@ -${startOld},${contextBefore.length + removed.length + contextAfter.length} +${startOld},${contextBefore.length + added.length + contextAfter.length} @@`,
		...contextBefore.map(line => ` ${line}`),
		...removed.map(line => `-${line}`),
		...added.map(line => `+${line}`),
		...contextAfter.map(line => ` ${line}`),
	];
	const shown =
		lines.length > DIFF_MAX_LINES
			? [...lines.slice(0, DIFF_MAX_LINES), `… ${lines.length - DIFF_MAX_LINES} more lines`]
			: lines;
	return { diff: shown.join("\n"), firstChangedLine: head + 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool calls → cards
// ═══════════════════════════════════════════════════════════════════════════

/** What the app needs to draw a tool call: omp's tool name where one fits, its arguments, an intent line. */
export interface ToolView {
	name: string;
	args: Record<string, unknown>;
	intent?: string;
}

/** A tool call as the agent's notifications have built it so far. */
export interface ToolState {
	id: string;
	title: string;
	kind: ToolKind;
	status: ToolCallStatus;
	content: ToolCallContent[];
	locations: ToolCallLocation[];
	rawInput: unknown;
	rawOutput: unknown;
}

/** Result of a tool call as the wire carries it (`tool_execution_end.result`, a `toolResult` message). */
export interface ToolOutcome {
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
}

export function newToolState(call: ToolCall): ToolState {
	return {
		id: call.toolCallId,
		title: call.title,
		kind: call.kind ?? "other",
		status: call.status ?? "pending",
		content: call.content ?? [],
		locations: call.locations ?? [],
		rawInput: call.rawInput,
		rawOutput: call.rawOutput,
	};
}

/** A `tool_call_update` folded into the state: fields it carries replace the old ones. */
export function mergeToolUpdate(state: ToolState, update: ToolCallUpdate): ToolState {
	return {
		id: state.id,
		title: update.title ?? state.title,
		kind: update.kind ?? state.kind,
		status: update.status ?? state.status,
		content: update.content ?? state.content,
		locations: update.locations ?? state.locations,
		rawInput: update.rawInput === undefined ? state.rawInput : update.rawInput,
		rawOutput: update.rawOutput === undefined ? state.rawOutput : update.rawOutput,
	};
}

const MAX_ARG_CHARS = 20_000;
const MAX_ARG_DEPTH = 4;

/** `value` with strings clipped and depth bounded, so a whole file in a tool's input never crosses the relay twice. */
function clip(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}…` : value;
	if (depth >= MAX_ARG_DEPTH) return typeof value === "object" && value !== null ? "…" : value;
	if (Array.isArray(value)) return value.slice(0, 50).map(item => clip(item, depth + 1));
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) out[key] = clip(inner, depth + 1);
		return out;
	}
	return value;
}

function firstString(record: unknown, keys: readonly string[]): string | null {
	if (!isRecord(record)) return null;
	for (const key of keys) {
		const value = str(record[key]);
		if (value !== null && value !== "") return value;
	}
	return null;
}

/** The file a call touches: its locations, a diff's path, or the usual input field names. */
function pathOf(state: ToolState): string | null {
	const located = state.locations.find(location => typeof location.path === "string" && location.path !== "");
	if (located) return located.path;
	for (const item of state.content) if (item.type === "diff") return item.path;
	return firstString(state.rawInput, ["file_path", "filePath", "path", "notebook_path", "target_file"]);
}

function diffsOf(state: ToolState): Extract<ToolCallContent, { type: "diff" }>[] {
	return state.content.filter((item): item is Extract<ToolCallContent, { type: "diff" }> => item.type === "diff");
}

/** The text of a content block; non-text blocks read as a short placeholder. */
export function blockText(block: ContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
			return `[image: ${block.mimeType}]`;
		case "audio":
			return `[audio: ${block.mimeType}]`;
		case "resource_link":
			return block.title || block.name ? `[${block.title ?? block.name}](${block.uri})` : block.uri;
		case "resource":
			return "text" in block.resource ? block.resource.text : `[binary resource: ${block.resource.uri}]`;
	}
}

/** The text a raw tool output carries: a string, or the usual `output`/`stdout`/`content` fields of an object. */
function rawText(raw: unknown): string | null {
	if (typeof raw === "string") return raw;
	if (!isRecord(raw)) return null;
	const parts = ["output", "stdout", "stderr", "text", "content", "result"]
		.map(key => raw[key])
		.filter((part): part is string => typeof part === "string" && part !== "");
	return parts.length > 0 ? parts.join("\n") : null;
}

function exitCodeOf(raw: unknown): number | null {
	if (!isRecord(raw)) return null;
	for (const value of [
		raw.exit_code,
		raw.exitCode,
		raw.exit,
		isRecord(raw.metadata) ? raw.metadata.exit : undefined,
	]) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

const KNOWN_TOOL_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The card name of a call with no better mapping: its title. A title that reads as one of omp's own tool
 * names (a bare lowercase word) is prefixed, so it can never pick an omp renderer by accident.
 */
function genericName(title: string): string {
	const trimmed = title.trim().slice(0, 60) || "tool";
	return KNOWN_TOOL_NAME.test(trimmed) ? `acp:${trimmed}` : trimmed;
}

/** What the app draws for `state`; see the file comment for the mapping. */
export function toolView(state: ToolState): ToolView {
	const path = pathOf(state);
	const input = state.rawInput;
	const intent = firstString(input, ["description"]) ?? undefined;
	switch (state.kind) {
		case "read":
			return { name: "read", args: path === null ? { path: state.title } : { path }, intent };
		case "edit": {
			const diffs = diffsOf(state);
			const first = diffs[0];
			if (first !== undefined && first.oldText == null && diffs.length === 1) {
				return { name: "write", args: { path: first.path, content: clip(first.newText) }, intent };
			}
			if (first === undefined && path !== null && isRecord(input) && typeof input.content === "string") {
				return { name: "write", args: { path, content: clip(input.content) }, intent };
			}
			return { name: "edit", args: { path: path ?? state.title }, intent };
		}
		case "execute": {
			const command = firstString(input, ["command", "cmd"]) ?? state.title;
			const cwd = firstString(input, ["cwd", "workdir"]);
			return { name: "bash", args: cwd === null ? { command } : { command, cwd }, intent };
		}
		case "search": {
			const pattern = firstString(input, ["pattern", "query", "regex"]) ?? state.title;
			const scope = firstString(input, ["path", "directory"]);
			const globby = /^(glob|find|ls|list)\b/i.test(state.title.trim());
			const args: Record<string, unknown> = { pattern };
			if (scope !== null) args.path = scope;
			const include = firstString(input, ["glob", "include"]);
			if (include !== null && !globby) args.glob = include;
			return { name: globby ? "glob" : "grep", args, intent };
		}
		case "fetch": {
			const url = firstString(input, ["url", "uri"]);
			if (url !== null) return { name: "fetch", args: { url }, intent };
			const query = firstString(input, ["query", "q"]);
			if (query !== null) return { name: "web_search", args: { query }, intent };
			return { name: "fetch", args: { url: state.title }, intent };
		}
		default:
			return {
				name: genericName(state.title),
				args: isRecord(input)
					? (clip(input) as Record<string, unknown>)
					: input === undefined
						? { kind: state.kind }
						: { input: clip(input) },
				intent,
			};
	}
}

/** The text the call reported: its content blocks, else its raw output, else nothing. */
function outcomeText(state: ToolState): string {
	const parts: string[] = [];
	for (const item of state.content) {
		if (item.type === "content" && item.content.type !== "image") parts.push(blockText(item.content));
	}
	const text = parts.join("\n");
	if (text !== "") return text;
	return rawText(state.rawOutput) ?? "";
}

/** The result of `state`, for a running update (`status` still open) or the end of the call. */
export function toolOutcome(state: ToolState): ToolOutcome {
	const view = toolView(state);
	const isError = state.status === "failed";
	const content: (TextContent | ImageContent)[] = [];
	for (const item of state.content) {
		if (item.type === "content" && item.content.type === "image") {
			content.push({ type: "image", data: item.content.data, mimeType: item.content.mimeType });
		}
	}
	let text = outcomeText(state);
	let details: Record<string, unknown> | undefined;
	if (view.name === "edit" || view.name === "write") {
		const files = diffsOf(state).map(diff => {
			const made = unifiedDiff(diff.oldText, diff.newText);
			return {
				path: diff.path,
				diff: made.diff,
				firstChangedLine: made.firstChangedLine,
				op: diff.oldText == null ? "create" : "update",
				isError,
				...(isError && text !== "" ? { errorText: text } : {}),
			};
		});
		if (files.length === 1) details = { ...files[0] };
		else if (files.length > 1) details = { perFileResults: files };
		if (text === "")
			text = isError
				? "The edit failed."
				: `${view.name === "write" ? "Wrote" : "Edited"} ${String(view.args.path ?? "the file")}`;
	} else if (view.name === "bash") {
		const exitCode = exitCodeOf(state.rawOutput);
		if (exitCode !== null) details = { exitCode };
	}
	if (text === "" && content.length === 0) text = isError ? "The tool call failed." : "Done.";
	if (text !== "") content.unshift({ type: "text", text });
	return { content, details, isError };
}

// ═══════════════════════════════════════════════════════════════════════════
// Plans → todo
// ═══════════════════════════════════════════════════════════════════════════

/** A plan as a `todo` call (what the app's task list reads) and its result. */
export function planTodo(entries: readonly PlanEntry[]): { args: Record<string, unknown>; outcome: ToolOutcome } {
	const tasks = entries.map(entry => ({ content: entry.content, status: entry.status }));
	const done = tasks.filter(task => task.status === "completed").length;
	return {
		args: { op: "replace", list: [{ phase: "Plan", items: entries.map(entry => entry.content) }] },
		outcome: {
			content: [{ type: "text", text: `Plan updated: ${done}/${tasks.length} done` }],
			details: { phases: [{ name: "Plan", tasks }] },
			isError: false,
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Turns: updates → events and messages
// ═══════════════════════════════════════════════════════════════════════════

/** What a turn produces, in order: an event for the live view, or a finished message the host appends as an entry. */
export type TurnOp = { type: "event"; event: AgentEvent } | { type: "message"; message: WireMessage };

/**
 * Drop each `message_update` that another update of the same stream immediately follows: a burst of text
 * chunks reaches guests as one full partial message, not one frame per chunk.
 */
export function coalesceOps(ops: readonly TurnOp[]): TurnOp[] {
	const out: TurnOp[] = [];
	for (const op of ops) {
		const last = out.at(-1);
		if (
			op.type === "event" &&
			op.event.type === "message_update" &&
			last?.type === "event" &&
			last.event.type === "message_update"
		) {
			out[out.length - 1] = op;
			continue;
		}
		out.push(op);
	}
	return out;
}

export interface TurnBuilderOptions {
	/** `model` of the assistant messages (the vendor's model id; the agent's name before one is known). */
	model: () => string;
	/** Agent id, recorded as the messages' `provider`. */
	provider: string;
	now?: () => number;
}

/** An assistant message as the transcript stores it: the wire's plus the vendor it came from. */
export type ForeignAssistantMessage = AssistantMessage & { provider: string };

/**
 * Builds the assistant messages and tool results of one prompt turn from the agent's `session/update`
 * notifications. A tool call closes the message it interrupts (text so far plus the call, stop reason
 * `toolUse`), as an omp turn is a chain of messages each ending in tool calls; the call's result follows as
 * its own message when the call ends. A call is announced once its input is known (or on the first
 * thing that depends on it), since an entry is immutable once written.
 */
export class TurnBuilder {
	readonly #opts: TurnBuilderOptions;
	/** Content of the assistant message being streamed; empty when none is open. */
	#content: AssistantContent[] = [];
	#open = false;
	readonly #tools = new Map<string, ToolState>();
	/** Calls whose card is announced (an assistant message with the call went out). */
	readonly #announced = new Set<string>();
	readonly #ended = new Set<string>();
	#planSeq = 0;

	constructor(opts: TurnBuilderOptions) {
		this.#opts = opts;
	}

	#now(): number {
		return this.#opts.now?.() ?? Date.now();
	}

	#assistant(
		stopReason: WireStopReason,
		usage: WireUsage = zeroUsage(),
		errorMessage?: string,
	): ForeignAssistantMessage {
		return {
			role: "assistant",
			content: this.#content.map(block => ({ ...block })),
			model: this.#opts.model(),
			provider: this.#opts.provider,
			usage,
			stopReason,
			...(errorMessage === undefined ? {} : { errorMessage }),
			timestamp: this.#now(),
		};
	}

	/** Whether any call is announced and not yet ended. */
	get hasRunningTools(): boolean {
		for (const id of this.#announced) if (!this.#ended.has(id)) return true;
		return false;
	}

	/** Chunks append to the last block of their kind; the first one opens the message. */
	#chunk(kind: "text" | "thinking", text: string): TurnOp[] {
		const ops: TurnOp[] = [];
		const last = this.#content.at(-1);
		if (kind === "text" && last?.type === "text") last.text += text;
		else if (kind === "thinking" && last?.type === "thinking") last.thinking += text;
		else this.#content.push(kind === "text" ? { type: "text", text } : { type: "thinking", thinking: text });
		const partial = this.#assistant("stop");
		if (!this.#open) {
			this.#open = true;
			ops.push({ type: "event", event: { type: "message_start", message: partial } });
		}
		ops.push({ type: "event", event: { type: "message_update", message: partial } });
		return ops;
	}

	/** Close the open message with `stopReason`: its last update, `message_end`, then the entry. */
	#close(stopReason: WireStopReason, usage?: WireUsage, errorMessage?: string): TurnOp[] {
		const message = this.#assistant(stopReason, usage, errorMessage);
		const ops: TurnOp[] = [];
		if (this.#open) {
			ops.push({ type: "event", event: { type: "message_update", message } });
			ops.push({ type: "event", event: { type: "message_end", message } });
		}
		ops.push({ type: "message", message });
		this.#content = [];
		this.#open = false;
		return ops;
	}

	/** Announce a call: close the message around it, then start its card. */
	#announce(id: string, view: ToolView): TurnOp[] {
		this.#announced.add(id);
		this.#content.push({
			type: "toolCall",
			id,
			name: view.name,
			arguments: view.args,
			...(view.intent === undefined ? {} : { intent: view.intent }),
		});
		const ops = this.#close("toolUse");
		ops.push({
			type: "event",
			event: {
				type: "tool_execution_start",
				toolCallId: id,
				toolName: view.name,
				args: view.args,
				intent: view.intent,
			},
		});
		return ops;
	}

	/** The events and message that end call `id`; empty when it already ended. */
	#result(id: string, toolName: string, outcome: ToolOutcome): TurnOp[] {
		if (this.#ended.has(id)) return [];
		this.#ended.add(id);
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName,
			content: outcome.content,
			...(outcome.details === undefined ? {} : { details: outcome.details }),
			isError: outcome.isError,
			timestamp: this.#now(),
		};
		return [
			{
				type: "event",
				event: {
					type: "tool_execution_end",
					toolCallId: id,
					toolName,
					result: { content: outcome.content, details: outcome.details },
					isError: outcome.isError,
				},
			},
			{ type: "message", message },
		];
	}

	#end(state: ToolState): TurnOp[] {
		return this.#result(state.id, toolView(state).name, toolOutcome(state));
	}

	/**
	 * Start a call the host makes up (a question the agent asked through the protocol, not a tool): it closes
	 * the message in progress like any call and stays open until {@link endSynthetic}.
	 */
	beginSynthetic(id: string, view: ToolView): TurnOp[] {
		return this.#announce(id, view);
	}

	endSynthetic(id: string, toolName: string, outcome: ToolOutcome): TurnOp[] {
		return this.#result(id, toolName, outcome);
	}

	/** Whether the call has what its card needs: an input, or it already moved past `pending`. */
	static #ready(state: ToolState): boolean {
		return (
			state.rawInput !== undefined ||
			state.content.length > 0 ||
			state.locations.length > 0 ||
			state.status !== "pending"
		);
	}

	#settle(state: ToolState): TurnOp[] {
		const ops: TurnOp[] = [];
		if (!this.#announced.has(state.id)) {
			if (!TurnBuilder.#ready(state)) return ops;
			ops.push(...this.#announce(state.id, toolView(state)));
		}
		if (state.status === "completed" || state.status === "failed") ops.push(...this.#end(state));
		else if (state.status === "in_progress" && !this.#ended.has(state.id)) {
			const view = toolView(state);
			const outcome = toolOutcome(state);
			ops.push({
				type: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: state.id,
					toolName: view.name,
					args: view.args,
					partialResult: { content: outcome.content, details: outcome.details },
				},
			});
		}
		return ops;
	}

	/** Announce a call that is waiting on a permission prompt, so the card exists when the prompt shows. */
	ensureAnnounced(id: string, patch?: ToolCallUpdate): TurnOp[] {
		let state = this.#tools.get(id);
		if (patch !== undefined) {
			state =
				state === undefined
					? newToolState({ ...patch, title: patch.title ?? "tool" })
					: mergeToolUpdate(state, patch);
			this.#tools.set(id, state);
		}
		if (state === undefined || this.#announced.has(id)) return [];
		return this.#announce(id, toolView(state));
	}

	/** The state of a call the agent mentioned; undefined for an unknown id. */
	tool(id: string): ToolState | undefined {
		return this.#tools.get(id);
	}

	/** One `session/update` of this turn. Updates that are not about the conversation (commands, usage, …) yield nothing. */
	update(update: SessionUpdate): TurnOp[] {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const text = blockText(update.content);
				return text === "" ? [] : this.#chunk("text", text);
			}
			case "agent_thought_chunk": {
				const text = blockText(update.content);
				return text === "" ? [] : this.#chunk("thinking", text);
			}
			case "tool_call": {
				const state = newToolState(update);
				this.#tools.set(state.id, state);
				return this.#settle(state);
			}
			case "tool_call_update": {
				const known = this.#tools.get(update.toolCallId);
				const state =
					known === undefined
						? newToolState({ ...update, title: update.title ?? "tool" })
						: mergeToolUpdate(known, update);
				this.#tools.set(state.id, state);
				return this.#settle(state);
			}
			case "plan": {
				const id = `plan-${++this.#planSeq}`;
				const todo = planTodo(update.entries);
				return [
					...this.beginSynthetic(id, { name: "todo", args: todo.args }),
					...this.endSynthetic(id, "todo", todo.outcome),
				];
			}
			default:
				return [];
		}
	}

	/**
	 * The turn is over: calls still open end as failed (an interrupted turn leaves none running), then the
	 * message in progress closes with the turn's stop reason and usage. A turn that ends cleanly with
	 * nothing left to say adds no message unless it carries usage.
	 */
	finish(stop: StopReason, usage: WireUsage | null, errorMessage?: string): TurnOp[] {
		const ops: TurnOp[] = [];
		for (const state of this.#tools.values()) {
			if (this.#ended.has(state.id)) continue;
			if (!this.#announced.has(state.id)) ops.push(...this.#announce(state.id, toolView(state)));
			ops.push(
				...this.#end({
					...state,
					status: "failed",
					content: [],
					rawOutput: stop === "cancelled" ? "Interrupted" : "The turn ended before the tool call did",
				}),
			);
		}
		const wireStop = wireStopReason(stop);
		const hasUsage = usage !== null && (usage.totalTokens > 0 || usage.cost.total > 0);
		if (this.#content.length === 0 && wireStop === "stop" && !hasUsage) return ops;
		ops.push(...this.#close(wireStop, usage ?? undefined, wireStop === "error" ? errorMessage : undefined));
		return ops;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Permission requests → the app's approval prompt
// ═══════════════════════════════════════════════════════════════════════════

export const APPROVE_ONCE_LABEL = "Approve once";
export const APPROVE_SESSION_LABEL = "Approve for this session";
export const DENY_LABEL = "Deny";

/** What the host knows about the call besides the permission request itself. */
export interface ApprovalContext {
	/** The session's working folder. */
	cwd: string;
	/** Every file the call reads or writes, as the agent spelled them. */
	targets: readonly string[];
	/** Why the call leaves the agent's sandbox, or null when it does not. */
	escalation: string | null;
}

/** The approval prompt for one `session/request_permission`, and how each answer maps back. */
export interface ApprovalPlan {
	/** The question and its details (`Label: value` lines), for the prompt's title. */
	title: string;
	options: string[];
	approval: CollabUiApproval;
	/** What a "for this session" answer saves; empty when that choice is not offered. */
	grants: SessionGrant[];
	/** Why the call leaves the sandbox (see {@link ApprovalContext}). */
	escalation: string | null;
	/** ACP option ids: the one-time allow (null when the agent offers none) and a rejection (null: cancel). */
	allowOnce: string | null;
	reject: string | null;
}

/** Every file a call touches: its locations, its diffs and the usual input fields, deduplicated. */
export function toolTargets(state: ToolState): string[] {
	const targets = new Set<string>();
	for (const location of state.locations) if (location.path !== "") targets.add(location.path);
	for (const diff of diffsOf(state)) targets.add(diff.path);
	const field = firstString(state.rawInput, ["file_path", "filePath", "path", "notebook_path", "target_file"]);
	if (field !== null) targets.add(field);
	return [...targets].slice(0, 16);
}

const ESCALATION_FLAGS: Record<string, string> = {
	with_escalated_permissions: "it asks to run without the sandbox",
	require_escalated: "it asks to run without the sandbox",
	dangerouslyDisableSandbox: "it asks to run without the sandbox",
	dangerously_disable_sandbox: "it asks to run without the sandbox",
};

/**
 * Why a call leaves the agent's sandbox, or null. Codex marks it with `sandbox_permissions` (anything but
 * `use_default`) or `with_escalated_permissions`, and asks for more access with `additional_permissions` /
 * `additionalPermissions`, or for the network with a title like "http network access to host" (its approval
 * carries only a url); Claude Code's shell tool has `dangerouslyDisableSandbox`. The input fields are looked for
 * at the top and one level down.
 */
export function escalationReason(title: string, ...inputs: readonly unknown[]): string | null {
	if (/\bnetwork access\b/i.test(title)) return "it asks for network access";
	for (const input of inputs) {
		for (const record of [input, ...(isRecord(input) ? Object.values(input) : [])]) {
			if (!isRecord(record)) continue;
			for (const [key, why] of Object.entries(ESCALATION_FLAGS)) {
				if (record[key] === true) return why;
			}
			const mode = record.sandbox_permissions ?? record.sandboxPermissions;
			if (typeof mode === "string" && mode !== "use_default" && mode !== "default") {
				return `it asks for ${mode.slice(0, 60)} permissions`;
			}
			const extra = record.additional_permissions ?? record.additionalPermissions;
			if (isRecord(extra) && Object.keys(extra).length > 0) return "it asks for extra permissions";
		}
	}
	return null;
}

function detailLine(view: ToolView): string {
	const text = (label: string, value: unknown): string =>
		`${label}: ${String(value).split("\n")[0]?.slice(0, 300) ?? ""}`;
	if (view.name === "bash") return text("Command", view.args.command);
	if (view.name === "fetch") return text("URL", view.args.url);
	if (view.name === "web_search") return text("Query", view.args.query);
	if (typeof view.args.path === "string") return text("Path", view.args.path);
	if (typeof view.args.pattern === "string") return text("Pattern", view.args.pattern);
	return text("Request", view.name);
}

function optionOf(options: readonly PermissionOption[], kind: PermissionOption["kind"]): string | null {
	return options.find(option => option.kind === kind)?.optionId ?? null;
}

/**
 * The prompt for a permission request. The agent's own "always allow" options are never offered or sent:
 * a grant for the session is a rule the host keeps and answers with a one-time allow each time. An agent
 * with no one-time allow gets only Deny; a call with no safe narrow rule (a compound shell line, a write
 * outside the folder, a fetch) and a call that leaves the sandbox get no session choice.
 */
export function planApproval(
	request: RequestPermissionRequest,
	view: ToolView,
	context: ApprovalContext,
): ApprovalPlan {
	const allowOnce = optionOf(request.options, "allow_once");
	const reject = optionOf(request.options, "reject_once");
	const escalation = context.escalation;
	const grants =
		allowOnce === null || escalation !== null
			? []
			: deriveSessionGrants({ name: view.name, args: view.args, targets: context.targets }, context.cwd);
	const rule = describeGrants(grants, context.cwd);
	const choices: { label: string; kind: CollabApprovalChoiceKind }[] = [];
	if (allowOnce !== null) choices.push({ label: APPROVE_ONCE_LABEL, kind: "once" });
	if (grants.length > 0) choices.push({ label: APPROVE_SESSION_LABEL, kind: "session" });
	choices.push({ label: DENY_LABEL, kind: "deny" });
	const lines = [`Allow tool: ${view.name}`, detailLine(view)];
	if (escalation !== null) lines.unshift(`Leaves the sandbox: ${escalation}`);
	if (allowOnce === null) lines.push("This agent offers no one-time approval, so the call can only be denied");
	else if (grants.length > 0) lines.push(`Rule saved by the session choice: ${rule}`);
	return {
		title: lines.join("\n"),
		options: choices.map(choice => choice.label),
		approval: { tool: view.name, ...(grants.length > 0 ? { rule } : {}), guestProject: false, choices },
		grants,
		escalation,
		allowOnce,
		reject,
	};
}

/** The kind of choice a label answers; anything unknown (a dismissed prompt included) is a denial. */
export function choiceKind(plan: ApprovalPlan, label: string | undefined): CollabApprovalChoiceKind {
	return plan.approval.choices.find(choice => choice.label === label)?.kind ?? "deny";
}

/** The ACP outcome for an answer: the one-time allow for `once` / `session`, a rejection (or a cancel) for `deny`. */
export function approvalOutcome(
	plan: ApprovalPlan,
	kind: CollabApprovalChoiceKind,
): RequestPermissionResponse["outcome"] {
	if ((kind === "once" || kind === "session") && plan.allowOnce !== null) {
		return { outcome: "selected", optionId: plan.allowOnce };
	}
	return plan.reject === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: plan.reject };
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent metadata: commands, models, thinking, context, cost
// ═══════════════════════════════════════════════════════════════════════════

/** What the agent has told us about itself and its session, as the welcome and the state need it. */
export interface AgentMeta {
	commands: CollabCommand[];
	models: WireModel[];
	currentModel: string | null;
	/** How a model switch is sent: a config option, or the agent's own model state. */
	modelVia: { kind: "config"; configId: string } | { kind: "set_model" } | null;
	thinkingLevels: string[];
	thinkingLevel: string | null;
	thinkingConfigId: string | null;
	title: string | null;
	contextUsed: number | null;
	contextSize: number | null;
	/** Cumulative cost of the session in USD, when the agent reports it. */
	costUsd: number | null;
}

export function emptyMeta(): AgentMeta {
	return {
		commands: [],
		models: [],
		currentModel: null,
		modelVia: null,
		thinkingLevels: [],
		thinkingLevel: null,
		thinkingConfigId: null,
		title: null,
		contextUsed: null,
		contextSize: null,
		costUsd: null,
	};
}

/** The agent's slash commands as the app lists them (a leading `/` is the app's to add). */
export function collabCommands(commands: readonly AvailableCommand[]): CollabCommand[] {
	return commands.flatMap(command => {
		const name = command.name.replace(/^\/+/, "");
		if (name === "") return [];
		return [
			{
				name,
				...(command.description ? { description: command.description } : {}),
				...(command.input?.hint ? { args: command.input.hint } : {}),
			},
		];
	});
}

/** The `models` block some agents send besides config options (`session/new`'s unstable model state). */
export interface ModelState {
	currentModelId: string;
	availableModels: { modelId: string; name: string; description?: string | null }[];
}

interface SetupResponse {
	modes?: SessionModeState | null;
	models?: ModelState | null;
	configOptions?: SessionConfigOption[] | null;
}

function selectOption(
	options: readonly SessionConfigOption[],
	category: string,
): (SessionConfigOption & { type: "select" }) | undefined {
	return options.find(
		(option): option is SessionConfigOption & { type: "select" } =>
			option.type === "select" && option.category === category,
	);
}

/** Models and thinking levels from a session setup response or a config option update. */
export function applySetup(meta: AgentMeta, agent: string, setup: SetupResponse): AgentMeta {
	const next = { ...meta };
	const options = setup.configOptions ?? [];
	const modelOption = selectOption(options, "model");
	if (modelOption !== undefined) {
		next.models = modelOption.options.map(option => ({
			id: option.value,
			name: option.name,
			provider: agent,
			contextWindow: null,
		}));
		next.currentModel = modelOption.currentValue;
		next.modelVia = { kind: "config", configId: modelOption.id };
	} else if (setup.models) {
		next.models = setup.models.availableModels.map(model => ({
			id: model.modelId,
			name: model.name,
			provider: agent,
			contextWindow: null,
		}));
		next.currentModel = setup.models.currentModelId;
		next.modelVia = { kind: "set_model" };
	}
	const thinking = selectOption(options, "thought_level");
	if (thinking !== undefined) {
		next.thinkingLevels = thinking.options.map(option => option.value);
		next.thinkingLevel = thinking.currentValue;
		next.thinkingConfigId = thinking.id;
	}
	return next;
}

/** `meta` after one notification that is not about the conversation. */
export function applyMetaUpdate(meta: AgentMeta, agent: string, update: SessionUpdate): AgentMeta {
	switch (update.sessionUpdate) {
		case "available_commands_update":
			return { ...meta, commands: collabCommands(update.availableCommands) };
		case "config_option_update":
			return applySetup(meta, agent, { configOptions: update.configOptions });
		case "session_info_update":
			return update.title === undefined ? meta : { ...meta, title: update.title?.trim() || null };
		case "usage_update": {
			const cost =
				update.cost && update.cost.currency.toUpperCase() === "USD" && Number.isFinite(update.cost.amount)
					? update.cost.amount
					: null;
			return { ...meta, contextUsed: update.used, contextSize: update.size, costUsd: cost ?? meta.costUsd };
		}
		default:
			return meta;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Prompts
// ═══════════════════════════════════════════════════════════════════════════

/** The ACP prompt blocks for a guest's prompt: its text, then its images when the agent takes them. */
export function promptBlocks(
	text: string,
	images: readonly ImageContent[] | undefined,
	acceptsImages: boolean,
): ContentBlock[] {
	const blocks: ContentBlock[] = [{ type: "text", text }];
	if (acceptsImages)
		for (const image of images ?? []) blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
	return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════
// Restoring context into a fresh agent session
// ═══════════════════════════════════════════════════════════════════════════

const DIGEST_ITEM_CHARS = 2_000;

function clipText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function digestLines(entry: SessionEntry): string[] {
	if (entry.type === "custom_message") {
		const body =
			typeof entry.content === "string"
				? entry.content
				: entry.content.map(block => (block.type === "text" ? block.text : "[image]")).join("\n");
		return [`User: ${clipText(body, DIGEST_ITEM_CHARS)}`];
	}
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (message.role === "user") {
		const body =
			typeof message.content === "string"
				? message.content
				: message.content.map(block => (block.type === "text" ? block.text : "[image]")).join("\n");
		return [`User: ${clipText(body, DIGEST_ITEM_CHARS)}`];
	}
	if (message.role === "assistant") {
		return message.content.flatMap(block => {
			if (block.type === "text" && block.text.trim() !== "")
				return [`Assistant: ${clipText(block.text, DIGEST_ITEM_CHARS)}`];
			if (block.type === "toolCall") return [`(tool call: ${block.name})`];
			return [];
		});
	}
	return [];
}

/**
 * The conversation so far as text, for an agent session that has to start over (a rewind, or a session the
 * agent cannot reload): the newest part that fits `maxChars`, oldest first. Empty when there is nothing to say.
 */
export function historyDigest(entries: readonly SessionEntry[], maxChars = 24_000): string {
	const kept: string[] = [];
	let size = 0;
	for (const entry of entries.toReversed()) {
		const lines = digestLines(entry);
		const text = lines.join("\n");
		if (text === "") continue;
		if (size + text.length > maxChars && kept.length > 0) break;
		kept.unshift(text);
		size += text.length;
	}
	if (kept.length === 0) return "";
	return [
		"This conversation was restored without your own memory of it. What was said so far (oldest first, the start may be cut):",
		"",
		kept.join("\n\n"),
		"",
		"Carry on from there; the user's next message follows.",
	].join("\n");
}
