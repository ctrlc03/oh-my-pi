/**
 * Sandboxed sessions for the `start` request: omp runs under macOS
 * `sandbox-exec` with a profile that confines file writes to the session
 * folder (plus the omp state omp itself must write) and hides credential
 * stores, and with a config overlay plus `--tools` that leave it only file
 * read/search/edit tools — no shell, eval, browser, or subagents. Execution is
 * denied rather than prompted because any guest with a control link could
 * approve a prompt.
 *
 * Reads are not confined to the folder: omp must read its own install, its
 * config, and its credential store (`agent.db`) to run at all.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Tools a sandboxed omp gets; every other tool, including MCP ones, is withheld. */
const SANDBOX_TOOLS = ["read", "grep", "glob", "edit", "write", "ast_edit", "todo", "ask"];

/**
 * Config overlay for sandboxed sessions, layered after the companion overlay.
 * Defence in depth behind `--tools`: execution tools are denied outright, and
 * any tool above the write tier that slips through still needs approval.
 */
export const SANDBOX_OVERLAY_YAML = `tools:
  approvalMode: write
  approval:
    bash: deny
    python: deny
    eval: deny
    browser: deny
    computer: deny
    task: deny
    debug: deny
bash:
  enabled: false
lsp:
  enabled: false
mcp:
  enableProjectConfig: false
`;

/** Entries under the session folder (at any depth) that run code or configure tools later: kept read-only. */
const PROTECTED_NAMES = [".git", ".omp", ".claude", ".vscode", ".envrc", ".mcp.json"];

/** Credential stores under the home directory a sandboxed session may not read. */
const SECRET_DIRS = [".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".config/gh", ".config/gcloud"];
const SECRET_FILES = [".netrc", ".npmrc", ".pypirc", ".git-credentials"];

/** omp state under the config dir that a running omp writes. */
const STATE_DIRS = [
	"logs",
	"run",
	"collab",
	"cache",
	"agent/sessions",
	"agent/blobs",
	"agent/cache",
	"agent/custom-session-files",
	"agent/terminal-sessions",
	"agent/predict",
];
const STATE_FILES = ["agent/last-changelog-version", "agent/config.yml.lock"];

const DEVICE_FILES = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/ptmx", "/dev/dtracehelper"];

export interface SandboxPaths {
	/** Realpath of the session folder: the only place file edits may land. */
	folder: string;
	home: string;
	/** omp config dir (`~/.omp`). */
	configDir: string;
	/** Realpath of the per-user temp dir. */
	tmpDir: string;
	/** Companion state (room key, VAPID key): unreadable, or the session could take over the companion. */
	companionState: string;
}

/** True when `inner` is `outer` or lies beneath it. */
function within(inner: string, outer: string): boolean {
	return inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
}

/** SBPL string literal; paths that would need escaping are refused instead. */
function str(value: string): string {
	if (/["\\\p{Cc}]/u.test(value)) throw new Error(`unsupported characters in path: ${JSON.stringify(value)}`);
	return `"${value}"`;
}

function regexEscape(value: string): string {
	return value.replace(/[.*+?^$|()[\]{}]/g, "\\$&");
}

/**
 * The `sandbox-exec` profile for one session folder.
 *
 * @throws Error when the folder contains the home or config dir (or lies in
 * the config dir), or a path has characters a profile string cannot hold.
 */
export function sandboxProfile(paths: SandboxPaths): string {
	const { folder, home, configDir, tmpDir } = paths;
	if (within(home, folder) || within(configDir, folder) || within(folder, configDir)) {
		throw new Error("pick a project folder: a sandbox cannot cover your home or omp config folder");
	}
	const sub = (p: string) => `(subpath ${str(p)})`;
	const lit = (p: string) => `(literal ${str(p)})`;
	const names = PROTECTED_NAMES.map(regexEscape).join("|");
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		"(allow file-write*",
		`  ${sub(folder)}`,
		`  ${sub(tmpDir)}`,
		`  ${DEVICE_FILES.map(lit).join(" ")}`,
		'  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/")',
		`  ${STATE_DIRS.map(dir => sub(path.join(configDir, dir))).join(" ")}`,
		`  ${STATE_FILES.map(file => lit(path.join(configDir, file))).join(" ")}`,
		`  (regex #"^${regexEscape(path.join(configDir, "agent"))}/[a-z-]+[.]db(-wal|-shm|-journal)?$"))`,
		`(deny file-write* (regex #"^${regexEscape(folder)}/(.+/)?(${names})(/|$)"))`,
		"(deny file-read*",
		`  ${SECRET_DIRS.map(dir => sub(path.join(home, dir))).join(" ")}`,
		`  ${SECRET_FILES.map(file => lit(path.join(home, file))).join(" ")}`,
		`  ${lit(paths.companionState)})`,
		"",
	].join("\n");
}

/** Realpath, or the path itself when it does not exist (yet). */
async function resolved(p: string): Promise<string> {
	return await fs.realpath(p).catch(() => p);
}

export interface SandboxLaunch extends SandboxPaths {
	/** Companion-owned sandbox overlay, rewritten on every launch. */
	overlayPath: string;
}

/** Write the sandbox overlay; resolves with the argv prefix (`sandbox-exec -p …`) and the omp flags to add. */
export async function prepareSandbox(launch: SandboxLaunch): Promise<{ prefix: string[]; ompArgs: string[] }> {
	const profile = sandboxProfile({
		folder: launch.folder,
		home: await resolved(launch.home),
		configDir: await resolved(launch.configDir),
		tmpDir: await resolved(launch.tmpDir),
		companionState: await resolved(launch.companionState),
	});
	await fs.mkdir(path.dirname(launch.overlayPath), { recursive: true });
	await fs.writeFile(launch.overlayPath, SANDBOX_OVERLAY_YAML, { mode: 0o600 });
	await fs.chmod(launch.overlayPath, 0o600);
	return {
		prefix: [SANDBOX_EXEC, "-p", profile],
		ompArgs: ["--config", launch.overlayPath, "--tools", SANDBOX_TOOLS.join(","), "--no-extensions", "--no-lsp"],
	};
}

/**
 * Pids (of `pids`) whose command line loads the sandbox overlay — omp processes
 * a sandboxed `start` launched. One `ps` call; an empty set when it fails.
 */
export async function sandboxedPids(pids: readonly number[], overlayPath: string): Promise<Set<number>> {
	const found = new Set<number>();
	if (pids.length === 0) return found;
	const proc = Bun.spawn(["ps", "-ww", "-o", "pid=,command=", "-p", pids.join(",")], {
		stdout: "pipe",
		stderr: "ignore",
		stdin: "ignore",
	});
	const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	const marker = ` --config ${overlayPath}`;
	for (const line of out.split("\n")) {
		const match = /^\s*(\d+)\s(.*)$/.exec(line);
		if (!match) continue;
		const command = match[2] as string;
		const at = command.indexOf(marker);
		const end = at + marker.length;
		if (at >= 0 && (end === command.length || command[end] === " ")) found.add(Number(match[1]));
	}
	return found;
}
