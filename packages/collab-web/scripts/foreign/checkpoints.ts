/**
 * Vendor-neutral working-tree checkpoints for foreign agent sessions: one git snapshot per turn, so the
 * app's per-turn and per-session diffs and its "restore files" work for agents that keep no snapshots of
 * their own (omp does, in `coding-agent/src/session/file-snapshots.ts`; the replies here match its
 * `turn-diff` / `session-diff` ones, with the same file, size and truncation limits).
 *
 * A checkpoint is a commit holding the working tree (tracked files plus untracked files that are not
 * ignored), kept under the hidden ref `refs/omp-checkpoints/<sessionId>/<turn>`. It is built without
 * touching the user's repository state: file contents are read by this module (see `readCovered`), copied
 * into a private temp dir and hashed raw (`hash-object --no-filters`, so `.gitattributes` filters and
 * line-ending conversion never run) into the object database, entered into a private index in that temp
 * dir (`GIT_INDEX_FILE`), and turned into a tree and a parentless commit. The user's index, HEAD,
 * branches, stash, reflog and config are never written; the only writes to the repository are new objects
 * and refs under `refs/omp-checkpoints/`. Hooks cannot run (no porcelain is used, and `core.hooksPath` is
 * pointed at nothing besides), and every git call is an argv array with a timeout.
 *
 * The agent can write to the session folder while this runs unsandboxed, so nothing it can plant may steer
 * git. The repository is found once per folder and pinned (`repoOf`); every call then names `--git-dir` and
 * `--work-tree` and sets `safe.bareRepository=explicit`, and a git dir inside the session folder (other than
 * the checkout's own `.git`) is refused. File bytes are read through `O_NOFOLLOW`, checked against the
 * `lstat` that chose the file, and dropped if the file or its directory changed; git never opens a path in
 * the working tree.
 *
 * The files a checkpoint covers are the ones `git status` would show: `ls-files --cached --others
 * --exclude-standard` (so every ignore rule applies), minus files over {@link CHECKPOINT_MAX_FILE_BYTES},
 * directories (submodules, nested repositories) and special files. Restoring
 * therefore never touches an ignored or oversized file. A repository with too many files or bytes is not
 * checkpointed.
 *
 * Linked worktrees work: the working tree is the one `cwd` is in, and the refs live in the repository's
 * shared ref store, namespaced by session id.
 */

import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RewindFilesPlan, TurnDiffFile } from "@oh-my-pi/pi-wire";

/** Files above this size are left out of checkpoints and never restored or deleted. */
export const CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A repository with more candidate files than this is not checkpointed. */
export const CHECKPOINT_MAX_FILES = 50_000;
/** A repository whose covered files add up to more than this is not checkpointed. */
export const CHECKPOINT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** Files listed per diff; the rest are counted in `omitted`. */
export const TURN_DIFF_MAX_FILES = 2000;
/** One file's diff text is cut at this size. */
export const TURN_DIFF_MAX_FILE_CHARS = 64 * 1024;
/** Diff text across all files; files past it are listed without their diff. */
export const TURN_DIFF_MAX_TOTAL_CHARS = 1024 * 1024;

const GIT_TIMEOUT_MS = 120_000;
/** Longest `ls-files` listing read: far more than {@link CHECKPOINT_MAX_FILES} ordinary paths. */
const LISTING_MAX_BYTES = 32 * 1024 * 1024;
/** Patch text read per diff; files past it are listed without their diff. */
const PATCH_MAX_BYTES = 8 * 1024 * 1024;
/** Blob bytes read from git per restore batch. */
const BLOB_BATCH_BYTES = 32 * 1024 * 1024;
const LSTAT_BATCH = 128;
/** Verified file bytes held (and copied for hashing) at a time. */
const HASH_BATCH_BYTES = 32 * 1024 * 1024;
const CAPTURE_ATTEMPTS = 3;
const REF_PREFIX = "refs/omp-checkpoints";
const BACKUP_NAME = "before-restore";
/** Same rule as the companion's session ids: no leading dash, and nothing that is special in a ref name. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TURN = 999_999_999;

const decoder = new TextDecoder();

/** A refusal or git failure whose message is safe to show a user. */
export class CheckpointError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CheckpointError";
	}
}

/** The repository is over a size cap; retrying will not help. */
class CheckpointLimitError extends CheckpointError {}

/** The `turn-diff` frame body: the host adds `t`, `scope` and `entryId`. */
export interface TurnDiffReply {
	/** Null when there is nothing to compare (`reason` says why). */
	files: TurnDiffFile[] | null;
	spansTurns?: number;
	/** Changed files past {@link TURN_DIFF_MAX_FILES}, not in `files`. */
	omitted?: number;
	reason?: string;
}

