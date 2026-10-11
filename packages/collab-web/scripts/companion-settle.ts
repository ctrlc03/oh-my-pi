/**
 * Cleanup of a worktree when its session settles: the companion's "when a worktree session settles,
 * run" command, or a repository's approved `.omp/worktree-settle`, run in the tree (see
 * ./companion-worktrees `runWorktreeSettle`). Which sessions settled is decided by the organiser
 * (./companion-sessionorg `settleTransitions`: once per transition); this module decides whether
 * the session's folder is a worktree the companion made, runs the command without ever blocking the
 * settle, and keeps the latest result per worktree (bounded) for the app to show.
 *
 * A sandboxed session is confined to file tools precisely so it cannot run code, but it can write the
 * files a cleanup command runs (package.json scripts, a Makefile, a .npmrc). So nothing runs in a worktree
 * a sandboxed session ever worked in (a sticky mark made when the companion starts one) or that a listed
 * sandboxed session works in or above; such a settle records "skipped". A session is located only through
 * what the companion recorded when it started or resumed it, or through the open-sessions listing;
 * never through a session file, which a sandboxed session can rewrite.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SettleCleanupResult } from "../src/lib/companion";
import { git, isInside, repoRoot } from "./companion-git";
import { gitDirs } from "./companion-gitflow";
import type { SettledSession } from "./companion-sessionorg";
import { SAFE_ID_RE } from "./companion-sessions";
import { type GitFlowFile, readProjectSettle, runWorktreeSettle } from "./companion-worktrees";

/** Latest results kept, one per worktree; the oldest go first. */
const MAX_RESULTS = 50;
/** Sessions whose worktree is remembered; forgetting one only means its settle runs no cleanup. */
const MAX_SESSIONS = 500;
/** Folders sandboxed sessions were started in (near a worktree folder) that are remembered. */
const MAX_SANDBOXED = 2000;
/** Cleanup commands running at once for one batch of settled sessions. */
const CONCURRENCY = 3;

/** What the companion remembers across restarts. */
export interface SettleState {
	/** Latest result per worktree, newest first. */
	results: SettleCleanupResult[];
	/** Session id to the worktree (symlinks resolved) the companion started or resumed it in; the only record that locates an ended session. */
	sessions: Record<string, string>;
	/** Folders (symlinks resolved) the companion started sandboxed sessions in, near a worktree folder: a worktree inside or above one is never cleaned. Never downgraded. */
	sandboxed: string[];
}

const RESULT_STATUSES = ["ok", "failed", "timeout", "skipped"];

function parseResult(raw: unknown): SettleCleanupResult | null {
	const r = raw as Record<string, unknown> | null;
	if (typeof r !== "object" || r === null) return null;
	if (
		typeof r.path !== "string" ||
		typeof r.branch !== "string" ||
		typeof r.sessionId !== "string" ||
		(r.source !== "settings" && r.source !== "project") ||
		typeof r.status !== "string" ||
		!RESULT_STATUSES.includes(r.status) ||
		(r.code !== null && typeof r.code !== "number") ||
		typeof r.startedAt !== "number" ||
		typeof r.durationMs !== "number" ||
		typeof r.output !== "string"
	)
		return null;
	return {
		path: r.path,
		branch: r.branch,
		sessionId: r.sessionId,
		source: r.source,
		status: r.status as SettleCleanupResult["status"],
		code: r.code,
		startedAt: r.startedAt,
		durationMs: r.durationMs,
		output: r.output,
	};
}

