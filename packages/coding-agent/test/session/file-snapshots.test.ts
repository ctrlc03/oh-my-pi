/**
 * Contract: a snapshot taken before a prompt lets the working tree return to exactly that state
 * (tracked and untracked non-ignored files; modified, created and deleted alike), the restore
 * can be undone, and none of it ever writes to the user's own repository.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	FileSnapshotError,
	FileSnapshotStore,
	SNAPSHOT_MAX_FILE_BYTES,
	SNAPSHOT_MAX_FILES,
} from "@oh-my-pi/pi-coding-agent/session/file-snapshots";
import { TempDir } from "@oh-my-pi/pi-utils";

function git(cwd: string, ...args: string[]): string {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	const result = Bun.spawnSync(["git", ...args], { cwd, env });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function put(repo: string, file: string, content: string | Buffer, mode?: number): void {
	const target = path.join(repo, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	if (mode !== undefined) fs.chmodSync(target, mode);
}

/** Every file under `dir` (skipping `.git`) as path -> content hash + exec bit. */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else {
				const hash = crypto.createHash("sha1").update(fs.readFileSync(absolute)).digest("hex");
				out[path.relative(dir, absolute)] = `${hash}:${fs.statSync(absolute).mode & 0o111 ? "x" : "-"}`;
			}
		}
	};
	walk(dir);
	return out;
}

/** Content hash of every file under the repo's `.git`: any write by the code under test shows up. */
function gitDirFingerprint(repo: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else
				out[path.relative(repo, absolute)] = crypto
					.createHash("sha1")
					.update(fs.readFileSync(absolute))
					.digest("hex");
		}
	};
	walk(path.join(repo, ".git"));
	return out;
}

let work: TempDir;
let repo: string;
let storeRoot: string;
let sessionId: string;
let enabled: boolean;

function makeStore(cwd = () => repo): FileSnapshotStore {
	return new FileSnapshotStore({
		storeRoot: () => storeRoot,
		cwd,
		sessionId: () => sessionId,
		enabled: () => enabled,
	});
}

async function bindBefore(
	store: FileSnapshotStore,
	snapshot: Awaited<ReturnType<FileSnapshotStore["capture"]>>,
	entryId: string,
): Promise<void> {
	if (!snapshot) throw new Error("expected a snapshot");
	await store.bind(snapshot, entryId);
}

/** A capture is refused while one is still running; retry until the earlier one is done. */
async function untilCaptured(store: FileSnapshotStore): Promise<Awaited<ReturnType<FileSnapshotStore["capture"]>>> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const snapshot = await store.capture(60_000);
		if (snapshot) return snapshot;
		await Bun.sleep(25);
	}
	return undefined;
}

beforeEach(() => {
	work = TempDir.createSync("@omp-file-snapshots-");
	repo = path.join(fs.realpathSync(work.path()), "repo");
	fs.mkdirSync(repo, { recursive: true });
	storeRoot = path.join(work.path(), "store");
	sessionId = "session-1";
	enabled = true;
	git(repo, "init", "-q");
	put(repo, ".gitignore", "ignored.txt\nbuild/\n");
	put(repo, "a.txt", "a1\n");
	put(repo, "dir/b.txt", "b1\n");
	put(repo, "del.txt", "to be deleted\n");
	put(repo, "run.sh", "#!/bin/sh\n", 0o755);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "init");
	put(repo, "untracked.txt", "u1\n");
	put(repo, "ignored.txt", "i1\n");
	put(repo, "build/out.js", "o1\n");
});

afterEach(() => {
	work[Symbol.dispose]();
});

