/**
 * Working-tree snapshots for rewinding the conversation together with the files it changed.
 *
 * Before every user prompt a snapshot of the session cwd's repository working tree is written
 * into a private bare git repository under omp's state dir (`<snapshots>/<repo-hash>`), driven
 * through `GIT_DIR`/`GIT_WORK_TREE` and a private per-session index. The user's own repository -
 * its index, HEAD, refs, stash, hooks, config - is never written: the only commands run against
 * it are the read-only `git ls-files` that decides which files the snapshot covers, so
 * `.gitignore`, `.git/info/exclude` and the global excludes file apply exactly as they do for the
 * user's `git status`. Tracked files and untracked non-ignored files are covered; ignored files,
 * files over {@link SNAPSHOT_MAX_FILE_BYTES}, directories and special files are not, so restoring
 * never touches them.
 *
 * A snapshot is a commit in the private repository; the prompt entry it precedes is bound to it
 * by the ref `refs/omp/s/<sessionId>/entry/<entryId>`, so the mapping survives restarts and
 * session resumes without touching the session file. Restoring snapshots the current tree first
 * and remembers it, which is what makes {@link FileSnapshotStore.redo} possible.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, ptree } from "@oh-my-pi/pi-utils";

/** Files above this size are left out of snapshots and never restored or deleted. */
export const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** A repository with more candidate files than this is not snapshotted. */
export const SNAPSHOT_MAX_FILES = 50_000;
/** A repository whose covered files add up to more than this is not snapshotted. */
export const SNAPSHOT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/**
 * How long a prompt waits for its snapshot. Past it the prompt runs without one (the snapshot keeps
 * going in the background, which warms the index for the next prompt, but is never bound to it).
 */
export const SNAPSHOT_PROMPT_BUDGET_MS = 2_000;
/** After a repository trips a size cap or keeps missing the prompt budget, prompts skip it for this long. */
const SIZE_SKIP_MS = 5 * 60 * 1000;
/** Consecutive prompts that gave up waiting before the repository is skipped for {@link SIZE_SKIP_MS}. */
const MAX_BUDGET_TIMEOUTS = 3;
/** A session's private index is recreated (seeded from another one) on demand, so idle ones go quickly. */
const INDEX_RETENTION_MS = 24 * 60 * 60 * 1000;
/** `git` stderr of an index that cannot be read: a copy taken mid-write, or a damaged file. */
const CORRUPT_INDEX =
	/index file (corrupt|smaller than expected|open failed)|bad index file|unknown index entry format/i;
const ROOT_MARKER = "omp-root";
/** Stores swept for orphans already, so the directory walk happens once per process. */
const sweptStoreRoots = new Set<string>();
/** Snapshots older than this are pruned the next time their repository's store is opened. */
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 120_000;
const LSTAT_BATCH = 128;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/** A refusal whose message is safe to show a user. */
export class FileSnapshotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FileSnapshotError";
	}
}

/** What restoring a snapshot does to the working tree. */
export interface FileRestorePlan {
	/** Files whose content returns to the snapshot's version. */
	revert: number;
	/** Files created since the snapshot, which restoring deletes. */
	remove: number;
	/** Files deleted since the snapshot, which restoring brings back. */
	recreate: number;
}

export interface FileRestoreResult {
	plan: FileRestorePlan;
	/** Files the restore left alone because something the snapshot does not cover is in the way. */
	skipped: number;
}

type ChangeStatus = "A" | "D" | "M" | "T";

interface Change {
	status: ChangeStatus;
	path: string;
}

/** A snapshot of one repository, not yet bound to a prompt entry. */
export class CapturedSnapshot {
	constructor(
		readonly repo: SnapshotRepo,
		readonly commit: string,
	) {}
}

