import { describe, expect, it } from "bun:test";
import { isCompanionCommand, type LockDeps, parseLock, readCompanionLock } from "../src/main/companion-lock";

function deps(options: { text: string | null; alive?: boolean; command?: string | null }): LockDeps {
	return {
		readFile: async () => options.text,
		alive: () => options.alive ?? true,
		commandLine: async () => options.command ?? null,
	};
}

describe("parseLock", () => {
	it("reads a pid and a start time and nothing else", () => {
		expect(parseLock('{"pid":12,"startedAt":1700000000000}')).toEqual({ pid: 12, startedAt: 1700000000000 });
		expect(parseLock('{"pid":0,"startedAt":1}')).toBeNull();
		expect(parseLock('{"pid":"12","startedAt":1}')).toBeNull();
		expect(parseLock('{"pid":12}')).toBeNull();
		expect(parseLock("not json")).toBeNull();
	});
});

describe("isCompanionCommand", () => {
	it("accepts a checkout's companion and the compiled omp's", () => {
		expect(isCompanionCommand("/opt/bun /repo/packages/collab-web/scripts/companion.ts")).toBe(true);
		expect(isCompanionCommand("bun scripts/companion.ts --no-local-app")).toBe(true);
		expect(isCompanionCommand("/Users/a/.local/bin/omp companion")).toBe(true);
		expect(isCompanionCommand("omp companion --port 7468")).toBe(true);
	});

	it("rejects other processes, including ones that merely mention a companion", () => {
		expect(isCompanionCommand("/usr/sbin/cupsd -l")).toBe(false);
		expect(isCompanionCommand("vim notes-companion.txt")).toBe(false);
		expect(isCompanionCommand("omp --resume")).toBe(false);
		expect(isCompanionCommand("tail -f companion.tsv")).toBe(false);
	});
});

describe("readCompanionLock", () => {
	const text = '{"pid":321,"startedAt":5}';

	it("has no lock without a readable one", async () => {
		expect(await readCompanionLock("/l", deps({ text: null }))).toBeNull();
		expect(await readCompanionLock("/l", deps({ text: "{}" }))).toBeNull();
	});

	it("is live while a companion runs under that pid", async () => {
		expect(await readCompanionLock("/l", deps({ text, command: "bun /r/companion.ts" }))).toEqual({
			pid: 321,
			startedAt: 5,
			live: true,
		});
	});

	it("is stale when the process is gone", async () => {
		expect(await readCompanionLock("/l", deps({ text, alive: false }))).toMatchObject({ pid: 321, live: false });
	});

	it("is stale when the pid now belongs to another program", async () => {
		expect(await readCompanionLock("/l", deps({ text, command: "/usr/bin/ssh host" }))).toMatchObject({
			live: false,
		});
		expect(await readCompanionLock("/l", deps({ text, command: null }))).toMatchObject({ live: false });
	});
});
