import { describe, expect, it } from "bun:test";
import { serviceStartCommand, startService } from "../src/main/launch";
import type { RunResult } from "../src/main/updater";

describe("serviceStartCommand", () => {
	it("starts the launchd job without killing a running one", () => {
		expect(serviceStartCommand("darwin", 501)).toEqual({
			command: "launchctl",
			args: ["kickstart", "gui/501/sh.omp.collab-companion"],
		});
	});

	it("starts the systemd user unit", () => {
		expect(serviceStartCommand("linux", 1000)).toEqual({
			command: "systemctl",
			args: ["--user", "start", "omp-collab-companion.service"],
		});
	});

	it("has none elsewhere", () => {
		expect(serviceStartCommand("win32", undefined)).toBeNull();
	});
});

describe("startService", () => {
	const plist = "/h/Library/LaunchAgents/sh.omp.collab-companion.plist";
	const script = (...results: RunResult[]) => {
		const calls: string[] = [];
		const exec = async (command: string, args: string[]): Promise<RunResult> => {
			calls.push([command, ...args].join(" "));
			return results[calls.length - 1] ?? { code: 0, out: "" };
		};
		return { calls, exec };
	};
	const notLoaded: RunResult = {
		code: 113,
		out: 'Could not find service "sh.omp.collab-companion" in domain for user gui: 501',
	};

	it("kicks a loaded service once", async () => {
		const { calls, exec } = script({ code: 0, out: "" });
		expect(await startService({ platform: "darwin", uid: 501, plist }, exec)).toEqual({ ok: true });
		expect(calls).toEqual(["launchctl kickstart gui/501/sh.omp.collab-companion"]);
	});

	it("loads a service that is not loaded, then kicks it", async () => {
		const { calls, exec } = script(notLoaded, { code: 0, out: "" }, { code: 0, out: "" });
		expect(await startService({ platform: "darwin", uid: 501, plist }, exec)).toEqual({ ok: true });
		expect(calls).toEqual([
			"launchctl kickstart gui/501/sh.omp.collab-companion",
			`launchctl bootstrap gui/501 ${plist}`,
			"launchctl kickstart gui/501/sh.omp.collab-companion",
		]);
	});

	it("reports a bootstrap that fails, without kicking", async () => {
		const { calls, exec } = script(notLoaded, { code: 5, out: "Bootstrap failed: 5: Input/output error\n" });
		expect(await startService({ platform: "darwin", uid: 501, plist }, exec)).toEqual({
			ok: false,
			message: "Bootstrap failed: 5: Input/output error",
		});
		expect(calls.length).toBe(2);
	});

	it("does not bootstrap for other kickstart failures", async () => {
		const { calls, exec } = script({ code: 1, out: "boom" });
		expect(await startService({ platform: "darwin", uid: 501, plist }, exec)).toEqual({ ok: false, message: "boom" });
		expect(calls.length).toBe(1);
	});

	it("reports a failing systemctl as it is", async () => {
		const { calls, exec } = script({ code: 1, out: "Failed to connect to bus: No medium found" });
		expect(await startService({ platform: "linux", uid: 1000, plist: null }, exec)).toEqual({
			ok: false,
			message: "Failed to connect to bus: No medium found",
		});
		expect(calls).toEqual(["systemctl --user start omp-collab-companion.service"]);
	});
});
