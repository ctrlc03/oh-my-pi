import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BLUEPRINT_EXCERPT_CONTEXT,
	BLUEPRINT_EXCERPT_MAX_LINES,
	BLUEPRINT_EXCERPT_MAX_RANGES,
} from "@oh-my-pi/pi-wire/blueprint";
import { excerptOf, excerptRange, languageOf, MAX_EXCERPT_REFS, readExcerpts } from "../scripts/companion-excerpt";

describe("excerptOf", () => {
	it("cuts an excerpt around the cited line, shortens long lines, and refuses a line outside the file", () => {
		const lines = Array.from({ length: 100 }, (_, i) => (i === 49 ? "x".repeat(1_000) : `line ${i + 1}`));
		const hit = excerptOf(lines, { path: "a.ts", line: 50 }, "head", "c".repeat(40))!;
		expect(hit.lines).toContain("line 49");
		expect(hit.lines.at(hit.line - hit.start)!.length).toBeLessThan(500);
		expect(excerptOf(lines, { path: "a.ts", line: 101 }, "head", "c")).toBeNull();
		expect(excerptOf(lines, { path: "a.ts", line: 0 }, "head", "c")).toBeNull();
		expect(excerptOf(lines, { path: "a.ts", line: 1 }, "head", "c")!.start).toBe(1);
	});

	it("names the language from the extension", () => {
		expect(languageOf("crates/x/src/lib.rs")).toBe("rs");
		expect(languageOf("a/b.TSX")).toBe("tsx");
		expect(languageOf("Makefile")).toBeUndefined();
		expect(languageOf("constructor")).toBeUndefined();
	});
});

describe("excerptRange", () => {
	const window = BLUEPRINT_EXCERPT_CONTEXT;

	it("gives the default window around the cited line when no range is asked for", () => {
		expect(excerptRange(500, 100)).toEqual({ start: 100 - window, end: 100 + window });
		expect(excerptRange(500, 100, {})).toEqual({ start: 100 - window, end: 100 + window });
		expect(excerptRange(500, 100, { from: 90 })).toEqual({ start: 100 - window, end: 100 + window });
	});

	it("stops the default window at the top and the bottom of the file", () => {
		expect(excerptRange(500, 3)).toEqual({ start: 1, end: 3 + window });
		expect(excerptRange(500, 498)).toEqual({ start: 498 - window, end: 500 });
	});

	it("honours a range, widened to hold the cited line", () => {
		expect(excerptRange(500, 100, { from: 60, to: 140 })).toEqual({ start: 60, end: 140 });
		expect(excerptRange(500, 100, { from: 110, to: 140 })).toEqual({ start: 100, end: 140 });
		expect(excerptRange(500, 100, { from: 60, to: 90 })).toEqual({ start: 60, end: 100 });
	});

	it("cuts a range to the file: past the top starts at line 1, past the bottom ends at the last line", () => {
		expect(excerptRange(500, 20, { from: -50, to: 40 })).toEqual({ start: 1, end: 40 });
		expect(excerptRange(500, 480, { from: 470, to: 9_999 })).toEqual({ start: 470, end: 500 });
	});

	it("gives the whole file when the range covers it", () => {
		expect(excerptRange(300, 150, { from: 1, to: 300 })).toEqual({ start: 1, end: 300 });
		expect(excerptRange(300, 150, { from: -1e9, to: 1e9 })).toEqual({ start: 1, end: 300 });
	});

	it("holds a range to the most lines one excerpt may have, keeping the cited line and the first line asked for", () => {
		const max = BLUEPRINT_EXCERPT_MAX_LINES;
		expect(excerptRange(50_000, 1_500, { from: 1, to: 50_000 })).toEqual({ start: 1, end: max });
		expect(excerptRange(50_000, 30_000, { from: 1, to: 50_000 })).toEqual({ start: 30_000 - max + 1, end: 30_000 });
		const fits = excerptRange(50_000, 5_000, { from: 4_000, to: 4_000 + max - 1 });
		expect(fits.end - fits.start + 1).toBe(max);
	});

	it("ignores a range that is not a pair of whole numbers with from <= to", () => {
		const fallback = { start: 100 - window, end: 100 + window };
		for (const bad of [
			{ from: 140, to: 60 },
			{ from: 60.5, to: 140 },
			{ from: Number.NaN, to: 140 },
			{ from: "60", to: 140 },
			{ from: 60, to: Number.POSITIVE_INFINITY },
			{ from: 60, to: null },
			{ from: 60, to: undefined },
		])
			expect(excerptRange(500, 100, bad)).toEqual(fallback);
	});
});

