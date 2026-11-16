import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HunkNote } from "../src/lib/review-board";
import {
	createReviewCache,
	MAX_AGE_MS,
	MAX_ENTRIES,
	parseNote,
	reviewCacheKey,
} from "../scripts/companion-review-cache";

let tmp: string;
let seq = 0;

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "review-cache-")));
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

/** A cache folder of its own. */
async function folder(): Promise<string> {
	const dir = path.join(tmp, `cache-${++seq}`);
	await fs.mkdir(dir);
	return dir;
}

const note = (hunk: string, extra: Partial<HunkNote> = {}): HunkNote => ({
	path: "src/a.ts",
	hunk,
	text: "Because.",
	source: "session",
	...extra,
});

describe("reviewCacheKey", () => {
	const pr = { kind: "pr", number: 7 } as const;

	it("is the same for the same repository, subject and version", () => {
		expect(reviewCacheKey("/r", pr, "abc", "s1")).toBe(reviewCacheKey("/r", pr, "abc", "s2"));
		expect(reviewCacheKey("/r", pr, "abc", "s1")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("differs by repository, subject and version", () => {
		const base = reviewCacheKey("/r", pr, "abc", "s1");
		expect(reviewCacheKey("/other", pr, "abc", "s1")).not.toBe(base);
		expect(reviewCacheKey("/r", { kind: "pr", number: 8 }, "abc", "s1")).not.toBe(base);
		expect(reviewCacheKey("/r", { kind: "branch" }, "abc", "s1")).not.toBe(base);
		expect(reviewCacheKey("/r", pr, "abd", "s1")).not.toBe(base);
	});

	it("keeps the notes of a session's own changes (and of a turn of it) to that session", () => {
		const session = { kind: "session" } as const;
		expect(reviewCacheKey("/r", session, "v", "s1")).not.toBe(reviewCacheKey("/r", session, "v", "s2"));
		const turn = { kind: "session", entryId: "e1" } as const;
		expect(reviewCacheKey("/r", turn, "v", "s1")).not.toBe(reviewCacheKey("/r", session, "v", "s1"));
	});
});

describe("parseNote", () => {
	it("keeps the fields of a note and drops what is not one", () => {
		const full = note("@@ -1 +1 @@", { sessionId: "s", sessionTitle: "T", turn: 2, intent: "i", at: 5 });
		expect(parseNote(JSON.parse(JSON.stringify(full)))).toEqual(full);
		expect(parseNote({ ...full, source: "other" })).toBeNull();
		expect(parseNote({ path: "a", hunk: "h" })).toBeNull();
		expect(parseNote(null)).toBeNull();
		expect(parseNote({ ...full, turn: "2", at: Number.NaN })).toEqual(
			note("@@ -1 +1 @@", { sessionId: "s", sessionTitle: "T", intent: "i" }),
		);
	});
});

describe("parseNote and weak", () => {
	it("keeps the weak mark of a session quote and drops it from a note a model wrote", () => {
		const quote = note("@@ -1 +1 @@", { weak: true });
		expect(parseNote(JSON.parse(JSON.stringify(quote)))).toEqual(quote);
		expect(parseNote({ ...quote, source: "generated" })?.weak).toBeUndefined();
		expect(parseNote({ ...quote, weak: false })?.weak).toBeUndefined();
	});
});

describe("createReviewCache", () => {
	const key = reviewCacheKey("/r", { kind: "branch" }, "v1", "s");

	it("returns what was written, with and without the session part", async () => {
		const dir = await folder();
		const cache = createReviewCache(dir, () => 1_000);
		expect(await cache.read(key)).toBeNull();
		await cache.write(key, { generated: [note("@@ -1 +1 @@", { source: "generated" })] });
		expect(await cache.read(key)).toEqual({
			v: 2,
			key,
			at: 1_000,
			generated: [note("@@ -1 +1 @@", { source: "generated" })],
		});
		await cache.write(key, { session: [note("@@ -2 +2 @@")], generated: [] });
		expect((await cache.read(key))?.session).toEqual([note("@@ -2 +2 @@")]);
		// Private to the user.
		expect((await fs.stat(path.join(dir, `${key}.json`))).mode & 0o777).toBe(0o600);
	});

	it("reads an unreadable, foreign or oversized file as missing", async () => {
		const dir = await folder();
		const cache = createReviewCache(dir);
		await fs.writeFile(path.join(dir, `${key}.json`), "{ not json");
		expect(await cache.read(key)).toBeNull();
		await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ v: 2, key: "other", at: 1, generated: [] }));
		expect(await cache.read(key)).toBeNull();
		await fs.writeFile(
			path.join(dir, `${key}.json`),
			JSON.stringify({ v: 2, key, at: 1, generated: [{ nonsense: true }] }),
		);
		expect(await cache.read(key)).toBeNull();
		await expect(cache.read("../escape")).rejects.toThrow("invalid cache key");
	});

	it("reads an entry of an older version as missing", async () => {
		const dir = await folder();
		const cache = createReviewCache(dir);
		await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify({ v: 1, key, at: 1, generated: [] }));
		expect(await cache.read(key)).toBeNull();
	});

	it("drops entries older than the limit when it writes", async () => {
		const dir = await folder();
		const cache = createReviewCache(dir);
		const old = reviewCacheKey("/r", { kind: "branch" }, "old", "s");
		await cache.write(old, { generated: [] });
		const long = new Date(Date.now() - MAX_AGE_MS - 60_000);
		await fs.utimes(path.join(dir, `${old}.json`), long, long);
		expect(await cache.read(old)).toBeNull();
		await cache.write(key, { generated: [] });
		expect(await fs.readdir(dir)).toEqual([`${key}.json`]);
	});

	it("keeps the most recently used entries when there are too many", async () => {
		const dir = await folder();
		const cache = createReviewCache(dir);
		const keys = Array.from({ length: MAX_ENTRIES + 2 }, (_, i) =>
			reviewCacheKey("/r", { kind: "branch" }, `v${i}`, "s"),
		);
		const base = Date.now() - 3_600_000;
		for (const [i, k] of keys.entries()) {
			const file = path.join(dir, `${k}.json`);
			await fs.writeFile(file, "{}");
			await fs.utimes(file, new Date(base + i * 1_000), new Date(base + i * 1_000));
		}
		const fresh = reviewCacheKey("/r", { kind: "branch" }, "fresh", "s");
		await cache.write(fresh, { generated: [] });
		const left = new Set(await fs.readdir(dir));
		expect(left.size).toBe(MAX_ENTRIES);
		expect(left.has(`${fresh}.json`)).toBe(true);
		// The three least recently used went.
		for (const gone of keys.slice(0, 3)) expect(left.has(`${gone}.json`)).toBe(false);
		expect(left.has(`${keys.at(-1)}.json`)).toBe(true);
	});
});
