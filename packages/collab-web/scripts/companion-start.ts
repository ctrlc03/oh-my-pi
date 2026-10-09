/**
 * Starting omp sessions on this computer for the `start` request: a detached
 * tmux session runs `omp` with a companion-owned config overlay that makes it
 * host collab with control access, so the app can attach to it like any other
 * hosted session. The tmux session ends when omp exits.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SAFE_ID_RE } from "./companion-sessions";

const TMUX_FALLBACKS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"];

/** Config overlay (`omp --config`): host every session this companion starts with control access. */
const OVERLAY_YAML = "collab:\n  autoStart: control\n";

/** Path of tmux, or null when it is not installed. */
export async function findTmux(): Promise<string | null> {
	const found = Bun.which("tmux");
	if (found) return found;
	for (const candidate of TMUX_FALLBACKS) if (await Bun.file(candidate).exists()) return candidate;
	return null;
}

async function writeOverlay(overlayPath: string): Promise<void> {
	await fs.mkdir(path.dirname(overlayPath), { recursive: true });
	await fs.writeFile(overlayPath, OVERLAY_YAML, { mode: 0o600 });
	await fs.chmod(overlayPath, 0o600);
}

export interface TmuxLaunch {
	tmux: string;
	ompBin: string;
	/** Companion-owned overlay file, rewritten on every launch. */
	overlayPath: string;
	cwd: string;
	/** Session id to resume; must match {@link SAFE_ID_RE}. */
	resume?: string;
}

/**
 * Validate the request and start omp in a detached tmux session; resolves with
 * the tmux session name and the realpath of the directory it runs in.
 */
export async function launchInTmux(launch: TmuxLaunch): Promise<{ name: string; cwd: string }> {
	if (!path.isAbsolute(launch.cwd) || launch.cwd.includes("\0")) throw new Error("cwd must be an absolute path");
	if (launch.resume !== undefined && !SAFE_ID_RE.test(launch.resume)) throw new Error("invalid session id");
	let cwd: string;
	try {
		cwd = await fs.realpath(launch.cwd);
		if (!(await fs.stat(cwd)).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new Error("folder does not exist on this computer");
	}
	await writeOverlay(launch.overlayPath);

	const name = `omp-${crypto.randomUUID().slice(0, 8)}`;
	// A tmux server that is already running does not pass our environment on to new sessions.
	const env = [`PATH=${process.env.PATH ?? ""}`, `HOME=${os.homedir()}`];
	if (process.env.PI_CONFIG_DIR) env.push(`PI_CONFIG_DIR=${process.env.PI_CONFIG_DIR}`);
	const args = [
		"new-session",
		"-d",
		"-s",
		name,
		"-c",
		cwd,
		...env.flatMap(entry => ["-e", entry]),
		launch.ompBin,
		"--config",
		launch.overlayPath,
		...(launch.resume ? ["-r", launch.resume] : []),
	];
	const proc = Bun.spawn([launch.tmux, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(err.trim() || `tmux exited with ${code}`);
	return { name, cwd };
}

/** Stop a session {@link launchInTmux} started (best effort). */
export async function killTmuxSession(tmux: string, name: string): Promise<void> {
	const proc = Bun.spawn([tmux, "kill-session", "-t", name], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
	await proc.exited;
}
