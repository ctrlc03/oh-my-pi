import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { QuizVerdictKind } from "@oh-my-pi/pi-wire/quiz";
import { type AgentLaunch, GATED_TOOL_SETTINGS } from "../scripts/companion-agent";
import type { RunOmp } from "../scripts/companion-headless";
import { createQuizzes, type Quizzes } from "../scripts/companion-quiz";
import { MAX_GRADE_CALL_COST_USD } from "../scripts/companion-quiz-grade";
import type { PrSource, StackPr } from "../scripts/companion-quiz-stack";

let tmp: string;
let repo: string;
let sessionsDir: string;

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

const STORE_BEFORE =
	"export class Store {\n\tprivate items = new Map<string, string>();\n\n\tget(key: string): string | undefined {\n\t\treturn this.items.get(key);\n\t}\n}\n";
const STORE_AFTER =
	"export class Store<S extends Access> {\n\tprivate items = new Map<string, string>();\n\n\tget(key: string): string | undefined {\n\t\treturn this.items.get(key);\n\t}\n}\n\nexport class Writable extends Store<ReadWrite> {\n\tput(key: string, value: string): void {\n\t\tthis.items.set(key, value);\n\t}\n}\n";
const RUNTIME =
	'import { Writable } from "./store";\n\nexport function startRuntime(): Writable {\n\treturn new Writable();\n}\n';

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "quiz-run-")));
	sessionsDir = path.join(tmp, "sessions");
	repo = path.join(tmp, "demo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_BEFORE);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
	await git(repo, "checkout", "-q", "-b", "feature/typestate");
	await fs.writeFile(path.join(repo, "src/store.ts"), STORE_AFTER);
	await fs.writeFile(path.join(repo, "src/runtime.ts"), RUNTIME);
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "Make store access a type");
	// A session the changes came from, in the format omp writes: the folder is the encoded working directory.
	const folder = path.join(sessionsDir, "-work-repo");
	await fs.mkdir(folder, { recursive: true });
	await fs.copyFile(
		path.join(import.meta.dir, "fixtures/quiz/session.jsonl"),
		path.join(folder, "2026-10-12T10-25-35-118Z_01a12fa5-758e-7595-b768-bb9462d6e44e.jsonl"),
	);
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const QUIZ_FILE = {
	parts: [
		{
			part: 1,
			questions: [
				{
					kind: "open",
					topic: "Typestate and write access",
					prompt: "Why does `put` live only on `Writable`?",
					reminder: "A typestate encodes a permission in a type parameter.",
					refs: ["src/runtime.ts@1@Writable"],
					rubric: {
						points: ["`put` is defined on Writable, not on Store", "the check is at compile time"],
						misconceptions: ["says there is a runtime check"],
						model_answer: "Because Writable is the only type that carries ReadWrite.",
					},
				},
				{
					kind: "choice",
					topic: "Where the access lives",
					prompt: "Where does `Store` get its access from?",
					reminder: "Look at the type parameter.",
					refs: ["src/store.ts@1@Store<S"],
					choices: ["A type parameter", "A runtime flag", "A constructor argument"],
					answer: "a",
					explanation: "The access is the `S` parameter of `Store<S extends Access>`.",
				},
				{
					kind: "open",
					topic: "Invented",
					prompt: "Why is there a lock in the store?",
					reminder: "There is none.",
					refs: ["src/store.ts@3@Mutex"],
					rubric: { points: ["there is a lock"], misconceptions: [] },
				},
			],
		},
	],
};

interface Harness {
	quizzes: Quizzes;
	changes: string[];
	launches: AgentLaunch[];
	graded: { argv: string[]; stdin: string }[];
	setVerdict(kind: QuizVerdictKind, cost?: number): void;
}

