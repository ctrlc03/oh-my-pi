/**
 * Contract: the snapshot taken before prompt N against the snapshot before prompt N+1 (or the working
 * tree for the latest turn) lists exactly the files turn N added, modified and deleted, with the
 * unified diff of each; the session diff covers everything since the first snapshot.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileSnapshotStore } from "@oh-my-pi/pi-coding-agent/session/file-snapshots";
import {
	buildTurnDiff,
	parseNumstat,
	splitPatch,
	TURN_DIFF_MAX_FILE_CHARS,
} from "@oh-my-pi/pi-coding-agent/session/turn-diff";
import { TempDir } from "@oh-my-pi/pi-utils";

function git(cwd: string, ...args: string[]): void {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@t",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@t",
	};
	const result = Bun.spawnSync(["git", ...args], { cwd, env });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function put(repo: string, file: string, content: string | Buffer): void {
	const target = path.join(repo, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

let work: TempDir;
let repo: string;
let store: FileSnapshotStore;

/** Snapshot the tree now and bind it to the prompt `entryId`, as the session does before each prompt. */
async function snapshotBefore(entryId: string): Promise<void> {
	const snapshot = await store.capture(60_000);
	if (!snapshot) throw new Error("no snapshot");
	await store.bind(snapshot, entryId);
}

beforeEach(() => {
	work = TempDir.createSync("@omp-turn-diff-");
	repo = path.join(fs.realpathSync(work.path()), "repo");
	fs.mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q");
	put(repo, "keep.txt", "k1\n");
	put(repo, "edit.txt", "one\ntwo\nthree\n");
	put(repo, "gone.txt", "bye\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "init");
	store = new FileSnapshotStore({
		storeRoot: () => path.join(work.path(), "store"),
		cwd: () => repo,
		sessionId: () => "s1",
		enabled: () => true,
	});
});

afterEach(() => {
	work[Symbol.dispose]();
});

describe("turn diff from snapshots", () => {
	it("shows only the files one turn added, modified and deleted", async () => {
		await snapshotBefore("p1");
		put(repo, "edit.txt", "one\nTWO\nthree\n");
		put(repo, "new dir/added file.txt", "fresh\n");
		fs.rmSync(path.join(repo, "gone.txt"));
		await snapshotBefore("p2");
		put(repo, "edit.txt", "one\nTWO\nthree\nfour\n");
		put(repo, "later.txt", "l\n");

		const first = await store.turnDiff("p1", ["p2"]);
		expect(first?.spansTurns).toBe(1);
		expect(first?.files.map(file => [file.path, file.status, file.added, file.removed])).toEqual([
			["edit.txt", "modified", 1, 1],
			["gone.txt", "deleted", 0, 1],
			["new dir/added file.txt", "added", 1, 0],
		]);
		const edit = first?.files.find(file => file.path === "edit.txt");
		expect(edit?.diff).toContain("-two\n+TWO\n");
		expect(edit?.diff.startsWith("@@ ")).toBe(true);

		// The latest turn runs to the working tree and shows nothing of the first.
		const latest = await store.turnDiff("p2", []);
		expect(latest?.files.map(file => [file.path, file.status])).toEqual([
			["edit.txt", "modified"],
			["later.txt", "added"],
		]);
	});

	it("ends a turn at the next prompt that has a snapshot and counts the turns it spans", async () => {
		await snapshotBefore("p1");
		put(repo, "one.txt", "1\n");
		// p2 got no snapshot (it ran without one); p3 did.
		put(repo, "two.txt", "2\n");
		await snapshotBefore("p3");
		put(repo, "three.txt", "3\n");

		const spanning = await store.turnDiff("p1", ["p2", "p3"]);
		expect(spanning?.spansTurns).toBe(2);
		expect(spanning?.files.map(file => file.path)).toEqual(["one.txt", "two.txt"]);
		// Nothing after it has a snapshot: the diff runs to the working tree.
		const toTree = await store.turnDiff("p3", ["p4"]);
		expect(toTree?.spansTurns).toBe(2);
		expect(toTree?.files.map(file => file.path)).toEqual(["three.txt"]);
		expect(await store.turnDiff("unknown", [])).toBeUndefined();
	});

	it("diffs the whole session from its first snapshot, skipping prompts that have none", async () => {
		put(repo, "pre.txt", "before the session\n");
		await snapshotBefore("p2");
		put(repo, "a.txt", "a\n");
		await snapshotBefore("p3");
		fs.rmSync(path.join(repo, "keep.txt"));

		const session = await store.sessionDiff(["p1", "p2", "p3"]);
		expect(session?.spansTurns).toBe(2);
		expect(session?.files.map(file => [file.path, file.status])).toEqual([
			["a.txt", "added"],
			["keep.txt", "deleted"],
		]);
		expect(await store.sessionDiff(["p1"])).toBeUndefined();
	});

	it("lists a binary file without a diff body and an empty turn as no files", async () => {
		await snapshotBefore("p1");
		expect((await store.turnDiff("p1", []))?.files).toEqual([]);
		put(repo, "image.bin", Buffer.from([0, 1, 2, 0, 255, 0]));
		const diff = await store.turnDiff("p1", []);
		expect(diff?.files).toEqual([{ path: "image.bin", status: "added", added: null, removed: null, diff: "" }]);
	});
});

describe("turn diff assembly", () => {
	it("pairs each section of git's patch with its file and cuts oversized diffs at a line", () => {
		const bigLines = Array.from(
			{ length: TURN_DIFF_MAX_FILE_CHARS / 8 },
			(_, index) => `+line ${index} of the new file`,
		);
		const big = `@@ -0,0 +1,${bigLines.length} @@\n${bigLines.join("\n")}\n`;
		const patch = splitPatch(
			[
				"diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
				"diff --git a/bin b/bin\nindex 1..2 100644\nBinary files a/bin and b/bin differ\n",
				`diff --git a/big b/big\nnew file mode 100644\n--- /dev/null\n+++ b/big\n${big}`,
			].join(""),
		);
		expect(patch[0]).toBe("@@ -1 +1 @@\n-a\n+b\n");
		expect(patch[1]).toBe("");
		const numstat = parseNumstat(["1\t1\ta.txt", "-\t-\tbin", "300\t0\tbig", ""].join("\0"));
		const result = buildTurnDiff(
			[
				{ status: "M", path: "a.txt" },
				{ status: "A", path: "bin" },
				{ status: "A", path: "big" },
			],
			numstat,
			patch,
			1,
		);
		expect(result.files.map(file => [file.path, file.added, file.removed])).toEqual([
			["a.txt", 1, 1],
			["bin", null, null],
			["big", 300, 0],
		]);
		const cut = result.files[2];
		expect(cut?.truncated).toBe(true);
		expect(cut?.diff.length).toBeLessThanOrEqual(TURN_DIFF_MAX_FILE_CHARS);
		expect(cut?.diff.endsWith("\n")).toBe(true);
		expect(() => buildTurnDiff([{ status: "M", path: "a.txt" }], numstat, [], 1)).toThrow();
	});
});
