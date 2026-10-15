import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	busyBySession,
	findArtifacts,
	isLinkedWorktree,
	listWorktrees,
	measureBytes,
	parseLsof,
	parsePs,
	probeProcesses,
	readFreeSpace,
	removeArtifact,
} from "../scripts/companion-disk-fs";
import { createWorktree } from "../scripts/companion-gitflow";

let tmp: string;
let repo: string;
let trees: string;
let outside: string;
const spawned: Bun.Subprocess[] = [];

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

/** A process that prints "ready" once it is in place; killed after the test. */
function spawnReady(command: string[], cwd: string): Bun.Subprocess<"ignore", "pipe", "ignore"> {
	const proc = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	spawned.push(proc);
	return proc;
}

async function started(proc: Bun.Subprocess<"ignore", "pipe", "ignore">): Promise<void> {
	for await (const chunk of proc.stdout) {
		if (Buffer.from(chunk).toString().includes("ready")) return;
	}
	throw new Error("the process ended before it was ready");
}

async function initRepo(dir: string): Promise<void> {
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await run(dir, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(dir, "git", "config", key, value);
	}
	await fs.writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
	await fs.writeFile(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
	await fs.writeFile(path.join(dir, "package.json"), "{}\n");
	await fs.writeFile(path.join(dir, ".gitignore"), "target/\nnode_modules/\ndist/\n");
	await run(dir, "git", "add", ".");
	await run(dir, "git", "commit", "-q", "-m", "init");
}

async function put(file: string, bytes = 1): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, Buffer.alloc(bytes, 97));
}

/** A linked worktree under `trees`, with cargo and npm output in it. */
async function makeTree(branch: string): Promise<string> {
	const created = await createWorktree(repo, trees, branch);
	const tree = await fs.realpath(created.path);
	await put(path.join(tree, "target", "CACHEDIR.TAG"));
	await put(path.join(tree, "target", "debug", "big.bin"), 2_000_000);
	await put(path.join(tree, "node_modules", "pkg", "index.js"), 500_000);
	return tree;
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-disk-fs-")));
	repo = path.join(tmp, "repo");
	trees = path.join(tmp, "trees");
	outside = path.join(tmp, "outside");
	await initRepo(repo);
	await fs.mkdir(trees, { recursive: true });
	await fs.mkdir(outside, { recursive: true });
});

afterEach(async () => {
	for (const proc of spawned.splice(0)) proc.kill();
	await fs.rm(tmp, { recursive: true, force: true });
});

const exists = (target: string): Promise<boolean> =>
	fs.lstat(target).then(
		() => true,
		() => false,
	);

describe("listWorktrees", () => {
	test("lists linked worktrees only: not a main checkout, a clone or a submodule under the folder", async () => {
		const tree = await makeTree("feature-a");
		const clone = path.join(trees, "other", "clone");
		await fs.mkdir(path.dirname(clone), { recursive: true });
		await run(tmp, "git", "clone", "-q", repo, clone);
		const submodule = path.join(trees, "other", "sub");
		await fs.mkdir(submodule, { recursive: true });
		await fs.mkdir(path.join(repo, ".git", "modules", "sub"), { recursive: true });
		await fs.writeFile(path.join(submodule, ".git"), `gitdir: ${path.join(repo, ".git", "modules", "sub")}\n`);
		expect(await listWorktrees([trees])).toEqual([tree]);
		expect(await isLinkedWorktree(clone)).toBe(false);
		expect(await isLinkedWorktree(submodule)).toBe(false);
		expect(await isLinkedWorktree(repo)).toBe(false);
	});

	test("a worktree made elsewhere is not listed", async () => {
		await createWorktree(repo, path.join(tmp, "elsewhere"), "feature-b");
		expect(await listWorktrees([trees])).toEqual([]);
	});
});

