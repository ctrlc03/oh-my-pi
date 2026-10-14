/**
 * The process and file-system side of running the companion: the real implementations of what the supervisor and
 * the resolver take as parameters. No Electron here.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { appUrl, type DiscoveryDeps, type LocalEndpoint, pidExists } from "./companion-endpoint";
import { type CompanionCommand, companionEnv } from "./companion-resolve";
import type { ChildHandle } from "./companion-supervisor";
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
