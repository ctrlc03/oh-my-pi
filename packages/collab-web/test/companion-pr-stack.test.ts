import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BlueprintCommit } from "@oh-my-pi/pi-wire/blueprint";
import type { BoardFile } from "../src/lib/review-board";
import { repoInfo, type ResolvedTarget, resolvePrHead, resolveTarget } from "../scripts/companion-blueprint-git";
import {
	boardFile,
	boardFiles,
	boardStackPr,
	checkPrNumber,
	createPrStack,
	diffBoardFiles,
	pullRequestBelow,
	STACK_TTL_MS,
	type PrStackDeps,
} from "../scripts/companion-pr-stack";
import { MAX_FILE_DIFF_CHARS } from "../scripts/companion-prreview";
import { ownBase } from "../scripts/companion-review-base";
import { detectStackPrs, type PrSource, type StackPr } from "../scripts/companion-quiz-stack";

const pr = (number: number, head: string, base: string, extra: Partial<StackPr> = {}): StackPr => ({
	number,
	title: `PR ${number}`,
	head,
	base,
	url: `https://github.com/o/r/pull/${number}`,
	state: "open",
	...extra,
});

describe("pullRequestBelow", () => {
	const stack = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b")];

	it("is the previous pull request when this one is stacked on its branch", () => {
		expect(pullRequestBelow(stack, 3)?.number).toBe(2);
		expect(pullRequestBelow(stack, 2)?.number).toBe(1);
	});

	it("is nothing for the bottom pull request or one stacked on something else", () => {
		expect(pullRequestBelow(stack, 1)).toBeUndefined();
		expect(pullRequestBelow([pr(1, "a", "main"), pr(2, "b", "main")], 2)).toBeUndefined();
		expect(pullRequestBelow(stack, 99)).toBeUndefined();
	});
});

describe("boardStackPr", () => {
	it("fills what a lookup did not say", () => {
		expect(boardStackPr({ number: 4, title: "t", head: "h", base: "b" })).toEqual({
			number: 4,
			title: "t",
			head: "h",
			base: "b",
			url: "",
			state: "open",
		});
		expect(boardStackPr(pr(5, "h", "b", { state: "merged" })).state).toBe("merged");
	});
});

describe("checkPrNumber", () => {
	it("accepts positive integers only", () => {
		expect(checkPrNumber(12)).toBe(12);
		for (const bad of [0, -1, 1.5, "3", null, 1e12])
			expect(() => checkPrNumber(bad)).toThrow("invalid pull request number");
	});
});

const SECTION = (path: string, body: string[]) =>
	[`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ""].join("\n");

describe("boardFiles", () => {
	it("tells added, deleted, renamed and modified files apart and counts their lines", () => {
		const raw = [
			SECTION("m.ts", ["@@ -1,2 +1,2 @@", " k", "-a", "+b"]),
			"diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n",
			"diff --git a/d.ts b/d.ts\ndeleted file mode 100644\n--- a/d.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n",
			"diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-p\n+q\n",
		].join("");
		const files = boardFiles(raw, false);
		expect(files.map(f => [f.path, f.status, f.added, f.removed, f.oldPath])).toEqual([
			["m.ts", "modified", 1, 1, undefined],
			["n.ts", "added", 2, 0, undefined],
			["d.ts", "deleted", 0, 1, undefined],
			["new.ts", "renamed", 1, 1, "old.ts"],
		]);
		expect(files.every(f => f.truncated === undefined)).toBe(true);
	});

	it("does not count a header-looking added line as a header", () => {
		const file = boardFile({ path: "a", diff: SECTION("a", ["@@ -1 +1 @@", "-x", "+++ y"]) });
		expect([file.added, file.removed]).toEqual([1, 1]);
	});

	it("cuts an oversized file at a line and says so, counting its whole diff", () => {
		const body = Array.from({ length: 40_000 }, (_, i) => `+line ${i} of the file`);
		const file = boardFile({ path: "big.ts", diff: SECTION("big.ts", ["@@ -0,0 +1,40000 @@", ...body]) });
		expect(file.truncated).toBe(true);
		expect(file.added).toBe(40_000);
		expect(file.diff.length).toBeLessThanOrEqual(MAX_FILE_DIFF_CHARS);
		expect(file.diff.endsWith("\n")).toBe(true);
	});

	it("marks the last file of a diff git stopped printing, dropping its cut line", () => {
		const raw = `${SECTION("a.ts", ["@@ -1 +1 @@", "-a", "+b"])}${SECTION("b.ts", ["@@ -1 +1 @@", "-c", "+d and a li"])}`;
		const files = boardFiles(raw.slice(0, -4), true);
		expect(files.map(f => [f.path, f.truncated])).toEqual([
			["a.ts", undefined],
			["b.ts", true],
		]);
		expect(files[1]!.diff.endsWith("-c\n")).toBe(true);
	});
});

// ── the engine ───────────────────────────────────────────────────────────────

const commit = (sha: string, ref?: string): BlueprintCommit => ({ commit: sha.repeat(40).slice(0, 40), ref });

/** A repository of pull requests: every lookup is answered from `prs`; the calls are recorded. */
function harness(prs: readonly StackPr[]) {
	const calls: string[] = [];
	let now = 1_000_000;
	const source: PrSource = {
		async view(number) {
			return prs.find(item => item.number === number) ?? null;
		},
		async byHead(branch) {
			return prs.filter(item => item.head === branch);
		},
		async byBase(branch) {
			return prs.filter(item => item.base === branch);
		},
	};
	const headOf = (number: number) => commit(String(number), `pr/${number}`);
	const deps: PrStackDeps = {
		root: async cwd => `/repos/${cwd}`,
		source: () => source,
		defaultBranch: async () => "main",
		async target(_root, number): Promise<ResolvedTarget> {
			calls.push(`target:${number}`);
			const viewed = prs.find(item => item.number === number)!;
			// The base the pull request has against its base branch: the merge base with it.
			return { head: headOf(number), base: commit("e", viewed.base), label: `PR #${number}` };
		},
		async head(_root, number) {
			calls.push(`head:${number}`);
			return headOf(number);
		},
		async ownBase(_root, target, viewed, below, belowHead) {
			// What `ownBase` decides in git, minus git: the merge base with the pull request below.
			calls.push(`ownBase:${below?.number ?? "-"}`);
			return below?.head && belowHead && viewed?.base === below.head
				? { commit: "f".repeat(40), ref: belowHead.ref }
				: target.base;
		},
		async diff(_root, base, head): Promise<BoardFile[]> {
			calls.push(`diff:${base.slice(0, 1)}..${head.slice(0, 1)}`);
			return [{ path: "a.ts", status: "modified", diff: "@@ -1 +1 @@\n-a\n+b\n", added: 1, removed: 1 }];
		},
		now: () => now,
	};
	return { deps, calls, advance: (ms: number) => (now += ms) };
}

