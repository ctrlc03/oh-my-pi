/**
 * What the quiz screens decide, with no React: which question comes next and where a reload resumes, the order of
 * questions across parts, progress, the summary and the topics' links back to their questions, the rows of the
 * history, how the form turns into a request, and what Enter does in the answer box.
 */

import type {
	Quiz,
	QuizAttempt,
	QuizCreate,
	QuizPart,
	QuizQuestion,
	QuizStackPr,
	QuizSummary,
	QuizVerdictKind,
} from "@oh-my-pi/pi-wire/quiz";
import { QUIZ_MAX_ANSWER_CHARS } from "@oh-my-pi/pi-wire/quiz";
import { quizPassed, type QuizStakes } from "@oh-my-pi/pi-wire/stakes";

/** Title of the one part of a quiz about a session's own changes when the quiz does not name it. */
const CHANGES_TITLE = "What the session changed";

/** The answer recorded for a question of an attempt, if it was answered. */
export function answerOf(attempt: QuizAttempt, id: string): QuizAttempt["answers"][string] | undefined {
	return Object.hasOwn(attempt.answers, id) ? attempt.answers[id] : undefined;
}

/**
 * The questions an attempt asks, in the order to ask them: part by part (the order of the quiz's parts), and within a
 * part in the attempt's own order. Ids the quiz does not have are skipped.
 */
export function attemptQuestions(quiz: Quiz, attempt: QuizAttempt): QuizQuestion[] {
	const byId = new Map(quiz.questions.map(question => [question.id, question]));
	return attempt.questions
		.flatMap((id, order) => {
			const question = byId.get(id);
			return question === undefined ? [] : [{ question, order }];
		})
		.sort((a, b) => a.question.part - b.question.part || a.order - b.order)
		.map(item => item.question);
}

/** Index of the first question of `questions` the attempt has no answer for; -1 when all are answered. */
export function firstUnanswered(questions: readonly QuizQuestion[], attempt: QuizAttempt): number {
	return questions.findIndex(question => answerOf(attempt, question.id) === undefined);
}

export interface Progress {
	answered: number;
	total: number;
	/** 0–1: the share of the attempt's questions answered. */
	fraction: number;
}

export function progressOf(questions: readonly QuizQuestion[], attempt: QuizAttempt): Progress {
	const answered = questions.filter(question => answerOf(attempt, question.id) !== undefined).length;
	return { answered, total: questions.length, fraction: questions.length === 0 ? 0 : answered / questions.length };
}

/** The part a question belongs to, or a stand-in when the quiz lacks it. */
export function partOf(quiz: Quiz, index: number): QuizPart | undefined {
	return quiz.parts.find(part => part.index === index);
}

/** What a part is called on screen: the pull request's title, or what the session changed. */
export function partTitle(quiz: Quiz, index: number): string {
	const part = partOf(quiz, index);
	if (part === undefined || part.title === "") return CHANGES_TITLE;
	return part.pr === undefined ? part.title : `#${part.pr.number} ${part.title}`;
}

export interface Position {
	/** 1-based among the parts the attempt asks about. */
	part: number;
	partCount: number;
	/** 1-based among the attempt's questions. */
	question: number;
	questionCount: number;
}

/** "Part i of n" and "Question k of m" for `questions[at]`: parts counted among those the attempt asks about. */
export function positionOf(questions: readonly QuizQuestion[], at: number): Position {
	const parts = [...new Set(questions.map(question => question.part))].sort((a, b) => a - b);
	const here = questions[at]?.part;
	return {
		part: here === undefined ? 0 : parts.indexOf(here) + 1,
		partCount: parts.length,
		question: at + 1,
		questionCount: questions.length,
	};
}

/** The attempt to open on: the latest by start time (ties: the later in the list). */
export function latestAttempt(attempts: readonly QuizAttempt[]): QuizAttempt | undefined {
	let latest: QuizAttempt | undefined;
	for (const attempt of attempts) if (latest === undefined || attempt.startedAt >= latest.startedAt) latest = attempt;
	return latest;
}

/** Where opening a quiz lands: the first unanswered question of an unfinished attempt (so a reload keeps your place), else the results. */
export type Landing = { kind: "question"; attempt: string; question: string } | { kind: "summary"; attempt: string };

