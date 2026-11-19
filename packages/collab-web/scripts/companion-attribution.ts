/**
 * Line attribution for the editor and the diffs (`file-attribution`): which lines of a file an agent wrote, and in
 * which session, turn and model. The sessions that ran inside the file's worktree are read for their successful edits
 * of the file (the scan the review board's notes use, ./companion-review-edits), and the pure replay in
 * ./companion-attribution-lines lays those edits over the file as it is on disk. Everything stays on the computer:
 * the answer is derived from the session files and the working tree, nothing is written anywhere.
 *
 * The answer is numbered for one version of the file (`version`, as `file` reports it): an editor that holds another
 * version asks again instead of marking the wrong lines. Reading a session file is the cost, so what a session file
 * held for a path is remembered while the file is unchanged, and the list of a worktree's sessions for a few seconds.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AttributionRange, AttributionRef, FileAttribution } from "../src/lib/line-attribution";
import { type AttributionEdit, attributeLines } from "./companion-attribution-lines";
import { type RepoSession, repoSessions } from "./companion-file-sessions";
import { checkPathText, FILE_BYTES, fileVersion, hasNul, repoScope, resolveInScope } from "./companion-git";
import type { SessionEdit } from "./companion-review-edits";
import { scanWithSubagents } from "./companion-review-notes";

/** Sessions not read by this time are left out; what was read is remembered, so the next request goes on from there. */
const SCAN_DEADLINE_MS = 15_000;
const SCAN_CONCURRENCY = 4;
/** Edits replayed per file: the latest ones, which are the ones whose lines can still be in the file. */
const MAX_EDITS = 500;
/** What a worktree's session list is trusted for. */
const SESSIONS_TTL_MS = 10_000;
/** Remembered reads of a session file for a path. */
const MAX_REMEMBERED_SCANS = 300;

export interface AttributionOptions {
	sessionsDir: string;
	/** Further session folders searched alongside (the Personal profile's). */
	extraSessionsDirs?: readonly string[];
	/** Working directory of the session the request names: its repository's checkout is the worktree searched. */
	cwd: string;
	/** Absolute, or relative to the session's working directory, like `file`. */
	path: unknown;
}

const decoder = new TextDecoder();

/** Edits found in a session file for a path, by the file's name, modification time and the path. */
const scans = new Map<string, SessionEdit[]>();
const sessionLists = new Map<string, { at: number; sessions: Promise<RepoSession[]> }>();
const inFlight = new Map<string, Promise<FileAttribution>>();

function remember(key: string, edits: SessionEdit[]): void {
	scans.delete(key);
	scans.set(key, edits);
	for (const oldest of scans.keys()) {
		if (scans.size <= MAX_REMEMBERED_SCANS) break;
		scans.delete(oldest);
	}
}

/** The worktree's sessions, listed once per {@link SESSIONS_TTL_MS}: opening several files in a row lists them once. */
function sessionsOf(options: AttributionOptions, root: string): Promise<RepoSession[]> {
	const found = sessionLists.get(root);
	if (found !== undefined && Date.now() - found.at < SESSIONS_TTL_MS) return found.sessions;
	const sessions = repoSessions(options, [root]);
	sessionLists.set(root, { at: Date.now(), sessions });
	// A failed listing is not kept: the next request lists again.
	sessions.catch(() => sessionLists.delete(root));
	return sessions;
}

/** The edits of the worktree's sessions to `rel`, oldest first. */
async function editsOf(options: AttributionOptions, root: string, rel: string): Promise<SessionEdit[]> {
	const candidates = await sessionsOf(options, root);
	const deadline = Date.now() + SCAN_DEADLINE_MS;
	const edits: SessionEdit[] = [];
	for (let i = 0; i < candidates.length && Date.now() < deadline; i += SCAN_CONCURRENCY) {
		const found = await Promise.all(
			candidates.slice(i, i + SCAN_CONCURRENCY).map(async candidate => {
				const key = `${candidate.found.file}\0${candidate.found.lastActive}\0${rel}`;
				const known = scans.get(key);
				if (known !== undefined) return known;
				try {
					const scanned = await scanWithSubagents(candidate.found.file, {
						sessionId: candidate.found.sessionId,
						sessionTitle: candidate.found.title,
						cwd: candidate.cwd,
						realCwd: candidate.realCwd,
						roots: [root],
						files: new Map([[rel, rel]]),
					});
					remember(key, scanned);
					return scanned;
				} catch {
					// A session file that cannot be read says nothing; the others still do.
					return [];
				}
			}),
		);
		for (const list of found) edits.push(...list);
	}
	// Chronological order across sessions is the order the file changed in; a stable sort keeps a session's own order.
	return edits
		.filter(edit => edit.changes !== undefined)
		.sort((a, b) => a.at - b.at)
		.slice(-MAX_EDITS);
}

