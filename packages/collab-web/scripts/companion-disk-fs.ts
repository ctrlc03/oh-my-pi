/**
 * The disk guard's reach into the machine: free space, finding rebuildable build output in the worktrees the
 * companion made, measuring and deleting it, and telling whether anything works in a worktree. The disk is slow
 * exactly when this matters, so every scan is bounded (entries read, time per size, time overall) and runs in a
 * child process (`du`, `ps`, `lsof`, `rm`) with a deadline, never on the companion's event loop.
 *
 * What may be deleted, and nothing else: a folder named `target` (next to a `Cargo.toml`, and holding what cargo writes),
 * `node_modules`, `.next`, `dist` or `build` (the last two only when git ignores them), next to a `package.json`, inside a
 * linked worktree under the companion's worktrees folder, holding no file git tracks. Never `.git`, never a symlink, never
 * a main checkout or a worktree the companion did not make. See docs/collab.md → Disk space.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DiskArtifact, DiskArtifactKind } from "@oh-my-pi/pi-wire/disk";
import { git, isInside } from "./companion-git";
import { listWorktreeFolders } from "./companion-worktrees";

/** What a size scan, a process listing or a free-space read may take before it is given up. */
const SIZE_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;
const STATFS_TIMEOUT_MS = 10_000;
const GIT_CHECK_TIMEOUT_MS = 10_000;
/** One artifact's deletion may take this long (tens of gigabytes of small files on a slow disk). */
const REMOVE_TIMEOUT_MS = 30 * 60_000;
/** Folders read looking for artifacts in one worktree, and how deep below its root they are looked for. */
const MAX_DIRS_READ = 300;
const MAX_DEPTH = 2;
const MAX_ARTIFACTS = 20;
/** Entries looked at to find the newest file change under a build folder. */
const MAX_MTIME_ENTRIES = 1_500;
const MAX_WORKTREES = 100;
const SIZE_CONCURRENCY = 2;
/** Pids handed to one `lsof`. */
const LSOF_CHUNK = 200;

/** The artifact kinds by folder name, and the file beside it that says it is that project's output. */
const ARTIFACT_RULES: Record<DiskArtifactKind, { marker: string; mustBeIgnored: boolean }> = {
	target: { marker: "Cargo.toml", mustBeIgnored: false },
	node_modules: { marker: "package.json", mustBeIgnored: false },
	".next": { marker: "package.json", mustBeIgnored: false },
	dist: { marker: "package.json", mustBeIgnored: true },
	build: { marker: "package.json", mustBeIgnored: true },
};

export const ARTIFACT_NAMES = Object.keys(ARTIFACT_RULES) as DiskArtifactKind[];

const isArtifactName = (name: string): name is DiskArtifactKind => Object.hasOwn(ARTIFACT_RULES, name);

/** What cargo leaves in a `target` folder: any of these says it is cargo's, not a folder that happens to share the name. */
const CARGO_TARGET_SIGNS = ["CACHEDIR.TAG", ".rustc_info.json", "debug", "release"];

// ── free space ───────────────────────────────────────────────────────────────

