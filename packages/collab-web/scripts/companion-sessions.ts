/**
 * Reads omp's on-disk session store for the companion: the text of a pending
 * `ask` question or a finished turn (push notification bodies) and the folders
 * recent sessions ran in.
 *
 * A session file is JSONL: an optional fixed-size title slot
 * (`{"type":"title","title":…}`, rewritten in place on rename), the
 * `{"type":"session","id","cwd","title"?}` header, then entries. Files live in
 * `<config>/agent/sessions/<cwd-derived dir>/<timestamp>_<session id>.jsonl`.
 * Everything here reads bounded slices and fails soft: a missing or garbled file
 * yields null or an empty list, never an exception.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RecentFolder } from "../src/lib/companion";
import { isRecord } from "../src/tool-render/util";

/** Session ids, instance ids and pids: no leading dash, so they are never read as CLI flags. */
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Bytes read from the end of a session file when looking for the latest turn. */
const TAIL_BYTES = 256 * 1024;
/** Bytes read from the start of a session file for its title slot and header. */
const HEAD_BYTES = 16 * 1024;
const MAX_FOLDERS = 15;
const SESSIONS_PER_FOLDER = 5;
/** Notification body length for a finished turn. */
const SUMMARY_CHARS = 140;
/** Notification body length for a pending question. */
const QUESTION_CHARS = 200;

type Entry = Record<string, unknown>;

function parseLines(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) entries.push(parsed);
		} catch {
			// partial or foreign line
		}
	}
	return entries;
}

/** Complete JSONL entries from the last `TAIL_BYTES` of a file (the cut first line is dropped). */
async function readTail(file: string): Promise<Entry[]> {
	const handle = Bun.file(file);
	const size = handle.size;
	const start = Math.max(0, size - TAIL_BYTES);
	let text = await handle.slice(start, size).text();
	if (start > 0) text = text.slice(text.indexOf("\n") + 1);
	return parseLines(text);
}

async function readHead(file: string): Promise<Entry[]> {
	return parseLines(await Bun.file(file).slice(0, HEAD_BYTES).text());
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = [...flat];
	return chars.length > max
		? `${chars
				.slice(0, max - 1)
				.join("")
				.trimEnd()}…`
		: flat;
}

function messageOf(entry: Entry): Entry | null {
	return entry.type === "message" && isRecord(entry.message) ? entry.message : null;
}

function blocksOf(message: Entry): Entry[] {
	return Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

/**
 * Text of the question the latest assistant `ask` tool call is waiting on, or
 * null when the latest call already has a result (or there is none).
 */
export function pendingQuestion(entries: Entry[]): string | null {
	const answered: Record<string, true> = {};
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = messageOf(entries[i]!);
		if (!message) continue;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			answered[message.toolCallId] = true;
			continue;
		}
		if (message.role !== "assistant") continue;
		const calls = blocksOf(message).filter(b => b.type === "toolCall" && b.name === "ask");
		const call = calls[calls.length - 1];
		if (!call) continue;
		if (typeof call.id === "string" && answered[call.id]) return null;
		const args = isRecord(call.arguments) ? call.arguments : {};
		const questions = Array.isArray(args.questions) ? args.questions.filter(isRecord) : [];
		const first = typeof questions[0]?.question === "string" ? questions[0].question : null;
		if (!first || !first.trim()) return null;
		const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
		return `${truncate(first, QUESTION_CHARS)}${more}`;
	}
	return null;
}

/** First ~140 characters of the latest assistant text after the last user message, or null. */
export function lastAssistantSummary(entries: Entry[]): string | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = messageOf(entries[i]!);
		if (!message) continue;
		if (message.role === "user") return null;
		if (message.role !== "assistant") continue;
		const text = blocksOf(message)
			.filter(b => b.type === "text" && typeof b.text === "string")
			.map(b => b.text as string)
			.join("\n");
		if (text.trim()) return truncate(text, SUMMARY_CHARS);
	}
	return null;
}

/** Session file path per session id; stable once a session exists. */
const sessionFiles = new Map<string, string>();

