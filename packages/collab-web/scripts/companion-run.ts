/**
 * Runnable targets of a session's repository and the runs a paired device starts from them
 * (`run-targets`, `run-start`, `run-output`, `run-stop`, `runs` requests). Only targets this module
 * discovers can run, each as a fixed argument vector: never free text, never through a shell. That does
 * not make a target trustworthy: its script body lives in repository files, and a sandboxed agent can
 * write them, so the app shows the body before running it and no repository a sandboxed session works
 * in is runnable (see {@link checkRunnableRoot}).
 *
 * A run lives in its own process group in the repository root, so Stop reaches the whole tree a
 * script spawned, and the run counts as going until that group is gone, not merely until its leader exits. Output keeps its ANSI colors (the child is asked to color even though it writes to
 * a pipe; the app renders them) and is held in memory in a ring buffer until the companion restarts;
 * stdout and stderr go to one buffer in the order they arrive.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunInfo, RunOutput, RunSource, RunTarget } from "../src/lib/companion";

/** Output kept per run, in characters (about 1 MB of text); older output falls off the front. */
export const RING_CHARS = 1_048_576;
/** Longest piece of output one `run-output` reply carries; the device asks again from `next`. */
export const MAX_READ_CHARS = 256 * 1024;
/** Runs kept per session: the newest ten; a running one is never dropped. */
export const MAX_RUNS_PER_SESSION = 10;
/** Runs kept on the computer across sessions; the oldest finished go first. */
export const MAX_RUNS_TOTAL = 30;
/** Runs going at once on this computer. */
export const MAX_CONCURRENT_RUNS = 3;
/** Time between SIGTERM and SIGKILL of a stopped run's process group. */
export const STOP_GRACE_MS = 3_000;
/** After the process group is gone, how long to wait for its output pipes to drain before giving up on them. */
const DRAIN_MS = 1_000;
/** How often a run whose leader exited is checked for group members still alive. */
const GROUP_POLL_MS = 250;
const JUST_TIMEOUT_MS = 5_000;

/** A target with the exact argument vector it runs; the device only ever sees {@link RunTarget}. */
export interface RunSpec extends RunTarget {
	argv: string[];
}

// ── command lines ───────────────────────────────────────────────────────────

/** Characters that need no quoting in a shell word. */
const PLAIN_WORD_RE = /^[\w@%+=:,./-]+$/;

