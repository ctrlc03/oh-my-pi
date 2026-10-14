/**
 * Starting omp sessions on this computer for the `start` request: a detached
 * tmux session runs `omp` with a companion-owned config overlay that makes it
 * host collab with control access, so the app can attach to it like any other
 * hosted session. The tmux session ends when omp exits. A sandboxed start
 * wraps omp in `sandbox-exec` (see ./companion-sandbox).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MODEL_SELECTOR_RE } from "../src/lib/fanout";
import { prepareSandbox, SANDBOX_EXEC, type SandboxLaunch } from "./companion-sandbox";
import { SAFE_ID_RE } from "./companion-sessions";

const TMUX_FALLBACKS = [
	"/opt/homebrew/bin/tmux",
	"/usr/local/bin/tmux",
	"/usr/bin/tmux",
	"/home/linuxbrew/.linuxbrew/bin/tmux",
];

/** A vendor agent id: a built-in one, or `custom:<slug>`. Matches what `scripts/foreign/agents.ts` hands out. */
export const AGENT_ID_RE = /^(?:claude|codex|cursor|grok|opencode|custom:[a-z0-9-]{1,32})$/;
/** A vendor's own model id (`sonnet`, `gpt-5.1-codex`, `anthropic/claude-sonnet-4-5`, `opus[1m]`): no spaces, no leading dash (it would read as a flag). */
export const FOREIGN_MODEL_RE = /^[A-Za-z0-9_][\w.:/@+[\]-]{0,199}$/;

/**
 * Config overlay (`omp --config`): host every session this companion starts with control access,
 * and also serve it on the companion's local relay when it runs one.
 */
export function overlayYaml(localRelayUrl?: string): string {
	return `collab:\n  autoStart: control\n${localRelayUrl ? `  localRelayUrl: ${JSON.stringify(localRelayUrl)}\n` : ""}`;
}

/** Path of tmux, or null when it is not installed. */
export async function findTmux(): Promise<string | null> {
	const found = Bun.which("tmux");
	if (found) return found;
	for (const candidate of TMUX_FALLBACKS) if (await Bun.file(candidate).exists()) return candidate;
	return null;
}

/** True when this computer can run sandboxed sessions (macOS `sandbox-exec`). */
export async function canSandbox(): Promise<boolean> {
	return process.platform === "darwin" && (await Bun.file(SANDBOX_EXEC).exists());
}

async function writeOverlay(overlayPath: string, localRelayUrl?: string): Promise<void> {
	await fs.mkdir(path.dirname(overlayPath), { recursive: true });
	await fs.writeFile(overlayPath, overlayYaml(localRelayUrl), { mode: 0o600 });
	await fs.chmod(overlayPath, 0o600);
}

/** A tool allowlist and config overlay for a session that may only read the code; see {@link TmuxLaunch.restrict}. */
export interface RestrictLaunch {
	/** Overlay file written for this launch (and removed by the caller). */
	overlayPath: string;
	overlayYaml: string;
	tools: readonly string[];
}

async function prepareRestriction(restrict: RestrictLaunch): Promise<{ ompArgs: string[] }> {
	await fs.mkdir(path.dirname(restrict.overlayPath), { recursive: true, mode: 0o700 });
	await fs.writeFile(restrict.overlayPath, restrict.overlayYaml, { mode: 0o600 });
	await fs.chmod(restrict.overlayPath, 0o600);
	return {
		ompArgs: [
			"--config",
			restrict.overlayPath,
			"--tools",
			restrict.tools.join(","),
			"--no-extensions",
			"--no-lsp",
			"--no-title",
		],
	};
}

