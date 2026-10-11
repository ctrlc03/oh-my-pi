/**
 * Ranked view of what fills the model's context window.
 *
 * Pure layer: given the live branch entries (already cut at the compaction
 * boundary), the system prompt parts and the tool roster, it produces one list
 * of {@link ContextItem}s sorted by estimated token cost. Tool results are
 * listed individually (`bash bun test`), reads and `@file` mentions are
 * aggregated per file, images are grouped per carrying entry, and the system
 * prompt parts and tool schemas appear as non-prunable rows.
 *
 * Pruning lives in `SessionMaintenance.pruneContextItems`; this module only
 * names the entries a prune would rewrite ({@link ContextPruneTarget}).
 */

import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { estimateImageContentTokens } from "@oh-my-pi/pi-agent-core/image-tokens";
import { collectToolCallsById } from "@oh-my-pi/pi-agent-core/compaction/tool-protection";
import type { ImageContent, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import * as path from "node:path";
import type { SessionEntry } from "./session-entries";

export type ContextItemKind = "toolResult" | "file" | "attachment" | "systemPrompt" | "toolSchema";

/** One entry-level rewrite a prune performs. */
export type ContextPruneTarget =
	| { kind: "toolResult"; entryId: string }
	| { kind: "fileMention"; entryId: string; path: string }
	| { kind: "images"; entryId: string; tokens: number };

export interface ContextItem {
	/** Stable across calls while the underlying entries are unchanged (`tr:<entryId>`, `file:<path>`, …). */
	id: string;
	kind: ContextItemKind;
	/** Human label: `read src/x.ts`, `src/x.ts (3 reads)`, `System prompt`, `tool schema: bash`. */
	label: string;
	/** Estimated tokens the item occupies. */
	tokens: number;
	/** `tokens` as a fraction (0–1) of the session's estimated total. */
	share: number;
	/** Entries merged into this row (reads of one file, images in one message, …). */
	count: number;
	/** Entry rewrites a prune of this row performs; empty when the item cannot be pruned. */
	targets: ContextPruneTarget[];
}

/** Outcome of `SessionMaintenance.pruneContextItems`. */
export interface ContextPruneResult {
	/** Session entries rewritten (tool results, `@file` mentions, image-carrying messages). */
	entriesRewritten: number;
	/** Estimated context tokens reclaimed. */
	tokensFreed: number;
	/** Session artifact holding the elided originals, when persisted. */
	artifactId?: string;
}

/** Placeholder prefix shake/prune leaves behind (`[shaken ~N tokens — recover: artifact://…]`). */
export const PRUNED_PREFIX = "[shaken ";

const LABEL_MAX = 72;

/** Argument keys naming what a tool call works on, in preference order. */
const TOOL_TARGET_KEYS = ["command", "pattern", "path", "file_path", "query", "url", "code"] as const;

/** Trailing `:50-80` / `:raw` / `:conflicts` selectors of a `read` path. */
const READ_SELECTOR_SUFFIX = /(?::(?:raw|conflicts|[-+,\d]+))+$/;

export interface RankContextItemsInput {
	/** Branch entries that reach the provider (summarized-away entries already dropped). */
	entries: readonly SessionEntry[];
	tokenizer: Tokenizer;
	systemPrompt: readonly string[];
	tools: readonly Pick<Tool, "name" | "description" | "parameters" | "examples">[];
	/** Tool-result entry ids the elision pass is allowed to rewrite (unprotected, not yet pruned). */
	prunableToolResultIds: ReadonlySet<string>;
	cwd: string;
	/** Denominator for {@link ContextItem.share}; falls back to the sum of listed items. */
	totalTokens?: number;
}

function firstLine(source: string): string {
	const line = source.split("\n").find(part => part.trim().length > 0) ?? "";
	return line.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
	return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/** `name target` label of a tool call (`bash bun test`, `grep TODO`). */
function toolCallLabel(name: string, args: Record<string, unknown> | undefined): string {
	for (const key of TOOL_TARGET_KEYS) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim()) return clip(`${name} ${firstLine(value)}`);
	}
	return name;
}

/** Display path and aggregation key of a `read` path argument. */
function readFileKey(rawPath: string, cwd: string): { key: string; display: string } {
	const stripped = rawPath.replace(READ_SELECTOR_SUFFIX, "");
	if (stripped.includes("://")) return { key: stripped, display: stripped };
	const absolute = path.resolve(cwd, stripped);
	const relative = path.relative(cwd, absolute);
	const display =
		relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : absolute;
	return { key: absolute, display };
}

function toolResultTextTokens(message: ToolResultMessage, tokenizer: Tokenizer): number {
	const fragments: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text.length > 0) fragments.push(block.text);
	}
	return fragments.length === 0 ? 0 : tokenizer.countTokens(fragments);
}

function imageTokens(images: readonly ImageContent[]): number {
	let total = 0;
	for (const image of images) total += estimateImageContentTokens(image);
	return total;
}

function contentImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is ImageContent => block?.type === "image");
}

interface FileAccumulator {
	display: string;
	tokens: number;
	count: number;
	targets: ContextPruneTarget[];
}

interface ImageAccumulator {
	label: string;
	tokens: number;
	count: number;
}

