/**
 * The collab companion's macOS LaunchAgent (`sh.omp.collab-companion`), shared by `omp companion --install` and the
 * binary update.
 *
 * launchd keeps a background-task record per agent with the code hash of the executable it launches. The binary is
 * ad-hoc signed, so every build has a new hash: once the file under the agent is replaced, launchd refuses to spawn it
 * again ("spawn failed", exit 78, "Unable to get updated LWCR … No such process") and `kickstart -k` does not help.
 * Unloading and loading the agent again (`bootout` + `bootstrap`) records the new hash, so an update that replaces
 * the binary an installed agent runs re-registers it.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const COMPANION_LAUNCH_LABEL = "sh.omp.collab-companion";

/** How long a restart scheduled from inside the companion waits, so the reply that triggered it reaches the app. */
const SCHEDULED_RESTART_DELAY_S = 3;

export function companionLaunchAgentPath(): string {
	return path.join(os.homedir(), "Library", "LaunchAgents", `${COMPANION_LAUNCH_LABEL}.plist`);
}

export function launchDomain(): string {
	return `gui/${process.getuid?.() ?? os.userInfo().uid}`;
}

export async function launchctl(args: string[]): Promise<{ code: number; err: string }> {
	const proc = Bun.spawn(["launchctl", ...args], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code, err: err.trim() };
}

/** Unload the agent if it is loaded, then load `plistPath`: launchd starts it (RunAtLoad) with a fresh record. */
export async function reloadCompanionLaunchAgent(plistPath: string): Promise<void> {
	const target = `${launchDomain()}/${COMPANION_LAUNCH_LABEL}`;
	await launchctl(["bootout", target]);
	// bootout returns before the agent is gone, and bootstrapping meanwhile fails with an I/O error.
	for (let i = 0; i < 20 && (await launchctl(["print", target])).code === 0; i++) {
		await Bun.sleep(250);
	}
	const boot = await launchctl(["bootstrap", launchDomain(), plistPath]);
	if (boot.code !== 0) throw new Error(`launchctl bootstrap failed: ${boot.err || `exit ${boot.code}`}`);
}

function xmlString(text: string): string {
	const escaped = text.replace(
		/[&<>"']/g,
		c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
	);
	return `<string>${escaped}</string>`;
}

/** What happened to the companion after the binary was replaced. */
export type CompanionAgentRefresh =
	| { kind: "none" }
	| { kind: "restarted" }
	| { kind: "scheduled" }
	| { kind: "failed"; error: string };

/**
 * Reload the agent from inside its own job (the companion, or a process it started): `bootout` stops the job's
 * process group, so the reload runs in a detached shell of its own after `delaySeconds`.
 */
export function scheduleCompanionReload(delaySeconds: number, plistPath = companionLaunchAgentPath()): void {
	const target = `${launchDomain()}/${COMPANION_LAUNCH_LABEL}`;
	const script = [
		`sleep ${delaySeconds}`,
		`launchctl bootout "$1"`,
		`i=0; while [ $i -lt 20 ] && launchctl print "$1" >/dev/null 2>&1; do sleep 0.25; i=$((i+1)); done`,
		`launchctl bootstrap "$2" "$3"`,
	].join("; ");
	const child = spawn("/bin/sh", ["-c", script, "sh", target, launchDomain(), plistPath], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

/**
 * Re-register the companion's LaunchAgent when it runs `binaryPath`, which was just replaced. From inside the
 * companion's own job (the app's update runs `omp update` as the companion's child) the bootout would kill this
 * process before the bootstrap, so the reload runs in a detached shell a few seconds later instead.
 */
export async function refreshCompanionAgent(
	binaryPath: string,
	env: Record<string, string | undefined> = process.env,
): Promise<CompanionAgentRefresh> {
	if (process.platform !== "darwin") return { kind: "none" };
	const plistPath = companionLaunchAgentPath();
	let plist: string;
	try {
		plist = await Bun.file(plistPath).text();
	} catch {
		return { kind: "none" };
	}
	const real = await fs.realpath(binaryPath).catch(() => binaryPath);
	if (!plist.includes(xmlString(binaryPath)) && !plist.includes(xmlString(real))) return { kind: "none" };

	if (env.XPC_SERVICE_NAME === COMPANION_LAUNCH_LABEL) {
		scheduleCompanionReload(SCHEDULED_RESTART_DELAY_S, plistPath);
		return { kind: "scheduled" };
	}
	try {
		await reloadCompanionLaunchAgent(plistPath);
		return { kind: "restarted" };
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}
