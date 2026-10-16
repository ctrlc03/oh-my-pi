/**
 * The append-only chat log of the chat-tree memory mode (spec §1), one directory (`<agentDir>/personal-chat`):
 *
 * ```
 * main/YYYY-MM-DD.jsonl   {"i","kind","text","size","date"}   one message per line
 * tree/YYYY-MM-DD.jsonl   {"l","i","text","size"}             one built node per line
 * view.json               [[l, i], ...]                        the view, replaced atomically
 * lock                    {"pid","startedAt"}                  one process owns the chat
 * ```
 *
 * A row is only ever appended, and each append is fsynced before it resolves; no line is edited or deleted.
 * The one exception is a torn tail: a last line that is not a whole valid row (a crash mid-write; its append never
 * resolved) is ignored when the log opens and cut off the file, so later appends stay parseable. Open reads every
 * day file once and keeps an index (file, byte offset, length) per row, so text is read back by positioned slices.
 * A day file is named by the UTC date of its row and never goes back: a clock that steps back into an earlier day
 * keeps appending to the newest file, so ids stay in file order.
 */
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { utf8Size } from "./text";
import { CHAT_KINDS, type ChatKind, type MessageRow, nodeKey, type TreeRow } from "./types";

const LOCK_FILE = "lock";
const VIEW_FILE = "view.json";
const MAIN_DIR = "main";
const TREE_DIR = "tree";
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const LOCK_RETRY_MS = 250;
/** How many recently appended or read nodes `readNode` keeps in memory. */
const NODE_CACHE_ENTRIES = 4096;

/** Another live process owns the chat log. */
export class ChatLockedError extends Error {
	readonly pid: number;

	constructor(pid: number, dir: string) {
		super(`chat log ${dir} is locked by process ${pid}`);
		this.name = "ChatLockedError";
		this.pid = pid;
	}
}

export interface ChatLogOptions {
	/** Clock; default () => new Date(). */
	now?: () => Date;
	/** How long open() keeps retrying a lock held by a live process, in ms (default 0 = fail at once). Retries every 250 ms. */
	waitForLockMs?: number;
	/** Pid considered the owner; default process.pid (tests may pass another). */
	pid?: number;
	/** Liveness probe of a pid (default: process.kill(pid, 0) succeeds, or fails with EPERM). */
	isAlive?: (pid: number) => boolean;
	/** When another pid's process started, epoch ms (default: `ps -o etime=`); undefined when unobtainable, which skips the pid-reuse check. */
	processStartMs?: (pid: number) => Promise<number | undefined> | number | undefined;
}

/** What the index remembers of a logged message without its text. */
export interface MessageMeta {
	i: number;
	kind: ChatKind;
	size: number;
	date: string;
}

/** Where a row sits on disk: an index into the area's file list, the byte offset of the line, and its length without the newline. */
interface Place {
	file: number;
	offset: number;
	length: number;
}

interface MessageEntry extends Place {
	kind: ChatKind;
	size: number;
	date: string;
}

interface NodeEntry extends Place {
	l: number;
	i: number;
	size: number;
}

type Area = typeof MAIN_DIR | typeof TREE_DIR;

interface Writer {
	file: string;
	handle: FileHandle;
	/** Size of the file in bytes: where the next row lands. */
	size: number;
}

interface ScannedFile<Row> {
	rows: { row: Row; offset: number; length: number }[];
	/** Bytes up to the end of the last whole row (and its newline, if it has one). */
	validEnd: number;
	size: number;
}

function isNonNegativeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseMessageRow(value: unknown): MessageRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (!isNonNegativeInt(row.i) || typeof row.text !== "string" || typeof row.date !== "string") return undefined;
	if (!CHAT_KINDS.includes(row.kind as ChatKind) || row.size !== utf8Size(row.text)) return undefined;
	return { i: row.i, kind: row.kind as ChatKind, text: row.text, size: row.size, date: row.date };
}

function parseTreeRow(value: unknown): TreeRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (!isNonNegativeInt(row.l) || !isNonNegativeInt(row.i) || typeof row.text !== "string") return undefined;
	if (row.size !== utf8Size(row.text)) return undefined;
	return { l: row.l, i: row.i, text: row.text, size: row.size };
}

