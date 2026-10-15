/**
 * Where the companion keeps quizzes: `<dir>/index.json` (one summary per quiz, including quizzes still being written
 * or failed) and `<dir>/<id>.json` (a finished quiz with its answer keys and attempts). Private to the user, under the
 * omp config folder and never in a repository; see ./companion-doc-store for the storage rules.
 */

import { type Quiz, type QuizAttempt, type QuizSummary, QUIZ_VERSION } from "@oh-my-pi/pi-wire/quiz";
import { createDocStore, type DocStore } from "./companion-doc-store";
import type { QuizKey } from "./companion-quiz-verify";

/** The high-stakes session a quiz was made for (./companion-stakes) and the exact states it compares. */
export interface QuizDocStakes {
	sessionId: string;
	/** Tree of the quizzed state: what a pass covers. */
	headTree: string;
	headCommit: string;
	/** Where the quiz starts: the merge base with the default branch, or the latest passed state for a delta quiz. */
	baseCommit: string;
	baseTree: string;
	delta: boolean;
	/** The attempt that passed, once one did. */
	passedAttempt?: string;
}

/** A stored quiz: what devices see, what only the companion sees, and the attempts so far. */
export interface QuizDoc {
	v: typeof QUIZ_VERSION;
	id: string;
	quiz: Quiz;
	/** Answer keys by question id; never sent to a device before the question is answered. */
	keys: Record<string, QuizKey>;
	attempts: QuizAttempt[];
	/** The limit this quiz was made with, USD. */
	maxCostUsd: number;
	/** What writing the questions cost, USD, when known. */
	generationCostUsd: number;
	/** What grading open answers has cost so far, USD. */
	gradingCostUsd: number;
	/** Set on a quiz made for a high-stakes session's push. */
	stakes?: QuizDocStakes;
}

export type QuizStore = DocStore<QuizSummary, QuizDoc>;

export function createQuizStore(dir: string): QuizStore {
	return createDocStore<QuizSummary, QuizDoc>({
		dir,
		indexKey: "quizzes",
		idPrefix: "qz",
		noun: "quiz",
		version: QUIZ_VERSION,
		isSummary: value => typeof value.subject === "string",
	});
}