/** Rank everything that fills the context by estimated tokens, largest first. */
export function rankContextItems(input: RankContextItemsInput): ContextItem[] {
	const { entries, tokenizer, cwd } = input;
	const items: Array<Omit<ContextItem, "share">> = [];
	const files = new Map<string, FileAccumulator>();
	const toolCalls = collectToolCallsById(entries as SessionEntry[]);

	const addFile = (key: string, display: string, tokens: number, target: ContextPruneTarget | undefined): void => {
		let acc = files.get(key);
		if (!acc) {
			acc = { display, tokens: 0, count: 0, targets: [] };
			files.set(key, acc);
		}
		acc.tokens += tokens;
		acc.count++;
		if (target) acc.targets.push(target);
	};

	for (const entry of entries) {
		const images: ImageAccumulator[] = [];
		const addImages = (label: string, found: readonly ImageContent[]): void => {
			if (found.length === 0) return;
			images.push({ label, tokens: imageTokens(found), count: found.length });
		};

		if (entry.type === "custom_message") {
			addImages(`attachment (${entry.customType})`, contentImages(entry.content));
		} else if (entry.type === "message") {
			const message = entry.message;
			switch (message.role) {
				case "toolResult": {
					const result: ToolResultMessage = message;
					const call = toolCalls.get(result.toolCallId);
					const tokens = toolResultTextTokens(result, tokenizer);
					const prunable = input.prunableToolResultIds.has(entry.id);
					const target: ContextPruneTarget | undefined = prunable
						? { kind: "toolResult", entryId: entry.id }
						: undefined;
					const readPath = result.toolName === "read" ? call?.arguments.path : undefined;
					if (typeof readPath === "string") {
						const { key, display } = readFileKey(readPath, cwd);
						addFile(key, display, tokens, target);
					} else if (tokens > 0) {
						items.push({
							id: `tr:${entry.id}`,
							kind: "toolResult",
							label: toolCallLabel(result.toolName, call?.arguments),
							tokens,
							count: 1,
							targets: target ? [target] : [],
						});
					}
					addImages(`${toolCallLabel(result.toolName, call?.arguments)} (image)`, contentImages(result.content));
					break;
				}
				case "user":
				case "developer":
					addImages(`attachment (${message.role} message)`, contentImages(message.content));
					break;
				case "bashExecution":
					addImages(`attachment (! ${clip(firstLine(message.command))})`, message.images ?? []);
					break;
				case "custom":
				case "hookMessage":
					addImages(`attachment (${message.customType})`, contentImages(message.content));
					break;
				case "fileMention":
					for (const file of message.files) {
						const { key, display } = readFileKey(file.path, cwd);
						const pruned = file.content.startsWith(PRUNED_PREFIX);
						const tokens = file.content.length > 0 ? tokenizer.countTokens(file.content) : 0;
						if (tokens > 0) {
							addFile(
								key,
								display,
								tokens,
								pruned ? undefined : { kind: "fileMention", entryId: entry.id, path: file.path },
							);
						}
						if (file.image) addImages(`${display} (image)`, [file.image]);
					}
					break;
				default:
					break;
			}
		}

		if (images.length > 0) {
			const tokens = images.reduce((sum, image) => sum + image.tokens, 0);
			items.push({
				id: `img:${entry.id}`,
				kind: "attachment",
				label: images.length === 1 ? images[0]!.label : `${images[0]!.label} +${images.length - 1} more`,
				tokens,
				count: images.reduce((sum, image) => sum + image.count, 0),
				targets: [{ kind: "images", entryId: entry.id, tokens }],
			});
		}
	}

	for (const [key, acc] of files) {
		items.push({
			id: `file:${key}`,
			kind: "file",
			label: acc.count > 1 ? `${acc.display} (${acc.count} reads)` : `read ${acc.display}`,
			tokens: acc.tokens,
			count: acc.count,
			targets: acc.targets,
		});
	}

	input.systemPrompt.forEach((part, index) => {
		const text = part ?? "";
		const tokens = text.length > 0 ? tokenizer.countTokens(text) : 0;
		if (tokens === 0) return;
		items.push({
			id: `sys:${index}`,
			kind: "systemPrompt",
			label: index === 0 ? "System prompt" : clip(`System context: ${firstLine(text) || `part ${index + 1}`}`),
			tokens,
			count: 1,
			targets: [],
		});
	});

	for (const tool of input.tools) {
		const tokens = estimateToolSchemaTokens([tool], tokenizer);
		if (tokens === 0) continue;
		items.push({
			id: `tool:${tool.name}`,
			kind: "toolSchema",
			label: `tool schema: ${tool.name}`,
			tokens,
			count: 1,
			targets: [],
		});
	}

	const total = input.totalTokens ?? items.reduce((sum, item) => sum + item.tokens, 0);
	return items
		.map(item => ({ ...item, share: total > 0 ? Math.min(1, item.tokens / total) : 0 }))
		.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
}

/** Resolve user-supplied ids/ranks (`3`, `tr:abc`) against a ranked list; unknown selectors are returned in `missing`. */
export function selectContextItems(
	items: readonly ContextItem[],
	selectors: readonly string[],
): { selected: ContextItem[]; missing: string[] } {
	const selected: ContextItem[] = [];
	const missing: string[] = [];
	for (const selector of selectors) {
		const rank = /^\d+$/.test(selector) ? Number(selector) : undefined;
		const item = rank !== undefined ? items[rank - 1] : items.find(candidate => candidate.id === selector);
		if (!item) missing.push(selector);
		else if (!selected.includes(item)) selected.push(item);
	}
	return { selected, missing };
}
