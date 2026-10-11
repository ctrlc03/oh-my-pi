/**
 * Messages of the session on screen, for the command palette: every prompt and reply that contains all the
 * words typed, newest first, each with the stretch of text around the first hit. The companion answers the
 * same question across sessions (`session-search`); this answers it for the replica the app already holds.
 */

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { entryText } from "../components/transcript/search";
import { queryTerms } from "./search-terms";

export interface MessageHit {
	entryId: string;
	role: "user" | "assistant";
	/** About `SNIPPET_CHARS` characters around the first match, on one line. */
	snippet: string;
	/** The entry's own timestamp (ms), or null when it has none. */
	time: number | null;
}

export const SNIPPET_CHARS = 140;

/** `text` on one line, cut to about `SNIPPET_CHARS` around the earliest of `terms`, with an ellipsis where it was cut. */
export function snippetAround(text: string, terms: readonly string[]): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= SNIPPET_CHARS) return flat;
	const lower = flat.toLowerCase();
	let first = flat.length;
	for (const term of terms) {
		const at = lower.indexOf(term);
		if (at >= 0 && at < first) first = at;
	}
	if (first === flat.length) first = 0;
	const start = Math.max(0, Math.min(first - Math.floor(SNIPPET_CHARS / 3), flat.length - SNIPPET_CHARS));
	const end = Math.min(flat.length, start + SNIPPET_CHARS);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

function entryRole(entry: SessionEntry): "user" | "assistant" {
	return entry.type === "message" && entry.message.role === "assistant" ? "assistant" : "user";
}

/** The newest `limit` prompts and replies in `entries` containing every word of `query` (any case); none for a blank query. */
export function findMessages(entries: readonly SessionEntry[], query: string, limit: number): MessageHit[] {
	const terms = queryTerms(query);
	if (terms.length === 0) return [];
	const hits: MessageHit[] = [];
	for (let i = entries.length - 1; i >= 0 && hits.length < limit; i--) {
		const entry = entries[i]!;
		const text = entryText(entry);
		if (text === "") continue;
		const lower = text.toLowerCase();
		if (!terms.every(term => lower.includes(term))) continue;
		const time = Date.parse(entry.timestamp);
		hits.push({
			entryId: entry.id,
			role: entryRole(entry),
			snippet: snippetAround(text, terms),
			time: Number.isFinite(time) ? time : null,
		});
	}
	return hits;
}
