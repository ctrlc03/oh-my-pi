/**
 * macOS LaunchAgent for the companion: `--install` writes
 * `~/Library/LaunchAgents/sh.omp.collab-companion.plist` and loads it so the
 * companion starts at login and restarts if it dies; `--uninstall` removes it.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const LAUNCH_LABEL = "sh.omp.collab-companion";

export function launchAgentPath(): string {
	return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}

export function launchLogPath(): string {
	return path.join(os.homedir(), "Library", "Logs", "omp-collab-companion.log");
}

export interface LaunchAgentSpec {
	/** Absolute path of the bun executable. */
	bun: string;
	/** Absolute path of `companion.ts`. */
	script: string;
	/** Environment the agent runs with (launchd starts it with an almost empty one). */
	env: Record<string, string>;
	logPath: string;
}

function xml(text: string): string {
	return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** The agent's property list. */
export function buildPlist(spec: LaunchAgentSpec): string {
	const env = Object.entries(spec.env)
		.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(spec.bun)}</string>
		<string>${xml(spec.script)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${env}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xml(spec.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

/** PATH for the agent: where bun, omp, tmux and git live, then the caller's PATH and the system dirs. */
export function agentPath(tools: (string | null)[]): string {
	const dirs = [
		...tools.filter((t): t is string => t !== null).map(t => path.dirname(t)),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		...(process.env.PATH ?? "").split(":"),
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	];
	return [...new Set(dirs.filter(Boolean))].join(":");
}

async function launchctl(args: string[]): Promise<{ code: number; err: string }> {
	const proc = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code, err: err.trim() };
}

function domain(): string {
	return `gui/${process.getuid?.() ?? os.userInfo().uid}`;
}

/** launchd started this process: it names the job it runs in `XPC_SERVICE_NAME`. */
export function isLaunchManaged(): boolean {
	return process.platform === "darwin" && process.env.XPC_SERVICE_NAME === LAUNCH_LABEL;
}

/** Kill the running agent so launchd starts it again (`launchctl kickstart -k`); the caller is that process. */
export async function restartLaunchAgent(): Promise<void> {
	const result = await launchctl(["kickstart", "-k", `${domain()}/${LAUNCH_LABEL}`]);
	if (result.code !== 0) throw new Error(`launchctl kickstart failed: ${result.err || `exit ${result.code}`}`);
}

export interface InstallOptions {
	/** Absolute omp executable the agent should run sessions with. */
	ompBin: string;
	script: string;
	/** Print the plist instead of writing and loading it. */
	dryRun: boolean;
}

/** Write the plist and (re)load the agent; returns the plist path and text. */
export async function installLaunchAgent(options: InstallOptions): Promise<{ plistPath: string; plist: string }> {
	if (process.platform !== "darwin") throw new Error("--install is for macOS (launchd) only");
	if (!path.isAbsolute(options.ompBin) || !(await Bun.file(options.ompBin).exists())) {
		throw new Error(`omp not found at ${options.ompBin}; set OMP_BIN to its absolute path and retry`);
	}
	const tools = [process.execPath, options.ompBin, Bun.which("tmux"), Bun.which("git")];
	const env: Record<string, string> = { OMP_BIN: options.ompBin, PATH: agentPath(tools) };
	if (process.env.PI_CONFIG_DIR) env.PI_CONFIG_DIR = process.env.PI_CONFIG_DIR;
	const plist = buildPlist({ bun: process.execPath, script: options.script, env, logPath: launchLogPath() });
	const plistPath = launchAgentPath();
	if (options.dryRun) return { plistPath, plist };

	await fs.mkdir(path.dirname(plistPath), { recursive: true });
	await fs.mkdir(path.dirname(launchLogPath()), { recursive: true });
	await fs.writeFile(plistPath, plist, { mode: 0o644 });
	// bootout returns before the agent is gone, and bootstrapping meanwhile fails with an I/O error.
	await launchctl(["bootout", `${domain()}/${LAUNCH_LABEL}`]);
	for (let i = 0; i < 20 && (await launchctl(["print", `${domain()}/${LAUNCH_LABEL}`])).code === 0; i++) {
		await Bun.sleep(250);
	}
	const boot = await launchctl(["bootstrap", domain(), plistPath]);
	if (boot.code !== 0) throw new Error(`launchctl bootstrap failed: ${boot.err || `exit ${boot.code}`}`);
	return { plistPath, plist };
}

/** Unload the agent and delete its plist; true when a plist existed. */
export async function uninstallLaunchAgent(): Promise<boolean> {
	if (process.platform !== "darwin") throw new Error("--uninstall is for macOS (launchd) only");
	await launchctl(["bootout", `${domain()}/${LAUNCH_LABEL}`]);
	const plistPath = launchAgentPath();
	const existed = await Bun.file(plistPath).exists();
	await fs.rm(plistPath, { force: true });
	return existed;
}
