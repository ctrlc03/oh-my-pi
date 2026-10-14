import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { excerptOf, languageOf, MAX_EXCERPT_REFS, readExcerpts } from "../scripts/companion-excerpt";

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
