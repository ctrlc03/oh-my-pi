import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_SETTINGS, parseSettings, SettingsStore } from "../src/main/settings";
import {
	DEFAULT_SIZE,
	loadWindowState,
	parseWindowState,
	restoreBounds,
	saveWindowState,
} from "../src/main/window-state";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-test-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseSettings", () => {
	it("falls back to the defaults for missing, unreadable or malformed settings", () => {
		expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings("{")).toEqual(DEFAULT_SETTINGS);
		expect(parseSettings("[]")).toEqual(DEFAULT_SETTINGS);
		expect(
			parseSettings(JSON.stringify({ keepCompanionRunning: "yes", shortcut: 3, ompPath: "relative/omp" })),
		).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps valid fields", () => {
		const parsed = parseSettings(
			JSON.stringify({
				keepCompanionRunning: true,
				notifyFinished: false,
				shortcut: " Alt+X ",
				ompPath: "/opt/omp",
			}),
		);
		expect(parsed).toMatchObject({
			keepCompanionRunning: true,
			notifyFinished: false,
			shortcut: "Alt+X",
			ompPath: "/opt/omp",
			notifyInput: true,
		});
	});
});

describe("SettingsStore", () => {
	it("persists every change, privately", () => {
		const file = path.join(tmp(), "nested", "settings.json");
		const store = new SettingsStore(file);
		store.update({ keepCompanionRunning: true });
		expect(new SettingsStore(file).value.keepCompanionRunning).toBe(true);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe("window state", () => {
	const screen = { x: 0, y: 0, width: 1920, height: 1080 };

	it("restores bounds that are on a screen", () => {
		const saved = { x: 100, y: 80, width: 1000, height: 700, maximized: false };
		expect(restoreBounds(saved, [screen])).toEqual({ x: 100, y: 80, width: 1000, height: 700 });
	});

	it("centres the default size when the screen it was on is gone", () => {
		const saved = { x: 4000, y: 80, width: 1000, height: 700, maximized: false };
		expect(restoreBounds(saved, [screen])).toEqual({
			x: (1920 - DEFAULT_SIZE.width) / 2,
			y: (1080 - DEFAULT_SIZE.height) / 2,
			...DEFAULT_SIZE,
		});
		expect(restoreBounds(null, [{ x: 0, y: 0, width: 800, height: 600 }])).toEqual({
			x: 0,
			y: 0,
			width: 800,
			height: 600,
		});
	});

	it("restores onto a second screen", () => {
		const second = { x: 1920, y: 0, width: 1280, height: 1024 };
		const saved = { x: 2000, y: 40, width: 900, height: 700, maximized: true };
		expect(restoreBounds(saved, [screen, second])).toMatchObject({ x: 2000, y: 40 });
	});

	it("rejects saved state that is not usable, and round-trips a good one", () => {
		expect(parseWindowState(null)).toBeNull();
		expect(parseWindowState("{")).toBeNull();
		expect(parseWindowState(JSON.stringify({ x: 0, y: 0, width: 10, height: 10 }))).toBeNull();
		expect(parseWindowState(JSON.stringify({ x: "0", y: 0, width: 900, height: 900 }))).toBeNull();
		const file = path.join(tmp(), "window.json");
		saveWindowState(file, { x: 5, y: 6, width: 900, height: 700, maximized: true });
		expect(loadWindowState(file)).toEqual({ x: 5, y: 6, width: 900, height: 700, maximized: true });
	});
});
