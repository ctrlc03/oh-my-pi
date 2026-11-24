/**
 * Find-in-session over what a reader scans for: prompts and reply text. Tool
 * arguments and output are left out, so a search for a word in the conversation
 * does not stop on every `grep` that touched it.
 */

import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";
import { ADVISOR_TYPE, advisorNotes } from "../../lib/advisor";
import { replyWriteText, toolResultReplies } from "../../lib/reply-write";

function contentText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) if (block.type === "text") text += `${block.text}\n`;
	return text;
}

/** The prompt or reply text of `entry` (empty for anything else); an advisor's message is its notes, as shown. */
export function entryText(entry: SessionEntry): string {
	if (entry.type === "custom_message") {
		if (!entry.display && entry.customType !== "collab-prompt") return "";
		const notes = entry.customType === ADVISOR_TYPE ? advisorNotes(entry.details) : null;
		return notes === null ? contentText(entry.content) : notes.map(note => `${note.note}\n`).join("");
	}
	if (entry.type !== "message") return "";
	const message = entry.message;
	if (message.role === "user") return contentText(message.content);
	if (message.role === "toolResult") return toolResultReplies(message.details).join("\n");
	if (message.role !== "assistant") return "";
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += `${block.text}\n`;
		else if (block.type === "toolCall") {
			const reply = replyWriteText(block.name, block.arguments);
			if (reply !== undefined) text += `${reply}\n`;
		}
	}
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
