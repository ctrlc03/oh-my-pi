/**
 * Which omp sessions changed a file, for the `file-sessions` request: the recent sessions that ran inside the
 * file's repository are streamed line by line for a successful `edit`, `apply_patch` or `write` call on it.
 * The scan is bounded (recent sessions only, a byte cap per file, a deadline) and stops at a file's first hit.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSummary } from "@oh-my-pi/omp-stats/shared-types";
import { inputPaths, isRecord, str } from "../src/tool-render/util";
import { isInside, repoRoot } from "./companion-git";
import { readSessionHead, recentSessionFiles, type SessionHead } from "./companion-sessions";

/** Session files whose header is read to find those that ran inside the repository. */
const HEADER_SCAN_FILES = 300;
/** Sessions of the repository whose files are scanned for edits. */
const SCAN_SESSIONS = 40;
const MAX_RESULTS = 20;
/** Files scanned at once. */
const SCAN_CONCURRENCY = 4;
/** Bytes of one session file scanned before giving up on it. */
const MAX_FILE_BYTES = 128 * 1024 * 1024;
/** Sessions not scanned by this time are left out. */
const DEADLINE_MS = 10_000;
const MAX_PATH_CHARS = 4096;
const EDIT_TOOLS: Record<string, true> = { edit: true, apply_patch: true, write: true };

export interface FoundSession {
	sessionId: string;
	title: string | null;
	/** The session's working directory. */
	folder: string;
	file: string;
	startedAt: number;
	/** File modification time: when the session last wrote. */
	lastActive: number;
}

/** A path inside the repository containing `cwd`: its root, absolute form and root-relative form. */
export interface RepoPath {
	root: string;
	abs: string;
	rel: string;
}

/**
 * Resolve a device-supplied path (absolute, or relative to the repository root) inside the repository containing
 * `cwd` (`cwd` itself outside a repository).
 * @throws Error when the path is invalid or outside the repository.
 */
export async function resolveInRepo(cwd: string, value: unknown): Promise<RepoPath> {
	if (typeof value !== "string" || value === "" || value.length > MAX_PATH_CHARS || value.includes("\0")) {
		throw new Error("invalid path");
	}
	const root = (await repoRoot(cwd)) ?? (await fs.realpath(cwd));
	let abs = path.resolve(root, value);
	// The path may reach the repository through a symlink (the session's folder, or a linked directory).
	if (!isInside(root, abs)) abs = await fs.realpath(abs).catch(() => abs);
	if (!isInside(root, abs)) throw new Error("path is outside the repository");
	return { root, abs, rel: path.relative(root, abs).split(path.sep).join("/") };
}

/**
 * A code map focus as a device sent it, with an absolute path made repository-relative so the app may pass a path
 * as a tool call showed it (a file focus on a folder becomes a folder focus). Anything else is returned untouched
 * for `checkFocus` to judge.
 */
export async function repoRelativeFocus(cwd: string, focus: unknown): Promise<unknown> {
	if (!isRecord(focus) || typeof focus.path !== "string") return focus;
	if (!path.isAbsolute(focus.path)) return focus;
	const { abs, rel } = await resolveInRepo(cwd, focus.path);
	// A tool card may name a folder (a listing, a search scope): map the folder.
	const folder =
		focus.kind === "file" &&
		(await fs.stat(abs).then(
			s => s.isDirectory(),
			() => false,
		));
	return folder ? { kind: "dir", path: rel } : { ...focus, path: rel };
}

/** Tool-call paths (as written) of an edit or write call. */
function callPaths(name: string, args: Record<string, unknown>): string[] {
	const paths: string[] = [];
	const input = str(args.input) ?? str(args._input);
	if (input) paths.push(...inputPaths(input));
	const named = str(args.file_path) ?? str(args.path);
	if (named) paths.push(named);
	if (name !== "write" && Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			const editPath = isRecord(edit) ? str(edit.path) : null;
			if (editPath) paths.push(editPath);
		}
	}
	return paths;
}

/** Lines of a file, streamed; stops after about `maxBytes`. */
async function* fileLines(file: string, maxBytes: number): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let rest = "";
	let read = 0;
	for await (const chunk of Bun.file(file).stream()) {
		read += chunk.byteLength;
		rest += decoder.decode(chunk, { stream: true });
		let start = 0;
		for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n", start)) {
			yield rest.slice(start, end);
			start = end + 1;
		}
		rest = rest.slice(start);
		if (read >= maxBytes) return;
	}
	rest += decoder.decode();
	if (rest) yield rest;
}

