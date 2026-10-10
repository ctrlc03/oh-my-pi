import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkReview,
	createPrReview,
	DIFF_TTL_MS,
	mergeBlocker,
	type PrDeps,
	reviewPayload,
	splitPrDiff,
} from "../scripts/companion-prreview";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const DIFF = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,2 @@",
	" keep",
	"-old",
	"+new",
	"diff --git a/docs/new file.md b/docs/new file.md",
	"new file mode 100644",
	"--- /dev/null",
	"+++ b/docs/new file.md",
	"@@ -0,0 +1 @@",
	"+hello",
	"diff --git a/gone.txt b/gone.txt",
	"deleted file mode 100644",
	"--- a/gone.txt",
	"+++ /dev/null",
	"@@ -1 +0,0 @@",
	"-bye",
	"diff --git a/old/name.ts b/new/name.ts",
	"similarity index 90%",
	"rename from old/name.ts",
	"rename to new/name.ts",
	"--- a/old/name.ts",
	"+++ b/new/name.ts",
	"@@ -1 +1 @@",
	"-x",
	"+diff --git a/not/a/header b/not/a/header",
	"diff --git a/img.png b/img.png",
	"index 333..444 100644",
	"Binary files a/img.png and b/img.png differ",
	'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
	'--- "a/caf\\303\\251.txt"',
	'+++ "b/caf\\303\\251.txt"',
	"@@ -1 +1 @@",
	"-a",
	"+b",
	"",
].join("\n");

describe("splitPrDiff", () => {
	const parts = splitPrDiff(DIFF);

	it("yields one section per file under its new path, in order", () => {
		expect(parts.map(p => p.path)).toEqual([
			"src/a.ts",
			"docs/new file.md",
			"gone.txt",
			"new/name.ts",
			"img.png",
			"café.txt",
		]);
	});

	it("keeps a section's own lines only, so a file's diff never carries the next file's header", () => {
		const a = parts[0]?.diff ?? "";
		expect(a.startsWith("diff --git a/src/a.ts b/src/a.ts\n")).toBe(true);
		expect(a).toContain("+new\n");
		expect(a).not.toContain("docs/new file.md");
	});

	it("does not split on an added line that looks like a header", () => {
		const renamed = parts[3]?.diff ?? "";
		expect(renamed).toContain("+diff --git a/not/a/header b/not/a/header");
		expect(parts).toHaveLength(6);
	});

	it("names a binary file from its header", () => {
		expect(parts[4]?.diff).toContain("Binary files a/img.png and b/img.png differ");
	});

	it("is empty for an empty diff", () => {
		expect(splitPrDiff("")).toEqual([]);
	});
});

describe("review payload", () => {
	const base = { event: "COMMENT", body: " Looks mostly fine ", comments: [] };

	it("sends start_line with the same side only for a range", () => {
		const review = checkReview({
			...base,
			comments: [
				{ path: "a.ts", line: 4, side: "RIGHT", body: "single" },
				{ path: "a.ts", line: 9, side: "LEFT", startLine: 7, body: "range" },
			],
			commit: SHA,
		});
		expect(reviewPayload(review)).toEqual({
			event: "COMMENT",
			body: "Looks mostly fine",
			commit_id: SHA,
			comments: [
				{ path: "a.ts", body: "single", line: 4, side: "RIGHT" },
				{ path: "a.ts", body: "range", line: 9, side: "LEFT", start_line: 7, start_side: "LEFT" },
			],
		});
	});

	it("omits comments when there are none", () => {
		expect(reviewPayload(checkReview({ event: "APPROVE", body: "", comments: [] }))).toEqual({
			event: "APPROVE",
			body: "",
		});
	});

	it("requires a summary unless approving", () => {
		expect(() => checkReview({ event: "COMMENT", body: "  ", comments: [] })).toThrow("summary");
		expect(() => checkReview({ event: "REQUEST_CHANGES", body: "", comments: [] })).toThrow("summary");
		expect(() => checkReview({ event: "APPROVE", body: "", comments: [] })).not.toThrow();
	});

	it("refuses comments GitHub would reject", () => {
		const bad = (comment: unknown) => () => checkReview({ ...base, comments: [comment] });
		expect(bad({ path: "a", line: 5, side: "RIGHT", startLine: 5, body: "x" })).toThrow();
		expect(bad({ path: "a", line: 5, side: "RIGHT", startLine: 6, body: "x" })).toThrow();
		expect(bad({ path: "a", line: 0, side: "RIGHT", body: "x" })).toThrow();
		expect(bad({ path: "a", line: 1.5, side: "RIGHT", body: "x" })).toThrow();
		expect(bad({ path: "a", line: 1, side: "BOTH", body: "x" })).toThrow();
		expect(bad({ path: "", line: 1, side: "LEFT", body: "x" })).toThrow();
		expect(bad({ path: "a", line: 1, side: "LEFT", body: "  " })).toThrow();
		expect(() => checkReview({ event: "MERGE", body: "x", comments: [] })).toThrow();
		expect(() => checkReview({ ...base, commit: "HEAD" })).toThrow();
	});
});

