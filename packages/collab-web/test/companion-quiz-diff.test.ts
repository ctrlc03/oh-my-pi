import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { numberDiff, partDiff } from "../scripts/companion-quiz-diff";

const RAW = await Bun.file(new URL("./fixtures/quiz/changes.diff", import.meta.url)).text();

/** A diff that adds one file of `lines` lines. */
function addedFile(name: string, lines: number, width = 20): string {
	const body = Array.from({ length: lines }, (_, i) => `+${String(i + 1).padStart(4, "0")} ${"x".repeat(width)}`).join(
		"\n",
	);
	return `diff --git a/${name} b/${name}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
}

function fileText(text: string, name: string): string {
	const start = text.indexOf(`### ${name} `);
	if (start === -1) return "";
	const next = text.indexOf("\n### ", start + 1);
	return text.slice(start, next === -1 ? undefined : next + 1);
}

describe("numberDiff", () => {
	const out = numberDiff(RAW, { maxChars: 100_000 });

	it("lists the files with their change, skipping binary files and lockfiles", () => {
		expect(out.text).toContain("### src/added.ts (added)\n");
		expect(out.text).toContain("### docs/removed.md (removed)\n");
		expect(out.text).toContain("### src/new-name.ts (renamed from src/old-name.ts)\n");
		expect(out.text).toContain("### docs/moved-after.md (renamed from docs/moved-before.md)\n");
		expect(out.text).toContain("### src/multi.ts (modified)\n");
		expect(out.text).not.toContain("logo.png");
		expect(out.text).not.toContain("package-lock.json");
		expect(out.files).toBe(6);
		expect(out.omittedFiles).toBe(0);
		expect(out.truncated).toBe(false);
	});

	it("numbers added lines from line 1 of the new file", () => {
		expect(fileText(out.text, "src/added.ts")).toBe(
			[
				"### src/added.ts (added)",
				"@@ -0,0 +1,4 @@",
				"+1  export const added = true;",
				"+2  export function hello(name: string) {",
				"+3  \treturn `hi ${name}`;",
				"+4  }",
				"",
			].join("\n"),
		);
	});

	it("numbers removed lines from the old file", () => {
		expect(fileText(out.text, "docs/removed.md")).toBe(
			["### docs/removed.md (removed)", "@@ -1,3 +0,0 @@", "-1  gone 1", "-2  gone 2", "-3  gone 3", ""].join("\n"),
		);
	});

	it("numbers context and added lines by the new file and removed lines by the old file, across hunks", () => {
		expect(fileText(out.text, "src/multi.ts")).toBe(
			[
				"### src/multi.ts (modified)",
				"@@ -1,6 +1,6 @@",
				" 1  line 1",
				" 2  line 2",
				"-3  line 3",
				"+3  line three changed",
				" 4  line 4",
				" 5  line 5",
				" 6  line 6",
				"@@ -17,7 +17,6 @@ line 16",
				" 17  line 17",
				" 18  line 18",
				" 19  line 19",
				"-20  line 20",
				" 20  line 21",
				" 21  line 22",
				" 22  line 23",
				"@@ -36,5 +35,7 @@ line 35",
				" 35  line 36",
				" 36  line 37",
				" 37  line 38",
				"+38  line 38b",
				"+39  line 38c",
				" 40  line 39",
				" 41  line 40",
				"",
			].join("\n"),
		);
	});

	it("shows a rename with its edits and a pure rename as a header", () => {
		const renamed = fileText(out.text, "src/new-name.ts");
		expect(renamed).toContain("-2  export const b = 2;\n+2  export const b = 20;");
		expect(renamed).toContain("-5  \treturn a + b;\n+5  \treturn a + b + c;");
		expect(fileText(out.text, "docs/moved-after.md")).toBe(
			"### docs/moved-after.md (renamed from docs/moved-before.md)\n",
		);
	});

	it("keeps added lines that look like diff headers and drops the no-newline note", () => {
		const tricky = fileText(out.text, "src/tricky.sql");
		expect(tricky).toContain("+1  -- starts like a header\n+2  +++ looks like one too\n+3  plain\n");
		expect(tricky).not.toContain("No newline");
	});

	it("returns nothing for text without a diff", () => {
		expect(numberDiff("", { maxChars: 1_000 })).toEqual({ text: "", files: 0, omittedFiles: 0, truncated: false });
	});

	it("cuts a very long line", () => {
		const long = numberDiff(addedFile("a.txt", 1, 5_000), { maxChars: 100_000 });
		expect(long.text.length).toBeLessThan(900);
		expect(long.text).toContain("…\n");
	});

	it("cuts one huge file at a line, with a marker counting what is left out", () => {
		const huge = numberDiff(addedFile("huge.txt", 2_000), { maxChars: 3_000 });
		expect(huge.text.length).toBeLessThanOrEqual(3_000);
		expect(huge.truncated).toBe(true);
		expect(huge.files).toBe(1);
		const shown = huge.text.split("\n").filter(line => line.startsWith("+")).length;
		expect(huge.text).toContain(`[… ${2_000 - shown} more changed lines in this file omitted]`);
	});

	it("cuts a file with many hunks at a hunk boundary", () => {
		const hunks = Array.from({ length: 30 }, (_, i) => {
			const at = i * 100 + 1;
			return `@@ -${at},1 +${at},1 @@\n-old ${i} ${"o".repeat(60)}\n+new ${i} ${"n".repeat(60)}\n`;
		}).join("");
		const raw = `diff --git a/many.ts b/many.ts\nindex 1..2 100644\n--- a/many.ts\n+++ b/many.ts\n${hunks}`;
		const result = numberDiff(raw, { maxChars: 2_000 });
		expect(result.text.length).toBeLessThanOrEqual(2_000);
		const shownHunks = result.text.split("\n").filter(line => line.startsWith("@@")).length;
		expect(shownHunks).toBeGreaterThan(5);
		expect(shownHunks).toBeLessThan(30);
		expect(result.text).toContain(`[… ${(30 - shownHunks) * 2} more changed lines in this file omitted]`);
		// Every shown hunk is whole.
		expect(result.text.split("\n").filter(line => line.startsWith("-")).length).toBe(shownHunks);
	});

	it("gives every file a fair share: a small file is whole and a big file does not crowd out the others", () => {
		const raw = addedFile("big.txt", 3_000) + addedFile("small-a.txt", 5) + addedFile("small-b.txt", 5);
		const result = numberDiff(raw, { maxChars: 4_000 });
		expect(result.files).toBe(3);
		expect(result.omittedFiles).toBe(0);
		expect(fileText(result.text, "small-a.txt")).toContain("+5  ");
		expect(fileText(result.text, "small-b.txt")).toContain("+5  ");
		expect(fileText(result.text, "big.txt")).toContain("more changed lines in this file omitted");
		expect(result.text.length).toBeLessThanOrEqual(4_000);
	});

	it("honours a per-file cap", () => {
		const result = numberDiff(addedFile("a.txt", 500), { maxChars: 100_000, perFileChars: 2_000 });
		expect(result.text.length).toBeLessThanOrEqual(2_000);
		expect(result.truncated).toBe(true);
	});

	it("leaves out the files that no longer fit and names them", () => {
		const raw = Array.from({ length: 10 }, (_, i) => addedFile(`dir/f${i}.txt`, 200)).join("");
		const result = numberDiff(raw, { maxChars: 4_000 });
		expect(result.text.length).toBeLessThanOrEqual(4_000);
		expect(result.files).toBeGreaterThan(0);
		expect(result.files + result.omittedFiles).toBe(10);
		expect(result.omittedFiles).toBeGreaterThan(0);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain(`[… ${result.omittedFiles} more files omitted: `);
		const shown = [...result.text.matchAll(/^### (dir\/f\d\.txt) /gm)].map(match => match[1]);
		const omittedNames = (/omitted: (.*)\]\n$/.exec(result.text)?.[1] ?? "").split(", ");
		expect([...shown, ...omittedNames].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `dir/f${i}.txt`));
	});

	it("lists at most 30 omitted names", () => {
		const raw = Array.from({ length: 60 }, (_, i) => addedFile(`f${String(i).padStart(2, "0")}.txt`, 100)).join("");
		const result = numberDiff(raw, { maxChars: 6_000 });
		expect(result.text.length).toBeLessThanOrEqual(6_000);
		const note = result.text.slice(result.text.lastIndexOf("[… "));
		expect(note.split(", ").length).toBeLessThanOrEqual(31);
		expect(result.omittedFiles).toBeGreaterThan(30);
		expect(note).toContain(`, and ${result.omittedFiles - 30} more]`);
	});

	it("shows nothing but the note when no file fits at all", () => {
		const result = numberDiff(addedFile("a.txt", 50), { maxChars: 20 });
		expect(result.files).toBe(0);
		expect(result.omittedFiles).toBe(1);
		expect(result.truncated).toBe(true);
	});
});

