import { describe, expect, it } from "bun:test";
import type { Quiz, QuizAttempt, QuizQuestion, QuizStackPr, QuizSummary, QuizVerdict } from "@oh-my-pi/pi-wire/quiz";
import { QUIZ_MAX_ANSWER_CHARS, QUIZ_VERSION, scoreAttempt } from "@oh-my-pi/pi-wire/quiz";
import {
	answerKeyAction,
	attemptQuestions,
	buildCreate,
	canSubmit,
	currentFirst,
	firstUnanswered,
	groupByRepo,
	landingOf,
	nextQuestion,
	offeredStack,
	parseLimit,
	parsePrNumber,
	partTitle,
	positionOf,
	progressOf,
	rowStatus,
	scoreBand,
	stackLabel,
	subjectOf,
	plainText,
	summaryOf,
} from "../src/components/quiz/quiz-flow";

function question(id: string, part: number, extra: Partial<QuizQuestion> = {}): QuizQuestion {
	return {
		id,
		part,
		kind: "open",
		prompt: `Prompt ${id}`,
		topic: `Topic ${id}`,
		refs: [{ path: "src/a.rs", line: 1, token: "a" }],
		...extra,
	};
}

function quizOf(questions: QuizQuestion[], titles = ["Alpha", "Beta"]): Quiz {
	return {
		v: QUIZ_VERSION,
		id: "qz",
		title: "repo · PRs",
		repo: { root: "/work/repo", name: "repo" },
		createdAt: 1,
		parts: titles.map((title, index) => ({
			index,
			title,
			pr: { number: 10 + index },
			head: { commit: "abc" },
		})),
		questions,
		warnings: [],
	};
}

function verdict(kind: QuizVerdict["kind"]): QuizVerdict {
	return { kind, explanation: "why", graded: "model" };
}

function attemptOf(
	quiz: Quiz,
	ids: string[],
	answered: Record<string, QuizVerdict["kind"]>,
	over: Partial<QuizAttempt> = {},
): QuizAttempt {
	const attempt: QuizAttempt = {
		id: "a1",
		startedAt: 100,
		questions: ids,
		answers: Object.fromEntries(
			Object.entries(answered).map(([id, kind]) => [id, { text: "x", verdict: verdict(kind), at: 200 }]),
		),
		score: { points: 0, total: 0, percent: 0, byPart: [], revisit: [] },
		...over,
	};
	attempt.score = scoreAttempt(quiz.questions, attempt);
	return attempt;
}

const questions = [question("q1", 0), question("q2", 0), question("q3", 1), question("q4", 1)];
const quiz = quizOf(questions);

describe("attemptQuestions and resuming", () => {
	it("asks part by part, keeping the attempt's order inside a part, and skips unknown ids", () => {
		const attempt = attemptOf(quiz, ["q4", "q2", "ghost", "q1", "q3"], {});
		expect(attemptQuestions(quiz, attempt).map(item => item.id)).toEqual(["q2", "q1", "q4", "q3"]);
	});

	it("finds the first unanswered question, or -1 when all are answered", () => {
		const ids = ["q1", "q2", "q3", "q4"];
		const some = attemptOf(quiz, ids, { q1: "right", q3: "wrong" });
		expect(firstUnanswered(attemptQuestions(quiz, some), some)).toBe(1);
		const all = attemptOf(quiz, ids, { q1: "right", q2: "right", q3: "wrong", q4: "partly" });
		expect(firstUnanswered(attemptQuestions(quiz, all), all)).toBe(-1);
		expect(nextQuestion(attemptQuestions(quiz, all), all)).toBeNull();
		expect(nextQuestion(attemptQuestions(quiz, some), some)?.id).toBe("q2");
	});

	it("lands on the first unanswered question of an unfinished latest attempt, so a reload keeps your place", () => {
		const half = attemptOf(quiz, ["q1", "q2", "q3", "q4"], { q1: "right", q2: "partly" });
		expect(landingOf(quiz, [half])).toEqual({ kind: "question", attempt: "a1", question: "q3" });
	});

	it("lands on the results of a finished attempt, and of the latest attempt among several", () => {
		const ids = ["q1", "q2", "q3", "q4"];
		const done = attemptOf(quiz, ids, { q1: "right", q2: "right", q3: "right", q4: "right" }, { finishedAt: 300 });
		const again = attemptOf(quiz, ids, { q1: "right" }, { id: "a2", startedAt: 400 });
		expect(landingOf(quiz, [done])).toEqual({ kind: "summary", attempt: "a1" });
		expect(landingOf(quiz, [done, again])).toEqual({ kind: "question", attempt: "a2", question: "q2" });
		expect(landingOf(quiz, [])).toBeNull();
	});

	it("counts progress over the attempt's own questions", () => {
		const retry = attemptOf(quiz, ["q2", "q4"], { q2: "right" });
		const asked = attemptQuestions(quiz, retry);
		expect(progressOf(asked, retry)).toEqual({ answered: 1, total: 2, fraction: 0.5 });
		expect(progressOf([], retry).fraction).toBe(0);
	});
});

