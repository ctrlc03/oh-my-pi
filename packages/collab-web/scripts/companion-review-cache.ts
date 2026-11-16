/**
 * The review board's notes on disk, so reopening a board costs nothing: one file per repository, subject and version
 * (`<dir>/<key>.json`), holding what sessions said about the hunks and what a model wrote for the rest. Private to the
 * user (folder 0700, files 0600, under the omp config folder, never in a repository); writes are atomic. Entries older
 * than {@link MAX_AGE_MS} are dropped and at most {@link MAX_ENTRIES} are kept, the least recently used going first.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { type HunkNote, type ReviewSubject, subjectKey } from "../src/lib/review-board";
import { isRecord } from "../src/tool-render/util";

/** 2: session notes carry `weak`; entries of version 1 are read as missing. */
const CACHE_VERSION = 2;
export const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const MAX_ENTRIES = 200;
/** A file larger than this is not read back (and so is replaced at the next write). */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const STALE_TEMP_MS = 60 * 60_000;
const MAX_NOTES = 5_000;
const KEY_RE = /^[0-9a-f]{64}$/;

export interface CacheEntry {
	v: typeof CACHE_VERSION;
	key: string;
	/** Epoch ms the entry was last written. */
	at: number;
	/** Quoted from sessions; absent until the sessions were read. */
	session?: HunkNote[];
	/** Written by a model. */
	generated: HunkNote[];
}

/**
 * What an entry is filed under: the repository, the subject and its version. A session's own subject (and a turn of
 * it) is also that session's: two sessions changing the same files do not share their notes.
 */
export function reviewCacheKey(repo: string, subject: ReviewSubject, version: string, sessionId: string): string {
	const scope = subject.kind === "session" ? sessionId : "";
	return createHash("sha256")
		.update(JSON.stringify([repo, subjectKey(subject), version, scope]))
		.digest("hex");
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A note read back from disk, or null when it is not one. */
export function parseNote(value: unknown): HunkNote | null {
	if (!isRecord(value)) return null;
	const { path: notePath, hunk, text, source } = value;
	if (typeof notePath !== "string" || typeof hunk !== "string" || typeof text !== "string") return null;
	if (source !== "session" && source !== "generated") return null;
	const note: HunkNote = { path: notePath, hunk, text, source };
	const sessionId = optionalString(value.sessionId);
	const sessionTitle = optionalString(value.sessionTitle);
	const turn = optionalNumber(value.turn);
	const intent = optionalString(value.intent);
	const at = optionalNumber(value.at);
	if (sessionId !== undefined) note.sessionId = sessionId;
	if (sessionTitle !== undefined) note.sessionTitle = sessionTitle;
	if (turn !== undefined) note.turn = turn;
	if (intent !== undefined) note.intent = intent;
	if (at !== undefined) note.at = at;
	if (value.weak === true && source === "session") note.weak = true;
	return note;
}

function parseNotes(value: unknown): HunkNote[] | null {
	if (!Array.isArray(value) || value.length > MAX_NOTES) return null;
	const notes: HunkNote[] = [];
	for (const item of value) {
		const note = parseNote(item);
		if (note === null) return null;
		notes.push(note);
	}
	return notes;
}

export interface ReviewCache {
	read(key: string): Promise<CacheEntry | null>;
	/** Store the entry and evict what is old or beyond the limit. */
	write(key: string, entry: Pick<CacheEntry, "session" | "generated">): Promise<void>;
}

export function createReviewCache(dir: string, now: () => number = Date.now): ReviewCache {
	const fileOf = (key: string): string => {
		if (!KEY_RE.test(key)) throw new Error("invalid cache key");
		return path.join(dir, `${key}.json`);
	};

	async function evict(): Promise<void> {
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			return;
		}
		const rows: { file: string; mtime: number }[] = [];
		for (const name of names) {
			const temp = name.endsWith(".tmp");
			if (!temp && !name.endsWith(".json")) continue;
			const file = path.join(dir, name);
			const stat = await fs.stat(file).catch(() => null);
			if (!stat?.isFile()) continue;
			// A temp file is a write that never finished (the companion stopped between the two steps).
			if (temp) {
				if (now() - stat.mtimeMs >= STALE_TEMP_MS) await fs.rm(file, { force: true }).catch(() => undefined);
			} else {
				rows.push({ file, mtime: stat.mtimeMs });
			}
		}
		rows.sort((a, b) => b.mtime - a.mtime);
		const cutoff = now() - MAX_AGE_MS;
		await Promise.all(
			rows
				.filter((row, i) => i >= MAX_ENTRIES || row.mtime < cutoff)
				.map(row => fs.rm(row.file, { force: true }).catch(() => undefined)),
		);
	}

	return {
		async read(key) {
			const file = fileOf(key);
			try {
				const stat = await fs.stat(file);
				if (stat.size > MAX_ENTRY_BYTES || now() - stat.mtimeMs >= MAX_AGE_MS) return null;
				const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
				if (!isRecord(raw) || raw.v !== CACHE_VERSION || raw.key !== key || typeof raw.at !== "number") return null;
				const generated = parseNotes(raw.generated);
				const session = raw.session === undefined ? undefined : parseNotes(raw.session);
				if (generated === null || session === null) return null;
				// Reading is using: a board that is opened again keeps its notes.
				const used = new Date(now());
				await fs.utimes(file, used, used).catch(() => undefined);
				return { v: CACHE_VERSION, key, at: raw.at, ...(session ? { session } : {}), generated };
			} catch {
				// Missing or unreadable: the notes are worked out again.
				return null;
			}
		},
		async write(key, entry) {
			const file = fileOf(key);
			await fs.mkdir(dir, { recursive: true, mode: 0o700 });
			await fs.chmod(dir, 0o700);
			const body: CacheEntry = {
				v: CACHE_VERSION,
				key,
				at: now(),
				...(entry.session ? { session: entry.session.slice(0, MAX_NOTES) } : {}),
				generated: entry.generated.slice(0, MAX_NOTES),
			};
			const temp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
			await fs.writeFile(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
			await fs.rename(temp, file);
			await evict();
		},
	};
}
