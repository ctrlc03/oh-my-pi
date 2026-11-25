/**
 * Markdown for sharing: a turn, a whole session, or just a reply's prose. Reads
 * the replicated entries the way the transcript does, so what a reader scrolled
 * through is what they send on. Thinking and tool output stay out: the export is
 * the conversation plus one line per tool call.
 */

import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";
import { argsDigest, normalizeWs } from "../tool-render/util";
import { replyWriteText, toolResultReplies } from "./reply-write";
import { isPrompt } from "./trim";

/** A turn's slice of the entries: the prompt at `from` through the entry before `to`. */
export interface TurnRange {
	from: number;
	to: number;
}

/** Turns in order: each prompt and everything up to the next one. Entries before the first prompt belong to none. */
export function turnRanges(entries: readonly SessionEntry[]): TurnRange[] {
	const ranges: TurnRange[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (!isPrompt(entries[i]!)) continue;
		const last = ranges.at(-1);
		if (last !== undefined) last.to = i;
		ranges.push({ from: i, to: entries.length });
	}
	return ranges;
}

export function contentMarkdown(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content.trim();
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			const text = block.text.trim();
			if (text) parts.push(text);
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n\n");
}

/** Gutter names the transcript shows: the host user's prompts are "host", a guest's carry their name. */
export function authorOf(entry: SessionEntry): string {
	if (entry.type !== "custom_message") return "host";
	const from = (entry.details as { from?: unknown } | null | undefined)?.from;
	return typeof from === "string" && from ? from : "guest";
}

function quote(text: string): string {
	return text
		.split("\n")
		.map(line => (line ? `> ${line}` : ">"))
		.join("\n");
}

/** One block of the output; consecutive tool lines join into a single list. */
interface Block {
	text: string;
	tool: boolean;
}

function blocksOf(entries: readonly SessionEntry[]): Block[] {
	const blocks: Block[] = [];
	const add = (text: string, tool = false): void => {
		if (text) blocks.push({ text, tool });
	};
	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (message.role === "user") {
					add(`**${authorOf(entry)}:**`);
					add(contentMarkdown(message.content));
				} else if (message.role === "assistant") {
					for (const block of message.content) {
						if (block.type === "text") {
							add(block.text.trim());
						} else if (block.type === "toolCall") {
							const reply = replyWriteText(block.name, block.arguments);
							if (reply !== undefined) {
								add(reply.trim());
								continue;
							}
							const summary = normalizeWs(block.intent ?? "") || argsDigest(block.arguments);
							add(summary ? `- ⚙ ${block.name} · ${summary}` : `- ⚙ ${block.name}`, true);
						}
					}
				} else if (message.role === "toolResult") {
					for (const reply of toolResultReplies(message.details)) add(reply.trim());
				}
				break;
			}
			case "custom_message":
				if (entry.customType !== "collab-prompt") break;
				add(`**${authorOf(entry)}:**`);
				add(contentMarkdown(entry.content));
				break;
			case "compaction":
				add(quote(`Context compacted\n\n${(entry.shortSummary ?? entry.summary).trim()}`));
				break;
			case "branch_summary":
				add(quote(`Branch summary\n\n${entry.summary.trim()}`));
				break;
			case "reset_boundary":
				add(quote("Context cleared"));
				break;
			default:
				break;
		}
	}
	return blocks;
}

/** The entries as Markdown. Pass one turn's slice, or any run of entries. */
export function turnMarkdown(entries: readonly SessionEntry[]): string {
	let out = "";
	let previous: Block | null = null;
	for (const block of blocksOf(entries)) {
		if (previous !== null) out += previous.tool && block.tool ? "\n" : "\n\n";
		out += block.text;
		previous = block;
	}
	return out;
}

/**
 * The assistant's prose across `entries` — what a reader means by "the reply" — without tool calls or thinking.
 * Mid-turn replies (`out://`) are prose too: often the only answer a turn gives.
 */
export function replyText(entries: readonly SessionEntry[]): string {
	const parts: string[] = [];
	const push = (text: string | undefined): void => {
		const trimmed = text?.trim();
		if (trimmed) parts.push(trimmed);
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") {
			for (const reply of toolResultReplies(entry.message.details)) push(reply);
			continue;
		}
		if (entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "text") push(block.text);
			else if (block.type === "toolCall") push(replyWriteText(block.name, block.arguments));
		}
	}
	return parts.join("\n\n");
}

/**
 * The whole session: a title, the day it started, then each turn set off by a rule. `omitted` is how many
 * entries before `entries[0]` this guest never loaded (a long session joins from its newest turns): the
 * export then says so instead of passing a partial transcript off as the whole.
 */
export function sessionMarkdown(
	entries: readonly SessionEntry[],
	{ title, omitted = 0 }: { title: string; omitted?: number },
): string {
	const ranges = turnRanges(entries);
	const segments = [{ from: 0, to: ranges[0]?.from ?? entries.length }, ...ranges];
	const turns = segments.map(range => turnMarkdown(entries.slice(range.from, range.to))).filter(Boolean);
	const started = entries[0] === undefined || omitted > 0 ? Number.NaN : Date.parse(entries[0].timestamp);
	const head = [`# ${normalizeWs(title) || "Session"}`];
	if (!Number.isNaN(started)) head.push(`*${new Date(started).toISOString().slice(0, 10)}*`);
	if (omitted > 0) {
		head.push(
			`*Partial export: the first ${omitted.toLocaleString("en-US")} entries of this session were not loaded on this device. Use "Load earlier" in the transcript to load them before exporting.*`,
		);
	}
	return `${head.join("\n\n")}\n\n${turns.join("\n\n---\n\n")}\n`;
}

/** `my-session-name.md`: lowercase ASCII words from the title, so every file system takes it. */
export function exportFilename(title: string): string {
	const slug = title
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return `${slug || "session"}.md`;
}