export interface TmuxLaunch {
	tmux: string;
	ompBin: string;
	/** Companion-owned overlay file, rewritten on every launch. */
	overlayPath: string;
	/** The companion's local relay (`ws://127.0.0.1:<port>`); sessions started also serve their room there. */
	localRelayUrl?: string;
	cwd: string;
	/** Session id to resume; must match {@link SAFE_ID_RE}. */
	resume?: string;
	/** Run omp sandboxed to `cwd` with file tools only; `folder` is filled in with the resolved cwd. */
	sandbox?: Omit<SandboxLaunch, "folder">;
	/**
	 * Folder (`<config dir>/run/collab-companion`, see `COMPANION_RUN_DIR`) the first-message file is handed over in: private to the
	 * companion, and denied to every sandbox, so a sandboxed session cannot swap a later start's prompt.
	 */
	promptDir: string;
	/** First message omp works on as soon as it is up (`omp … -- <prompt>`); handed over through a file, because tmux refuses commands over ~16 KB. */
	prompt?: string;
	/** Stop the session at a safe point once it has spent this many USD (`omp --max-cost`). */
	maxCostUsd?: number;
	/** Run on this model (`omp --model provider/id`); validated like a fan-out model selector. */
	model?: string;
	/** Run a vendor agent's host (`scripts/foreign/host-main.ts`) instead of omp; `ompBin`, `overlayPath` and `sandbox` then go unused (a vendor agent never runs sandboxed). */
	foreign?: ForeignLaunch;
	/**
	 * Run omp with this tool allowlist and this config overlay (after the companion's) instead of the sandbox's own,
	 * for a session that only reads the code and writes one file (an architecture map's agent). The sandbox, when given,
	 * still confines its writes.
	 */
	restrict?: RestrictLaunch;
	/**
	 * Keep the screen of a process that exits at once, and its tmux session with it, until the caller reads it with
	 * {@link launchEnded} and ends the session ({@link releaseLaunch} or {@link killTmuxSession}). Off: the session ends with its process.
	 */
	keepEnded?: boolean;
}

/** How the detached host of a foreign agent session is started; see `scripts/foreign/host-main.ts`. */
export interface ForeignLaunch {
	/** Command that runs the host, before its flags (see `foreignHostLauncher`): bun and `host-main.ts`, or the compiled omp and its internal subcommand. */
	host: readonly string[];
	/** {@link AGENT_ID_RE}. */
	agent: string;
	permission: "supervised" | "full";
	/** The folder is a worktree the companion created for this session; recorded in the session index. */
	worktree?: boolean;
	/** The relay the session's room goes through. */
	relayUrl?: string;
	/** The web app's address, the base of the links the session prints. */
	webUrl?: string;
	/** Serialized fan-out membership (`{ group, model, agent }`), recorded in the session index. */
	fanout?: string;
}

/**
 * The argv of a foreign host process: every value is a separate positional argument, never part of a shell
 * string, so an agent id, model or folder cannot become a command.
 */
export function foreignHostCommand(
	foreign: ForeignLaunch,
	options: {
		cwd: string;
		resume?: string;
		model?: string;
		maxCostUsd?: number;
		promptFile?: string;
		localRelayUrl?: string;
	},
): string[] {
	return [
		...foreign.host,
		"--agent",
		foreign.agent,
		"--cwd",
		options.cwd,
		...(options.resume !== undefined ? ["--resume", options.resume] : []),
		...(options.model !== undefined ? ["--model", options.model] : []),
		"--permission",
		foreign.permission,
		...(options.maxCostUsd !== undefined ? ["--max-cost", String(options.maxCostUsd)] : []),
		...(options.promptFile !== undefined ? ["--prompt-file", options.promptFile] : []),
		...(foreign.worktree ? ["--worktree"] : []),
		...(foreign.fanout !== undefined ? ["--fanout", foreign.fanout] : []),
		...(foreign.relayUrl !== undefined ? ["--relay", foreign.relayUrl] : []),
		...(foreign.webUrl !== undefined ? ["--web", foreign.webUrl] : []),
		...(options.localRelayUrl !== undefined ? ["--local-relay", options.localRelayUrl] : []),
	];
}

/**
 * Validate the request and start omp in a detached tmux session; resolves with
 * the tmux session name and the realpath of the directory it runs in.
 */
