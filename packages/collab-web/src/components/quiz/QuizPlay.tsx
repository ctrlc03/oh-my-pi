import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type { Quiz, QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import type { Draft } from "./QuestionView";
import { QuestionView } from "./QuestionView";
import { QuizHeader } from "./QuizHeader";
import type { ExcerptCache, ExcerptReader } from "./QuizCode";
import { SummaryView } from "./SummaryView";
import type { QuizGiven } from "./quiz-api";
import { answerQuiz, getQuizExcerpts, retryQuiz } from "./quiz-api";
import {
	answerOf,
	attemptHistory,
	attemptQuestions,
	landingOf,
	nextQuestion,
	positionOf,
	progressOf,
	summaryOf,
} from "./quiz-flow";

export interface QuizPlayProps {
	client: CompanionClient;
	quiz: Quiz;
	/** Every attempt the companion holds; the latest unfinished one is resumed at its first unanswered question. */
	attempts: readonly QuizAttempt[];
	costUsd: number | undefined;
	/** Opens a cited line of the checkout on screen when it is this quiz's repository; absent when the quiz is not about that checkout. */
	editor?: { root: string; open(path: string, line?: number): void };
	/** Back to the new-quiz form about this quiz's subject; null when there is none to offer. */
	onNewQuiz: ((quiz: Quiz) => void) | null;
	/** Back to the list of quizzes. */
	onHistory(): void;
	onClose(): void;
}

type View = { kind: "question"; id: string; review: boolean } | { kind: "summary" };

/**
 * A loaded quiz being taken: one question at a time with its verdict, then the results. The attempts live on the
 * companion, so closing the sheet or reloading comes back to the first unanswered question.
 */
export function QuizPlay({
	client,
	quiz,
	attempts: given,
	costUsd,
	editor,
	onNewQuiz,
	onHistory,
	onClose,
}: QuizPlayProps): ReactNode {
	const [attempts, setAttempts] = useState<readonly QuizAttempt[]>(given);
	const landing = useMemo(() => landingOf(quiz, given), [quiz, given]);
	const [attemptId, setAttemptId] = useState<string | null>(landing?.attempt ?? null);
	const [view, setView] = useState<View>(
		landing?.kind === "question" ? { kind: "question", id: landing.question, review: false } : { kind: "summary" },
	);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [submitting, setSubmitting] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [retrying, setRetrying] = useState<"all" | "missed" | null>(null);
	const [retryError, setRetryError] = useState<string | null>(null);
	const cache = useRef<ExcerptCache>(new Map()).current;
	const excerpts = useCallback<ExcerptReader>(
		(part, refs) => getQuizExcerpts(client, quiz.id, part, refs),
		[client, quiz.id],
	);
	const openInEditor =
		editor !== undefined && editor.root === quiz.repo.root
			? (ref: BlueprintRef) => editor.open(`${editor.root}/${ref.path}`, ref.line)
			: undefined;

	const attempt = attempts.find(item => item.id === attemptId) ?? null;
	const questions = useMemo(() => (attempt === null ? [] : attemptQuestions(quiz, attempt)), [quiz, attempt]);

	const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

	const submit = async (questionId: string, answer: QuizGiven): Promise<void> => {
		if (attempt === null) return;
		setSubmitting(questionId);
		setErrors(list => Object.fromEntries(Object.entries(list).filter(([id]) => id !== questionId)));
		try {
			const reply = await answerQuiz(client, quiz.id, attempt.id, questionId, answer);
			setAttempts(list => list.map(item => (item.id === reply.attempt.id ? reply.attempt : item)));
		} catch (err) {
			setErrors(list => ({ ...list, [questionId]: messageOf(err) }));
		} finally {
			setSubmitting(null);
		}
	};

	const startAttempt = async (only: "all" | "missed"): Promise<void> => {
		setRetrying(only);
		setRetryError(null);
		try {
			const fresh = await retryQuiz(client, quiz.id, only, attemptId ?? undefined);
			setAttempts(list => [...list.filter(item => item.id !== fresh.id), fresh]);
			setAttemptId(fresh.id);
			const first = attemptQuestions(quiz, fresh)[0];
			setView(first === undefined ? { kind: "summary" } : { kind: "question", id: first.id, review: false });
		} catch (err) {
			setRetryError(messageOf(err));
		} finally {
			setRetrying(null);
		}
	};

	const header = <QuizHeader onHistory={onHistory} onClose={onClose} />;

	if (attempt === null) {
		return (
			<>
				{header}
				<div className="qz-center">
					<p>This quiz has no attempt yet.</p>
					{retryError !== null && (
						<div className="qz-alert" role="alert">
							{retryError}
						</div>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={retrying !== null}
						onClick={() => void startAttempt("all")}
					>
						{retrying !== null && <LoaderCircle size={14} className="sh-spin" />} Start the quiz
					</button>
				</div>
			</>
		);
	}

	const question = view.kind === "question" ? questions.find(item => item.id === view.id) : undefined;
	if (view.kind === "question" && question !== undefined) {
		const at = questions.indexOf(question);
		const following = nextQuestion(questions, attempt);
		return (
			<>
				{header}
				<div className="qz-scroll qz-scroll-question">
					<QuestionView
						key={`${attempt.id}:${question.id}`}
						code={{ excerpts, cache, openInEditor }}
						quiz={quiz}
						question={question}
						position={positionOf(questions, at)}
						progress={progressOf(questions, attempt)}
						record={answerOf(attempt, question.id)}
						draft={drafts[question.id]}
						onDraft={next => setDrafts(list => ({ ...list, [question.id]: next }))}
						submitting={submitting === question.id}
						error={errors[question.id] ?? null}
						onSubmit={answer => void submit(question.id, answer)}
						review={view.review}
						next={
							following === null
								? { label: "See results", results: true }
								: { label: "Next question", results: false }
						}
						onNext={() =>
							setView(
								following === null
									? { kind: "summary" }
									: { kind: "question", id: following.id, review: false },
							)
						}
						onBackToResults={() => setView({ kind: "summary" })}
					/>
				</div>
			</>
		);
	}
	return (
		<>
			{header}
			<div className="qz-scroll">
				<SummaryView
					summary={summaryOf(quiz, attempt)}
					attempts={attemptHistory(attempts)}
					attemptId={attempt.id}
					costUsd={costUsd}
					warnings={quiz.warnings}
					retrying={retrying}
					error={retryError}
					onReview={id => setView({ kind: "question", id, review: true })}
					onRetry={only => void startAttempt(only)}
					onSelectAttempt={id => {
						const chosen = attempts.find(item => item.id === id);
						if (chosen === undefined) return;
						setAttemptId(id);
						setRetryError(null);
						// An attempt left half done resumes where it stopped.
						const resume = nextQuestion(attemptQuestions(quiz, chosen), chosen);
						if (resume !== null) setView({ kind: "question", id: resume.id, review: false });
					}}
					onNewQuiz={onNewQuiz === null ? null : () => onNewQuiz(quiz)}
					onHistory={onHistory}
				/>
			</div>
		</>
	);
}