async function findSessionFile(sessionsDir: string, sessionId: string): Promise<string | null> {
	if (!SAFE_ID_RE.test(sessionId)) return null;
	const cached = sessionFiles.get(sessionId);
	if (cached && (await Bun.file(cached).exists())) return cached;
	sessionFiles.delete(sessionId);
	const glob = new Bun.Glob(`*/*_${sessionId}.jsonl`);
	for await (const file of glob.scan({ cwd: sessionsDir, absolute: true })) {
		sessionFiles.set(sessionId, file);
		return file;
	}
	return null;
}

/** Entries from the tail of a session's file, or [] when it cannot be found or read. */
export async function readSessionTail(sessionsDir: string, sessionId: string): Promise<Entry[]> {
	try {
		const file = await findSessionFile(sessionsDir, sessionId);
		return file ? await readTail(file) : [];
	} catch {
		return [];
	}
}

interface SessionHead {
	id: string;
	cwd: string;
	title: string | null;
}

/** Id, cwd and current title of a session file; null when the header is unreadable. */
async function readSessionHead(file: string): Promise<SessionHead | null> {
	const head = await readHead(file);
	const header = head.find(e => e.type === "session");
	if (!header || typeof header.id !== "string" || !SAFE_ID_RE.test(header.id) || typeof header.cwd !== "string")
		return null;
	const slot = head.find(e => e.type === "title");
	let title: string | null = null;
	if (slot) {
		if (typeof slot.title === "string") title = slot.title;
	} else {
		// Files from before the title slot: the name lives in the header, renames in later `title_change` entries.
		if (typeof header.title === "string") title = header.title;
		for (const entry of (await readTail(file)).reverse()) {
			if (entry.type === "title_change" && typeof entry.title === "string") {
				title = entry.title;
				break;
			}
		}
	}
	return { id: header.id, cwd: header.cwd, title: title?.trim() || null };
}

interface SessionFile {
	file: string;
	mtime: number;
}

async function sessionFilesOf(dir: string): Promise<SessionFile[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return [];
	}
	const stats = await Promise.all(
		names
			.filter(name => name.endsWith(".jsonl"))
			.map(async name => {
				const file = path.join(dir, name);
				try {
					return { file, mtime: Math.floor((await fs.stat(file)).mtimeMs) };
				} catch {
					return null;
				}
			}),
	);
	return stats.filter((s): s is SessionFile => s !== null).sort((a, b) => b.mtime - a.mtime);
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Folders sessions ran in, newest first: up to 15 folders with up to 5 sessions
 * each, skipping folders that no longer exist. `sessionsDir` is
 * `<config>/agent/sessions`.
 */
export async function recentFolders(sessionsDir: string): Promise<RecentFolder[]> {
	let names: string[];
	try {
		names = await fs.readdir(sessionsDir);
	} catch {
		return [];
	}
	const dirs = (
		await Promise.all(
			names.map(async name => {
				const dir = path.join(sessionsDir, name);
				const files = await sessionFilesOf(dir);
				return files.length > 0 ? { files, newest: files[0]!.mtime } : null;
			}),
		)
	)
		.filter(d => d !== null)
		.sort((a, b) => b.newest - a.newest);

	const folders = new Map<string, RecentFolder>();
	const exists = new Map<string, boolean>();
	for (const { files } of dirs) {
		if (folders.size >= MAX_FOLDERS) break;
		for (const { file, mtime } of files) {
			let head: SessionHead | null = null;
			try {
				head = await readSessionHead(file);
			} catch {
				// unreadable file
			}
			if (!head || !path.isAbsolute(head.cwd)) continue;
			let alive = exists.get(head.cwd);
			if (alive === undefined) {
				alive = await isDirectory(head.cwd);
				exists.set(head.cwd, alive);
			}
			if (!alive) continue;
			const folder = folders.get(head.cwd) ?? { cwd: head.cwd, lastActive: mtime, sessions: [] };
			if (folder.sessions.length >= SESSIONS_PER_FOLDER) continue;
			folder.sessions.push({ id: head.id, title: head.title, lastActive: mtime });
			folder.lastActive = Math.max(folder.lastActive, mtime);
			folders.set(head.cwd, folder);
			if (folder.sessions.length >= SESSIONS_PER_FOLDER) break;
		}
	}
	return [...folders.values()]
		.map(f => ({ ...f, sessions: f.sessions.sort((a, b) => b.lastActive - a.lastActive) }))
		.sort((a, b) => b.lastActive - a.lastActive)
		.slice(0, MAX_FOLDERS);
}
