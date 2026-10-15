import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createHiddenMessages,
	type HiddenFile,
	loadHiddenFile,
	parseHiddenFile,
	saveHiddenFile,
} from "../scripts/companion-hidden";
import type { HiddenDoc } from "../src/lib/hidden-messages";

const T0 = Date.UTC(2026, 9, 10, 12);
const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempFile(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hidden-"));
	dirs.push(dir);
	return path.join(dir, "hidden.json");
}

const doc = (entries: Record<string, [number, boolean]>): HiddenDoc => ({
	entries: Object.fromEntries(Object.entries(entries).map(([id, [at, hidden]]) => [id, { at, hidden }])),
});

function harness(initial: HiddenFile = { rev: 0, sessions: {} }) {
	const saved: HiddenFile[] = [];
	let changes = 0;
	const hidden = createHiddenMessages({
		now: () => T0,
		initial,
		save: async file => void saved.push(file),
		onChange: () => void changes++,
	});
	return { hidden, saved, changes: () => changes };
}

describe("the computer's hidden messages", () => {
	it("merges a device's document into the session's and answers with the result", async () => {
		const { hidden } = harness();
		const first = await hidden.sync("s1", doc({ a: [T0 + 10, true] }));
		expect(first.doc).toEqual(doc({ a: [T0 + 10, true] }));
		const second = await hidden.sync("s1", doc({ b: [T0 + 11, true], a: [T0 + 12, false] }));
		expect(second.doc).toEqual(doc({ a: [T0 + 12, false], b: [T0 + 11, true] }));
		expect(second.rev).toBe(2);
	});

	it("keeps each session's document apart", async () => {
		const { hidden } = harness();
		await hidden.sync("s1", doc({ a: [T0 + 10, true] }));
		const other = await hidden.sync("s2", doc({ a: [T0 + 10, false] }));
		expect(other.doc).toEqual(doc({ a: [T0 + 10, false] }));
		expect(Object.keys(hidden.file().sessions).sort()).toEqual(["s1", "s2"]);
	});

	it("moves the revision, saves and tells the devices only when something changed", async () => {
		const { hidden, saved, changes } = harness();
		await hidden.sync("s1", doc({ a: [T0 + 10, true] }));
		expect([hidden.file().rev, saved.length, changes()]).toEqual([1, 1, 1]);
		// A device syncing what the computer already has, or nothing: no news.
		await hidden.sync("s1", doc({ a: [T0 + 10, true] }));
		await hidden.sync("s1", { entries: {} });
		expect([hidden.file().rev, saved.length, changes()]).toEqual([1, 1, 1]);
	});

	it("answers a device with no document of its own with the computer's", async () => {
		const { hidden } = harness();
		await hidden.sync("s1", doc({ a: [T0 + 10, true] }));
		expect((await hidden.sync("s1", { entries: {} })).doc).toEqual(doc({ a: [T0 + 10, true] }));
		expect((await hidden.sync("never-seen", { entries: {} })).doc).toEqual({ entries: {} });
	});

	it("refuses a session id that cannot name a session", async () => {
		const { hidden, saved } = harness();
		for (const id of [undefined, 4, "", "__proto__", "x".repeat(300)])
			await expect(hidden.sync(id, doc({ a: [T0 + 1, true] }))).rejects.toThrow("invalid session id");
		expect(saved).toEqual([]);
	});

	it("forgets shown-again entries after a month", async () => {
		const { hidden } = harness({
			rev: 3,
			sessions: { s1: doc({ gone: [T0 - 40 * 24 * 60 * 60 * 1000, false], kept: [T0, true] }) },
		});
		const synced = await hidden.sync("s1", { entries: {} });
		expect(Object.keys(synced.doc.entries)).toEqual(["kept"]);
		expect(synced.rev).toBe(4);
	});
});

describe("the hidden messages file", () => {
	it("reads junk as nothing hidden", () => {
		for (const raw of [null, 4, "x", [], { rev: "1", sessions: 3 }])
			expect(parseHiddenFile(raw)).toEqual({ rev: 0, sessions: {} });
		expect(parseHiddenFile({ rev: -2, sessions: {} }).rev).toBe(0);
		expect(parseHiddenFile({ rev: 2.5, sessions: {} }).rev).toBe(0);
	});

	it("round-trips through a private file", async () => {
		const file = await tempFile();
		const { hidden, saved } = harness();
		await hidden.sync("s1", doc({ a: [T0 + 10, true], b: [T0 + 11, false] }));
		await saveHiddenFile(file, saved.at(-1) as HiddenFile);
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		expect(await loadHiddenFile(file)).toEqual({
			rev: 1,
			sessions: { s1: doc({ a: [T0 + 10, true], b: [T0 + 11, false] }) },
		});
	});

	it("starts empty when the file is missing or damaged", async () => {
		const file = await tempFile();
		expect(await loadHiddenFile(file)).toEqual({ rev: 0, sessions: {} });
		await fs.writeFile(file, "{not json");
		expect(await loadHiddenFile(file)).toEqual({ rev: 0, sessions: {} });
	});
});