/** Reads a day file line by line. A last line that is not a whole valid row is dropped; a bad line elsewhere throws. */
async function scanFile<Row>(file: string, parse: (value: unknown) => Row | undefined): Promise<ScannedFile<Row>> {
	const bytes = await fs.readFile(file);
	const rows: ScannedFile<Row>["rows"] = [];
	let pos = 0;
	let line = 0;
	while (pos < bytes.length) {
		line++;
		const newline = bytes.indexOf(10, pos);
		const end = newline < 0 ? bytes.length : newline;
		const next = newline < 0 ? bytes.length : newline + 1;
		let row: Row | undefined;
		try {
			row = parse(JSON.parse(bytes.toString("utf8", pos, end)));
		} catch {
			row = undefined;
		}
		if (row === undefined) {
			if (next < bytes.length) throw new Error(`${file}:${line}: corrupt row`);
			break;
		}
		rows.push({ row, offset: pos, length: end - pos });
		pos = next;
	}
	return { rows, validEnd: pos, size: bytes.length };
}

/** Cuts a torn tail off a scanned file, and ends a whole last row that lost its newline. */
async function repairTail(file: string, scanned: ScannedFile<unknown>): Promise<void> {
	if (scanned.size > scanned.validEnd) {
		await fs.truncate(file, scanned.validEnd);
	} else if (scanned.validEnd > 0) {
		const handle = await fs.open(file, "r");
		try {
			const last = Buffer.alloc(1);
			await handle.read(last, 0, 1, scanned.validEnd - 1);
			if (last[0] === 10) return;
		} finally {
			await handle.close();
		}
		await fs.appendFile(file, "\n");
	}
}

async function listDayFiles(dir: string): Promise<string[]> {
	const names = await fs.readdir(dir);
	return names.filter(name => DAY_FILE.test(name)).sort();
}

function isErrno(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isErrno(error, "EPERM");
	}
}

/** The pid a lock file names, or undefined when its content is not a lock. */
function lockPid(raw: string): number | undefined {
	try {
		const value = JSON.parse(raw) as { pid?: unknown } | null;
		const pid = value?.pid;
		return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

async function readIfExists(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	}
}

let tempCounter = 0;

/** Replaces `file` with `content` atomically: a temp file in the same directory, fsynced, then renamed over it. */
async function writeFileAtomic(file: string, content: string): Promise<void> {
	const temp = `${file}.${process.pid}.${tempCounter++}.tmp`;
	try {
		const handle = await fs.open(temp, "w");
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temp, file);
	} catch (error) {
		await fs.rm(temp, { force: true });
		throw error;
	}
}

/** Lock files of the chats this process holds (by absolute lock path): a lock naming our own pid that is not in here is a leftover of a dead predecessor with the same pid. */
const heldLocks = new Set<string>();

/** Slack for comparing a process start time (second precision, estimated from its elapsed time) with the time a lock was written. */
const START_SLACK_MS = 5000;