function harness(
	name: string,
	options: { file?: unknown; gradeFails?: boolean; prSource?: (root: string) => PrSource } = {},
): Harness {
	const changes: string[] = [];
	const launches: AgentLaunch[] = [];
	const graded: { argv: string[]; stdin: string }[] = [];
	let verdict: QuizVerdictKind = "partly";
	let cost = 0.01;
	const run: RunOmp = async (argv, stdin) => {
		graded.push({ argv, stdin });
		if (options.gradeFails) return { code: 1, out: "", err: "400 stub says no\n" };
		const text = JSON.stringify({
			verdict,
			explanation: "You have the idea. `Writable` is the one that carries `ReadWrite`.",
			refs: ["src/runtime.ts@1@Writable", "src/runtime.ts@1@nothing_like_this"],
		});
		const event = {
			type: "message_end",
			message: {
				role: "assistant",
				model: "stub-model",
				content: [{ type: "text", text }],
				usage: { cost: { total: cost } },
			},
		};
		return { code: 0, out: `${JSON.stringify({ type: "agent_start" })}\n${JSON.stringify(event)}\n`, err: "" };
	};
	const quizzes = createQuizzes({
		storeDir: path.join(tmp, name, "agent", "quizzes"),
		cacheDir: path.join(tmp, name, "cache", "quizzes"),
		sessionsDir,
		now: () => Date.now(),
		changed: id => changes.push(id),
		agent: {
			start: async launch => {
				launches.push(launch);
				await fs.writeFile(launch.outFile, JSON.stringify(options.file ?? QUIZ_FILE));
				return "agent-1";
			},
			hosts: async () => [{ instanceId: "agent-1", sessionId: "s-1", model: "stub/stub-model", busy: false }],
			stop: async () => undefined,
			cost: async () => 0.4,
		},
		ompBin: "omp",
		prSource: options.prSource,
		run,
		watch: { pollMs: 10, settleMs: 30 },
	});
	return {
		quizzes,
		changes,
		launches,
		graded,
		setVerdict: (kind, spent) => {
			verdict = kind;
			cost = spent ?? cost;
		},
	};
}

