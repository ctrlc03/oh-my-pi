/**
 * "Quiz me": questions that test whether you understood a set of code changes (a branch, a pull request, a
 * stack of pull requests, or what an agent session just changed), written by a read-only agent on the computer
 * and graded there. Every question cites the code it is about as `path@line@token` (the same citation as an
 * architecture map, {@link BlueprintRef}); the companion checks each citation against the commit before the quiz
 * is stored and drops a question whose citations all fail.
 *
 * A quiz has one {@link QuizPart} per pull request of a stack (or one part for a single change), and 3–5
 * conceptual questions per part: why a dependency caused something, what a type change does, which message
 * starts a flow. Most are `open` (answered in your own words, graded by a small model call against a hidden
 * rubric); some are `choice` (graded on the spot, no model).
 *
 * What the client never receives until a question is answered: the rubric of an open question and the right
 * answer of a choice question. They come back with the {@link QuizVerdict}.
 *
 * Shared by the companion (which generates, grades and stores quizzes) and the web app (which asks the
 * questions). Pure JSON shapes, plus the scoring rules both sides use.
 */

import type { BlueprintCommit, BlueprintExcerpt, BlueprintRef } from "./blueprint";

/** Format version of the stored quiz. */
export const QUIZ_VERSION = 1;
/** Parts of one quiz: a stack longer than this is refused. */
export const QUIZ_MAX_PARTS = 8;
/** Characters of a free-text answer the companion accepts. */
export const QUIZ_MAX_ANSWER_CHARS = 4_000;
/** Spend limit of a quiz when the request names none, USD: generation and all grading together. */
export const QUIZ_DEFAULT_MAX_COST_USD = 1;
/** Points a verdict earns. */
export const QUIZ_POINTS = { right: 1, partly: 0.5, wrong: 0 } as const;

/** Code a question is about; verified like an architecture map's citation. `side: "base"` cites the code a change removed. */
export type QuizRef = BlueprintRef;

export type QuizQuestionKind = "open" | "choice";

export interface QuizChoice {
	/** `a`, `b`, `c`… */
	id: string;
	text: string;
}

/** One pull request of a stack, or the one change a quiz is about. */
export interface QuizPart {
	/** Position in {@link Quiz.parts}, from 0. */
	index: number;
	/** The pull request's title, or the branch / "What the session changed". */
	title: string;
	/** Set when the part is a pull request. */
	pr?: { number: number; url?: string; head?: string; base?: string };
	/** Commit the questions of this part cite (side `head`). */
	head: BlueprintCommit;
	/** What `head` is compared with: citations of removed code (side `base`) read it. */
	base?: BlueprintCommit;
}

export interface QuizQuestion {
	/** `q1`, `q2`… unique within the quiz. */
	id: string;
	/** Index into {@link Quiz.parts}. */
	part: number;
	kind: QuizQuestionKind;
	prompt: string;
	/** One short paragraph recalling the idea the question is about, shown with the question. */
	reminder?: string;
	/** Short name of what the question tests ("Dev-dependency cycles"): what the summary tells you to revisit. */
	topic: string;
	/** Verified citations: the code to show with the question, the first one is the main one. At least one. */
	refs: QuizRef[];
	/** The options of a `choice` question, in the order to show them. */
	choices?: QuizChoice[];
}

/** The quiz as the client sees it: no rubric and no right answers. */
export interface Quiz {
	v: typeof QUIZ_VERSION;
	id: string;
	/** Display name, e.g. "interfold · PR #2243–#2248" or "interfold @ feature/x vs main". */
	title: string;
	repo: { root: string; name: string; github?: string };
	createdAt: number;
	/** `provider/model` that wrote the questions. */
	model?: string;
	/** The omp session whose conversation the questions were written from, when one was given and could be read. */
	sessionId?: string;
	parts: QuizPart[];
	questions: QuizQuestion[];
	/** Everything the build fixed, dropped or skipped, in plain words. */
	warnings: string[];
}

export type QuizVerdictKind = "right" | "partly" | "wrong";

