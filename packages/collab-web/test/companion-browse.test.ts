import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { browseFolders, checkStartFolder, expandFolder, MAX_BROWSED_FOLDERS } from "../scripts/companion-browse";

let home: string;
const unlock: string[] = [];

beforeEach(async () => {
	// realpath: macOS reports /var/folders… as /private/var/…, and the listing must say what the test made.
	home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "browse-test-")));
});

afterEach(async () => {
	for (const dir of unlock.splice(0)) await fs.chmod(dir, 0o755).catch(() => undefined);
	await fs.rm(home, { recursive: true, force: true });
});

const names = (listing: { folders: { name: string }[] }): string[] => listing.folders.map(folder => folder.name);
const mkdirs = async (...dirs: string[]): Promise<void> => {
	for (const dir of dirs) await fs.mkdir(path.join(home, dir), { recursive: true });
};

describe("browseFolders", () => {
	it("lists the home folder without a path, sorted without regard to case, skipping files and hidden folders", async () => {
		await mkdirs("banana", "Apple", "cherry", "apple2", ".hidden", "Zed");
		await fs.writeFile(path.join(home, "notes.txt"), "not a folder");
		const listing = await browseFolders({}, { home });
		expect(listing.path).toBe(home);
		expect(names(listing)).toEqual(["Apple", "apple2", "banana", "cherry", "Zed"]);
		expect(listing.folders[0]).toEqual({ name: "Apple", path: path.join(home, "Apple"), git: false });
		expect(listing.truncated).toBe(false);
	});

	it("shows hidden folders only when asked", async () => {
		await mkdirs(".config", "src");
		expect(names(await browseFolders({ hidden: false }, { home }))).toEqual(["src"]);
		expect(names(await browseFolders({ hidden: true }, { home }))).toEqual([".config", "src"]);
	});

	it("marks git repositories by their .git entry, a folder or a file (a worktree)", async () => {
		await mkdirs("repo/.git", "plain", "worktree");
		await fs.writeFile(path.join(home, "worktree", ".git"), "gitdir: /elsewhere");
		const listing = await browseFolders({}, { home });
		expect(listing.folders.map(folder => [folder.name, folder.git])).toEqual([
			["plain", false],
			["repo", true],
			["worktree", true],
		]);
	});

	it("lists a symlink to a folder as an entry under its own name, and leaves out links to files and broken ones", async () => {
		await mkdirs("real/.git");
		await fs.writeFile(path.join(home, "file.txt"), "x");
		await fs.symlink(path.join(home, "real"), path.join(home, "alias"));
		await fs.symlink(path.join(home, "file.txt"), path.join(home, "to-file"));
		await fs.symlink(path.join(home, "gone"), path.join(home, "broken"));
		const listing = await browseFolders({}, { home });
		expect(listing.folders).toEqual([
			{ name: "alias", path: path.join(home, "alias"), git: true },
			{ name: "real", path: path.join(home, "real"), git: true },
		]);
	});

	it("stops at the cap and says so", async () => {
		await mkdirs("e", "d", "c", "b", "a");
		const listing = await browseFolders({}, { home, max: 3 });
		expect(names(listing)).toEqual(["a", "b", "c"]);
		expect(listing.truncated).toBe(true);
		const exact = await browseFolders({}, { home, max: 5 });
		expect(names(exact)).toEqual(["a", "b", "c", "d", "e"]);
		expect(exact.truncated).toBe(false);
	});

	it("caps a listing at 500 folders by default", async () => {
		const big = path.join(home, "big");
		await fs.mkdir(big);
		for (let n = 0; n <= MAX_BROWSED_FOLDERS; n++) await fs.mkdir(path.join(big, `d${String(n).padStart(4, "0")}`));
		const listing = await browseFolders({ path: big }, { home });
		expect(MAX_BROWSED_FOLDERS).toBe(500);
		expect(listing.folders).toHaveLength(500);
		expect(listing.folders[0]?.name).toBe("d0000");
		expect(listing.truncated).toBe(true);
	});

	it.skipIf(process.getuid?.() === 0)("leaves out a folder it cannot enter", async () => {
		await mkdirs("open", "locked");
		const locked = path.join(home, "locked");
		unlock.push(locked);
		await fs.chmod(locked, 0o000);
		expect(names(await browseFolders({}, { home }))).toEqual(["open"]);
	});

	it("gives the parent, and none at the root", async () => {
		await mkdirs("a/b");
		const inner = await browseFolders({ path: path.join(home, "a", "b") }, { home });
		expect(inner.parent).toBe(path.join(home, "a"));
		expect(inner.folders).toEqual([]);
		const root = await browseFolders({ path: path.parse(home).root }, { home, max: 1 });
		expect(root.path).toBe(path.parse(home).root);
		expect(root.parent).toBeNull();
	});

	it("expands ~ and reads a path that is not absolute from the home folder, and normalises", async () => {
		await mkdirs("code/app", "code/lib");
		expect((await browseFolders({ path: "~" }, { home })).path).toBe(home);
		expect(names(await browseFolders({ path: "~/code" }, { home }))).toEqual(["app", "lib"]);
		expect(names(await browseFolders({ path: "code/" }, { home }))).toEqual(["app", "lib"]);
		const typed = await browseFolders({ path: `  ${home}/code/app/../  ` }, { home });
		expect(typed.path).toBe(path.join(home, "code"));
		expect((await browseFolders({ path: "   " }, { home })).path).toBe(home);
	});

	it("refuses a path that is missing, not a folder, or not readable, in plain words", async () => {
		await mkdirs("locked");
		await fs.writeFile(path.join(home, "file.txt"), "x");
		const missing = path.join(home, "nope");
		await expect(browseFolders({ path: missing }, { home })).rejects.toThrow(`${missing} does not exist`);
		const file = path.join(home, "file.txt");
		await expect(browseFolders({ path: file }, { home })).rejects.toThrow(`${file} is not a folder`);
		await expect(browseFolders({ path: path.join(file, "inside") }, { home })).rejects.toThrow("is not a folder");
		if (process.getuid?.() !== 0) {
			const locked = path.join(home, "locked");
			unlock.push(locked);
			await fs.chmod(locked, 0o000);
			await expect(browseFolders({ path: locked }, { home })).rejects.toThrow(`${locked} cannot be read`);
		}
	});

	it("refuses a request of the wrong shape", async () => {
		await expect(browseFolders({ path: 3 }, { home })).rejects.toThrow("invalid request");
		await expect(browseFolders({ hidden: "yes" }, { home })).rejects.toThrow("invalid request");
		await expect(browseFolders({ path: "a\0b" }, { home })).rejects.toThrow("invalid path");
	});
});