export async function launchInTmux(launch: TmuxLaunch): Promise<{ name: string; cwd: string }> {
	const foreign = launch.foreign;
	if (foreign && (!AGENT_ID_RE.test(foreign.agent) || !["supervised", "full"].includes(foreign.permission)))
		throw new Error("invalid agent");
	if (launch.model !== undefined && !(foreign ? FOREIGN_MODEL_RE : MODEL_SELECTOR_RE).test(launch.model))
		throw new Error("invalid model");
	if (!path.isAbsolute(launch.cwd) || launch.cwd.includes("\0")) throw new Error("cwd must be an absolute path");
	if (launch.resume !== undefined && !SAFE_ID_RE.test(launch.resume)) throw new Error("invalid session id");
	let cwd: string;
	try {
		cwd = await fs.realpath(launch.cwd);
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not a directory");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// macOS privacy protection (TCC) answers EPERM for ~/Documents, ~/Desktop, iCloud Drive and
		// external volumes when the companion runs from launchd without a Full Disk Access grant.
		if (code === "EPERM" || code === "EACCES")
			throw new Error(
				"macOS blocked the companion from this folder: allow bun under System Settings → Privacy & Security → Files and Folders, then restart the companion",
			);
		throw new Error("folder does not exist on this computer");
	}
	if (!foreign) await writeOverlay(launch.overlayPath, launch.localRelayUrl);
	const sandbox = !foreign && launch.sandbox ? await prepareSandbox({ ...launch.sandbox, folder: cwd }) : null;
	const restrict = !foreign && launch.restrict ? await prepareRestriction(launch.restrict) : null;

	const name = `omp-${crypto.randomUUID().slice(0, 8)}`;
	// A tmux server that is already running does not pass our environment on to new sessions.
	const env = [`PATH=${process.env.PATH ?? ""}`, `HOME=${os.homedir()}`];
	if (process.env.PI_CONFIG_DIR) env.push(`PI_CONFIG_DIR=${process.env.PI_CONFIG_DIR}`);
	let promptFile: string | null = null;
	if (launch.prompt !== undefined) {
		await fs.mkdir(launch.promptDir, { recursive: true, mode: 0o700 });
		await fs.chmod(launch.promptDir, 0o700);
		promptFile = path.join(launch.promptDir, `omp-collab-prompt-${crypto.randomUUID()}.txt`);
		await fs.writeFile(promptFile, launch.prompt, { mode: 0o600 });
	}
	const command = foreign
		? foreignHostCommand(foreign, {
				cwd,
				resume: launch.resume,
				model: launch.model,
				maxCostUsd: launch.maxCostUsd,
				promptFile: promptFile ?? undefined,
				localRelayUrl: launch.localRelayUrl,
			})
		: [
				...(sandbox?.prefix ?? []),
				launch.ompBin,
				"--config",
				launch.overlayPath,
				...(restrict?.ompArgs ?? sandbox?.ompArgs ?? []),
				...(launch.resume ? ["-r", launch.resume] : []),
				...(launch.maxCostUsd !== undefined ? ["--max-cost", String(launch.maxCostUsd)] : []),
				...(launch.model !== undefined ? ["--model", launch.model] : []),
			];
	// tmux format-expands `-c` (`#(cmd)` would run in the tmux server, outside any sandbox), so the folder is never a
	// tmux argument: the shell enters it from a positional parameter, which tmux passes on untouched.
	let argv = ["sh", "-c", 'cd -- "$1" || exit 1; shift; exec "$@"', "sh", cwd, ...command];
	// A foreign host reads and deletes its prompt file itself (`--prompt-file`). For omp the shell reads and deletes the
	// file, then becomes omp; `--` keeps a prompt that starts with `-` or `@` literal.
	if (promptFile !== null && !foreign) {
		argv = [
			"sh",
			"-c",
			'cd -- "$1" || exit 1; f=$2; shift 2; p=$(cat "$f") && rm -f "$f" && exec "$@" -- "$p"',
			"sh",
			cwd,
			promptFile,
			...command,
		];
	}
	// With `keepEnded`, `remain-on-exit` (set in the same tmux command, before the pane can die) keeps the output of a
	// process that exits at once, so the caller can say why; `releaseLaunch` (or killing the session) ends that.
	const args = [
		"new-session",
		"-d",
		"-s",
		name,
		...env.flatMap(entry => ["-e", entry]),
		...argv,
		...(launch.keepEnded ? [";", "set-option", "-w", "-t", `=${name}:`, "remain-on-exit", "on"] : []),
	];
	const proc = Bun.spawn([launch.tmux, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) {
		if (promptFile !== null) await fs.rm(promptFile, { force: true });
		throw new Error(err.trim() || `tmux exited with ${code}`);
	}
	return { name, cwd };
}

/** Stop a session {@link launchInTmux} started (best effort). */
export async function killTmuxSession(tmux: string, name: string): Promise<void> {
	const proc = Bun.spawn([tmux, "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
	await proc.exited;
}

async function tmuxOutput(tmux: string, args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn([tmux, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { code, out };
}

/** Longest tail of a dead session's screen kept for an error message. */
const MAX_TAIL_LINES = 8;
const MAX_TAIL_CHARS = 700;

/** The last non-empty lines of a screen as one line of text, short enough for an error message; tmux's own "Pane is dead" banner is left out. */
export function screenTail(screen: string): string {
	const lines = screen
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "" && !line.startsWith("Pane is dead"));
	const tail = lines.slice(-MAX_TAIL_LINES).join(" ");
	return tail.length > MAX_TAIL_CHARS ? `…${tail.slice(-MAX_TAIL_CHARS)}` : tail;
}

/** The tail of what a session {@link launchInTmux} started shows on its screen; empty when there is none to read. */
export async function launchScreen(tmux: string, name: string): Promise<string> {
	const screen = await tmuxOutput(tmux, ["capture-pane", "-p", "-J", "-S", "-", "-t", `=${name}:`]);
	return screen.code === 0 ? screenTail(screen.out) : "";
}

/**
 * Where a session {@link launchInTmux} started stands: null while its process runs, else the tail of its last output
 * (empty when tmux no longer has the session, so there is nothing to read).
 */
export async function launchEnded(tmux: string, name: string): Promise<{ tail: string } | null> {
	const panes = await tmuxOutput(tmux, ["list-panes", "-t", `=${name}:`, "-F", "#{pane_dead}"]);
	if (panes.code !== 0) return { tail: "" };
	if (!panes.out.split("\n").includes("1")) return null;
	return { tail: await launchScreen(tmux, name) };
}

/** What a launch that never hosted shows the user: `what` (no final period) happened, followed by the last output when there is any. */
export function launchFailure(what: string, tail: string): string {
	return tail === "" ? what : `${what}. Last output: ${tail}`;
}

/** The host is up: the tmux session ends with its process again, as for any session. */
export async function releaseLaunch(tmux: string, name: string): Promise<void> {
	await tmuxOutput(tmux, ["set-option", "-w", "-t", `=${name}:`, "remain-on-exit", "off"]);
	// The process may have exited between the host appearing and now: nothing would remove the dead pane.
	if ((await launchEnded(tmux, name)) !== null) await killTmuxSession(tmux, name);
}

/**
 * Runs the tasks of one key one after another, those of different keys at once. A start waits for "the new host in this
 * folder": two starts in the same folder at the same time would both claim the first host to appear.
 */
export function createKeyedLock(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
	const tails = new Map<string, Promise<unknown>>();
	return async (key, task) => {
		const previous = tails.get(key) ?? Promise.resolve();
		const run = previous.then(task);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		tails.set(key, tail);
		try {
			return await run;
		} finally {
			if (tails.get(key) === tail) tails.delete(key);
		}
	};
}

/** Longest first prompt a `start` request may carry. */
export const MAX_START_PROMPT_CHARS = 20_000;

/** The `prompt` of a `start` request: its trimmed text, or undefined when there is none. */
export function parseStartPrompt(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.includes("\0")) throw new Error("invalid prompt");
	const prompt = value.trim();
	if (prompt.length > MAX_START_PROMPT_CHARS)
		throw new Error(`the prompt is over ${MAX_START_PROMPT_CHARS} characters`);
	return prompt === "" ? undefined : prompt;
}
