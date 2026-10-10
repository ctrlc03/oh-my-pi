/**
 * "Keep the latest turns": a per-device, per-session preference that hides the
 * transcript before the last N prompts. Nothing is deleted: the session, the
 * agent and the saved transcript are untouched, and *Show all* reveals the rest.
 */

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { readJson, writeJson } from "./storage";

const TRIM_KEY = "omp.collab.trim";
const MAX_SESSIONS = 50;

/** Turns a session may keep; null shows the whole transcript. */
export const TRIM_CHOICES: readonly (number | null)[] = [null, 10, 3, 1];

interface Entry {
	sessionId: string;
	keep: number;
}

/** Newest first. */
function loadEntries(): Entry[] {
	const raw = readJson(TRIM_KEY);
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(v): v is Entry =>
			typeof v === "object" &&
			v !== null &&
			typeof (v as Entry).sessionId === "string" &&
			Number.isInteger((v as Entry).keep) &&
			(v as Entry).keep > 0,
	);
}

export function loadTrim(sessionId: string): number | null {
	return loadEntries().find(e => e.sessionId === sessionId)?.keep ?? null;
}

/** null shows everything again; the 50 most recently changed sessions are kept. */
export function saveTrim(sessionId: string, keep: number | null): void {
	const rest = loadEntries().filter(e => e.sessionId !== sessionId);
	writeJson(TRIM_KEY, keep === null ? rest : [{ sessionId, keep }, ...rest].slice(0, MAX_SESSIONS));
}

/** A prompt opens a turn: the user's own, or one a collab guest sent. */
export function isPrompt(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user";
	return entry.type === "custom_message" && entry.customType === "collab-prompt";
}

/**
 * Where the last `keep` turns start, and how many turns come before it. A
 * transcript with no more than `keep` prompts is shown whole.
 */
export function trimEntries(entries: readonly SessionEntry[], keep: number): { from: number; hiddenTurns: number } {
	let seen = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (!isPrompt(entries[i]!) || ++seen < keep) continue;
		let hiddenTurns = 0;
		for (let j = 0; j < i; j++) if (isPrompt(entries[j]!)) hiddenTurns++;
		// Only what came before the first prompt (session setup) would hide: show it all.
		return hiddenTurns === 0 ? { from: 0, hiddenTurns: 0 } : { from: i, hiddenTurns };
	}
	return { from: 0, hiddenTurns: 0 };
}
