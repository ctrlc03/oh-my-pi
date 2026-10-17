/**
 * The process and file-system side of running the companion: the real implementations of what the supervisor and
 * the resolver take as parameters. No Electron here.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { appUrl, type DiscoveryDeps, type LocalEndpoint, pidExists } from "./companion-endpoint";
import type { LockDeps } from "./companion-lock";
import { type CompanionCommand, companionEnv } from "./companion-resolve";
import type { ChildHandle, ServiceStart } from "./companion-supervisor";
import { parseLocalLink } from "./pairing";
import type { RunResult } from "./updater";

const PROBE_TIMEOUT_MS = 2_000;
const HELP_TIMEOUT_MS = 20_000;
const LINK_TIMEOUT_MS = 30_000;
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

export function discoveryDeps(): DiscoveryDeps {
	return {
		readFile: async file => {
			try {
				return await fs.promises.readFile(file, "utf8");
			} catch {
				return null;
			}
		},
		alive: pid => pidExists(process.kill.bind(process), pid),
		probe: async url => {
			try {
				// Any answer proves something listens there; the status says nothing (the app may still be building).
				await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
				return true;
			} catch {
				return false;
			}
		},
	};
}

export async function isRunnable(file: string): Promise<boolean> {
	try {
		await fs.promises.access(file, fs.constants.X_OK);
		return (await fs.promises.stat(file)).isFile();
	} catch {
		return false;
	}
}

/** `<file> companion --help` exits 0: the build has the companion (an upstream omp does not). */
export function hasCompanion(file: string, env: Record<string, string>): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	execFile(file, ["companion", "--help"], { env, timeout: HELP_TIMEOUT_MS }, (error, stdout) => {
		resolve(error === null && /companion/i.test(stdout));
	});
	return promise;
}

/** Run a command to completion; never rejects. */
export function run(command: string, args: string[]): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(command, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
		const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
		resolve({ code, out: `${stdout}${stderr}` });
	});
	return promise;
}

/** Keep a log file from growing without bound: past the limit the old one becomes `<file>.1`. */
export function rotateLog(file: string): void {
	try {
		if (fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, `${file}.1`);
	} catch {
		// no log yet
	}
}

/**
 * Start the companion detached, with its output going straight to `logFile` (the file is private to the user: a
 * companion started by hand prints a one-time pairing link at start). Detached so that it can outlive the app when
 * the user keeps it running; the app stops it itself otherwise.
 */
export function spawnCompanion(
	command: CompanionCommand,
	options: { home: string; baseEnv: Record<string, string | undefined>; logFile: string; platform: NodeJS.Platform },
): ChildHandle {
	fs.mkdirSync(path.dirname(options.logFile), { recursive: true, mode: 0o700 });
	rotateLog(options.logFile);
	const fd = fs.openSync(options.logFile, "a", 0o600);
	let child: ChildProcess;
	try {
		child = spawn(command.argv[0]!, command.argv.slice(1), {
			cwd: options.home,
			env: companionEnv(options.baseEnv, command, options.home, options.platform),
			stdio: ["ignore", fd, fd],
			detached: true,
		});
	} finally {
		fs.closeSync(fd);
	}
	let finished = false;
	return {
		pid: child.pid,
		kill: signal => {
			if (!finished) child.kill(signal);
		},
		onExit: listener => {
			const done = (info: { code: number | null; signal: string | null; error?: string }): void => {
				if (finished) return;
				finished = true;
				listener(info);
			};
			child.once("error", err => done({ code: null, signal: null, error: err.message }));
			child.once("exit", (code, signal) => done({ code, signal }));
		},
		release: () => child.unref(),
	};
}

/** Ask the companion for this window's pairing link: `companion --print-local-link`, which issues a one-time invite. */
export function printLocalLink(
	command: CompanionCommand,
	options: {
		home: string;
		baseEnv: Record<string, string | undefined>;
		platform: NodeJS.Platform;
		endpoint: LocalEndpoint;
	},
): Promise<string> {
	const origin = new URL(appUrl(options.endpoint.port)).origin;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(
		command.argv[0]!,
		[...command.argv.slice(1), "--print-local-link"],
		{
			cwd: options.home,
			env: companionEnv(options.baseEnv, command, options.home, options.platform),
			timeout: LINK_TIMEOUT_MS,
		},
		(error, stdout, stderr) => {
			const link = parseLocalLink(stdout, origin);
			if (link !== null) resolve(link);
			else reject(new Error((stderr || stdout || (error?.message ?? "no link printed")).trim().slice(0, 500)));
		},
	);
	return promise;
}

