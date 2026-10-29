/**
 * The transcript as blocks: every prompt, reply and tool run is one unit a reader can select, copy
 * or quote. This module holds the pure parts: the block model derived from the replicated entries,
 * the plain-text and Markdown each block copies as, and the selection arithmetic. The transcript
 * renders the same blocks, so what is selected is what is copied.
 *
 * Copied text is plain: ANSI escapes are stripped, and output the host or the tool cut short
 * says so in the copy instead of ending silently.
 */

import type { SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { executeXdevDispatch } from "../tool-render/ToolView";
import type { ToolResultLike } from "../tool-render/types";
import {
	argsDigest,
	detailsRecord,
	isRecord,
	normalizeWs,
	num,
	resultImagesOf,
	resultTextOf,
	stripAnsi,
} from "../tool-render/util";
import { authorOf, contentMarkdown } from "./export";
import { isPrompt } from "./trim";

export interface PromptBlock {
	kind: "prompt";
	id: string;
	entryId: string;
	/** Gutter name: the host user, or the guest who sent it. */
	author: string;
	text: string;
	/** The prompt can be edited and resent. */
	editable: boolean;
}

export interface ReplyBlock {
	kind: "reply";
	id: string;
	entryId: string | null;
	text: string;
}

/** One tool call and its result. `partial` is the live output of a call that has no result yet. */
export interface ToolBlock {
	kind: "tool";
	id: string;
	entryId: string | null;
	name: string;
	/** Raw call arguments, `i` intent included. */
	args: unknown;
	result: ToolResultLike | undefined;
	running: boolean;
	partial?: string;
}

/** A folded run of tool calls in the chat view: one block that copies every call in it. */
export interface RunBlock {
	kind: "run";
	id: string;
	entryId: string | null;
	tools: ToolBlock[];
}

export type Block = PromptBlock | ReplyBlock | ToolBlock | RunBlock;

/** What the chat view hands over per item (`ChatItem` satisfies it); the model stays free of UI modules. */
export type ChatSource =
	| { kind: "entry"; entry: SessionEntry }
	| { kind: "text"; key: string; entryId: string | null; text: string }
	| {
			kind: "tools";
			key: string;
			entryId: string | null;
			calls: readonly { id: string; name: string; args: unknown }[];
	  }
	| { kind: "stop" };

/** The results of `entries`' tool calls by call id. */
export function toolResults(entries: readonly SessionEntry[]): Map<string, ToolResultMessage> {
	const map = new Map<string, ToolResultMessage>();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult")
			map.set(entry.message.toolCallId, entry.message);
	}
	return map;
}

/** Id of the reply block for the text at `index` of an assistant entry (the chat view keys its text items the same way). */
export function replyId(entryId: string, index: number): string {
	return `${entryId}:${index}`;
}

function promptOf(entry: SessionEntry): PromptBlock | null {
	if (!isPrompt(entry)) return null;
	const message = entry.type === "message" && entry.message.role === "user" ? entry.message : null;
	const content = entry.type === "custom_message" ? entry.content : (message?.content ?? "");
	return {
		kind: "prompt",
		id: entry.id,
		entryId: entry.id,
		author: authorOf(entry),
		text: contentMarkdown(content),
		// Host-injected prompts (`synthetic`) cannot be rewound to.
		editable: message?.synthetic !== true,
	};
}

/** The call as `ToolView` renders it: a `write xd://<tool>` dispatch is the device tool it ran. */
export function effectiveCall(
	name: string,
	args: unknown,
	result: ToolResultLike | undefined,
): { name: string; args: unknown; result: ToolResultLike | undefined } {
	const xdev = executeXdevDispatch(name, result);
	if (xdev === null || result === undefined) return { name, args, result };
	return {
		name: xdev.tool,
		args: xdev.args,
		result: { content: result.content, details: xdev.inner, isError: result.isError },
	};
}

function toolOf(
	call: { id: string; name: string; args: unknown },
	entryId: string | null,
	results: ReadonlyMap<string, ToolResultMessage>,
): ToolBlock {
	const effective = effectiveCall(call.name, call.args, results.get(call.id));
	return { kind: "tool", id: call.id, entryId, ...effective, running: false };
}

