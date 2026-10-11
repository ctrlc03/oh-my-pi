/**
 * Settings and housekeeping for the git worktrees the companion creates for
 * sessions: the branch-name prefix and location of new ones, a setup script
 * run once in each new tree, the model that writes commit and pull request
 * text, and an opt-in cleanup that removes trees whose pull request merged or
 * that nobody has touched for a while. Cleanup only ever runs
 * `git worktree remove` (no `--force`) on a clean tree no omp works in, and the
 * branch stays, so a sweep cannot lose work.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GitFlowSettings } from "../src/lib/companion";
import { git, isInside, repoRoot } from "./companion-git";
import { DEFAULT_BRANCH_PREFIX, gh, gitDirs, isDirty, removeWorktree } from "./companion-gitflow";
import { DEFAULT_MESSAGE_MODEL } from "./companion-gitmsg";

export const DEFAULT_GIT_FLOW_SETTINGS: GitFlowSettings = {
	branchPrefix: DEFAULT_BRANCH_PREFIX,
	worktreesDir: null,
	setupScript: "",
	settleScript: "",
	cleanup: { mode: "off", days: 14 },
	messageModel: DEFAULT_MESSAGE_MODEL,
};

/**
 * What the file holds: the settings, the folders worktrees were once created under (so moving the
 * location keeps old ones removable), and the repository scripts the user approved.
 */
export interface GitFlowFile {
	settings: GitFlowSettings;
	previousDirs: string[];
	/** Repository root to the SHA-256 of the `.omp/worktree-setup` the user approved there. */
	trustedSetups: Record<string, string>;
	/** Repository root to the SHA-256 of the `.omp/worktree-settle` the user approved there. */
	trustedSettles: Record<string, string>;
}

const MAX_PREFIX_CHARS = 40;
const MAX_PATH_CHARS = 500;
const MAX_SCRIPT_CHARS = 2_000;
const MAX_MODEL_CHARS = 100;
const MAX_PREVIOUS_DIRS = 20;
const MAX_INACTIVE_DAYS = 365;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const SETTLE_OUTPUT_CHARS = 4_000;
const SETUP_OUTPUT_CHARS = 800;
const GH_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
/** Worktrees checked per sweep; each costs a `gh` call in `merged` mode. */
const MAX_SWEEP = 100;
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Repositories may carry their own setup; it runs in place of the companion's setting only once the user approved it. */
export const PROJECT_SETUP_FILE = path.join(".omp", "worktree-setup");
/** Repositories may carry their own settle cleanup; same approval as the setup script. */
export const PROJECT_SETTLE_FILE = path.join(".omp", "worktree-settle");
const MAX_PROJECT_SCRIPT_CHARS = 20_000;
/** Repositories whose setup script the user can have approved at once. */
const MAX_TRUSTED = 200;

// ── settings ─────────────────────────────────────────────────────────────────

/**
 * The settings in `raw`; `strict` throws on the first invalid field (a device's edit), otherwise
 * a missing or damaged field falls back to its default (the file on disk).
 * @throws Error naming the invalid field in strict mode.
 */
export function parseGitFlowSettings(raw: unknown, strict: boolean): GitFlowSettings {
	const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const defaults = DEFAULT_GIT_FLOW_SETTINGS;
	const pick = <T>(key: string, read: (input: unknown) => T | undefined, fallback: T): T => {
		if (value[key] === undefined && !strict) return fallback;
		const parsed = read(value[key]);
		if (parsed !== undefined) return parsed;
		if (strict) throw new Error(`invalid ${key}`);
		return fallback;
	};
	return {
		branchPrefix: pick("branchPrefix", readPrefix, defaults.branchPrefix),
		worktreesDir: pick("worktreesDir", readDir, defaults.worktreesDir),
		setupScript: pick("setupScript", readScript, defaults.setupScript),
		settleScript: pick("settleScript", readScript, defaults.settleScript),
		cleanup: pick("cleanup", readCleanup, defaults.cleanup),
		messageModel: pick("messageModel", readModel, defaults.messageModel),
	};
}

function readPrefix(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const prefix = input.trim();
	if (prefix === "") return "";
	if (prefix.length > MAX_PREFIX_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix)) return undefined;
	if (prefix.includes("//") || prefix.includes("..") || prefix.endsWith(".") || prefix.endsWith(".lock"))
		return undefined;
	// `feature` means `feature/…`: a prefix glued to the date would read as one word.
	return /[A-Za-z0-9]$/.test(prefix) ? `${prefix}/` : prefix;
}