/** The result of one answer. */
export interface QuizVerdict {
	kind: QuizVerdictKind;
	/** What is right, what is missing, with code. 2–6 sentences of markdown for a model-graded answer; one or two for a choice. */
	explanation: string;
	/** Code the explanation points at, verified. */
	refs?: QuizRef[];
	/** Choice questions: the id of the right choice. */
	answer?: string;
	/** Open questions: the points a full answer makes (the hidden rubric, shown once the question is answered). */
	keyPoints?: string[];
	/** `local` for a choice question, `model` for an open one. */
	graded: "local" | "model";
}

export interface QuizAnswerRecord {
	/** Open questions: the answer as written. */
	text?: string;
	/** Choice questions: the id of the choice picked. */
	choice?: string;
	verdict: QuizVerdict;
	at: number;
}

/** A topic to revisit: the questions about it that were not fully right. */
export interface QuizTopic {
	topic: string;
	part: number;
	/** Question ids, in quiz order. */
	questions: string[];
}

export interface QuizPartScore {
	part: number;
	points: number;
	total: number;
}

export interface QuizScore {
	points: number;
	/** Questions the attempt asks. */
	total: number;
	/** `points / total` as a whole percent (0 when there is no question). */
	percent: number;
	byPart: QuizPartScore[];
	/** Topics of questions answered partly or wrong, the most points lost first. */
	revisit: QuizTopic[];
}

/** One run through a quiz (or through the questions of an earlier run that were missed). */
export interface QuizAttempt {
	/** `a1`, `a2`… unique within the quiz. */
	id: string;
	startedAt: number;
	/** Set once every question of the attempt is answered. */
	finishedAt?: number;
	/** Question ids this attempt asks, in order. */
	questions: string[];
	/** Answers by question id. */
	answers: Record<string, QuizAnswerRecord>;
	/** The attempt this one retries. */
	retryOf?: string;
	/** Recomputed by the companion on every answer, so it is always current. */
	score: QuizScore;
}

/** One row of the quiz list. */
export interface QuizSummary {
	id: string;
	title: string;
	repoRoot: string;
	/** What was quizzed, for the list: `feature/x vs main`, `PR #12`, `PRs #12–#16`, `worktree vs main`. */
	subject: string;
	createdAt: number;
	status: "running" | "ready" | "failed";
	/** While running: the step in plain words. */
	progress?: string;
	/** When failed. */
	error?: string;
	/** The omp session writing the questions, while running. */
	instanceId?: string;
	partCount?: number;
	questionCount?: number;
	attemptCount?: number;
	/** Score of the latest attempt, with whether it is finished. */
	latest?: { points: number; total: number; percent: number; finished: boolean; at: number };
	/** Spent so far (generation and grading), USD. */
	costUsd?: number;
	/** The limit this quiz was made with, USD. */
	maxCostUsd?: number;
	sessionId?: string;
}

/** What to quiz. */
export interface QuizCreate {
	/** Any folder inside the repository. */
	cwd: string;
	/**
	 * Branch, tag, commit, or `@worktree` (the folder's current files, uncommitted changes included, snapshotted without
	 * touching the checkout). Omitted: the checked-out HEAD. Ignored when `pr` or `stack` is given.
	 */
	ref?: string;
	/** Compare with this ref, or `@default` (the merge base with the default branch). Omitted: `@default`. */
	base?: string;
	/** A pull request number: one part. */
	pr?: number;
	/** Pull request numbers in stack order (bottom first): one part each, at most {@link QUIZ_MAX_PARTS}. Wins over `pr`. */
	stack?: number[];
	/** An omp session whose conversation the questions may draw on, to ask why things were done. */
	sessionId?: string;
	/** Spend limit for the quiz, generation and grading together, USD. */
	maxCostUsd?: number;
	model?: string;
}

/** A pull request of a detected stack. */
export interface QuizStackPr {
	number: number;
	title: string;
	/** Head branch. */
	head: string;
	/** Base branch. */
	base: string;
	url?: string;
}