describe("positions and titles", () => {
	it("numbers parts among those the attempt asks about, and questions among its questions", () => {
		const retry = attemptOf(quiz, ["q3", "q4"], {});
		const asked = attemptQuestions(quiz, retry);
		expect(positionOf(asked, 0)).toEqual({ part: 1, partCount: 1, question: 1, questionCount: 2 });
		const full = attemptQuestions(quiz, attemptOf(quiz, ["q1", "q2", "q3", "q4"], {}));
		expect(positionOf(full, 2)).toEqual({ part: 2, partCount: 2, question: 3, questionCount: 4 });
	});

	it("names a part by its pull request title, or by what the session changed", () => {
		expect(partTitle(quiz, 1)).toBe("#11 Beta");
		const session: Quiz = { ...quiz, parts: [{ index: 0, title: "", head: { commit: "x" } }] };
		expect(partTitle(session, 0)).toBe("What the session changed");
		expect(partTitle(session, 5)).toBe("What the session changed");
	});
});

describe("summaryOf", () => {
	const ids = ["q1", "q2", "q3", "q4"];
	const attempt = attemptOf(quiz, ids, { q1: "right", q2: "partly", q3: "wrong", q4: "wrong" }, { finishedAt: 300 });
	const summary = summaryOf(quiz, attempt);

	it("takes the score the companion computed and names each part", () => {
		expect(summary.points).toBe(1.5);
		expect(summary.total).toBe(4);
		expect(summary.percent).toBe(38);
		expect(summary.parts).toEqual([
			{ part: 0, title: "#10 Alpha", points: 1.5, total: 2, percent: 75 },
			{ part: 1, title: "#11 Beta", points: 0, total: 2, percent: 0 },
		]);
		expect(summary.missed).toBe(3);
	});

	it("links each topic to the numbered questions it covers, the most points lost first", () => {
		expect(summary.topics.map(topic => topic.topic)).toEqual(["Topic q3", "Topic q4", "Topic q2"]);
		const first = summary.topics[0]!;
		expect(first.partTitle).toBe("#11 Beta");
		expect(first.questions).toEqual([{ id: "q3", number: 3, prompt: "Prompt q3", kind: "wrong" }]);
		expect(summary.topics[2]!.questions[0]).toMatchObject({ id: "q2", number: 2, kind: "partly" });
	});

	it("lists every question in order with its verdict, null when unanswered", () => {
		const half = summaryOf(quiz, attemptOf(quiz, ids, { q1: "right" }));
		expect(half.questions.map(item => [item.number, item.kind])).toEqual([
			[1, "right"],
			[2, null],
			[3, null],
			[4, null],
		]);
		expect(half.missed).toBe(0);
		expect(half.topics).toEqual([]);
	});

	it("says a few words for a score", () => {
		expect(scoreBand(95)).toContain("well");
		expect(scoreBand(75)).toContain("solid");
		expect(scoreBand(50)).toContain("landed");
		expect(scoreBand(10)).toContain("another look");
	});
});

