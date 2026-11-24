/**
 * macOS LaunchAgent for the companion: `--install` writes
 * `~/Library/LaunchAgents/sh.omp.collab-companion.plist` and loads it so the
 * companion starts at login and restarts if it dies; `--uninstall` removes it.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	COMPANION_LAUNCH_LABEL,
	companionLaunchAgentPath,
	launchctl,
	launchDomain,
	reloadCompanionLaunchAgent,
	scheduleCompanionReload,
} from "@oh-my-pi/pi-coding-agent/cli/companion-agent";

export function launchLogPath(): string {
	return path.join(os.homedir(), "Library", "Logs", "omp-collab-companion.log");
}

export interface LaunchAgentSpec {
	/** Absolute argv the agent runs: the executable, then its arguments. */
	argv: string[];
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
	const program = spec.argv.map(arg => `\t\t<string>${xml(arg)}</string>`).join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${COMPANION_LAUNCH_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${program}
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

/** launchd started this process: it names the job it runs in `XPC_SERVICE_NAME`. */
export function isLaunchManaged(env: Record<string, string | undefined> = process.env): boolean {
	return process.platform === "darwin" && env.XPC_SERVICE_NAME === COMPANION_LAUNCH_LABEL;
}

/**
 * Restart the running agent; the caller is that process. Unloading and loading it (not `kickstart -k`) records the
 * current binary's code hash, so the restart also works after the omp binary was replaced underneath it.
 */
export async function restartLaunchAgent(): Promise<void> {
	scheduleCompanionReload(0);
}

export interface LaunchInstallOptions {
	argv: string[];
	env: Record<string, string>;
	/** Print the plist instead of writing and loading it. */
	dryRun: boolean;
}

/** Write the plist and (re)load the agent; returns the plist path and text. */
export async function installLaunchAgent(options: LaunchInstallOptions): Promise<{ plistPath: string; plist: string }> {
	const plist = buildPlist({ argv: options.argv, env: options.env, logPath: launchLogPath() });
	const plistPath = companionLaunchAgentPath();
	if (options.dryRun) return { plistPath, plist };

	await fs.mkdir(path.dirname(plistPath), { recursive: true });
	await fs.mkdir(path.dirname(launchLogPath()), { recursive: true });
	await fs.writeFile(plistPath, plist, { mode: 0o644 });
	await reloadCompanionLaunchAgent(plistPath);
	return { plistPath, plist };
}

/** Unload the agent and delete its plist; true when a plist existed. */
export async function uninstallLaunchAgent(): Promise<boolean> {
	await launchctl(["bootout", `${launchDomain()}/${COMPANION_LAUNCH_LABEL}`]);
	const plistPath = companionLaunchAgentPath();
	const existed = await Bun.file(plistPath).exists();
	await fs.rm(plistPath, { force: true });
	return existed;
}