describe("excerptOf with a range", () => {
	const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

	it("says how long the file is, so a viewer knows when it has reached either end", () => {
		const hit = excerptOf(lines, { path: "a.ts", line: 100 }, "head", "c")!;
		expect(hit.total).toBe(200);
		expect(hit.start).toBe(100 - BLUEPRINT_EXCERPT_CONTEXT);
		expect(hit.start + hit.lines.length - 1).toBe(100 + BLUEPRINT_EXCERPT_CONTEXT);
	});

	it("does not count the empty piece after the final newline as a line", () => {
		const text = ["one", "two", "three", ""];
		expect(excerptOf(text, { path: "a.ts", line: 3 }, "head", "c")).toMatchObject({
			total: 3,
			lines: ["one", "two", "three"],
		});
		expect(excerptOf(text, { path: "a.ts", line: 4 }, "head", "c")).toBeNull();
	});

	it("returns the lines asked for, and the old window for a request that asks for none", () => {
		const wide = excerptOf(lines, { path: "a.ts", line: 100, from: 60, to: 140 }, "head", "c")!;
		expect([wide.start, wide.lines.length, wide.lines[0], wide.lines.at(-1)]).toEqual([
			60,
			81,
			"line 60",
			"line 140",
		]);
		const whole = excerptOf(lines, { path: "a.ts", line: 100, from: 1, to: 200 }, "head", "c")!;
		expect([whole.start, whole.lines.length, whole.total]).toEqual([1, 200, 200]);
		expect(excerptOf(lines, { path: "a.ts", line: 100 }, "head", "c")!.lines).toHaveLength(
			2 * BLUEPRINT_EXCERPT_CONTEXT + 1,
		);
	});
});

describe("readExcerpts", () => {
	let repo: string;
	let first: string;
	let second: string;

	async function git(...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
		return out.trim();
	}

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-excerpt-"));
		await git("init", "-q", "-b", "main");
		await fs.writeFile(path.join(repo, "a.ts"), "const one = 1;\nconst two = 2;\nconst gone = 3;\n");
		await git("add", "-A");
		await git("commit", "-q", "-m", "one");
		first = await git("rev-parse", "HEAD");
		await fs.writeFile(
			path.join(repo, "a.ts"),
			"const one = 1;\nconst two = 2;\nconst added = 4;\nconst more = 5;\n",
		);
		await git("commit", "-q", "-am", "two");
		second = await git("rev-parse", "HEAD");
	});
	afterAll(async () => {
		await fs.rm(repo, { recursive: true, force: true });
	});

	it("reads each ref at the commit of its side and answers null for what the commit does not have", async () => {
		const out = await readExcerpts(repo, { head: second, base: first }, [
			{ path: "a.ts", line: 3, token: "added" },
			{ path: "a.ts", line: 3, token: "gone", side: "base" },
			{ path: "nope.ts", line: 1, token: "x" },
			{ path: "a.ts", line: 99, token: "x" },
			{ path: "../etc/passwd", line: 1, token: "x" },
		]);
		expect(out[0]).toMatchObject({ path: "a.ts", line: 3, side: "head", commit: second, language: "ts" });
		expect(out[0]!.lines[2]).toBe("const added = 4;");
		expect(out[1]).toMatchObject({ side: "base", commit: first });
		expect(out[1]!.lines[2]).toBe("const gone = 3;");
		expect(out.slice(2)).toEqual([null, null, null]);
	});

	it("reads a range from the commit and side of its ref, and answers a request without one with the default window", async () => {
		const out = await readExcerpts(repo, { head: second, base: first }, [
			{ path: "a.ts", line: 2, token: "two", from: 1, to: 99 },
			{ path: "a.ts", line: 2, token: "two", side: "base", from: 1, to: 99 },
			{ path: "a.ts", line: 2, token: "two" },
			{ path: "a.ts", line: 2, token: "two", from: 3, to: 1 },
		]);
		expect(out[0]).toMatchObject({ commit: second, side: "head", start: 1, total: 4 });
		expect(out[0]!.lines).toEqual(["const one = 1;", "const two = 2;", "const added = 4;", "const more = 5;"]);
		expect(out[1]).toMatchObject({ commit: first, side: "base", start: 1, total: 3 });
		expect(out[1]!.lines.at(-1)).toBe("const gone = 3;");
		expect(out[2]).toEqual(out[3]);
		expect(out[2]).toMatchObject({ start: 1, total: 4 });
	});

	it("keeps the path and commit checks for a ranged ref, and refuses more ranges than a reply may carry", async () => {
		const out = await readExcerpts(repo, { head: second }, [
			{ path: "../etc/passwd", line: 1, token: "x", from: 1, to: 50 },
			{ path: "a.ts", line: 1, token: "x", side: "base", from: 1, to: 50 },
			{ path: "a.ts", line: 99, token: "x", from: 1, to: 50 },
		]);
		expect(out).toEqual([null, null, null]);
		const ranged = Array.from({ length: BLUEPRINT_EXCERPT_MAX_RANGES + 1 }, () => ({
			path: "a.ts",
			line: 1,
			token: "one",
			from: 1,
			to: 4,
		}));
		await expect(readExcerpts(repo, { head: second }, ranged)).rejects.toThrow("too many ranges");
		await expect(readExcerpts(repo, { head: second }, ranged.slice(1))).resolves.toHaveLength(
			BLUEPRINT_EXCERPT_MAX_RANGES,
		);
	});

	it("has no base excerpts without a base commit, and refuses an absurd number of refs", async () => {
		expect(
			await readExcerpts(repo, { head: second }, [{ path: "a.ts", line: 1, token: "one", side: "base" }]),
		).toEqual([null]);
		await expect(
			readExcerpts(
				repo,
				{ head: second },
				Array.from({ length: MAX_EXCERPT_REFS + 1 }, () => ({ path: "a.ts", line: 1, token: "x" })),
			),
		).rejects.toThrow("too many references");
	});
});