describe("findArtifacts", () => {
	test("finds cargo and npm output that git ignores, and not source", async () => {
		const tree = await makeTree("feature-a");
		const found = await findArtifacts(tree);
		expect(found.map(item => `${item.kind}`).sort()).toEqual(["node_modules", "target"]);
		expect(found.every(item => item.path.startsWith(`${tree}${path.sep}`))).toBe(true);
	});

	test("dist and build only when git ignores them; never when it tracks anything in them", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(tree, "dist", "app.js"));
		await put(path.join(tree, "build", "out.js"));
		expect((await findArtifacts(tree)).map(item => item.kind).sort()).toEqual(["dist", "node_modules", "target"]);
		await fs.writeFile(path.join(tree, ".gitignore"), "target/\nnode_modules/\ndist/\nbuild/\n");
		expect((await findArtifacts(tree)).map(item => item.kind).sort()).toEqual([
			"build",
			"dist",
			"node_modules",
			"target",
		]);
		await run(tree, "git", "add", "-f", "node_modules/pkg/index.js", "dist/app.js");
		expect((await findArtifacts(tree)).map(item => item.kind).sort()).toEqual(["build", "target"]);
	});

	test("a target without Cargo.toml beside it, or without cargo's own files in it, is not build output", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(tree, "docs", "target", "notes.md"));
		await put(path.join(tree, "tools", "Cargo.toml"));
		await put(path.join(tree, "tools", "target", "mine.txt"));
		const found = (await findArtifacts(tree)).map(item => path.relative(tree, item.path));
		expect(found).toContain("target");
		expect(found).not.toContain(path.join("docs", "target"));
		expect(found).not.toContain(path.join("tools", "target"));
	});

	test("a monorepo's packages are found two folders down; nothing inside an artifact is", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(tree, "packages", "a", "package.json"));
		await put(path.join(tree, "packages", "a", "node_modules", "x", "index.js"));
		await put(path.join(tree, "node_modules", "pkg", "package.json"));
		await put(path.join(tree, "node_modules", "pkg", "node_modules", "y", "index.js"));
		await put(path.join(tree, "a", "b", "c", "package.json"));
		await put(path.join(tree, "a", "b", "c", "node_modules", "z.js"));
		const found = (await findArtifacts(tree)).map(item => path.relative(tree, item.path)).sort();
		expect(found).toEqual(["node_modules", path.join("packages", "a", "node_modules"), "target"].sort());
	});

	test("a symlink named like build output is not followed", async () => {
		const tree = await makeTree("feature-a");
		await fs.rm(path.join(tree, "target"), { recursive: true });
		await put(path.join(outside, "CACHEDIR.TAG"));
		await fs.symlink(outside, path.join(tree, "target"));
		expect((await findArtifacts(tree)).map(item => item.kind)).toEqual(["node_modules"]);
	});
});