export interface FreeSpace {
	/** Identifies the volume. */
	key: string;
	freeBytes: number;
	totalBytes: number;
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
	let timer: Timer | undefined;
	const deadline = new Promise<null>(resolve => {
		timer = setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** Free space of the volume `folder` is on (its nearest existing ancestor when it does not exist yet); null when it cannot be read in time. */
export async function readFreeSpace(folder: string): Promise<FreeSpace | null> {
	let at = path.resolve(folder);
	for (;;) {
		try {
			const stat = await fs.stat(at);
			const space = await withDeadline(fs.statfs(at), STATFS_TIMEOUT_MS);
			if (space === null) return null;
			const block = Number(space.bsize);
			return {
				key: String(stat.dev),
				freeBytes: Number(space.bavail) * block,
				totalBytes: Number(space.blocks) * block,
			};
		} catch (err) {
			const parent = path.dirname(at);
			if (parent === at || (err as NodeJS.ErrnoException).code !== "ENOENT") return null;
			at = parent;
		}
	}
}

// ── child processes ──────────────────────────────────────────────────────────

interface Ran {
	out: string;
	code: number;
	/** Killed at the deadline: what it printed is incomplete. */
	timedOut: boolean;
}

/** Run `command` with a deadline; null when it cannot be started. */
async function run(command: string[], timeoutMs: number): Promise<Ran | null> {
	try {
		const proc = Bun.spawn(command, {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		const out = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return { out, code, timedOut: proc.signalCode !== null };
	} catch {
		return null;
	}
}

/** Bytes a folder takes on disk (`du`, not following symlinks, staying on one volume); null when it did not finish in `timeoutMs`. */
export async function measureBytes(dir: string, timeoutMs: number = SIZE_TIMEOUT_MS): Promise<number | null> {
	const ran = await run(["du", "-sk", "-x", "--", dir], timeoutMs);
	if (ran === null || ran.timedOut) return null;
	const kilobytes = Number.parseInt(ran.out, 10);
	return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

// ── worktrees and artifacts ──────────────────────────────────────────────────

/** True when `tree` is a linked worktree: its `.git` is a file naming `<repo>/.git/worktrees/<name>` (a submodule's names `modules/…`). */
export async function isLinkedWorktree(tree: string): Promise<boolean> {
	try {
		const dotGit = path.join(tree, ".git");
		if (!(await fs.lstat(dotGit)).isFile()) return false;
		const text = await Bun.file(dotGit).slice(0, 4096).text();
		const match = /^gitdir:\s*(.+)$/m.exec(text);
		if (match === null) return false;
		const gitdir = path.resolve(tree, match[1]!.trim());
		return path.basename(path.dirname(gitdir)) === "worktrees" && (await fs.stat(path.join(gitdir, "HEAD"))).isFile();
	} catch {
		return false;
	}
}

/** The worktrees folders with symlinks resolved; one that does not exist is left out. */
async function realBases(dirs: readonly string[]): Promise<string[]> {
	const bases = await Promise.all(dirs.map(dir => fs.realpath(dir).catch(() => null)));
	return bases.filter((base): base is string => base !== null);
}

/**
 * The linked worktrees at `<dir>/<repo>/<name>` under the folders worktrees live in, with symlinks resolved. One that
 * resolves to a place outside those folders (a symlink left in one) is not listed.
 */
export async function listWorktrees(dirs: readonly string[]): Promise<string[]> {
	const bases = await realBases(dirs);
	const found = new Set<string>();
	for (const folder of (await listWorktreeFolders(dirs)).slice(0, MAX_WORKTREES)) {
		const resolved = await fs.realpath(folder).catch(() => null);
		if (resolved === null || !bases.some(base => resolved !== base && isInside(base, resolved))) continue;
		if (await isLinkedWorktree(resolved)) found.add(resolved);
	}
	return [...found];
}

/** `<repo>` and `<name>` of a worktree at `<dir>/<repo>/<name>`. */
export function worktreeNames(tree: string): { repo: string; name: string } {
	return { repo: path.basename(path.dirname(tree)), name: path.basename(tree) };
}

async function readNames(dir: string): Promise<{ names: Set<string>; folders: string[] } | null> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		// A symlink is neither a folder nor a file here: it is never looked into or deleted.
		return {
			names: new Set(entries.map(entry => entry.name)),
			folders: entries.filter(entry => entry.isDirectory()).map(entry => entry.name),
		};
	} catch {
		return null;
	}
}

async function looksLikeCargoTarget(dir: string): Promise<boolean> {
	const inside = await readNames(dir);
	return inside !== null && CARGO_TARGET_SIGNS.some(sign => inside.names.has(sign));
}

/** git's verdict on `relative` in `tree`: it holds no tracked file, and (`mustBeIgnored`) git ignores it. Anything unclear is a no. */
async function isOnlyOutput(tree: string, relative: string, mustBeIgnored: boolean): Promise<boolean> {
	const tracked = await git(tree, ["ls-files", "-z", "--", relative], {
		maxBytes: 64,
		timeoutMs: GIT_CHECK_TIMEOUT_MS,
	});
	if (tracked.code !== 0 || tracked.truncated || tracked.out.length > 0) return false;
	if (!mustBeIgnored) return true;
	// check-ignore takes paths, not pathspecs, and refuses the helper's `--literal-pathspecs`; `./` keeps a folder named like pathspec magic a plain path.
	const ignored = await git(tree, ["--no-literal-pathspecs", "check-ignore", "-q", "--", `./${relative}`], {
		timeoutMs: GIT_CHECK_TIMEOUT_MS,
	});
	return ignored.code === 0;
}

/**
 * Rebuildable build output in the worktree `tree` (symlinks resolved): at its root and up to two folders down (a
 * monorepo's packages), never inside another artifact or `.git`. Bounded by {@link MAX_DIRS_READ} folders read.
 */
export async function findArtifacts(tree: string): Promise<{ path: string; kind: DiskArtifactKind }[]> {
	const found: { path: string; kind: DiskArtifactKind }[] = [];
	const queue: { dir: string; depth: number }[] = [{ dir: tree, depth: 0 }];
	let read = 0;
	for (let next = queue.shift(); next !== undefined && read < MAX_DIRS_READ; next = queue.shift()) {
		read++;
		const listing = await readNames(next.dir);
		if (listing === null) continue;
		for (const name of listing.folders) {
			const here = path.join(next.dir, name);
			if (isArtifactName(name)) {
				const rule = ARTIFACT_RULES[name];
				if (!listing.names.has(rule.marker)) continue;
				if (name === "target" && !(await looksLikeCargoTarget(here))) continue;
				if (!(await isOnlyOutput(tree, path.relative(tree, here), rule.mustBeIgnored))) continue;
				if (found.length < MAX_ARTIFACTS) found.push({ path: here, kind: name });
			} else if (next.depth < MAX_DEPTH && !name.startsWith(".")) queue.push({ dir: here, depth: next.depth + 1 });
		}
	}
	return found;
}

/** Measures `dirs` two at a time, giving up on the rest once `budgetMs` has passed since `startedAt`. */
export async function measureAll(
	dirs: readonly string[],
	options: {
		measure: (dir: string) => Promise<number | null>;
		startedAt: number;
		budgetMs: number;
		now: () => number;
	},
): Promise<Map<string, number | null>> {
	const sizes = new Map<string, number | null>();
	const queue = [...dirs];
	const worker = async (): Promise<void> => {
		for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
			sizes.set(dir, options.now() - options.startedAt >= options.budgetMs ? null : await options.measure(dir));
		}
	};
	await Promise.all(Array.from({ length: Math.min(SIZE_CONCURRENCY, queue.length) }, worker));
	return sizes;
}

export function toArtifacts(
	found: readonly { path: string; kind: DiskArtifactKind }[],
	sizes: ReadonlyMap<string, number | null>,
): DiskArtifact[] {
	return found.map(item => ({ path: item.path, kind: item.kind, bytes: sizes.get(item.path) ?? null }));
}

// ── how recently a worktree was used ─────────────────────────────────────────

/** Newest modification time under `dir` (itself, its entries, and theirs): a cheap, bounded sign of the last build. */
export async function newestChange(dir: string): Promise<number> {
	let newest = 0;
	let looked = 0;
	const visit = async (folder: string, depth: number): Promise<void> => {
		const stat = await fs.lstat(folder).catch(() => null);
		if (stat === null) return;
		newest = Math.max(newest, stat.mtimeMs);
		if (depth >= 2 || !stat.isDirectory()) return;
		const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (looked++ >= MAX_MTIME_ENTRIES) return;
			const child = path.join(folder, entry.name);
			if (entry.isDirectory()) await visit(child, depth + 1);
			else newest = Math.max(newest, (await fs.lstat(child).catch(() => null))?.mtimeMs ?? 0);
		}
	};
	await visit(dir, 0);
	return newest;
}

/** The worktree's own git activity: its HEAD and index (in the repository's `worktrees/<name>` folder) and its top folder. */
export async function gitActivity(tree: string): Promise<number> {
	const times: number[] = [(await fs.stat(tree).catch(() => null))?.mtimeMs ?? 0];
	try {
		const text = await Bun.file(path.join(tree, ".git")).slice(0, 4096).text();
		const match = /^gitdir:\s*(.+)$/m.exec(text);
		if (match !== null) {
			const gitdir = path.resolve(tree, match[1]!.trim());
			for (const file of ["HEAD", "index"])
				times.push((await fs.stat(path.join(gitdir, file)).catch(() => null))?.mtimeMs ?? 0);
		}
	} catch {
		// no readable .git file: the top folder's time stands
	}
	return Math.max(...times);
}

// ── is anything working in it ────────────────────────────────────────────────

/** A listed session, as far as the guard needs to know. */
export interface DiskSession {
	sessionId: string;
	name: string;
	cwd: string;
	/** null: an omp that predates the field, which counts as working. */
	busy: boolean | null;
	inputRequired: boolean;
}

/** Why a worktree counts as busy; one entry per busy worktree. */
export function busyBySession(trees: readonly string[], sessions: readonly DiskSession[]): Map<string, string> {
	const busy = new Map<string, string>();
	for (const tree of trees) {
		const working = sessions.find(
			session => (session.busy !== false || session.inputRequired) && isInside(tree, session.cwd),
		);
		if (working !== undefined) busy.set(tree, `${working.name} is working in it`);
	}
	return busy;
}

/** A process that has the worktree as its folder or holds a file in it. */
export interface ProcessHit {
	pid: number;
	name: string;
}

/**
 * Tells which of `trees` (symlinks resolved) a process works in. null when the processes could not be listed in time:
 * the caller then treats every worktree as busy.
 */
export type ProcessProbe = (
	trees: readonly string[],
	ignorePids: ReadonlySet<number>,
) => Promise<Map<string, ProcessHit> | null>;

/** Language servers and the like sit in a project all day without building anything: they never make a worktree busy. */
const LANGUAGE_SERVER_RE =
	/(?:^|[/\s])(?:rust-analyzer(?:-proc-macro-srv)?|rls|gopls|clangd|pyright[\w-]*|basedpyright[\w-]*|pylsp|typescript-language-server|tsserver(?:\.js)?|lua-language-server|jdtls|zls|[\w-]+-language-server)(?:\s|$)/;
/** Tools that write files while they run: also checked for the files they hold open, not only their folder. */
const BUILDER_RE =
	/^(?:cargo|rustc|rustdoc|rust-lld|node|bun|deno|npm|npx|pnpm|yarn|python3?|ruby|go|make|cmake|ninja|gradle|java|tsc|vite|esbuild|webpack|next|cc|c\+\+|clang|clang\+\+|ld|tail|less|vi|vim|nvim)$/;

/** Parse `lsof -F pn`: for each process id, the names (paths) it has open. */
export function parseLsof(out: string): Map<number, string[]> {
	const byPid = new Map<number, string[]>();
	let pid = 0;
	for (const line of out.split("\n")) {
		if (line.startsWith("p")) {
			pid = Number.parseInt(line.slice(1), 10);
			if (!byPid.has(pid)) byPid.set(pid, []);
		} else if (line.startsWith("n") && line.charAt(1) === "/") byPid.get(pid)?.push(line.slice(1));
	}
	return byPid;
}

/** `ps` lines: `pid uid args`. */
export function parsePs(out: string): { pid: number; uid: number; args: string }[] {
	return out.split("\n").flatMap(line => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		return match === null ? [] : [{ pid: Number(match[1]), uid: Number(match[2]), args: match[3]!.trim() }];
	});
}

/**
 * The default {@link ProcessProbe}: this user's processes from `ps`, then one `lsof` for their folder and running
 * program and one for the open files of the build tools among them — never `lsof +D`, which walks the tree. Language servers
 * and `ignorePids` (the companion, omp sessions whose state says whether they work) are not looked at.
 */
export const probeProcesses: ProcessProbe = async (trees, ignorePids) => {
	if (trees.length === 0) return new Map();
	const listed = await run(["ps", "-axww", "-o", "pid=,uid=,args="], PROBE_TIMEOUT_MS);
	if (listed === null || listed.timedOut || listed.code !== 0) return null;
	const uid = process.getuid?.() ?? -1;
	const mine = parsePs(listed.out).filter(
		proc => proc.uid === uid && !ignorePids.has(proc.pid) && !LANGUAGE_SERVER_RE.test(proc.args),
	);
	const label = new Map(
		mine.map(proc => {
			const program = proc.args.split(/\s+/)[0] ?? proc.args;
			return [proc.pid, path.basename(program)] as const;
		}),
	);
	const builders = mine.filter(proc => BUILDER_RE.test(label.get(proc.pid) ?? ""));
	const hits = new Map<string, ProcessHit>();
	const scan = async (pids: readonly number[], fds: string): Promise<boolean> => {
		for (let at = 0; at < pids.length; at += LSOF_CHUNK) {
			const chunk = pids.slice(at, at + LSOF_CHUNK);
			const ran = await run(
				["lsof", "-nP", "-w", "-a", "-d", fds, "-p", chunk.join(","), "-F", "pn"],
				PROBE_TIMEOUT_MS,
			);
			// lsof exits 1 when some pid ended meanwhile; what it did print stands.
			if (ran === null || ran.timedOut || ran.code > 1) return false;
			for (const [pid, names] of parseLsof(ran.out)) {
				for (const tree of trees) {
					if (!hits.has(tree) && names.some(name => isInside(tree, name)))
						hits.set(tree, { pid, name: label.get(pid) ?? "a process" });
				}
			}
		}
		return true;
	};
	if (
		!(await scan(
			mine.map(proc => proc.pid),
			"cwd,txt",
		))
	)
		return null;
	if (
		!(await scan(
			builders.map(proc => proc.pid),
			"0-255",
		))
	)
		return null;
	return hits;
};

// ── deleting ─────────────────────────────────────────────────────────────────

/**
 * Delete one build-output folder. Refuses anything that is not exactly an artifact folder
 * (see {@link ARTIFACT_NAMES}) inside a linked worktree under one of `dirs` (the companion's worktrees folders), and
 * resolves symlinks first, so a path that leads out of those folders by a `..`, a symlinked parent or a symlinked
 * artifact is refused. `rm -rf` never follows a symlink it meets inside, and the folder must be on the same volume as
 * its parent (a mount is never crossed).
 * @throws Error saying why it was refused or failed.
 */
export async function removeArtifact(dirs: readonly string[], artifact: string): Promise<void> {
	if (
		typeof artifact !== "string" ||
		!path.isAbsolute(artifact) ||
		artifact.includes("\0") ||
		path.resolve(artifact) !== artifact
	)
		throw new Error("invalid path");
	const name = path.basename(artifact);
	if (!isArtifactName(name)) throw new Error("not a build output folder");
	const stat = await fs.lstat(artifact).catch(() => null);
	if (stat === null) throw new Error("not found");
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("not a folder");
	const real = await fs.realpath(artifact);
	const parent = await fs.realpath(path.dirname(artifact));
	if (real !== path.join(parent, name)) throw new Error("the path leads through a symlink");
	const bases = await realBases(dirs);
	const base = bases.find(candidate => real !== candidate && isInside(candidate, real));
	if (base === undefined) throw new Error("outside the worktrees folder");
	const parts = path.relative(base, real).split(path.sep);
	// <repo>/<worktree>/…/<artifact>, never through `.git` or another artifact.
	if (parts.length < 3 || parts.includes(".git") || parts.slice(2, -1).some(part => isArtifactName(part)))
		throw new Error("not inside a worktree");
	if (!(await isLinkedWorktree(path.join(base, parts[0]!, parts[1]!))))
		throw new Error("not inside a linked worktree");
	if ((await fs.lstat(parent)).dev !== stat.dev) throw new Error("on another volume than its parent");
	const proc = Bun.spawn(["rm", "-rf", "--", real], {
		stdout: "ignore",
		stderr: "pipe",
		stdin: "ignore",
		timeout: REMOVE_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (proc.signalCode !== null) throw new Error("deleting took too long and was stopped");
	if (code !== 0) throw new Error(err.split("\n")[0]?.trim() || `rm failed (${code})`);
}