describe("partDiff", () => {
	let repo: string;
	let base: string;
	let head: string;

	async function run(...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(err);
		return out.trim();
	}

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "quiz-diff-"));
		await run("init", "-q", "-b", "main");
		await run("config", "user.email", "t@example.com");
		await run("config", "user.name", "Test");
		await run("config", "diff.noprefix", "true");
		await Bun.write(
			path.join(repo, "a.ts"),
			Array.from({ length: 30 }, (_, i) => `const a${i + 1} = ${i + 1};`).join("\n") + "\n",
		);
		await Bun.write(path.join(repo, "gone.ts"), "export const gone = 1;\nexport const alsoGone = 2;\n");
		await Bun.write(path.join(repo, "bun.lock"), "lock one\n");
		await run("add", "-A");
		await run("commit", "-qm", "base");
		base = await run("rev-parse", "HEAD");
		const lines = (await Bun.file(path.join(repo, "a.ts")).text()).split("\n");
		lines.splice(4, 1, "const five = 'changed';", "const extra = true;");
		lines.splice(20, 2);
		await Bun.write(path.join(repo, "a.ts"), lines.join("\n"));
		await Bun.write(path.join(repo, "new.ts"), "export function fresh() {\n\treturn 1;\n}\n");
		await Bun.write(path.join(repo, "bun.lock"), "lock two\n");
		await fs.rm(path.join(repo, "gone.ts"));
		await run("add", "-A");
		await run("commit", "-qm", "head");
		head = await run("rev-parse", "HEAD");
	});

	afterAll(() => fs.rm(repo, { recursive: true, force: true }));

	it("numbers the diff between two commits and adds the stat, whatever the user's diff config", async () => {
		const result = await partDiff(repo, base, head, { maxChars: 50_000 });
		expect(result.files).toBe(3);
		expect(result.omittedFiles).toBe(0);
		expect(result.truncated).toBe(false);
		expect(result.stat).toContain("a.ts");
		expect(result.stat).toContain("4 files changed");
		expect(result.text).toContain("### a.ts (modified)\n");
		expect(result.text).toContain("### gone.ts (removed)\n");
		expect(result.text).toContain("### new.ts (added)\n");
		expect(result.text).not.toContain("bun.lock");

		// Every numbered line is the very line it names: new side for ` ` and `+`, old side for `-`.
		const baseFiles = new Map<string, string[]>();
		const headFiles = new Map<string, string[]>();
		for (const name of ["a.ts", "gone.ts", "new.ts"]) {
			baseFiles.set(name, (await run("show", `${base}:${name}`).catch(() => "")).split("\n"));
			headFiles.set(name, (await run("show", `${head}:${name}`).catch(() => "")).split("\n"));
		}
		let current = "";
		let checked = 0;
		for (const line of result.text.split("\n")) {
			const header = /^### (\S+) /.exec(line);
			if (header) {
				current = header[1] as string;
				continue;
			}
			const numbered = /^([ +-])\s*(\d+)  (.*)$/.exec(line);
			if (!numbered || line.startsWith("@@")) continue;
			const [, marker, number, text] = numbered;
			const side = marker === "-" ? baseFiles : headFiles;
			expect(side.get(current)?.[Number(number) - 1]).toBe(text as string);
			checked++;
		}
		expect(checked).toBeGreaterThan(10);
	});

	it("keeps within the budget", async () => {
		const result = await partDiff(repo, base, head, { maxChars: 300 });
		expect(result.text.length).toBeLessThanOrEqual(300);
		expect(result.truncated).toBe(true);
	});

	it("rejects an unknown commit", async () => {
		await expect(partDiff(repo, "0".repeat(40), head, { maxChars: 1_000 })).rejects.toThrow();
	});
});