const chain = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b")];

describe("createPrStack", () => {
	it("lists the stack bottom first for any member and for a lone pull request", async () => {
		const { deps } = harness([...chain, pr(9, "solo", "main")]);
		const board = createPrStack(deps);
		expect((await board.stack("x", 2)).map(p => p.number)).toEqual([1, 2, 3]);
		expect((await board.stack("x", 9)).map(p => [p.number, p.state, p.url])).toEqual([
			[9, "open", "https://github.com/o/r/pull/9"],
		]);
	});

	it("diffs a stacked pull request against the merge base with the head of the one below", async () => {
		const { deps, calls } = harness(chain);
		const own = await createPrStack(deps).ownDiff("x", 3);
		expect(calls).toContain("head:2");
		expect(calls).toContain("ownBase:2");
		expect(own).toEqual({
			number: 3,
			head: "3".repeat(40),
			against: { ref: "b", sha: "f".repeat(40) },
			files: [expect.objectContaining({ path: "a.ts" })],
		});
		// The diff is taken between the base the below pull request gave and the head.
		expect(calls).toContain("diff:f..3");
	});

	it("diffs the bottom pull request against its base branch without looking at another head", async () => {
		const { deps, calls } = harness(chain);
		const own = await createPrStack(deps).ownDiff("x", 1);
		expect(calls.filter(call => call.startsWith("head:"))).toEqual([]);
		expect(calls).toContain("ownBase:-");
		expect(own.against).toEqual({ ref: "main", sha: "e".repeat(40) });
		expect(own.head).toBe("1".repeat(40));
	});

	it("diffs a pull request whose base is not the one below as a bottom one", async () => {
		const { deps, calls } = harness([pr(1, "a", "main"), pr(2, "b", "main", { body: "Stack: #1, #2" })]);
		const own = await createPrStack(deps).ownDiff("x", 2);
		expect(calls).not.toContain("head:1");
		expect(own.against.ref).toBe("main");
	});

	it("fails with the reason when a pull request has no base", async () => {
		const { deps } = harness(chain);
		deps.ownBase = async () => undefined;
		await expect(createPrStack(deps).ownDiff("x", 1)).rejects.toThrow("pull request #1 changes: it has no base");
	});

	it("reuses a stack for every member and an own diff for a minute, then asks again", async () => {
		const { deps, calls, advance } = harness(chain);
		const board = createPrStack(deps);
		await board.ownDiff("x", 2);
		await board.ownDiff("x", 2);
		await board.ownDiff("x", 3);
		expect(calls.filter(call => call === "target:2")).toHaveLength(1);
		expect(calls.filter(call => call === "target:3")).toHaveLength(1);
		advance(STACK_TTL_MS + 1);
		await board.ownDiff("x", 2);
		expect(calls.filter(call => call === "target:2")).toHaveLength(2);
	});

	it("keeps a diff by its two commits: the same range is not diffed twice", async () => {
		const { deps, calls, advance } = harness(chain);
		const board = createPrStack(deps);
		await board.ownDiff("x", 3);
		advance(STACK_TTL_MS + 1);
		await board.ownDiff("x", 3);
		expect(calls.filter(call => call.startsWith("diff:"))).toHaveLength(1);
	});

	it("does not remember a failure", async () => {
		const { deps } = harness(chain);
		let fail = true;
		const real = deps.diff;
		deps.diff = async (...args) => {
			if (fail) throw new Error("git is busy");
			return real(...args);
		};
		const board = createPrStack(deps);
		await expect(board.ownDiff("x", 1)).rejects.toThrow("git is busy");
		fail = false;
		expect((await board.ownDiff("x", 1)).files).toHaveLength(1);
	});

	it("rejects a number that is not a pull request number", async () => {
		const { deps } = harness(chain);
		await expect(createPrStack(deps).stack("x", "1")).rejects.toThrow("invalid pull request number");
	});
});