/** The blocks of the full view, in transcript order. */
export function buildBlocks(
	entries: readonly SessionEntry[],
	results: ReadonlyMap<string, ToolResultMessage>,
): Block[] {
	const blocks: Block[] = [];
	for (const entry of entries) {
		const prompt = promptOf(entry);
		if (prompt !== null) {
			blocks.push(prompt);
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		entry.message.content.forEach((block, i) => {
			if (block.type === "text") {
				if (block.text.trim())
					blocks.push({ kind: "reply", id: replyId(entry.id, i), entryId: entry.id, text: block.text.trim() });
			} else if (block.type === "toolCall") {
				blocks.push(toolOf({ id: block.id, name: block.name, args: block.arguments }, entry.id, results));
			}
		});
	}
	return blocks;
}

/** The blocks of the chat view: prompts, replies and one block per folded tool run. Items not yet in the session have no block. */
export function buildChatBlocks(
	items: readonly ChatSource[],
	results: ReadonlyMap<string, ToolResultMessage>,
): Block[] {
	const blocks: Block[] = [];
	for (const item of items) {
		switch (item.kind) {
			case "entry": {
				const prompt = promptOf(item.entry);
				if (prompt !== null) blocks.push(prompt);
				break;
			}
			case "text":
				if (item.entryId !== null && item.text.trim()) {
					blocks.push({ kind: "reply", id: item.key, entryId: item.entryId, text: item.text.trim() });
				}
				break;
			case "tools":
				if (item.entryId !== null) {
					blocks.push({
						kind: "run",
						id: item.key,
						entryId: item.entryId,
						tools: item.calls.map(call => toolOf(call, item.entryId, results)),
					});
				}
				break;
			case "stop":
				break;
		}
	}
	return blocks;
}

// ---- tool facts ----

export type ToolStatus = "running" | "ok" | "err" | "pending";

export interface ToolMeta {
	/** The shell command of a `bash` call; null for every other tool. */
	command: string | null;
	exitCode: number | null;
	durationMs: number | null;
	/** The result is an error or the command exited non-zero. */
	failed: boolean;
}

/** Facts for a tool block's header: the command, exit code and wall time when the tool reports them. */
export function toolMeta(name: string, args: unknown, result: ToolResultLike | undefined): ToolMeta {
	const details = detailsRecord(result);
	const exitCode = num(details?.exitCode);
	return {
		command: name === "bash" && isRecord(args) && typeof args.command === "string" ? args.command : null,
		exitCode,
		durationMs: num(details?.wallTimeMs),
		failed: result?.isError === true || (exitCode !== null && exitCode !== 0),
	};
}

export function toolStatus(block: ToolBlock): ToolStatus {
	if (block.result === undefined) return block.running ? "running" : "pending";
	return toolMeta(block.name, block.args, block.result).failed ? "err" : "ok";
}

/** Argument keys that say what a call acts on, most telling first. */
const MAIN_ARGUMENTS = [
	"path",
	"paths",
	"pattern",
	"query",
	"url",
	"file",
	"command",
	"task",
	"description",
	"id",
	"op",
];

function withoutIntent(args: unknown): Record<string, unknown> {
	if (!isRecord(args)) return {};
	const rest: Record<string, unknown> = {};
	for (const key in args) if (key !== INTENT_FIELD) rest[key] = args[key];
	return rest;
}

/** The one-line call a non-shell tool copies as: its name and what it acts on. */
function mainArgument(args: Record<string, unknown>): string {
	for (const key of MAIN_ARGUMENTS) {
		if (!Object.hasOwn(args, key)) continue;
		const value = args[key];
		if (typeof value === "string" && value.trim()) return normalizeWs(value);
		if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
			return value.join(", ");
	}
	return argsDigest(args);
}

/** What "Copy command" copies: the shell command, or for other tools the call as `name argument`. */
export function toolCommand(block: ToolBlock): string {
	const { command } = toolMeta(block.name, block.args, block.result);
	if (command !== null) return command;
	const main = mainArgument(withoutIntent(block.args));
	return main ? `${block.name} ${main}` : block.name;
}

const COLLAB_ELISION = /chars elided for collab session/;

/** Statements about output that is missing or incomplete, so a copy never looks whole when it is not. */
function outputNotes(block: ToolBlock, text: string): string[] {
	const notes: string[] = [];
	const { exitCode } = toolMeta(block.name, block.args, block.result);
	if (block.result === undefined) {
		notes.push(block.running ? "output so far; the call is still running" : "no result recorded for this call");
	}
	const meta = detailsRecord(block.result)?.meta;
	const truncation = isRecord(meta) && isRecord(meta.truncation) ? meta.truncation : null;
	if (truncation !== null) {
		const kept = num(truncation.outputLines);
		const total = num(truncation.totalLines);
		notes.push(
			kept !== null && total !== null
				? `output truncated by the tool: ${kept} of ${total} lines kept`
				: "output truncated by the tool",
		);
	}
	if (COLLAB_ELISION.test(text)) notes.push("output elided for the collab session");
	const images = resultImagesOf(block.result).length;
	if (images > 0) notes.push(`${images} image${images === 1 ? "" : "s"} in the result not copied`);
	if (exitCode !== null && exitCode !== 0) notes.push(`exit code ${exitCode}`);
	return notes;
}

function plainOutput(block: ToolBlock): string {
	const raw = block.result === undefined ? (block.partial ?? "") : resultTextOf(block.result);
	return stripAnsi(raw).replace(/\s+$/, "");
}

/** The last `max` lines of `text`, and how many earlier ones were left out. */
function lastLines(text: string, max: number): { text: string; omitted: number } {
	const lines = text.split("\n");
	if (lines.length <= max) return { text, omitted: 0 };
	return { text: lines.slice(-max).join("\n"), omitted: lines.length - max };
}

/** What "Copy output" copies: the output with ANSI stripped, then a bracketed line per shortfall. Empty when there is nothing. */
export function toolOutput(block: ToolBlock, maxLines?: number): string {
	const text = plainOutput(block);
	const notes = outputNotes(block, text);
	const clipped = maxLines === undefined ? { text, omitted: 0 } : lastLines(text, maxLines);
	if (clipped.omitted > 0) notes.unshift(`${clipped.omitted} earlier lines not included`);
	return [clipped.text, ...notes.map(note => `[${note}]`)].filter(Boolean).join("\n");
}

/** A code fence that `text` cannot close early: longer than any backtick run inside it. */
function fence(text: string, lang = ""): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const ticks = "`".repeat(Math.max(3, longest + 1));
	return `${ticks}${lang}\n${text}\n${ticks}`;
}

