/**
 * Open at Login on Linux. Electron's login-item API covers macOS and Windows only, so on Linux the app keeps an XDG
 * autostart entry (`$XDG_CONFIG_HOME/autostart/omp-collab.desktop`) that the desktop session runs at login. The entry
 * starts the app with `--hidden`, which is what makes it start in the tray instead of opening the window.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const AUTOSTART_ENTRY = "omp-collab.desktop";
/** The installer's launcher next to the executable (it adds `--no-sandbox` only where Chromium needs it). */
export const LAUNCHER = "omp-collab-launch";

export function autostartFile(home: string, env: NodeJS.ProcessEnv): string {
	const config = env.XDG_CONFIG_HOME;
	return path.join(
		config !== undefined && path.isAbsolute(config) ? config : path.join(home, ".config"),
		"autostart",
		AUTOSTART_ENTRY,
	);
}

/**
 * The command the session runs at login. A packaged app goes through its launcher; an unpackaged one (development) is
 * the Electron binary pointed at the app directory.
 */
export function autostartCommand(app: {
	packaged: boolean;
	exe: string;
	appPath: string;
	launcherExists: (file: string) => boolean;
}): string[] {
	if (!app.packaged) return [app.exe, app.appPath, "--hidden"];
	const launcher = path.join(path.dirname(app.exe), LAUNCHER);
	return [app.launcherExists(launcher) ? launcher : app.exe, "--hidden"];
}

/** One argument of an `Exec` line: quoted when it holds a reserved character, with `%` doubled (field codes). */
export function execArgument(arg: string): string {
	const field = arg.replaceAll("%", "%%");
	if (!/[\s"'\\><~|&;$*?#()`%]/.test(arg)) return field;
	// The Exec quoting escapes ", `, $ and \ with a backslash, and the file's own string escaping then doubles every backslash.
	return `"${field.replace(/["`$\\]/g, "\\$&").replaceAll("\\", "\\\\")}"`;
}

export function autostartEntry(name: string, command: string[]): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		`Name=${name}`,
		`Exec=${command.map(execArgument).join(" ")}`,
		"Terminal=false",
		"X-GNOME-Autostart-enabled=true",
		"",
	].join("\n");
}

/** The entry exists and the session has not been told to skip it (`Hidden=true`, GNOME's `X-GNOME-Autostart-enabled=false`). */
export function autostartEnabled(file: string): boolean {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return false;
	}
	return !/^\s*(Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/im.test(text);
}

/** Writes the entry, or removes the file when `entry` is null. */
export function setAutostart(file: string, entry: string | null): void {
	if (entry === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, entry);
}