export function landingOf(quiz: Quiz, attempts: readonly QuizAttempt[]): Landing | null {
	const attempt = latestAttempt(attempts);
	if (attempt === undefined) return null;
	const questions = attemptQuestions(quiz, attempt);
	const next = firstUnanswered(questions, attempt);
	// Finished (every question answered, or the companion says so): the results. An attempt that asks nothing has no results to show.
	if (attempt.finishedAt !== undefined || next === -1) return { kind: "summary", attempt: attempt.id };
	return { kind: "question", attempt: attempt.id, question: questions[next]!.id };
}

/** The question to go to after one is answered: the next unanswered one, or null when the attempt is done. */
export function nextQuestion(questions: readonly QuizQuestion[], attempt: QuizAttempt): QuizQuestion | null {
	const next = firstUnanswered(questions, attempt);
	return next === -1 ? null : questions[next]!;
}

/** Points as people write them: `7`, `6.5`. */
export function formatPoints(points: number): string {
	return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

export interface VerdictLook {
	label: string;
	/** The name of the colour class suffix; the icon and the label carry the meaning too. */
	tone: "right" | "partly" | "wrong";
}

export function verdictLook(kind: QuizVerdictKind): VerdictLook {
	switch (kind) {
		case "right":
			return { label: "Right", tone: "right" };
		case "partly":
			return { label: "Partly right", tone: "partly" };
		case "wrong":
			return { label: "Wrong", tone: "wrong" };
	}
}

/** A few words for a score. */
export function scoreBand(percent: number): string {
	if (percent >= 90) return "You know these changes well";
	if (percent >= 70) return "A solid grasp, with a few gaps";
	if (percent >= 40) return "Some of it landed";
	return "Worth another look at the changes";
}

export interface SummaryQuestion {
	id: string;
	/** 1-based among the attempt's questions. */
	number: number;
	prompt: string;
	kind: QuizVerdictKind | null;
}

export interface SummaryTopic {
	topic: string;
	part: number;
	partTitle: string;
	questions: SummaryQuestion[];
}

export interface SummaryPart {
	part: number;
	title: string;
	points: number;
	total: number;
	percent: number;
}

export interface SummaryModel {
	points: number;
	total: number;
	percent: number;
	band: string;
	parts: SummaryPart[];
	/** Topics to revisit, the most points lost first; each lists the questions to jump back to. */
	topics: SummaryTopic[];
	/** Every question of the attempt, in order, with its verdict. */
	questions: SummaryQuestion[];
	/** Questions answered partly or wrong: what "Retry wrong answers" asks again. */
	missed: number;
}

/** A question's Markdown as one line of plain words, for a row that cannot render it (code fences, links and emphasis dropped). */
export function plainText(markdown: string): string {
	return markdown
		.replace(/```[^\n]*\n([\s\S]*?)```/g, " $1 ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])([*_])(\S(?:[^*_]*\S)?)\2(?![\w*])/g, "$1$3")
		.replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The results screen's numbers, from the attempt the companion scored. */
export function summaryOf(quiz: Quiz, attempt: QuizAttempt): SummaryModel {
	const questions = attemptQuestions(quiz, attempt);
	const numbered = new Map<string, SummaryQuestion>(
		questions.map((question, at) => [
			question.id,
			{
				id: question.id,
				number: at + 1,
				prompt: plainText(question.prompt),
				kind: answerOf(attempt, question.id)?.verdict.kind ?? null,
			},
		]),
	);
	const { score } = attempt;
	return {
		points: score.points,
		total: score.total,
		percent: score.percent,
		band: scoreBand(score.percent),
		parts: score.byPart.map(item => ({
			part: item.part,
			title: partTitle(quiz, item.part),
			points: item.points,
			total: item.total,
			percent: item.total === 0 ? 0 : Math.round((item.points / item.total) * 100),
		})),
		topics: score.revisit.map(item => ({
			topic: item.topic,
			part: item.part,
			partTitle: partTitle(quiz, item.part),
			questions: item.questions.flatMap(id => {
				const question = numbered.get(id);
				return question === undefined ? [] : [question];
			}),
		})),
		questions: [...numbered.values()],
		missed: questions.filter(question => {
			const kind = answerOf(attempt, question.id)?.verdict.kind;
			return kind !== undefined && kind !== "right";
		}).length,
	};
}

/** What the results screen of a high-stakes quiz says about the push: passed, or why not yet. */
export interface StakesBanner {
	tone: "passed" | "failed";
	text: string;
}

/**
 * The banner of a stakes quiz's results, or null while the attempt is unfinished. The score is compared with
 * {@link quizPassed}, exactly, never from the rounded percent. Only an attempt at every question can pass, so a
 * shorter one says that instead of showing a score it cannot be judged by.
 */
export function stakesBannerOf(quiz: Quiz, attempt: QuizAttempt, stakes: QuizStakes): StakesBanner | null {
	const { points, total } = attempt.score;
	const finished = attempt.finishedAt !== undefined;
	const full = quiz.questions.every(question => attempt.questions.includes(question.id));
	const recorded = stakes.passedAttempt === attempt.id;
	const earned = finished && full && stakes.passedAttempt === undefined && quizPassed(points, total, stakes.passMark);
	// A pass the companion is still recording reads as a pass; one earned in another attempt still unlocks the push.
	if (recorded || earned) return { tone: "passed", text: "Passed — you can push now" };
	if (stakes.passedAttempt !== undefined) return { tone: "passed", text: "Passed earlier — you can push now" };
	if (!finished) return null;
	if (!full) return { tone: "failed", text: "Only an attempt at every question can pass" };
	return {
		tone: "failed",
		text: `Not passed: ${formatPoints(points)} of ${total} points, ${stakes.passMark}% needed`,
	};
}

/** Which attempts a quiz has had, newest first, for the results screen's history. */
export function attemptHistory(attempts: readonly QuizAttempt[]): QuizAttempt[] {
	return [...attempts].sort((a, b) => b.startedAt - a.startedAt);
}

export type RowStatus =
	| { kind: "generating"; text: string }
	| { kind: "failed"; text: string }
	| { kind: "progress"; text: string }
	| { kind: "score"; text: string; percent: number }
	| { kind: "new"; text: string };

/** What a row of the history says about a quiz: how it is being made, or where you stand. */
export function rowStatus(quiz: QuizSummary): RowStatus {
	if (quiz.status === "running") return { kind: "generating", text: "Generating…" };
	if (quiz.status === "failed") return { kind: "failed", text: "Failed" };
	const latest = quiz.latest;
	if (latest === undefined) return { kind: "new", text: "Not started" };
	if (!latest.finished) return { kind: "progress", text: "In progress" };
	return {
		kind: "score",
		text: `${formatPoints(latest.points)}/${latest.total} · ${latest.percent}%`,
		percent: latest.percent,
	};
}

/** The rows of the history grouped by repository (a folder name each), the groups ordered by their newest quiz. */
export function groupByRepo(
	quizzes: readonly QuizSummary[],
): { repoRoot: string; name: string; quizzes: QuizSummary[] }[] {
	const groups = new Map<string, QuizSummary[]>();
	for (const quiz of [...quizzes].sort((a, b) => b.createdAt - a.createdAt)) {
		const group = groups.get(quiz.repoRoot);
		if (group === undefined) groups.set(quiz.repoRoot, [quiz]);
		else group.push(quiz);
	}
	return [...groups].map(([repoRoot, items]) => ({ repoRoot, name: folderName(repoRoot), quizzes: items }));
}

/** `/a/b/repo` → `repo`. */
export function folderName(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Which pull requests a quiz covers, from its stack: `#1`, `#1–#3`. Empty for none. */
export function stackLabel(stack: readonly QuizStackPr[]): string {
	const first = stack[0];
	const last = stack[stack.length - 1];
	if (first === undefined || last === undefined) return "";
	return stack.length === 1 ? `#${first.number}` : `#${first.number}–#${last.number}`;
}

/** What the new-quiz form is about: the session's changes, a branch against the default branch, or one pull request (with its stack, when it has one). */
export type QuizSubject =
	| { kind: "changes" }
	| { kind: "branch"; name: string }
	| { kind: "pr"; number: number; title: string };

/** The subject to offer for another quiz like `quiz`: its pull request (any one of a stack finds the rest), else the changes. */
export function subjectOf(quiz: Quiz): QuizSubject {
	const part = quiz.parts.find(item => item.pr !== undefined);
	return part?.pr === undefined ? { kind: "changes" } : { kind: "pr", number: part.pr.number, title: part.title };
}

export interface QuizFormValues {
	/** Any folder of the repository. */
	cwd: string;
	subject: QuizSubject;
	/** The session whose conversation may be read; null: none to offer. */
	sessionId: string | null;
	/** The checkbox "Ask about why things were done". */
	useConversation: boolean;
	/** Pull requests of the stack in order, as the form lists them; empty: not looked up or none found. */
	stack: readonly QuizStackPr[];
	/** The radio: the whole stack, or only the pull request the form is about. */
	scope: "stack" | "single";
	/** The cost-limit field as typed. */
	limit: string;
	/** The model field as typed; empty: the companion's default. */
	model: string;
}

/** Parse the cost-limit field: a positive amount in dollars. */
export function parseLimit(text: string): number | null {
	const value = Number(text.trim());
	return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The request the form's values make, or what is wrong with them. */
export function buildCreate(values: QuizFormValues): { request: QuizCreate } | { error: string } {
	const maxCostUsd = parseLimit(values.limit);
	if (values.cwd === "") return { error: "There is no repository to quiz." };
	if (maxCostUsd === null) return { error: "The cost limit must be more than $0." };
	const request: QuizCreate = { cwd: values.cwd, maxCostUsd };
	const model = values.model.trim();
	if (model !== "") request.model = model;
	if (values.subject.kind === "changes") {
		request.ref = "@worktree";
		request.base = "@default";
		if (values.useConversation && values.sessionId !== null) request.sessionId = values.sessionId;
	} else if (values.subject.kind === "branch") {
		const name = values.subject.name.trim();
		if (name === "") return { error: "Pick a branch." };
		request.ref = name;
		request.base = "@default";
	} else if (values.scope === "stack" && values.stack.length > 1) {
		request.stack = values.stack.map(pr => pr.number);
	} else {
		request.pr = values.subject.number;
	}
	return { request };
}

/** A pull request number as typed (`482` or `#482`); null for anything else. */
export function parsePrNumber(text: string): number | null {
	const match = /^#?(\d+)$/.exec(text.trim());
	const value = match === null ? 0 : Number(match[1]);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The branches with the checked-out one first, the rest in the order given. */
export function currentFirst(branches: readonly string[], current: string | undefined): string[] {
	if (current === undefined || !branches.includes(current)) return [...branches];
	return [current, ...branches.filter(name => name !== current)];
}

/** The stack the form offers: more than one pull request, with the one asked about in it. */
export function offeredStack(stack: readonly QuizStackPr[], pr: number): QuizStackPr[] {
	return stack.length > 1 && stack.some(item => item.number === pr) ? [...stack] : [];
}

export interface AnswerKey {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	/** An input method is composing text: Enter confirms the composition. */
	composing: boolean;
	/** The primary input is a finger: the return key is a newline and the button is in reach. */
	touch: boolean;
}

/**
 * What a key does in the answer box, as in the message box: Enter submits and Shift+Enter breaks the line; on a
 * touch keyboard Enter only breaks the line; Ctrl or Cmd with Enter submits anywhere.
 */
export function answerKeyAction(event: AnswerKey): "submit" | "newline" {
	if (event.key !== "Enter" || event.composing) return "newline";
	if (event.ctrlKey || event.metaKey) return "submit";
	return event.shiftKey || event.touch ? "newline" : "submit";
}

/** Whether an answer can be sent: an open answer has text within the limit, a choice has a pick. */
export function canSubmit(question: QuizQuestion, draft: { text?: string; choice?: string } | undefined): boolean {
	if (draft === undefined) return false;
	if (question.kind === "choice") {
		return draft.choice !== undefined && (question.choices ?? []).some(choice => choice.id === draft.choice);
	}
	const text = draft.text ?? "";
	return text.trim() !== "" && text.length <= QUIZ_MAX_ANSWER_CHARS;
}