function readDir(input: unknown): string | null | undefined {
	if (input === null || input === "") return null;
	if (typeof input !== "string" || input.length > MAX_PATH_CHARS || input.includes("\0")) return undefined;
	const expanded = input.trim().startsWith("~/") ? path.join(os.homedir(), input.trim().slice(2)) : input.trim();
	if (!path.isAbsolute(expanded)) return undefined;
	const dir = path.resolve(expanded);
	// Removal refuses a folder that is itself the worktrees root; these two would make every checkout in it fair game.
	return dir === path.parse(dir).root || dir === os.homedir() ? undefined : dir;
}

function readScript(input: unknown): string | undefined {
	if (typeof input !== "string" || input.length > MAX_SCRIPT_CHARS || input.includes("\0")) return undefined;
	return input.trim();
}

function readCleanup(input: unknown): GitFlowSettings["cleanup"] | undefined {
	const value = input as { mode?: unknown; days?: unknown } | null;
	if (typeof value !== "object" || value === null) return undefined;
	if (value.mode !== "off" && value.mode !== "merged" && value.mode !== "inactive") return undefined;
	const days = value.days === undefined ? DEFAULT_GIT_FLOW_SETTINGS.cleanup.days : value.days;
	if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_INACTIVE_DAYS) return undefined;
	return { mode: value.mode, days };
}

function readModel(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const model = input.trim();
	if (model === "") return DEFAULT_MESSAGE_MODEL;
	// Never starts with `-`: the value is an argument of `omp --model`.
	return model.length <= MAX_MODEL_CHARS && /^[A-Za-z0-9@][\w.:/@+-]*$/.test(model) ? model : undefined;
}