/** Who wrote an edit's lines: its session's turn. */
function writerKey(edit: SessionEdit): string {
	return `${edit.sessionId}\0${edit.turnId === "" ? `turn-${edit.turn}` : edit.turnId}`;
}

/**
 * The attribution of `text` (a file's lines) by `edits`, oldest first, with the refs the ranges point at: one per turn,
 * carrying the latest edit's time and model.
 */
export function attribute(
	text: readonly string[],
	edits: readonly SessionEdit[],
): { refs: AttributionRef[]; ranges: AttributionRange[] } {
	const replayed: AttributionEdit[] = edits.map(edit => ({
		key: writerKey(edit),
		changes: edit.changes ?? [],
		...(edit.rewrite ? { rewrite: true } : {}),
	}));
	const refs: AttributionRef[] = [];
	const refOf = new Map<string, number>();
	const ranges: AttributionRange[] = [];
	for (const range of attributeLines(text, replayed)) {
		let index = refOf.get(range.key);
		if (index === undefined) {
			const turnEdits = edits.filter(edit => writerKey(edit) === range.key);
			const latest = turnEdits.at(-1)!;
			index = refs.length;
			refOf.set(range.key, index);
			refs.push({
				sessionId: latest.sessionId,
				sessionTitle: latest.sessionTitle,
				turn: latest.turn,
				prompt: turnEdits.find(edit => edit.prompt)?.prompt ?? "",
				model: turnEdits.findLast(edit => edit.model)?.model ?? null,
				at: Math.max(...turnEdits.map(edit => edit.at)),
			});
		}
		ranges.push({ start: range.start, end: range.end, ref: index });
	}
	return { refs, ranges };
}

async function compute(options: AttributionOptions, real: string, root: string, rel: string): Promise<FileAttribution> {
	const stat = await fs.stat(real);
	if (!stat.isFile()) throw new Error("not a regular file");
	const bytes = await Bun.file(real).slice(0, FILE_BYTES).bytes();
	// A binary or cut-off file is not edited as text: there are no lines to mark.
	if (hasNul(bytes) || stat.size > FILE_BYTES) return { path: rel, version: null, refs: [], ranges: [] };
	const version = fileVersion(stat, bytes);
	const edits = await editsOf(options, root, rel);
	if (edits.length === 0) return { path: rel, version, refs: [], ranges: [] };
	return { path: rel, version, ...attribute(decoder.decode(bytes).split("\n"), edits) };
}

/**
 * Which lines of a file in the session's checkout agents wrote and the file still has as written. Paths follow the
 * `file` request's rules (confined to the repository root, or to the working directory outside a repository); the
 * sessions read are those that ran inside that checkout.
 * @throws Error when the path is invalid, outside the repository, missing or not a regular file.
 */
export async function fileAttribution(options: AttributionOptions): Promise<FileAttribution> {
	if (typeof options.path !== "string") throw new Error("invalid path");
	checkPathText(options.path);
	const scope = await repoScope(options.cwd);
	const real = await resolveInScope(options.cwd, scope, options.path);
	if (real === null) throw new Error("file not found");
	const rel = path.relative(scope.base, real).split(path.sep).join("/");
	if (rel === "") throw new Error("not a file");
	// Requests for one file made together (the editor and a diff open on it) share the work.
	const key = `${scope.base}\0${rel}`;
	const running = inFlight.get(key);
	if (running !== undefined) return running;
	const started = compute(options, real, scope.base, rel).finally(() => inFlight.delete(key));
	inFlight.set(key, started);
	return started;
}
