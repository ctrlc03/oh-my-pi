/**
 * The companion as a background service, per platform: a launchd LaunchAgent on macOS, a systemd user unit on Linux.
 * `--install`/`--uninstall`, "was this process started by the service", restarting it, and the user-facing texts
 * that name the right tool for the platform.
 */

import * as path from "node:path";
import { isCompiled } from "./build-identity";
import {
	installLaunchAgent,
	isLaunchManaged,
	launchLogPath,
	restartLaunchAgent,
	uninstallLaunchAgent,
} from "./companion-launchd";
import {
	installSystemdService,
	isSystemdManaged,
	restartSystemdService,
	systemdLogHint,
	uninstallSystemdService,
} from "./companion-systemd";

export type ServiceKind = "launchd" | "systemd";

/** The service manager this platform has, or null where `--install` is unsupported. */
export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | null {
	if (platform === "darwin") return "launchd";
	if (platform === "linux") return "systemd";
	return null;
}

function requireKind(flag: "--install" | "--uninstall"): ServiceKind {
	const kind = serviceKind();
	if (kind === null) throw new Error(`${flag} is for macOS (launchd) and Linux (systemd) only`);
	return kind;
}

/** Which service manager started this process as the companion, or null when it was started by hand. */
export function managedBy(env: Record<string, string | undefined> = process.env): ServiceKind | null {
	if (isLaunchManaged(env)) return "launchd";
	if (isSystemdManaged(env)) return "systemd";
	return null;
}

/** PATH for the service: where bun, omp, tmux and git live, then the caller's PATH and the system dirs. */
export function servicePath(
	tools: (string | null)[],
	platform: NodeJS.Platform = process.platform,
	callerPath: string = process.env.PATH ?? "",
): string {
	const dirs = [
		...tools.filter((t): t is string => t !== null).map(t => path.dirname(t)),
		...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
		"/usr/local/bin",
		...callerPath.split(":"),
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	];
	return [...new Set(dirs.filter(Boolean))].join(":");
}

export interface ServiceInstallOptions {
	/** Absolute omp executable the service should run sessions with. */
	ompBin: string;
	/** Absolute argv the service runs: `[bun, companion.ts]` from a checkout, `[omp, "companion"]` compiled. */
	argv: string[];
	/** Print the service file instead of writing and starting it. */
	dryRun: boolean;
}

export interface ServiceInstall {
	/** The plist or unit file. */
	file: string;
	/** Its text. */
	text: string;
	/** What to tell the user after a real install. */
	lines: string[];
}

/** Write the service file and start the service. */
export async function installService(options: ServiceInstallOptions): Promise<ServiceInstall> {
	const kind = requireKind("--install");
	if (!path.isAbsolute(options.ompBin) || !(await Bun.file(options.ompBin).exists())) {
		throw new Error(`omp not found at ${options.ompBin}; set OMP_BIN to its absolute path and retry`);
	}
	const tools = [process.execPath, options.ompBin, Bun.which("tmux"), Bun.which("git")];
	const env: Record<string, string> = { OMP_BIN: options.ompBin, PATH: servicePath(tools) };
	if (process.env.PI_CONFIG_DIR) env.PI_CONFIG_DIR = process.env.PI_CONFIG_DIR;
	if (kind === "launchd") {
		const { plistPath, plist } = await installLaunchAgent({ argv: options.argv, env, dryRun: options.dryRun });
		return {
			file: plistPath,
			text: plist,
			lines: [
				`LaunchAgent installed (${plistPath}); the companion now starts at login and restarts if it exits`,
				`log: ${launchLogPath()}`,
			],
		};
	}
	const { unitPath, unit, notes } = await installSystemdService({ argv: options.argv, env, dryRun: options.dryRun });
	return {
		file: unitPath,
		text: unit,
		lines: [
			`systemd user unit installed and started (${unitPath}); the companion starts at login and restarts if it exits`,
			`log: ${systemdLogHint()}`,
			...notes,
		],
	};
}

/** Stop the service and delete its file; the message says what happened. */
export async function uninstallService(): Promise<string> {
	const kind = requireKind("--uninstall");
	if (kind === "launchd") {
		return (await uninstallLaunchAgent())
			? "companion LaunchAgent removed"
			: "companion LaunchAgent was not installed";
	}
	return (await uninstallSystemdService())
		? "companion systemd user unit removed"
		: "companion systemd user unit was not installed";
}

/** Restart the service so it starts this companion again; the caller is that process. */
export async function restartService(): Promise<void> {
	const kind = managedBy();
	if (kind === "launchd") await restartLaunchAgent();
	else if (kind === "systemd") await restartSystemdService();
	else throw new Error("the companion is not running under a service manager");
}

/** The command that installs the service, as the user types it. */
export function installCommand(): string {
	return isCompiled ? "omp companion --install" : "bun scripts/companion.ts --install";
}

/** The command that prints a fresh pairing link and QR code, as the user types it. */
export function pairCommand(): string {
	return isCompiled ? "omp companion --pair" : "bun scripts/companion.ts --pair";
}

/** The command that opens the app this computer serves, paired with a fresh one-time invite, as the user types it. */
export function openCommand(): string {
	return isCompiled ? "omp companion --open" : "bun scripts/companion.ts --open";
}

/** What to tell someone whose companion was started by hand and cannot be restarted from the app. */
export function startedByHandHint(platform: NodeJS.Platform = process.platform): string {
	const keeper = platform === "linux" ? "systemd" : "macOS";
	return `This companion was started by hand, so the app cannot restart it. Stop it and start it again in a terminal, or run \`${installCommand()}\` once so ${keeper} keeps it running.`;
}
