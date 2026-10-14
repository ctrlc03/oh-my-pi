import { describe, expect, it } from "bun:test";
import { scoreAttempt } from "@oh-my-pi/pi-wire/quiz";
import { splitLines } from "../scripts/companion-excerpt";
import { parseQuizOutput, type QuizVerifyIo, verifyQuiz } from "../scripts/companion-quiz-verify";

const FILES: Record<string, string> = {
	"0:head:src/a.ts": "export function a() {}\nexport const KEY = 1;\n",
	"1:head:src/b.ts": "export function b() {}\n",
	"1:base:src/b.ts": "export function oldB() {}\n",
};

const io: QuizVerifyIo = {
	lines: async (part, side, path) => {
		const text = Object.hasOwn(FILES, `${part}:${side}:${path}`) ? FILES[`${part}:${side}:${path}`] : undefined;
		return text === undefined ? null : splitLines(text);
	},
};

const open = (over: Record<string, unknown> = {}) => ({
	kind: "open",
	topic: "A topic",
	prompt: "Why?",
	reminder: "Remember.",
	refs: ["src/a.ts@1@function a"],
	rubric: { points: ["says why"], misconceptions: ["says how"] },
	...over,
});

describe("parseQuizOutput", () => {
	it("reads parts numbered from 1, or a flat list, and strips what it does not know", () => {
		const warnings: string[] = [];
		const nested = parseQuizOutput(
			{
				parts: [{ part: 1, questions: [open({ extra: "ignored" })] }, { questions: [open({ prompt: "Second?" })] }],
			},
			2,
			warnings,
		);
		expect(nested.map(q => [q.part, q.prompt])).toEqual([
			[0, "Why?"],
			[1, "Second?"],
		]);
		expect(nested[0]).not.toHaveProperty("extra");
		const flat = parseQuizOutput({ questions: [{ ...open(), part: 2 }] }, 2, warnings);
		expect(flat[0]!.part).toBe(1);
		expect(warnings).toEqual([]);
	});

	it("accepts a choice's answer as a letter, an index or the text, and rejects one without a clear right answer", () => {
		const warnings: string[] = [];
		const choice = (answer: unknown, choices: unknown = ["x", "y", "z"]) => ({
			kind: "choice",
			prompt: `Pick ${String(answer)}`,
			refs: ["src/a.ts@1@a"],
			choices,
			answer,
			explanation: "Because.",
		});
		const parsed = parseQuizOutput(
			{
				parts: [
					{
						part: 1,
						questions: [
							choice("b"),
							choice(2),
							choice("1"),
							choice("z"),
							choice("q"),
							choice("a", ["only one"]),
							choice(7),
						],
					},
				],
			},
			1,
			warnings,
		);
		expect(parsed.map(q => q.answer)).toEqual([1, 2, 1, 2]);
		expect(warnings.join(" ")).toContain("needs 2–5 choices and a clear right one");
	});

	it("skips open questions without a rubric, questions for a part that does not exist, and a runaway part", () => {
		const warnings: string[] = [];
		const many = Array.from({ length: 12 }, (_, i) => open({ prompt: `Q${i}?` }));
		const parsed = parseQuizOutput(
			{
				parts: [
					{ part: 1, questions: [open({ rubric: undefined }), ...many] },
					{ part: 5, questions: [open()] },
				],
			},
			1,
			warnings,
		);
		expect(parsed).toHaveLength(8);
		expect(warnings.join(" ")).toContain("no rubric");
		expect(warnings.join(" ")).toContain("the quiz has no such part");
		expect(warnings.join(" ")).toContain("more than 8 questions");
	});

	it("rejects output that is not a quiz", () => {
		expect(() => parseQuizOutput([], 1, [])).toThrow(/not a JSON object/);
		expect(() => parseQuizOutput({ parts: [] }, 1, [])).toThrow(/no questions/);
		expect(() => parseQuizOutput({ parts: [{ part: 1, questions: [{ kind: "open" }] }] }, 1, [])).toThrow(/None of/);
	});
});