export interface MarkdownOptions {
	/** Keep only the last `maxOutputLines` lines of each tool output, saying how many were left out. */
	maxOutputLines?: number;
}

/** A tool call as Markdown: the command in a `sh` fence (a plain one for other tools), then the output in a fence. */
export function toolMarkdown(block: ToolBlock, options: MarkdownOptions = {}): string {
	const isShell = toolMeta(block.name, block.args, block.result).command !== null;
	const parts = [fence(toolCommand(block), isShell ? "sh" : "")];
	const output = toolOutput(block, options.maxOutputLines);
	if (output) parts.push(fence(output));
	return parts.join("\n\n");
}

// ---- serialising blocks ----

/** Every tool call a block stands for: itself, or the calls of a folded run. */
function toolsOf(block: Block): ToolBlock[] {
	return block.kind === "tool" ? [block] : block.kind === "run" ? block.tools : [];
}

/** "Copy command": the commands of a tool or run block, one per line; empty for prompts and replies. */
export function blockCommand(block: Block): string {
	return toolsOf(block).map(toolCommand).join("\n");
}

/** "Copy output": the outputs of a tool or run block, a blank line apart. */
export function blockOutput(block: Block): string {
	return toolsOf(block)
		.map(tool => toolOutput(tool))
		.filter(Boolean)
		.join("\n\n");
}

/** Whether a tool or run block has output (or a statement about its missing output) to copy; cheap enough to ask on every render. */
export function hasOutput(block: Block): boolean {
	return toolsOf(block).some(tool => {
		if (tool.result === undefined) return true;
		const text = tool.result.content.some(
			part => "text" in part && typeof part.text === "string" && /\S/.test(part.text),
		);
		return text || outputNotes(tool, "").length > 0;
	});
}

/**
 * One block as Markdown. A prompt names its author when `labeled` (several blocks together);
 * alone it is just the text.
 */
export function blockMarkdown(block: Block, labeled = false, options: MarkdownOptions = {}): string {
	switch (block.kind) {
		case "prompt":
			return labeled ? `**${block.author}:**\n\n${block.text}` : block.text;
		case "reply":
			return block.text;
		case "tool":
			return toolMarkdown(block, options);
		case "run":
			return block.tools.map(tool => toolMarkdown(tool, options)).join("\n\n");
	}
}

/** The blocks, in the order given, as one Markdown document: what ⌘C and *Copy* put on the clipboard. */
export function blocksMarkdown(blocks: readonly Block[], options: MarkdownOptions = {}): string {
	const labeled = blocks.length > 1;
	return blocks.map(block => blockMarkdown(block, labeled, options)).join("\n\n");
}

