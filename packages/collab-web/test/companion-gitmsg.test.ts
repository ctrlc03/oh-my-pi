import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildPrompt,
	capDiff,
	DIFF_CHARS,
	fallbackText,
	gatherContext,
	generateGitText,
	ompArgs,
	parseAnswer,
} from "../scripts/companion-gitmsg";
import type { RunOmp } from "../scripts/companion-headless";

let tmp: string;
let repo: string;

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err);
	return out.trim();
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-gitmsg-")));
	repo = path.join(tmp, "repo");
	await fs.mkdir(repo);
	await run(repo, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(repo, "git", "config", key, value);
	}
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "feat: first thing");
	await fs.writeFile(path.join(repo, "b.txt"), "b\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "fix(core): second thing");
	// Uncommitted: an edit, a lockfile edit and a new file.
	await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
	await fs.writeFile(path.join(repo, "bun.lock"), "lockfile noise\n");
	await run(repo, "git", "add", "bun.lock");
	await run(repo, "git", "commit", "-q", "-m", "chore: lock");
	await fs.writeFile(path.join(repo, "bun.lock"), "lockfile noise changed\n");
	await fs.writeFile(path.join(repo, "c.txt"), "new file\n");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const session = { title: "Add the third line", summary: "Added three to a.txt" };

describe("ompArgs", () => {
	it("runs a headless, toolless, sessionless omp on the chosen model with a spend cap", () => {
		const argv = ompArgs("/bin/omp", "smol");
		expect(argv.slice(0, 2)).toEqual(["/bin/omp", "-p"]);
		for (const flag of ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp"]) {
			expect(argv).toContain(flag);
		}
		expect(argv[argv.indexOf("--model") + 1]).toBe("smol");
		expect(argv).toContain("--max-cost");
		const other = ompArgs("omp", "anthropic/claude-haiku");
		expect(other[other.indexOf("--model") + 1]).toBe("anthropic/claude-haiku");
	});
});

describe("capDiff", () => {
	const section = (file: string, body: string) =>
		`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n${body}`;

	it("drops lockfiles and binary files", () => {
		const diff = [
			section("src/a.ts", "+x\n"),
			section("bun.lock", "+lock\n"),
			section("package-lock.json", "+lock\n"),
			"diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n",
		].join("");
		const capped = capDiff(diff, 10_000);
		expect(capped).toContain("src/a.ts");
		expect(capped).not.toContain("bun.lock");
		expect(capped).not.toContain("package-lock");
		expect(capped).not.toContain("img.png");
	});

	it("keeps every file in view when one is huge, within the limit", () => {
		const diff = section("big.ts", `${"+line of text\n".repeat(5_000)}`) + section("small.ts", "+tiny\n");
		const capped = capDiff(diff, 6_000);
		expect(capped.length).toBeLessThanOrEqual(6_000 + 200);
		expect(capped).toContain("small.ts");
		expect(capped).toContain("omitted");
	});
});

describe("gatherContext + buildPrompt", () => {
	it("hands the model the repo's commit style, the session, the diff without lockfiles, and new files", async () => {
		const context = await gatherContext(repo, { commit: true, pr: false }, session);
		expect(context.styleSubjects).toEqual(["chore: lock", "fix(core): second thing", "feat: first thing"]);
		const prompt = buildPrompt(context, { commit: true, pr: false });
		expect(prompt).toContain("Add the third line");
		expect(prompt).toContain("fix(core): second thing");
		expect(prompt).toContain("+three");
		expect(prompt).toContain("c.txt");
		expect(prompt).not.toContain("lockfile noise");
		// Only the commit was asked for.
		expect(prompt).not.toContain("pull request title");
	});

	it("keeps the prompt's diff within the cap however large the change", async () => {
		await fs.writeFile(path.join(repo, "big.txt"), "x".repeat(100).concat("\n").repeat(5_000));
		await run(repo, "git", "add", "-N", "big.txt");
		try {
			const context = await gatherContext(repo, { commit: true, pr: false }, session);
			expect(context.uncommitted?.diff.length ?? 0).toBeLessThanOrEqual(DIFF_CHARS + 400);
		} finally {
			await run(repo, "git", "rm", "-q", "--cached", "big.txt");
			await fs.rm(path.join(repo, "big.txt"));
		}
	});
});

describe("parseAnswer", () => {
	it("reads JSON through code fences and chatter", () => {
		const raw = 'Sure!\n```json\n{"commit":"Add three\\n\\nWhy.","title":"Add three","body":"- a"}\n```';
		expect(parseAnswer(raw, { commit: true, pr: true })).toEqual({
			commit: "Add three\n\nWhy.",
			prTitle: "Add three",
			prBody: "- a",
		});
	});

	it("rejects an answer missing a field that was asked for", () => {
		expect(parseAnswer('{"commit":"x"}', { commit: true, pr: true })).toBeNull();
		expect(parseAnswer('{"commit":""}', { commit: true, pr: false })).toBeNull();
		expect(parseAnswer("no json here", { commit: true, pr: false })).toBeNull();
		expect(parseAnswer('{"title":"t"}', { commit: false, pr: true })).toEqual({
			commit: "",
			prTitle: "t",
			prBody: "",
		});
	});
});

describe("generateGitText", () => {
	const base = { session, ompBin: "/bin/omp", model: "smol" };

	it("runs omp with the prompt on stdin in a neutral folder and returns the model's text", async () => {
		let seen: { argv: string[]; stdin: string; cwd: string } | null = null;
		const fake: RunOmp = async (argv, stdin, cwd) => {
			seen = { argv, stdin, cwd };
			return { code: 0, out: '{"commit":"Add the third line"}', err: "" };
		};
		const text = await generateGitText({ ...base, cwd: repo, want: { commit: true, pr: false }, run: fake });
		expect(text).toEqual({ commit: "Add the third line", prTitle: "", prBody: "", source: "model" });
		expect(seen!.argv).toEqual(ompArgs("/bin/omp", "smol"));
		expect(seen!.stdin).toContain("+three");
		expect(seen!.cwd).toBe(os.tmpdir());
	});

	it("asks for the whole branch when a pull request is wanted", async () => {
		let stdin = "";
		const fake: RunOmp = async (_argv, input) => {
			stdin = input;
			return { code: 0, out: '{"commit":"c","title":"T","body":"B"}', err: "" };
		};
		const text = await generateGitText({ ...base, cwd: repo, want: { commit: true, pr: true }, run: fake });
		expect(text).toMatchObject({ commit: "c", prTitle: "T", prBody: "B", source: "model" });
		expect(stdin).toContain("pull request title");
		expect(stdin).toContain("Whole branch against its base");
	});

	it("falls back to a template with the reason when omp cannot be started", async () => {
		const failing: RunOmp = async () => {
			throw new Error("spawn omp ENOENT");
		};
		const text = await generateGitText({ ...base, cwd: repo, want: { commit: true, pr: true }, run: failing });
		expect(text.source).toBe("fallback");
		expect(text.note).toContain("ENOENT");
		// The repo writes conventional commits: the session title is typed accordingly.
		expect(text.commit.split("\n")[0]).toBe("chore: add the third line");
		expect(text.prTitle).toBe("Add the third line");
		expect(text.prBody).toContain("Added three to a.txt");
	});

	it("falls back when omp exits nonzero or answers nonsense", async () => {
		const exits: RunOmp = async () => ({ code: 3, out: "", err: "Working...\nspend cap reached\n" });
		const first = await generateGitText({ ...base, cwd: repo, want: { commit: true, pr: false }, run: exits });
		expect(first).toMatchObject({ source: "fallback" });
		expect(first.note).toContain("spend cap reached");
		const babble: RunOmp = async () => ({ code: 0, out: "I think the commit should say hello", err: "" });
		const second = await generateGitText({ ...base, cwd: repo, want: { commit: true, pr: false }, run: babble });
		expect(second).toMatchObject({ source: "fallback", note: "the model's answer was not readable" });
		expect(second.commit).not.toBe("");
	});

	it("runs the real default runner: stdin in, answer from stdout", async () => {
		const stub = path.join(tmp, "fake-omp");
		const argvFile = path.join(tmp, "fake-omp-argv.txt");
		const stdinFile = path.join(tmp, "fake-omp-stdin.txt");
		await fs.writeFile(
			stub,
			`#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\ncat > "${stdinFile}"\necho '{"commit":"From the stub"}'\n`,
			{ mode: 0o755 },
		);
		const text = await generateGitText({
			cwd: repo,
			want: { commit: true, pr: false },
			session,
			ompBin: stub,
			model: "smol",
		});
		expect(text).toMatchObject({ commit: "From the stub", source: "model" });
		expect(await Bun.file(argvFile).text()).toContain("--no-tools");
		expect(await Bun.file(stdinFile).text()).toContain("+three");
	});
});

describe("fallbackText", () => {
	it("names a lone file, and does not prefix plain-style repos", async () => {
		const context = await gatherContext(repo, { commit: true, pr: true }, { title: null, summary: null });
		const plain = { ...context, styleSubjects: ["Add things", "Fix bugs"], sessionTitle: null };
		const text = fallbackText(plain, { commit: true, pr: true });
		expect(text.commit.startsWith("Update 2 files")).toBe(true);
		expect(text.prTitle).not.toBe("");
	});
});
