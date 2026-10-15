import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import type { AgentLaunch } from "../scripts/companion-agent";
import { createQuizzes, type Quizzes } from "../scripts/companion-quiz";
import type { QuizDoc, QuizDocStakes } from "../scripts/companion-quiz-store";

let tmp: string;
let repo: string;
let first: string;
let second: string;

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

const STORE =
	"export class Store<S extends Access> {\n\tprivate items = new Map<string, string>();\n}\n\nexport class Writable extends Store<ReadWrite> {}\n";
const RUNTIME =
	'import { Writable } from "./store";\n\nexport function startRuntime(): Writable {\n\treturn new Writable();\n}\n';

/** Two multiple-choice questions, so scoring needs no model. */
const QUIZ_FILE = {
	parts: [
		{
			part: 1,
			questions: [
				{
					kind: "choice",
					topic: "What starts",
					prompt: "What does `startRuntime` return?",
					reminder: "Look at the signature.",
					refs: ["src/runtime.ts@3@startRuntime"],
					choices: ["A Writable", "A Store", "Nothing"],
					answer: "a",
					explanation: "It returns a new Writable.",
				},
				{
					kind: "choice",
					topic: "Where Writable comes from",
					prompt: "Where does the runtime get `Writable`?",
					reminder: "Look at the import.",
					refs: ["src/runtime.ts@1@Writable"],
					choices: ["From ./store", "From a global", "From a package"],
					answer: "a",
					explanation: "It imports it from ./store.",
				},
			],
		},
	],
};

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quiz-stakes-")));
	repo = path.join(tmp, "demo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "README.md"), "demo\n");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
	await git(repo, "checkout", "-q", "-b", "feature");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "store");
	first = await git(repo, "rev-parse", "HEAD");
	await fs.writeFile(path.join(repo, "src/runtime.ts"), RUNTIME);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "runtime");
	second = await git(repo, "rev-parse", "HEAD");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

interface Harness {
	quizzes: Quizzes;
	launches: AgentLaunch[];
	finished: { points: number; total: number }[];
	verdict: { passes: boolean };
}

function harness(name: string): Harness {
	const launches: AgentLaunch[] = [];
	const finished: { points: number; total: number }[] = [];
	const verdict = { passes: true };
	const quizzes = createQuizzes({
		storeDir: path.join(tmp, name, "agent", "quizzes"),
		cacheDir: path.join(tmp, name, "cache", "quizzes"),
		sessionsDir: path.join(tmp, "sessions"),
		now: () => Date.now(),
		changed: () => undefined,
		agent: {
			start: async launch => {
				launches.push(launch);
				await fs.writeFile(launch.outFile, JSON.stringify(QUIZ_FILE));
				return "agent-1";
			},
			hosts: async () => [{ instanceId: "agent-1", sessionId: "s-1", model: "stub/stub-model", busy: false }],
			stop: async () => undefined,
			cost: async () => 0.1,
		},
		ompBin: "omp",
		run: async () => ({ code: 1, out: "", err: "no model in this test" }),
		watch: { pollMs: 10, settleMs: 30 },
		stakes: {
			mark: () => 90,
			finished: async (_doc: QuizDoc, attempt: QuizAttempt) => {
				finished.push({ points: attempt.score.points, total: attempt.score.total });
				return verdict.passes;
			},
		},
	});
	return { quizzes, launches, finished, verdict };
}

const stakesOf = (delta: boolean, headCommit: string, baseCommit: string): QuizDocStakes => ({
	sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
	headTree: "t".repeat(40),
	headCommit,
	baseCommit,
	baseTree: "b".repeat(40),
	delta,
});

