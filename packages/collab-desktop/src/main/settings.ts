/** The app's own preferences, kept as JSON in its data directory. Unknown or malformed fields fall back to the defaults. */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Settings {
	/** Leave the companion this app started running when the app quits. */
	keepCompanionRunning: boolean;
	/** Show or hide the window from anywhere. */
	globalShortcut: boolean;
	/** The shortcut, as Electron writes accelerators. */
	shortcut: string;
	/** Notify when a session needs input. */
	notifyInput: boolean;
	/** Notify when a session finishes a turn. */
	notifyFinished: boolean;
	/** Look for a newer release on launch and every few hours. */
	checkUpdates: boolean;
	/** An `omp` to run the companion with, when the usual places do not have one. */
	ompPath: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
	keepCompanionRunning: false,
	globalShortcut: true,
	shortcut: "CommandOrControl+Alt+O",
	notifyInput: true,
	notifyFinished: true,
	checkUpdates: true,
	ompPath: null,
};

function flag(raw: Record<string, unknown>, key: keyof Settings, fallback: boolean): boolean {
	const value = raw[key];
	return typeof value === "boolean" ? value : fallback;
}

export function parseSettings(text: string | null): Settings {
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = text === null ? {} : JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			raw = parsed as Record<string, unknown>;
	} catch {
		// unreadable: defaults
	}
	const shortcut =
		typeof raw.shortcut === "string" && raw.shortcut.trim() !== "" ? raw.shortcut.trim() : DEFAULT_SETTINGS.shortcut;
	const ompPath = typeof raw.ompPath === "string" && path.isAbsolute(raw.ompPath) ? raw.ompPath : null;
	return {
		keepCompanionRunning: flag(raw, "keepCompanionRunning", DEFAULT_SETTINGS.keepCompanionRunning),
		globalShortcut: flag(raw, "globalShortcut", DEFAULT_SETTINGS.globalShortcut),
		shortcut,
		notifyInput: flag(raw, "notifyInput", DEFAULT_SETTINGS.notifyInput),
		notifyFinished: flag(raw, "notifyFinished", DEFAULT_SETTINGS.notifyFinished),
		checkUpdates: flag(raw, "checkUpdates", DEFAULT_SETTINGS.checkUpdates),
		ompPath,
	};
}

/** Write `value` as JSON to `file` through a temporary file, so a crash never leaves half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

export function readText(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/** Settings that persist every change. */
export class SettingsStore {
	readonly #file: string;
	#value: Settings;

	constructor(file: string) {
		this.#file = file;
		this.#value = parseSettings(readText(file));
	}

	get value(): Settings {
		return this.#value;
	}

	update(patch: Partial<Settings>): Settings {
		this.#value = { ...this.#value, ...patch };
		writeJsonAtomic(this.#file, this.#value);
		return this.#value;
	}
}