describe("mergeBlocker", () => {
	const open = { state: "OPEN", isDraft: false, checks: "pass" as const };
	const none = { allowDraft: false, allowFailing: false, allowPending: false };

	it("lets an open pull request with passing or no checks through", () => {
		expect(mergeBlocker(open, none)).toBeNull();
		expect(mergeBlocker({ ...open, checks: null }, none)).toBeNull();
	});

	it("refuses failing checks, running checks and drafts until the user chose them", () => {
		expect(mergeBlocker({ ...open, checks: "fail" }, none)).toContain("failing");
		expect(mergeBlocker({ ...open, checks: "fail" }, { ...none, allowFailing: true })).toBeNull();
		expect(mergeBlocker({ ...open, checks: "pending" }, none)).toContain("still running");
		expect(mergeBlocker({ ...open, checks: "pending" }, { ...none, allowPending: true })).toBeNull();
		expect(mergeBlocker({ ...open, isDraft: true }, none)).toContain("draft");
		expect(mergeBlocker({ ...open, isDraft: true }, { ...none, allowDraft: true })).toBeNull();
		// Choosing one does not waive another.
		expect(mergeBlocker({ ...open, isDraft: true, checks: "fail" }, { ...none, allowDraft: true })).toContain(
			"failing",
		);
		expect(mergeBlocker({ ...open, checks: "fail" }, { ...none, allowPending: true })).toContain("failing");
	});

	it("refuses a pull request that is not open whatever the user chose", () => {
		const all = { allowDraft: true, allowFailing: true, allowPending: true };
		expect(mergeBlocker({ ...open, state: "MERGED" }, all)).toContain("not open");
	});
});

/** A fake `gh`: records every call and answers from `reply`. */
function fakeGh(reply: (args: string[]) => { code?: number; out?: string; err?: string }) {
	const calls: string[][] = [];
	const cwds: string[] = [];
	let clock = 1_000_000;
	const deps: PrDeps = {
		async run(cwd, args) {
			cwds.push(cwd);
			calls.push(args);
			const r = reply(args);
			return { code: r.code ?? 0, out: r.out ?? "", err: r.err ?? "" };
		},
		repo: async () => "o/r",
		now: () => clock,
	};
	return { deps, calls, cwds, tick: (ms: number) => (clock += ms) };
}

describe("PR diff cache", () => {
	const gh = (head: () => string) =>
		fakeGh(args => {
			if (args[0] === "pr" && args[1] === "diff") return { out: DIFF };
			if (args[0] === "pr" && args[1] === "view") return { out: JSON.stringify({ headRefOid: head() }) };
			return { code: 1, err: "unexpected" };
		});

	it("runs `gh pr diff` once for a burst of files, then again after the TTL", async () => {
		const fake = gh(() => SHA);
		const pr = createPrReview(fake.deps);
		const [a, b] = await Promise.all([pr.diff("/x", 7, SHA, "src/a.ts"), pr.diff("/x", 7, SHA, "gone.txt")]);
		expect(a.diff).toContain("+new");
		expect(b.diff).toContain("-bye");
		const c = await pr.diff("/x", 7, SHA, "new/name.ts");
		expect(c.diff).toContain("rename to new/name.ts");
		expect(fake.calls.filter(call => call[1] === "diff")).toHaveLength(1);
		fake.tick(DIFF_TTL_MS + 1);
		await pr.diff("/x", 7, SHA, "src/a.ts");
		expect(fake.calls.filter(call => call[1] === "diff")).toHaveLength(2);
	});

	it("answers an empty diff for a path the pull request does not change", async () => {
		const pr = createPrReview(gh(() => SHA).deps);
		expect(await pr.diff("/x", 7, SHA, "nope.ts")).toEqual({ diff: "", truncated: false });
	});

	it("refuses a diff when the pull request moved past the head the device saw, and does not cache it", async () => {
		let head = OTHER_SHA;
		const fake = gh(() => head);
		const pr = createPrReview(fake.deps);
		await expect(pr.diff("/x", 7, SHA, "src/a.ts")).rejects.toThrow("new commits");
		head = SHA;
		expect((await pr.diff("/x", 7, SHA, "src/a.ts")).diff).toContain("+new");
	});

	it("rejects a malformed head instead of running gh", async () => {
		const fake = gh(() => SHA);
		const pr = createPrReview(fake.deps);
		await expect(pr.diff("/x", 7, "--flag", "a")).rejects.toThrow("invalid commit");
		expect(fake.calls).toHaveLength(0);
	});
});

