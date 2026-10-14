import { afterEach, describe, expect, it } from "bun:test";
import { defaultDeviceName, INITIAL_SNAPSHOT, type CompanionHost } from "../src/lib/companion";
import type { ComputerHandle } from "../src/lib/computers";
import { desktopReport, getDesktop } from "../src/lib/desktop";
import { saveBlob } from "../src/lib/download";

const host = (instanceId: string, patch: Partial<CompanionHost> = {}): CompanionHost => ({
	instanceId,
	sessionId: `session-${instanceId}`,
	sessionName: null,
	cwd: `/work/${instanceId}`,
	model: null,
	startedAt: 0,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
	...patch,
});

const computer = (
	id: string,
	hosts: CompanionHost[],
	phase: ComputerHandle["snap"]["phase"] = "live",
): ComputerHandle => ({
	id,
	name: `Machine ${id}`,
	client: null,
	error: null,
	snap: { ...INITIAL_SNAPSHOT, phase, hosts },
});

const titleOf = (h: CompanionHost): string => h.sessionName || h.cwd.split("/").pop() || "session";

const bridge = (calls: unknown[]) => ({
	saveFile: async (name: string, data: Uint8Array) => {
		calls.push([name, data.byteLength]);
		return "saved" as const;
	},
	reportSessions: () => {},
	onOpenSession: () => () => {},
});

describe("getDesktop", () => {
	it("is null in a browser and for anything that is not the full bridge", () => {
		expect(getDesktop({})).toBeNull();
		expect(getDesktop({ ompDesktop: {} })).toBeNull();
		expect(getDesktop({ ompDesktop: { saveFile() {}, reportSessions() {} } })).toBeNull();
		expect(getDesktop({ ompDesktop: "yes" })).toBeNull();
	});

	it("returns a bridge that forwards to the shell's calls", async () => {
		const calls: unknown[] = [];
		const desktop = getDesktop({ ompDesktop: bridge(calls) });
		expect(desktop).not.toBeNull();
		await desktop?.saveFile("a.txt", new Uint8Array([1]));
		expect(calls.length).toBe(1);
	});
});

describe("desktopReport", () => {
	it("classifies sessions of live computers and counts computers", () => {
		const report = desktopReport(
			[
				computer("a", [
					host("1", { inputRequired: true, busy: true }),
					host("2", { busy: true }),
					host("3"),
					host("4", { busy: null }),
				]),
				computer("b", [host("5", { inputRequired: true })], "offline"),
				computer("c", [], "live"),
			],
			titleOf,
		);
		expect(report.computersTotal).toBe(3);
		expect(report.computersLive).toBe(2);
		expect(report.sessions.map(s => [s.instanceId, s.activity])).toEqual([
			["1", "input"],
			["2", "working"],
			["3", "idle"],
			["4", "idle"],
		]);
		expect(report.sessions[0]).toMatchObject({ computerId: "a", title: "1", computerName: "Machine a" });
	});
});

describe("saveBlob in the desktop app", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "ompDesktop");
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, "ompDesktop", original);
		else delete (globalThis as Record<string, unknown>).ompDesktop;
	});

	it("hands the bytes to the shell's save dialog", async () => {
		const calls: unknown[] = [];
		Object.defineProperty(globalThis, "ompDesktop", { configurable: true, value: bridge(calls) });
		const result = await saveBlob(new Blob(["hello"]), "notes.txt");
		expect(result).toBe("saved");
		expect(calls).toEqual([["notes.txt", 5]]);
	});
});

describe("defaultDeviceName", () => {
	it("names the desktop app, not Chrome", () => {
		const ua =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) omp collab/0.1.0 Chrome/140.0.0.0 Electron/44.7.0 Safari/537.36";
		expect(defaultDeviceName(ua)).toBe("Mac desktop app");
	});
});