describe("verifyQuiz", () => {
	it("checks each citation against the commit of its own part, drops what does not hold, and numbers the rest in part order", async () => {
		const warnings: string[] = [];
		const parsed = parseQuizOutput(
			{
				parts: [
					{
						part: 2,
						questions: [
							open({ prompt: "From part two?", refs: ["src/b.ts@1@function b"] }),
							// Removed code is cited on the base side of its own part.
							open({ prompt: "Removed in part two?", refs: ["base:src/b.ts@1@oldB"] }),
							// src/a.ts does not exist at part two's commit.
							open({ prompt: "Wrong part?", refs: ["src/a.ts@1@function a"] }),
						],
					},
					{
						part: 1,
						questions: [
							// Cited at line 9: moved to line 2, the only place the token occurs.
							open({ prompt: "Moved?", refs: ["src/a.ts@9@KEY"] }),
							open({ prompt: "Not there?", refs: ["src/a.ts@1@nothing_like_this"] }),
							open({ prompt: "No citation?", refs: [] }),
						],
					},
				],
			},
			2,
			warnings,
		);
		const result = await verifyQuiz(parsed, io, "qz-1");
		expect(result.questions.map(q => [q.id, q.part, q.prompt])).toEqual([
			["q1", 0, "Moved?"],
			["q2", 1, "From part two?"],
			["q3", 1, "Removed in part two?"],
		]);
		expect(result.questions[0]!.refs).toEqual([{ path: "src/a.ts", line: 2, token: "KEY" }]);
		expect(result.questions[2]!.refs[0]).toMatchObject({ path: "src/b.ts", side: "base", token: "oldB" });
		expect(result.stats).toMatchObject({ moved: 1, questionsDropped: 3 });
		expect(result.warnings.join(" ")).toContain("it cites no code");
		expect(result.warnings.join(" ")).toContain("none of its citations held");
		expect(Object.keys(result.keys)).toEqual(["q1", "q2", "q3"]);
		expect(result.keys.q1!.rubric!.points).toEqual(["says why"]);
	});

	it("shuffles choices the same way for the same quiz, keeps the right one's key in step, and never puts the key in the question", async () => {
		const raw = {
			parts: [
				{
					part: 1,
					questions: Array.from({ length: 12 }, (_, i) => ({
						kind: "choice",
						prompt: `Q${i}?`,
						refs: ["src/a.ts@1@function a"],
						choices: ["right", "w1", "w2", "w3"],
						answer: "a",
						explanation: "Because.",
					})),
				},
			],
		};
		const first = await verifyQuiz(parseQuizOutput(raw, 1, []), io, "qz-seed");
		const again = await verifyQuiz(parseQuizOutput(raw, 1, []), io, "qz-seed");
		const other = await verifyQuiz(parseQuizOutput(raw, 1, []), io, "qz-other");
		expect(JSON.stringify(first.questions)).toBe(JSON.stringify(again.questions));
		expect(JSON.stringify(first.questions)).not.toBe(JSON.stringify(other.questions));
		for (const question of first.questions) {
			const key = first.keys[question.id]!;
			expect(question.choices!.find(c => c.id === key.answer)!.text).toBe("right");
			expect(question.choices!.map(c => c.id)).toEqual(["a", "b", "c", "d"]);
			expect(JSON.stringify(question)).not.toContain("explanation");
		}
		// Not always first: the right choice moves around.
		expect(new Set(first.questions.map(q => first.keys[q.id]!.answer)).size).toBeGreaterThan(1);
	});
});

describe("the score of an attempt", () => {
	const questions = [
		{ id: "q1", part: 0, topic: "Typestate" },
		{ id: "q2", part: 0, topic: "Typestate" },
		{ id: "q3", part: 1, topic: "Build order" },
		{ id: "q4", part: 1, topic: "Direction" },
	];
	const answer = (kind: "right" | "partly" | "wrong") => ({
		verdict: { kind, explanation: "", graded: "local" as const },
		at: 1,
	});

	it("counts 1, 0.5 and 0 points, leaves unanswered questions out of the points, and lists the topics to revisit by points lost", () => {
		const score = scoreAttempt(questions, {
			questions: ["q1", "q2", "q3", "q4"],
			answers: { q1: answer("right"), q2: answer("partly"), q3: answer("wrong") },
		});
		expect(score).toMatchObject({ points: 1.5, total: 4, percent: 38 });
		expect(score.byPart).toEqual([
			{ part: 0, points: 1.5, total: 2 },
			{ part: 1, points: 0, total: 2 },
		]);
		expect(score.revisit).toEqual([
			{ topic: "Build order", part: 1, questions: ["q3"] },
			{ topic: "Typestate", part: 0, questions: ["q2"] },
		]);
	});

	it("scores a retry of the missed questions over only the questions it asks", () => {
		const score = scoreAttempt(questions, { questions: ["q3"], answers: { q3: answer("right") } });
		expect(score).toMatchObject({ points: 1, total: 1, percent: 100, revisit: [] });
	});
});