/** Epoch ms a process started at, from `ps -o etime=` (`[[dd-]hh:]mm:ss`, on both macOS and Linux); undefined when `ps` or the pid is unavailable. */
async function processStartMs(pid: number): Promise<number | undefined> {
	try {
		const proc = Bun.spawn(["ps", "-o", "etime=", "-p", String(pid)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(out);
		if (!match) return undefined;
		const [, days, hours, minutes, seconds] = match;
		const hoursTotal = Number(days ?? 0) * 24 + Number(hours ?? 0);
		const elapsed = ((hoursTotal * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
		return Date.now() - elapsed;
	} catch {
		return undefined;
	}
}

/** When the lock file's content says it was written (`startedAt`), in epoch ms; undefined when absent or unparsable. */
function lockStartedAt(raw: string): number | undefined {
	try {
		const value = JSON.parse(raw) as { startedAt?: unknown } | null;
		const at = typeof value?.startedAt === "string" ? Date.parse(value.startedAt) : Number.NaN;
		return Number.isNaN(at) ? undefined : at;
	} catch {
		return undefined;
	}
}

/**
 * Whether the process the lock names still holds it. A live pid is not enough: after a reboot or a pid wrap the pid
 * can belong to an unrelated process. So a lock naming our own pid is a leftover unless a chat of this process holds
 * it, and another pid whose process started after the lock was written cannot be the one that wrote it (skipped when
 * the start time is unobtainable, e.g. no `ps`).
 */
async function lockHeld(
	raw: string,
	holder: number,
	lockFile: string,
	isAlive: (pid: number) => boolean,
	processStart: (pid: number) => Promise<number | undefined> | number | undefined,
): Promise<boolean> {
	if (!isAlive(holder)) return false;
	if (holder === process.pid) return heldLocks.has(lockFile);
	const wrote = lockStartedAt(raw);
	if (wrote === undefined) return true;
	const started = await processStart(holder);
	return started === undefined || started <= wrote + START_SLACK_MS;
}

/**
 * Takes the lock file and returns the content it was written with. The file appears whole and exclusively (the
 * content goes to a temp file that is hard-linked into place), so a reader never sees it half written. A lock that
 * is not held any more (see `lockHeld`), or whose content is not a lock, is taken over: it is renamed to a name
 * unique to this attempt, and only deleted when what was moved is still the content that was judged stale. If
 * another process had already replaced it, that lock is moved back instead, so a fresh lock is never deleted. (A
 * third process linking its own lock in the instant between the move and the move back is the one window left.)
 */
async function acquireLock(dir: string, pid: number, options: ChatLogOptions): Promise<string> {
	const now = options.now ?? (() => new Date());
	const isAlive = options.isAlive ?? processAlive;
	const processStart = options.processStartMs ?? processStartMs;
	const lockFile = path.join(path.resolve(dir), LOCK_FILE);
	const deadline = Date.now() + (options.waitForLockMs ?? 0);
	for (;;) {
		const content = JSON.stringify({ pid, startedAt: now().toISOString() });
		const temp = `${lockFile}.${pid}.${tempCounter++}.tmp`;
		try {
			await fs.writeFile(temp, content, { flag: "wx" });
			await fs.link(temp, lockFile);
			heldLocks.add(lockFile);
			return content;
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		} finally {
			await fs.rm(temp, { force: true });
		}
		const raw = await readIfExists(lockFile);
		if (raw === undefined) continue;
		const holder = lockPid(raw);
		if (holder !== undefined && (await lockHeld(raw, holder, lockFile, isAlive, processStart))) {
			const left = deadline - Date.now();
			if (left <= 0) throw new ChatLockedError(holder, dir);
			await Bun.sleep(Math.min(LOCK_RETRY_MS, left));
			continue;
		}
		await takeOver(lockFile, raw, pid);
	}
}

/** Removes the stale lock `raw` from `lockFile` without ever deleting a lock another process just linked there. */
async function takeOver(lockFile: string, raw: string, pid: number): Promise<void> {
	const moved = `${lockFile}.${pid}.${tempCounter++}.stale`;
	try {
		await fs.rename(lockFile, moved);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return;
		throw error;
	}
	try {
		if ((await readIfExists(moved)) === raw) return;
		// What we moved is not what we judged stale: someone replaced it first. Put it back.
		await fs.link(moved, lockFile).catch(error => {
			if (!isErrno(error, "EEXIST")) throw error;
		});
	} finally {
		await fs.rm(moved, { force: true });
	}
}

/** The append-only chat log under one directory (`<agentDir>/personal-chat`): see the module comment. */
export class ChatLog {
	readonly dir: string;
	readonly #now: () => Date;
	readonly #lockContent: string;
	readonly #messages: MessageEntry[] = [];
	readonly #nodes = new Map<string, NodeEntry>();
	/** Day files per area, in name order; `Place.file` indexes them. */
	readonly #files: Record<Area, string[]> = { main: [], tree: [] };
	readonly #writers = new Map<Area, Writer>();
	readonly #nodeCache = new Map<string, TreeRow>();
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;
	#closing: Promise<void> | undefined;

	private constructor(dir: string, now: () => Date, lockContent: string) {
		this.dir = dir;
		this.#now = now;
		this.#lockContent = lockContent;
	}

	/**
	 * Takes the lock (creating the directory tree) and loads the indexes. Throws `ChatLockedError` when another LIVE
	 * process holds the lock after `waitForLockMs`; a lock whose pid is dead, was reused by another process (our own
	 * pid with no open chat here, or a process that started after the lock was written), or is unreadable is taken over. Throws
	 * when a day file has a corrupt row that is not its last line, when message ids are not contiguous from 0 in file
	 * order, or when a node appears twice.
	 */
	static async open(dir: string, options: ChatLogOptions = {}): Promise<ChatLog> {
		const pid = options.pid ?? process.pid;
		await fs.mkdir(path.join(dir, MAIN_DIR), { recursive: true });
		await fs.mkdir(path.join(dir, TREE_DIR), { recursive: true });
		const content = await acquireLock(dir, pid, options);
		const log = new ChatLog(dir, options.now ?? (() => new Date()), content);
		try {
			await log.#load();
		} catch (error) {
			await log.#releaseLock();
			throw error;
		}
		return log;
	}

	/** Number of messages (= the next id). */
	get messageCount(): number {
		return this.#messages.length;
	}

	/** Number of built nodes logged. */
	get nodeCount(): number {
		return this.#nodes.size;
	}

	async #load(): Promise<void> {
		for (const name of await listDayFiles(path.join(this.dir, MAIN_DIR))) {
			const file = path.join(this.dir, MAIN_DIR, name);
			const scanned = await scanFile(file, parseMessageRow);
			const index = this.#files.main.push(file) - 1;
			for (const { row, offset, length } of scanned.rows) {
				if (row.i !== this.#messages.length) {
					throw new Error(
						`${file}: message id ${row.i} where ${this.#messages.length} was expected (ids must be contiguous)`,
					);
				}
				this.#messages.push({ kind: row.kind, size: row.size, date: row.date, file: index, offset, length });
			}
			await repairTail(file, scanned);
		}
		for (const name of await listDayFiles(path.join(this.dir, TREE_DIR))) {
			const file = path.join(this.dir, TREE_DIR, name);
			const scanned = await scanFile(file, parseTreeRow);
			const index = this.#files.tree.push(file) - 1;
			for (const { row, offset, length } of scanned.rows) {
				const key = nodeKey(row.l, row.i);
				if (this.#nodes.has(key)) throw new Error(`${file}: node (${row.l}, ${row.i}) is logged twice`);
				this.#nodes.set(key, { l: row.l, i: row.i, size: row.size, file: index, offset, length });
			}
			await repairTail(file, scanned);
		}
	}

	/** Runs `task` after every task queued before it: appends within one process happen in call order. */
	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error(`chat log ${this.dir} is closed`));
		const run = this.#queue.then(task);
		this.#queue = run.catch(() => {});
		return run;
	}

	/** Appends one line to the area's current day file, fsyncs it, and returns where it landed. */
	async #appendLine(area: Area, line: string): Promise<Place> {
		const files = this.#files[area];
		const clockDay = this.#now().toISOString().slice(0, 10);
		const newest = files.length > 0 ? path.basename(files[files.length - 1], ".jsonl") : "";
		const file = path.join(this.dir, area, `${newest > clockDay ? newest : clockDay}.jsonl`);
		let writer = this.#writers.get(area);
		if (writer?.file !== file) {
			await writer?.handle.close();
			this.#writers.delete(area);
			const handle = await fs.open(file, "a");
			writer = { file, handle, size: (await handle.stat()).size };
			this.#writers.set(area, writer);
		}
		const bytes = Buffer.from(`${line}\n`, "utf8");
		const offset = writer.size;
		try {
			let written = 0;
			while (written < bytes.length) {
				written += (await writer.handle.write(bytes, written, bytes.length - written)).bytesWritten;
			}
			await writer.handle.sync();
		} catch (error) {
			// Never leave half a row behind: cut it off and start over from a fresh handle on the next append.
			this.#writers.delete(area);
			await writer.handle.truncate(offset).catch(() => {});
			await writer.handle.close().catch(() => {});
			throw error;
		}
		writer.size = offset + bytes.length;
		let index = files.indexOf(file);
		if (index < 0) index = files.push(file) - 1;
		return { file: index, offset, length: bytes.length - 1 };
	}

	/**
	 * Appends one message and flushes (fsync) before returning; assigns `i`, `size` (UTF-8 bytes of `text`) and `date`
	 * (ISO UTC from the clock). The day file is the UTC date of `date`. `text` is stored as given (callers split
	 * long text first).
	 */
	appendMessage(kind: ChatKind, text: string): Promise<MessageRow> {
		return this.#enqueue(async () => {
			const row: MessageRow = {
				i: this.#messages.length,
				kind,
				text,
				size: utf8Size(text),
				date: this.#now().toISOString(),
			};
			const place = await this.#appendLine(MAIN_DIR, JSON.stringify(row));
			this.#messages.push({ kind, size: row.size, date: row.date, ...place });
			return row;
		});
	}

	/** Index lookups, no I/O. */
	messageMeta(i: number): MessageMeta | undefined {
		const entry = this.#messages[i];
		return entry && { i, kind: entry.kind, size: entry.size, date: entry.date };
	}

	/** The text of the line at `place`, read as a positioned slice. */
	async #readLine(area: Area, place: Place): Promise<string> {
		return Bun.file(this.#files[area][place.file])
			.slice(place.offset, place.offset + place.length)
			.text();
	}

	/** Reads message `i` from disk by its recorded offset; undefined when `i` is out of range. */
	async readMessage(i: number): Promise<MessageRow | undefined> {
		const entry = this.#messages[i];
		if (!entry) return undefined;
		return JSON.parse(await this.#readLine(MAIN_DIR, entry)) as MessageRow;
	}

	/** Remembers a node's row, dropping the least recently used one beyond the cap. */
	#cacheNode(key: string, row: TreeRow): void {
		this.#nodeCache.delete(key);
		this.#nodeCache.set(key, row);
		if (this.#nodeCache.size > NODE_CACHE_ENTRIES) {
			const oldest = this.#nodeCache.keys().next();
			if (!oldest.done) this.#nodeCache.delete(oldest.value);
		}
	}

	/**
	 * Appends a built node and flushes; `size` is the UTF-8 bytes of `text`; the day file is today's (UTC). Throws if
	 * (l, i) already exists: each node is built once.
	 */
	appendNode(l: number, i: number, text: string): Promise<TreeRow> {
		return this.#enqueue(async () => {
			if (!isNonNegativeInt(l) || !isNonNegativeInt(i)) throw new Error(`invalid node (${l}, ${i})`);
			const key = nodeKey(l, i);
			if (this.#nodes.has(key)) throw new Error(`node (${l}, ${i}) is already built`);
			const row: TreeRow = { l, i, text, size: utf8Size(text) };
			const place = await this.#appendLine(TREE_DIR, JSON.stringify(row));
			this.#nodes.set(key, { l, i, size: row.size, ...place });
			this.#cacheNode(key, row);
			return row;
		});
	}

	hasNode(l: number, i: number): boolean {
		return this.#nodes.has(nodeKey(l, i));
	}

	/** Bytes of a built node's text, no I/O; undefined if not built. */
	nodeSize(l: number, i: number): number | undefined {
		return this.#nodes.get(nodeKey(l, i))?.size;
	}

	/** Reads a node's text from disk by offset, with a cache of the last ~4096 nodes appended or read. */
	async readNode(l: number, i: number): Promise<TreeRow | undefined> {
		const key = nodeKey(l, i);
		const entry = this.#nodes.get(key);
		if (!entry) return undefined;
		const cached = this.#nodeCache.get(key);
		if (cached) {
			this.#cacheNode(key, cached);
			return cached;
		}
		const row = JSON.parse(await this.#readLine(TREE_DIR, entry)) as TreeRow;
		this.#cacheNode(key, row);
		return row;
	}

	/** Calls back for every built node (one pass, any order): the startup recovery of the work queues. */
	forEachNode(callback: (l: number, i: number, size: number) => void): void {
		for (const entry of this.#nodes.values()) callback(entry.l, entry.i, entry.size);
	}

	/** `view.json` as parsed JSON; undefined when absent. Rejects with an Error naming the path when it is corrupt. */
	async readView(): Promise<unknown | undefined> {
		const file = path.join(this.dir, VIEW_FILE);
		const raw = await readIfExists(file);
		if (raw === undefined) return undefined;
		try {
			return JSON.parse(raw);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${file}: corrupt view (${reason})`, { cause: error });
		}
	}

	/** Atomically replaces `view.json` with `[[l, i], ...]` (temp file in the same directory, then rename). */
	writeView(entries: readonly (readonly [number, number])[]): Promise<void> {
		return this.#enqueue(() => writeFileAtomic(path.join(this.dir, VIEW_FILE), JSON.stringify(entries)));
	}

	async #releaseLock(): Promise<void> {
		const file = path.join(path.resolve(this.dir), LOCK_FILE);
		heldLocks.delete(file);
		if ((await readIfExists(file)) === this.#lockContent) await fs.rm(file, { force: true });
	}

	/** Waits for appends in flight, then releases the lock (removes the lock file if it is ours). Idempotent. After close, appends throw. */
	close(): Promise<void> {
		this.#closed = true;
		this.#closing ??= (async () => {
			await this.#queue;
			for (const writer of this.#writers.values()) await writer.handle.close();
			this.#writers.clear();
			await this.#releaseLock();
		})();
		return this.#closing;
	}
}