describe("detectStackPrs", () => {
	it("keeps the state of each pull request of the stack", async () => {
		const prs = [pr(1, "a", "main", { state: "open" }), pr(2, "b", "a", { state: "open" })];
		const source: PrSource = {
			view: async number => prs.find(item => item.number === number) ?? null,
			byHead: async branch => prs.filter(item => item.head === branch),
			byBase: async branch => prs.filter(item => item.base === branch),
		};
		const { stack, source: found } = await detectStackPrs(2, source);
		expect(found).toBe("branches");
		expect(stack.map(p => [p.number, p.state])).toEqual([
			[1, "open"],
			[2, "open"],
		]);
	});
});

// ── with real git ────────────────────────────────────────────────────────────

describe("createPrStack on a repository", () => {
	let tmp: string;
	let repo: string;

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

	async function commitFiles(files: Record<string, string>, message: string): Promise<string> {
		for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(repo, file), text);
		await run(repo, "add", "-A");
		await run(repo, "commit", "-q", "-m", message);
		return run(repo, "rev-parse", "HEAD");
	}

	beforeAll(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pr-stack-")));
		const origin = path.join(tmp, "origin.git");
		repo = path.join(tmp, "repo");
		await run(tmp, "init", "-q", "--bare", "-b", "main", origin);
		await run(tmp, "clone", "-q", origin, repo);
		await run(repo, "checkout", "-q", "-b", "main");
		await commitFiles({ "a.ts": "one\ntwo\n", "b.ts": "b\n" }, "first");
		await run(repo, "push", "-q", "origin", "main");
		// PR 1 (branch `lower`) changes a.ts; PR 2 (branch `upper`, stacked on it) changes b.ts.
		await run(repo, "checkout", "-q", "-b", "lower");
		const lowerHead = await commitFiles({ "a.ts": "one\nTWO\n" }, "lower");
		await run(repo, "checkout", "-q", "-b", "upper");
		const upperHead = await commitFiles({ "b.ts": "b\nbb\n" }, "upper");
		// The branch below moves on after the one above was made on it.
		await run(repo, "checkout", "-q", "lower");
		const movedLower = await commitFiles({ "a.ts": "one\nTWO\nthree\n" }, "lower moves on");
		await run(repo, "push", "-q", "origin", `${movedLower}:refs/pull/1/head`, `${upperHead}:refs/pull/2/head`);
		expect(lowerHead).not.toBe(movedLower);
	});

	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	const prs = [pr(1, "lower", "main"), pr(2, "upper", "lower")];
	const source: PrSource = {
		view: async number => prs.find(item => item.number === number) ?? null,
		byHead: async branch => prs.filter(item => item.head === branch),
		byBase: async branch => prs.filter(item => item.base === branch),
	};

	it("shows a stacked pull request its own changes only, though the branch below moved on", async () => {
		const board = createPrStack({
			root: async cwd => (await repoInfo(cwd)).root,
			source: () => source,
			defaultBranch: async () => "main",
			target: (root, number) => resolveTarget(root, { ref: `pr/${number}` }),
			head: resolvePrHead,
			ownBase,
			diff: diffBoardFiles,
			now: Date.now,
		});
		const upper = await board.ownDiff(repo, 2);
		expect(upper.files.map(file => file.path)).toEqual(["b.ts"]);
		expect(upper.against.ref).toBe("lower");
		expect(upper.head).toBe(await run(repo, "rev-parse", "upper"));
		// Against what the two branches share, not against the moved head of the one below.
		expect(upper.against.sha).toBe(await run(repo, "rev-parse", "upper~1"));

		const lower = await board.ownDiff(repo, 1);
		expect(lower.files.map(file => [file.path, file.added, file.removed])).toEqual([["a.ts", 2, 1]]);
		expect(lower.against.ref).toBe("main");
	});
});
