import { describe, expect, it } from "bun:test";
import type { Quiz, QuizQuestion, QuizSummary } from "@oh-my-pi/pi-wire/quiz";
import type { CompanionReply, CompanionRequest } from "../src/lib/companion";
import { TOPIC_CWD, TOPIC_SESSION_ID, topicEntries } from "../scripts/fixture-topic";
import { createMockQuiz, MOCK_QUIZ_ROOT, mockTopicSpecs } from "../scripts/mock-quiz";

const REPO_FOLDER = "/work/api-pagination";
const NO_CODE = "Implementation questions need code, and this folder has none.";

function setup() {
	const waiting: (() => void)[] = [];
	const mock = createMockQuiz({
		instanceId: "inst-7",
		stageMs: 2,
		gradeMs: 0,
		onChanged: () => {
			for (const wake of waiting.splice(0)) wake();
		},
	});
	let reqId = 0;
	const ask = <T extends CompanionReply["t"]>(request: Record<string, unknown> & { t: string }, _expect?: T) =>
		mock.answer({ ...request, reqId: ++reqId } as unknown as CompanionRequest) as Promise<
			Extract<CompanionReply, { t: T }>
		>;
	/** The list row of a quiz once it is ready: woken by the mock's pushes, so nothing waits on a clock. */
	const settled = async (id: string): Promise<QuizSummary> => {
		for (;;) {
			const next = new Promise<void>(resolve => waiting.push(resolve));
			const row = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(item => item.id === id);
			if (row?.status === "failed") throw new Error(row.error);
			if (row?.status === "ready") return row;
			await next;
		}
	};
	/** A topic quiz of the folder, written and read back. */
	const topic = async (cwd: string, focus?: string) => {
		const { id } = await ask(
			{ t: "quiz-create", cwd, subject: "session", sessionId: TOPIC_SESSION_ID, ...(focus ? { focus } : {}) },
			"quiz-create",
		);
		const row = await settled(id);
		const got = await ask({ t: "quiz-get", id }, "quiz-get");
		return { id, row, quiz: got.quiz, attempt: got.attempts[0]! };
	};
	return { mock, ask, topic, settled };
}

const isBackground = (question: QuizQuestion): boolean => question.background === true;
const isSession = (question: QuizQuestion): boolean => (question.session ?? []).length > 0;
const isFile = (question: QuizQuestion): boolean => question.refs.length > 0;

