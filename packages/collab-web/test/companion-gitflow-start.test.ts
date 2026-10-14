import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorktree } from "../scripts/companion-gitflow";

let tmp: string;
let repo: string;
let worktrees: string;
let older: string;
let newer: string;

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

async function branches(): Promise<string[]> {
	return (await run(repo, "git", "branch", "--format=%(refname:short)")).split("\n");
}

async function worktreePaths(): Promise<string[]> {
	const listed = await run(repo, "git", "worktree", "list", "--porcelain");
	return listed
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => line.slice("worktree ".length));
}

async function exists(target: string): Promise<boolean> {
	return await fs
		.stat(target)
		.then(() => true)
		.catch(() => false);
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-gitflow-start-")));
	repo = path.join(tmp, "repo");
	worktrees = path.join(tmp, "worktrees");
	await fs.mkdir(repo);
	await run(repo, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(repo, "git", "config", key, value);
	}
	await fs.writeFile(path.join(repo, "a.txt"), "old\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "first");
	older = await run(repo, "git", "rev-parse", "HEAD");
	await fs.writeFile(path.join(repo, "a.txt"), "new\n");
	await fs.writeFile(path.join(repo, "b.txt"), "later\n");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "commit", "-q", "-m", "second");
	newer = await run(repo, "git", "rev-parse", "HEAD");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("createWorktree from a start commit", () => {
	it("starts at HEAD when no start commit is given", async () => {
		const created = await createWorktree(repo, worktrees, "from-head");
		expect(await run(created.path, "git", "rev-parse", "HEAD")).toBe(newer);
		expect(await run(repo, "git", "rev-parse", "from-head")).toBe(newer);
		expect(await Bun.file(path.join(created.path, "a.txt")).text()).toBe("new\n");
		expect(await Bun.file(path.join(created.path, "b.txt")).text()).toBe("later\n");
	});

	it("starts at HEAD when the options carry no start", async () => {
		const created = await createWorktree(repo, worktrees, "from-head-options", new Date(), { branchPrefix: "x/" });
		expect(await run(created.path, "git", "rev-parse", "HEAD")).toBe(newer);
	});

	it("starts at an explicit older commit: its files, with the branch pointing at it", async () => {
		const created = await createWorktree(repo, worktrees, "from-older", new Date(), { start: older });
		expect(created).toEqual({ root: repo, path: path.join(worktrees, "repo", "from-older"), branch: "from-older" });
		expect(await run(created.path, "git", "rev-parse", "HEAD")).toBe(older);
		expect(await run(repo, "git", "rev-parse", "from-older")).toBe(older);
		expect(await run(created.path, "git", "symbolic-ref", "--short", "HEAD")).toBe("from-older");
		expect(await Bun.file(path.join(created.path, "a.txt")).text()).toBe("old\n");
		expect(await exists(path.join(created.path, "b.txt"))).toBe(false);
		// The checkout it was made from is untouched.
		expect(await run(repo, "git", "rev-parse", "HEAD")).toBe(newer);
		expect(await Bun.file(path.join(repo, "a.txt")).text()).toBe("new\n");
	});

	it("gives a generated branch name when only the start commit is given", async () => {
		const created = await createWorktree(repo, worktrees, undefined, new Date(2026, 9, 9, 7, 5), { start: older });
		expect(created.branch).toMatch(/^omp\/20261009-0705-[0-9a-f]{4}$/);
		expect(await run(repo, "git", "rev-parse", created.branch)).toBe(older);
	});

	it("refuses a start that is not a full commit id, before touching anything", async () => {
		const before = { branches: await branches(), trees: await worktreePaths() };
		for (const start of [
			"HEAD",
			"main",
			older.slice(0, 12),
			"--detach",
			`${older} --force`,
			older.toUpperCase(),
			"",
		]) {
			await expect(createWorktree(repo, worktrees, "bad-start", new Date(), { start })).rejects.toThrow(
				"invalid start commit",
			);
		}
		expect(await branches()).toEqual(before.branches);
		expect(await worktreePaths()).toEqual(before.trees);
		expect(await exists(path.join(worktrees, "repo", "bad-start"))).toBe(false);
	});

	it("reports a commit id that is not in the repository as a clean error, leaving no worktree or branch", async () => {
		const before = { branches: await branches(), trees: await worktreePaths() };
		const missing = "0123456789abcdef0123456789abcdef01234567";
		const failure = await createWorktree(repo, worktrees, "missing-start", new Date(), { start: missing }).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message.length).toBeGreaterThan(0);
		expect(message).not.toBe("git worktree add failed");
		expect(message.split("\n").length).toBeLessThanOrEqual(6);
		expect(await branches()).toEqual(before.branches);
		expect(await worktreePaths()).toEqual(before.trees);
		expect(await exists(path.join(worktrees, "repo", "missing-start"))).toBe(false);
	});

	it("refuses a start that exists but is not a commit, leaving nothing behind", async () => {
		const before = { branches: await branches(), trees: await worktreePaths() };
		const blob = await run(repo, "git", "rev-parse", "HEAD:a.txt");
		await expect(createWorktree(repo, worktrees, "blob-start", new Date(), { start: blob })).rejects.toThrow();
		expect(await branches()).toEqual(before.branches);
		expect(await worktreePaths()).toEqual(before.trees);
		expect(await exists(path.join(worktrees, "repo", "blob-start"))).toBe(false);
	});

	it("still validates the branch name when a start commit is given", async () => {
		await expect(createWorktree(repo, worktrees, "-bad", new Date(), { start: older })).rejects.toThrow(
			"invalid branch name",
		);
		await expect(createWorktree(repo, worktrees, "main", new Date(), { start: older })).rejects.toThrow();
		expect(await run(repo, "git", "rev-parse", "main")).toBe(newer);
	});
});