describe("PR files", () => {
	it("lists files from the paginated API with the head, tolerating unknown statuses", async () => {
		const fake = fakeGh(args => {
			if (args[0] === "api") {
				return {
					out: [
						'{"path":"a.ts","status":"modified","additions":3,"deletions":1,"from":null}',
						'{"path":"b.ts","status":"renamed","additions":0,"deletions":0,"from":"c.ts"}',
						'{"path":"d.bin","status":"weird","additions":0,"deletions":0}',
					].join("\n"),
				};
			}
			return { out: JSON.stringify({ headRefOid: SHA }) };
		});
		const result = await createPrReview(fake.deps).files("/x", 7);
		expect(result.head).toBe(SHA);
		expect(result.files).toEqual([
			{ path: "a.ts", status: "modified", additions: 3, deletions: 1 },
			{ path: "b.ts", status: "renamed", additions: 0, deletions: 0, from: "c.ts" },
			{ path: "d.bin", status: "changed", additions: 0, deletions: 0 },
		]);
		expect(fake.calls.find(call => call[0] === "api")).toContain("repos/o/r/pulls/7/files?per_page=100");
	});
});

describe("PR merge", () => {
	const view = (over: Record<string, unknown>) => ({
		out: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: SHA, statusCheckRollup: [], ...over }),
	});
	const failing = [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }];
	const running = [{ name: "ci", status: "IN_PROGRESS" }];
	const merges = (calls: string[][]) => calls.filter(call => call[1] === "merge" || call[1] === "ready");
	const base = { method: "squash", deleteBranch: false, head: SHA };

	it("never reaches `gh pr merge` while checks fail, and merges once the user chose to", async () => {
		const fake = fakeGh(args => (args[1] === "view" ? view({ statusCheckRollup: failing }) : { out: "" }));
		const pr = createPrReview(fake.deps);
		await expect(pr.merge("/x", 7, base)).rejects.toThrow("failing");
		expect(merges(fake.calls)).toHaveLength(0);
		await pr.merge("/x", 7, { ...base, deleteBranch: true, allowFailing: true });
		expect(merges(fake.calls)).toEqual([
			["pr", "merge", "7", "--repo", "o/r", "--squash", "--match-head-commit", SHA, "--delete-branch"],
		]);
		// Outside the repository: gh cannot check out, pull or delete a local branch.
		expect(fake.cwds.every(cwd => cwd === os.tmpdir())).toBe(true);
	});

	it("treats running checks like failing ones: an explicit choice is needed", async () => {
		const fake = fakeGh(args => (args[1] === "view" ? view({ statusCheckRollup: running }) : { out: "" }));
		const pr = createPrReview(fake.deps);
		await expect(pr.merge("/x", 7, base)).rejects.toThrow("still running");
		await expect(pr.merge("/x", 7, { ...base, allowFailing: true })).rejects.toThrow("still running");
		expect(merges(fake.calls)).toHaveLength(0);
		await pr.merge("/x", 7, { ...base, allowPending: true });
		expect(merges(fake.calls)).toHaveLength(1);
	});

	it("refuses to merge a head the user did not see, however many boxes were ticked", async () => {
		const fake = fakeGh(args => (args[1] === "view" ? view({ headRefOid: OTHER_SHA }) : { out: "" }));
		const pr = createPrReview(fake.deps);
		const everything = { ...base, allowDraft: true, allowFailing: true, allowPending: true };
		await expect(pr.merge("/x", 7, everything)).rejects.toThrow("New commits were pushed");
		expect(merges(fake.calls)).toHaveLength(0);
	});

	it("pins the merge to the head the device sent", async () => {
		const fake = fakeGh(args => (args[1] === "view" ? view({}) : { out: "" }));
		await createPrReview(fake.deps).merge("/x", 7, base);
		const call = merges(fake.calls)[0] ?? [];
		expect(call[call.indexOf("--match-head-commit") + 1]).toBe(SHA);
	});

	it("requires a well-formed head", async () => {
		const fake = fakeGh(() => view({}));
		const pr = createPrReview(fake.deps);
		await expect(pr.merge("/x", 7, { method: "squash", deleteBranch: false })).rejects.toThrow("invalid commit");
		await expect(pr.merge("/x", 7, { ...base, head: "--admin" })).rejects.toThrow("invalid commit");
		expect(fake.calls).toHaveLength(0);
	});

	it("marks a draft ready first only when the user chose to merge it", async () => {
		const fake = fakeGh(args => (args[1] === "view" ? view({ isDraft: true }) : { out: "" }));
		const pr = createPrReview(fake.deps);
		await expect(pr.merge("/x", 7, { ...base, method: "merge" })).rejects.toThrow("draft");
		expect(merges(fake.calls)).toHaveLength(0);
		await pr.merge("/x", 7, { ...base, method: "rebase", allowDraft: true });
		expect(merges(fake.calls).map(call => call[1])).toEqual(["ready", "merge"]);
		expect(merges(fake.calls)[1]).toContain("--rebase");
		expect(merges(fake.calls)[1]).not.toContain("--delete-branch");
	});

	it("refuses a closed pull request and an unknown method", async () => {
		const fake = fakeGh(() => view({ state: "MERGED" }));
		const pr = createPrReview(fake.deps);
		await expect(pr.merge("/x", 7, { ...base, allowDraft: true, allowFailing: true })).rejects.toThrow("not open");
		await expect(pr.merge("/x", 7, { ...base, method: "yolo" })).rejects.toThrow("invalid merge");
		expect(merges(fake.calls)).toHaveLength(0);
	});
});

