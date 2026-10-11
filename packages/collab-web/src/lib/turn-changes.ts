/**
 * What the per-turn changes sheet needs beyond the frames: the session's turns in order, the files a
 * reader has marked viewed, and the key their review comments are stored under.
 */

import type { SessionEntry, TurnDiffFile } from "@oh-my-pi/pi-wire";
import { contentMarkdown, turnRanges } from "./export";
import { readJson, writeJson } from "./storage";

/** A prompt and the turn it opens. */
export interface PromptTurn {
	/** The prompt's entry id: what the host's `turn-diff` takes. */
	id: string;
	/** 1-based. */
	turn: number;
	/** The prompt's first line, shortened. */
	label: string;
}

const LABEL_MAX = 60;

/** Every turn of the transcript, oldest first. */
export function promptTurns(entries: readonly SessionEntry[]): PromptTurn[] {
	return turnRanges(entries).map((range, i) => {
		const entry = entries[range.from]!;
		const content = entry.type === "message" && entry.message.role === "user" ? entry.message.content : "";
		const text = entry.type === "custom_message" ? contentMarkdown(entry.content) : contentMarkdown(content);
		const line = text.split("\n", 1)[0]?.trim() ?? "";
		return { id: entry.id, turn: i + 1, label: line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line };
	});
}

/** What the sheet shows: one turn's changes, or the whole session's. */
export type TurnChangesView = { scope: "turn"; entryId: string } | { scope: "session" };

/** Key a view's review comments and viewed marks are stored under. */
export function viewKey(sessionId: string, view: TurnChangesView): string {
	return view.scope === "turn" ? `${sessionId}.turn.${view.entryId}` : `${sessionId}.session`;
}

/** A file as the reader saw it: a change to it since (the latest turn is still running) clears its viewed mark. */
export function fileSignature(file: TurnDiffFile): string {
	return `${file.status}:${file.added ?? "-"}:${file.removed ?? "-"}:${file.diff.length}`;
}

const VIEWED_KEY = "omp.collab.turn-viewed";
const MAX_VIEWS = 100;

interface ViewedEntry {
	key: string;
	/** Path → signature when it was marked. */
	files: Record<string, string>;
}

/** Newest first. */
function loadViewedEntries(): ViewedEntry[] {
	const raw = readJson(VIEWED_KEY);
	if (!Array.isArray(raw)) return [];
	const entries: ViewedEntry[] = [];
	for (const v of raw) {
		if (typeof v !== "object" || v === null) continue;
		const { key, files } = v as Record<string, unknown>;
		if (typeof key !== "string" || typeof files !== "object" || files === null) continue;
		const clean: Record<string, string> = {};
		for (const [path, signature] of Object.entries(files)) if (typeof signature === "string") clean[path] = signature;
		entries.push({ key, files: clean });
	}
	return entries;
}

/** Files marked viewed in a view, with the signature they had then. */
export function loadViewed(key: string): Record<string, string> {
	return loadViewedEntries().find(entry => entry.key === key)?.files ?? {};
}

/** An empty set forgets the view; the 100 most recently changed views are kept. */
export function saveViewed(key: string, files: Readonly<Record<string, string>>): void {
	const rest = loadViewedEntries().filter(entry => entry.key !== key);
	const next = Object.keys(files).length === 0 ? rest : [{ key, files: { ...files } }, ...rest];
	writeJson(VIEWED_KEY, next.length === 0 ? null : next.slice(0, MAX_VIEWS));
}

/** Paths among `files` whose viewed mark still matches what the file looks like now. */
export function viewedPaths(files: readonly TurnDiffFile[], marks: Readonly<Record<string, string>>): Set<string> {
	const viewed = new Set<string>();
	for (const file of files) {
		if (Object.hasOwn(marks, file.path) && marks[file.path] === fileSignature(file)) viewed.add(file.path);
	}
	return viewed;
}
