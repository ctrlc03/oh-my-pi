import { createLazySheet } from "../shell/createLazySheet";
import type { QuizSheetProps } from "./QuizSheet";

/**
 * `QuizSheet`, loaded when first shown. The questions, the answer and results screens and the code panel are only
 * needed once someone opens quizzes: keep them out of the entry bundle.
 */
export const LazyQuizSheet = createLazySheet<QuizSheetProps>(
	{ label: "quizzes", title: "Quizzes", noun: "the quizzes" },
	() => import("./QuizSheet").then(module => module.QuizSheet),
);