export interface RestoreResult {
	plan: RewindFilesPlan;
	/** Files left alone because something the checkpoint does not cover is in the way. */
	skipped: number;
}

export interface DiffOptions {
	/** The session's newest turn, so a diff that ends at the working tree reports how many turns it spans. */
	latestTurn?: number;
}

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) throw new CheckpointError("invalid session id");
}

function assertTurn(turn: number): void {
	if (!Number.isSafeInteger(turn) || turn < 0 || turn > MAX_TURN) throw new CheckpointError("invalid turn");
}

function refFor(sessionId: string, turn: number | typeof BACKUP_NAME): string {
	return `${REF_PREFIX}/${sessionId}/${turn}`;
}

// ---------------------------------------------------------------------------
// Running git

interface GitOptions {
	input?: string | Uint8Array;
	/** Private index file, as `GIT_INDEX_FILE`. */
	index?: string;
	/** Output cap in bytes; git is stopped when it is reached. */
	maxBytes?: number;
	timeoutMs?: number;
	/** Resolve (instead of throw) when the output cap stopped git. */
	allowTruncated?: boolean;
}

interface GitRun {
	out: Buffer;
	code: number;
	err: string;
	truncated: boolean;
	timedOut: boolean;
}

function gitEnv(index: string | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		// An inherited GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE would point git at some other repository.
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_PAGER = "cat";
	env.LC_ALL = "C";
	env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "omp";
	env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "omp@localhost";
	if (index !== undefined) env.GIT_INDEX_FILE = index;
	return env;
}

/** A repository pinned for the life of the process: where git runs, and the only git dir it may use. */
interface Repo {
	/** Working tree root, symlinks resolved. */
	root: string;
	/** Absolute git dir, symlinks resolved. */
	gitDir: string;
}

