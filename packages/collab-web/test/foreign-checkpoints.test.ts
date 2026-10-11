import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	CHECKPOINT_MAX_FILE_BYTES,
	checkpoint,
	dropCheckpoints,
	pinRepository,
	previewRestore,
	redoRestore,
	restoreFiles,
	sessionDiff,
	turnDiff,
} from "../scripts/foreign/checkpoints";

const SESSION = "claude-0123456789abcdef";

let tmp: string;
let repo: string;
let counter = 0;

async function sh(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${args.join(" ")}: ${err}`);
	return out;
}

const gitc = (cwd: string, ...args: string[]) =>
	sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args);

async function write(rel: string, content: string | Buffer, root = repo): Promise<void> {
	await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
	await fs.writeFile(path.join(root, rel), content);
}

async function read(rel: string, root = repo): Promise<string> {
	return fs.readFile(path.join(root, rel), "utf8");
}

async function exists(rel: string, root = repo): Promise<boolean> {
	return fs.lstat(path.join(root, rel)).then(
		() => true,
		() => false,
	);
}

async function newRepo(name: string): Promise<string> {
	const dir = path.join(tmp, `${name}-${counter++}`);
	await fs.mkdir(dir);
	await sh(dir, "git", "init", "-q", "-b", "main");
	return dir;
}

/** Everything the checkpoint code promises not to touch. */
async function userState(root: string): Promise<Record<string, string>> {
	const gitDir = (await sh(root, "git", "rev-parse", "--absolute-git-dir")).trim();
	const index = await fs.readFile(path.join(gitDir, "index")).catch(() => Buffer.alloc(0));
	const optional = async (...args: string[]) => sh(root, "git", ...args).catch(() => "");
	return {
		status: await sh(root, "git", "status", "--porcelain=v1", "--untracked-files=all"),
		cached: await sh(root, "git", "diff", "--cached", "--no-ext-diff"),
		lsFiles: await sh(root, "git", "ls-files", "-s"),
		indexHash: Bun.hash(index).toString(36),
		head: await optional("rev-parse", "HEAD"),
		branches: await sh(root, "git", "branch", "--list", "-a"),
		stash: await optional("stash", "list"),
		reflog: await optional("reflog", "show", "--all"),
		refs: (await sh(root, "git", "for-each-ref", "--format=%(refname)"))
			.split("\n")
			.filter(ref => !ref.startsWith("refs/omp-checkpoints/"))
			.join("\n"),
	};
}

async function checkpointRefs(root: string): Promise<string[]> {
	return (await sh(root, "git", "for-each-ref", "--format=%(refname)", "refs/omp-checkpoints/"))
		.split("\n")
		.filter(Boolean);
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "foreign-checkpoints-")));
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
	repo = await newRepo("repo");
	await write(".gitignore", "ignored.log\nbuild/\n");
	await write("a.txt", "one\ntwo\nthree\n");
	await write("dir/b.txt", "bee\n");
	await write("old-name.txt", "renamed content\nline 2\nline 3\n");
	await write("gone.txt", "will be deleted\n");
	await write("bin.dat", Buffer.from([1, 0, 2, 3, 0, 255]));
	await write("run.sh", "#!/bin/sh\necho hi\n");
	await fs.chmod(path.join(repo, "run.sh"), 0o755);
	await gitc(repo, "add", "-A");
	await gitc(repo, "commit", "-q", "-m", "init");
});

describe("checkpoint", () => {
	it("returns a commit under refs/omp-checkpoints/<session>/<turn>", async () => {
		const commit = await checkpoint(repo, SESSION, 1);
		expect(commit).toMatch(/^[0-9a-f]{40}$/);
		expect(await checkpointRefs(repo)).toEqual([`refs/omp-checkpoints/${SESSION}/1`]);
		expect((await sh(repo, "git", "rev-parse", `refs/omp-checkpoints/${SESSION}/1`)).trim()).toBe(commit as string);
	});

	it("holds tracked, untracked and uncommitted files but not ignored ones", async () => {
		await write("a.txt", "one\nTWO\nthree\n");
		await write("fresh.txt", "new file\n");
		await write("ignored.log", "noise\n");
		await write("build/out.js", "built\n");
		await checkpoint(repo, SESSION, 1);
		const files = (await sh(repo, "git", "ls-tree", "-r", "--name-only", `refs/omp-checkpoints/${SESSION}/1`)).split(
			"\n",
		);
		expect(files).toContain("a.txt");
		expect(files).toContain("fresh.txt");
		expect(files).toContain(".gitignore");
		expect(files).not.toContain("ignored.log");
		expect(files).not.toContain("build/out.js");
		const blob = await sh(repo, "git", "cat-file", "blob", `refs/omp-checkpoints/${SESSION}/1:a.txt`);
		expect(blob).toBe("one\nTWO\nthree\n");
	});

	it("records modes and symlinks", async () => {
		await fs.symlink("a.txt", path.join(repo, "link"));
		await checkpoint(repo, SESSION, 1);
		const tree = await sh(repo, "git", "ls-tree", "-r", `refs/omp-checkpoints/${SESSION}/1`);
		expect(tree).toMatch(/^100755 blob \w+\trun\.sh$/m);
		expect(tree).toMatch(/^120000 blob \w+\tlink$/m);
		expect(await sh(repo, "git", "cat-file", "blob", `refs/omp-checkpoints/${SESSION}/1:link`)).toBe("a.txt");
	});

	it("skips files over the size cap and directories", async () => {
		await write("huge.bin", Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1, 7));
		const nested = path.join(repo, "nested");
		await fs.mkdir(nested);
		await sh(nested, "git", "init", "-q");
		await write("inner.txt", "inner\n", nested);
		await checkpoint(repo, SESSION, 1);
		const files = (await sh(repo, "git", "ls-tree", "-r", "--name-only", `refs/omp-checkpoints/${SESSION}/1`)).split(
			"\n",
		);
		expect(files).not.toContain("huge.bin");
		expect(files.some(file => file.startsWith("nested"))).toBe(false);
	});

	it("keeps paths with spaces, unicode, tabs and newlines", async () => {
		await write("sp ace/ü ñ.txt", "unicode\n");
		await write("new\nline.txt", "newline\n");
		await write("tab\there.txt", "tab\n");
		await checkpoint(repo, SESSION, 1);
		const files = (
			await sh(
				repo,
				"git",
				"-c",
				"core.quotepath=off",
				"ls-tree",
				"-r",
				"--name-only",
				"-z",
				`refs/omp-checkpoints/${SESSION}/1`,
			)
		).split("\0");
		expect(files).toContain("sp ace/ü ñ.txt");
		expect(files).toContain("new\nline.txt");
		expect(files).toContain("tab\there.txt");
		await write("new\nline.txt", "changed\n");
		await fs.rm(path.join(repo, "tab\there.txt"));
		await restoreFiles(repo, SESSION, 1);
		expect(await read("new\nline.txt")).toBe("newline\n");
		expect(await read("tab\there.txt")).toBe("tab\n");
	});

	it("never touches the user's index, HEAD, branches, stash or reflog", async () => {
		await write("a.txt", "one\nstaged\nthree\n");
		await gitc(repo, "add", "a.txt");
		await write("a.txt", "one\nstaged\nand more\n");
		await write("untracked.txt", "u\n");
		await gitc(repo, "rm", "-q", "--cached", "gone.txt");
		await sh(repo, "git", "status", "--porcelain");
		const before = await userState(repo);
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "changed again\n");
		await checkpoint(repo, SESSION, 2);
		await turnDiff(repo, SESSION, 1);
		await sessionDiff(repo, SESSION);
		await write("a.txt", "one\nstaged\nand more\n");
		const mid = await userState(repo);
		expect(mid.indexHash).toBe(before.indexHash);
		await restoreFiles(repo, SESSION, 1);
		const after = await userState(repo);
		for (const key of ["cached", "lsFiles", "indexHash", "head", "branches", "stash", "reflog", "refs"] as const) {
			expect(after[key]).toBe(before[key]);
		}
		expect(before.cached).toContain("staged");
	});

	it("leaves status byte-identical when the working tree did not change", async () => {
		await write("untracked.txt", "u\n");
		await gitc(repo, "add", "dir/b.txt");
		await write("dir/b.txt", "bee\nmore\n");
		await sh(repo, "git", "status", "--porcelain");
		const before = await userState(repo);
		await checkpoint(repo, SESSION, 1);
		await turnDiff(repo, SESSION, 1);
		await sessionDiff(repo, SESSION);
		expect(await userState(repo)).toEqual(before);
	});

	it("runs no hooks", async () => {
		const marker = path.join(tmp, `hook-ran-${counter++}`);
		const hooks = path.join(repo, ".git", "hooks");
		for (const hook of ["pre-commit", "commit-msg", "post-commit", "reference-transaction", "post-index-change"]) {
			await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		}
		await write("a.txt", "edited\n");
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "edited again\n");
		await turnDiff(repo, SESSION, 1);
		await restoreFiles(repo, SESSION, 1);
		await dropCheckpoints(repo, SESSION);
		expect(await exists(marker, "/")).toBe(false);
	});

	it("does not run attribute filters or convert line endings", async () => {
		const marker = path.join(tmp, `filter-ran-${counter++}`);
		await write(".gitattributes", "*.txt filter=spy text eol=crlf\n");
		await sh(repo, "git", "config", "filter.spy.clean", `touch '${marker}'; cat`);
		await sh(repo, "git", "config", "filter.spy.smudge", `touch '${marker}'; cat`);
		await write("lf.txt", "line1\nline2\n");
		await checkpoint(repo, SESSION, 1);
		expect(await sh(repo, "git", "cat-file", "blob", `refs/omp-checkpoints/${SESSION}/1:lf.txt`)).toBe(
			"line1\nline2\n",
		);
		await write("lf.txt", "changed\n");
		await restoreFiles(repo, SESSION, 1);
		expect(await read("lf.txt")).toBe("line1\nline2\n");
		expect(await exists(marker, "/")).toBe(false);
	});

	it("returns null outside a git repository", async () => {
		const plain = path.join(tmp, `plain-${counter++}`);
		await fs.mkdir(plain);
		expect(await checkpoint(plain, SESSION, 1)).toBeNull();
		expect(await turnDiff(plain, SESSION, 1)).toBeNull();
		expect(await sessionDiff(plain, SESSION)).toBeNull();
		expect(await restoreFiles(plain, SESSION, 1)).toBeNull();
		expect(await dropCheckpoints(plain, SESSION)).toBeNull();
		expect(await checkpoint(path.join(plain, "missing"), SESSION, 1)).toBeNull();
	});

	it("checkpoints a repository with no commits", async () => {
		const empty = await newRepo("empty");
		expect(await checkpoint(empty, SESSION, 1)).toMatch(/^[0-9a-f]{40}$/);
		await write("first.txt", "hello\n", empty);
		const diff = await turnDiff(empty, SESSION, 1);
		expect(diff?.files?.map(file => file.path)).toEqual(["first.txt"]);
	});

	it("rejects ids that are not safe ref components", async () => {
		for (const bad of ["", "../x", "a/b", "-flag", "a b", "a..b", "x.lock", "a:b", "é", "x".repeat(65)]) {
			await expect(checkpoint(repo, bad, 1)).rejects.toThrow("invalid session id");
			await expect(turnDiff(repo, bad, 1)).rejects.toThrow("invalid session id");
			await expect(sessionDiff(repo, bad)).rejects.toThrow("invalid session id");
			await expect(restoreFiles(repo, bad, 1)).rejects.toThrow("invalid session id");
			await expect(dropCheckpoints(repo, bad)).rejects.toThrow("invalid session id");
		}
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
			await expect(checkpoint(repo, SESSION, bad)).rejects.toThrow("invalid turn");
			await expect(turnDiff(repo, SESSION, bad)).rejects.toThrow("invalid turn");
			await expect(restoreFiles(repo, SESSION, bad)).rejects.toThrow("invalid turn");
		}
		expect(await checkpointRefs(repo)).toEqual([]);
	});
});

/** Every loose or packed object of a repository, as raw text, to look for content that must not be in it. */
async function allObjectText(gitDir: string): Promise<string> {
	const out = await sh(gitDir, "git", `--git-dir=${gitDir}`, "cat-file", "--batch-all-objects", "--batch");
	return out;
}

describe("a repository the agent can write to", () => {
	let secretDir: string;

	beforeEach(async () => {
		secretDir = path.join(tmp, `secrets-${counter++}`);
		await fs.mkdir(path.join(secretDir, "dir"), { recursive: true });
		await fs.writeFile(path.join(secretDir, "key.txt"), "TOP-SECRET-KEY-MATERIAL\n");
		await fs.writeFile(path.join(secretDir, "dir", "b.txt"), "TOP-SECRET-IN-DIR\n");
	});

	async function plantBare(folder: string, workTree?: string): Promise<void> {
		const bare = path.join(tmp, `planted-${counter++}`);
		await sh(tmp, "git", "init", "-q", "--bare", bare);
		for (const entry of await fs.readdir(bare))
			await fs.cp(path.join(bare, entry), path.join(folder, entry), { recursive: true });
		if (workTree !== undefined) {
			await fs.appendFile(path.join(folder, "config"), `[core]\n\tbare = false\n\tworktree = ${workTree}\n`);
		}
	}

	it("refuses a bare repository planted in the session folder before the repository is pinned", async () => {
		const sub = path.join(repo, "work");
		await fs.mkdir(sub);
		await plantBare(sub, secretDir);
		await expect(checkpoint(sub, SESSION, 1)).rejects.toThrow("bare repository");
		await expect(pinRepository(sub)).rejects.toThrow("bare repository");
		await expect(turnDiff(sub, SESSION, 1)).rejects.toThrow("bare repository");
		await expect(restoreFiles(sub, SESSION, 1)).rejects.toThrow("bare repository");
		expect((await fs.readdir(path.join(sub, "objects"))).sort()).toEqual(["info", "pack"]);
		expect(await checkpointRefs(repo)).toEqual([]);
	});

	it("keeps using the repository it pinned when one is planted afterwards", async () => {
		const sub = path.join(repo, "work");
		await fs.mkdir(sub);
		await write("work/file.txt", "inside\n");
		expect(await pinRepository(sub)).toBe(true);
		await plantBare(sub, secretDir);
		const objectsBefore = await fs.readdir(path.join(sub, "objects"));
		await checkpoint(sub, SESSION, 1);
		await write("work/file.txt", "changed\n");
		expect((await turnDiff(sub, SESSION, 1))?.files?.map(file => file.path)).toEqual(["work/file.txt"]);
		expect((await fs.readdir(path.join(sub, "objects"))).sort()).toEqual(objectsBefore.sort());
		expect(await checkpointRefs(repo)).toEqual([`refs/omp-checkpoints/${SESSION}/1`]);
		const objects = await allObjectText((await sh(repo, "git", "rev-parse", "--absolute-git-dir")).trim());
		expect(objects).not.toContain("TOP-SECRET");
	});

	it("refuses a git directory that sits inside the session folder", async () => {
		const sub = path.join(repo, "work");
		await fs.mkdir(sub);
		const inner = path.join(sub, "inner-git");
		await sh(sub, "git", "init", "-q", `--separate-git-dir=${inner}`, ".");
		await expect(checkpoint(sub, SESSION, 1)).rejects.toThrow("git directory inside the session folder");
		expect(await checkpointRefs(inner)).toEqual([]);
	});

	it("does not follow a directory swapped for a symlink to hash what is behind it", async () => {
		await checkpoint(repo, SESSION, 1);
		await fs.rm(path.join(repo, "dir"), { recursive: true });
		await fs.symlink(path.join(secretDir, "dir"), path.join(repo, "dir"));
		await fs.symlink(secretDir, path.join(repo, "linked-secrets"));
		await checkpoint(repo, SESSION, 2);
		const tree = await sh(repo, "git", "ls-tree", "-r", "--name-only", `refs/omp-checkpoints/${SESSION}/2`);
		expect(tree).not.toContain("dir/b.txt");
		expect(tree).not.toContain("linked-secrets/key.txt");
		const objects = await allObjectText((await sh(repo, "git", "rev-parse", "--absolute-git-dir")).trim());
		expect(objects).not.toContain("TOP-SECRET");
	});

	it("stores a file swapped for a symlink as the link, never the target's content", async () => {
		await fs.rm(path.join(repo, "a.txt"));
		await fs.symlink(path.join(secretDir, "key.txt"), path.join(repo, "a.txt"));
		await checkpoint(repo, SESSION, 1);
		const entry = await sh(repo, "git", "ls-tree", `refs/omp-checkpoints/${SESSION}/1`, "a.txt");
		expect(entry).toMatch(/^120000 blob /);
		expect(await sh(repo, "git", "cat-file", "blob", `refs/omp-checkpoints/${SESSION}/1:a.txt`)).toBe(
			path.join(secretDir, "key.txt"),
		);
		const objects = await allObjectText((await sh(repo, "git", "rev-parse", "--absolute-git-dir")).trim());
		expect(objects).not.toContain("TOP-SECRET");
	});

	it("does not follow a symlinked directory when it is swapped in while a checkpoint runs", async () => {
		// Many files, so the swap lands somewhere inside the listing, lstat and read steps.
		for (let index = 0; index < 400; index++) await write(`race/f${index}.txt`, `${index}\n`);
		await write("race/key.txt", "placeholder\n");
		await checkpoint(repo, SESSION, 1);
		const swapped = path.join(repo, "race");
		const parked = path.join(repo, "race-parked");
		let stop = false;
		const flipper = (async () => {
			while (!stop) {
				await fs.rename(swapped, parked).catch(() => {});
				await fs.symlink(secretDir, swapped).catch(() => {});
				await Bun.sleep(1);
				await fs.rm(swapped, { force: true }).catch(() => {});
				await fs.rename(parked, swapped).catch(() => {});
				await Bun.sleep(1);
			}
		})();
		try {
			for (let turn = 2; turn < 8; turn++) await checkpoint(repo, SESSION, turn).catch(() => null);
		} finally {
			stop = true;
			await flipper;
		}
		const objects = await allObjectText((await sh(repo, "git", "rev-parse", "--absolute-git-dir")).trim());
		expect(objects).not.toContain("TOP-SECRET");
	});
});

describe("turnDiff and sessionDiff", () => {
	it("reports edits, additions, deletions, renames and binary files for a turn", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "one\nTWO\nthree\nfour\n");
		await write("added.txt", "x\ny\n");
		await fs.rm(path.join(repo, "gone.txt"));
		await fs.rename(path.join(repo, "old-name.txt"), path.join(repo, "new-name.txt"));
		await write("bin.dat", Buffer.from([9, 0, 9, 0]));
		await write("ignored.log", "ignored change\n");
		await checkpoint(repo, SESSION, 2);

		const reply = await turnDiff(repo, SESSION, 1);
		expect(reply?.spansTurns).toBe(1);
		expect(reply?.reason).toBeUndefined();
		expect(reply?.omitted).toBeUndefined();
		const rows = Object.fromEntries((reply?.files ?? []).map(file => [file.path, file]));
		expect(Object.keys(rows).sort()).toEqual([
			"a.txt",
			"added.txt",
			"bin.dat",
			"gone.txt",
			"new-name.txt",
			"old-name.txt",
		]);
		expect(rows["a.txt"]).toMatchObject({ status: "modified", added: 2, removed: 1 });
		expect(rows["a.txt"].diff.startsWith("@@ ")).toBe(true);
		expect(rows["a.txt"].diff).toContain("-two\n+TWO\n");
		expect(rows["added.txt"]).toMatchObject({ status: "added", added: 2, removed: 0 });
		expect(rows["gone.txt"]).toMatchObject({ status: "deleted", added: 0, removed: 1 });
		expect(rows["old-name.txt"]).toMatchObject({ status: "deleted" });
		expect(rows["new-name.txt"]).toMatchObject({ status: "added" });
		expect(rows["bin.dat"]).toMatchObject({ status: "modified", added: null, removed: null, diff: "" });
		expect(rows["a.txt"].truncated).toBeUndefined();
	});

	it("diffs the latest turn against the working tree, and reports a type change", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "edited\n");
		await fs.rm(path.join(repo, "run.sh"));
		await fs.symlink("a.txt", path.join(repo, "run.sh"));
		const reply = await turnDiff(repo, SESSION, 1, { latestTurn: 3 });
		expect(reply?.spansTurns).toBe(3);
		const rows = Object.fromEntries((reply?.files ?? []).map(file => [file.path, file]));
		expect(rows["a.txt"].status).toBe("modified");
		expect(rows["run.sh"].status).toBe("typechange");
		expect(rows["run.sh"].diff).toContain("-echo hi\n");
		expect(rows["run.sh"].diff).toContain("+a.txt\n");
	});

	it("spans the turns whose checkpoint is missing", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "x\n");
		await checkpoint(repo, SESSION, 4);
		expect((await turnDiff(repo, SESSION, 1))?.spansTurns).toBe(3);
	});

	it("sessionDiff compares the first checkpoint with the working tree", async () => {
		await write("a.txt", "turn one\n");
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "turn two\n");
		await write("two.txt", "2\n");
		await checkpoint(repo, SESSION, 2);
		await write("three.txt", "3\n");
		await fs.rm(path.join(repo, "dir/b.txt"));
		const reply = await sessionDiff(repo, SESSION);
		expect(reply?.spansTurns).toBe(2);
		const rows = Object.fromEntries((reply?.files ?? []).map(file => [file.path, file.status]));
		expect(rows).toEqual({ "a.txt": "modified", "two.txt": "added", "three.txt": "added", "dir/b.txt": "deleted" });
	});

	it("returns an empty list when nothing changed", async () => {
		await checkpoint(repo, SESSION, 1);
		expect(await sessionDiff(repo, SESSION)).toEqual({ files: [], spansTurns: 1 });
		expect(await turnDiff(repo, SESSION, 1)).toEqual({ files: [], spansTurns: 1 });
	});

	it("says why there is no diff instead of throwing", async () => {
		expect((await sessionDiff(repo, SESSION))?.files).toBeNull();
		expect((await sessionDiff(repo, SESSION))?.reason).toContain("no checkpoint");
		await checkpoint(repo, SESSION, 1);
		const missing = await turnDiff(repo, SESSION, 7);
		expect(missing?.files).toBeNull();
		expect(missing?.reason).toContain("no checkpoint");
	});

	it("keeps sessions apart", async () => {
		await checkpoint(repo, SESSION, 1);
		await checkpoint(repo, "codex-aaaaaaaaaaaaaaaa", 1);
		await write("a.txt", "later\n");
		await checkpoint(repo, "codex-aaaaaaaaaaaaaaaa", 2);
		expect((await sessionDiff(repo, SESSION))?.files).toHaveLength(1);
		expect((await turnDiff(repo, "codex-aaaaaaaaaaaaaaaa", 1))?.files).toHaveLength(1);
		expect((await turnDiff(repo, "codex-aaaaaaaaaaaaaaaa", 2))?.files).toHaveLength(0);
	});

	it("cuts a very large file's diff and lists it as truncated", async () => {
		const lines = Array.from({ length: 30_000 }, (_, index) => `line ${index} of the original file`);
		await write("big.txt", `${lines.join("\n")}\n`);
		await checkpoint(repo, SESSION, 1);
		await write("big.txt", `${lines.map(line => line.replace("original", "changed")).join("\n")}\n`);
		const reply = await turnDiff(repo, SESSION, 1);
		const big = reply?.files?.find(file => file.path === "big.txt");
		expect(big?.truncated).toBe(true);
		expect(big?.diff.length).toBeLessThanOrEqual(64 * 1024);
		expect(big?.diff.endsWith("\n")).toBe(true);
		expect(big).toMatchObject({ added: 30_000, removed: 30_000 });
	});

	it("lists files past the total budget without their diff", async () => {
		const body = (tag: string) =>
			Array.from({ length: 2_000 }, (_, index) => `${tag} ${index} padding padding padding`).join("\n");
		for (let index = 0; index < 30; index++) await write(`many/f${index}.txt`, `${body("a")}\n`);
		await checkpoint(repo, SESSION, 1);
		for (let index = 0; index < 30; index++) await write(`many/f${index}.txt`, `${body("b")}\n`);
		const reply = await turnDiff(repo, SESSION, 1);
		const files = reply?.files ?? [];
		expect(files).toHaveLength(30);
		expect(files.reduce((sum, file) => sum + file.diff.length, 0)).toBeLessThanOrEqual(1024 * 1024);
		const empty = files.filter(file => file.diff === "");
		expect(empty.length).toBeGreaterThan(0);
		expect(empty.every(file => file.truncated === true && file.added === 2000)).toBe(true);
	});

	it("lists every file when the patch itself outgrows the read cap", async () => {
		const body = (tag: string) =>
			Array.from({ length: 50_000 }, (_, index) => `${tag} line ${index} filler`).join("\n");
		for (let index = 0; index < 6; index++) await write(`huge/f${index}.txt`, `${body("a")}\n`);
		await checkpoint(repo, SESSION, 1);
		for (let index = 0; index < 6; index++) await write(`huge/f${index}.txt`, `${body("b")}\n`);
		const reply = await turnDiff(repo, SESSION, 1);
		const files = reply?.files ?? [];
		expect(reply?.reason).toBeUndefined();
		expect(files.map(file => file.path)).toEqual([0, 1, 2, 3, 4, 5].map(index => `huge/f${index}.txt`));
		expect(files.every(file => file.truncated === true && file.added === 50_000)).toBe(true);
		expect(files.reduce((sum, file) => sum + file.diff.length, 0)).toBeLessThanOrEqual(1024 * 1024);
	});

	it("caps the listing and reports how many files were omitted", async () => {
		for (let index = 0; index < 2_010; index++) await write(`bulk/f${index}.txt`, `${index}\n`);
		await checkpoint(repo, SESSION, 1);
		for (let index = 0; index < 2_010; index++) await write(`bulk/f${index}.txt`, `${index} changed\n`);
		const reply = await turnDiff(repo, SESSION, 1);
		expect(reply?.files).toHaveLength(2_000);
		expect(reply?.omitted).toBe(10);
	});
});

describe("restoreFiles", () => {
	it("restores edits, deletions, renames, additions and modes, and keeps ignored files", async () => {
		await write("a.txt", "checkpoint state\n");
		await write("untracked-early.txt", "present at the checkpoint\n");
		await write("ignored.log", "ignored at checkpoint\n");
		await checkpoint(repo, SESSION, 1);

		await write("a.txt", "agent edit\n");
		await write("added.txt", "created later\n");
		await write("deep/er/added.txt", "created later in a new directory\n");
		await fs.rm(path.join(repo, "gone.txt"));
		await fs.rm(path.join(repo, "untracked-early.txt"));
		await fs.rename(path.join(repo, "old-name.txt"), path.join(repo, "renamed.txt"));
		await write("bin.dat", Buffer.from([7, 7, 0, 7]));
		await fs.chmod(path.join(repo, "run.sh"), 0o644);
		await write("ignored.log", "ignored edit\n");
		await write("build/out.js", "build output\n");

		const result = await restoreFiles(repo, SESSION, 1);
		expect(result?.skipped).toBe(0);
		expect(result?.plan).toEqual({ revert: 3, remove: 3, recreate: 3 });
		expect(await read("a.txt")).toBe("checkpoint state\n");
		expect(await read("gone.txt")).toBe("will be deleted\n");
		expect(await read("untracked-early.txt")).toBe("present at the checkpoint\n");
		expect(await read("old-name.txt")).toBe("renamed content\nline 2\nline 3\n");
		expect(await fs.readFile(path.join(repo, "bin.dat"))).toEqual(Buffer.from([1, 0, 2, 3, 0, 255]));
		expect((await fs.stat(path.join(repo, "run.sh"))).mode & 0o111).not.toBe(0);
		expect(await exists("added.txt")).toBe(false);
		expect(await exists("renamed.txt")).toBe(false);
		expect(await exists("deep")).toBe(false);
		// Ignored files are neither restored nor removed.
		expect(await read("ignored.log")).toBe("ignored edit\n");
		expect(await read("build/out.js")).toBe("build output\n");
		expect(await sessionDiff(repo, SESSION)).toEqual({ files: [], spansTurns: 1 });
	});

	it("restores to an older checkpoint across several turns", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "turn 1 edit\n");
		await write("t1.txt", "t1\n");
		await checkpoint(repo, SESSION, 2);
		await write("a.txt", "turn 2 edit\n");
		await write("t2.txt", "t2\n");
		await restoreFiles(repo, SESSION, 2);
		expect(await read("a.txt")).toBe("turn 1 edit\n");
		expect(await read("t1.txt")).toBe("t1\n");
		expect(await exists("t2.txt")).toBe(false);
		await restoreFiles(repo, SESSION, 1);
		expect(await read("a.txt")).toBe("one\ntwo\nthree\n");
		expect(await exists("t1.txt")).toBe(false);
	});

	it("restores a symlink, a file replaced by a symlink, and a file replaced by a directory", async () => {
		await fs.symlink("a.txt", path.join(repo, "link"));
		await checkpoint(repo, SESSION, 1);
		await fs.rm(path.join(repo, "link"));
		await write("link", "now a file\n");
		await fs.rm(path.join(repo, "a.txt"));
		await fs.symlink("dir/b.txt", path.join(repo, "a.txt"));
		await fs.rm(path.join(repo, "dir"), { recursive: true });
		await write("dir", "a file where a directory was\n");
		const result = await restoreFiles(repo, SESSION, 1);
		expect(result?.skipped).toBe(0);
		expect(await fs.readlink(path.join(repo, "link"))).toBe("a.txt");
		expect((await fs.lstat(path.join(repo, "a.txt"))).isFile()).toBe(true);
		expect(await read("a.txt")).toBe("one\ntwo\nthree\n");
		expect(await read("dir/b.txt")).toBe("bee\n");
	});

	it("never writes through a symlinked directory", async () => {
		await write(".gitignore", "ignored.log\nbuild/\ndir\n");
		await checkpoint(repo, SESSION, 1);
		const outside = path.join(tmp, `outside-${counter++}`);
		await fs.mkdir(outside);
		await fs.rm(path.join(repo, "dir"), { recursive: true });
		await fs.symlink(outside, path.join(repo, "dir"));
		const result = await restoreFiles(repo, SESSION, 1);
		expect(result?.skipped).toBeGreaterThan(0);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	it("leaves an ignored file that is in the way of a deleted one", async () => {
		await write("late.txt", "tracked at the checkpoint\n");
		await checkpoint(repo, SESSION, 1);
		await fs.rm(path.join(repo, "late.txt"));
		await write(".gitignore", "ignored.log\nbuild/\nlate.txt\n");
		await write("late.txt", "ignored now\n");
		const result = await restoreFiles(repo, SESSION, 1);
		expect(result?.skipped).toBe(1);
		expect(await read("late.txt")).toBe("ignored now\n");
		expect(await read(".gitignore")).toBe("ignored.log\nbuild/\n");
	});

	it("keeps a file that was already there but not covered by the checkpoint", async () => {
		await write("notes.txt", "was ignored at the checkpoint\n");
		await write(".gitignore", "ignored.log\nbuild/\nnotes.txt\n");
		await checkpoint(repo, SESSION, 1);
		await write(".gitignore", "ignored.log\nbuild/\n");
		await write("created-after.txt", "after\n");
		const result = await restoreFiles(repo, SESSION, 1);
		expect(await read("notes.txt")).toBe("was ignored at the checkpoint\n");
		expect(await exists("created-after.txt")).toBe(false);
		expect(result?.skipped).toBe(1);
		expect(result?.plan.remove).toBe(1);
	});

	it("keeps staged changes staged and HEAD where it is", async () => {
		await write("a.txt", "staged edit\n");
		await gitc(repo, "add", "a.txt");
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "unstaged edit\n");
		const before = await userState(repo);
		await restoreFiles(repo, SESSION, 1);
		expect(await read("a.txt")).toBe("staged edit\n");
		const after = await userState(repo);
		expect(after.cached).toBe(before.cached);
		expect(after.lsFiles).toBe(before.lsFiles);
		expect(after.indexHash).toBe(before.indexHash);
		expect(after.head).toBe(before.head);
	});

	it("keeps the tree as it was before the restore under before-restore", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "work in progress\n");
		await write("wip.txt", "wip\n");
		await restoreFiles(repo, SESSION, 1);
		const backup = `refs/omp-checkpoints/${SESSION}/before-restore`;
		expect(await sh(repo, "git", "cat-file", "blob", `${backup}:a.txt`)).toBe("work in progress\n");
		expect(await sh(repo, "git", "cat-file", "blob", `${backup}:wip.txt`)).toBe("wip\n");
		// The backup is not a turn.
		expect((await sessionDiff(repo, SESSION))?.spansTurns).toBe(1);
	});

	it("rejects a turn with no checkpoint", async () => {
		await checkpoint(repo, SESSION, 1);
		await expect(restoreFiles(repo, SESSION, 2)).rejects.toThrow("no checkpoint");
	});

	it("restores in a subdirectory of the repository, covering the whole tree", async () => {
		await checkpoint(path.join(repo, "dir"), SESSION, 1);
		await write("a.txt", "edited\n");
		await write("dir/b.txt", "edited\n");
		await restoreFiles(path.join(repo, "dir"), SESSION, 1);
		expect(await read("a.txt")).toBe("one\ntwo\nthree\n");
		expect(await read("dir/b.txt")).toBe("bee\n");
	});
});

describe("previewRestore and redoRestore", () => {
	it("previews exactly what the restore then does, and writes nothing", async () => {
		await write("a.txt", "checkpoint state\n");
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "agent edit\n");
		await write("added.txt", "later\n");
		await fs.rm(path.join(repo, "gone.txt"));
		const before = await userState(repo);
		const refsBefore = await checkpointRefs(repo);
		const preview = await previewRestore(repo, SESSION, 1);
		expect(preview).toEqual({ revert: 1, remove: 1, recreate: 1 });
		expect(await read("a.txt")).toBe("agent edit\n");
		expect(await exists("gone.txt")).toBe(false);
		expect(await userState(repo)).toEqual(before);
		expect(await checkpointRefs(repo)).toEqual(refsBefore);
		expect((await restoreFiles(repo, SESSION, 1))?.plan).toEqual(preview as NonNullable<typeof preview>);
	});

	it("returns null for no repository or no checkpoint, and rejects bad ids", async () => {
		const plain = path.join(tmp, `plain-${counter++}`);
		await fs.mkdir(plain);
		expect(await previewRestore(plain, SESSION, 1)).toBeNull();
		expect(await previewRestore(repo, SESSION, 1)).toBeNull();
		await expect(previewRestore(repo, "../x", 1)).rejects.toThrow("invalid session id");
		await expect(previewRestore(repo, SESSION, -1)).rejects.toThrow("invalid turn");
		expect(await redoRestore(plain, SESSION)).toBeNull();
		await expect(redoRestore(repo, "../x")).rejects.toThrow("invalid session id");
	});

	it("undoes a restore, and redoes it when called again", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "agent edit\n");
		await write("added.txt", "later\n");
		await fs.rm(path.join(repo, "gone.txt"));
		await restoreFiles(repo, SESSION, 1);
		expect(await read("a.txt")).toBe("one\ntwo\nthree\n");
		expect(await exists("added.txt")).toBe(false);

		const undone = await redoRestore(repo, SESSION);
		expect(undone?.plan).toEqual({ revert: 1, remove: 1, recreate: 1 });
		expect(undone?.skipped).toBe(0);
		expect(await read("a.txt")).toBe("agent edit\n");
		expect(await read("added.txt")).toBe("later\n");
		expect(await exists("gone.txt")).toBe(false);

		await redoRestore(repo, SESSION);
		expect(await read("a.txt")).toBe("one\ntwo\nthree\n");
		expect(await exists("added.txt")).toBe(false);
		expect(await read("gone.txt")).toBe("will be deleted\n");
	});

	it("throws when there is no restore to undo", async () => {
		await checkpoint(repo, SESSION, 1);
		await expect(redoRestore(repo, SESSION)).rejects.toThrow("no file restore to undo");
	});
});

describe("linked worktrees", () => {
	it("checkpoints, diffs and restores the worktree, not the main checkout", async () => {
		const linked = path.join(tmp, `linked-${counter++}`);
		await gitc(repo, "worktree", "add", "-q", "-b", "side", linked);
		await write("a.txt", "main checkout edit\n");
		await write("only-in-worktree.txt", "w1\n", linked);
		const mainBefore = await userState(repo);
		const linkedBefore = await userState(linked);

		expect(await checkpoint(linked, SESSION, 1)).toMatch(/^[0-9a-f]{40}$/);
		await write("a.txt", "worktree edit\n", linked);
		await write("new.txt", "n\n", linked);
		await fs.rm(path.join(linked, "only-in-worktree.txt"));
		const reply = await sessionDiff(linked, SESSION);
		const rows = Object.fromEntries((reply?.files ?? []).map(file => [file.path, file.status]));
		expect(rows).toEqual({ "a.txt": "modified", "new.txt": "added", "only-in-worktree.txt": "deleted" });

		const result = await restoreFiles(linked, SESSION, 1);
		expect(result?.plan).toEqual({ revert: 1, remove: 1, recreate: 1 });
		expect(await read("a.txt", linked)).toBe("one\ntwo\nthree\n");
		expect(await read("only-in-worktree.txt", linked)).toBe("w1\n");
		expect(await exists("new.txt", linked)).toBe(false);
		// The main checkout and both indexes are exactly as they were.
		expect(await userState(repo)).toEqual(mainBefore);
		expect((await userState(linked)).indexHash).toBe(linkedBefore.indexHash);
		expect(await read("a.txt")).toBe("main checkout edit\n");

		// The refs live in the shared store, so the main checkout can drop them.
		expect(await checkpointRefs(repo)).toContain(`refs/omp-checkpoints/${SESSION}/1`);
		expect(await dropCheckpoints(repo, SESSION)).toBe(2);
		expect(await checkpointRefs(linked)).toEqual([]);
	});
});

describe("dropCheckpoints", () => {
	it("deletes every ref of the session and only that session's", async () => {
		await checkpoint(repo, SESSION, 1);
		await checkpoint(repo, SESSION, 2);
		await checkpoint(repo, "grok-bbbbbbbbbbbbbbbb", 1);
		expect(await dropCheckpoints(repo, SESSION)).toBe(2);
		expect(await checkpointRefs(repo)).toEqual(["refs/omp-checkpoints/grok-bbbbbbbbbbbbbbbb/1"]);
		expect((await sessionDiff(repo, SESSION))?.files).toBeNull();
		expect(await dropCheckpoints(repo, SESSION)).toBe(0);
	});

	it("does not match a session whose id merely starts with the same text", async () => {
		await checkpoint(repo, "claude-1", 1);
		await checkpoint(repo, "claude-12", 1);
		expect(await dropCheckpoints(repo, "claude-1")).toBe(1);
		expect(await checkpointRefs(repo)).toEqual(["refs/omp-checkpoints/claude-12/1"]);
	});

	it("also removes the restore backup", async () => {
		await checkpoint(repo, SESSION, 1);
		await restoreFiles(repo, SESSION, 1);
		expect(await checkpointRefs(repo)).toHaveLength(2);
		expect(await dropCheckpoints(repo, SESSION)).toBe(2);
		expect(await checkpointRefs(repo)).toEqual([]);
	});
});

describe("concurrency", () => {
	it("serialises overlapping calls on one repository", async () => {
		await checkpoint(repo, SESSION, 1);
		await write("a.txt", "x\n");
		const results = await Promise.all([
			checkpoint(repo, SESSION, 2),
			turnDiff(repo, SESSION, 1),
			sessionDiff(repo, SESSION),
			checkpoint(repo, SESSION, 3),
		]);
		expect(results[0]).toMatch(/^[0-9a-f]{40}$/);
		expect(results[3]).toMatch(/^[0-9a-f]{40}$/);
		expect(results[1]?.files).toHaveLength(1);
		expect(results[2]?.files).toHaveLength(1);
	});
});
