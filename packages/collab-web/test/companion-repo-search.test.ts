import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_MATCHES, checkFileSearch, searchPattern, searchRepoFiles } from "../scripts/companion-repo-search";

let tmp: string;
let repo: string;
let outside: string;

async function run(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

async function write(file: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
	await fs.writeFile(path.join(repo, file), text);
}

const paths = (result: { matches: { path: string }[] }): string[] =>
	[...new Set(result.matches.map(m => m.path))].sort();

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-repo-search-")));
	repo = path.join(tmp, "repo");
	outside = path.join(tmp, "outside");
	await fs.mkdir(repo);
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, "secret.txt"), "needle in the outside\n");
	await run(repo, "git", "init", "-q");
	await write(".gitignore", "ignored.log\nbuild/\n");
	await write("src/main.ts", "export const needle = 1;\nconst Needle2 = needle + 1;\nconst haystack = 'a-b';\n");
	await write("src/lib/util.ts", "export function useNeedle() {\n\treturn 'needle';\n}\n");
	await write("docs/readme.md", "A needle in a haystack. unneedled text.\n");
	await write("ignored.log", "needle ignored\n");
	await write("build/out.js", "needle built\n");
	await write("src/unicode.ts", "const π = '🙂'; const needle = 3;\n");
	await write(".git/info/exclude-test", "needle in git internals\n");
	await write("many.txt", Array.from({ length: 150 }, (_, i) => `many ${i}`).join("\n") + "\n");
	await fs.symlink(outside, path.join(repo, "link-to-outside"));
	await fs.symlink(path.join(outside, "secret.txt"), path.join(repo, "link-to-secret.txt"));
	await run(repo, "git", "add", ".gitignore", "src", "docs", "many.txt");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("file-search", () => {
	it("finds literal text, case-insensitively by default", async () => {
		const result = await searchRepoFiles(repo, { query: "needle" });
		expect(paths(result)).toEqual(["docs/readme.md", "src/lib/util.ts", "src/main.ts", "src/unicode.ts"]);
		expect(result.limited).toBe(false);
		expect(result.files).toBe(4);
		expect(result.matches.some(m => m.text.includes("Needle2"))).toBe(true);
	});

	it("reports 1-based lines and 0-based UTF-16 characters", async () => {
		const result = await searchRepoFiles(repo, { query: "needle", caseSensitive: true });
		const unicode = result.matches.find(m => m.path === "src/unicode.ts");
		// "const π = '🙂'; const needle = 3;": the emoji is two UTF-16 units.
		expect(unicode).toMatchObject({ line: 1, character: "const π = '🙂'; const ".length });
		expect(result.matches.find(m => m.path === "src/main.ts" && m.line === 2)?.character).toBe(
			"const Needle2 = ".length,
		);
	});

	it("honours caseSensitive", async () => {
		const result = await searchRepoFiles(repo, { query: "Needle", caseSensitive: true });
		expect(result.matches.map(m => `${m.path}:${m.line}`)).toEqual(["src/lib/util.ts:1", "src/main.ts:2"]);
	});

	it("treats plain text literally", async () => {
		const result = await searchRepoFiles(repo, { query: "a-b" });
		expect(result.matches.map(m => m.path)).toEqual(["src/main.ts"]);
		expect((await searchRepoFiles(repo, { query: "(needle" })).matches).toEqual([]);
		expect((await searchRepoFiles(repo, { query: "needle.", caseSensitive: true })).matches).toEqual([]);
	});

	it("searches regexes", async () => {
		const result = await searchRepoFiles(repo, { query: "need\\w+ = \\d", regex: true });
		expect(paths(result)).toEqual(["src/main.ts", "src/unicode.ts"]);
	});

	it("refuses an invalid regex with a clear message", async () => {
		await expect(searchRepoFiles(repo, { query: "(unclosed", regex: true })).rejects.toThrow(/^Invalid regex: /);
		await expect(searchRepoFiles(repo, { query: "[a-", regex: true })).rejects.toThrow(/^Invalid regex: /);
		await expect(searchRepoFiles(repo, { query: "*needle", regex: true })).rejects.toThrow(/^Invalid regex: /);
	});

	it("passes regex constructs only the native dialect knows", () => {
		expect(searchPattern({ query: "(?i)needle", regex: true })).toBe("(?i)needle");
		expect(searchPattern({ query: "a.b", wholeWord: true })).toBe("\\b(?:a\\.b)\\b");
	});

	it("matches whole words only", async () => {
		const result = await searchRepoFiles(repo, { query: "needle", wholeWord: true });
		const docs = result.matches.filter(m => m.path === "docs/readme.md");
		expect(docs).toHaveLength(1);
		expect((await searchRepoFiles(repo, { query: "need", wholeWord: true })).matches).toEqual([]);
		expect((await searchRepoFiles(repo, { query: "Needle", wholeWord: true, caseSensitive: true })).matches).toEqual(
			[],
		);
	});

	it("filters by glob: bare globs at any depth, rooted ones from the repository root", async () => {
		expect(paths(await searchRepoFiles(repo, { query: "needle", glob: "*.md" }))).toEqual(["docs/readme.md"]);
		expect(paths(await searchRepoFiles(repo, { query: "needle", glob: "src/lib/*.ts" }))).toEqual([
			"src/lib/util.ts",
		]);
		expect(paths(await searchRepoFiles(repo, { query: "needle", glob: "src/**/*.ts" }))).toEqual([
			"src/lib/util.ts",
			"src/main.ts",
			"src/unicode.ts",
		]);
	});

	it("skips .gitignored files and .git", async () => {
		const result = await searchRepoFiles(repo, { query: "needle" });
		expect(paths(result)).not.toContain("ignored.log");
		expect(paths(result)).not.toContain("build/out.js");
		expect(result.matches.some(m => m.path.startsWith(".git/"))).toBe(false);
		expect((await searchRepoFiles(repo, { query: "git internals" })).matches).toEqual([]);
	});

	it("never returns files outside the repository, even through symlinks", async () => {
		const result = await searchRepoFiles(repo, { query: "outside" });
		expect(result.matches).toEqual([]);
		expect((await searchRepoFiles(repo, { query: "needle in the outside" })).matches).toEqual([]);
	});

	it("searches from the repository root when the session sits in a subfolder", async () => {
		const result = await searchRepoFiles(path.join(repo, "src"), { query: "haystack", glob: "*.md" });
		expect(paths(result)).toEqual(["docs/readme.md"]);
	});

	it("caps results and says so", async () => {
		const result = await searchRepoFiles(repo, { query: "many" });
		// One file past its per-file cap of 100 matches.
		expect(result.matches.filter(m => m.path === "many.txt").length).toBeLessThanOrEqual(100);
		expect(result.limited).toBe(true);
		expect(result.files).toBeGreaterThanOrEqual(1);
		expect(result.matches.length).toBeLessThanOrEqual(MAX_MATCHES);
	});

	it("stops at the overall match cap", async () => {
		const bulk = path.join(repo, "bulk");
		await fs.mkdir(bulk);
		const text = Array.from({ length: 100 }, (_, i) => `bulkmark ${i}`).join("\n") + "\n";
		await Promise.all(Array.from({ length: 12 }, (_, i) => fs.writeFile(path.join(bulk, `f${i}.txt`), text)));
		const result = await searchRepoFiles(repo, { query: "bulkmark" });
		expect(result.matches.length).toBeLessThanOrEqual(MAX_MATCHES);
		expect(result.matches.length).toBeGreaterThan(900);
		expect(result.limited).toBe(true);
		await fs.rm(bulk, { recursive: true });
	});

	it("rejects empty, oversized and malformed queries", async () => {
		await expect(searchRepoFiles(repo, { query: "" })).rejects.toThrow("Enter something");
		await expect(searchRepoFiles(repo, { query: "x".repeat(1001) })).rejects.toThrow("over 1000");
		await expect(searchRepoFiles(repo, null)).rejects.toThrow("invalid search");
		expect(() => checkFileSearch({ query: "a", regex: "yes" })).toThrow("invalid search");
		expect(() => checkFileSearch({ query: "a", glob: 3 })).toThrow("invalid file filter");
		expect(checkFileSearch({ query: "a", glob: "  " }).glob).toBeUndefined();
	});
});
