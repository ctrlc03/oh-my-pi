import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { QuizAttempt, QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import { parseStakesState, STAKES_STATE_DIR, stakesStateKey } from "@oh-my-pi/pi-wire/stakes";
import type { Quizzes } from "../scripts/companion-quiz";
import type { QuizDoc, QuizDocStakes } from "../scripts/companion-quiz-store";
import { createStakes, type Stakes } from "../scripts/companion-stakes";

let tmp: string;
let repo: string;
let agentDir: string;
let created: Parameters<Quizzes["createForStakes"]>[0][];
let changes: string[];

async function git(cwd: string, ...args: string[]): Promise<string> {
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

async function commitFile(name: string, text: string, message = name): Promise<string> {
	await fs.writeFile(path.join(repo, name), text);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", message);
	return await git(repo, "rev-parse", "HEAD");
}

const quizzes: Pick<Quizzes, "createForStakes" | "summary" | "get"> = {
	async createForStakes(input) {
		created.push(input);
		return { id: `q${created.length}` };
	},
	summary(id) {
		return { id, status: "ready" } as QuizSummary;
	},
	async get() {
		return { quiz: { questions: [{}, {}] }, attempts: [] } as never;
	},
};

function open(): Stakes {
	return createStakes({
		agentDir,
		now: () => 1_000,
		session: async () => ({ sessionId: "s1", cwd: repo }),
		quizzes,
		changed: sessionId => changes.push(sessionId),
	});
}

/** A finished attempt that asked every question of the quiz the companion made last, scoring `points` of `total`. */
function attemptOf(points: number, total: number, questions = 2): QuizAttempt {
	return {
		id: "a1",
		questions: Array.from({ length: questions }, (_, i) => `x${i}`),
		answers: {},
		finishedAt: 5,
		score: { points, total, percent: Math.round((points / total) * 100) },
	} as unknown as QuizAttempt;
}

function docOf(stakes: QuizDocStakes): QuizDoc {
	return { id: "q", quiz: { questions: [{}, {}] }, stakes: { ...stakes } } as unknown as QuizDoc;
}

/** Take the quiz the companion offers and score it as the app would, then report whether the pass was recorded. */
async function take(stakes: Stakes, points: number, total = 20): Promise<boolean> {
	await stakes.quiz("i1");
	const made = created[created.length - 1]!;
	return await stakes.finished(docOf(made.stakes), attemptOf(points, total));
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stakes-")));
	repo = path.join(tmp, "work");
	agentDir = path.join(tmp, "agent");
	created = [];
	changes = [];
	await fs.mkdir(repo, { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await commitFile("base.txt", "base\n");
	await git(repo, "checkout", "-q", "-b", "feature");
	await commitFile("a.txt", "a\n");
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

async function highStakes(): Promise<Stakes> {
	const stakes = open();
	await stakes.init();
	await stakes.set("i1", true, { by: "Phone" });
	return stakes;
}

describe("the mode", () => {
	it("is off until it is turned on, and marks the rows it gates", async () => {
		const stakes = open();
		await stakes.init();
		expect((await stakes.status("i1")).on).toBe(false);
		expect(stakes.markRows([{ sessionId: "s1" }, { sessionId: "s2" }])).toEqual([
			{ sessionId: "s1" },
			{ sessionId: "s2" },
		]);
		await stakes.set("i1", true, { by: "Phone" });
		expect(stakes.markRows([{ sessionId: "s1" }, { sessionId: "s2" }])).toEqual([
			{ sessionId: "s1", highStakes: true },
			{ sessionId: "s2" },
		]);
		expect(changes).toEqual(["s1"]);
	});

	it("needs a confirmation to be turned off, and says who did it", async () => {
		const stakes = await highStakes();
		await expect(stakes.set("i1", false, { by: "Laptop" })).rejects.toThrow(/needs confirmation/);
		await expect(stakes.set("i1", false, { by: "Laptop", confirmOff: "yes" })).rejects.toThrow(/needs confirmation/);
		expect((await stakes.status("i1")).on).toBe(true);
		await stakes.set("i1", false, { by: "Laptop", confirmOff: true });
		expect((await stakes.status("i1")).on).toBe(false);
		const state = parseStakesState(
			await fs.readFile(path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(repo)), "utf8"),
		);
		expect(state).toMatchObject({ on: false, by: "Laptop", checkout: repo });
	});

	it("keeps the mode and the passes across a restart", async () => {
		const stakes = await highStakes();
		expect(await take(stakes, 19)).toBe(true);
		const restarted = open();
		await restarted.init();
		expect(restarted.isOn("s1")).toBe(true);
		await restarted.guard("i1", "push");
		const status = await restarted.status("i1");
		expect(status).toMatchObject({ on: true, covered: true, coveredBy: "pass", passed: { points: 19, total: 20 } });
	});

	it("puts the pre-push hook in the repository while the mode is on, and takes it out when it is off", async () => {
		const hook = path.join(repo, ".git/hooks/pre-push");
		const stakes = await highStakes();
		expect(await Bun.file(hook).text()).toContain("omp-high-stakes-hook");
		expect((await fs.stat(hook)).mode & 0o100).toBeTruthy();
		await stakes.set("i1", false, { by: "Phone", confirmOff: true });
		expect(await Bun.file(hook).exists()).toBe(false);
	});
});

describe("what a pass covers", () => {
	it("refuses until the changes are quizzed, then allows the same tree", async () => {
		const stakes = await highStakes();
		const before = await stakes.status("i1");
		expect(before).toMatchObject({ on: true, covered: false, needs: "full", hook: "installed" });
		await expect(stakes.guard("i1", "push")).rejects.toThrow(/needs a passed quiz/);
		expect(await take(stakes, 18)).toBe(true);
		await stakes.guard("i1", "push");
		await stakes.guard("i1", "pr");
	});

	it("quizzes the whole patch against the merge base with the default branch", async () => {
		const stakes = await highStakes();
		const mainTip = await git(repo, "rev-parse", "main");
		const { id, delta, created: made } = await stakes.quiz("i1");
		expect({ id, delta, made }).toEqual({ id: "q1", delta: false, made: true });
		expect(created[0]!.base.commit).toBe(mainTip);
		expect(created[0]!.stakes).toMatchObject({ delta: false, baseCommit: mainTip });
	});

	it("opens the quiz that exists instead of writing another for the same diff", async () => {
		const stakes = await highStakes();
		await stakes.quiz("i1");
		expect(await stakes.quiz("i1")).toEqual({ id: "q1", delta: false, created: false });
		expect((await stakes.status("i1")).quiz).toMatchObject({ id: "q1", delta: false });
		expect(created).toHaveLength(1);
	});

	it("quizzes the working tree, so the quiz can be taken before committing", async () => {
		const stakes = await highStakes();
		await fs.writeFile(path.join(repo, "dirty.txt"), "uncommitted\n");
		await stakes.quiz("i1");
		const quizzed = await git(repo, "rev-parse", `${created[0]!.head.commit}^{tree}`);
		expect((await git(repo, "ls-tree", "-r", "--name-only", quizzed)).split("\n")).toContain("dirty.txt");
	});

	it("does not need a new quiz for commits that only record what was quizzed", async () => {
		const stakes = await highStakes();
		await take(stakes, 20);
		await git(repo, "commit", "-q", "--allow-empty", "-m", "empty");
		await git(repo, "commit", "-q", "--amend", "--allow-empty", "-m", "reworded");
		await stakes.guard("i1", "push");
		await fs.writeFile(path.join(repo, "a.txt"), "a changed\n");
		await git(repo, "commit", "-q", "-am", "edit");
		await git(repo, "reset", "-q", "--hard", "HEAD~1");
		await stakes.guard("i1", "push");
	});

	it("needs a quiz on only the new changes after the passed diff, and a pass on it covers everything", async () => {
		const stakes = await highStakes();
		await take(stakes, 20);
		const passedCommit = created[0]!.stakes.headCommit;
		await commitFile("b.txt", "b\n");
		await expect(stakes.guard("i1", "push")).rejects.toThrow(/since the last passed quiz/);
		expect(await stakes.status("i1")).toMatchObject({ covered: false, needs: "delta" });
		expect(await take(stakes, 18)).toBe(true);
		const second = created[1]!;
		expect(second.stakes).toMatchObject({ delta: true, baseCommit: passedCommit });
		expect(second.base.commit).toBe(passedCommit);
		await stakes.guard("i1", "push");
		// The pass it replaced still counts: going back to it needs no quiz.
		await git(repo, "reset", "-q", "--hard", "HEAD~1");
		await stakes.guard("i1", "push");
	});

	it("covers a rebase, which has the same patch on another base", async () => {
		const stakes = await highStakes();
		await take(stakes, 20);
		await git(repo, "checkout", "-q", "main");
		await commitFile("other.txt", "other\n");
		await git(repo, "checkout", "-q", "feature");
		await git(repo, "rebase", "-q", "main");
		await stakes.guard("i1", "push");
		expect(await stakes.status("i1")).toMatchObject({ covered: true, coveredBy: "same-diff" });
	});

	it("has nothing to quiz when there are no changes against the default branch", async () => {
		const stakes = await highStakes();
		await git(repo, "checkout", "-q", "main");
		expect(await stakes.status("i1")).toMatchObject({ covered: true, coveredBy: "nothing-to-publish" });
		await stakes.guard("i1", "push");
		await expect(stakes.quiz("i1")).rejects.toThrow(/nothing to quiz/);
	});

	it("refuses a merge of a head this checkout does not hold", async () => {
		const stakes = await highStakes();
		await take(stakes, 20);
		await stakes.guard("i1", "merge", await git(repo, "rev-parse", "HEAD"));
		await expect(stakes.guard("i1", "merge", "1".repeat(40))).rejects.toThrow(/not in this checkout/);
		await commitFile("b.txt", "b\n");
		await expect(stakes.guard("i1", "merge", await git(repo, "rev-parse", "HEAD"))).rejects.toThrow(
			/needs a passed quiz/,
		);
	});
});

describe("when a quiz counts as passed", () => {
	it("compares the exact score with the pass mark, not the rounded percent", async () => {
		const stakes = await highStakes();
		expect(await take(stakes, 17.5)).toBe(false);
		expect(await take(stakes, 17.4)).toBe(false);
		expect((await stakes.status("i1")).covered).toBe(false);
		expect(await take(stakes, 18)).toBe(true);
	});

	it("follows the pass mark setting, which is checked and kept", async () => {
		const stakes = await highStakes();
		expect(stakes.settings()).toEqual({ passMark: 90 });
		await expect(stakes.setPassMark(49)).rejects.toThrow(/50 to 100/);
		await expect(stakes.setPassMark(90.5)).rejects.toThrow(/50 to 100/);
		await stakes.setPassMark(75);
		expect(await take(stakes, 14)).toBe(false);
		expect(await take(stakes, 15)).toBe(true);
		const restarted = open();
		await restarted.init();
		expect(restarted.settings()).toEqual({ passMark: 75 });
	});

	it("does not count an unfinished attempt or one that left questions out", async () => {
		const stakes = await highStakes();
		await stakes.quiz("i1");
		const doc = docOf(created[0]!.stakes);
		expect(await stakes.finished(doc, { ...attemptOf(20, 20), finishedAt: undefined })).toBe(false);
		expect(await stakes.finished(doc, attemptOf(20, 20, 1))).toBe(false);
		expect((await stakes.status("i1")).covered).toBe(false);
		expect(await stakes.finished(doc, attemptOf(20, 20))).toBe(true);
	});

	it("does not count a delta quiz whose starting point is not covered", async () => {
		const stakes = await highStakes();
		await stakes.quiz("i1");
		const stakesDoc = { ...created[0]!.stakes, delta: true, baseTree: "0".repeat(40) };
		expect(await stakes.finished(docOf(stakesDoc), attemptOf(20, 20))).toBe(false);
		expect((await stakes.status("i1")).covered).toBe(false);
	});

	it("keeps a pass at the mark it had, when the mark goes up later", async () => {
		const stakes = await highStakes();
		await take(stakes, 18);
		await stakes.setPassMark(100);
		await stakes.guard("i1", "push");
	});
});

describe("the pre-push question", () => {
	it("allows a push from a checkout that is not high stakes", async () => {
		const stakes = open();
		await stakes.init();
		expect(await stakes.prePush(`${repo}\n${await git(repo, "rev-parse", "HEAD")}\n`)).toEqual({
			allow: true,
			message: "",
		});
	});

	it("denies a commit no quiz covered and allows it after a pass, for every high-stakes session of the checkout", async () => {
		const stakes = await highStakes();
		const head = await git(repo, "rev-parse", "HEAD");
		const denied = await stakes.prePush(`${repo}\n${head}\n`);
		expect(denied.allow).toBe(false);
		expect(denied.message).toContain("quiz");
		await take(stakes, 20);
		expect(await stakes.prePush(`${repo}\n${head}\n`)).toEqual({ allow: true, message: "" });
		// A commit that has other changes is not covered, whatever branch it is on.
		const next = await commitFile("c.txt", "c\n");
		expect((await stakes.prePush(`${repo}\n${head}\n${next}\n`)).allow).toBe(false);
	});

	it("denies a request it cannot read", async () => {
		const stakes = await highStakes();
		expect((await stakes.prePush(`${repo}\nnot-a-sha\n`)).allow).toBe(false);
	});
});

describe("the published state", () => {
	it("lists the covered trees and counts its revisions up", async () => {
		const stakes = await highStakes();
		const file = path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(repo));
		const first = parseStakesState(await fs.readFile(file, "utf8"))!;
		expect(first).toMatchObject({ on: true, checkout: repo, by: "Phone", passMark: 90, trees: [] });
		await take(stakes, 20);
		const second = parseStakesState(await fs.readFile(file, "utf8"))!;
		expect(second.rev).toBeGreaterThan(first.rev);
		expect(second.trees).toEqual([await git(repo, "rev-parse", "HEAD^{tree}")]);
		const index = await fs.readFile(path.join(agentDir, STAKES_STATE_DIR, "index"), "utf8");
		expect(index).toBe(`${stakesStateKey(repo)}\t${repo}\n`);
	});

	it("is written with the owner as the only reader", async () => {
		await highStakes();
		const stat = await fs.stat(path.join(agentDir, "high-stakes.json"));
		expect(stat.mode & 0o777).toBe(0o600);
	});
});

describe("a session being started", () => {
	it("gates the folder before the session has an id, and keeps the mode under the id it gets", async () => {
		const stakes = open();
		await stakes.init();
		const handle = await stakes.expect(repo, "Phone");
		expect(await Bun.file(path.join(repo, ".git/hooks/pre-push")).exists()).toBe(true);
		const head = await git(repo, "rev-parse", "HEAD");
		expect((await stakes.prePush(`${repo}\n${head}\n`)).allow).toBe(false);
		await stakes.adopt(handle, "s1");
		expect(stakes.isOn("s1")).toBe(true);
		expect(stakes.isOn(handle)).toBe(false);
	});

	it("takes the gate away when the session never starts, and forgets a start the companion died in", async () => {
		const stakes = open();
		await stakes.init();
		const handle = await stakes.expect(repo, "Phone");
		await stakes.discard(handle);
		expect(await Bun.file(path.join(repo, ".git/hooks/pre-push")).exists()).toBe(false);
		await stakes.expect(repo, "Phone");
		const restarted = open();
		await restarted.init();
		const head = await git(repo, "rev-parse", "HEAD");
		expect((await restarted.prePush(`${repo}\n${head}\n`)).allow).toBe(true);
	});
});