describe("a quiz run", () => {
	it("writes a quiz from the diff and the session's conversation, verifies its citations, and keeps the answer key to itself", async () => {
		const h = harness("run1");
		const { id } = await h.quizzes.create({
			cwd: repo,
			ref: "feature/typestate",
			base: "main",
			sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
		});
		await h.quizzes.idle();
		const [summary] = await h.quizzes.list(repo);
		expect(summary).toMatchObject({
			id,
			status: "ready",
			questionCount: 2,
			partCount: 1,
			attemptCount: 1,
			costUsd: 0.4,
			maxCostUsd: 1,
			sessionId: "01a12fa5-758e-7595-b768-bb9462d6e44e",
		});
		expect(summary!.subject).toBe("feature/typestate vs main");
		expect(h.changes).toContain(id);

		// The brief has the changes with the numbers a citation uses, and the conversation (but not its tool output).
		expect(h.launches).toHaveLength(1);
		const launch = h.launches[0]!;
		expect(launch.prompt).toContain("### src/runtime.ts (added)");
		expect(launch.prompt).toContain("export class Writable extends Store<ReadWrite>");
		expect(launch.prompt).toContain("so the startup order is checked by the compiler");
		expect(launch.prompt).not.toContain("THINKING-SECRET");
		expect(launch.prompt).not.toContain("API_KEY");
		// Generation gets three quarters of the limit; grading the rest.
		expect(launch.maxCostUsd).toBe(0.75);
		for (const tool of launch.tools) {
			if (Object.hasOwn(GATED_TOOL_SETTINGS, tool))
				expect(launch.overlayYaml).toContain(`${GATED_TOOL_SETTINGS[tool]}:`);
		}
		expect(launch.tools).toEqual(expect.arrayContaining(["ast_grep", "trace", "flow"]));
		expect(launch.overlayYaml).toContain("astGrep:");
		expect(launch.overlayYaml).toContain("codemap:");

		const { quiz, attempts } = await h.quizzes.get(id);
		expect(quiz.questions.map(q => q.kind)).toEqual(["open", "choice"]);
		// The question with a citation that does not hold is dropped.
		expect(quiz.warnings.join(" ")).toContain("Dropped the question");
		expect(quiz.questions[0]!.refs).toEqual([{ path: "src/runtime.ts", line: 1, token: "Writable" }]);
		expect(quiz.sessionId).toBe("01a12fa5-758e-7595-b768-bb9462d6e44e");
		expect(quiz.parts[0]).toMatchObject({ title: "What the session changed" });
		// Nothing a device may not see: no rubric, no right choice.
		const wire = JSON.stringify({ quiz, attempts });
		expect(wire).not.toContain("compile time");
		expect(wire).not.toContain("explanation");
		expect(quiz.questions[1]!.choices!.map(c => c.id)).toEqual(["a", "b", "c"]);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]).toMatchObject({ id: "a1", questions: ["q1", "q2"], answers: {} });

		// The checkouts are gone and nothing lives in the repository.
		expect(await git(repo, "status", "--porcelain")).toBe("");
		expect(await fs.readdir(path.dirname(launch.cwd)).catch(() => [])).toEqual([]);

		const [hit, gone] = await h.quizzes.excerpt(id, 0, [
			quiz.questions[0]!.refs[0]!,
			{ path: "nope.ts", line: 1, token: "x" },
		]);
		expect(hit!.lines[hit!.line - hit!.start]).toContain("Writable");
		expect(gone).toBeNull();

		await h.quizzes.remove(id);
		expect(await h.quizzes.list(repo)).toEqual([]);
		expect(await git(repo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});

	it("grades a choice at once and an open answer with one small model call, within the spending limit", async () => {
		const h = harness("run2");
		const { id } = await h.quizzes.create({ cwd: repo, ref: "feature/typestate", base: "main", maxCostUsd: 0.5 });
		await h.quizzes.idle();
		const { quiz } = await h.quizzes.get(id);
		const choice = quiz.questions[1]!;
		const right = choice.choices!.find(c => c.text === "A type parameter")!;
		const wrong = choice.choices!.find(c => c.text === "A runtime flag")!;

		const missed = await h.quizzes.answer({ id, attempt: "a1", question: "q2", choice: wrong.id });
		expect(missed.verdict).toMatchObject({ kind: "wrong", graded: "local", answer: right.id });
		expect(missed.verdict.explanation).toContain("type parameter");
		expect(h.graded).toHaveLength(0);
		await expect(h.quizzes.answer({ id, attempt: "a1", question: "q2", choice: right.id })).rejects.toThrow(
			/already answered/,
		);
		await expect(h.quizzes.answer({ id, attempt: "a1", question: "q1", text: "   " })).rejects.toThrow(
			/Write an answer/,
		);

		const open = await h.quizzes.answer({
			id,
			attempt: "a1",
			question: "q1",
			text: "Because only Writable has the ReadWrite parameter, so the compiler decides.",
		});
		expect(open.verdict).toMatchObject({
			kind: "partly",
			graded: "model",
			keyPoints: ["`put` is defined on Writable, not on Store", "the check is at compile time"],
		});
		// The hint that did not hold is dropped, the one that did is shown.
		expect(open.verdict.refs).toEqual([{ path: "src/runtime.ts", line: 1, token: "Writable" }]);
		expect(h.graded).toHaveLength(1);
		const call = h.graded[0]!;
		expect(call.argv).toEqual(
			expect.arrayContaining(["--no-tools", "--no-session", "--mode", "json", "--model", "@smol"]),
		);
		// What is left of the limit after the question-writing session, but never more than one call may spend.
		expect(call.argv[call.argv.indexOf("--max-cost") + 1]).toBe(String(Math.min(MAX_GRADE_CALL_COST_USD, 0.1)));
		expect(call.stdin).toContain("the check is at compile time");
		expect(call.stdin).toContain("export function startRuntime");
		expect(call.stdin).toContain("only Writable has the ReadWrite parameter");

		// Both answered: the attempt finishes with 0.5 of 2 points, and the topic to revisit is named.
		expect(open.attempt.finishedAt).toBeDefined();
		expect(open.attempt.score).toMatchObject({ points: 0.5, total: 2, percent: 25 });
		expect(open.attempt.score.revisit.map(t => t.topic)).toEqual([
			"Where the access lives",
			"Typestate and write access",
		]);
		const [summary] = await h.quizzes.list(repo);
		expect(summary).toMatchObject({ latest: { points: 0.5, total: 2, percent: 25, finished: true } });
		expect(summary!.costUsd).toBeCloseTo(0.41, 6);

		// A retry asks the missed questions again, in a new attempt; the first one stays.
		const retry = await h.quizzes.retry({ id, only: "missed" });
		expect(retry.attempt).toMatchObject({ id: "a2", retryOf: "a1", questions: ["q1", "q2"], answers: {} });
		h.setVerdict("right");
		const again = await h.quizzes.answer({
			id,
			attempt: "a2",
			question: "q1",
			text: "Writable carries ReadWrite; Store does not have put.",
		});
		expect(again.verdict.kind).toBe("right");
		const all = await h.quizzes.get(id);
		expect(all.attempts.map(a => a.id)).toEqual(["a1", "a2"]);
		expect(all.attempts[0]!.score.points).toBe(0.5);
		await h.quizzes.answer({ id, attempt: "a2", question: "q2", choice: right.id });
		await expect(h.quizzes.retry({ id, only: "missed" })).rejects.toThrow(/every question was answered right/);
	});

	it("stops grading open answers once the limit is used up, and still grades choices", async () => {
		const h = harness("run3");
		const { id } = await h.quizzes.create({ cwd: repo, ref: "feature/typestate", base: "main", maxCostUsd: 0.41 });
		await h.quizzes.idle();
		h.setVerdict("right", 0.02);
		const first = await h.quizzes.answer({ id, attempt: "a1", question: "q1", text: "Because of the type." });
		expect(first.verdict.kind).toBe("right");
		await h.quizzes.retry({ id });
		await expect(h.quizzes.answer({ id, attempt: "a2", question: "q1", text: "Again." })).rejects.toThrow(
			/used up its spending limit/,
		);
		const { quiz } = await h.quizzes.get(id);
		const choice = await h.quizzes.answer({
			id,
			attempt: "a2",
			question: "q2",
			choice: quiz.questions[1]!.choices![0]!.id,
		});
		expect(choice.verdict.graded).toBe("local");
	});

	it("says why an answer could not be graded and records nothing", async () => {
		const h = harness("run4", { gradeFails: true });
		const { id } = await h.quizzes.create({ cwd: repo, ref: "feature/typestate", base: "main" });
		await h.quizzes.idle();
		await expect(h.quizzes.answer({ id, attempt: "a1", question: "q1", text: "Because." })).rejects.toThrow(
			/could not be graded: omp exited with 1: 400 stub says no/,
		);
		const { attempts } = await h.quizzes.get(id);
		expect(attempts[0]!.answers).toEqual({});
	});

	it("fails the quiz, with the reason, when nothing the agent wrote holds up", async () => {
		const h = harness("run5", {
			file: {
				parts: [
					{
						part: 1,
						questions: [{ kind: "open", prompt: "Q?", refs: ["src/store.ts@1@Nope"], rubric: { points: ["x"] } }],
					},
				],
			},
		});
		const { id } = await h.quizzes.create({ cwd: repo, ref: "feature/typestate", base: "main" });
		await h.quizzes.idle();
		const [summary] = await h.quizzes.list(repo);
		expect(summary).toMatchObject({ id, status: "failed" });
		expect(summary!.error).toContain("None of the agent's questions held up");
		await expect(h.quizzes.get(id)).rejects.toThrow(/failed/);
		expect(await git(repo, "for-each-ref", `refs/omp-blueprint/maps/${id}`)).toBe("");
	});

	it("refuses requests a device must not be able to make", async () => {
		const h = harness("run6");
		await expect(h.quizzes.create({ cwd: "relative" })).rejects.toThrow(/invalid folder/);
		await expect(h.quizzes.create({ cwd: repo, stack: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).rejects.toThrow(
			/at most|between 1 and 8/,
		);
		await expect(h.quizzes.create({ cwd: repo, stack: [3, 3] })).rejects.toThrow(/invalid stack/);
		await expect(h.quizzes.create({ cwd: repo, pr: 0 })).rejects.toThrow(/invalid pull request number/);
		await expect(h.quizzes.create({ cwd: repo, sessionId: "../../etc/passwd" })).rejects.toThrow(/invalid session/);
		await expect(h.quizzes.create({ cwd: repo, maxCostUsd: -1 })).rejects.toThrow(/invalid spending limit/);
		await expect(h.quizzes.get("../x")).rejects.toThrow();
		expect(await h.quizzes.list(repo)).toEqual([]);
	});

	it("quizzes a working tree against the default branch, and says the conversation was missing when it is", async () => {
		await git(repo, "checkout", "-q", "main");
		await fs.appendFile(path.join(repo, "src/store.ts"), "export const LIMIT = 10;\n");
		try {
			const h = harness("run7", {
				file: {
					parts: [
						{
							part: 1,
							questions: [
								{
									kind: "open",
									prompt: "What is LIMIT?",
									refs: ["src/store.ts@9@LIMIT"],
									rubric: { points: ["a constant"] },
								},
							],
						},
					],
				},
			});
			const { id } = await h.quizzes.create({
				cwd: repo,
				ref: "@worktree",
				base: "@default",
				sessionId: "01a12fa5-0000-7000-8000-000000000000",
			});
			await h.quizzes.idle();
			const { quiz } = await h.quizzes.get(id);
			expect(quiz.parts[0]!.title).toBe("What the session changed");
			expect(quiz.sessionId).toBeUndefined();
			expect(quiz.warnings.join(" ")).toContain("could not be read");
			expect(quiz.questions[0]!.refs[0]).toMatchObject({ path: "src/store.ts", token: "LIMIT" });
			expect(h.launches[0]!.prompt).toContain("export const LIMIT = 10;");
			expect(await git(repo, "status", "--porcelain")).toContain("store.ts");
		} finally {
			await git(repo, "checkout", "-q", "src/store.ts");
			await git(repo, "checkout", "-q", "feature/typestate");
		}
	});
});

describe("a quiz on a stack of pull requests", () => {
	it("makes one part per pull request in the order given, each showing only its own changes", async () => {
		const origin = path.join(tmp, "origin.git");
		const stackRepo = path.join(tmp, "stack");
		await fs.mkdir(stackRepo, { recursive: true });
		await git(tmp, "init", "-q", "--bare", "-b", "main", origin);
		await git(stackRepo, "init", "-q", "-b", "main");
		await git(stackRepo, "remote", "add", "origin", origin);
		await fs.writeFile(path.join(stackRepo, "base.ts"), "export const BASE = 0;\n");
		await git(stackRepo, "add", "-A");
		await git(stackRepo, "commit", "-q", "-m", "init");
		await git(stackRepo, "push", "-q", "origin", "main");
		for (const n of [1, 2]) {
			await git(stackRepo, "checkout", "-q", "-b", `pr${n}`);
			await fs.writeFile(path.join(stackRepo, `p${n}.ts`), `export const P${n} = ${n};\n`);
			await git(stackRepo, "add", "-A");
			await git(stackRepo, "commit", "-q", "-m", `Part ${n}`);
			await git(stackRepo, "push", "-q", "origin", `pr${n}`);
			await git(origin, "update-ref", `refs/pull/${n}/head`, await git(stackRepo, "rev-parse", "HEAD"));
		}
		await git(stackRepo, "checkout", "-q", "main");
		const prs: Record<number, StackPr> = {
			1: { number: 1, title: "First part", head: "pr1", base: "main", body: "Stack 1/2" },
			2: { number: 2, title: "Second part", head: "pr2", base: "pr1", body: "Stack 2/2" },
		};
		const source: PrSource = {
			view: async n => (Object.hasOwn(prs, n) ? prs[n]! : null),
			byHead: async () => [],
			byBase: async () => [],
		};
		const file = {
			parts: [
				{
					part: 1,
					questions: [{ kind: "open", prompt: "Why P1?", refs: ["p1.ts@1@P1"], rubric: { points: ["a"] } }],
				},
				{
					part: 2,
					questions: [{ kind: "open", prompt: "Why P2?", refs: ["p2.ts@1@P2"], rubric: { points: ["b"] } }],
				},
			],
		};
		const h = harness("stack1", { file, prSource: () => source });
		const { id } = await h.quizzes.create({ cwd: stackRepo, stack: [1, 2] });
		await h.quizzes.idle();
		const { quiz } = await h.quizzes.get(id);
		expect(quiz.title).toBe("stack · PRs #1–#2");
		expect(quiz.parts.map(p => [p.index, p.title, p.pr?.number, p.pr?.head, p.pr?.base])).toEqual([
			[0, "#1 First part", 1, "pr1", "main"],
			[1, "#2 Second part", 2, "pr2", "pr1"],
		]);
		// Part two is measured against part one's head, not against main.
		expect(quiz.parts[1]!.base!.commit).toBe(quiz.parts[0]!.head.commit);
		expect(quiz.questions.map(q => [q.id, q.part])).toEqual([
			["q1", 0],
			["q2", 1],
		]);
		const prompt = h.launches[0]!.prompt;
		const partTwo = prompt.slice(prompt.indexOf("## Part 2:"));
		expect(partTwo).toContain("### p2.ts (added)");
		expect(partTwo).not.toContain("### p1.ts");
		expect(prompt.slice(0, prompt.indexOf("## Part 2:"))).toContain("### p1.ts (added)");
		expect(prompt).toContain("Stack 2/2");
		expect(prompt).toContain("of one stack, bottom first");
		// The checkout the agent works in is the top of the stack.
		expect(h.launches[0]!.cwd).toContain("Quiz · stack @ PRs #1–#2");
		const { stack, source: how } = await h.quizzes.stack(stackRepo, 2);
		expect(how).toBe("none");
		expect(stack.map(p => p.number)).toEqual([2]);
		await h.quizzes.remove(id);
		expect(await git(stackRepo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});
});