/** Spawn git in `cwd` with the hardening flags every call here carries. */
async function spawnGit(cwd: string, args: string[], options: GitOptions): Promise<GitRun> {
	const { maxBytes = 64 * 1024 * 1024, timeoutMs = GIT_TIMEOUT_MS } = options;
	const input = typeof options.input === "string" ? Buffer.from(options.input) : options.input;
	const proc = Bun.spawn(
		[
			"git",
			"--no-optional-locks",
			"--literal-pathspecs",
			// Never take a bare repository found by walking up from a folder the agent can write to.
			"-c",
			"safe.bareRepository=explicit",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"-c",
			"core.quotepath=off",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{
			cwd,
			env: gitEnv(options.index),
			stdin: input ?? "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	try {
		const errText = new Response(proc.stderr).text();
		const chunks: Uint8Array[] = [];
		let total = 0;
		let truncated = false;
		for await (const chunk of proc.stdout) {
			const room = maxBytes - total;
			if (chunk.byteLength > room) {
				chunks.push(chunk.subarray(0, room));
				truncated = true;
				proc.kill("SIGKILL");
				break;
			}
			chunks.push(chunk);
			total += chunk.byteLength;
		}
		const code = await proc.exited;
		return { out: Buffer.concat(chunks), code, err: (await errText).trim(), truncated, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

/** Run git against the pinned repository: its git dir and working tree are named, never discovered. */
function runGit(repo: Repo, args: string[], options: GitOptions = {}): Promise<GitRun> {
	return spawnGit(repo.root, [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.root}`, ...args], options);
}

/** Run git and return its stdout; throws a {@link CheckpointError} on a failure, a timeout or a capped output. */
async function git(repo: Repo, args: string[], options: GitOptions = {}): Promise<Buffer> {
	const result = await runGit(repo, args, options);
	if (result.truncated && options.allowTruncated) return result.out;
	if (result.timedOut) throw new CheckpointError(`git ${args[0]} timed out`);
	if (result.truncated) throw new CheckpointError(`git ${args[0]} produced too much output`);
	if (result.code !== 0) throw new CheckpointError(result.err.split("\n")[0] || `git ${args[0]} failed`);
	return result.out;
}

function splitNul(text: string): string[] {
	const parts = text.split("\0");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

// ---------------------------------------------------------------------------
// Repository lookup and serialisation

const pinned = new Map<string, Repo>();

/**
 * The repository `cwd` belongs to, found once and then pinned for the process: later calls never
 * re-discover it, so nothing the agent plants in the folder afterwards can redirect git. Null when `cwd`
 * is not in a git working tree. Throws a {@link CheckpointError} when git would use a git dir the agent
 * could have written: one inside the session folder other than the checkout's own `.git`.
 */
async function repoOf(cwd: string): Promise<Repo | null> {
	const key = path.resolve(cwd);
	const known = pinned.get(key);
	if (known) return known;
	let folder: string;
	try {
		folder = await fs.realpath(key);
		if (!(await fs.stat(folder)).isDirectory()) return null;
	} catch {
		return null;
	}
	const found = await spawnGit(folder, ["rev-parse", "--show-toplevel", "--absolute-git-dir"], {
		maxBytes: 64 * 1024,
		timeoutMs: 15_000,
	});
	if (found.code !== 0 || found.timedOut) {
		if (/bare repository/i.test(found.err))
			throw new CheckpointError("refusing a bare repository in the session folder");
		return null;
	}
	const [top, dir] = decoder.decode(found.out).split("\n");
	if (!top || !dir) return null;
	const repo: Repo = { root: await fs.realpath(top), gitDir: await fs.realpath(dir) };
	if (isInside(folder, repo.gitDir) && repo.gitDir !== path.join(repo.root, ".git")) {
		throw new CheckpointError("refusing a git directory inside the session folder");
	}
	pinned.set(key, repo);
	return repo;
}

/**
 * Pin the repository of `cwd` now (the host calls this at start, before the agent runs), so a later
 * checkpoint can only ever use what was there. True when `cwd` is in a git working tree; throws a
 * {@link CheckpointError} when its git dir is one the agent could have planted.
 */
export async function pinRepository(cwd: string): Promise<boolean> {
	return (await repoOf(cwd)) !== null;
}

const chains = new Map<string, Promise<unknown>>();

/** Run `task` after everything already queued for `root`, so a restore never races a checkpoint or diff. */
function serial<T>(root: string, task: () => Promise<T>): Promise<T> {
	const run = (chains.get(root) ?? Promise.resolve()).then(task, task);
	const tail = run.catch(() => {});
	chains.set(root, tail);
	void tail.then(() => {
		if (chains.get(root) === tail) chains.delete(root);
	});
	return run;
}

// ---------------------------------------------------------------------------
// Capturing a tree

interface Covered {
	path: string;
	link: boolean;
	exec: boolean;
	/** The `lstat` that chose the file: what it must still be when it is read. */
	stat: Stats;
}

/** The files a checkpoint covers (see the module comment). */
async function coveredFiles(repo: Repo): Promise<Covered[]> {
	const listed = await runGit(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		maxBytes: LISTING_MAX_BYTES,
	});
	// A listing cut at the byte cap would silently drop files from the checkpoint.
	if (listed.truncated) {
		throw new CheckpointLimitError("the repository's file listing is too large; checkpoints are skipped");
	}
	if (listed.timedOut || listed.code !== 0)
		throw new CheckpointError(listed.err.split("\n")[0] || "git ls-files failed");
	const candidates = new Set(splitNul(listed.out.toString("utf8")));
	if (candidates.size > CHECKPOINT_MAX_FILES) {
		throw new CheckpointLimitError(
			`the repository has more than ${CHECKPOINT_MAX_FILES} files; checkpoints are skipped`,
		);
	}
	const paths = [...candidates];
	const covered: Covered[] = [];
	let totalBytes = 0;
	for (let start = 0; start < paths.length; start += LSTAT_BATCH) {
		const batch = paths.slice(start, start + LSTAT_BATCH);
		const stats = await Promise.all(
			batch.map(async candidate => {
				try {
					return await fs.lstat(path.join(repo.root, candidate));
				} catch {
					return undefined;
				}
			}),
		);
		for (const [index, stat] of stats.entries()) {
			if (!stat) continue;
			const link = stat.isSymbolicLink();
			if (!link && !(stat.isFile() && stat.size <= CHECKPOINT_MAX_FILE_BYTES)) continue;
			covered.push({ path: batch[index], link, exec: !link && (stat.mode & 0o100) !== 0, stat });
			totalBytes += stat.size;
		}
		if (totalBytes > CHECKPOINT_MAX_TOTAL_BYTES) {
			throw new CheckpointLimitError(
				`the repository's files add up to more than ${CHECKPOINT_MAX_TOTAL_BYTES / (1024 * 1024)} MiB; checkpoints are skipped`,
			);
		}
	}
	return covered;
}

/** `before` and `after` are the same file: not swapped, replaced or re-linked in between. */
function sameFile(before: Stats, after: Stats): boolean {
	return before.dev === after.dev && before.ino === after.ino && before.isSymbolicLink() === after.isSymbolicLink();
}

/**
 * The bytes of a covered file (or a symlink's target text), read so that nothing outside the working tree
 * can be taken for it. The agent can rewrite the folder while this runs, so the file is opened with
 * `O_NOFOLLOW`, must be the very file `lstat` chose, and its directory must still resolve inside the
 * working tree both before and after the read. Anything else is left out of the checkpoint, and the bytes
 * are only handed to git once all of that held, so a secret reached through a swapped link or directory
 * never enters the object store.
 */
async function readCovered(repo: Repo, file: Covered): Promise<Buffer | null> {
	const absolute = path.join(repo.root, file.path);
	const parentInside = async (): Promise<boolean> => {
		const parent = await fs.realpath(path.dirname(absolute)).catch(() => undefined);
		return parent !== undefined && isInside(repo.root, parent);
	};
	const unchanged = async (): Promise<boolean> => {
		const after = await fs.lstat(absolute).catch(() => undefined);
		return after !== undefined && sameFile(file.stat, after) && (await parentInside());
	};
	try {
		if (!(await parentInside())) return null;
		if (file.link) {
			const target = await fs.readlink(absolute, { encoding: "buffer" });
			return (await unchanged()) ? target : null;
		}
		// O_NONBLOCK: a pipe swapped in for the file must not hang the read.
		const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || !sameFile(file.stat, opened) || opened.size > CHECKPOINT_MAX_FILE_BYTES) return null;
			const data = Buffer.alloc(opened.size);
			let filled = 0;
			while (filled < data.length) {
				const { bytesRead } = await handle.read(data, filled, data.length - filled, filled);
				if (bytesRead === 0) break;
				filled += bytesRead;
			}
			return filled === data.length && (await unchanged()) ? data : null;
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

/** Write the current covered files into the object database and return the tree id. */
async function captureOnce(repo: Repo): Promise<string> {
	const covered = await coveredFiles(repo);
	const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-checkpoint-"));
	try {
		const entries: string[] = [];
		let batch: { file: Covered; copy: string }[] = [];
		let batchBytes = 0;
		// Verified bytes are copied into the private temp dir and hashed from there, so git never opens a
		// path in the working tree.
		const flush = async (): Promise<void> => {
			if (batch.length === 0) return;
			const shas = decoder
				.decode(
					await git(repo, ["hash-object", "-w", "--no-filters", "--stdin-paths"], {
						input: `${batch.map(item => item.copy).join("\n")}\n`,
					}),
				)
				.split("\n")
				.filter(line => line !== "");
			if (shas.length !== batch.length) throw new CheckpointError("git did not hash every file");
			for (const [index, { file, copy }] of batch.entries()) {
				const mode = file.link ? "120000" : file.exec ? "100755" : "100644";
				entries.push(`${mode} ${shas[index]}\t${file.path}\0`);
				await fs.rm(copy, { force: true });
			}
			batch = [];
			batchBytes = 0;
		};
		let copies = 0;
		for (const file of covered) {
			const data = await readCovered(repo, file);
			if (data === null) continue;
			const copy = path.join(work, `blob-${copies++}`);
			await fs.writeFile(copy, data);
			batch.push({ file, copy });
			batchBytes += data.length;
			if (batchBytes >= HASH_BATCH_BYTES) await flush();
		}
		await flush();
		if (entries.length === 0) {
			return decoder.decode(await git(repo, ["mktree"], { input: "" })).trim();
		}
		const index = path.join(work, "index");
		await git(repo, ["update-index", "-z", "--index-info"], { input: entries.join(""), index });
		return decoder.decode(await git(repo, ["write-tree"], { index })).trim();
	} finally {
		await fs.rm(work, { recursive: true, force: true });
	}
}

/** The working tree as a tree object. A file vanishing mid-hash is retried; a size cap is not. */
async function captureTree(repo: Repo): Promise<string> {
	let failure: unknown;
	for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
		try {
			return await captureOnce(repo);
		} catch (error) {
			if (error instanceof CheckpointLimitError) throw error;
			failure = error;
		}
	}
	throw failure;
}

async function commitTree(repo: Repo, tree: string, sessionId: string, turn: number | string, startedMs: number) {
	const message = `omp checkpoint ${sessionId} ${turn}\n\nt=${startedMs}\n`;
	return decoder.decode(await git(repo, ["commit-tree", tree, "-m", message])).trim();
}

interface Point {
	turn: number;
	commit: string;
}

/** The session's checkpoints, oldest turn first. */
async function listPoints(repo: Repo, sessionId: string): Promise<Point[]> {
	const prefix = `${REF_PREFIX}/${sessionId}/`;
	const out = decoder.decode(await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", prefix]));
	const points: Point[] = [];
	for (const line of out.split("\n")) {
		const space = line.indexOf(" ");
		if (space < 0) continue;
		const name = line.slice(space + 1 + prefix.length);
		if (/^\d{1,9}$/.test(name)) points.push({ turn: Number(name), commit: line.slice(0, space) });
	}
	return points.sort((a, b) => a.turn - b.turn);
}

// ---------------------------------------------------------------------------
// Diffs

type ChangeStatus = "A" | "D" | "M" | "T";

const STATUS_NAME: Record<ChangeStatus, TurnDiffFile["status"]> = {
	A: "added",
	D: "deleted",
	M: "modified",
	T: "typechange",
};

function isStatus(value: string): value is ChangeStatus {
	return value === "A" || value === "D" || value === "M" || value === "T";
}

/** `diff-tree --numstat -z` (no renames): path -> `[added, removed]`, `null` counts for a binary file. */
function parseNumstat(output: string): Map<string, [number | null, number | null]> {
	const counts = new Map<string, [number | null, number | null]>();
	for (const record of output.split("\0")) {
		const first = record.indexOf("\t");
		const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
		if (second < 0) continue;
		const added = record.slice(0, first);
		const removed = record.slice(first + 1, second);
		counts.set(record.slice(second + 1), [
			added === "-" ? null : Number(added),
			removed === "-" ? null : Number(removed),
		]);
	}
	return counts;
}

/**
 * The per-file sections of `git diff-tree -p`, each cut down to its hunks (the `diff --git`, `index`,
 * `---` and `+++` preamble dropped: the path is the row header). A binary or mode-only change has no
 * hunk and yields "". Sections come in the same path order as `--name-status`.
 */
function splitPatch(output: string): string[] {
	const sections = output.split(/^diff --git /m);
	sections.shift();
	return sections.map(section => {
		const hunk = section.startsWith("@@ ") ? 0 : section.indexOf("\n@@ ");
		return hunk < 0 ? "" : section.slice(hunk === 0 ? 0 : hunk + 1);
	});
}

function cutAtLine(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const end = text.lastIndexOf("\n", limit);
	return end < 0 ? "" : text.slice(0, end + 1);
}

/** The changed files from tree-ish `from` to tree-ish `to`, with line counts and unified diffs. */
async function fileDiffs(repo: Repo, from: string, to: string, spansTurns: number): Promise<TurnDiffReply> {
	const names = splitNul(
		decoder.decode(await git(repo, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", from, to])),
	);
	const changes: { status: ChangeStatus; path: string }[] = [];
	for (let index = 0; index + 1 < names.length; index += 2) {
		if (isStatus(names[index])) changes.push({ status: names[index] as ChangeStatus, path: names[index + 1] });
	}
	if (changes.length === 0) return { files: [], spansTurns };
	const diffTree = ["diff-tree", "-r", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
	const [numstatOut, patchRun] = await Promise.all([
		git(repo, [...diffTree, "-z", "--numstat", from, to]),
		runGit(repo, [...diffTree, "-p", "-U3", from, to], { maxBytes: PATCH_MAX_BYTES }),
	]);
	if (patchRun.timedOut) throw new CheckpointError("git diff-tree timed out");
	if (patchRun.code !== 0 && !patchRun.truncated) throw new CheckpointError(patchRun.err || "git diff-tree failed");
	const numstat = parseNumstat(numstatOut.toString("utf8"));
	const sections = splitPatch(patchRun.out.toString("utf8"));
	// A patch cut at the byte cap ends in a half section; the files after it are listed without a diff.
	if (patchRun.truncated) sections.pop();
	// A type change prints as two sections (the old file deleted, the new one created).
	const patch: (string | undefined)[] = [];
	let cursor = 0;
	for (const change of changes) {
		const width = change.status === "T" ? 2 : 1;
		patch.push(cursor + width <= sections.length ? sections.slice(cursor, cursor + width).join("") : undefined);
		cursor += width;
	}
	if (!patchRun.truncated && cursor !== sections.length) {
		throw new CheckpointError("the diff did not line up with its file list");
	}
	const files: TurnDiffFile[] = [];
	let budget = TURN_DIFF_MAX_TOTAL_CHARS;
	for (const [index, change] of changes.slice(0, TURN_DIFF_MAX_FILES).entries()) {
		const counts = numstat.get(change.path);
		const full = patch[index];
		const diff = full === undefined ? "" : cutAtLine(full, Math.min(TURN_DIFF_MAX_FILE_CHARS, budget));
		budget -= diff.length;
		const cutShort =
			full === undefined
				? counts !== undefined && ((counts[0] ?? 0) > 0 || (counts[1] ?? 0) > 0)
				: diff.length < full.length;
		files.push({
			path: change.path,
			status: STATUS_NAME[change.status],
			added: counts ? counts[0] : null,
			removed: counts ? counts[1] : null,
			diff,
			...(cutShort ? { truncated: true as const } : {}),
		});
	}
	const omitted = changes.length - files.length;
	return { files, spansTurns, ...(omitted > 0 ? { omitted } : {}) };
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Restoring

interface RawChange {
	status: ChangeStatus;
	path: string;
	/** Mode and blob of the target side of the diff (empty for a deletion). */
	mode: string;
	sha: string;
}

function parseRaw(output: string): RawChange[] {
	const tokens = splitNul(output);
	const changes: RawChange[] = [];
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		const meta = tokens[index].slice(1).split(" ");
		const status = meta[4];
		if (isStatus(status)) changes.push({ status, path: tokens[index + 1], mode: meta[1], sha: meta[3] });
	}
	return changes;
}

/** A tree path that is safe to join onto the working tree root. */
function isSafeRelative(relative: string): boolean {
	if (relative === "" || relative.startsWith("/")) return false;
	const segments = relative.split("/");
	return segments.every(segment => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git");
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** When the checkpoint `commit` began (ms), from its message; falls back to its commit time. */
async function startedAt(repo: Repo, commit: string): Promise<number> {
	const body = decoder.decode(await git(repo, ["cat-file", "commit", commit]));
	const recorded = /^t=(\d+)$/m.exec(body)?.[1];
	if (recorded) return Number(recorded);
	return Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(body)?.[1] ?? 0) * 1000;
}

async function removeFile(root: string, rootReal: string, relative: string): Promise<boolean> {
	const absolute = path.join(root, relative);
	let stat: Stats;
	try {
		stat = await fs.lstat(absolute);
	} catch {
		return true;
	}
	// A directory here was not created by the checkpointed run; leave it.
	if (stat.isDirectory()) return false;
	const parent = await fs.realpath(path.dirname(absolute)).catch(() => undefined);
	if (parent === undefined || !isInside(rootReal, parent)) return false;
	await fs.rm(absolute, { force: true });
	// Directories the file leaves empty go with it.
	let dir = path.dirname(absolute);
	while (dir !== root && isInside(root, dir)) {
		try {
			await fs.rmdir(dir);
		} catch {
			break;
		}
		dir = path.dirname(dir);
	}
	return true;
}

/** Make every directory above `relative` exist as a real directory; false when something else is in the way. */
async function prepareParents(root: string, relative: string): Promise<boolean> {
	const segments = relative.split("/").slice(0, -1);
	let current = root;
	for (const segment of segments) {
		current = path.join(current, segment);
		try {
			if (!(await fs.lstat(current)).isDirectory()) return false;
		} catch {
			// Nothing from here down exists yet.
			await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
			return true;
		}
	}
	return true;
}

/** Blob contents by id, read in batches that stay under {@link BLOB_BATCH_BYTES}. */
async function* readBlobs(repo: Repo, shas: string[]): AsyncGenerator<Map<string, Buffer>> {
	const unique = [...new Set(shas)];
	if (unique.length === 0) return;
	const checked = decoder
		.decode(await git(repo, ["cat-file", "--batch-check"], { input: `${unique.join("\n")}\n` }))
		.split("\n");
	let batch: string[] = [];
	let bytes = 0;
	const flush = async (): Promise<Map<string, Buffer>> => {
		const out = await git(repo, ["cat-file", "--batch"], {
			input: `${batch.join("\n")}\n`,
			maxBytes: bytes + batch.length * 128 + 1024,
		});
		const blobs = new Map<string, Buffer>();
		let offset = 0;
		for (const sha of batch) {
			const newline = out.indexOf(0x0a, offset);
			const [, type, size] = decoder.decode(out.subarray(offset, newline)).split(" ");
			if (type !== "blob") throw new CheckpointError(`checkpoint object ${sha} is missing`);
			const start = newline + 1;
			blobs.set(sha, out.subarray(start, start + Number(size)));
			offset = start + Number(size) + 1;
		}
		return blobs;
	};
	for (const line of checked) {
		const [sha, type, size] = line.split(" ");
		if (!sha) continue;
		if (type !== "blob") throw new CheckpointError(`checkpoint object ${sha} is missing`);
		if (batch.length > 0 && bytes + Number(size) > BLOB_BATCH_BYTES) {
			yield await flush();
			batch = [];
			bytes = 0;
		}
		batch.push(sha);
		bytes += Number(size);
	}
	if (batch.length > 0) yield await flush();
}

async function writeFile(root: string, change: RawChange, data: Buffer): Promise<boolean> {
	const absolute = path.join(root, change.path);
	const temp = path.join(path.dirname(absolute), `.omp-restore-${process.pid}-${Math.random().toString(36).slice(2)}`);
	try {
		if (change.mode === "120000") await fs.symlink(data.toString("utf8"), temp);
		else await fs.writeFile(temp, data, { mode: change.mode === "100755" ? 0o777 : 0o666, flag: "wx" });
		await fs.rename(temp, absolute);
		return true;
	} catch {
		await fs.rm(temp, { force: true });
		return false;
	}
}

interface RestorePlan {
	/** Files created since the checkpoint, which a restore removes. */
	removals: RawChange[];
	/** Files a restore writes: changed ones back to the checkpoint's content, deleted ones back. */
	writes: RawChange[];
	/** Files the plan already leaves alone. */
	skipped: number;
}

/** What turning the tree `currentTree` back into `target` involves, without touching the working tree. */
async function planRestore(repo: Repo, currentTree: string, target: Point): Promise<RestorePlan> {
	const takenAt = await startedAt(repo, target.commit);
	const all = parseRaw(
		decoder.decode(
			await git(repo, ["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", currentTree, target.commit]),
		),
	);
	let skipped = 0;
	// Files the checkpoint does not hold: created since, or already there but not covered then (ignored
	// until a `.gitignore` edit). A file untouched since the checkpoint (its change time is not later) was
	// the latter and is left alone; one created, edited or renamed since is ours to remove.
	const removals: RawChange[] = [];
	const writes: RawChange[] = [];
	for (const change of all) {
		if (!isSafeRelative(change.path)) {
			skipped++;
		} else if (change.status !== "D") {
			writes.push(change);
		} else {
			const stat = await fs.lstat(path.join(repo.root, change.path)).catch(() => undefined);
			if (stat && Math.floor(stat.ctimeMs) <= takenAt) skipped++;
			else removals.push(change);
		}
	}
	return { removals, writes, skipped };
}

/**
 * Put the working tree back to `target`'s state and return what changed. The tree as it is now is kept
 * under `refs/omp-checkpoints/<sessionId>/before-restore`, so a restore can be undone ({@link redoRestore}).
 */
async function restoreTo(repo: Repo, sessionId: string, target: Point): Promise<RestoreResult> {
	const startedMs = Date.now();
	const currentTree = await captureTree(repo);
	const backup = await commitTree(repo, currentTree, sessionId, BACKUP_NAME, startedMs);
	await git(repo, ["update-ref", refFor(sessionId, BACKUP_NAME), backup]);
	const { removals, writes, skipped: planSkipped } = await planRestore(repo, currentTree, target);
	const rootReal = await fs.realpath(repo.root);
	let skipped = planSkipped;
	const plan: RewindFilesPlan = { revert: 0, remove: 0, recreate: 0 };
	for (const change of removals) {
		if (await removeFile(repo.root, rootReal, change.path)) plan.remove++;
		else skipped++;
	}
	const writable: RawChange[] = [];
	for (const change of writes) {
		// Something the checkpoint never saw (ignored, over the size cap) sits where a deleted file was.
		if (
			change.status === "A" &&
			(await fs.lstat(path.join(repo.root, change.path)).then(
				() => true,
				() => false,
			))
		) {
			skipped++;
		} else if (!(await prepareParents(repo.root, change.path))) {
			skipped++;
		} else {
			writable.push(change);
		}
	}
	const byBlob = new Map<string, RawChange[]>();
	for (const change of writable) byBlob.set(change.sha, [...(byBlob.get(change.sha) ?? []), change]);
	for await (const blobs of readBlobs(repo, [...byBlob.keys()])) {
		for (const [sha, data] of blobs) {
			for (const change of byBlob.get(sha) ?? []) {
				if (await writeFile(repo.root, change, data)) {
					if (change.status === "A") plan.recreate++;
					else plan.revert++;
				} else {
					skipped++;
				}
			}
		}
	}
	return { plan, skipped };
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Snapshot the working tree of `cwd`'s repository as turn `turn` of `sessionId` and return the commit id.
 * Null when `cwd` is not in a git working tree (the host then does not advertise `turn-diff`). Throws a
 * {@link CheckpointError} for a bad id or a repository that is over the size caps.
 */
export async function checkpoint(cwd: string, sessionId: string, turn: number): Promise<string | null> {
	assertSessionId(sessionId);
	assertTurn(turn);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		const startedMs = Date.now();
		const commit = await commitTree(repo, await captureTree(repo), sessionId, turn, startedMs);
		await git(repo, ["update-ref", refFor(sessionId, turn), commit]);
		return commit;
	});
}

/**
 * What turn `turn` changed: checkpoint `turn` against the next checkpoint, or against the working tree
 * for the latest one. Never throws on a git failure (the reply carries its `reason`); null when `cwd` is
 * not in a git working tree.
 */
export async function turnDiff(
	cwd: string,
	sessionId: string,
	turn: number,
	options: DiffOptions = {},
): Promise<TurnDiffReply | null> {
	assertSessionId(sessionId);
	assertTurn(turn);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		try {
			const points = await listPoints(repo, sessionId);
			const from = points.find(point => point.turn === turn);
			if (!from) return { files: null, reason: "no checkpoint was recorded before that turn" };
			const next = points.find(point => point.turn > turn);
			if (next) return await fileDiffs(repo, from.commit, next.commit, next.turn - turn);
			const spans = Math.max(1, (options.latestTurn ?? turn) - turn + 1);
			return await fileDiffs(repo, from.commit, await captureTree(repo), spans);
		} catch (error) {
			return { files: null, reason: reasonOf(error) };
		}
	});
}

/**
 * Everything changed since the session's first checkpoint, against the working tree. Never throws on a
 * git failure; null when `cwd` is not in a git working tree.
 */
export async function sessionDiff(
	cwd: string,
	sessionId: string,
	options: DiffOptions = {},
): Promise<TurnDiffReply | null> {
	assertSessionId(sessionId);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		try {
			const points = await listPoints(repo, sessionId);
			const first = points[0];
			if (!first) return { files: null, reason: "no checkpoint was recorded in this session" };
			const latest = Math.max(points[points.length - 1].turn, options.latestTurn ?? 0);
			return await fileDiffs(repo, first.commit, await captureTree(repo), latest - first.turn + 1);
		} catch (error) {
			return { files: null, reason: reasonOf(error) };
		}
	});
}

/**
 * Put the working tree back to how it was at checkpoint `turn`, without moving HEAD or touching the
 * index: changed and deleted files return to the checkpoint's content, files created since are removed,
 * and ignored files are left alone. Null when `cwd` is not in a git working tree; throws a
 * {@link CheckpointError} for a bad id, a missing checkpoint or a git failure.
 */
export async function restoreFiles(cwd: string, sessionId: string, turn: number): Promise<RestoreResult | null> {
	assertSessionId(sessionId);
	assertTurn(turn);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		const target = (await listPoints(repo, sessionId)).find(point => point.turn === turn);
		if (!target) throw new CheckpointError("no checkpoint was recorded before that turn");
		return restoreTo(repo, sessionId, target);
	});
}

/**
 * What {@link restoreFiles} would do for `turn`, without writing anything to the working tree or the
 * refs. Null when `cwd` is not in a git working tree or the turn has no checkpoint.
 */
export async function previewRestore(cwd: string, sessionId: string, turn: number): Promise<RewindFilesPlan | null> {
	assertSessionId(sessionId);
	assertTurn(turn);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		const target = (await listPoints(repo, sessionId)).find(point => point.turn === turn);
		if (!target) return null;
		const { removals, writes } = await planRestore(repo, await captureTree(repo), target);
		return {
			revert: writes.filter(change => change.status !== "A").length,
			remove: removals.length,
			recreate: writes.filter(change => change.status === "A").length,
		};
	});
}

