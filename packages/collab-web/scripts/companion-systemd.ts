/**
 * Linux systemd user unit for the companion: `--install` writes
 * `~/.config/systemd/user/omp-collab-companion.service`, enables it and starts it so the companion runs at
 * login (at boot with lingering) and restarts if it dies; `--uninstall` removes it. Output goes to the user journal.
 */

import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const SYSTEMD_UNIT = "omp-collab-companion.service";

/** Longest wait the `systemctl` probes get before they count as hung. */
const SYSTEMCTL_TIMEOUT_MS = 30_000;
/** Seconds systemd waits before it starts a dead companion again. */
const RESTART_SEC = 5;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters a unit file cannot carry
const UNQUOTABLE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function unitPath(env: Record<string, string | undefined> = process.env): string {
	const xdg = env.XDG_CONFIG_HOME;
	const config = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
	return path.join(config, "systemd", "user", SYSTEMD_UNIT);
}

/** Where to read the companion's output. */
export function systemdLogHint(): string {
	return `journalctl --user -u ${SYSTEMD_UNIT} -f`;
}

/** A word as systemd reads it between double quotes: C escapes, and `%` (specifiers) doubled; `$` too when `expand`. */
export function quoteUnitWord(word: string, expand: boolean): string {
	if (UNQUOTABLE_RE.test(word))
		throw new Error(`cannot put control characters in a systemd unit: ${JSON.stringify(word)}`);
	const escaped = word
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "\\r")
		.replace(/%/g, "%%");
	return `"${expand ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export interface UnitSpec {
	/** Absolute argv the unit runs: the executable, then its arguments. */
	argv: string[];
	/** Environment the service runs with. */
	env: Record<string, string>;
}

/**
 * The unit text. A user unit takes no `User=`. `KillMode=process`: stopping or restarting the companion must not take
 * the tmux sessions it started down with it (they live in its control group). `SuccessExitStatus=143`: the companion
 * exits 143 on SIGTERM, which is a clean stop, not a failure.
 */
export function buildUnit(spec: UnitSpec): string {
	// systemd refuses quotes and backslashes in the executable path, and takes it literally: `$VAR` is expanded
	// only in the arguments, so `$` is doubled there and not here.
	if (/["'\\]/.test(spec.argv[0] ?? "")) {
		throw new Error(`systemd cannot run an executable whose path has quotes or backslashes: ${spec.argv[0]}`);
	}
	const exec = spec.argv.map((arg, i) => quoteUnitWord(arg, i > 0)).join(" ");
	const env = Object.entries(spec.env).map(([name, value]) => {
		if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name for a systemd unit: ${name}`);
		return `Environment=${quoteUnitWord(`${name}=${value}`, false)}`;
	});
	return `[Unit]
Description=omp collab companion

[Service]
Type=simple
ExecStart=${exec}
WorkingDirectory=%h
${env.join("\n")}
Restart=always
RestartSec=${RESTART_SEC}
KillMode=process
SuccessExitStatus=143
SyslogIdentifier=omp-collab-companion

[Install]
WantedBy=default.target
`;
}

/** systemd started this process as the companion's unit: `INVOCATION_ID` is set and the cgroup is the unit's. */
export function isSystemdManaged(
	env: Record<string, string | undefined> = process.env,
	cgroup: () => string = readOwnCgroup,
): boolean {
	if (!env.INVOCATION_ID) return false;
	return cgroup()
		.split("\n")
		.some(line => line.endsWith(`/${SYSTEMD_UNIT}`));
}

function readOwnCgroup(): string {
	try {
		return readFileSync("/proc/self/cgroup", "utf8");
	} catch {
		return "";
	}
}

interface SystemctlResult {
	code: number;
	out: string;
	err: string;
}

/** `systemctl --user` needs `XDG_RUNTIME_DIR` to find the user manager; `su`, `sudo -u` and `docker exec` leave it out. */
function managerEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	const uid = process.getuid?.();
	if (!env.XDG_RUNTIME_DIR && uid !== undefined) env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
	return env;
}

async function run(command: string, args: string[]): Promise<SystemctlResult> {
	const proc = Bun.spawn([command, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: managerEnv(),
		timeout: SYSTEMCTL_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: out.trim(), err: err.trim() };
}

const systemctl = (args: string[]) => run("systemctl", ["--user", ...args]);

/** Why the user manager cannot be used, or null when it answers. */
export async function systemdUnavailable(): Promise<string | null> {
	if (Bun.which("systemctl") === null) return "systemctl is not installed";
	try {
		const probe = await systemctl(["show-environment"]);
		if (probe.code === 0) return null;
		return probe.err || `systemctl --user exited with ${probe.code}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** `argv` as one shell command line, for the by-hand instructions. */
function shellLine(argv: string[]): string {
	return argv.map(arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** The message `--install` fails with when there is no usable user manager. */
export function noSystemdMessage(reason: string, argv: string[]): string {
	return [
		`--install needs a running systemd user manager (\`systemctl --user\`), and it is not available: ${reason}`,
		"This happens on WSL without systemd, in containers, and over `su`/`sudo` without a login session.",
		`Run the companion by hand instead, for example inside tmux, so it outlives this terminal:\n  tmux new-session -d -s omp-companion ${shellLine(argv)}`,
		`or in the foreground:\n  ${shellLine(argv)}`,
	].join("\n");
}

/** Restart the unit without waiting (`--no-block`): the caller is the process systemd is about to stop. */
export async function restartSystemdService(): Promise<void> {
	const result = await systemctl(["restart", "--no-block", SYSTEMD_UNIT]);
	if (result.code !== 0) throw new Error(`systemctl restart failed: ${result.err || `exit ${result.code}`}`);
}

export interface SystemdInstallOptions extends UnitSpec {
	/** Print the unit instead of writing and starting it. */
	dryRun: boolean;
}

export interface SystemdInstall {
	unitPath: string;
	unit: string;
	/** Things the user should still do or know after the install. */
	notes: string[];
}

async function lingerNote(): Promise<string[]> {
	const uid = process.getuid?.() ?? os.userInfo().uid;
	try {
		const linger = await run("loginctl", ["show-user", String(uid), "--property=Linger", "--value"]);
		if (linger.code !== 0 || linger.out === "yes") return [];
	} catch {
		return [];
	}
	return [
		"to keep the companion running without a login session (after a reboot, or once you log out), run: loginctl enable-linger $USER",
	];
}

/** Write the unit, reload systemd, enable the unit and (re)start it. */
export async function installSystemdService(options: SystemdInstallOptions): Promise<SystemdInstall> {
	const unit = buildUnit(options);
	const file = unitPath();
	if (options.dryRun) return { unitPath: file, unit, notes: [] };

	const unavailable = await systemdUnavailable();
	if (unavailable !== null) throw new Error(noSystemdMessage(unavailable, options.argv));
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, unit, { mode: 0o644 });
	for (const args of [["daemon-reload"], ["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
		const result = await systemctl(args);
		if (result.code !== 0) {
			throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.err || `exit ${result.code}`}`);
		}
	}
	return { unitPath: file, unit, notes: await lingerNote() };
}

/** Stop and disable the unit and delete it; true when a unit file existed. */
export async function uninstallSystemdService(): Promise<boolean> {
	const file = unitPath();
	const existed = await Bun.file(file).exists();
	const live = (await systemdUnavailable()) === null;
	if (live) await systemctl(["disable", "--now", SYSTEMD_UNIT]);
	await fs.rm(file, { force: true });
	if (live) {
		await systemctl(["daemon-reload"]);
		await systemctl(["reset-failed", SYSTEMD_UNIT]);
	}
	return existed;
}
