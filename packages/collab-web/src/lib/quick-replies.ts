/**
 * One-tap prompts shown above the composer. Stored per device (not per room):
 * they are the user's habits, not a session's.
 */

import { readJson, writeJson } from "./storage";

const QUICK_KEY = "omp.collab.quick";
export const MAX_QUICK_REPLY_CHARS = 200;

export const DEFAULT_QUICK_REPLIES: readonly string[] = [
	"Continue",
	"Run the tests",
	"What's left to do?",
	"Summarize the changes so far",
];

export function loadQuickReplies(): string[] {
	const raw = readJson(QUICK_KEY);
	if (!Array.isArray(raw)) return [...DEFAULT_QUICK_REPLIES];
	return raw.filter((r): r is string => typeof r === "string" && r.length > 0);
}

export function saveQuickReplies(replies: readonly string[]): void {
	writeJson(QUICK_KEY, replies);
}