describe("removeArtifact", () => {
	test("deletes the build output and leaves the source, the git link and the repository alone", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(tree, "notes", "todo.txt"));
		await removeArtifact([trees], path.join(tree, "target"));
		await removeArtifact([trees], path.join(tree, "node_modules"));
		expect(await exists(path.join(tree, "target"))).toBe(false);
		expect(await exists(path.join(tree, "node_modules"))).toBe(false);
		expect(await Bun.file(path.join(tree, "src", "main.rs")).text()).toBe("fn main() {}\n");
		expect(await exists(path.join(tree, "Cargo.toml"))).toBe(true);
		expect(await exists(path.join(tree, "notes", "todo.txt"))).toBe(true);
		expect(await exists(path.join(tree, ".git"))).toBe(true);
		expect(await run(tree, "git", "status", "--porcelain")).toBe("?? notes/");
		expect(await run(repo, "git", "worktree", "list", "--porcelain")).toContain(tree);
		expect(await exists(path.join(repo, "src", "main.rs"))).toBe(true);
	});

	test("never follows a symlink found inside: what it points at stays", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(outside, "precious.txt"), 10);
		await fs.symlink(outside, path.join(tree, "target", "debug", "link"));
		await removeArtifact([trees], path.join(tree, "target"));
		expect(await exists(path.join(tree, "target"))).toBe(false);
		expect(await Bun.file(path.join(outside, "precious.txt")).text()).toBe("aaaaaaaaaa");
	});

	test("refuses a symlinked artifact and leaves its target alone", async () => {
		const tree = await makeTree("feature-a");
		await fs.rm(path.join(tree, "target"), { recursive: true });
		await put(path.join(outside, "keep.txt"));
		await fs.symlink(outside, path.join(tree, "target"));
		await expect(removeArtifact([trees], path.join(tree, "target"))).rejects.toThrow("not a folder");
		expect(await exists(path.join(outside, "keep.txt"))).toBe(true);
	});

	test("refuses a path that reaches an artifact through a symlinked folder", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(outside, "pkg", "node_modules", "keep.txt"));
		await fs.symlink(path.join(outside, "pkg"), path.join(tree, "linked"));
		await expect(removeArtifact([trees], path.join(tree, "linked", "node_modules"))).rejects.toThrow(
			"outside the worktrees folder",
		);
		expect(await exists(path.join(outside, "pkg", "node_modules", "keep.txt"))).toBe(true);
	});

	test("refuses a symlinked worktree folder that leads out of the worktrees folder", async () => {
		const tree = await makeTree("feature-a");
		const moved = path.join(outside, "moved");
		await fs.rename(tree, moved);
		await fs.symlink(moved, tree);
		await expect(removeArtifact([trees], path.join(tree, "target"))).rejects.toThrow();
		expect(await exists(path.join(moved, "target", "debug", "big.bin"))).toBe(true);
	});

	test("refuses `..`, relative and empty paths", async () => {
		const tree = await makeTree("feature-a");
		await expect(removeArtifact([trees], `${tree}/src/../target`)).rejects.toThrow("invalid path");
		await expect(removeArtifact([trees], `${tree}/../../../${path.basename(tmp)}/outside`)).rejects.toThrow(
			"invalid path",
		);
		await expect(removeArtifact([trees], "target")).rejects.toThrow("invalid path");
		await expect(removeArtifact([trees], "")).rejects.toThrow("invalid path");
		await expect(removeArtifact([trees], `${tree}/target\0`)).rejects.toThrow("invalid path");
		expect(await exists(path.join(tree, "target", "debug", "big.bin"))).toBe(true);
	});

	test("refuses a folder outside the worktrees folder, even one that looks like build output", async () => {
		await put(path.join(outside, "proj", "node_modules", "keep.txt"));
		await expect(removeArtifact([trees], path.join(outside, "proj", "node_modules"))).rejects.toThrow("outside");
		await put(path.join(repo, "node_modules", "keep.txt"));
		await expect(removeArtifact([trees], path.join(repo, "node_modules"))).rejects.toThrow("outside");
		await expect(removeArtifact([], path.join(repo, "node_modules"))).rejects.toThrow("outside");
		expect(await exists(path.join(repo, "node_modules", "keep.txt"))).toBe(true);
	});

	test("refuses a main checkout, a clone and a submodule that sit under the worktrees folder", async () => {
		const clone = path.join(trees, "other", "clone");
		await fs.mkdir(path.dirname(clone), { recursive: true });
		await run(tmp, "git", "clone", "-q", repo, clone);
		await put(path.join(clone, "node_modules", "keep.txt"));
		await expect(removeArtifact([trees], path.join(clone, "node_modules"))).rejects.toThrow("linked worktree");
		expect(await exists(path.join(clone, "node_modules", "keep.txt"))).toBe(true);
	});

	test("refuses anything that is not an artifact folder: source, the worktree, .git, nested output", async () => {
		const tree = await makeTree("feature-a");
		await expect(removeArtifact([trees], path.join(tree, "src"))).rejects.toThrow("not a build output folder");
		await expect(removeArtifact([trees], tree)).rejects.toThrow("not a build output folder");
		await expect(removeArtifact([trees], path.join(tree, ".git"))).rejects.toThrow("not a build output folder");
		await expect(removeArtifact([trees], trees)).rejects.toThrow("not a build output folder");
		await put(path.join(tree, "node_modules", "pkg", "target", "x.txt"));
		await expect(removeArtifact([trees], path.join(tree, "node_modules", "pkg", "target"))).rejects.toThrow(
			"not inside a worktree",
		);
		await expect(removeArtifact([trees], path.join(tree, "gone", "target"))).rejects.toThrow("not found");
		await put(path.join(tree, "build"), 3);
		await expect(removeArtifact([trees], path.join(tree, "build"))).rejects.toThrow("not a folder");
		expect(await exists(path.join(tree, "src", "main.rs"))).toBe(true);
		expect(await exists(path.join(tree, "build"))).toBe(true);
	});
});