describe("the mock quiz companion's topic quizzes", () => {
	it("advertises the topic capability and answers quiz-folder per folder", async () => {
		const { mock, ask } = setup();
		expect(mock.capabilities.canQuizTopic).toBe(true);
		expect(mock.handles({ t: "quiz-folder", reqId: 1, cwd: TOPIC_CWD })).toBe(true);
		const scratch = (await ask({ t: "quiz-folder", cwd: TOPIC_CWD }, "quiz-folder")).folder;
		expect(scratch).toMatchObject({ git: false, code: false, name: "Scratch · fhe statistics" });
		expect(scratch.files).toBeGreaterThan(0);
		const repo = (await ask({ t: "quiz-folder", cwd: REPO_FOLDER }, "quiz-folder")).folder;
		expect(repo).toMatchObject({ git: true, code: true, name: "interfold" });
		expect(repo.files).toBeGreaterThan(scratch.files);
		mock.stop();
	});

	it("lists the seeded topic quiz with its folder only, with the words of a topic quiz", async () => {
		const { mock, ask } = setup();
		const here = (await ask({ t: "quiz-list", cwd: TOPIC_CWD }, "quiz-list")).quizzes;
		expect(here.map(row => row.id)).toEqual(["qz-topic"]);
		expect(here[0]).toMatchObject({
			subject: "Session topic · Understanding",
			about: "session",
			focus: "understanding",
			sessionId: TOPIC_SESSION_ID,
			repoRoot: TOPIC_CWD,
		});
		const repoRows = (await ask({ t: "quiz-list", cwd: REPO_FOLDER }, "quiz-list")).quizzes;
		expect(repoRows.some(row => row.id === "qz-topic")).toBe(false);
		expect(repoRows.every(row => row.repoRoot === MOCK_QUIZ_ROOT)).toBe(true);
		const got = await ask({ t: "quiz-get", id: "qz-topic" }, "quiz-get");
		expect(got.attempts[0]!.questions.filter(id => Object.hasOwn(got.attempts[0]!.answers, id))).toEqual(["q1"]);
		mock.stop();
	});

	it("writes a mixed quiz by default, with the three kinds of citation, for a folder that is no git repository", async () => {
		const { mock, topic } = setup();
		const { quiz, row, attempt } = await topic(TOPIC_CWD);
		expect(quiz).toMatchObject({ about: "session", focus: "mixed", sessionId: TOPIC_SESSION_ID });
		expect(quiz.repo.root).toBe(TOPIC_CWD);
		expect(quiz.parts).toHaveLength(1);
		expect(quiz.parts[0]).toMatchObject({ head: { commit: "folder" } });
		expect(quiz.parts[0]!.base).toBeUndefined();
		expect(row).toMatchObject({
			about: "session",
			focus: "mixed",
			subject: "Session topic · Mixed",
			repoRoot: TOPIC_CWD,
		});
		expect(attempt.questions).toEqual(quiz.questions.map(question => question.id));
		expect(quiz.questions.some(isBackground)).toBe(true);
		expect(quiz.questions.some(isSession)).toBe(true);
		expect(quiz.questions.some(question => isFile(question) && !isBackground(question))).toBe(true);
		// Background questions have no citation at all; no question is left without one, unless it is background.
		for (const question of quiz.questions) {
			if (isBackground(question)) {
				expect(question.refs).toEqual([]);
				expect(question.session).toBeUndefined();
			} else {
				expect(isFile(question) || isSession(question)).toBe(true);
			}
		}
		// The folder has no code: the questions cite its notes only.
		const paths = new Set(quiz.questions.flatMap(question => question.refs.map(ref => ref.path)));
		expect([...paths]).toEqual(["notes/design.md"]);
		mock.stop();
	});

	it("writes a mixed quiz that also asks about the code of a folder that has some", async () => {
		const { mock, topic } = setup();
		const { quiz, row } = await topic(REPO_FOLDER, "mixed");
		expect(row.repoRoot).toBe(MOCK_QUIZ_ROOT);
		expect(quiz.parts[0]!.head.commit).not.toBe("folder");
		const paths = new Set(quiz.questions.flatMap(question => question.refs.map(ref => ref.path)));
		expect(paths).toEqual(new Set(["notes/design.md", "src/stats.py"]));
		expect(quiz.questions.some(isBackground)).toBe(true);
		expect(quiz.questions.some(isSession)).toBe(true);
		mock.stop();
	});

	it("leans each focus its own way", async () => {
		const { mock, topic } = setup();
		const understanding = (await topic(TOPIC_CWD, "understanding")).quiz;
		expect(understanding.focus).toBe("understanding");
		expect(understanding.questions.filter(isBackground).length).toBeGreaterThanOrEqual(2);
		expect(understanding.questions.filter(isBackground).length).toBeGreaterThanOrEqual(
			understanding.questions.length / 2,
		);

		const design = (await topic(TOPIC_CWD, "design")).quiz;
		expect(design.focus).toBe("design");
		expect(design.questions.some(isBackground)).toBe(false);
		expect(design.questions.some(isSession)).toBe(true);
		expect(design.questions.every(question => isSession(question) || isFile(question))).toBe(true);

		const implementation = (await topic(REPO_FOLDER, "implementation")).quiz;
		expect(implementation.focus).toBe("implementation");
		expect(implementation.questions.length).toBeGreaterThan(0);
		for (const question of implementation.questions) {
			expect(isBackground(question)).toBe(false);
			expect(question.session).toBeUndefined();
			expect(question.refs.length).toBeGreaterThan(0);
			expect(question.refs.every(ref => ref.path === "src/stats.py")).toBe(true);
		}
		mock.stop();
	});

	it("refuses the implementation focus for a folder without code, and a topic quiz without a session", async () => {
		const { mock, ask } = setup();
		await expect(
			ask({
				t: "quiz-create",
				cwd: TOPIC_CWD,
				subject: "session",
				sessionId: TOPIC_SESSION_ID,
				focus: "implementation",
			}),
		).rejects.toThrow(NO_CODE);
		await expect(ask({ t: "quiz-create", cwd: TOPIC_CWD, subject: "session" })).rejects.toThrow("needs the session");
		await expect(
			ask({ t: "quiz-create", cwd: REPO_FOLDER, subject: "session", sessionId: "s", focus: "cooking" }),
		).rejects.toThrow("Unknown focus");
		mock.stop();
	});

	it("cites real messages of the mock session, with their author and a passage that is in them", async () => {
		const { mock, topic } = setup();
		const entries = new Map(topicEntries().map(entry => [entry.id, entry]));
		const { quiz } = await topic(TOPIC_CWD);
		const citations = quiz.questions.flatMap(question => question.session ?? []);
		expect(citations.length).toBeGreaterThan(0);
		for (const cite of citations) {
			const entry = entries.get(cite.entry);
			expect(entry).toBeDefined();
			if (entry?.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant"))
				throw new Error(`${cite.entry} is not a user or assistant message`);
			expect(entry.message.role).toBe(cite.role);
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content.map(block => ("text" in block ? block.text : "")).join("\n");
			expect(text.replace(/\s+/g, " ")).toContain(cite.quote);
		}
		// Both authors are cited.
		expect(new Set(citations.map(cite => cite.role))).toEqual(new Set(["user", "assistant"]));
		mock.stop();
	});

	it("reads a topic quiz's file citations through quiz-excerpt, from the stored folder files", async () => {
		const { mock, ask, topic } = setup();
		for (const [cwd, focus] of [
			[TOPIC_CWD, "mixed"],
			[REPO_FOLDER, "implementation"],
		] as const) {
			const { id, quiz } = await topic(cwd, focus);
			const refs = quiz.questions.flatMap(question => question.refs);
			expect(refs.length).toBeGreaterThan(0);
			const { excerpts } = await ask({ t: "quiz-excerpt", id, part: 0, refs }, "quiz-excerpt");
			excerpts.forEach((excerpt, at) => {
				const ref = refs[at]!;
				expect(excerpt).not.toBeNull();
				expect(excerpt!.lines[ref.line - excerpt!.start]).toContain(ref.token);
			});
		}
		const { excerpts } = await ask(
			{
				t: "quiz-excerpt",
				id: "qz-topic",
				part: 0,
				refs: [{ path: "src/stats.py", line: 5, token: "ts" }],
			},
			"quiz-excerpt",
		);
		expect(excerpts[0]?.language).toBe("python");
		mock.stop();
	});

	it("explains a background question in its verdict, without a citation", async () => {
		const { mock, ask, topic } = setup();
		const { id, quiz, attempt } = await topic(TOPIC_CWD, "understanding");
		const specs = mockTopicSpecs();
		const send = (question: string, given: { text?: string; choice?: string }) =>
			ask({ t: "quiz-answer", id, attempt: attempt.id, question, ...given }, "quiz-answer");

		const choice = quiz.questions.find(question => isBackground(question) && question.kind === "choice")!;
		const choiceSecret = specs.find(spec => spec.question.prompt === choice.prompt)!.secret;
		if (choiceSecret.kind !== "choice") throw new Error("a background choice question has a choice key");
		const wrong = choice.choices!.find(item => item.id !== choiceSecret.answer)!;
		const missed = await send(choice.id, { choice: wrong.id });
		expect(missed.verdict).toMatchObject({ kind: "wrong", answer: choiceSecret.answer, graded: "local" });
		expect(missed.verdict.explanation.length).toBeGreaterThan(40);
		expect(missed.verdict.refs ?? []).toEqual([]);

		const open = quiz.questions.find(question => isBackground(question) && question.kind === "open")!;
		const found = await send(open.id, {
			text: "The error is tiny, like floating point rounding. It is not fine where a result must be exact, such as a ledger, and it grows with the depth.",
		});
		expect(found.verdict).toMatchObject({ kind: "right", graded: "model" });
		expect(found.verdict.explanation.length).toBeGreaterThan(40);
		expect(found.verdict.keyPoints?.length).toBeGreaterThan(0);
		expect(found.verdict.refs ?? []).toEqual([]);
		const none = await ask({ t: "quiz-retry", id, only: "all" }, "quiz-retry");
		const lost = await ask(
			{ t: "quiz-answer", id, attempt: none.attempt.id, question: open.id, text: "I do not know" },
			"quiz-answer",
		);
		expect(lost.verdict.kind).toBe("wrong");
		expect(lost.verdict.explanation).toContain("That misses the idea.");
		mock.stop();
	});

	it("still loads and writes quizzes on changes, which take a focus and say nothing of a topic", async () => {
		const { mock, ask, settled } = setup();
		const old = await ask({ t: "quiz-get", id: "qz-stack" }, "quiz-get");
		const oldQuiz: Quiz = old.quiz;
		expect(oldQuiz.about).toBeUndefined();
		expect(oldQuiz.focus).toBeUndefined();
		expect(oldQuiz.questions).toHaveLength(7);
		expect(oldQuiz.questions.every(question => question.refs.length > 0 && !isBackground(question))).toBe(true);
		const row = (await ask({ t: "quiz-list" }, "quiz-list")).quizzes.find(item => item.id === "qz-stack")!;
		expect(row.about).toBeUndefined();
		expect(row.focus).toBeUndefined();

		const created = await ask({ t: "quiz-create", cwd: REPO_FOLDER, pr: 2243, focus: "design" }, "quiz-create");
		const made = await settled(created.id);
		expect(made).toMatchObject({ status: "ready", subject: "PR #2243", focus: "design" });
		expect(made.about).toBeUndefined();
		const got = await ask({ t: "quiz-get", id: created.id }, "quiz-get");
		expect(got.quiz.about).toBeUndefined();
		expect(got.quiz.focus).toBe("design");
		expect(got.quiz.parts).toHaveLength(1);
		mock.stop();
	});
});