export function parseSettleState(raw: unknown): SettleState {
	const file = raw as { results?: unknown; sessions?: unknown; sandboxed?: unknown } | null;
	const results = Array.isArray(file?.results) ? file.results.flatMap(r => parseResult(r) ?? []) : [];
	const sessions: [string, string][] =
		typeof file?.sessions === "object" && file.sessions !== null
			? Object.entries(file.sessions).flatMap(([id, folder]) =>
					SAFE_ID_RE.test(id) && typeof folder === "string" && path.isAbsolute(folder) ? [[id, folder]] : [],
				)
			: [];
	const sandboxed = Array.isArray(file?.sandboxed)
		? file.sandboxed.filter((folder): folder is string => typeof folder === "string" && path.isAbsolute(folder))
		: [];
	return {
		results: results.slice(0, MAX_RESULTS),
		sessions: Object.fromEntries(sessions.slice(-MAX_SESSIONS)),
		sandboxed: sandboxed.slice(-MAX_SANDBOXED),
	};
}

export async function loadSettleState(file: string): Promise<SettleState> {
	try {
		return parseSettleState(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { results: [], sessions: {}, sandboxed: [] };
	}
}

export async function saveSettleState(file: string, contents: SettleState): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

/** The linked worktree `cwd` is in, when it is one under `dirs` (`<dir>/<repo>/<name>`); null for a main checkout or any other folder. */
export async function companionWorktree(
	cwd: string,
	dirs: readonly string[],
): Promise<{ root: string; path: string; branch: string } | null> {
	let top: string | null;
	try {
		top = await repoRoot(await fs.realpath(cwd));
	} catch {
		return null;
	}
	if (top === null) return null;
	const bases = await Promise.all(dirs.map(dir => fs.realpath(dir).catch(() => null)));
	const under = bases.some(
		base => base !== null && isInside(base, top) && path.relative(base, top).split(path.sep).length === 2,
	);
	if (!under) return null;
	const { gitDir, commonDir } = await gitDirs(top);
	if (gitDir === commonDir) return null;
	const head = await git(top, ["symbolic-ref", "--short", "-q", "HEAD"]);
	return {
		root: path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir,
		path: top,
		branch: new TextDecoder().decode(head.out).trim(),
	};
}

/** An open session, from one fresh listing. */
export interface ListedSession {
	sessionId: string;
	cwd: string;
	/** Started sandboxed: file tools only. */
	sandboxed: boolean;
}

export interface SettleCleanupOptions {
	initial: SettleState;
	save(state: SettleState): Promise<void>;
	/** The git flow file as it is now: the command and the user's approvals. */
	flow(): GitFlowFile;
	/** Every folder worktrees may live under. */
	dirs(): string[];
	/** The sessions open now; asked once per {@link SettleCleanup.run}. */
	listing(): Promise<readonly ListedSession[]>;
	/** A repository has a `.omp/worktree-settle` that was not run because the user has not approved it. */
	onUnapproved(root: string): void;
	onError(err: unknown): void;
	timeoutMs?: number;
}

export interface SettleCleanup {
	/** Clean up after sessions that settled; resolves when every command ended (the settle itself never waits for it). */
	run(sessions: readonly SettledSession[]): Promise<void>;
	/** The companion started or resumed this session in `folder`: remember its worktree, the only way an ended session is located. */
	recordSession(sessionId: string, folder: string): Promise<void>;
	/** The companion is about to start a sandboxed session in `folder`: no worktree inside or above it is ever cleaned again. */
	recordSandboxed(folder: string): Promise<void>;
	/** The latest result of each worktree that still exists, newest first. */
	results(): Promise<SettleCleanupResult[]>;
}

/** True when one folder is the other or lies beneath it. */
const related = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

export function createSettleCleanup(options: SettleCleanupOptions): SettleCleanup {
	let state = options.initial;
	let saving: Promise<void> = Promise.resolve();
	/** Worktrees a command is running in. */
	const running = new Set<string>();

	const persist = (): Promise<void> => {
		const snapshot = state;
		saving = saving.catch(() => {}).then(() => options.save(snapshot));
		return saving;
	};

	const record = (
		tree: { path: string; branch: string },
		session: SettledSession,
		outcome: Omit<SettleCleanupResult, "path" | "branch" | "sessionId">,
	): Promise<void> => {
		const result: SettleCleanupResult = {
			path: tree.path,
			branch: tree.branch,
			sessionId: session.sessionId,
			...outcome,
		};
		state = { ...state, results: [result, ...state.results.filter(r => r.path !== tree.path)].slice(0, MAX_RESULTS) };
		return persist();
	};

	/** Where the session works: the folder the companion started it in, else (open now) its listed folder; null when unknown. */
	const locate = (sessionId: string, listed: readonly ListedSession[]): string | null => {
		if (Object.hasOwn(state.sessions, sessionId)) return state.sessions[sessionId];
		return listed.find(session => session.sessionId === sessionId)?.cwd ?? null;
	};

	const clean = async (
		session: SettledSession,
		listed: readonly ListedSession[],
		sandboxedNow: readonly string[],
	): Promise<void> => {
		const flow = options.flow();
		const folder = locate(session.sessionId, listed);
		if (folder === null) return;
		const tree = await companionWorktree(folder, options.dirs());
		if (tree === null || running.has(tree.path)) return;
		const command = flow.settings.settleScript;
		// A sandboxed agent has no way to run code, but it can write anything a cleanup would run: package.json scripts,
		// a Makefile, a .npmrc. So a tree one ever worked in (or whose folder one works above) is not cleaned at all.
		if (state.sandboxed.concat(sandboxedNow).some(sandboxed => related(sandboxed, tree.path))) {
			const project = command === "" ? await readProjectSettle(tree.root) : null;
			if (command !== "" || project !== null)
				await record(tree, session, {
					source: command !== "" ? "settings" : "project",
					status: "skipped",
					code: null,
					startedAt: Date.now(),
					durationMs: 0,
					output: "skipped: a sandboxed session worked here",
				});
			return;
		}
		running.add(tree.path);
		try {
			const { outcome, unapproved } = await runWorktreeSettle(tree, {
				command,
				trusted: flow.trustedSettles,
				timeoutMs: options.timeoutMs,
			});
			if (unapproved) options.onUnapproved(unapproved.root);
			if (outcome) await record(tree, session, outcome);
		} finally {
			running.delete(tree.path);
		}
	};

	return {
		async run(sessions) {
			if (sessions.length === 0) return;
			// One listing for the whole batch, and at most a few commands at a time: a rule can settle many sessions at once.
			const listed = await options.listing();
			const sandboxedNow = await Promise.all(
				listed
					.filter(session => session.sandboxed)
					.map(session => fs.realpath(session.cwd).catch(() => session.cwd)),
			);
			const queue = [...sessions];
			const worker = async (): Promise<void> => {
				for (let next = queue.shift(); next !== undefined; next = queue.shift())
					await clean(next, listed, sandboxedNow).catch(err => options.onError(err));
			};
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
		},
		async recordSession(sessionId, folder) {
			const tree = await companionWorktree(folder, options.dirs());
			if (tree === null) return;
			const others = Object.entries(state.sessions).filter(([id]) => id !== sessionId);
			state = { ...state, sessions: Object.fromEntries([...others, [sessionId, tree.path]].slice(-MAX_SESSIONS)) };
			await persist();
		},
		async recordSandboxed(folder) {
			const resolved = await fs.realpath(folder);
			const bases = await Promise.all(options.dirs().map(dir => fs.realpath(dir).catch(() => null)));
			// Only folders that could hold or cover a worktree matter; any other sandboxed start is nothing to remember.
			if (!bases.some(base => base !== null && related(base, resolved))) return;
			const alive = await Promise.all(
				state.sandboxed.map(known =>
					fs.stat(known).then(
						() => true,
						() => false,
					),
				),
			);
			const kept = state.sandboxed.filter((known, i) => alive[i] && known !== resolved);
			state = { ...state, sandboxed: [...kept, resolved].slice(-MAX_SANDBOXED) };
			await persist();
		},
		async results() {
			const alive = await Promise.all(
				state.results.map(r =>
					fs.stat(r.path).then(
						() => true,
						() => false,
					),
				),
			);
			return state.results.filter((_, i) => alive[i]);
		},
	};
}
