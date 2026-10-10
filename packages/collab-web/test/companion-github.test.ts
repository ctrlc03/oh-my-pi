import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { githubItem, githubList } from "../scripts/companion-github";

let tmp: string;
let repo: string;
let savedGhBin: string | undefined;

const PR_LIST = [
	{
		number: 3,
		title: "Older, failing",
		state: "OPEN",
		isDraft: false,
		author: { login: "a" },
		labels: [{ name: "bug" }],
		updatedAt: "2026-01-01T00:00:00Z",
		url: "https://github.com/o/r/pull/3",
		reviewDecision: "CHANGES_REQUESTED",
		statusCheckRollup: [
			{ status: "IN_PROGRESS", conclusion: "" },
			{ status: "COMPLETED", conclusion: "FAILURE" },
		],
	},
	{
		number: 9,
		title: "Newer, draft",
		state: "OPEN",
		isDraft: true,
		author: null,
		labels: [],
		updatedAt: "2026-02-01T00:00:00Z",
		url: "https://github.com/o/r/pull/9",
		reviewDecision: "",
		statusCheckRollup: [
			{ status: "COMPLETED", conclusion: "SKIPPED" },
			{ state: "PENDING", context: "ci/legacy" },
		],
	},
];

const PR_VIEW = {
	...PR_LIST[0],
	body: "Fixes the thing.",
	headRefName: "fix",
	baseRefName: "main",
	additions: 10,
	deletions: 2,
	changedFiles: 3,
	statusCheckRollup: [
		{ name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
		{ context: "deploy", state: "ERROR", targetUrl: "https://ci/2" },
		{ name: "lint", workflowName: "CI", status: "QUEUED", conclusion: "" },
	],
	comments: Array.from({ length: 35 }, (_, i) => ({
		author: { login: `u${i}` },
		body: `comment ${i}`,
		createdAt: "2026-01-02T00:00:00Z",
	})),
};

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-github-")));
	repo = path.join(tmp, "repo");
	await fs.mkdir(path.join(repo, "sub"), { recursive: true });
	const init = Bun.spawn(["git", "init", "-q", repo], { stdout: "ignore", stderr: "ignore" });
	if ((await init.exited) !== 0) throw new Error("git init failed");
	await Bun.write(path.join(tmp, "pr-list.json"), JSON.stringify(PR_LIST));
	await Bun.write(path.join(tmp, "pr-view.json"), JSON.stringify(PR_VIEW));

	// A gh stand-in: records each subcommand's arguments and answers from the fixtures above.
	const stub = path.join(tmp, "gh");
	await fs.writeFile(
		stub,
		`#!/bin/sh
printf '%s\\n' "$@" > "${tmp}/argv-$1-$2"
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"o/r"}' ;;
  "pr list") cat "${tmp}/pr-list.json" ;;
  "issue list") echo '[]' ;;
  "pr view") cat "${tmp}/pr-view.json" ;;
  *) echo "GraphQL: Could not resolve to an issue with the number of $3. (repository.issue)" >&2; exit 1 ;;
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

async function argv(cmd: string): Promise<string[]> {
	return (await Bun.file(path.join(tmp, `argv-${cmd}`)).text()).trim().split("\n");
}

describe("githubList", () => {
	it("lists newest first with combined checks and review state", async () => {
		const { repo: name, items } = await githubList(path.join(repo, "sub"), "pr", "open");
		expect(name).toBe("o/r");
		expect(items.map(item => item.number)).toEqual([9, 3]);
		expect(items[0]).toMatchObject({ draft: true, author: "ghost", review: null, checks: "pending" });
		// A failing check outranks one still running.
		expect(items[1]).toMatchObject({ labels: ["bug"], review: "changes", checks: "fail" });
	});

	it("asks gh for pull requests waiting on my review", async () => {
		await githubList(repo, "pr", "review");
		const args = await argv("pr-list");
		expect(args.slice(args.indexOf("--search"), args.indexOf("--search") + 2)).toEqual([
			"--search",
			"review-requested:@me",
		]);
		expect(args).toContain("open");
	});

	it("filters issues by assignee", async () => {
		const { items } = await githubList(repo, "issue", "mine");
		expect(items).toEqual([]);
		const args = await argv("issue-list");
		expect(args.slice(args.indexOf("--assignee"), args.indexOf("--assignee") + 2)).toEqual(["--assignee", "@me"]);
	});

	it("refuses filters a kind lacks and prototype keys", async () => {
		await expect(githubList(repo, "issue", "review")).rejects.toThrow("invalid filter");
		await expect(githubList(repo, "pr", "constructor")).rejects.toThrow("invalid filter");
		await expect(githubList(repo, "constructor", "open")).rejects.toThrow("invalid kind");
	});

	it("refuses folders outside a repository", async () => {
		await expect(githubList(tmp, "pr", "open")).rejects.toThrow("not a git repository");
	});
});

describe("githubItem", () => {
	it("opens a pull request with its checks failing first and the latest comments", async () => {
		const item = await githubItem(repo, "pr", 3);
		expect(item.checkList).toEqual([
			{ name: "deploy", state: "fail", url: "https://ci/2" },
			{ name: "CI / lint", state: "pending", url: "" },
			{ name: "CI / test", state: "pass", url: "https://ci/1" },
		]);
		expect(item.checks).toBe("fail");
		expect(item.comments).toHaveLength(30);
		expect(item.comments[0]?.author).toBe("u5");
		expect(item.olderComments).toBe(5);
		expect(item.branch).toEqual({ head: "fix", base: "main" });
		expect(item.size).toEqual({ additions: 10, deletions: 2, files: 3 });
	});

	it("passes on what gh printed when it fails", async () => {
		await expect(githubItem(repo, "issue", 404)).rejects.toThrow("Could not resolve to an issue");
	});

	it("refuses numbers that are not positive integers", async () => {
		await expect(githubItem(repo, "pr", 1.5)).rejects.toThrow("invalid number");
		await expect(githubItem(repo, "pr", "3")).rejects.toThrow("invalid number");
	});
});