describe("busy worktrees", () => {
	test("a process whose folder is in the worktree makes it busy; its neighbour is not", async () => {
		const busy = await makeTree("feature-a");
		const idle = await makeTree("feature-b");
		const sleeper = Bun.spawn(["sleep", "60"], { cwd: path.join(busy, "src"), stdout: "ignore", stderr: "ignore" });
		spawned.push(sleeper);
		const hits = await probeProcesses([busy, idle], new Set());
		expect(hits).not.toBeNull();
		expect(hits?.get(busy)).toEqual({ pid: sleeper.pid, name: "sleep" });
		expect(hits?.has(idle)).toBe(false);
	});

	test("the companion's own and listed omp pids are not looked at", async () => {
		const busy = await makeTree("feature-a");
		const sleeper = Bun.spawn(["sleep", "60"], { cwd: busy, stdout: "ignore", stderr: "ignore" });
		spawned.push(sleeper);
		expect((await probeProcesses([busy], new Set([sleeper.pid])))?.size).toBe(0);
	});

	test("a language server in the worktree does not make it busy", async () => {
		const tree = await makeTree("feature-a");
		const server = path.join(tmp, "rust-analyzer");
		await fs.writeFile(server, 'console.log("ready");\nawait Bun.sleep(60000);\n');
		const proc = spawnReady([process.execPath, server], tree);
		await started(proc);
		expect((await probeProcesses([tree], new Set()))?.size).toBe(0);
	});

	test("a file a build tool holds open in the worktree makes it busy", async () => {
		const tree = await makeTree("feature-a");
		const script = path.join(tmp, "writer.js");
		const log = path.join(tree, "target", "build.log");
		await fs.writeFile(
			script,
			`import * as fs from "node:fs";\nfs.openSync(${JSON.stringify(log)}, "w");\nconsole.log("ready");\nawait Bun.sleep(60000);\n`,
		);
		const proc = spawnReady([process.execPath, script], tmp);
		await started(proc);
		const hit = (await probeProcesses([tree], new Set()))?.get(tree);
		expect(hit?.pid).toBe(proc.pid);
	});

	test("a session that works there makes it busy; an idle one does not", () => {
		const session = (cwd: string, busy: boolean | null, inputRequired = false) => ({
			sessionId: "s",
			name: "refactor",
			cwd,
			busy,
			inputRequired,
		});
		expect(busyBySession(["/w/a"], [session("/w/a/src", true)]).get("/w/a")).toContain("refactor");
		expect(busyBySession(["/w/a"], [session("/w/a", null)]).has("/w/a")).toBe(true);
		expect(busyBySession(["/w/a"], [session("/w/a", false, true)]).has("/w/a")).toBe(true);
		expect(busyBySession(["/w/a"], [session("/w/a", false)]).has("/w/a")).toBe(false);
		expect(busyBySession(["/w/a"], [session("/w/ab", true)]).has("/w/a")).toBe(false);
	});

	test("parses lsof and ps output", () => {
		const lsof = parseLsof("p12\nn/a/b\nn/c\nfcwd\np13\nnnot-a-path\nn/d\n");
		expect(lsof.get(12)).toEqual(["/a/b", "/c"]);
		expect(lsof.get(13)).toEqual(["/d"]);
		expect(parsePs("  42   501 /usr/bin/cargo build --release\nnoise\n 7 0 launchd\n")).toEqual([
			{ pid: 42, uid: 501, args: "/usr/bin/cargo build --release" },
			{ pid: 7, uid: 0, args: "launchd" },
		]);
	});
});

describe("sizes and free space", () => {
	test("measures a folder, and gives up past its time limit", async () => {
		const tree = await makeTree("feature-a");
		const bytes = await measureBytes(path.join(tree, "target"));
		expect(bytes).toBeGreaterThanOrEqual(2_000_000);
		expect(bytes).toBeLessThan(10_000_000);
		expect(await measureBytes(path.join(tree, "target"), 1)).toBeNull();
	});

	test("does not follow a symlink out when measuring", async () => {
		const tree = await makeTree("feature-a");
		await put(path.join(outside, "big.bin"), 5_000_000);
		await fs.rm(path.join(tree, "target"), { recursive: true });
		await fs.symlink(outside, path.join(tree, "target"));
		expect(await measureBytes(path.join(tree, "target"))).toBeLessThan(1_000_000);
	});

	test("reads the free space of a folder, or of the nearest existing parent of one that is not there yet", async () => {
		const here = await readFreeSpace(tmp);
		const later = await readFreeSpace(path.join(tmp, "not", "yet", "made"));
		expect(here?.freeBytes).toBeGreaterThan(0);
		expect(here?.totalBytes).toBeGreaterThanOrEqual(here?.freeBytes ?? Number.POSITIVE_INFINITY);
		expect(later?.key).toBe(here?.key);
	});
});