describe("file snapshots", () => {
	it("restores modified, created, deleted and untracked files, leaves ignored and oversized ones alone, and redoes", async () => {
		const store = makeStore();
		const before = tree(repo);
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");

		put(repo, "a.txt", "a2\n");
		put(repo, "untracked.txt", "u2\n");
		put(repo, "dir/deep/new.txt", "n\n");
		put(repo, "new-top.txt", "n\n");
		put(repo, "run.sh", "#!/bin/sh\necho changed\n", 0o644);
		fs.rmSync(path.join(repo, "del.txt"));
		put(repo, "ignored.txt", "i2\n");
		put(repo, "build/out.js", "o2\n");
		put(repo, "big.bin", Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1, 1));
		const after = tree(repo);

		expect(await store.preview("e1")).toEqual({ revert: 3, remove: 2, recreate: 1 });

		const restored = await store.restoreBefore("e1");
		expect(restored).toEqual({ plan: { revert: 3, remove: 2, recreate: 1 }, skipped: 0 });
		// Everything the snapshot covers is back; ignored and oversized files keep their later state.
		const expected = {
			...before,
			"ignored.txt": after["ignored.txt"],
			"build/out.js": after["build/out.js"],
			"big.bin": after["big.bin"],
		};
		expect(tree(repo)).toEqual(expected);
		// A directory emptied by the restore does not linger.
		expect(fs.existsSync(path.join(repo, "dir", "deep"))).toBe(false);
		expect(store.canRedo).toBe(true);

		const redone = await store.redo();
		expect(redone.plan).toEqual({ revert: 3, remove: 1, recreate: 2 });
		expect(tree(repo)).toEqual(after);
		// Redo is itself revertible, and the exec bit survives the round trip.
		expect(fs.statSync(path.join(repo, "run.sh")).mode & 0o111).toBe(0);
		await store.redo();
		expect(tree(repo)).toEqual(expected);
		expect(fs.statSync(path.join(repo, "run.sh")).mode & 0o111).not.toBe(0);
	});

	it("never writes to the user's repository: index, HEAD, refs and stash stay byte-identical", async () => {
		const store = makeStore();
		git(repo, "stash", "push", "-u", "-q", "-m", "keep");
		put(repo, "a.txt", "a-wip\n");
		put(repo, "untracked.txt", "u-wip\n");
		git(repo, "add", "a.txt");
		const fingerprint = gitDirFingerprint(repo);
		const head = git(repo, "rev-parse", "HEAD");
		const refs = git(repo, "for-each-ref");
		const stash = git(repo, "stash", "list");

		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");
		put(repo, "a.txt", "a-later\n");
		put(repo, "extra.txt", "x\n");
		await store.restoreBefore("e1");
		await store.redo();
		await store.preview("e1");

		expect(gitDirFingerprint(repo)).toEqual(fingerprint);
		expect(git(repo, "rev-parse", "HEAD")).toBe(head);
		expect(git(repo, "for-each-ref")).toBe(refs);
		expect(git(repo, "stash", "list")).toBe(stash);
		expect(fs.existsSync(storeRoot)).toBe(true);
	});

	it("keeps a prompt's snapshot across a new store instance (resumed session)", async () => {
		const first = makeStore();
		const snapshot = await first.capture();
		await bindBefore(first, snapshot, "e1");
		put(repo, "a.txt", "changed\n");
		put(repo, "added.txt", "x\n");

		const resumed = makeStore();
		expect(await resumed.preview("e1")).toEqual({ revert: 1, remove: 1, recreate: 0 });
		await resumed.restoreBefore("e1");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a1\n");
		expect(fs.existsSync(path.join(repo, "added.txt"))).toBe(false);
	});

	it("restores the snapshot of the chosen prompt, not the latest", async () => {
		const store = makeStore();
		const first = await store.capture();
		await bindBefore(store, first, "e1");
		put(repo, "a.txt", "a-after-first\n");
		const second = await store.capture();
		await bindBefore(store, second, "e2");
		put(repo, "a.txt", "a-after-second\n");

		await store.restoreBefore("e2");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a-after-first\n");
		await store.restoreBefore("e1");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a1\n");
	});

	it("refuses to redo over files changed after the restore, and keeps those files", async () => {
		const store = makeStore();
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");
		put(repo, "a.txt", "a2\n");
		await store.restoreBefore("e1");
		put(repo, "a.txt", "edited after restore\n");

		await expect(store.redo()).rejects.toThrow("files changed since the restore");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("edited after restore\n");
	});

	it("does not overwrite a path the snapshot never saw", async () => {
		const store = makeStore();
		put(repo, "gen.txt", "small\n");
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");
		// gen.txt is deleted, then reappears as a file over the size cap: the snapshot does not cover it.
		fs.rmSync(path.join(repo, "gen.txt"));
		put(repo, "gen.txt", Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1, 7));

		const result = await store.restoreBefore("e1");
		expect(result.skipped).toBe(1);
		expect(fs.statSync(path.join(repo, "gen.txt")).size).toBe(SNAPSHOT_MAX_FILE_BYTES + 1);
	});

	it("refuses an entry that has no snapshot and one that is not a safe id", async () => {
		const store = makeStore();
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");
		await expect(store.restoreBefore("nope")).rejects.toBeInstanceOf(FileSnapshotError);
		await expect(store.restoreBefore("../../e1")).rejects.toThrow("no file snapshot");
		expect(await store.preview("nope")).toBeUndefined();
		await expect(store.redo()).rejects.toThrow("no file restore to undo");
	});

	it("skips when the cwd is not a git repository or snapshots are disabled", async () => {
		const plain = path.join(work.path(), "plain");
		fs.mkdirSync(plain);
		const outside = makeStore(() => plain);
		expect(outside.supported).toBe(false);
		expect(await outside.capture()).toBeUndefined();
		await expect(outside.restoreBefore("e1")).rejects.toBeInstanceOf(FileSnapshotError);
		expect(fs.existsSync(storeRoot)).toBe(false);

		enabled = false;
		const disabled = makeStore();
		expect(disabled.supported).toBe(false);
		expect(await disabled.capture()).toBeUndefined();
		expect(fs.existsSync(storeRoot)).toBe(false);
	});

	it("works from a subdirectory of the repository and covers the whole repository", async () => {
		const store = makeStore(() => path.join(repo, "dir"));
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");
		put(repo, "a.txt", "changed from outside cwd\n");
		await store.restoreBefore("e1");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("a1\n");
	});

	it("skips a repository whose files add up past the total cap, instead of hashing them", async () => {
		// Sparse files: each stays under the per-file cap, together they pass the total cap.
		for (let index = 0; index < 300; index++) {
			const file = path.join(repo, "data", `blob-${index}.bin`);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.closeSync(fs.openSync(file, "w"));
			fs.truncateSync(file, SNAPSHOT_MAX_FILE_BYTES);
		}
		const store = makeStore();
		const started = performance.now();
		expect(await store.capture()).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(2000);
		// The refusal is remembered, so the next prompt does not walk the repository again.
		fs.rmSync(path.join(repo, "data"), { recursive: true });
		expect(await store.capture()).toBeUndefined();
	});

	it("stops listing a huge untracked tree at the file cap", async () => {
		const count = SNAPSHOT_MAX_FILES + 1;
		await Promise.all(
			Array.from({ length: 50 }, async (_, shard) => {
				const dir = path.join(repo, "node_modules", `pkg-${shard}`);
				await fs.promises.mkdir(dir, { recursive: true });
				for (let file = shard; file < count; file += 50)
					await fs.promises.writeFile(path.join(dir, `f${file}.js`), "");
			}),
		);
		expect(await makeStore().capture(60_000)).toBeUndefined();
	}, 60_000);

	it("lets a prompt go without a snapshot once the budget is spent, and never binds the late one", async () => {
		const store = makeStore();
		put(repo, "a.txt", "before\n");
		expect(await store.capture(0)).toBeUndefined();
		// The work behind it finishes; the next prompt gets a normal snapshot of what is there now.
		put(repo, "a.txt", "after\n");
		const snapshot = await untilCaptured(store);
		await bindBefore(store, snapshot, "p2");
		put(repo, "a.txt", "agent edit\n");
		await store.restoreBefore("p2");
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("after\n");
	});

	it("keeps a file that already existed but was ignored when the snapshot was taken, even if the ignore rule goes away", async () => {
		put(repo, ".env", "SECRET=1\n");
		put(repo, ".gitignore", "ignored.txt\nbuild/\n.env\n");
		const store = makeStore();
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");

		put(repo, ".gitignore", "ignored.txt\nbuild/\n");
		put(repo, "made-by-agent.txt", "x\n");

		expect(await store.preview("e1")).toEqual({ revert: 1, remove: 1, recreate: 0 });
		const restored = await store.restoreBefore("e1");
		expect(restored).toEqual({ plan: { revert: 1, remove: 1, recreate: 0 }, skipped: 1 });
		expect(fs.readFileSync(path.join(repo, ".env"), "utf8")).toBe("SECRET=1\n");
		expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe("ignored.txt\nbuild/\n.env\n");
		expect(fs.existsSync(path.join(repo, "made-by-agent.txt"))).toBe(false);
	});

	it("keeps a file that was over the size cap at snapshot time and shrank under it", async () => {
		put(repo, "lock.json", Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1, 1));
		const store = makeStore();
		const snapshot = await store.capture();
		await bindBefore(store, snapshot, "e1");

		put(repo, "lock.json", "{}\n");
		const restored = await store.restoreBefore("e1");
		expect(restored).toEqual({ plan: { revert: 0, remove: 0, recreate: 0 }, skipped: 1 });
		expect(fs.readFileSync(path.join(repo, "lock.json"), "utf8")).toBe("{}\n");
	});

	it("recovers from an unreadable session index by starting a new one", async () => {
		const store = makeStore();
		expect(await store.capture()).toBeDefined();
		const [gitDir] = fs.readdirSync(storeRoot).map(name => path.join(storeRoot, name));
		fs.writeFileSync(path.join(gitDir, "index-session-1"), "not an index, just garbage bytes");
		expect(await store.capture()).toBeUndefined();
		expect(await store.capture()).toBeDefined();
	});

	it("never seeds an index from one another session is still writing", async () => {
		const first = makeStore();
		expect(await first.capture()).toBeDefined();
		const [gitDir] = fs.readdirSync(storeRoot).map(name => path.join(storeRoot, name));
		fs.writeFileSync(path.join(gitDir, "index-other-session.lock"), "half written");
		sessionId = "session-2";
		expect(await makeStore().capture()).toBeDefined();
	});

	it("sweeps stores of repositories that no longer exist, and drops idle session indexes", async () => {
		const orphan = path.join(storeRoot, "0123456789abcdef");
		fs.mkdirSync(orphan, { recursive: true });
		fs.writeFileSync(path.join(orphan, "omp-root"), path.join(work.path(), "deleted-repo"));
		const legacy = path.join(storeRoot, "fedcba9876543210");
		fs.mkdirSync(legacy);

		// Opening any store sweeps its siblings (once per process and store root).
		const store = makeStore();
		expect(await store.capture()).toBeDefined();
		const gitDir = fs
			.readdirSync(storeRoot)
			.map(name => path.join(storeRoot, name))
			.find(dir => fs.existsSync(path.join(dir, "index-session-1")));
		if (!gitDir) throw new Error("expected the repository's store");
		for (let attempt = 0; attempt < 100 && fs.existsSync(orphan); attempt++) await Bun.sleep(50);
		expect(fs.existsSync(orphan)).toBe(false);
		expect(fs.existsSync(legacy)).toBe(true);

		// A session index nobody touched for a day goes when the repository's store is opened again.
		const idle = path.join(gitDir, "index-idle-session");
		fs.copyFileSync(path.join(gitDir, "index-session-1"), idle);
		const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		fs.utimesSync(idle, old, old);
		fs.utimesSync(path.join(gitDir, "index-session-1"), old, old);
		expect(await makeStore().capture()).toBeDefined();
		for (let attempt = 0; attempt < 100 && fs.existsSync(idle); attempt++) await Bun.sleep(50);
		expect(fs.existsSync(idle)).toBe(false);
		// The opening session's own index stays, however long it sat.
		expect(fs.existsSync(path.join(gitDir, "index-session-1"))).toBe(true);
	});
});
