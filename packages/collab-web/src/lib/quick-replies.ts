/**
 * Saved prompts: one-tap text shown above the composer and in the start-session sheet, edited in Settings →
 * Messages. Stored per device (not per room): they are the user's habits, not a session's.
 */

import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

const QUICK_KEY = "omp.collab.quick";
export const MAX_QUICK_REPLY_CHARS = 1000;

export const DEFAULT_QUICK_REPLIES: readonly string[] = [
	"Continue",
	"Run the tests",
	"What's left to do?",
	"Summarize the changes so far",
];

let replies: readonly string[] | undefined;
const listeners = new Set<() => void>();

/** The saved prompts, the same array until they change. */
export function quickReplies(): readonly string[] {
	if (replies === undefined) {
		const raw = readJson(QUICK_KEY);
		replies = Array.isArray(raw)
			? raw.filter((r): r is string => typeof r === "string" && r.length > 0)
			: DEFAULT_QUICK_REPLIES;
	}
	return replies;
}

export function setQuickReplies(next: readonly string[]): void {
	replies = next;
	writeJson(QUICK_KEY, next);
	for (const listener of listeners) listener();
}

/** The saved prompts; re-renders when they change, so the composer follows an edit made in Settings. */
export function useQuickReplies(): readonly string[] {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		quickReplies,
		() => DEFAULT_QUICK_REPLIES,
	);
}