/** The directory (the one holding `.git`) of the repository containing `cwd`, or undefined. */
export function findGitRoot(cwd: string): string | undefined {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			try {
				return fs.realpathSync(dir);
			} catch {
				return dir;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function baseEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

function splitNul(output: string): string[] {
	const parts = output.split("\0");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** One repository's private snapshot store. Callers serialize access through {@link FileSnapshotStore}. */
export class SnapshotRepo {
	readonly root: string;
	readonly #gitDir: string;
	readonly #storeRelative: string | undefined;

	private constructor(root: string, gitDir: string) {
		this.root = root;
		this.#gitDir = gitDir;
		const relative = path.relative(root, gitDir);
		this.#storeRelative = relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative;
	}

	static async open(
		root: string,
		storeRoot: string,
		create: boolean,
		keepIndex: string,
	): Promise<SnapshotRepo | undefined> {
		const gitDir = path.join(storeRoot, crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
		const repo = new SnapshotRepo(root, gitDir);
		if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
			if (!create) return undefined;
			await fsp.mkdir(storeRoot, { recursive: true });
			await ptree.exec(["git", "init", "--bare", "--quiet", gitDir], {
				cwd: storeRoot,
				env: baseEnv(),
				timeout: GIT_TIMEOUT_MS,
			});
			await fsp.mkdir(path.join(gitDir, "info"), { recursive: true });
			// Highest-precedence attributes: no eol conversion, filters or encodings, so the bytes the
			// snapshot stores and writes back are exactly the bytes on disk.
			await Bun.write(
				path.join(gitDir, "info", "attributes"),
				"* -text -eol -crlf -filter -ident -working-tree-encoding\n",
			);
		}
		// The marker names the repository this store belongs to; touching it on every open makes its
		// mtime the store's last use, which is what the orphan sweep goes by.
		const marker = path.join(gitDir, ROOT_MARKER);
		if (fs.existsSync(marker)) await fsp.utimes(marker, new Date(), new Date()).catch(() => {});
		else await Bun.write(marker, root);
		repo.#prune(keepIndex).catch(error => logger.debug("file snapshot prune failed", { error: String(error) }));
		if (!sweptStoreRoots.has(storeRoot)) {
			sweptStoreRoots.add(storeRoot);
			sweepOrphanStores(storeRoot, gitDir).catch(error =>
				logger.debug("file snapshot store sweep failed", { error: String(error) }),
			);
		}
		return repo;
	}

	/** Run git against the private store (`GIT_DIR` + the user's tree as `GIT_WORK_TREE`). */
	async #store(
		args: string[],
		options: { index?: string; input?: string; allowNonZero?: boolean } = {},
	): Promise<ptree.ExecResult> {
		const env = baseEnv();
		env.GIT_DIR = this.#gitDir;
		env.GIT_WORK_TREE = this.root;
		if (options.index) env.GIT_INDEX_FILE = path.join(this.#gitDir, options.index);
		env.GIT_CONFIG_GLOBAL = NULL_DEVICE;
		env.GIT_CONFIG_NOSYSTEM = "1";
		env.GIT_ATTR_NOSYSTEM = "1";
		env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "omp";
		env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "omp@localhost";
		return ptree.exec(
			[
				"git",
				"-c",
				"core.autocrlf=false",
				"-c",
				"core.safecrlf=false",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.untrackedCache=false",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ cwd: this.root, env, input: options.input, allowNonZero: options.allowNonZero, timeout: GIT_TIMEOUT_MS },
		);
	}

	/**
	 * `git ls-files` on the user's repository, read as a stream so a huge untracked tree that is not
	 * ignored stops the walk at {@link SNAPSHOT_MAX_FILES} instead of being listed in full.
	 */
	async #listCandidates(): Promise<string[]> {
		const env = baseEnv();
		env.GIT_OPTIONAL_LOCKS = "0";
		const child = ptree
			.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
				cwd: this.root,
				env,
				timeout: GIT_TIMEOUT_MS,
			})
			.nothrow();
		const decoder = new TextDecoder();
		const files = new Set<string>();
		let tail = "";
		for await (const chunk of child.stdout) {
			const parts = (tail + decoder.decode(chunk, { stream: true })).split("\0");
			tail = parts.pop() ?? "";
			for (const part of parts) files.add(part);
			if (files.size > SNAPSHOT_MAX_FILES) {
				child.kill();
				throw new FileSnapshotError(
					`the repository has more than ${SNAPSHOT_MAX_FILES} files; file snapshots are skipped`,
				);
			}
		}
		if ((await child.exited) !== 0) throw new Error("git ls-files failed");
		if (tail) files.add(tail);
		return [...files];
	}

	/** The files a snapshot covers: tracked plus untracked-not-ignored, minus oversized and special files. */
	async #coveredPaths(): Promise<string[]> {
		const candidates = await this.#listCandidates();
		const storePrefix =
			this.#storeRelative === undefined ? undefined : `${this.#storeRelative.split(path.sep).join("/")}/`;
		const covered: string[] = [];
		let totalBytes = 0;
		for (let start = 0; start < candidates.length; start += LSTAT_BATCH) {
			const batch = candidates.slice(start, start + LSTAT_BATCH);
			const stats = await Promise.all(
				batch.map(async candidate => {
					if (storePrefix !== undefined && candidate.startsWith(storePrefix)) return undefined;
					try {
						return await fsp.lstat(path.join(this.root, candidate));
					} catch {
						return undefined;
					}
				}),
			);
			for (const [index, stat] of stats.entries()) {
				if (!stat) continue;
				if (stat.isSymbolicLink() || (stat.isFile() && stat.size <= SNAPSHOT_MAX_FILE_BYTES)) {
					covered.push(batch[index]);
					totalBytes += stat.size;
				}
			}
			if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) {
				throw new FileSnapshotError(
					`the repository's files add up to more than ${SNAPSHOT_MAX_TOTAL_BYTES / (1024 * 1024)} MiB; file snapshots are skipped`,
				);
			}
		}
		return covered;
	}

	/**
	 * A session's first capture starts from the most recently written index of any other session
	 * (git replaces an index atomically, so a copy is always whole): its stat cache lets git skip
	 * rehashing every unchanged file, which is what makes a first snapshot of a large repo slow.
	 */
	async #seedIndex(indexName: string): Promise<void> {
		const target = path.join(this.#gitDir, indexName);
		if (fs.existsSync(target)) return;
		let newest: { file: string; mtimeMs: number } | undefined;
		for (const name of await fsp.readdir(this.#gitDir)) {
			// A `.lock` is an index git is still writing (or one a killed git left behind), not a whole one.
			if (!name.startsWith("index-") || name.startsWith("index-restore-") || name.endsWith(".lock")) continue;
			const file = path.join(this.#gitDir, name);
			const stat = await fsp.stat(file).catch(() => undefined);
			if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs: stat.mtimeMs };
		}
		if (newest) await fsp.copyFile(newest.file, target).catch(() => {});
	}

	/** Write the current covered files into the store and return the tree id. */
	async captureTree(indexName: string): Promise<string> {
		try {
			await this.#seedIndex(indexName);
			const covered = await this.#coveredPaths();
			const coveredSet = new Set(covered);
			const indexed = splitNul((await this.#store(["ls-files", "-z"], { index: indexName })).stdout);
			const stale = indexed.filter(entry => !coveredSet.has(entry));
			if (stale.length > 0) {
				await this.#store(["update-index", "-z", "--force-remove", "--stdin"], {
					index: indexName,
					input: `${stale.join("\0")}\0`,
				});
			}
			if (covered.length > 0) {
				await this.#store(["update-index", "-z", "--add", "--stdin"], {
					index: indexName,
					input: `${covered.join("\0")}\0`,
				});
			}
			return (await this.#store(["write-tree"], { index: indexName })).stdout.trim();
		} catch (error) {
			// An unreadable index would fail every later capture too; dropping it lets the next one reseed.
			if (error instanceof ptree.Exception && CORRUPT_INDEX.test(error.stderr)) {
				await fsp.rm(path.join(this.#gitDir, indexName), { force: true });
			}
			throw error;
		}
	}

	/** Commit `tree`; the message records when the snapshot began, which {@link plan} compares file birth times to. */
	async commit(tree: string, takenAtMs: number): Promise<string> {
		return (await this.#store(["commit-tree", tree, "-m", `omp file snapshot t=${takenAtMs}`])).stdout.trim();
	}

	/** When the snapshot `commit` began (ms), from its message; falls back to its commit time. */
	async #snapshotTime(commit: string): Promise<number> {
		const body = (await this.#store(["cat-file", "commit", commit])).stdout;
		const recorded = /^omp file snapshot t=(\d+)$/m.exec(body)?.[1];
		if (recorded) return Number(recorded);
		return Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(body)?.[1] ?? 0) * 1000;
	}

	async treeOf(commit: string): Promise<string> {
		return (await this.#store(["rev-parse", `${commit}^{tree}`])).stdout.trim();
	}

	async setRef(name: string, commit: string): Promise<void> {
		await this.#store(["update-ref", name, commit]);
	}

	async resolveRef(name: string): Promise<string | undefined> {
		const result = await this.#store(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], {
			allowNonZero: true,
		});
		const commit = result.stdout.trim();
		return result.ok && commit ? commit : undefined;
	}

	/** What turns tree-ish `from` into tree-ish `to`. */
	async diff(from: string, to: string): Promise<Change[]> {
		const out = (await this.#store(["diff-tree", "-r", "-z", "--name-status", "--no-renames", from, to])).stdout;
		const tokens = splitNul(out);
		const changes: Change[] = [];
		for (let index = 0; index + 1 < tokens.length; index += 2) {
			const status = tokens[index];
			if (status === "A" || status === "D" || status === "M" || status === "T") {
				changes.push({ status, path: tokens[index + 1] });
			}
		}
		return changes;
	}

	/**
	 * What restoring `target` does to a tree currently equal to `current`. A path that is in
	 * `current` but not in `target` was either created after the snapshot or already existed and was
	 * simply not covered then (ignored until a `.gitignore` edit, over the size cap until it shrank);
	 * only the former may be deleted, so a file born before the snapshot is left alone and counted.
	 */
	async plan(current: string, target: string): Promise<{ changes: Change[]; skipped: number }> {
		const all = await this.diff(current, target);
		if (!all.some(change => change.status === "D")) return { changes: all, skipped: 0 };
		const takenAt = await this.#snapshotTime(target);
		const changes: Change[] = [];
		let skipped = 0;
		for (const change of all) {
			if (change.status === "D") {
				const stat = await fsp.lstat(path.join(this.root, change.path)).catch(() => undefined);
				// Filesystems without a birth time report 0 (or the change time, which only moves later).
				const born = stat && (stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs);
				if (stat && born !== undefined && Math.floor(born) <= takenAt) {
					skipped++;
					continue;
				}
			}
			changes.push(change);
		}
		return { changes, skipped };
	}

	/** Make the working tree match `target` for the paths in `changes` (the diff from the current tree to `target`). */
	async apply(target: string, changes: Change[]): Promise<number> {
		const rootReal = await fsp.realpath(this.root);
		for (const change of changes) {
			if (change.status === "D") await this.#remove(rootReal, change.path);
		}
		const dirState = new Map<string, boolean>();
		const writable = async (relative: string): Promise<boolean> => {
			const segments = relative.split("/").slice(0, -1);
			let current = this.root;
			for (const segment of segments) {
				current = path.join(current, segment);
				let ok = dirState.get(current);
				if (ok === undefined) {
					try {
						const stat = await fsp.lstat(current);
						ok = stat.isDirectory();
					} catch (error) {
						if (!isEnoent(error)) throw error;
						// Nothing from here down exists yet.
						return true;
					}
					dirState.set(current, ok);
				}
				if (!ok) return false;
			}
			return true;
		};
		let skipped = 0;
		const toWrite: string[] = [];
		for (const change of changes) {
			if (change.status === "D") continue;
			// A created-since path that is occupied by something the snapshot never saw (ignored, over the
			// size cap) or sits behind such a path is theirs, not ours to overwrite.
			if (change.status === "A") {
				const occupied = await fsp.lstat(path.join(this.root, change.path)).then(
					() => true,
					() => false,
				);
				if (occupied || !(await writable(change.path))) {
					skipped++;
					continue;
				}
			} else if (!(await writable(change.path))) {
				skipped++;
				continue;
			}
			toWrite.push(change.path);
		}
		if (toWrite.length > 0) {
			const indexName = `index-restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
			try {
				await this.#store(["read-tree", target], { index: indexName });
				await this.#store(["checkout-index", "-f", "-z", "--stdin"], {
					index: indexName,
					input: `${toWrite.join("\0")}\0`,
				});
			} finally {
				await fsp.rm(path.join(this.#gitDir, indexName), { force: true });
			}
		}
		return skipped;
	}

	async #remove(rootReal: string, relative: string): Promise<void> {
		const absolute = path.join(this.root, relative);
		let stat: fs.Stats;
		try {
			stat = await fsp.lstat(absolute);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		// A directory here was not created by the snapshotted run; leave it.
		if (stat.isDirectory()) return;
		const parent = await fsp.realpath(path.dirname(absolute)).catch(() => undefined);
		if (parent === undefined || !isInside(rootReal, parent)) return;
		await fsp.rm(absolute, { force: true });
		let dir = path.dirname(absolute);
		while (dir !== this.root && isInside(this.root, dir)) {
			try {
				await fsp.rmdir(dir);
			} catch {
				break;
			}
			dir = path.dirname(dir);
		}
	}

	/** Drop snapshot refs past the retention window and per-session indexes nobody has touched for a day. */
	async #prune(keepIndex: string): Promise<void> {
		const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
		const listing = (
			await this.#store(["for-each-ref", "--format=%(refname)%09%(committerdate:unix)", "refs/omp/"], {
				allowNonZero: true,
			})
		).stdout;
		const expired: string[] = [];
		for (const line of listing.split("\n")) {
			const [ref, seconds] = line.split("\t");
			if (ref && seconds && Number(seconds) * 1000 < cutoff) expired.push(`delete ${ref}`);
		}
		if (expired.length > 0) {
			await this.#store(["update-ref", "--stdin"], { input: `${expired.join("\n")}\n` });
			await this.#store(["gc", "--quiet"], { allowNonZero: true });
		}
		const indexCutoff = Date.now() - INDEX_RETENTION_MS;
		for (const name of await fsp.readdir(this.#gitDir)) {
			if (!name.startsWith("index-") || name === keepIndex) continue;
			const file = path.join(this.#gitDir, name);
			const stat = await fsp.stat(file).catch(() => undefined);
			if (stat && stat.mtimeMs < indexCutoff) await fsp.rm(file, { force: true });
		}
	}
}

/**
 * Remove sibling stores (other repositories) whose repository is gone or that have not been opened
 * for the retention window, so stores for deleted worktrees and temporary clones do not pile up.
 * Stores without a marker predate it and are left alone.
 */
async function sweepOrphanStores(storeRoot: string, keepDir: string): Promise<void> {
	const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
	for (const name of await fsp.readdir(storeRoot)) {
		const dir = path.join(storeRoot, name);
		if (dir === keepDir) continue;
		const marker = path.join(dir, ROOT_MARKER);
		const [root, stat] = await Promise.all([
			fsp.readFile(marker, "utf8").catch(() => undefined),
			fsp.stat(marker).catch(() => undefined),
		]);
		if (root === undefined || !stat) continue;
		if (!fs.existsSync(root) || stat.mtimeMs < cutoff) await fsp.rm(dir, { recursive: true, force: true });
	}
}

export interface FileSnapshotStoreOptions {
	/** Directory holding the per-repository snapshot stores. */
	storeRoot: () => string;
	cwd: () => string;
	sessionId: () => string;
	enabled: () => boolean;
}

interface UndoSlot {
	sessionId: string;
	repo: SnapshotRepo;
	/** Commit of the tree as it was before the last restore (or redo). */
	inverse: string;
	/** Tree the working tree had right after that operation; redo only runs while it still does. */
	expectedTree: string;
}

function planOf(changes: Change[]): FileRestorePlan {
	const plan: FileRestorePlan = { revert: 0, remove: 0, recreate: 0 };
	for (const change of changes) {
		if (change.status === "A") plan.recreate++;
		else if (change.status === "D") plan.remove++;
		else plan.revert++;
	}
	return plan;
}

function describeFailure(error: unknown): string {
	if (error instanceof FileSnapshotError) return error.message;
	const text =
		error instanceof ptree.Exception ? error.stderr : error instanceof Error ? error.message : String(error);
	return text.trim().split("\n")[0] || "git failed";
}

/** Snapshots and restores one session's working tree. */
export class FileSnapshotStore {
	readonly #options: FileSnapshotStoreOptions;
	readonly #repos = new Map<string, Promise<SnapshotRepo | undefined>>();
	#queue: Promise<unknown> = Promise.resolve();
	#undo: UndoSlot | undefined;
	/** Repository root -> time until which prompts skip snapshotting it (it tripped a size cap). */
	readonly #sizeSkips = new Map<string, number>();
	/** Repository root -> consecutive prompts that gave up waiting for its snapshot. */
	readonly #timeouts = new Map<string, number>();
	/** The capture in flight, if any: a prompt that finds one running goes without a snapshot instead of queueing another pass. */
	#capturing: Promise<unknown> | undefined;

	constructor(options: FileSnapshotStoreOptions) {
		this.#options = options;
	}

	/** Whether snapshots apply to this session right now: enabled, and the cwd is inside a git repository. */
	get supported(): boolean {
		return this.#options.enabled() && findGitRoot(this.#options.cwd()) !== undefined;
	}

	/** Whether the last file restore (or redo) can be reverted. */
	get canRedo(): boolean {
		return this.#undo?.sessionId === this.#options.sessionId();
	}

	#serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task, task);
		this.#queue = run.catch(() => {});
		return run;
	}

	#repo(create: boolean): Promise<SnapshotRepo | undefined> {
		const root = findGitRoot(this.#options.cwd());
		if (root === undefined) return Promise.resolve(undefined);
		const key = `${create ? "w" : "r"}\0${root}`;
		let repo = this.#repos.get(key);
		if (!repo) {
			repo = SnapshotRepo.open(root, this.#options.storeRoot(), create, this.#indexName());
			// A store that does not exist yet must be looked up again once something creates it, and a
			// failed open must not poison later attempts.
			const forget = () => this.#repos.delete(key);
			repo.then(opened => (opened ? undefined : forget()), forget);
			this.#repos.set(key, repo);
		}
		return repo;
	}

	#indexName(): string {
		return `index-${sanitizeSegment(this.#options.sessionId())}`;
	}

	#entryRef(entryId: string): string {
		return `refs/omp/s/${sanitizeSegment(this.#options.sessionId())}/entry/${entryId}`;
	}

	#undoRef(): string {
		return `refs/omp/s/${sanitizeSegment(this.#options.sessionId())}/undo`;
	}

	/**
	 * Snapshot the working tree now. Resolves undefined (never throws) when snapshots are off, the
	 * cwd is not in a git repository, the repository is being skipped (it tripped a size cap or kept
	 * missing the budget), another capture is still running, the snapshot failed, it took longer than
	 * `budgetMs`, or `signal` aborted. A snapshot that finishes late is dropped, not bound to anything,
	 * so it can never capture state the agent has already changed; it still finishes in the background
	 * and leaves the index warm for the next one.
	 */
	async capture(
		budgetMs: number = SNAPSHOT_PROMPT_BUDGET_MS,
		signal?: AbortSignal,
	): Promise<CapturedSnapshot | undefined> {
		if (!this.supported || this.#capturing || signal?.aborted) return undefined;
		const root = findGitRoot(this.#options.cwd());
		if (root === undefined || (this.#sizeSkips.get(root) ?? 0) > Date.now()) return undefined;
		const work = this.#serial(async () => {
			const takenAt = Date.now();
			try {
				const repo = await this.#repo(true);
				if (!repo) return undefined;
				const commit = await repo.commit(await repo.captureTree(this.#indexName()), takenAt);
				return new CapturedSnapshot(repo, commit);
			} catch (error) {
				if (error instanceof FileSnapshotError) this.#sizeSkips.set(root, Date.now() + SIZE_SKIP_MS);
				logger.warn("file snapshot failed", { error: describeFailure(error) });
				return undefined;
			}
		});
		this.#capturing = work;
		void work.finally(() => {
			if (this.#capturing === work) this.#capturing = undefined;
		});
		const { promise: gate, resolve } = Promise.withResolvers<"timeout" | "aborted">();
		const timer = setTimeout(() => resolve("timeout"), budgetMs);
		const onAbort = () => resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const outcome = await Promise.race([work, gate]);
			if (outcome === "aborted") return undefined;
			if (outcome === "timeout") {
				const misses = (this.#timeouts.get(root) ?? 0) + 1;
				this.#timeouts.set(root, misses);
				if (misses >= MAX_BUDGET_TIMEOUTS) {
					this.#timeouts.delete(root);
					this.#sizeSkips.set(root, Date.now() + SIZE_SKIP_MS);
				}
				logger.warn("file snapshot took too long; the prompt runs without one", { budgetMs, misses });
				return undefined;
			}
			if (outcome) this.#timeouts.delete(root);
			return outcome;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Record that `entryId` is the prompt `snapshot` was taken before. Never rejects. */
	async bind(snapshot: CapturedSnapshot, entryId: string): Promise<void> {
		if (!ENTRY_ID_PATTERN.test(entryId)) return;
		const ref = this.#entryRef(entryId);
		try {
			await this.#serial(() => snapshot.repo.setRef(ref, snapshot.commit));
		} catch (error) {
			logger.warn("file snapshot could not be bound to its prompt", { error: describeFailure(error) });
		}
	}

	async #lookup(entryId: string): Promise<{ repo: SnapshotRepo; commit: string } | undefined> {
		if (!ENTRY_ID_PATTERN.test(entryId)) return undefined;
		const repo = await this.#repo(false);
		if (!repo) return undefined;
		const commit = await repo.resolveRef(this.#entryRef(entryId));
		return commit ? { repo, commit } : undefined;
	}

	/** What restoring to before prompt `entryId` would change; undefined when it has no snapshot. */
	preview(entryId: string): Promise<FileRestorePlan | undefined> {
		if (!this.supported) return Promise.resolve(undefined);
		return this.#serial(async () => {
			try {
				const found = await this.#lookup(entryId);
				if (!found) return undefined;
				const tree = await found.repo.captureTree(this.#indexName());
				return planOf((await found.repo.plan(tree, found.commit)).changes);
			} catch (error) {
				logger.warn("file restore preview failed", { error: describeFailure(error) });
				return undefined;
			}
		});
	}

	/** Put the working tree back to how it was before prompt `entryId`, remembering the current state for {@link redo}. */
	restoreBefore(entryId: string): Promise<FileRestoreResult> {
		if (!this.supported) {
			return Promise.reject(new FileSnapshotError("file restore needs a git repository and snapshots enabled"));
		}
		return this.#serial(async () => {
			try {
				const found = await this.#lookup(entryId);
				if (!found) throw new FileSnapshotError("no file snapshot was recorded before that prompt");
				return await this.#restoreTo(found.repo, found.commit);
			} catch (error) {
				throw error instanceof FileSnapshotError
					? error
					: new FileSnapshotError(`file restore failed: ${describeFailure(error)}`);
			}
		});
	}

	/** Revert the last file restore (or redo), as long as nothing has changed the files since. */
	redo(): Promise<FileRestoreResult> {
		return this.#serial(async () => {
			const slot = this.#undo;
			if (!slot || slot.sessionId !== this.#options.sessionId()) {
				throw new FileSnapshotError("there is no file restore to undo");
			}
			try {
				const tree = await slot.repo.captureTree(this.#indexName());
				if (tree !== slot.expectedTree) {
					throw new FileSnapshotError("files changed since the restore; undoing it would overwrite them");
				}
				return await this.#restoreTo(slot.repo, slot.inverse);
			} catch (error) {
				throw error instanceof FileSnapshotError
					? error
					: new FileSnapshotError(`undoing the file restore failed: ${describeFailure(error)}`);
			}
		});
	}

	async #restoreTo(repo: SnapshotRepo, target: string): Promise<FileRestoreResult> {
		const index = this.#indexName();
		const takenAt = Date.now();
		const before = await repo.commit(await repo.captureTree(index), takenAt);
		const { changes, skipped: kept } = await repo.plan(await repo.treeOf(before), target);
		const skipped = kept + (changes.length > 0 ? await repo.apply(target, changes) : 0);
		await repo.setRef(this.#undoRef(), before);
		this.#undo = {
			sessionId: this.#options.sessionId(),
			repo,
			inverse: before,
			expectedTree: await repo.captureTree(index),
		};
		return { plan: planOf(changes), skipped };
	}
}

/** "3 files (2 reverted, 1 removed)": how many files a restore touches, for notices and prompts. */
export function describeFileRestore(plan: FileRestorePlan): string {
	const total = plan.revert + plan.remove + plan.recreate;
	const parts = [
		plan.revert > 0 ? `${plan.revert} reverted` : undefined,
		plan.remove > 0 ? `${plan.remove} removed` : undefined,
		plan.recreate > 0 ? `${plan.recreate} recreated` : undefined,
	].filter(part => part !== undefined);
	return `${total} ${total === 1 ? "file" : "files"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}
