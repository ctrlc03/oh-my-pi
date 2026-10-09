import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gitDiff, gitSnapshot, isInside, readRepoFile } from "../scripts/companion-git";

let tmp: string;
let repo: string;
let outside: string;
let plain: string;

async function run(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-git-")));
	repo = path.join(tmp, "repo");
	outside = path.join(tmp, "repo-evil");
	plain = path.join(tmp, "plain");
	await Promise.all([repo, outside, plain].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
	await fs.writeFile(path.join(tmp, "parent-secret.txt"), "secret\n");
	await fs.writeFile(path.join(repo, "tracked.txt"), "one\ntwo\n");
	await fs.writeFile(path.join(repo, "bin.dat"), Buffer.from([1, 0, 2, 3]));
	await run(repo, "git", "init", "-q");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	await fs.writeFile(path.join(repo, "tracked.txt"), "one\nthree\nfour\n");
	await fs.writeFile(path.join(repo, "new.txt"), "a\nb\n");
	await fs.symlink(path.join(outside, "secret.txt"), path.join(repo, "link-to-secret"));
	await fs.symlink(outside, path.join(repo, "link-to-dir"));
	await fs.writeFile(path.join(plain, "ok.txt"), "plain\n");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("isInside", () => {
	it("treats a sibling sharing the name prefix as outside", () => {
		expect(isInside("/a/repo", "/a/repo-evil/x")).toBe(false);
		expect(isInside("/a/repo", "/a/repo/x")).toBe(true);
		expect(isInside("/a/repo", "/a/repo")).toBe(true);
		expect(isInside("/a/repo", "/a")).toBe(false);
		expect(isInside("/a/repo", "/a/repo/..hidden")).toBe(true);
	});
});

describe("readRepoFile containment", () => {
	it("reads files inside the repository, by relative or absolute path", async () => {
		expect((await readRepoFile(repo, "tracked.txt")).text).toBe("one\nthree\nfour\n");
		expect((await readRepoFile(repo, path.join(repo, "tracked.txt"))).path).toBe("tracked.txt");
	});

	it("rejects paths that leave the repository", async () => {
		await expect(readRepoFile(repo, "../parent-secret.txt")).rejects.toThrow("outside");
		await expect(readRepoFile(repo, path.join(outside, "secret.txt"))).rejects.toThrow("outside");
		await expect(readRepoFile(repo, "/etc/hosts")).rejects.toThrow("outside");
	});

	it("rejects symlinks that resolve outside the repository", async () => {
		await expect(readRepoFile(repo, "link-to-secret")).rejects.toThrow("outside");
		await expect(readRepoFile(repo, "link-to-dir/secret.txt")).rejects.toThrow("outside");
	});

	it("confines a session outside any repository to its cwd", async () => {
		expect((await readRepoFile(plain, "ok.txt")).text).toBe("plain\n");
		await expect(readRepoFile(plain, "../repo/tracked.txt")).rejects.toThrow("outside");
	});

	it("reports a file with NUL bytes as binary", async () => {
		const file = await readRepoFile(repo, "bin.dat");
		expect(file.text).toBeNull();
		expect(file.size).toBe(4);
	});
});

describe("git", () => {
	it("lists changes with line counts, untracked files included", async () => {
		const snap = await gitSnapshot(repo);
		expect(snap.root).toBe(repo);
		expect(snap.commits.map(c => c.subject)).toEqual(["init"]);
		const byPath = Object.fromEntries(snap.files.map(f => [f.path, f]));
		expect(byPath["tracked.txt"]).toMatchObject({ status: " M", added: 2, removed: 1 });
		expect(byPath["new.txt"]).toMatchObject({ status: "??", added: 2, removed: 0 });
	});

	it("says so outside a repository", async () => {
		await expect(gitSnapshot(plain)).rejects.toThrow("not a git repository");
	});

	it("diffs tracked and untracked files, and never reads outside the repository", async () => {
		expect((await gitDiff(repo, "tracked.txt")).diff).toContain("+three");
		expect((await gitDiff(repo, "new.txt")).diff).toContain("+b");
		await expect(gitDiff(repo, "../parent-secret.txt")).rejects.toThrow("inside the repository");
		await expect(gitDiff(repo, "/etc/hosts")).rejects.toThrow("inside the repository");
		// git refuses to look beyond a symlinked directory, so nothing from outside the repository can leak.
		expect((await gitDiff(repo, "link-to-dir/secret.txt")).diff).toBe("");
	});
});
