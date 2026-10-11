/**
 * The host's own transcript of a foreign agent session: `<config>/agent/collab-foreign/sessions/<id>.jsonl`.
 *
 * It reads like an omp session file, so the companion's session reader and the app's transcript viewer need
 * no second format: a `session` header line, then append-only entries that each name their `parentId`.
 * The active path is the parent chain of the last line; a rewind appends a `custom` marker whose parent is
 * the entry rewound to, so the file alone says where the session stands after a restart. Nothing is ever
 * rewritten, which is also what lets `fetch-transcript` serve it by byte range.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EntryBase, SessionEntry, SessionHeader } from "@oh-my-pi/pi-wire";

/** An entry that is stored but never sent to guests: a marker, an approval record. */
export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

/** A rename of the session. */
export interface TitleChangeEntry extends EntryBase {
	type: "title_change";
	title: string;
}

export type StoredEntry = SessionEntry | CustomEntry | TitleChangeEntry;

/** Entry types the app renders (the wire's `SessionEntry`); the rest stay in the file. */
export function isRenderable(entry: StoredEntry): entry is SessionEntry {
	return entry.type !== "custom" && entry.type !== "title_change";
}

/** Entry types a caller supplies: the store adds `id`, `parentId` and `timestamp`. */
export type NewEntry =
	| Omit<Extract<SessionEntry, { type: "message" }>, keyof EntryBase>
	| Omit<Extract<SessionEntry, { type: "custom_message" }>, keyof EntryBase>
	| Omit<Extract<SessionEntry, { type: "model_change" }>, keyof EntryBase>
	| Omit<Extract<SessionEntry, { type: "thinking_level_change" }>, keyof EntryBase>
	| Omit<CustomEntry, keyof EntryBase>
	| Omit<TitleChangeEntry, keyof EntryBase>;

/** Directory of every foreign session's transcript. */
export function transcriptDir(configDir: string): string {
	return path.join(configDir, "agent", "collab-foreign", "sessions");
}

/** `sessionId` is a host-made id (`<agent>-<16 hex>`), never a path. */
export function transcriptPath(configDir: string, sessionId: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
	return path.join(transcriptDir(configDir), `${sessionId}.jsonl`);
}