/** Run the companion's own `--uninstall`, which removes the launchd or systemd service and stops the companion it runs. */
export function uninstallService(
	command: CompanionCommand,
	options: { home: string; baseEnv: Record<string, string | undefined>; platform: NodeJS.Platform },
): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(
		command.argv[0]!,
		[...command.argv.slice(1), "--uninstall"],
		{
			cwd: options.home,
			env: companionEnv(options.baseEnv, command, options.home, options.platform),
			timeout: 60_000,
		},
		(error, stdout, stderr) => {
			if (error === null) resolve(stdout.trim());
			else reject(new Error((stderr || stdout || error.message).trim().slice(0, 500)));
		},
	);
	return promise;
}

/** The service files a companion installed as a service leaves, per platform. */
export function serviceFile(home: string, platform: NodeJS.Platform): string | null {
	if (platform === "darwin") return path.join(home, "Library", "LaunchAgents", "sh.omp.collab-companion.plist");
	if (platform === "linux") return path.join(home, ".config", "systemd", "user", "omp-collab-companion.service");
	return null;
}

export function serviceInstalled(home: string, platform: NodeJS.Platform): boolean {
	const file = serviceFile(home, platform);
	return file !== null && fs.existsSync(file);
}

/** Real file, process-table and command-line access for the single-instance lock check. */
export function lockDeps(): LockDeps {
	const { readFile, alive } = discoveryDeps();
	return {
		readFile,
		alive,
		commandLine: async pid => {
			const { promise, resolve } = Promise.withResolvers<string | null>();
			execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
				resolve(error === null && stdout.trim() !== "" ? stdout.trim() : null);
			});
			return promise;
		},
	};
}

export const MAC_SERVICE_LABEL = "sh.omp.collab-companion";
export const LINUX_SERVICE_UNIT = "omp-collab-companion.service";

/**
 * The command that asks the service manager to start the companion service, or null where there is none. It starts
 * a stopped service and leaves a running one alone (launchd's `kickstart` without `-k`, which would kill and restart it).
 */
export function serviceStartCommand(
	platform: NodeJS.Platform,
	uid: number | undefined,
): { command: string; args: string[] } | null {
	if (platform === "darwin" && uid !== undefined)
		return { command: "launchctl", args: ["kickstart", `gui/${uid}/${MAC_SERVICE_LABEL}`] };
	if (platform === "linux") return { command: "systemctl", args: ["--user", "start", LINUX_SERVICE_UNIT] };
	return null;
}

/** launchd's answer to `kickstart` for a job that is not loaded (after `bootout`, or a `bootstrap` that failed). */
export function launchdNotLoaded(result: RunResult): boolean {
	return result.code === 113 || /could not find service/i.test(result.out);
}

const failure = (result: RunResult): ServiceStart => ({
	ok: false,
	message: result.out.trim().slice(0, 300) || `exit ${result.code}`,
});

/**
 * Ask the service manager to start the companion service; never rejects. On macOS a service whose plist exists but
 * is not loaded is loaded first (`launchctl bootstrap`) and then kicked; a service that still will not start is
 * reported as the manager said it. On Linux `systemctl --user start` is reported as is.
 */
export async function startService(
	options: { platform: NodeJS.Platform; uid: number | undefined; plist: string | null },
	exec: (command: string, args: string[]) => Promise<RunResult> = run,
): Promise<ServiceStart> {
	const start = serviceStartCommand(options.platform, options.uid);
	if (start === null) return { ok: false, message: "this platform has no companion service" };
	const result = await exec(start.command, start.args);
	if (result.code === 0) return { ok: true };
	if (options.platform !== "darwin" || options.plist === null || !launchdNotLoaded(result)) return failure(result);
	const loaded = await exec("launchctl", ["bootstrap", `gui/${options.uid}`, options.plist]);
	if (loaded.code !== 0) return failure(loaded);
	const kicked = await exec(start.command, start.args);
	return kicked.code === 0 ? { ok: true } : failure(kicked);
}