/**
 * True when the session whose lines these are successfully edited or wrote `target` (absolute, symlink-resolved).
 * `cwd` is the session's working directory as its header spells it, `realCwd` the same with symlinks resolved.
 */
export async function editsFile(
	lines: AsyncIterable<string>,
	target: string,
	cwd: string,
	realCwd: string,
): Promise<boolean> {
	const needle = path.basename(target);
	/** Ids of matching calls waiting for their result. */
	const pending = new Set<string>();
	const resolves = (p: string): boolean => {
		let abs = path.resolve(cwd, p);
		if (realCwd !== cwd && isInside(cwd, abs)) abs = path.join(realCwd, path.relative(cwd, abs));
		return abs === target;
	};
	for await (const line of lines) {
		if (line.includes('"toolCall"') && line.includes(needle)) {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const message = isRecord(entry) && isRecord(entry.message) ? entry.message : null;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
				const name = str(block.name) ?? "";
				if (EDIT_TOOLS[name] !== true || !isRecord(block.arguments)) continue;
				if (callPaths(name, block.arguments).some(resolves)) pending.add(block.id);
			}
		} else if (pending.size > 0 && line.includes('"toolResult"')) {
			const id = [...pending].find(candidate => line.includes(candidate));
			if (id === undefined) continue;
			try {
				const entry: unknown = JSON.parse(line);
				const message = isRecord(entry) && isRecord(entry.message) ? entry.message : null;
				if (message?.toolCallId === id) {
					if (message.isError !== true) return true;
					pending.delete(id);
				}
			} catch {
				// Unreadable line: its call stays pending.
			}
		}
	}
	return false;
}

export interface FileSessionsOptions {
	sessionsDir: string;
	/** Working directory of the session the request names; its repository is searched. */
	cwd: string;
	/** Absolute, or relative to the repository root. */
	path: unknown;
}

/** Sessions of the file's repository that changed it, newest activity first. */
export async function findFileSessions(options: FileSessionsOptions): Promise<FoundSession[]> {
	const { root, abs, rel } = await resolveInRepo(options.cwd, options.path);
	if (rel === "") throw new Error("not a file");
	const deadline = Date.now() + DEADLINE_MS;

	const candidates: { found: FoundSession; cwd: string; realCwd: string }[] = [];
	const realCwds = new Map<string, string>();
	for (const { file, mtime } of await recentSessionFiles(options.sessionsDir, HEADER_SCAN_FILES)) {
		if (candidates.length >= SCAN_SESSIONS) break;
		let head: SessionHead | null;
		try {
			head = await readSessionHead(file);
		} catch {
			continue;
		}
		if (!head || !path.isAbsolute(head.cwd)) continue;
		const sessionCwd = head.cwd;
		let realCwd = realCwds.get(sessionCwd);
		if (realCwd === undefined) {
			realCwd = await fs.realpath(sessionCwd).catch(() => sessionCwd);
			realCwds.set(sessionCwd, realCwd);
		}
		if (!isInside(root, realCwd)) continue;
		candidates.push({
			found: {
				sessionId: head.id,
				title: head.title,
				folder: head.cwd,
				file,
				startedAt: head.startedAt || mtime,
				lastActive: mtime,
			},
			cwd: head.cwd,
			realCwd,
		});
	}

	const hits: FoundSession[] = [];
	for (let i = 0; i < candidates.length && hits.length < MAX_RESULTS && Date.now() < deadline; i += SCAN_CONCURRENCY) {
		const batch = candidates.slice(i, i + SCAN_CONCURRENCY);
		const edited = await Promise.all(
			batch.map(candidate =>
				editsFile(fileLines(candidate.found.file, MAX_FILE_BYTES), abs, candidate.cwd, candidate.realCwd).catch(
					() => false,
				),
			),
		);
		batch.forEach((candidate, j) => {
			if (edited[j]) hits.push(candidate.found);
		});
	}
	return hits.slice(0, MAX_RESULTS);
}

/** A stats-database row for a session the database does not hold yet: no totals, only what the file header says. */
export function unmeasuredSummary(found: FoundSession): SessionSummary {
	return {
		file: found.file,
		folder: found.folder,
		title: found.title,
		startedAt: found.startedAt,
		endedAt: found.lastActive,
		requests: 0,
		toolCalls: 0,
		subagents: 0,
		totalTokens: 0,
		costTotal: 0,
		unpricedRequests: 0,
		models: [],
	};
}