describe("posting a review through gh", () => {
	let tmp: string;
	let repo: string;
	let savedGhBin: string | undefined;

	beforeAll(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-prreview-")));
		repo = path.join(tmp, "repo");
		await fs.mkdir(repo);
		const init = Bun.spawn(["git", "init", "-q", repo], { stdout: "ignore", stderr: "ignore" });
		if ((await init.exited) !== 0) throw new Error("git init failed");
		// A gh stand-in: copies the file given to --input, answers like the reviews endpoint.
		const stub = path.join(tmp, "gh");
		await fs.writeFile(
			stub,
			`#!/bin/sh
printf '%s\\n' "$@" > "${tmp}/argv-$1"
case "$1" in
  repo) echo '{"nameWithOwner":"o/r"}' ;;
  api)
    while [ $# -gt 0 ]; do
      if [ "$1" = "--input" ]; then cp "$2" "${tmp}/input.json"; echo "$2" > "${tmp}/input-path"; fi
      shift
    done
    echo '{"html_url":"https://github.com/o/r/pull/7#pullrequestreview-1"}' ;;
  *) exit 1 ;;
esac
`,
			{ mode: 0o755 },
		);
		savedGhBin = process.env.GH_BIN;
		process.env.GH_BIN = stub;
	});

	afterAll(async () => {
		if (savedGhBin === undefined) delete process.env.GH_BIN;
		else process.env.GH_BIN = savedGhBin;
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("POSTs the payload from a private file that is removed afterwards", async () => {
		const url = await createPrReview().review(repo, 7, {
			event: "REQUEST_CHANGES",
			body: "Please fix",
			comments: [{ path: "src/a.ts", line: 12, side: "RIGHT", startLine: 10, body: "why?" }],
			commit: SHA,
		});
		expect(url).toBe("https://github.com/o/r/pull/7#pullrequestreview-1");
		const argv = (await Bun.file(path.join(tmp, "argv-api")).text()).trim().split("\n");
		expect(argv.slice(0, 5)).toEqual(["api", "repos/o/r/pulls/7/reviews", "-X", "POST", "--input"]);
		expect(JSON.parse(await Bun.file(path.join(tmp, "input.json")).text())).toEqual({
			event: "REQUEST_CHANGES",
			body: "Please fix",
			commit_id: SHA,
			comments: [{ path: "src/a.ts", body: "why?", line: 12, side: "RIGHT", start_line: 10, start_side: "RIGHT" }],
		});
		const inputPath = (await Bun.file(path.join(tmp, "input-path")).text()).trim();
		expect(await Bun.file(inputPath).exists()).toBe(false);
	});
});
