import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	autostartCommand,
	autostartEnabled,
	autostartEntry,
	autostartFile,
	execArgument,
	setAutostart,
} from "../src/main/autostart";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-desktop-test-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("autostartFile", () => {
	it("is in the XDG config directory, or ~/.config", () => {
		expect(autostartFile("/home/me", {})).toBe("/home/me/.config/autostart/omp-collab.desktop");
		expect(autostartFile("/home/me", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/autostart/omp-collab.desktop");
		expect(autostartFile("/home/me", { XDG_CONFIG_HOME: "relative" })).toBe(
			"/home/me/.config/autostart/omp-collab.desktop",
		);
	});
});

describe("autostartCommand", () => {
	const installed = { packaged: true, exe: "/opt/omp/omp-collab", appPath: "/opt/omp/resources/app.asar" };

	it("starts a packaged app through its launcher, hidden", () => {
		expect(autostartCommand({ ...installed, launcherExists: () => true })).toEqual([
			"/opt/omp/omp-collab-launch",
			"--hidden",
		]);
	});

	it("falls back to the executable when the launcher is missing", () => {
		expect(autostartCommand({ ...installed, launcherExists: () => false })).toEqual([
			"/opt/omp/omp-collab",
			"--hidden",
		]);
	});

	it("points an unpackaged app's Electron at the app directory", () => {
		expect(
			autostartCommand({
				packaged: false,
				exe: "/x/electron",
				appPath: "/repo/collab-desktop",
				launcherExists: () => true,
			}),
		).toEqual(["/x/electron", "/repo/collab-desktop", "--hidden"]);
	});
});

describe("execArgument", () => {
	it("leaves a plain argument alone and quotes one with reserved characters", () => {
		expect(execArgument("/opt/omp/omp-collab-launch")).toBe("/opt/omp/omp-collab-launch");
		expect(execArgument("--hidden")).toBe("--hidden");
		expect(execArgument("/home/me/my apps/omp")).toBe('"/home/me/my apps/omp"');
	});

	it("escapes the characters a quoted Exec argument must, with the file's own backslash escaping on top", () => {
		expect(execArgument('/a b/"c"')).toBe('"/a b/\\\\"c\\\\""');
		expect(execArgument("/a b/$HOME")).toBe('"/a b/\\\\$HOME"');
		expect(execArgument("/a b/c\\d")).toBe('"/a b/c\\\\\\\\d"');
		expect(execArgument("/a b/`x`")).toBe('"/a b/\\\\`x\\\\`"');
	});

	it("doubles percent signs, which would otherwise be field codes", () => {
		expect(execArgument("/a/100%")).toBe('"/a/100%%"');
	});
});

describe("Open at Login on Linux", () => {
	it("writes an entry that starts the app hidden, reports it enabled, and removes it", () => {
		const file = autostartFile(tmp(), {});
		expect(autostartEnabled(file)).toBe(false);

		setAutostart(file, autostartEntry("omp collab", ["/opt/my apps/omp-collab-launch", "--hidden"]));
		const text = fs.readFileSync(file, "utf8");
		expect(text).toContain("[Desktop Entry]");
		expect(text).toContain("Name=omp collab");
		expect(text).toContain('Exec="/opt/my apps/omp-collab-launch" --hidden');
		expect(text).toContain("X-GNOME-Autostart-enabled=true");
		expect(autostartEnabled(file)).toBe(true);

		setAutostart(file, null);
		expect(fs.existsSync(file)).toBe(false);
		expect(autostartEnabled(file)).toBe(false);
		expect(() => setAutostart(file, null)).not.toThrow();
	});

	it("reports an entry the session has been told to skip as off", () => {
		const dir = tmp();
		const file = path.join(dir, "omp-collab.desktop");
		for (const line of ["Hidden=true", "X-GNOME-Autostart-enabled=false"]) {
			fs.writeFileSync(file, `[Desktop Entry]\nType=Application\n${line}\n`);
			expect(autostartEnabled(file)).toBe(false);
		}
	});
});
