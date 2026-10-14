import { describe, expect, it } from "bun:test";
import type { Quiz, QuizAttempt, QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { createMockQuiz, gradeAnswer, MOCK_QUIZ_ROOT, mockQuestionSpecs } from "../scripts/mock-quiz";

function setup() {
	const pushed: string[] = [];
	const mock = createMockQuiz({ instanceId: "inst-7", stageMs: 5, gradeMs: 0, onChanged: id => pushed.push(id) });
	let reqId = 0;
	const ask = <T extends CompanionReply["t"]>(request: Record<string, unknown> & { t: string }, _expect?: T) =>
		mock.answer({ ...request, reqId: ++reqId } as unknown as CompanionRequest) as Promise<
			Extract<CompanionReply, { t: T }>
		>;
	return { mock, pushed, ask };
}

async function until(done: () => boolean): Promise<void> {
	for (let n = 0; n < 200 && !done(); n++) await Bun.sleep(5);
	expect(done()).toBe(true);
}

describe("the mock quiz companion", () => {
	it("advertises quizzes and answers only quiz requests", () => {
		const { mock } = setup();
		expect(mock.capabilities).toEqual({ canQuiz: true });
		expect(mock.handles({ t: "quiz-list", reqId: 1 })).toBe(true);
		expect(mock.handles({ t: "blueprint-list", reqId: 1 })).toBe(false);
		mock.stop();
	});

	it("lists a finished two-part quiz, a half answered one, a failed one, and other repositories only without a folder", async () => {
		const { mock, ask } = setup();
		const all = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes;
		const byId = new Map(all.map(row => [row.id, row]));
		expect(byId.get("qz-stack")).toMatchObject({ status: "ready", partCount: 2, subject: "PRs #2243–#2244" });
		expect(byId.get("qz-stack")?.latest?.finished).toBe(true);
		expect(byId.get("qz-session")?.latest?.finished).toBe(false);
		expect(byId.get("qz-failed")?.status).toBe("failed");
		expect(byId.has("qz-other")).toBe(true);
		const here = (await ask({ t: "quiz-list", cwd: "/work/api-pagination" }, "quiz-list")).quizzes;
		expect(here.every(row => row.repoRoot === MOCK_QUIZ_ROOT)).toBe(true);
		expect(here.some(row => row.id === "qz-other")).toBe(false);
		mock.stop();
	});

	it("keeps rubrics and right answers out of quiz-get", async () => {
		const { mock, ask } = setup();
		const got = await ask({ t: "quiz-get", id: "qz-stack" }, "quiz-get");
		expect(got.quiz.questions).toHaveLength(7);
		expect(got.quiz.parts.map(part => part.title)).toEqual([
			"refactor(event-system): the event runtime gets its own crate",
			"refactor(evm): move the provider cache",
		]);
		for (const question of got.quiz.questions) {
			expect(Object.keys(question)).not.toContain("answer");
			expect(Object.keys(question)).not.toContain("rubric");
			expect(question.refs.length).toBeGreaterThan(0);
		}
		const fresh = await ask({ t: "quiz-retry", id: "qz-stack", only: "all" }, "quiz-retry");
		const again = await ask({ t: "quiz-get", id: "qz-stack" }, "quiz-get");
		const empty = again.attempts.find(attempt => attempt.id === fresh.attempt.id)!;
		expect(empty.answers).toEqual({});
		expect(JSON.stringify(empty)).not.toContain("explanation");
		// The quiz itself never carries a verdict, a key point or an explanation.
		const text = JSON.stringify(got.quiz);
		for (const word of ["explanation", "keyPoints", "keywords", "verdict"]) expect(text).not.toContain(word);
		mock.stop();
	});

	it("mixes open and choice questions", () => {
		const specs = mockQuestionSpecs();
		expect(specs.some(spec => spec.question.kind === "open")).toBe(true);
		expect(specs.some(spec => spec.question.kind === "choice")).toBe(true);
	});

	it("grades a choice by the key and an open answer by the rubric's keywords", async () => {
		const { mock, ask } = setup();
		const fresh = (await ask({ t: "quiz-retry", id: "qz-stack", only: "all" }, "quiz-retry")).attempt;
		const send = (question: string, given: { text?: string; choice?: string }) =>
			ask({ t: "quiz-answer", id: "qz-stack", attempt: fresh.id, question, ...given }, "quiz-answer");
		const right = await send("q2", { choice: "b" });
		expect(right.verdict).toMatchObject({ kind: "right", graded: "local", answer: "b" });
		const wrong = await send("q4", { choice: "a" });
		expect(wrong.verdict).toMatchObject({ kind: "wrong", answer: "c" });
		const full = await send("q1", {
			text: "It is built twice, the two copies have a different type, so move helpers to a leaf crate.",
		});
		expect(full.verdict.kind).toBe("right");
		expect(full.verdict.graded).toBe("model");
		expect(full.verdict.keyPoints).toHaveLength(3);
		expect(full.verdict.explanation).toContain("```");
		const part = await send("q3", { text: "Memory would grow forever." });
		expect(part.verdict.kind).toBe("partly");
		expect(part.verdict.explanation).toContain("What is missing");
		const none = await send("q5", { text: "No idea" });
		expect(none.verdict.kind).toBe("wrong");
		expect(none.attempt.score.points).toBe(1 + 0 + 1 + 0.5 + 0);
		expect(none.attempt.score.total).toBe(7);
		mock.stop();
	});

	it("refuses to answer a question twice, and fails grading once on '/fail'", async () => {
		const { mock, ask } = setup();
		const fresh = (await ask({ t: "quiz-retry", id: "qz-stack", only: "all" }, "quiz-retry")).attempt;
		const base = { t: "quiz-answer", id: "qz-stack", attempt: fresh.id, question: "q1" };
		await expect(ask({ ...base, text: "/fail" })).rejects.toThrow("Grading failed");
		const second = await ask({ ...base, text: "/fail" }, "quiz-answer");
		expect(second.verdict.kind).toBe("wrong");
		await expect(ask({ ...base, text: "again" })).rejects.toThrow("already answered");
		await expect(ask({ ...base, question: "q3", text: "/limit" })).rejects.toThrow("spending limit");
		await expect(ask({ ...base, question: "q2", choice: "zz" })).rejects.toThrow("Pick one");
		mock.stop();
	});

	it("finishes an attempt when its last question is answered, and says so in the list", async () => {
		const { mock, pushed, ask } = setup();
		const resumed = (await ask({ t: "quiz-get", id: "qz-session" }, "quiz-get")).attempts[0]!;
		const open = resumed.questions.filter(id => !Object.hasOwn(resumed.answers, id));
		expect(open).toEqual(["q3"]);
		expect(resumed.finishedAt).toBeUndefined();
		const done = await ask(
			{
				t: "quiz-answer",
				id: "qz-session",
				attempt: resumed.id,
				question: "q3",
				text: "Every call did a new handshake",
			},
			"quiz-answer",
		);
		expect(done.attempt.finishedAt).toBeDefined();
		expect(pushed).toContain("qz-session");
		const row = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(item => item.id === "qz-session")!;
		expect(row.latest?.finished).toBe(true);
		expect(row.costUsd).toBeGreaterThan(0.41);
		mock.stop();
	});

	it("retries only what was missed, from the latest attempt by default", async () => {
		const { mock, ask } = setup();
		const missed = (await ask({ t: "quiz-retry", id: "qz-stack", only: "missed" }, "quiz-retry")).attempt;
		expect(missed.questions).toEqual(["q1", "q3", "q7"]);
		expect(missed.retryOf).toBe("a1");
		expect(missed.score.total).toBe(3);
		const all = (await ask({ t: "quiz-retry", id: "qz-stack", only: "all", from: "a1" }, "quiz-retry")).attempt;
		expect(all.questions).toHaveLength(7);
		await expect(ask({ t: "quiz-retry", id: "qz-stack", only: "missed", from: "a1" })).resolves.toBeDefined();
		const perfect = (await ask({ t: "quiz-get", id: "qz-other" }, "quiz-get")).attempts[0]!;
		expect(perfect.questions).toHaveLength(3);
		mock.stop();
	});

	it("reads every citation of every question and verdict from the embedded repository", async () => {
		const { mock, ask } = setup();
		const got = await ask({ t: "quiz-get", id: "qz-stack" }, "quiz-get");
		for (const question of got.quiz.questions) {
			const { excerpts } = await ask(
				{ t: "quiz-excerpt", id: "qz-stack", part: question.part, refs: question.refs },
				"quiz-excerpt",
			);
			excerpts.forEach((excerpt, at) => {
				const ref = question.refs[at]!;
				expect(excerpt).not.toBeNull();
				expect(excerpt!.side).toBe(ref.side ?? "head");
				expect(excerpt!.lines[ref.line - excerpt!.start]).toContain(ref.token);
			});
		}
		const answered = got.attempts[0]!.answers;
		for (const [id, record] of Object.entries(answered)) {
			const part = got.quiz.questions.find(question => question.id === id)!.part;
			const { excerpts } = await ask(
				{ t: "quiz-excerpt", id: "qz-stack", part, refs: record.verdict.refs ?? [] },
				"quiz-excerpt",
			);
			expect(excerpts.every(excerpt => excerpt !== null)).toBe(true);
		}
		await expect(ask({ t: "quiz-excerpt", id: "qz-stack", part: 9, refs: [] })).rejects.toThrow("no part 9");
		mock.stop();
	});

	it("shows base citations as removed code", async () => {
		const { mock, ask } = setup();
		const got = await ask({ t: "quiz-get", id: "qz-stack" }, "quiz-get");
		const refs = got.quiz.questions.flatMap(question => question.refs.filter(ref => ref.side === "base"));
		expect(refs.length).toBeGreaterThan(0);
		const { excerpts } = await ask(
			{ t: "quiz-excerpt", id: "qz-stack", part: 0, refs: refs.slice(0, 1) },
			"quiz-excerpt",
		);
		expect(excerpts[0]?.side).toBe("base");
		expect(excerpts[0]?.lines.join("\n")).toContain("e3-data");
		mock.stop();
	});

	it("finds a stack of three for the fixture's pull requests and a lone pull request otherwise", async () => {
		const { mock, ask } = setup();
		for (const pr of [2243, 2244, 2245]) {
			const found = await ask({ t: "quiz-stack", cwd: "/work/x", pr }, "quiz-stack");
			expect(found.stack.map(item => item.number)).toEqual([2243, 2244, 2245]);
			expect(found.source).toBe("branches");
		}
		const alone = await ask({ t: "quiz-stack", cwd: "/work/x", pr: 2246 }, "quiz-stack");
		expect(alone.stack.map(item => item.number)).toEqual([2246]);
		expect(alone.source).toBe("none");
		mock.stop();
	});

	it("writes a quiz that turns ready after its stages, one part per pull request of the stack, and pushes each step", async () => {
		const { mock, pushed, ask } = setup();
		const created = await ask(
			{ t: "quiz-create", cwd: "/work/x", stack: [2243, 2244, 2245], sessionId: "s1", maxCostUsd: 2 },
			"quiz-create",
		);
		const listed = async (): Promise<QuizSummary> =>
			(await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(item => item.id === created.id)!;
		const first = await listed();
		expect(first).toMatchObject({
			status: "running",
			instanceId: "inst-7",
			subject: "PRs #2243–#2245",
			maxCostUsd: 2,
		});
		expect(first.progress).toBeDefined();
		await expect(ask({ t: "quiz-get", id: created.id })).rejects.toThrow("not ready");
		await until(() => pushed.filter(id => id === created.id).length >= 5);
		let row = await listed();
		for (let n = 0; n < 100 && row.status === "running"; n++) {
			await Bun.sleep(5);
			row = await listed();
		}
		expect(row.status).toBe("ready");
		expect(row.instanceId).toBeUndefined();
		const got = await ask({ t: "quiz-get", id: created.id }, "quiz-get");
		const quiz: Quiz = got.quiz;
		const attempts: QuizAttempt[] = got.attempts;
		expect(quiz.parts).toHaveLength(3);
		expect(quiz.questions).toHaveLength(10);
		expect(attempts).toHaveLength(1);
		expect(attempts[0]!.questions).toHaveLength(10);
		mock.stop();
	});

	it("fails a quiz asked for with the model mock/fail, and deletes quizzes", async () => {
		const { mock, pushed, ask } = setup();
		const created = await ask({ t: "quiz-create", cwd: "/work/x", pr: 2246, model: "mock/fail" }, "quiz-create");
		await until(() => pushed.length >= 2);
		let row: QuizSummary | undefined;
		for (let n = 0; n < 100 && row?.status !== "failed"; n++) {
			await Bun.sleep(5);
			row = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(item => item.id === created.id);
		}
		expect(row?.status).toBe("failed");
		expect(row?.error).toBeDefined();
		await ask({ t: "quiz-delete", id: created.id }, "quiz-delete");
		expect((await ask({ t: "quiz-list" }, "quiz-list")).quizzes.some(item => item.id === created.id)).toBe(false);
		mock.stop();
	});
});

describe("gradeAnswer", () => {
	const [first] = mockQuestionSpecs();
	it("is right with two thirds of the points, partly with a third, wrong with none", () => {
		const secret = first!.secret;
		if (secret.kind !== "open") throw new Error("the first fixture question is open");
		const [a, b, c] = secret.points.map(point => point.keywords[0]!);
		expect(gradeAnswer(secret, { text: `${a} ${b}` }).kind).toBe("right");
		expect(gradeAnswer(secret, { text: `${a}` }).kind).toBe("partly");
		expect(gradeAnswer(secret, { text: "nothing relevant" }).kind).toBe("wrong");
		expect(gradeAnswer(secret, { text: `${a} ${b} ${c}` }).keyPoints).toHaveLength(3);
	});
});