describe("the history", () => {
	const row = (over: Partial<QuizSummary>): QuizSummary => ({
		id: "x",
		title: "t",
		repoRoot: "/work/a",
		subject: "PR #1",
		createdAt: 1,
		status: "ready",
		...over,
	});

	it("says how each quiz stands", () => {
		expect(rowStatus(row({ status: "running" }))).toEqual({ kind: "generating", text: "Generating…" });
		expect(rowStatus(row({ status: "failed" }))).toEqual({ kind: "failed", text: "Failed" });
		expect(rowStatus(row({}))).toEqual({ kind: "new", text: "Not started" });
		expect(rowStatus(row({ latest: { points: 3, total: 7, percent: 43, finished: false, at: 1 } }))).toEqual({
			kind: "progress",
			text: "In progress",
		});
		expect(rowStatus(row({ latest: { points: 5.5, total: 7, percent: 79, finished: true, at: 1 } }))).toEqual({
			kind: "score",
			text: "5.5/7 · 79%",
			percent: 79,
		});
	});

	it("groups by repository, newest quiz first within a group and the newest group first", () => {
		const groups = groupByRepo([
			row({ id: "1", repoRoot: "/work/a", createdAt: 10 }),
			row({ id: "2", repoRoot: "/work/b/", createdAt: 30 }),
			row({ id: "3", repoRoot: "/work/a", createdAt: 20 }),
		]);
		expect(groups.map(group => [group.name, group.quizzes.map(item => item.id)])).toEqual([
			["b", ["2"]],
			["a", ["3", "1"]],
		]);
	});
});

describe("the new-quiz form", () => {
	const stack: QuizStackPr[] = [
		{ number: 1, title: "one", head: "h1", base: "main" },
		{ number: 2, title: "two", head: "h2", base: "h1" },
		{ number: 3, title: "three", head: "h3", base: "h2" },
	];
	const base = {
		cwd: "/work/repo",
		sessionId: "session-1",
		useConversation: true,
		stack: [] as QuizStackPr[],
		scope: "stack" as const,
		limit: "1",
		model: "",
	};

	it("quizzes the session's changes from the worktree against the default branch, with the conversation when asked", () => {
		expect(buildCreate({ ...base, subject: { kind: "changes" } })).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, ref: "@worktree", base: "@default", sessionId: "session-1" },
		});
		const quiet = buildCreate({ ...base, subject: { kind: "changes" }, useConversation: false, model: " a/b " });
		expect(quiet).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, ref: "@worktree", base: "@default", model: "a/b" },
		});
		const none = buildCreate({ ...base, subject: { kind: "changes" }, sessionId: null });
		expect("request" in none && none.request.sessionId).toBeUndefined();
	});

	it("asks for the whole stack in order, or only the pull request", () => {
		const subject = { kind: "pr" as const, number: 2, title: "two" };
		expect(buildCreate({ ...base, subject, stack })).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, stack: [1, 2, 3] },
		});
		expect(buildCreate({ ...base, subject, stack, scope: "single" })).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, pr: 2 },
		});
		expect(buildCreate({ ...base, subject })).toEqual({ request: { cwd: "/work/repo", maxCostUsd: 1, pr: 2 } });
	});

	it("quizzes a branch against the default branch, without the session's conversation", () => {
		expect(buildCreate({ ...base, subject: { kind: "branch", name: " feature/x " } })).toEqual({
			request: { cwd: "/work/repo", maxCostUsd: 1, ref: "feature/x", base: "@default" },
		});
		expect(buildCreate({ ...base, subject: { kind: "branch", name: " " } })).toHaveProperty("error");
	});

	it("reads a typed pull request number and lists the checked-out branch first", () => {
		expect(parsePrNumber(" #482 ")).toBe(482);
		expect(parsePrNumber("482")).toBe(482);
		for (const text of ["", "0", "-3", "4a", "1.5", "#"]) expect(parsePrNumber(text)).toBeNull();
		expect(currentFirst(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
		expect(currentFirst(["a", "b"], "z")).toEqual(["a", "b"]);
		expect(currentFirst(["a", "b"], undefined)).toEqual(["a", "b"]);
	});

	it("refuses a missing repository and a limit that is not an amount", () => {
		const subject = { kind: "changes" as const };
		expect(buildCreate({ ...base, subject, cwd: "" })).toHaveProperty("error");
		for (const limit of ["", "0", "-1", "abc"])
			expect(buildCreate({ ...base, subject, limit })).toHaveProperty("error");
		expect(parseLimit(" 2.5 ")).toBe(2.5);
		expect(parseLimit("0")).toBeNull();
	});

	it("offers a stack only when it has several pull requests and holds this one", () => {
		expect(offeredStack(stack, 2)).toHaveLength(3);
		expect(offeredStack(stack.slice(0, 1), 1)).toEqual([]);
		expect(offeredStack(stack, 9)).toEqual([]);
		expect(stackLabel(stack)).toBe("#1–#3");
		expect(stackLabel(stack.slice(0, 1))).toBe("#1");
		expect(stackLabel([])).toBe("");
	});

	it("offers another quiz of a pull request quiz's pull request, or of the changes", () => {
		expect(subjectOf(quiz)).toEqual({ kind: "pr", number: 10, title: "Alpha" });
		expect(
			subjectOf({ ...quiz, parts: [{ index: 0, title: "What the session changed", head: { commit: "x" } }] }),
		).toEqual({
			kind: "changes",
		});
	});
});