/** Whether *Copy* has text for the block: *Read in full* is offered exactly then. */
export function blockHasText(block: Block): boolean {
	return /\S/.test(blocksMarkdown([block]));
}

/** Lines of one tool output a quoted excerpt keeps: enough for the failure at the end of a log. */
export const EXCERPT_OUTPUT_LINES = 40;

/** The blocks quoted for the message box: Markdown with long outputs cut to their last lines (and saying so), every line quoted. */
export function blocksQuote(blocks: readonly Block[]): string {
	return blocksMarkdown(blocks, { maxOutputLines: EXCERPT_OUTPUT_LINES })
		.split("\n")
		.map(line => (line ? `> ${line}` : ">"))
		.join("\n");
}

/** A short line naming a block, for share sheets and accessible labels. */
export function blockTitle(block: Block): string {
	switch (block.kind) {
		case "prompt":
		case "reply":
			return normalizeWs(block.text).slice(0, 80) || block.kind;
		case "tool":
			return toolCommand(block).split("\n", 1)[0]!.slice(0, 80);
		case "run":
			return `${block.tools.length} tool call${block.tools.length === 1 ? "" : "s"}`;
	}
}

// ---- selection ----

/** Selected block ids, plus where a range started (`anchor`) and where the keyboard cursor is (`focus`). */
export interface BlockSelection {
	ids: ReadonlySet<string>;
	anchor: string | null;
	focus: string | null;
}

export const NO_SELECTION: BlockSelection = { ids: new Set(), anchor: null, focus: null };

export function selectOnly(id: string): BlockSelection {
	return { ids: new Set([id]), anchor: id, focus: id };
}

/** Add `id`, or drop it when selected; the range anchor moves to it. */
export function toggleBlock(selection: BlockSelection, id: string): BlockSelection {
	const ids = new Set(selection.ids);
	if (!ids.delete(id)) ids.add(id);
	return { ids, anchor: id, focus: id };
}

/** Select every block from the anchor (or `id` itself without one) through `id`. */
export function extendTo(selection: BlockSelection, order: readonly Block[], id: string): BlockSelection {
	const to = order.findIndex(block => block.id === id);
	if (to < 0) return selection;
	const found = selection.anchor === null ? -1 : order.findIndex(block => block.id === selection.anchor);
	const from = found < 0 ? to : found;
	const ids = new Set<string>();
	for (let i = Math.min(from, to); i <= Math.max(from, to); i++) ids.add(order[i]!.id);
	return { ids, anchor: order[from]!.id, focus: id };
}

/**
 * The selection after ⌘↑ / ⌘↓ (`delta` -1 / +1). The cursor is the focused block; without one, up starts
 * at the last block and down at `fallback` (the first block in view) or the first. The ends clamp.
 * `extend` grows a range from the anchor instead of moving a single selection.
 */
export function moveSelection(
	selection: BlockSelection,
	order: readonly Block[],
	delta: -1 | 1,
	extend: boolean,
	fallback?: string,
): BlockSelection {
	if (order.length === 0) return selection;
	const at = selection.focus === null ? -1 : order.findIndex(block => block.id === selection.focus);
	if (at < 0) {
		const start =
			delta < 0
				? order.length - 1
				: Math.max(
						0,
						order.findIndex(block => block.id === fallback),
					);
		return selectOnly(order[start]!.id);
	}
	const next = order[Math.min(order.length - 1, Math.max(0, at + delta))]!.id;
	return extend ? extendTo(selection, order, next) : selectOnly(next);
}

/** The selection without blocks that left the transcript; the same object when none did. */
export function pruneSelection(selection: BlockSelection, order: readonly Block[]): BlockSelection {
	if (selection.ids.size === 0) return selection;
	const present = new Set(order.map(block => block.id));
	const ids = new Set([...selection.ids].filter(id => present.has(id)));
	if (ids.size === selection.ids.size && (selection.focus === null || present.has(selection.focus))) return selection;
	if (ids.size === 0) return NO_SELECTION;
	return {
		ids,
		anchor: selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : null,
		focus: selection.focus !== null && present.has(selection.focus) ? selection.focus : null,
	};
}

/** The selected blocks in transcript order, however they were picked. */
export function selectedBlocks(selection: BlockSelection, order: readonly Block[]): Block[] {
	return order.filter(block => selection.ids.has(block.id));
}