describe("a quiz for a high-stakes session", () => {
	it("compares exactly the two states it is given, so a delta quiz covers only the new changes", async () => {
		const h = harness("delta");
		const { id } = await h.quizzes.createForStakes({
			cwd: repo,
			sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
			head: { commit: second, ref: "@worktree", subject: "Working tree" },
			base: { commit: first, subject: "Last passed state" },
			stakes: stakesOf(true, second, first),
		});
		await h.quizzes.idle();
		expect(h.launches[0]!.prompt).toContain("### src/runtime.ts (added)");
		expect(h.launches[0]!.prompt).not.toContain("### src/store.ts");
		// Mostly the changes, with about a quarter design and understanding questions, about the new changes only.
		expect(h.launches[0]!.prompt).toContain("about a quarter (25 %)");
		expect(h.launches[0]!.prompt).toContain("never more than a third");
		expect(h.launches[0]!.prompt).toContain("these questions concern the new changes only");
		expect(h.quizzes.summary(id)).toMatchObject({
			status: "ready",
			stakes: { delta: true, passed: false },
		});
		const answer = await h.quizzes.get(id);
		expect(answer.stakes).toEqual({
			sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
			delta: true,
			passMark: 90,
		});
		expect(await git(repo, "for-each-ref", "refs/omp-blueprint/maps/stakes")).toBe("");
	});

	it("mixes in design and understanding questions of the changes, grounded in the session, and leaves the pass rule alone", async () => {
		const h = harness("mix");
		const { id } = await h.quizzes.createForStakes({
			cwd: repo,
			sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
			head: { commit: second },
			base: { commit: first },
			stakes: stakesOf(false, second, first),
		});
		await h.quizzes.idle();
		const prompt = h.launches[0]!.prompt;
		expect(prompt).toContain("about a quarter (25 %)");
		expect(prompt).toContain("These questions concern the changes below");
		expect(prompt).not.toContain("new changes only");
		expect(h.quizzes.summary(id)).toMatchObject({ about: "changes", focus: "mixed", stakes: { delta: false } });
		const answer = await h.quizzes.get(id);
		expect(answer.stakes).toMatchObject({ passMark: 90 });
	});

	it("asks the companion at every answer, and records the attempt that passed", async () => {
		const h = harness("pass");
		const { id } = await h.quizzes.createForStakes({
			cwd: repo,
			sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
			head: { commit: second },
			base: { commit: first },
			stakes: stakesOf(false, second, first),
		});
		await h.quizzes.idle();
		const { quiz } = await h.quizzes.get(id);
		const right = (question: string) =>
			quiz.questions
				.find(q => q.id === question)!
				.choices!.find(c => c.text.startsWith("A Writable") || c.text === "From ./store")!;
		h.verdict.passes = false;
		await h.quizzes.answer({ id, attempt: "a1", question: "q1", choice: right("q1").id });
		const last = await h.quizzes.answer({ id, attempt: "a1", question: "q2", choice: right("q2").id });
		expect(last.attempt.finishedAt).toBeDefined();
		expect(h.finished.at(-1)).toEqual({ points: 2, total: 2 });
		expect((await h.quizzes.get(id)).stakes?.passedAttempt).toBeUndefined();
		expect(h.quizzes.summary(id)?.stakes).toEqual({ delta: false, passed: false });

		const retry = await h.quizzes.retry({ id });
		h.verdict.passes = true;
		await h.quizzes.answer({ id, attempt: retry.attempt.id, question: "q1", choice: right("q1").id });
		await h.quizzes.answer({ id, attempt: retry.attempt.id, question: "q2", choice: right("q2").id });
		expect((await h.quizzes.get(id)).stakes?.passedAttempt).toBe(retry.attempt.id);
		expect(h.quizzes.summary(id)?.stakes).toEqual({ delta: false, passed: true });
	});

	it("refuses a request for a session id that is not one", async () => {
		const h = harness("bad");
		await expect(
			h.quizzes.createForStakes({
				cwd: repo,
				sessionId: "../x",
				head: { commit: second },
				base: { commit: first },
				stakes: stakesOf(false, second, first),
			}),
		).rejects.toThrow(/invalid session/);
	});
});
