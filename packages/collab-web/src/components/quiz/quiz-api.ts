import type { BlueprintExcerpt, BlueprintExcerptRef } from "@oh-my-pi/pi-wire/blueprint";
import type {
	QuizAttempt,
	QuizCreate,
	QuizGetAnswer,
	QuizStackPr,
	QuizStackSource,
	QuizSummary,
	QuizVerdict,
} from "@oh-my-pi/pi-wire/quiz";
import type { CompanionClient } from "../../lib/companion";

/** Listing and reading quizzes reads stored JSON. */
const QUIZ_TIMEOUT_MS = 60_000;
/** Starting a quiz answers as soon as it is listed as running. */
const CREATE_TIMEOUT_MS = 60_000;
/** A small model grades an open answer: the reply waits for it. */
const ANSWER_TIMEOUT_MS = 120_000;
/** Code around cited lines: a git read per cited file. */
const EXCERPT_TIMEOUT_MS = 90_000;
/** Finding a stack reads branches and, for pull requests, `gh`. */
const STACK_TIMEOUT_MS = 45_000;

/** Citations asked for in one `quiz-excerpt` request, so no single request holds the connection for long. */
export const QUIZ_EXCERPT_BATCH = 200;

/** Quizzes of the repository holding `cwd` (all repositories when omitted), newest first. */
export async function listQuizzes(client: CompanionClient, cwd?: string): Promise<QuizSummary[]> {
	return (await client.requestQuiz({ t: "quiz-list", cwd }, QUIZ_TIMEOUT_MS)).quizzes;
}

/** Start writing a quiz; resolves with its id as soon as it is listed as `running`. */
export async function createQuiz(client: CompanionClient, request: QuizCreate): Promise<string> {
	return (await client.requestQuiz({ t: "quiz-create", ...request }, CREATE_TIMEOUT_MS)).id;
}

/** The quiz without its answers, every attempt made at it, and, for a high-stakes quiz, what passing it unlocks. */
export async function getQuiz(client: CompanionClient, id: string): Promise<QuizGetAnswer> {
	const { quiz, attempts, stakes } = await client.requestQuiz({ t: "quiz-get", id }, QUIZ_TIMEOUT_MS);
	return { quiz, attempts, stakes };
}

/** What a person answered: free text for an open question, the id of a choice for a choice question. */
export type QuizGiven = { text: string } | { choice: string };

/** Answer one question of an attempt; resolves with the verdict and the attempt with its score updated. */
export async function answerQuiz(
	client: CompanionClient,
	id: string,
	attempt: string,
	question: string,
	given: QuizGiven,
): Promise<{ verdict: QuizVerdict; attempt: QuizAttempt }> {
	const reply = await client.requestQuiz({ t: "quiz-answer", id, attempt, question, ...given }, ANSWER_TIMEOUT_MS);
	return { verdict: reply.verdict, attempt: reply.attempt };
}

/** A new attempt asking every question, or only the ones `from` (default: the latest attempt) did not get right. */
export async function retryQuiz(
	client: CompanionClient,
	id: string,
	only: "all" | "missed",
	from?: string,
): Promise<QuizAttempt> {
	return (await client.requestQuiz({ t: "quiz-retry", id, only, from }, QUIZ_TIMEOUT_MS)).attempt;
}

/** Code around each ref at a part's commit, in the order of `refs`; null for a ref the commit does not have. */
export async function getQuizExcerpts(
	client: CompanionClient,
	id: string,
	part: number,
	refs: BlueprintExcerptRef[],
): Promise<(BlueprintExcerpt | null)[]> {
	const out: (BlueprintExcerpt | null)[] = [];
	for (let at = 0; at < refs.length; at += QUIZ_EXCERPT_BATCH) {
		const reply = await client.requestQuiz(
			{ t: "quiz-excerpt", id, part, refs: refs.slice(at, at + QUIZ_EXCERPT_BATCH) },
			EXCERPT_TIMEOUT_MS,
		);
		out.push(...reply.excerpts);
	}
	return out;
}

/** Delete a quiz; a running one is stopped first. */
export async function deleteQuiz(client: CompanionClient, id: string): Promise<void> {
	await client.requestQuiz({ t: "quiz-delete", id }, QUIZ_TIMEOUT_MS);
}

/** The pull requests stacked with `pr` (bottom first, `pr` included), and how they were found. */
export async function getQuizStack(
	client: CompanionClient,
	cwd: string,
	pr: number,
): Promise<{ stack: QuizStackPr[]; source: QuizStackSource }> {
	const { stack, source } = await client.requestQuiz({ t: "quiz-stack", cwd, pr }, STACK_TIMEOUT_MS);
	return { stack, source };
}