/**
 * Companion requests (sent in the companion room like the other `t`-tagged requests, answered by `reqId`).
 * The companion advertises `canQuiz` in its hello when it supports them.
 *
 * - `quiz-list` `{ cwd? }` → `{ quizzes: QuizSummary[] }` (all repositories when `cwd` is omitted)
 * - `quiz-create` `QuizCreate` → `{ id }` (the quiz appears in the list as `running`)
 * - `quiz-get` `{ id }` → `{ quiz: Quiz, attempts: QuizAttempt[] }`; a new quiz has one empty attempt
 * - `quiz-answer` `{ id, attempt, question, text? | choice? }` → `{ verdict, attempt }`: a choice is graded at once,
 *   an open answer by a small model call that counts against the quiz's spend limit; the answer is stored and the
 *   attempt (with its score) returned. An answered question cannot be answered again in the same attempt.
 * - `quiz-retry` `{ id, from?, only? }` → `{ attempt }`: a new attempt asking every question (`only: "all"`, the
 *   default) or the ones `from` (default: the latest attempt) did not answer right (`only: "missed"`)
 * - `quiz-excerpt` `{ id, part, refs }` → `{ excerpts }` (same order; read from git at that part's commit)
 * - `quiz-delete` `{ id }` → `{}` (stops it first when running)
 * - `quiz-stack` `{ cwd, pr }` → `{ stack, source }`: the pull requests stacked with `pr`, bottom first, `pr` included
 *   (`source` says how it was found; a PR that is not part of a stack answers a one-element list with `"none"`)
 *
 * The companion pushes `{ t: "quiz-changed", id }` when a quiz's summary changes (progress, done, failed, answered).
 */
export type QuizRequest =
	| { t: "quiz-list"; reqId: number; cwd?: string }
	| ({ t: "quiz-create"; reqId: number } & QuizCreate)
	| { t: "quiz-get"; reqId: number; id: string }
	| { t: "quiz-answer"; reqId: number; id: string; attempt: string; question: string; text?: string; choice?: string }
	| { t: "quiz-retry"; reqId: number; id: string; from?: string; only?: "all" | "missed" }
	| { t: "quiz-excerpt"; reqId: number; id: string; part: number; refs: BlueprintRef[] }
	| { t: "quiz-delete"; reqId: number; id: string }
	| { t: "quiz-stack"; reqId: number; cwd: string; pr: number };

export type QuizStackSource = "branches" | "body" | "none";

export interface QuizGetAnswer {
	quiz: Quiz;
	attempts: QuizAttempt[];
}

export type QuizExcerpt = BlueprintExcerpt;

/** Points one verdict earns. */
export function verdictPoints(kind: QuizVerdictKind): number {
	return QUIZ_POINTS[kind];
}

/**
 * The score of an attempt: points over the questions it asks (an unanswered one counts for nothing), per part, and
 * the topics to revisit: questions answered partly or wrong, grouped by topic within a part, the most points lost first.
 */
export function scoreAttempt(
	questions: readonly Pick<QuizQuestion, "id" | "part" | "topic">[],
	attempt: Pick<QuizAttempt, "questions" | "answers">,
): QuizScore {
	const byId = new Map(questions.map(question => [question.id, question]));
	const parts = new Map<number, QuizPartScore>();
	const topics = new Map<string, QuizTopic & { lost: number; first: number }>();
	let points = 0;
	let total = 0;
	attempt.questions.forEach((id, order) => {
		const question = byId.get(id);
		if (question === undefined) return;
		total++;
		const part = parts.get(question.part) ?? { part: question.part, points: 0, total: 0 };
		part.total++;
		parts.set(question.part, part);
		const answer = Object.hasOwn(attempt.answers, id) ? attempt.answers[id] : undefined;
		if (answer === undefined) return;
		const earned = verdictPoints(answer.verdict.kind);
		points += earned;
		part.points += earned;
		if (answer.verdict.kind === "right") return;
		const key = `${question.part}\0${question.topic}`;
		const topic = topics.get(key) ?? {
			topic: question.topic,
			part: question.part,
			questions: [],
			lost: 0,
			first: order,
		};
		topic.questions.push(id);
		topic.lost += 1 - earned;
		topics.set(key, topic);
	});
	const revisit = [...topics.values()]
		.sort((a, b) => b.lost - a.lost || a.first - b.first)
		.map(({ topic, part, questions: ids }) => ({ topic, part, questions: ids }));
	return {
		points,
		total,
		percent: total === 0 ? 0 : Math.round((points / total) * 100),
		byPart: [...parts.values()].sort((a, b) => a.part - b.part),
		revisit,
	};
}
