import { describe, expect, it } from "bun:test";
import {
	appUrl,
	configDirOf,
	type DiscoveryDeps,
	endpointFile,
	findRunningEndpoint,
	parseEndpoint,
	pidExists,
	planCompanion,
} from "../src/main/companion-endpoint";

const deps = (over: Partial<DiscoveryDeps> & { text?: string | null }): DiscoveryDeps => ({
	readFile: async () => (over.text === undefined ? '{"pid":42,"port":7467,"app":true}' : over.text),
	alive: over.alive ?? (() => true),
	probe: over.probe ?? (async () => true),
});

describe("paths", () => {
	it("follows PI_CONFIG_DIR the way the companion does", () => {
		expect(configDirOf("/h", {})).toBe("/h/.omp");
		expect(configDirOf("/h", { PI_CONFIG_DIR: ".omp-test" })).toBe("/h/.omp-test");
		expect(endpointFile("/h/.omp")).toBe("/h/.omp/agent/collab-companion-local.json");
		expect(appUrl(7468)).toBe("http://127.0.0.1:7468/");
	});
});

describe("parseEndpoint", () => {
	it("reads what the companion publishes", () => {
		expect(parseEndpoint('{"pid":7,"port":7467,"app":false}')).toEqual({ pid: 7, port: 7467, app: false });
	});

	it("refuses anything else", () => {
		for (const text of [
			"",
			"[]",
			"null",
			'{"pid":7,"port":7467}',
			'{"pid":"7","port":7467,"app":true}',
			'{"pid":7,"port":0,"app":true}',
			'{"pid":7,"port":70000,"app":true}',
			'{"pid":-1,"port":7467,"app":true}',
			"{",
		]) {
			expect(parseEndpoint(text)).toBeNull();
		}
	});
});

describe("findRunningEndpoint", () => {
	it("finds a live companion", async () => {
		expect(await findRunningEndpoint("f", deps({}))).toEqual({ pid: 42, port: 7467, app: true });
	});

	it("ignores a file a crashed companion left behind", async () => {
		expect(await findRunningEndpoint("f", deps({ alive: () => false }))).toBeNull();
		expect(await findRunningEndpoint("f", deps({ probe: async () => false }))).toBeNull();
		expect(await findRunningEndpoint("f", deps({ text: null }))).toBeNull();
		expect(await findRunningEndpoint("f", deps({ text: "garbage" }))).toBeNull();
	});

	it("probes the app's own address", async () => {
		const probed: string[] = [];
		await findRunningEndpoint("f", deps({ probe: async url => (probed.push(url), true) }));
		expect(probed).toEqual(["http://127.0.0.1:7467/"]);
	});
});

describe("planCompanion", () => {
	it("starts one when none runs, attaches to one that serves the app, and refuses one that does not", () => {
		expect(planCompanion(null)).toEqual({ action: "start" });
		expect(planCompanion({ pid: 1, port: 7467, app: true })).toEqual({
			action: "attach",
			endpoint: { pid: 1, port: 7467, app: true },
		});
		const blocked = planCompanion({ pid: 1, port: 7467, app: false });
		expect(blocked.action).toBe("blocked");
	});
});

describe("pidExists", () => {
	it("says a process exists unless the system says it does not", () => {
		const kill = (code?: string) => (_pid: number, _signal: 0) => {
			if (code !== undefined) throw Object.assign(new Error(code), { code });
		};
		expect(pidExists(kill(), 1)).toBe(true);
		expect(pidExists(kill("EPERM"), 1)).toBe(true);
		expect(pidExists(kill("ESRCH"), 1)).toBe(false);
	});
});