describe("expandFolder", () => {
	it("expands ~ and resolves the rest against the home folder", () => {
		expect(expandFolder("~", "/home/me")).toBe("/home/me");
		expect(expandFolder("~/code/app", "/home/me")).toBe("/home/me/code/app");
		expect(expandFolder("code", "/home/me")).toBe("/home/me/code");
		expect(expandFolder("/opt/app/", "/home/me")).toBe("/opt/app");
		expect(expandFolder("~other", "/home/me")).toBe("/home/me/~other");
	});
});

describe("checkStartFolder", () => {
	it("returns the absolute path of a folder that exists, with ~ expanded", async () => {
		await mkdirs("code/app");
		const app = path.join(home, "code", "app");
		expect(await checkStartFolder(app, home)).toBe(app);
		expect(await checkStartFolder("~/code/app", home)).toBe(app);
		expect(await checkStartFolder(`${app}/`, home)).toBe(app);
	});

	it("refuses a folder that does not exist", async () => {
		const missing = path.join(home, "typo");
		await expect(checkStartFolder(missing, home)).rejects.toThrow(`${missing} does not exist`);
		await expect(checkStartFolder("~/typo", home)).rejects.toThrow(`${missing} does not exist`);
	});

	it("refuses a file, or an empty path", async () => {
		await fs.writeFile(path.join(home, "file.txt"), "x");
		await expect(checkStartFolder(path.join(home, "file.txt"), home)).rejects.toThrow("is not a folder");
		await expect(checkStartFolder("~/file.txt/inside", home)).rejects.toThrow("is not a folder");
		await expect(checkStartFolder("", home)).rejects.toThrow("Choose a folder to start in");
		await expect(checkStartFolder("  ", home)).rejects.toThrow("Choose a folder to start in");
	});
});