function newEntryId(taken: ReadonlyMap<string, unknown>): string {
	for (;;) {
		const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
		if (!taken.has(id)) return id;
	}
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function isEntry(value: unknown): value is StoredEntry {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if (!("type" in value) || typeof value.type !== "string" || value.type === "session") return false;
	return "parentId" in value && (value.parentId === null || typeof value.parentId === "string");
}

function isHeader(value: unknown): value is SessionHeader {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		value.type === "session" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

export class Transcript {
	readonly path: string;
	header: SessionHeader;
	readonly #entries: StoredEntry[];
	readonly #byId = new Map<string, StoredEntry>();
	#leaf: string | null;
	#writes: Promise<void> = Promise.resolve();
	#failure: Error | null = null;

	private constructor(file: string, header: SessionHeader, entries: StoredEntry[]) {
		this.path = file;
		this.header = header;
		this.#entries = entries;
		for (const entry of entries) this.#byId.set(entry.id, entry);
		this.#leaf = entries.at(-1)?.id ?? null;
	}

	/** Start a transcript: the file is created (owner-only) with its header line. */
	static async create(configDir: string, header: SessionHeader): Promise<Transcript> {
		const file = transcriptPath(configDir, header.id);
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.writeFile(file, `${JSON.stringify({ ...header, version: 3 })}\n`, { flag: "wx", mode: 0o600 });
		return new Transcript(file, header, []);
	}

	/** Load an existing transcript; null when there is none or its header is unreadable. Unreadable entry lines are skipped. */
	static async open(configDir: string, sessionId: string): Promise<Transcript | null> {
		const file = transcriptPath(configDir, sessionId);
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch {
			return null;
		}
		const lines = text.split("\n").filter(line => line !== "");
		const header = parseLine(lines[0] ?? "");
		if (!isHeader(header)) return null;
		const entries: StoredEntry[] = [];
		for (const line of lines.slice(1)) {
			const parsed = parseLine(line);
			if (isEntry(parsed)) entries.push(parsed);
		}
		const title = entries.findLast(entry => entry.type === "title_change");
		return new Transcript(file, title?.type === "title_change" ? { ...header, title: title.title } : header, entries);
	}

	/** Id of the last entry of the active path; null while it is empty. */
	get leafId(): string | null {
		return this.#leaf;
	}

	/** Every entry in the file, dropped branches included. */
	get all(): readonly StoredEntry[] {
		return this.#entries;
	}

	/** The entries from the first to the leaf, in order. */
	get activePath(): StoredEntry[] {
		const out: StoredEntry[] = [];
		for (let id = this.#leaf; id !== null;) {
			const entry = this.#byId.get(id);
			if (entry === undefined) break;
			out.push(entry);
			id = entry.parentId;
		}
		return out.reverse();
	}

	/** What guests see: the active path without the host-only entries. */
	get renderablePath(): SessionEntry[] {
		return this.activePath.filter(isRenderable);
	}

	get(id: string): StoredEntry | undefined {
		return this.#byId.get(id);
	}

	/** Whether `id` is on the active path. */
	onPath(id: string): boolean {
		for (let at = this.#leaf; at !== null;) {
			if (at === id) return true;
			at = this.#byId.get(at)?.parentId ?? null;
		}
		return false;
	}

	/** Append an entry under the leaf; it is on disk once {@link flush} resolves. */
	append(entry: NewEntry): StoredEntry {
		const stored = {
			...entry,
			id: newEntryId(this.#byId),
			parentId: this.#leaf,
			timestamp: new Date().toISOString(),
		} as StoredEntry;
		this.#add(stored);
		return stored;
	}

	/**
	 * Move the session to just before `entryId` (a rewind): the entries from it on leave the active path but
	 * stay in the file. The move is itself an entry, so a restart finds the session where it was left.
	 * Returns the id the active path now ends at (null when it is empty).
	 */
	rewindBefore(entryId: string): string | null {
		const target = this.#byId.get(entryId);
		if (target === undefined) throw new Error(`no such entry: ${entryId}`);
		const marker: CustomEntry = {
			type: "custom",
			customType: "rewind",
			data: { before: entryId },
			id: newEntryId(this.#byId),
			parentId: target.parentId,
			timestamp: new Date().toISOString(),
		};
		this.#add(marker);
		return target.parentId;
	}

	/** Rename the session; the header the guests see changes with it. */
	rename(title: string): void {
		this.append({ type: "title_change", title });
		this.header = { ...this.header, title };
	}

	#add(entry: StoredEntry): void {
		this.#entries.push(entry);
		this.#byId.set(entry.id, entry);
		this.#leaf = entry.id;
		const line = `${JSON.stringify(entry)}\n`;
		this.#writes = this.#writes
			.then(() => fs.appendFile(this.path, line))
			.catch((err: unknown) => {
				this.#failure ??= err instanceof Error ? err : new Error(String(err));
			});
	}

	/** Resolves once every entry appended so far is on disk; rejects with the first write error. */
	flush(): Promise<void> {
		return this.#writes.then(() => {
			if (this.#failure !== null) throw this.#failure;
		});
	}
}

/** Most bytes one `fetch-transcript` reply carries; the guest asks again from `newSize` for the rest. */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;

export interface TranscriptSlice {
	text: string;
	/** Offset the next request starts from. */
	newSize: number;
	error?: string;
}

/** The part of a transcript file from `fromByte`, cut after its last whole line when it exceeds the cap. */
export async function readTranscriptSlice(file: string, fromByte: number): Promise<TranscriptSlice> {
	const handle = await fs.open(file, "r");
	try {
		const { size } = await handle.stat();
		if (size <= fromByte) return { text: "", newSize: size };
		const want = Math.min(size - fromByte, TRANSCRIPT_READ_CAP);
		const buf = Buffer.allocUnsafe(want);
		const { bytesRead } = await handle.read(buf, 0, want, fromByte);
		let slice = buf.subarray(0, bytesRead);
		const reachedEof = fromByte + bytesRead >= size;
		if (!reachedEof) {
			const lastNewline = slice.lastIndexOf(0x0a);
			if (lastNewline < 0) {
				return {
					text: "",
					newSize: fromByte,
					error: `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`,
				};
			}
			slice = slice.subarray(0, lastNewline + 1);
		}
		return { text: slice.toString("utf-8"), newSize: reachedEof ? size : fromByte + slice.byteLength };
	} finally {
		await handle.close();
	}
}
