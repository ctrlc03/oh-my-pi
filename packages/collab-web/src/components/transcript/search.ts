/**
 * Find-in-session over what a reader scans for: prompts and reply text. Tool
 * arguments and output are left out, so a search for a word in the conversation
 * does not stop on every `grep` that touched it.
 */

import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";

function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) if (block.type === "text") text += `${block.text}\n`;
	return text;
}

function entryText(entry: SessionEntry): string {
	if (entry.type === "custom_message")
		return entry.display || entry.customType === "collab-prompt" ? contentText(entry.content) : "";
	if (entry.type !== "message") return "";
	const message = entry.message;
	if (message.role === "user") return contentText(message.content);
	if (message.role !== "assistant") return "";
	let text = "";
	for (const block of message.content) if (block.type === "text") text += `${block.text}\n`;
	return text;
}

/** Ids of entries whose prompt or reply text contains `query` (case-insensitive), oldest first. */
export function findEntryMatches(entries: readonly SessionEntry[], query: string): string[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const ids: string[] = [];
	for (const entry of entries) if (entryText(entry).toLowerCase().includes(needle)) ids.push(entry.id);
	return ids;
}
