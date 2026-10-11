/**
 * Stashed drafts: a half-written message set aside (⌘S) to make room for another, with a list to take them
 * back from. Kept per device, not per session, so a draft can move to another session. Text only: attached
 * images and files stay where they are.
 */
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

const STASH_KEY = "omp.collab.stash";
/** Drafts kept; stashing past this drops the oldest. */
export const MAX_STASHED = 20;
/** A draft longer than this is refused (it would not fit local storage alongside the rest). */
export const MAX_STASH_CHARS = 100_000;

export interface StashedDraft {
	id: string;
	text: string;
	/** Unix ms. */
	at: number;
}

function isStashed(value: unknown): value is StashedDraft {
	if (typeof value !== "object" || value === null) return false;
	const d = value as Record<string, unknown>;
	return typeof d.id === "string" && typeof d.text === "string" && typeof d.at === "number";
}

/**
 * `drafts` (newest first) with `text` put on top. Blank or oversized text changes nothing; the same text stashed
 * again moves to the top instead of repeating.
 */
export function pushStash(drafts: readonly StashedDraft[], text: string, id: string, at: number): StashedDraft[] {
	if (text.trim() === "" || text.length > MAX_STASH_CHARS) return [...drafts];
	return [{ id, text, at }, ...drafts.filter(draft => draft.text !== text)].slice(0, MAX_STASHED);
}

let drafts: readonly StashedDraft[] | undefined;
const listeners = new Set<() => void>();

function current(): readonly StashedDraft[] {
	if (drafts === undefined) {
		const raw = readJson(STASH_KEY);
		drafts = Array.isArray(raw) ? raw.filter(isStashed).slice(0, MAX_STASHED) : [];
	}
	return drafts;
}

function commit(next: readonly StashedDraft[]): void {
	drafts = next;
	writeJson(STASH_KEY, next.length > 0 ? next : null);
	for (const listener of listeners) listener();
}

/** Stashes `text`; false when it is blank or too long. */
export function stashDraft(text: string): boolean {
	if (text.trim() === "" || text.length > MAX_STASH_CHARS) return false;
	commit(pushStash(current(), text, crypto.randomUUID(), Date.now()));
	return true;
}

export function dropStashed(id: string): void {
	commit(current().filter(draft => draft.id !== id));
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The stash, newest first; re-renders when a draft is stashed or dropped, here or in another composer. */
export function useStashedDrafts(): readonly StashedDraft[] {
	return useSyncExternalStore(subscribe, current, current);
}
