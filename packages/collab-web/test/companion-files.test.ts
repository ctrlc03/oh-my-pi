import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileChangedError } from "../src/lib/companion";
import { fileVersions, listTree, writeRepoFile } from "../scripts/companion-files";
import { FILE_BYTES, fileVersion, readRepoFile } from "../scripts/companion-git";

let tmp: string;
let repo: string;
let outside: string;
let plain: string;

async function run(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
	if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
}

/** The version a reader sees for `file` inside `cwd`. */
async function versionOf(cwd: string, file: string): Promise<string> {
	return (await readRepoFile(cwd, file, false)).version;
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-files-")));
	repo = path.join(tmp, "repo");
	outside = path.join(tmp, "outside");
	plain = path.join(tmp, "plain");
	await Promise.all([repo, outside, plain].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");

	await fs.mkdir(path.join(repo, "src"));
	await fs.writeFile(path.join(repo, ".gitignore"), "ignored.log\nbuild/\n");
	await fs.writeFile(path.join(repo, "tracked.txt"), "one\n");
	await fs.writeFile(path.join(repo, "gone.txt"), "will be deleted\n");
	await fs.writeFile(path.join(repo, "src", "main.ts"), "export {};\n");
	await fs.writeFile(path.join(repo, "constructor"), "a file named like an Object.prototype member\n");
	await run(repo, "git", "init", "-q");
	await run(repo, "git", "add", ".");
	await run(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
	await fs.rm(path.join(repo, "gone.txt"));
	await fs.writeFile(path.join(repo, "untracked.txt"), "new\n");
	await fs.writeFile(path.join(repo, "ignored.log"), "noise\n");
	await fs.mkdir(path.join(repo, "build"));
	await fs.writeFile(path.join(repo, "build", "out.js"), "x\n");
	await fs.writeFile(path.join(repo, "bin.dat"), Buffer.from([1, 0, 2, 3]));
	await fs.writeFile(path.join(repo, "big.txt"), "x".repeat(FILE_BYTES + 10));
	await fs.writeFile(path.join(repo, "edit.txt"), "before\n");
	await fs.writeFile(path.join(repo, "mode.sh"), "#!/bin/sh\n");
	await fs.chmod(path.join(repo, "mode.sh"), 0o750);
	await fs.symlink(path.join(outside, "secret.txt"), path.join(repo, "link-to-secret"));

	await fs.mkdir(path.join(plain, "node_modules", "dep"), { recursive: true });
	await fs.mkdir(path.join(plain, ".git"));
	await fs.mkdir(path.join(plain, "lib"));
	await fs.writeFile(path.join(plain, "node_modules", "dep", "index.js"), "x\n");
	await fs.writeFile(path.join(plain, ".git", "config"), "x\n");
	await fs.writeFile(path.join(plain, "lib", "a.txt"), "a\n");
	await fs.writeFile(path.join(plain, "top.txt"), "top\n");
	await fs.symlink(outside, path.join(plain, "link-to-dir"));
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("listTree", () => {
	it("lists tracked and untracked files git does not ignore, minus deleted ones", async () => {
		const tree = await listTree(repo);
		expect(tree.root).toBe(repo);
		expect(tree.truncated).toBe(false);
		expect(tree.files).toEqual(
			[
				".gitignore",
				"bin.dat",
				"big.txt",
				"constructor",
				"edit.txt",
				"link-to-secret",
				"mode.sh",
				"src/main.ts",
				"tracked.txt",
				"untracked.txt",
			].sort(),
		);
	});

	it("lists the whole repository from a subdirectory", async () => {
		const tree = await listTree(path.join(repo, "src"));
		expect(tree.root).toBe(repo);
		expect(tree.files).toContain("src/main.ts");
	});

	it("walks a folder outside a repository without .git, node_modules or symlinked directories", async () => {
		const tree = await listTree(plain);
		expect(tree).toEqual({ root: plain, files: ["lib/a.txt", "top.txt"], truncated: false });
	});
});

describe("listTree cap", () => {
	it("stops at 20,000 files and says so", async () => {
		const many = path.join(tmp, "many");
		await fs.mkdir(many);
		const names = Array.from({ length: 20_001 }, (_, i) => `f${i}`);
		for (let i = 0; i < names.length; i += 500)
			await Promise.all(names.slice(i, i + 500).map(name => fs.writeFile(path.join(many, name), "")));
		const tree = await listTree(many);
		expect(tree.truncated).toBe(true);
		expect(tree.files).toHaveLength(20_000);
		expect(tree.files).toEqual([...tree.files].sort());
	});
});

describe("writeRepoFile", () => {
	it("saves over the right base and returns the version of what was written", async () => {
		const file = path.join(repo, "edit.txt");
		const before = await fs.stat(file);
		const base = await versionOf(repo, "edit.txt");
		const saved = await writeRepoFile(repo, "edit.txt", "after ✓\n", base, false);
		expect(await Bun.file(file).text()).toBe("after ✓\n");
		expect(saved).not.toBe(base);
		expect(saved).toBe(await versionOf(repo, "edit.txt"));
		const bytes = await Bun.file(file).bytes();
		expect(saved).toBe(fileVersion(await fs.stat(file), bytes));
		// In place: same file, not a replacement.
		expect((await fs.stat(file)).ino).toBe(before.ino);
		// The new version is the base of the next save.
		await writeRepoFile(repo, file, "again\n", saved, false);
		expect(await Bun.file(file).text()).toBe("again\n");
	});

	it("keeps the file mode", async () => {
		const base = await versionOf(repo, "mode.sh");
		await writeRepoFile(repo, "mode.sh", "#!/bin/sh\necho hi\n", base, false);
		expect((await fs.stat(path.join(repo, "mode.sh"))).mode & 0o777).toBe(0o750);
	});

	it("refuses a stale base and reports the version on disk", async () => {
		const stale = await versionOf(repo, "tracked.txt");
		await fs.writeFile(path.join(repo, "tracked.txt"), "changed elsewhere\n");
		const err = await writeRepoFile(repo, "tracked.txt", "mine\n", stale, false).catch(e => e);
		expect(err).toBeInstanceOf(FileChangedError);
		expect(err.version).toBe(await versionOf(repo, "tracked.txt"));
		expect(await Bun.file(path.join(repo, "tracked.txt")).text()).toBe("changed elsewhere\n");
	});

	it("notices a same-size edit that keeps the modification time", async () => {
		const file = path.join(repo, "src", "main.ts");
		const base = await versionOf(repo, "src/main.ts");
		const { atime, mtime } = await fs.stat(file);
		await fs.writeFile(file, "export 1;\n");
		await fs.utimes(file, atime, mtime);
		await expect(writeRepoFile(repo, "src/main.ts", "mine\n", base, false)).rejects.toBeInstanceOf(FileChangedError);
	});

	it("reports a deleted file as changed with no version, and never creates it", async () => {
		const err = await writeRepoFile(repo, "gone.txt", "x\n", "any", false).catch(e => e);
		expect(err).toBeInstanceOf(FileChangedError);
		expect(err.version).toBeNull();
		expect(await Bun.file(path.join(repo, "gone.txt")).exists()).toBe(false);
	});

	it("refuses a symlink that leads outside the repository", async () => {
		await expect(writeRepoFile(repo, "link-to-secret", "owned\n", "any", false)).rejects.toThrow("outside");
		expect(await Bun.file(path.join(outside, "secret.txt")).text()).toBe("secret\n");
		await expect(writeRepoFile(repo, path.join(outside, "secret.txt"), "owned\n", "any", false)).rejects.toThrow(
			"outside",
		);
		await expect(writeRepoFile(plain, "../outside/secret.txt", "owned\n", "any", false)).rejects.toThrow("outside");
	});

	it("refuses files inside .git, even by a path through the repository root", async () => {
		const config = path.join(repo, ".git", "config");
		const before = await Bun.file(config).text();
		const base = (await readRepoFile(repo, ".git/config", false)).version;
		await expect(writeRepoFile(repo, ".git/config", "[core]\n", base, false)).rejects.toThrow(".git");
		await expect(writeRepoFile(repo, path.join(repo, ".GIT", "HEAD"), "x\n", "any", false)).rejects.toThrow();
		expect(await Bun.file(config).text()).toBe(before);
	});

	it("refuses a sandboxed session", async () => {
		const base = await versionOf(repo, "untracked.txt");
		await expect(writeRepoFile(repo, "untracked.txt", "x\n", base, true)).rejects.toThrow("read-only");
		expect(await Bun.file(path.join(repo, "untracked.txt")).text()).toBe("new\n");
	});

	it("refuses binary files, files over the read cap, directories and oversized text", async () => {
		const bin = await versionOf(repo, "bin.dat");
		await expect(writeRepoFile(repo, "bin.dat", "text\n", bin, false)).rejects.toThrow("binary");
		const big = await versionOf(repo, "big.txt");
		await expect(writeRepoFile(repo, "big.txt", "small\n", big, false)).rejects.toThrow("too large");
		await expect(writeRepoFile(repo, "src", "x\n", "any", false)).rejects.toThrow("regular file");
		const base = await versionOf(repo, "untracked.txt");
		await expect(writeRepoFile(repo, "untracked.txt", "x".repeat(4 * 1024 * 1024 + 1), base, false)).rejects.toThrow(
			"too large",
		);
	});

	it("saves in a folder outside a repository", async () => {
		const base = await versionOf(plain, "top.txt");
		const saved = await writeRepoFile(plain, "top.txt", "edited\n", base, false);
		expect(saved).toBe(await versionOf(plain, "top.txt"));
		expect(await Bun.file(path.join(plain, "top.txt")).text()).toBe("edited\n");
	});
});

describe("readRepoFile version and writable", () => {
	it("hashes the content of a file within the read cap and uses size and mtime above it", async () => {
		const small = await readRepoFile(repo, "src/main.ts", false);
		expect(small.version).toMatch(/^[0-9a-z]+-\d+$/);
		expect(small.version.endsWith(`-${small.size}`)).toBe(true);
		const big = await readRepoFile(repo, "big.txt", false);
		const stat = await fs.stat(path.join(repo, "big.txt"));
		expect(big.version).toBe(`${stat.size}-${stat.mtimeMs}`);
	});

	it("is writable for plain text outside .git", async () => {
		expect((await readRepoFile(repo, "src/main.ts", false)).writable).toBe(true);
	});

	it("is not writable when binary, truncated, sandboxed or inside .git", async () => {
		expect((await readRepoFile(repo, "bin.dat", false)).writable).toBe(false);
		const big = await readRepoFile(repo, "big.txt", false);
		expect(big.truncated).toBe(true);
		expect(big.writable).toBe(false);
		expect((await readRepoFile(repo, "src/main.ts", true)).writable).toBe(false);
		expect((await readRepoFile(repo, ".git/HEAD", false)).writable).toBe(false);
	});

	it("is not writable when the file is read-only for the companion", async () => {
		if (process.getuid?.() === 0) return;
		const file = path.join(plain, "lib", "a.txt");
		await fs.chmod(file, 0o444);
		try {
			expect((await readRepoFile(plain, "lib/a.txt", false)).writable).toBe(false);
		} finally {
			await fs.chmod(file, 0o644);
		}
	});
});

describe("fileVersions", () => {
	it("answers in request order, with null for missing files and paths outside the repository", async () => {
		const versions = await fileVersions(repo, [
			"src/main.ts",
			"missing.txt",
			path.join(repo, "untracked.txt"),
			"link-to-secret",
			"../outside/secret.txt",
			"src",
		]);
		expect(versions).toEqual([
			await versionOf(repo, "src/main.ts"),
			null,
			await versionOf(repo, "untracked.txt"),
			null,
			null,
			null,
		]);
	});

	it("matches what a save returns", async () => {
		const base = await versionOf(repo, "untracked.txt");
		const saved = await writeRepoFile(repo, "untracked.txt", "next\n", base, false);
		expect(await fileVersions(repo, ["untracked.txt"])).toEqual([saved]);
	});

	it("rejects more than 20 paths and non-string or malformed paths", async () => {
		await expect(
			fileVersions(
				repo,
				Array.from({ length: 21 }, () => "a"),
			),
		).rejects.toThrow("invalid");
		await expect(fileVersions(repo, [1])).rejects.toThrow("invalid");
		await expect(fileVersions(repo, ["a\0b"])).rejects.toThrow("invalid");
		await expect(fileVersions(repo, "tracked.txt")).rejects.toThrow("invalid");
		expect(
			await fileVersions(
				repo,
				Array.from({ length: 20 }, () => "nope"),
			),
		).toHaveLength(20);
	});
});
