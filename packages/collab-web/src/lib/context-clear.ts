/**
 * `/clear` on the host drops the conversation context in place and appends a `reset_boundary`
 * entry. The transcript keeps everything before it; the app folds those entries behind a
 * one-line expander so the page starts where the agent does. Nothing is deleted: expanding
 * shows them again, and find and copy work on them then.
 */

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { isPrompt } from "./trim";

export interface ContextClear {
	/** Index of the latest boundary in the entry list: the first entry that stays visible. */
	from: number;
	/** Id of that boundary; a newer `/clear` folds the page again even after an earlier one was expanded. */
	boundaryId: string;
	/** Prompts and replies before it: what the expander reports. */
	hiddenMessages: number;
}

/** A message a reader counts: a prompt (the user's or a guest's) or an agent reply. */
function isMessage(entry: SessionEntry): boolean {
	if (isPrompt(entry)) return true;
	return entry.type === "message" && entry.message.role === "assistant";
}

/**
 * The latest `/clear` on the active path and what it folds; null when there is none or nothing
 * readable comes before it (a `/clear` on a fresh session folds nothing).
 */
export function latestClear(entries: readonly SessionEntry[]): ContextClear | null {
	const from = entries.findLastIndex(entry => entry.type === "reset_boundary");
	if (from <= 0) return null;
	let hiddenMessages = 0;
	for (let i = 0; i < from; i++) if (isMessage(entries[i]!)) hiddenMessages++;
	return hiddenMessages === 0 ? null : { from, boundaryId: entries[from]!.id, hiddenMessages };
}