/**
 * Undo the last {@link restoreFiles}: restore the tree it kept under `before-restore`. That in turn
 * keeps the tree as it was just now, so calling this twice redoes the restore. Null when `cwd` is not in
 * a git working tree; throws a {@link CheckpointError} when the session has no restore to undo.
 */
export async function redoRestore(cwd: string, sessionId: string): Promise<RestoreResult | null> {
	assertSessionId(sessionId);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		const found = await runGit(repo, [
			"rev-parse",
			"--verify",
			"--quiet",
			`${refFor(sessionId, BACKUP_NAME)}^{commit}`,
		]);
		const commit = decoder.decode(found.out).trim();
		if (found.code !== 0 || !commit) throw new CheckpointError("there is no file restore to undo");
		return restoreTo(repo, sessionId, { turn: -1, commit });
	});
}

/** Delete every checkpoint of `sessionId` (and its restore backup); returns how many refs went. Null when not in a repository. */
export async function dropCheckpoints(cwd: string, sessionId: string): Promise<number | null> {
	assertSessionId(sessionId);
	const repo = await repoOf(cwd);
	if (!repo) return null;
	return serial(repo.root, async () => {
		const prefix = `${REF_PREFIX}/${sessionId}/`;
		const refs = decoder
			.decode(await git(repo, ["for-each-ref", "--format=%(refname)", prefix]))
			.split("\n")
			.filter(ref => ref.startsWith(prefix));
		if (refs.length > 0) {
			await git(repo, ["update-ref", "--stdin"], { input: `${refs.map(ref => `delete ${ref}`).join("\n")}\n` });
		}
		return refs.length;
	});
}