/** The command as a person would type it: what the confirmation shows and what `runs` lists. */
export function commandLine(argv: readonly string[]): string {
	return argv.map(arg => (PLAIN_WORD_RE.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");
}

// ── discovery ───────────────────────────────────────────────────────────────

/** A target name safe to pass as an argument: no leading dash (it would read as a flag), no spaces or control characters. */
const TARGET_NAME_RE = /^[A-Za-z0-9_@][\w:./@-]*$/;
/** Makefile target names are plainer: file-like targets (with a slash or a pattern) are not tasks. */
const MAKE_NAME_RE = /^[A-Za-z0-9_][\w.-]*$/;
/** Package scripts the package manager runs on install and publish: not tasks to start by hand. */
const LIFECYCLE_SCRIPTS = new Set([
	"preinstall",
	"install",
	"postinstall",
	"prepare",
	"prepublish",
	"prepublishOnly",
	"prepack",
	"postpack",
]);
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];
const JUSTFILES = ["justfile", "Justfile", ".justfile"];

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/** Lockfiles in the order they win when a repository keeps more than one. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["package-lock.json", "npm"],
];

/** Lines of a script or recipe the confirmation shows, and the longest line kept. */
const DETAIL_LINES = 20;
const DETAIL_LINE_CHARS = 300;

/** The text a person confirms before a target runs: its first ~20 lines, with a note when cut. */
function clipDetail(lines: readonly string[]): string {
	const flat = lines
		.flatMap(line => line.split("\n"))
		.map(l => (l.length > DETAIL_LINE_CHARS ? `${l.slice(0, DETAIL_LINE_CHARS)}…` : l));
	if (flat.length <= DETAIL_LINES) return flat.join("\n");
	return `${flat.slice(0, DETAIL_LINES).join("\n")}\n… ${flat.length - DETAIL_LINES} more lines`;
}

async function exists(file: string): Promise<boolean> {
	return fs.stat(file).then(
		s => s.isFile(),
		() => false,
	);
}

/** The package manager the repository uses: its lockfile, then the `packageManager` field, then npm. */
export async function detectPackageManager(root: string, pkg: { packageManager?: unknown }): Promise<PackageManager> {
	for (const [file, manager] of LOCKFILES) if (await exists(path.join(root, file))) return manager;
	if (typeof pkg.packageManager === "string") {
		const name = pkg.packageManager.split("@")[0];
		if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return name;
	}
	return "npm";
}

async function packageTargets(root: string): Promise<RunSpec[]> {
	let pkg: { scripts?: unknown; packageManager?: unknown };
	try {
		pkg = JSON.parse(await Bun.file(path.join(root, "package.json")).text()) as typeof pkg;
	} catch {
		return [];
	}
	if (
		typeof pkg !== "object" ||
		pkg === null ||
		typeof pkg.scripts !== "object" ||
		pkg.scripts === null ||
		Array.isArray(pkg.scripts)
	)
		return [];
	const scripts = pkg.scripts as Record<string, unknown>;
	const manager = await detectPackageManager(root, pkg);
	const targets: RunSpec[] = [];
	for (const name of Object.keys(scripts)) {
		if (typeof scripts[name] !== "string" || !TARGET_NAME_RE.test(name) || LIFECYCLE_SCRIPTS.has(name)) continue;
		// `pretest` and `posttest` run by themselves around `test`.
		const hooked = /^(?:pre|post)(.+)$/.exec(name);
		if (hooked && Object.hasOwn(scripts, hooked[1])) continue;
		const argv = [manager, "run", name];
		// The package manager also runs `pre<name>` and `post<name>`: they are part of what starts.
		const body = [`pre${name}`, name, `post${name}`]
			.filter(key => typeof scripts[key] === "string")
			.map(key => `${key}: ${scripts[key]}`);
		targets.push({
			id: `package:${name}`,
			source: "package",
			name,
			command: commandLine(argv),
			detail: clipDetail(body),
			argv,
		});
	}
	return targets;
}

/**
 * Targets of the first Makefile: a line `name:` (or `a b:`) at column 0 that is not an assignment, a
 * pattern rule or a dot-target, with its rule line and recipe lines (the first rule naming a target wins).
 */
export function parseMakefile(text: string): Array<{ name: string; lines: string[] }> {
	const found: Array<{ name: string; lines: string[] }> = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const rule = /^([^\s#:=][^:=#]*?)\s*:(?![=:])/.exec(lines[i]);
		if (!rule) continue;
		const body = [lines[i].trimEnd()];
		for (let j = i + 1; j < lines.length && (lines[j].startsWith("\t") || lines[j].trim() === ""); j++) {
			if (lines[j].trim() !== "") body.push(lines[j].trimEnd());
		}
		for (const name of rule[1].split(/\s+/)) {
			if (MAKE_NAME_RE.test(name) && !found.some(t => t.name === name)) found.push({ name, lines: body });
		}
	}
	return found;
}

async function makeTargets(root: string): Promise<RunSpec[]> {
	for (const file of MAKEFILES) {
		let text: string;
		try {
			text = await Bun.file(path.join(root, file)).text();
		} catch {
			continue;
		}
		return parseMakefile(text).map(({ name, lines }) => {
			const argv = ["make", name];
			return {
				id: `make:${name}`,
				source: "make",
				name,
				command: commandLine(argv),
				detail: clipDetail(lines),
				argv,
			};
		});
	}
	return [];
}

interface JustRecipe {
	private?: boolean;
	parameters?: Array<{ kind?: string; default?: unknown }>;
}

/** Recipes `just` can start without arguments, from its JSON dump. */
export function parseJustDump(json: string): string[] {
	let dump: { recipes?: Record<string, JustRecipe> };
	try {
		dump = JSON.parse(json) as typeof dump;
	} catch {
		return [];
	}
	const recipes = dump?.recipes;
	if (typeof recipes !== "object" || recipes === null) return [];
	return Object.keys(recipes).filter(name => {
		const recipe = recipes[name];
		if (!TARGET_NAME_RE.test(name) || name.startsWith("_") || recipe?.private === true) return false;
		// A parameter without a default must be typed in; a variadic `*` one may stay empty.
		return (recipe?.parameters ?? []).every(
			p => p.kind === "star" || (p.default !== null && p.default !== undefined),
		);
	});
}

/** `just --dump --dump-format json` in `root`; empty when `just` fails (an old version, a broken justfile). */
async function dumpJust(root: string, just: string): Promise<string> {
	try {
		const proc = Bun.spawn([just, "--dump", "--dump-format", "json"], {
			cwd: root,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: JUST_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? out : "";
	} catch {
		return "";
	}
}

/** The text of one recipe, as `just --show` prints it. */
async function showJust(root: string, just: string, name: string): Promise<string> {
	try {
		const proc = Bun.spawn([just, "--show", name], {
			cwd: root,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: JUST_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? out.trimEnd() : "";
	} catch {
		return "";
	}
}

export interface DiscoverDeps {
	/** Path of an executable on PATH, or null; `just` targets exist only when it is found. */
	which?: (command: string) => string | null;
	/** JSON `just` dumps for the justfile in `root`. */
	justDump?: (root: string, just: string) => Promise<string>;
	/** The text of recipe `name`. */
	justShow?: (root: string, just: string, name: string) => Promise<string>;
}

/** Everything runnable in `root`, grouped by source in the order package.json, Makefile, justfile, Cargo. */
export async function discoverTargets(root: string, deps: DiscoverDeps = {}): Promise<RunSpec[]> {
	const which = deps.which ?? ((command: string) => Bun.which(command));
	const justDump = deps.justDump ?? dumpJust;
	const justShow = deps.justShow ?? showJust;
	const targets = [...(await packageTargets(root)), ...(await makeTargets(root))];
	const just = which("just");
	if (just !== null) {
		for (const file of JUSTFILES) {
			if (!(await exists(path.join(root, file)))) continue;
			for (const name of parseJustDump(await justDump(root, just))) {
				const argv = ["just", name];
				const recipe = await justShow(root, just, name);
				targets.push({
					id: `just:${name}`,
					source: "just",
					name,
					command: commandLine(argv),
					detail: clipDetail(recipe === "" ? ["(recipe text unavailable)"] : recipe.split("\n")),
					argv,
				});
			}
			break;
		}
	}
	if (await exists(path.join(root, "Cargo.toml"))) {
		for (const name of ["test", "build"]) {
			const argv = ["cargo", name];
			targets.push({ id: `cargo:${name}`, source: "cargo", name, command: commandLine(argv), argv });
		}
	}
	return targets;
}

/** What the device sees of a target. */
export function toTarget({ id, source, name, command, detail }: RunSpec): RunTarget {
	return detail === undefined ? { id, source, name, command } : { id, source, name, command, detail };
}

export function isRunSource(value: unknown): value is RunSource {
	return value === "package" || value === "make" || value === "just" || value === "cargo";
}

// ── output ──────────────────────────────────────────────────────────────────

/**
 * The last {@link RING_CHARS} characters of a run's output. Positions are absolute character
 * counts since the run began, so a device that polls from the `next` it was given never misses or
 * repeats text; asking from before the oldest kept position gets the oldest kept text, flagged.
 */
export class OutputRing {
	#chunks: string[] = [];
	/** Position of the first kept character. */
	#start = 0;
	#end = 0;
	readonly #cap: number;

	constructor(cap = RING_CHARS) {
		this.#cap = cap;
	}

	/** Position after the last character. */
	get end(): number {
		return this.#end;
	}

	/** Position of the oldest kept character. */
	get start(): number {
		return this.#start;
	}

	push(text: string): void {
		if (text === "") return;
		this.#chunks.push(text);
		this.#end += text.length;
		let excess = this.#end - this.#start - this.#cap;
		while (excess > 0) {
			const first = this.#chunks[0];
			if (first.length <= excess) {
				this.#chunks.shift();
				this.#start += first.length;
				excess -= first.length;
				continue;
			}
			// Never start on the low half of a surrogate pair.
			const cut = isLowSurrogate(first.charCodeAt(excess)) ? excess + 1 : excess;
			this.#chunks[0] = first.slice(cut);
			this.#start += cut;
			excess = 0;
		}
	}

	/** Up to `limit` characters from position `from`. `truncated`: `from` was older than what is kept. */
	read(from: number, limit = MAX_READ_CHARS): { text: string; from: number; next: number; truncated: boolean } {
		const truncated = from < this.#start;
		const begin = Math.min(Math.max(from, this.#start), this.#end);
		let text = "";
		let position = this.#start;
		for (const chunk of this.#chunks) {
			const chunkEnd = position + chunk.length;
			if (chunkEnd > begin && text.length < limit) {
				text += chunk.slice(Math.max(0, begin - position), Math.max(0, begin - position) + (limit - text.length));
			}
			position = chunkEnd;
			if (text.length >= limit) break;
		}
		// Never end between the halves of a surrogate pair: the next read starts with the low half.
		if (text.length === limit && text.length > 0 && isHighSurrogate(text.charCodeAt(text.length - 1)))
			text = text.slice(0, -1);
		return { text, from: begin, next: begin + text.length, truncated };
	}
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

// ── environment ─────────────────────────────────────────────────────────────

/**
 * Variable names that hold credentials. A heuristic over names only: values a script reads from files
 * (`~/.npmrc`, ssh keys, the keychain) are as reachable as ever, and `SSH_AUTH_SOCK` is kept on purpose
 * since scripts may need git over ssh.
 */
const SECRET_NAME_RE =
	/(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|_AUTH$|_PAT$|_DSN$|^DATABASE_URL$|^NPM_CONFIG__AUTH)/i;

/**
 * The environment a run gets: the companion's own minus variables whose names look like credentials,
 * so what the companion happened to be launched with is not handed to every script a phone starts.
 * Color is forced on since the output goes to a pipe and the app renders it.
 */
export function runEnv(base: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined || SECRET_NAME_RE.test(name) || name === "NO_COLOR") continue;
		env[name] = value;
	}
	env.FORCE_COLOR = "1";
	env.CLICOLOR_FORCE = "1";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

// ── where runs may happen ───────────────────────────────────────────────────

/** A listed session as far as run safety is concerned. */
export interface RunSession {
	cwd: string;
	sandboxed?: boolean;
}

/** True when `target` is `base` or lies beneath it; both symlink-resolved. */
function within(base: string, target: string): boolean {
	const rel = path.relative(base, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Refuse a repository root a sandboxed session works in. The files that define targets (package.json,
 * Makefile, justfile, Cargo.toml, and the bunfig/npmrc/cargo config around them) are writable by that
 * session's agent, which is confined to file tools precisely so it cannot run code: running its repository's
 * scripts would hand it that. A sandboxed session confined to a folder above the repository counts too.
 * `rootOf` resolves a folder to its repository root (symlinks resolved), as the caller resolved `root`.
 */
export async function checkRunnableRoot(
	root: string,
	sessions: readonly RunSession[],
	rootOf: (cwd: string) => Promise<string>,
): Promise<void> {
	for (const session of sessions) {
		if (session.sandboxed !== true) continue;
		const sessionRoot = await rootOf(session.cwd).catch(() => null);
		if (sessionRoot !== null && (sessionRoot === root || within(sessionRoot, root))) {
			throw new Error("A sandboxed session works in this repository, so its scripts cannot be run from the app.");
		}
	}
}

// ── runs ────────────────────────────────────────────────────────────────────

interface RunRecord {
	info: RunInfo;
	ring: OutputRing;
	/** Process group id (the leader's pid); null when nothing started. */
	pgid: number | null;
	stopRequested: boolean;
	killTimer: Timer | undefined;
}

export interface RunManagerOptions {
	/** Targets of a repository root; defaults to {@link discoverTargets}. */
	discover?: (root: string) => Promise<RunSpec[]>;
	env?: Record<string, string | undefined>;
	graceMs?: number;
	maxConcurrent?: number;
	now?: () => number;
	/** How often the group of a run whose leader exited is checked. */
	groupPollMs?: number;
}

export interface RunManager {
	targets(root: string): Promise<RunTarget[]>;
	/**
	 * Start the listed target `targetId` of `root`. Refused when it is not listed, too many runs are going, or its
	 * current `detail` is not the `detail` the device confirmed (absent for targets without one): the files changed.
	 */
	start(instanceId: string, root: string, targetId: unknown, detail?: unknown): Promise<RunInfo>;
	/** Output from `from`; `from` is a position as returned in `next`. */
	output(runId: unknown, from: unknown): RunOutput;
	/** SIGTERM the run's process group, SIGKILL it after the grace period. */
	stop(runId: unknown): RunInfo;
	/** The session's recent runs, newest first. */
	list(instanceId: string): RunInfo[];
	/** Forget finished runs of sessions that are not in `listed` any more. */
	retain(listed: ReadonlySet<string>): void;
	/** Terminate every running run (the companion is exiting). */
	stopAll(): void;
}

/** A process group has members while signal 0 reaches it (ESRCH once all are gone). */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		// EPERM: members exist that this user cannot signal.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Already gone.
	}
}

export function createRunManager(options: RunManagerOptions = {}): RunManager {
	const discover = options.discover ?? ((root: string) => discoverTargets(root));
	const graceMs = options.graceMs ?? STOP_GRACE_MS;
	const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_RUNS;
	const groupPollMs = options.groupPollMs ?? GROUP_POLL_MS;
	const now = options.now ?? Date.now;
	const runs = new Map<string, RunRecord>();

	const running = (): number => [...runs.values()].filter(r => r.info.state === "running").length;

	/** Drop the oldest finished runs of `records` beyond `keep`. */
	function evict(records: RunRecord[], keep: number): void {
		let extra = records.length - keep;
		for (const record of records) {
			if (extra <= 0) break;
			if (record.info.state === "running") continue;
			runs.delete(record.info.runId);
			extra--;
		}
	}

	/** Map order is start order, so the first finished records are the oldest. */
	function prune(instanceId: string): void {
		evict(
			[...runs.values()].filter(r => r.info.instanceId === instanceId),
			MAX_RUNS_PER_SESSION,
		);
		evict([...runs.values()], MAX_RUNS_TOTAL);
	}

	function record(runId: unknown): RunRecord {
		const found = typeof runId === "string" ? runs.get(runId) : undefined;
		if (!found) throw new Error("unknown run (the companion restarted since)");
		return found;
	}

	async function pump(reader: ReadableStreamDefaultReader<Uint8Array>, ring: OutputRing): Promise<void> {
		// Streaming: a multi-byte character split between two reads is decoded whole.
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				ring.push(decoder.decode(value, { stream: true }));
			}
			ring.push(decoder.decode());
		} catch {
			// The reader was cancelled after the drain period.
		}
	}

	/** Resolves once no member of the group is left. */
	async function groupGone(pgid: number): Promise<void> {
		while (groupAlive(pgid)) await Bun.sleep(groupPollMs);
	}

	async function supervise(r: RunRecord, proc: Bun.Subprocess<"ignore", "pipe", "pipe">, pgid: number): Promise<void> {
		const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
		const drained = Promise.all(readers.map(reader => pump(reader, r.ring)));
		await proc.exited;
		// Members the script left behind keep the run going (and keep its output flowing) until they end or are stopped.
		await groupGone(pgid);
		// A process outside the group (it called setsid) may hold the pipes open: take what arrives, then stop waiting.
		await Promise.race([drained, Bun.sleep(DRAIN_MS)]);
		for (const reader of readers) void reader.cancel().catch(() => undefined);
		clearTimeout(r.killTimer);
		r.killTimer = undefined;
		const signal = proc.signalCode;
		r.info = {
			...r.info,
			state: r.stopRequested ? "stopped" : "exited",
			exitCode: signal ? null : proc.exitCode,
			signal: signal ?? null,
			endedAt: now(),
		};
		prune(r.info.instanceId);
	}

	return {
		async targets(root) {
			return (await discover(root)).map(toTarget);
		},

		async start(instanceId, root, targetId, detail) {
			if (typeof targetId !== "string" || (detail !== undefined && typeof detail !== "string"))
				throw new Error("invalid target");
			const spec = (await discover(root)).find(t => t.id === targetId);
			if (!spec) throw new Error("That target is not runnable in this repository.");
			if (spec.detail !== detail) throw new Error("The script changed since you opened Run; review it again.");
			if (running() >= maxConcurrent)
				throw new Error(`${maxConcurrent} runs are already going on this computer; stop one first.`);
			const r: RunRecord = {
				info: {
					runId: randomUUID(),
					instanceId,
					targetId: spec.id,
					command: spec.command,
					startedAt: now(),
					endedAt: null,
					state: "running",
					exitCode: null,
					signal: null,
				},
				ring: new OutputRing(),
				pgid: null,
				stopRequested: false,
				killTimer: undefined,
			};
			runs.set(r.info.runId, r);
			prune(instanceId);
			try {
				const proc = Bun.spawn(spec.argv, {
					cwd: root,
					env: runEnv(options.env ?? process.env),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					// Its own process group: Stop reaches everything the script spawned.
					detached: true,
				});
				r.pgid = proc.pid;
				void supervise(r, proc, proc.pid);
			} catch (err) {
				r.ring.push(`${spec.command}: ${err instanceof Error ? err.message : String(err)}\n`);
				r.info = { ...r.info, state: "failed", endedAt: now() };
			}
			return r.info;
		},

		output(runId, from) {
			const r = record(runId);
			if (typeof from !== "number" || !Number.isInteger(from) || from < 0) throw new Error("invalid position");
			return { run: r.info, ...r.ring.read(from) };
		},

		stop(runId) {
			const r = record(runId);
			if (r.info.state !== "running" || r.pgid === null || r.stopRequested) return r.info;
			r.stopRequested = true;
			const pgid = r.pgid;
			// The group, even when its leader has exited: that is when members linger unseen.
			signalGroup(pgid, "SIGTERM");
			// A member may ignore SIGTERM: the group gets SIGKILL either way.
			r.killTimer = setTimeout(() => {
				r.killTimer = undefined;
				if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
			}, graceMs);
			return r.info;
		},

		list(instanceId) {
			return [...runs.values()]
				.filter(r => r.info.instanceId === instanceId)
				.map(r => r.info)
				.sort((a, b) => b.startedAt - a.startedAt);
		},

		retain(listed) {
			for (const [runId, r] of runs) {
				if (r.info.state !== "running" && !listed.has(r.info.instanceId)) runs.delete(runId);
			}
		},

		stopAll() {
			for (const r of runs.values()) {
				if (r.info.state === "running" && r.pgid !== null) signalGroup(r.pgid, "SIGTERM");
			}
		},
	};
}