describe("the answer box", () => {
	const key = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, composing: false, touch: false };

	it("submits on Enter and breaks the line on Shift+Enter", () => {
		expect(answerKeyAction(key)).toBe("submit");
		expect(answerKeyAction({ ...key, shiftKey: true })).toBe("newline");
	});

	it("leaves Enter to a touch keyboard's newline and to an input method's composition", () => {
		expect(answerKeyAction({ ...key, touch: true })).toBe("newline");
		expect(answerKeyAction({ ...key, composing: true })).toBe("newline");
		expect(answerKeyAction({ ...key, key: "a" })).toBe("newline");
	});

	it("submits on Ctrl or Cmd with Enter anywhere", () => {
		expect(answerKeyAction({ ...key, ctrlKey: true, touch: true })).toBe("submit");
		expect(answerKeyAction({ ...key, metaKey: true, shiftKey: true })).toBe("submit");
	});

	it("can submit an open answer with text within the limit, and a choice that exists", () => {
		const open = question("o", 0);
		expect(canSubmit(open, undefined)).toBe(false);
		expect(canSubmit(open, { text: "   " })).toBe(false);
		expect(canSubmit(open, { text: "an answer" })).toBe(true);
		expect(canSubmit(open, { text: "x".repeat(QUIZ_MAX_ANSWER_CHARS + 1) })).toBe(false);
		const pick = question("c", 0, {
			kind: "choice",
			choices: [
				{ id: "a", text: "A" },
				{ id: "b", text: "B" },
			],
		});
		expect(canSubmit(pick, { choice: "b" })).toBe(true);
		expect(canSubmit(pick, { choice: "z" })).toBe(false);
		expect(canSubmit(pick, {})).toBe(false);
	});
});

describe("plainText", () => {
	it("turns a question's Markdown into one line of words", () => {
		expect(
			plainText("`e3-core` listed `e3-data` as a **dev-dependency**.\n\nWhy _would_ it [matter](https://x.y)?"),
		).toBe("e3-core listed e3-data as a dev-dependency. Why would it matter?");
	});

	it("keeps the code of a fence and leaves identifiers with underscores alone", () => {
		expect(plainText("Read this:\n```rust\nlet snake_case_name = 1;\n```\nWhat is `snake_case_name`?")).toBe(
			"Read this: let snake_case_name = 1; What is snake_case_name?",
		);
		expect(plainText("- first\n- second")).toBe("first second");
	});

	it("shows the summary's rows without Markdown", () => {
		const own = quizOf([question("q1", 0, { prompt: "Why does `S` **matter**?" })], ["Alpha"]);
		const attempt = attemptOf(own, ["q1"], { q1: "right" }, { finishedAt: 300 });
		expect(summaryOf(own, attempt).questions[0]?.prompt).toBe("Why does S matter?");
	});
});
