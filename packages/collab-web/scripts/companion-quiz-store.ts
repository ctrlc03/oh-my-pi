/**
 * Where the companion keeps quizzes: `<dir>/index.json` (one summary per quiz, including quizzes still being written
 * or failed) and `<dir>/<id>.json` (a finished quiz with its answer keys and attempts). Private to the user, under the
 * omp config folder and never in a repository; see ./companion-doc-store for the storage rules.
 */

import { type Quiz, type QuizAttempt, type QuizSummary, QUIZ_VERSION } from "@oh-my-pi/pi-wire/quiz";
import { createDocStore, type DocStore } from "./companion-doc-store";
import type { QuizKey } from "./companion-quiz-verify";

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
