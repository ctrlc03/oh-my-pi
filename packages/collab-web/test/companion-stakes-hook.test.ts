import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import { STAKES_IPC_FILE } from "@oh-my-pi/pi-wire/stakes";
import type { Quizzes } from "../scripts/companion-quiz";
import type { QuizDoc } from "../scripts/companion-quiz-store";
import { createScheduler } from "../scripts/companion-schedule";
import { type ScheduleIpc, startScheduleIpc } from "../scripts/companion-schedule-ipc";
import { createStakes, type Stakes } from "../scripts/companion-stakes";

let tmp: string;
let repo: string;
let remote: string;
let agentDir: string;
let ipcFile: string;
let ipc: ScheduleIpc | undefined;
let created: Parameters<Quizzes["createForStakes"]>[0][];

async function run(cwd: string, command: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: `${out}${err}`.trim() };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { code, out } = await run(cwd, ["git", ...args]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${out}`);
	return out;
}

const quizzes: Pick<Quizzes, "createForStakes" | "summary" | "get"> = {
	async createForStakes(input) {
		created.push(input);
		return { id: `q${created.length}` };
	},
	summary: id => ({ id, status: "ready" }) as QuizSummary,
	get: async () => ({ quiz: { questions: [{}, {}] }, attempts: [] }) as never,
};

async function openStakes(serve: boolean): Promise<Stakes> {
	const stakes = createStakes({
		agentDir,
		now: () => 1_000,
		session: async () => ({ sessionId: "s1", cwd: repo }),
		quizzes,
		changed: () => undefined,
	});
	await stakes.init();
	if (serve) {
		ipc = await startScheduleIpc({
			file: path.join(tmp, "schedule-ipc.json"),
			scheduler: createScheduler({
				now: () => 1,
				initial: [],
				save: async () => {},
				start: async () => "inst",
				spendLimitReached: async () => false,
				refreshSessions: async () => {},
				isWorking: () => false,
				notify: () => {},
				onError: () => {},
			}),
			validate: { now: () => 1, sandboxAvailable: false, checkDirectory: async () => {} },
			stakes: { prePush: body => stakes.prePush(body) },
		});
		await ipc.publishStakes(ipcFile);
	}
	return stakes;
}

async function pass(stakes: Stakes): Promise<void> {
	await stakes.quiz("i1");
	const made = created[created.length - 1]!;
	const doc = { id: "q", quiz: { questions: [{}, {}] }, stakes: { ...made.stakes } } as unknown as QuizDoc;
	const attempt = {
		id: "a",
		questions: ["x", "y"],
		answers: {},
		finishedAt: 1,
		score: { points: 20, total: 20, percent: 100 },
	};
	expect(await stakes.finished(doc, attempt as never)).toBe(true);
}

async function commitFile(name: string, text: string): Promise<void> {
	await fs.writeFile(path.join(repo, name), text);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", name);
}

const remoteBranches = async (): Promise<string> => await git(remote, "branch", "--list");

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stakes-hook-")));
	repo = path.join(tmp, "work");
	remote = path.join(tmp, "remote.git");
	agentDir = path.join(tmp, "agent");
	ipcFile = path.join(agentDir, STAKES_IPC_FILE);
	created = [];
	await fs.mkdir(repo, { recursive: true });
	await git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "remote", "add", "origin", remote);
	await commitFile("base.txt", "base\n");
	await git(repo, "push", "-q", "origin", "main");
	await git(repo, "checkout", "-q", "-b", "feature");
	await commitFile("a.txt", "a\n");
});

afterEach(async () => {
	await ipc?.stop();
	ipc = undefined;
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("the pre-push hook with the companion running", () => {
	it("stops a push until the quiz is passed, whichever client pushes", async () => {
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		const refused = await run(repo, ["git", "push", "origin", "feature"]);
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain("Take the quiz");
		expect(await remoteBranches()).not.toContain("feature");
		await pass(stakes);
		const pushed = await run(repo, ["git", "push", "origin", "feature"]);
		expect(pushed.code).toBe(0);
		expect(await remoteBranches()).toContain("feature");
	});

	it("stops a push of a commit no quiz covered, even from a branch that was pushed before", async () => {
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		await pass(stakes);
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).toBe(0);
		await commitFile("b.txt", "b\n");
		const refused = await run(repo, ["git", "push", "origin", "feature"]);
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain("since the last passed quiz");
		await pass(stakes);
		expect(created[1]!.stakes.delta).toBe(true);
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).toBe(0);
	});

	it("lets a branch be deleted without a quiz", async () => {
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		await pass(stakes);
		await git(repo, "push", "-q", "origin", "feature");
		expect((await run(repo, ["git", "push", "origin", "--delete", "feature"])).code).toBe(0);
	});

	it("does not trust an endpoint file with the wrong token", async () => {
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		const endpoint = JSON.parse(await Bun.file(ipcFile).text()) as { port: number; pid: number };
		await Bun.write(ipcFile, JSON.stringify({ ...endpoint, token: "forged" }));
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).not.toBe(0);
	});
});

describe("the pre-push hook without the companion", () => {
	it("goes by the state file: blocks what no pass covers, allows what one did", async () => {
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		await pass(stakes);
		await ipc?.stop();
		ipc = undefined;
		expect(await Bun.file(ipcFile).exists()).toBe(false);
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).toBe(0);
		await commitFile("b.txt", "b\n");
		const refused = await run(repo, ["git", "push", "origin", "feature"]);
		expect(refused.code).not.toBe(0);
		expect(refused.out).toContain("cannot be reached");
	});

	it("treats a stale endpoint file of a crashed companion like a missing companion", async () => {
		const stakes = await openStakes(false);
		await stakes.set("i1", true, { by: "Phone" });
		await Bun.write(ipcFile, JSON.stringify({ port: 9, token: "x", pid: 1 }));
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).not.toBe(0);
	});

	it("lets a repository through that no session gates", async () => {
		await openStakes(false);
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).toBe(0);
	});
});

describe("the hook file", () => {
	it("runs a hook the user already had after its own check, and gives it back when the mode is off", async () => {
		const hooks = path.join(repo, ".git/hooks");
		await fs.writeFile(
			path.join(hooks, "pre-push"),
			`#!/bin/sh\necho ran > "${path.join(tmp, "user-hook-ran")}"\nexit 0\n`,
			{
				mode: 0o755,
			},
		);
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		expect(await Bun.file(path.join(hooks, "pre-push.omp-orig")).exists()).toBe(true);
		await pass(stakes);
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).toBe(0);
		expect(await Bun.file(path.join(tmp, "user-hook-ran")).exists()).toBe(true);
		await stakes.set("i1", false, { by: "Phone", confirmOff: true });
		expect(await Bun.file(path.join(hooks, "pre-push")).text()).toContain("user-hook-ran");
		expect(await Bun.file(path.join(hooks, "pre-push.omp-orig")).exists()).toBe(false);
	});

	it("still refuses when the user's own hook would allow the push", async () => {
		const hooks = path.join(repo, ".git/hooks");
		await fs.writeFile(path.join(hooks, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).not.toBe(0);
	});

	it("is put back after something replaced it, with what replaced it moved aside", async () => {
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		const hook = path.join(repo, ".git/hooks/pre-push");
		await fs.writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await stakes.tick([{ sessionId: "s1", cwd: repo }]);
		expect(await Bun.file(hook).text()).toContain("omp-high-stakes-hook");
		expect((await run(repo, ["git", "push", "origin", "feature"])).code).not.toBe(0);
	});

	it("is not installed where core.hooksPath belongs to another tool, and the session says so", async () => {
		await git(repo, "config", "core.hooksPath", ".husky");
		const stakes = await openStakes(true);
		await stakes.set("i1", true, { by: "Phone" });
		expect(await Bun.file(path.join(repo, ".git/hooks/pre-push")).exists()).toBe(false);
		const status = await stakes.status("i1");
		expect(status.hook).toBe("unavailable");
		expect(status.hookNote).toContain("core.hooksPath");
	});
});
