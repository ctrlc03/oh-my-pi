import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	changedFiles,
	diffHunks,
	holdCommit,
	isStale,
	listFiles,
	parseHunks,
	parseNameStatus,
	readBlob,
	releaseCommits,
	repoInfo,
	resolveTarget,
} from "../scripts/companion-blueprint-git";

let tmp: string;
let repo: string;
let origin: string;

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
	for (const [file, text] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
		await fs.writeFile(path.join(dir, file), text);
	}
	await run(dir, "add", "-A");
	await run(dir, "commit", "-q", "-m", message);
	return run(dir, "rev-parse", "HEAD");
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-git-")));
	origin = path.join(tmp, "origin.git");
	repo = path.join(tmp, "repo");
	await run(tmp, "init", "-q", "--bare", "-b", "main", origin);
	await run(tmp, "clone", "-q", origin, repo);
	await run(repo, "checkout", "-q", "-b", "main");
	await commit(repo, { "a.ts": "one\ntwo\n", "keep.ts": "keep\n" }, "first");
	await run(repo, "push", "-q", "origin", "main");
	await run(repo, "checkout", "-q", "-b", "feature");
	const featureHead = await commit(repo, { "a.ts": "one\nTWO\nthree\n", "b.ts": "new\n" }, "feature work");
	// A pull request head, as GitHub publishes it, on the remote only.
	await run(repo, "push", "-q", "origin", `${featureHead}:refs/pull/5/head`);
	await run(repo, "checkout", "-q", "main");
	await commit(repo, { "main-only.ts": "m\n" }, "main moves on");
	await run(repo, "push", "-q", "origin", "main");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("resolveTarget", () => {
	it("compares a branch with the default branch at their merge base", async () => {
		const target = await resolveTarget(repo, { ref: "feature", base: "@default" });
		const mergeBase = await run(repo, "merge-base", "feature", "main");
		expect(target.head.commit).toBe(await run(repo, "rev-parse", "feature"));
		expect(target.base?.commit).toBe(mergeBase);
		expect(target.base?.commit).not.toBe(await run(repo, "rev-parse", "main"));
		expect(target.label).toBe("feature");
	});

	it("says there is nothing to compare when head is already in the base", async () => {
		await expect(resolveTarget(repo, { ref: "main~1", base: "main" })).rejects.toThrow(/nothing to compare/);
		await expect(resolveTarget(repo, { ref: "nope", base: "@default" })).rejects.toThrow(
			/no branch, tag or commit named "nope"/,
		);
	});

	it("maps the working tree to a commit without touching the index, the files, or any branch", async () => {
		await fs.writeFile(path.join(repo, "keep.ts"), "keep\nedited\n");
		await fs.writeFile(path.join(repo, "untracked.ts"), "u\n");
		await run(repo, "add", "keep.ts");
		await fs.writeFile(path.join(repo, "keep.ts"), "keep\nedited\nagain\n");
		const statusBefore = await run(repo, "status", "--porcelain");
		const branchesBefore = await run(repo, "for-each-ref", "refs/heads");
		const target = await resolveTarget(repo, { ref: "@worktree", base: "@default" });
		expect(await run(repo, "status", "--porcelain")).toBe(statusBefore);
		expect(await run(repo, "for-each-ref", "refs/heads")).toBe(branchesBefore);
		expect(await readBlob(repo, target.head.commit, "keep.ts")).toBe("keep\nedited\nagain\n");
		expect(await readBlob(repo, target.head.commit, "untracked.ts")).toBe("u\n");
		expect(target.head.ref).toBe("@worktree");
		const changed = await changedFiles(repo, target.base!.commit, target.head.commit);
		expect(changed.map(file => `${file.change}:${file.path}`).sort()).toEqual([
			"added:untracked.ts",
			"modified:keep.ts",
		]);
		await run(repo, "checkout", "-q", "--", "keep.ts");
		await run(repo, "reset", "-q", "keep.ts");
		await fs.rm(path.join(repo, "untracked.ts"));
	});

	it("fetches a pull request head into a private ref and bases it on the default branch", async () => {
		const target = await resolveTarget(repo, { ref: "pr/5" });
		expect(target.label).toBe("PR #5");
		expect(target.head.commit).toBe(await run(repo, "rev-parse", "feature"));
		expect(target.base?.commit).toBe(await run(repo, "merge-base", "feature", "main"));
		expect(await run(repo, "for-each-ref", "--format=%(refname)", "refs/omp-blueprint/pr")).toBe(
			"refs/omp-blueprint/pr/5",
		);
		expect(await run(repo, "for-each-ref", "refs/heads", "refs/tags", "refs/remotes")).not.toContain("omp-blueprint");
	});
});

describe("kept commits", () => {
	it("holds a commit under a private ref until released, and reports a moved branch as stale", async () => {
		const target = await resolveTarget(repo, { ref: "feature" });
		await holdCommit(repo, "bp-0123456789ab", "head", target.head.commit);
		expect(await run(repo, "rev-parse", "refs/omp-blueprint/maps/bp-0123456789ab/head")).toBe(target.head.commit);
		expect(await isStale(repo, target.head)).toBe(false);
		await run(repo, "checkout", "-q", "feature");
		await commit(repo, { "later.ts": "x\n" }, "later");
		await run(repo, "checkout", "-q", "main");
		expect(await isStale(repo, target.head)).toBe(true);
		expect(await isStale(repo, { commit: target.head.commit, ref: "@worktree" })).toBe(false);
		await releaseCommits(repo, "bp-0123456789ab");
		expect(await run(repo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});

	it("lists and reads files at a commit, and finds the primary root from a linked worktree", async () => {
		const files = await listFiles(repo, "main");
		expect(files).toContain("main-only.ts");
		const main = await run(repo, "rev-parse", "main");
		expect(await readBlob(repo, main, "a.ts")).toBe("one\ntwo\n");
		expect(await readBlob(repo, main, "does-not-exist.ts")).toBeNull();
		const linked = path.join(tmp, "linked");
		await run(repo, "worktree", "add", "-q", "--detach", linked, "main");
		expect((await repoInfo(linked)).root).toBe(repo);
		await run(repo, "worktree", "remove", "--force", linked);
	});
});

describe("diff parsing", () => {
	it("reads name-status output including renames, deletions and odd file names", () => {
		const raw = ["M", "a.ts", "A", "dir/new file.ts", "D", "old.ts", "R087", "from.ts", "to.ts", ""].join("\0");
		expect(parseNameStatus(raw)).toEqual([
			{ change: "modified", path: "a.ts" },
			{ change: "added", path: "dir/new file.ts" },
			{ change: "removed", path: "old.ts" },
			{ change: "modified", path: "to.ts", oldPath: "from.ts" },
		]);
	});

	it("reads hunks of both sides from a zero-context diff", async () => {
		const base = await run(repo, "merge-base", "feature", "main");
		const hunks = await diffHunks(repo, base, await run(repo, "rev-parse", "feature"));
		expect(hunks.get("a.ts")).toEqual({ head: [[2, 3]], base: [[2, 2]] });
		expect(parseHunks("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,0 +4,2 @@\n+a\n+b\n").get("x")).toEqual({
			head: [[4, 5]],
			base: [],
		});
	});
});