/** Approvals from untrusted JSON: absolute repository roots with a SHA-256, at most {@link MAX_TRUSTED}. */
function readApprovals(raw: unknown): Record<string, string> {
	const entries = typeof raw === "object" && raw !== null ? Object.entries(raw) : [];
	return Object.fromEntries(
		entries
			.filter(([root, hash]) => path.isAbsolute(root) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
			.slice(0, MAX_TRUSTED),
	);
}

export function parseGitFlowFile(raw: unknown): GitFlowFile {
	const file = (typeof raw === "object" && raw !== null ? raw : {}) as {
		settings?: unknown;
		previousDirs?: unknown;
		trustedSetups?: unknown;
		trustedSettles?: unknown;
	};
	const previous = Array.isArray(file.previousDirs) ? file.previousDirs : [];
	return {
		settings: parseGitFlowSettings(file.settings, false),
		previousDirs: previous.flatMap(dir => {
			const parsed = readDir(dir);
			return typeof parsed === "string" ? [parsed] : [];
		}),
		trustedSetups: readApprovals(file.trustedSetups),
		trustedSettles: readApprovals(file.trustedSettles),
	};
}

export async function loadGitFlowFile(file: string): Promise<GitFlowFile> {
	try {
		return parseGitFlowFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return parseGitFlowFile(null);
	}
}

export async function saveGitFlowFile(file: string, contents: GitFlowFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

/** Where new worktrees go. */
export function effectiveWorktreesDir(settings: GitFlowSettings, defaultDir: string): string {
	return settings.worktreesDir ?? defaultDir;
}

/** Every folder worktrees may live under: the current one, the default, and past ones. */
export function worktreeLocations(file: GitFlowFile, defaultDir: string): string[] {
	return [...new Set([effectiveWorktreesDir(file.settings, defaultDir), defaultDir, ...file.previousDirs])];
}

/** The file after replacing the settings: the folder worktrees leave behind stays known, so they stay removable. */
export function replaceSettings(file: GitFlowFile, settings: GitFlowSettings, defaultDir: string): GitFlowFile {
	const before = effectiveWorktreesDir(file.settings, defaultDir);
	const moved = before !== effectiveWorktreesDir(settings, defaultDir);
	const previousDirs = moved ? [before, ...file.previousDirs.filter(dir => dir !== before)] : file.previousDirs;
	return {
		settings,
		previousDirs: previousDirs.slice(0, MAX_PREVIOUS_DIRS),
		trustedSetups: file.trustedSetups,
		trustedSettles: file.trustedSettles,
	};
}

// ── setup script ─────────────────────────────────────────────────────────────

/** A repository's own `.omp/worktree-setup`, as read now. */
export interface ProjectSetup {
	root: string;
	/** SHA-256 of `script`: what an approval is bound to. */
	hash: string;
	script: string;
}

export interface SetupOptions {
	/** `settings.setupScript`. */
	command: string;
	/**
	 * Consider the repository's `.omp/worktree-setup` at all. A sandboxed session's agent can write that
	 * file in the checkout, so it must not run on the computer's behalf for one.
	 */
	allowProjectFile: boolean;
	/** The user's approvals: repository root to the hash of the script they approved. */
	trusted: Readonly<Record<string, string>>;
}

export interface SetupResult {
	ran: "project" | "settings" | null;
	/** The repository's script, when it has one this run did not use because the user has not approved this exact content. */
	unapproved: ProjectSetup | null;
}

export function setupHash(script: string): string {
	return createHash("sha256").update(script).digest("hex");
}

/** The repository's script at `file` (relative to `root`); null when it has none, cannot be read, or is over {@link MAX_PROJECT_SCRIPT_CHARS}. */
async function readProjectScript(root: string, file: string): Promise<ProjectSetup | null> {
	try {
		const source = Bun.file(path.join(root, file));
		if (source.size > MAX_PROJECT_SCRIPT_CHARS * 4) return null;
		const script = await source.text();
		return script.length > MAX_PROJECT_SCRIPT_CHARS || script.includes("\0")
			? null
			: { root, hash: setupHash(script), script };
	} catch {
		return null;
	}
}

/** The repository's setup script; null when it has none, cannot be read, or is over {@link MAX_PROJECT_SCRIPT_CHARS}. */
export function readProjectSetup(root: string): Promise<ProjectSetup | null> {
	return readProjectScript(root, PROJECT_SETUP_FILE);
}

/** The repository's `.omp/worktree-settle`, under the same limits as the setup script. */
export function readProjectSettle(root: string): Promise<ProjectSetup | null> {
	return readProjectScript(root, PROJECT_SETTLE_FILE);
}

/**
 * Run the setup of a freshly created worktree, once, in the new tree with `OMP_WORKTREE_PATH`,
 * `OMP_WORKTREE_BRANCH` and `OMP_REPO_ROOT` set: the repository's `.omp/worktree-setup` when the
 * user approved exactly its current content, else the companion's command. A repository file
 * is code someone else wrote, so it never runs on its own: it is reported as `unapproved`. What
 * runs is the text that was hashed, not a second read of the file.
 * Rejects with the end of the output when it fails or takes over five minutes.
 */
export async function runWorktreeSetup(
	created: { root: string; path: string; branch: string },
	options: SetupOptions,
): Promise<SetupResult> {
	const project = options.allowProjectFile ? await readProjectSetup(created.root) : null;
	const approved =
		project !== null &&
		Object.hasOwn(options.trusted, created.root) &&
		options.trusted[created.root] === project.hash;
	const useProject = approved && project !== null;
	const unapproved = project !== null && !useProject ? project : null;
	const script = useProject ? project.script : options.command;
	if (!script) return { ran: null, unapproved };
	const proc = Bun.spawn(["sh", "-c", script, ...(useProject ? [path.join(created.root, PROJECT_SETUP_FILE)] : [])], {
		cwd: created.path,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: {
			...process.env,
			OMP_WORKTREE_PATH: created.path,
			OMP_WORKTREE_BRANCH: created.branch,
			OMP_REPO_ROOT: created.root,
		},
		timeout: SETUP_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code === 0) return { ran: useProject ? "project" : "settings", unapproved };
	const tail = `${out}\n${err}`.trim().slice(-SETUP_OUTPUT_CHARS);
	const reason = proc.signalCode !== null ? "timed out after 5 minutes" : `exit ${code}`;
	throw new Error(
		`worktree setup (${useProject ? PROJECT_SETUP_FILE : "companion setting"}) failed: ${reason}${tail ? `\n${tail}` : ""}`,
	);
}

/** A repository's setup script and where the user's approval of it stands, for review in the app. */
export interface ProjectSetupStatus {
	root: string;
	/** The script now; null when the repository no longer has a readable one. */
	script: string | null;
	hash: string | null;
	/** The stored approval is of exactly this content: the script runs for new worktrees. */
	trusted: boolean;
	/** Some approval is stored for the repository, whether or not it still matches. */
	approved: boolean;
}

async function scriptStatuses(
	approvals: Readonly<Record<string, string>>,
	read: (root: string) => Promise<ProjectSetup | null>,
	waiting: Iterable<string>,
): Promise<ProjectSetupStatus[]> {
	const roots = [...new Set([...Object.keys(approvals), ...waiting])];
	return Promise.all(
		roots.map(async root => {
			const project = await read(root);
			const approved = Object.hasOwn(approvals, root);
			return {
				root,
				script: project?.script ?? null,
				hash: project?.hash ?? null,
				trusted: project !== null && approved && approvals[root] === project.hash,
				approved,
			};
		}),
	);
}

/** Status of every repository with an approval and of `waiting` ones (whose script a start left unused). */
export function projectSetupStatuses(file: GitFlowFile, waiting: Iterable<string>): Promise<ProjectSetupStatus[]> {
	return scriptStatuses(file.trustedSetups, readProjectSetup, waiting);
}

/** {@link projectSetupStatuses} for `.omp/worktree-settle`: `waiting` are repositories a settle left unused. */
export function projectSettleStatuses(file: GitFlowFile, waiting: Iterable<string>): Promise<ProjectSetupStatus[]> {
	return scriptStatuses(file.trustedSettles, readProjectSettle, waiting);
}

/**
 * The file after the user approved (`hash`) or withdrew approval (`null`) for a repository's setup
 * script (`kind` `settle`: its settle script). An approval needs the repository to be one `known`
 * or already approved, and `hash` to still be the script's content, so what runs is what was shown.
 * @throws Error when the request is invalid, the script changed or is gone.
 */
export async function applySetupTrust(
	file: GitFlowFile,
	known: ReadonlySet<string>,
	change: { root: unknown; hash: unknown; kind?: unknown },
): Promise<GitFlowFile> {
	const { root, hash, kind } = change;
	if (
		typeof root !== "string" ||
		!path.isAbsolute(root) ||
		(hash !== null && typeof hash !== "string") ||
		(kind !== undefined && kind !== "setup" && kind !== "settle")
	)
		throw new Error("invalid request");
	const settle = kind === "settle";
	const field = settle ? "trustedSettles" : "trustedSetups";
	const approvals = file[field];
	const others = Object.entries(approvals).filter(([key]) => key !== root);
	if (hash === null) return { ...file, [field]: Object.fromEntries(others) };
	if (!known.has(root) && !Object.hasOwn(approvals, root)) throw new Error("unknown repository");
	const project = await (settle ? readProjectSettle(root) : readProjectSetup(root));
	if (project === null) throw new Error(`the repository has no ${settle ? "settle" : "setup"} script to approve`);
	if (project.hash !== hash) throw new Error("the script changed; review it again");
	if (others.length >= MAX_TRUSTED) throw new Error("too many approved repositories; withdraw some first");
	return { ...file, [field]: Object.fromEntries([...others, [root, hash]]) };
}

// ── settle cleanup ───────────────────────────────────────────────────────────

export interface SettleOptions {
	/** `settings.settleScript`. */
	command: string;
	/** The user's approvals of `.omp/worktree-settle`: repository root to the hash of the script they approved. */
	trusted: Readonly<Record<string, string>>;
	timeoutMs?: number;
}

export interface SettleOutcome {
	source: "settings" | "project";
	status: "ok" | "failed" | "timeout";
	/** Exit code; null when it timed out or could not start. */
	code: number | null;
	startedAt: number;
	durationMs: number;
	/** The end of stdout and stderr together, without terminal colours. */
	output: string;
}

export interface SettleRun {
	/** Null when there was nothing to run. */
	outcome: SettleOutcome | null;
	/** The repository's script, when it has one this run did not use because the user has not approved this exact content. */
	unapproved: ProjectSetup | null;
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** After the command ends, how long to wait for output still held open by something it left running. */
const OUTPUT_GRACE_MS = 1_000;

/** Append what `stream` yields to `tail`, keeping only its last {@link SETTLE_OUTPUT_CHARS} characters. */
async function collectTail(stream: ReadableStream<Uint8Array>, tail: { text: string }): Promise<void> {
	const decoder = new TextDecoder();
	for await (const chunk of stream)
		tail.text = (tail.text + decoder.decode(chunk, { stream: true })).slice(-SETTLE_OUTPUT_CHARS);
}

/**
 * Run the settle cleanup of a worktree whose session settled, in the tree with `OMP_WORKTREE_PATH`,
 * `OMP_WORKTREE_BRANCH` and `OMP_REPO_ROOT` set (`tree.root` is the repository the tree belongs to):
 * the repository's `.omp/worktree-settle` when the user approved exactly its current content, else the
 * companion's command; a repository script that is not approved is reported as `unapproved`, never run.
 * Never rejects: a failing or timing-out command is an outcome. The command runs in its own process group,
 * so a timeout also ends what it started.
 */
export async function runWorktreeSettle(
	tree: { root: string; path: string; branch: string },
	options: SettleOptions,
): Promise<SettleRun> {
	const project = await readProjectSettle(tree.root);
	const useProject =
		project !== null && Object.hasOwn(options.trusted, tree.root) && options.trusted[tree.root] === project.hash;
	const unapproved = project !== null && !useProject ? project : null;
	const script = useProject ? project.script : options.command;
	if (!script) return { outcome: null, unapproved };
	const source = useProject ? "project" : "settings";
	const startedAt = Date.now();
	const finish = (status: SettleOutcome["status"], code: number | null, output: string): SettleRun => ({
		outcome: {
			source,
			status,
			code,
			startedAt,
			durationMs: Date.now() - startedAt,
			output: output.replace(ANSI_RE, "").trim(),
		},
		unapproved,
	});
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(["sh", "-c", script, ...(useProject ? [path.join(tree.root, PROJECT_SETTLE_FILE)] : [])], {
			cwd: tree.path,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			detached: true,
			env: {
				...process.env,
				OMP_WORKTREE_PATH: tree.path,
				OMP_WORKTREE_BRANCH: tree.branch,
				OMP_REPO_ROOT: tree.root,
			},
		});
	} catch (err) {
		return finish("failed", null, err instanceof Error ? err.message : String(err));
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	}, options.timeoutMs ?? SETUP_TIMEOUT_MS);
	const tail = { text: "" };
	const reading = Promise.all([collectTail(proc.stdout, tail), collectTail(proc.stderr, tail)]);
	const code = await proc.exited;
	clearTimeout(timer);
	await Promise.race([reading, Bun.sleep(OUTPUT_GRACE_MS)]);
	if (timedOut) return finish("timeout", null, tail.text);
	return finish(code === 0 ? "ok" : "failed", code, tail.text);
}

// ── pull request state and cleanup ───────────────────────────────────────────

export type PrState = "OPEN" | "MERGED" | "CLOSED" | null;

/**
 * State of the pull requests whose head is `branch`: an open one wins over a merged one,
 * which wins over a closed one. null when there is none or `gh` could not answer.
 */
export async function branchPrState(root: string, branch: string): Promise<PrState> {
	try {
		const result = await gh(
			root,
			["pr", "list", "--head", branch, "--state", "all", "--json", "state", "--limit", "10"],
			GH_TIMEOUT_MS,
		);
		if (result.code !== 0) return null;
		const states = (JSON.parse(result.out) as { state?: unknown }[]).map(pr => pr.state);
		for (const state of ["OPEN", "MERGED", "CLOSED"] as const) if (states.includes(state)) return state;
		return null;
	} catch {
		return null;
	}
}

/** The linked-worktree folders (`<dir>/<repo>/<name>` with a `.git` file) under `dirs`. */
export async function listWorktreeFolders(dirs: readonly string[]): Promise<string[]> {
	const found: string[] = [];
	for (const dir of dirs) {
		const repos = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const repo of repos) {
			if (!repo.isDirectory()) continue;
			const trees = await fs.readdir(path.join(dir, repo.name), { withFileTypes: true }).catch(() => []);
			for (const tree of trees) {
				const folder = path.join(dir, repo.name, tree.name);
				if (tree.isDirectory() && (await fs.stat(path.join(folder, ".git")).catch(() => null))?.isFile())
					found.push(folder);
			}
		}
	}
	return found;
}

/** Latest sign of life in a worktree: its newest commit, checkout, staging or top-level change. */
async function lastActivity(root: string, gitDir: string): Promise<number> {
	const [commit, head, index, folder] = await Promise.all([
		git(root, ["log", "-1", "--format=%ct", "HEAD"]),
		fs.stat(path.join(gitDir, "HEAD")).catch(() => null),
		fs.stat(path.join(gitDir, "index")).catch(() => null),
		fs.stat(root).catch(() => null),
	]);
	const committed = Number(new TextDecoder().decode(commit.out).trim()) * 1000;
	return Math.max(
		Number.isFinite(committed) ? committed : 0,
		head?.mtimeMs ?? 0,
		index?.mtimeMs ?? 0,
		folder?.mtimeMs ?? 0,
	);
}

export interface SweepOptions {
	dirs: readonly string[];
	cleanup: GitFlowSettings["cleanup"];
	/** Working directories of every running omp. */
	runningCwds: string[];
	now: number;
	prState?: (root: string, branch: string) => Promise<PrState>;
}

export interface SweepResult {
	removed: { path: string; branch: string; reason: "merged" | "inactive" }[];
	/** Trees that were due but could not be removed, with why (a failing removal is not retried within the sweep). */
	failed: { path: string; reason: string }[];
}

/**
 * Remove the worktrees `cleanup` says are done: `merged` — the branch's pull request merged; `inactive` —
 * nothing happened in the tree for `days` days. Never touches a tree with uncommitted changes
 * (untracked files included) or one an omp is running in; the branch always stays.
 */
export async function sweepWorktrees(options: SweepOptions): Promise<SweepResult> {
	const result: SweepResult = { removed: [], failed: [] };
	if (options.cleanup.mode === "off") return result;
	const prState = options.prState ?? branchPrState;
	for (const folder of (await listWorktreeFolders(options.dirs)).slice(0, MAX_SWEEP)) {
		try {
			const resolved = await fs.realpath(folder);
			const root = await repoRoot(resolved);
			if (root !== resolved) continue;
			const dirs = await gitDirs(root);
			if (dirs.gitDir === dirs.commonDir) continue;
			if (options.runningCwds.some(cwd => isInside(root, cwd))) continue;
			// A tree with work in it is not a candidate, however old or merged.
			if (await isDirty(root)) continue;
			const head = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
			const branch = new TextDecoder().decode(head.out).trim();
			if (head.code !== 0 || !branch) continue;
			let reason: "merged" | "inactive";
			if (options.cleanup.mode === "merged") {
				if ((await prState(root, branch)) !== "MERGED") continue;
				reason = "merged";
			} else {
				if (options.now - (await lastActivity(root, dirs.gitDir)) < options.cleanup.days * DAY_MS) continue;
				reason = "inactive";
			}
			try {
				await removeWorktree(root, options.dirs, options.runningCwds);
				result.removed.push({ path: root, branch, reason });
			} catch (err) {
				result.failed.push({ path: root, reason: err instanceof Error ? err.message : String(err) });
			}
		} catch {
			// vanished or unreadable meanwhile: not ours to remove
		}
	}
	return result;
}

export interface SweeperOptions {
	settings: () => GitFlowSettings["cleanup"];
	dirs: () => string[];
	/** Working directories of every running omp, from a fresh listing. */
	runningCwds: () => Promise<string[]>;
	now?: () => number;
	onRemoved?: (removed: SweepResult["removed"]) => void;
}

/** Sweeps at most every {@link SWEEP_INTERVAL_MS}, one round at a time; does nothing while cleanup is off. */
export function createWorktreeSweeper(options: SweeperOptions): { tick(force?: boolean): Promise<SweepResult | null> } {
	const now = options.now ?? Date.now;
	let last = 0;
	let running: Promise<SweepResult | null> | null = null;
	return {
		tick(force = false) {
			if (running) return running;
			const cleanup = options.settings();
			if (cleanup.mode === "off" || (!force && now() - last < SWEEP_INTERVAL_MS)) return Promise.resolve(null);
			last = now();
			running = (async () => {
				try {
					const result = await sweepWorktrees({
						dirs: options.dirs(),
						cleanup,
						runningCwds: await options.runningCwds(),
						now: now(),
					});
					if (result.removed.length > 0) options.onRemoved?.(result.removed);
					return result;
				} finally {
					running = null;
				}
			})();
			return running;
		},
	};
}
