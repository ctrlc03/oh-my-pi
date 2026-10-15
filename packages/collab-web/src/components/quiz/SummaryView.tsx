import type { QuizAttempt } from "@oh-my-pi/pi-wire/quiz";
import {
	CircleAlert,
	CircleCheck,
	CircleX,
	History,
	ListRestart,
	LoaderCircle,
	Plus,
	RotateCcw,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { fmtCost, relTime } from "../../lib/format";
import { formatPoints, type StakesBanner, type SummaryModel, type SummaryQuestion, verdictLook } from "./quiz-flow";

const TONE_ICON = { right: CircleCheck, partly: CircleAlert, wrong: CircleX } as const;

export interface SummaryViewProps {
	summary: SummaryModel;
	/** Set on a quiz made for a high-stakes session's push: what the results say about it. Only a full run can pass, so the retry of missed answers is not offered. */
	stakes: { banner: StakesBanner | null } | null;
	/** Every attempt at the quiz, newest first. */
	attempts: readonly QuizAttempt[];
	/** The attempt shown. */
	attemptId: string;
	costUsd: number | undefined;
	/** What the companion fixed, dropped or skipped while writing the quiz, in plain words. */
	warnings: readonly string[];
	/** The retry that is being set up. */
	retrying: "all" | "missed" | null;
	error: string | null;
	onReview(question: string): void;
	onRetry(only: "all" | "missed"): void;
	onSelectAttempt(id: string): void;
	/** Back to the new-quiz form with the same subject; absent when there is none to offer. */
	onNewQuiz: (() => void) | null;
	onHistory(): void;
}

/** A question's verdict as a small mark: icon and words, not colour alone. */
function Mark({ kind }: { kind: SummaryQuestion["kind"] }): ReactNode {
	if (kind === null) return <span className="qz-mark qz-mark-open">Not answered</span>;
	const look = verdictLook(kind);
	const Icon = TONE_ICON[look.tone];
	return (
		<span className="qz-mark" data-tone={look.tone}>
			<Icon size={13} aria-hidden="true" /> {look.label}
		</span>
	);
}

/** The results of an attempt: the score, each part's, the topics to revisit (each linking to its questions), and what to do next. */
export function SummaryView({
	summary,
	stakes,
	attempts,
	attemptId,
	costUsd,
	warnings,
	retrying,
	error,
	onReview,
	onRetry,
	onSelectAttempt,
	onNewQuiz,
	onHistory,
}: SummaryViewProps): ReactNode {
	const busy = retrying !== null;
	const banner = stakes?.banner ?? null;
	// A stakes quiz that has not passed asks for a full run; otherwise a full retry is the main action only when nothing was missed.
	const retryAllFirst = stakes === null ? summary.missed === 0 : banner?.tone !== "passed";
	return (
		<div className="qz-summary">
			<div className="qz-score" role="group" aria-label="Score">
				<div className="qz-score-figure">
					<span className="qz-score-points">{formatPoints(summary.points)}</span>
					<span className="qz-score-total">/ {summary.total}</span>
				</div>
				<div className="qz-score-side">
					<span className="qz-score-percent">{summary.percent}%</span>
					<span className="qz-score-band">{summary.band}</span>
					{costUsd !== undefined && <span className="qz-hint">Quiz cost so far {fmtCost(costUsd)}</span>}
				</div>
			</div>
			{banner !== null && (
				<div className="qz-stakes" data-tone={banner.tone} role="status">
					{banner.tone === "passed" ? (
						<ShieldCheck size={16} aria-hidden="true" />
					) : (
						<ShieldAlert size={16} aria-hidden="true" />
					)}
					<span>{banner.text}</span>
				</div>
			)}
			{error !== null && (
				<div className="qz-alert" role="alert">
					<CircleAlert size={15} aria-hidden="true" />
					<span>{error}</span>
				</div>
			)}
			<div className="qz-actions qz-actions-start">
				{summary.missed > 0 && stakes === null && (
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={busy}
						onClick={() => onRetry("missed")}
					>
						{retrying === "missed" ? <LoaderCircle size={14} className="sh-spin" /> : <RotateCcw size={14} />}{" "}
						Retry wrong answers ({summary.missed})
					</button>
				)}
				<button
					type="button"
					className={retryAllFirst ? "sh-btn sh-btn-primary" : "sh-btn"}
					disabled={busy}
					onClick={() => onRetry("all")}
				>
					{retrying === "all" ? <LoaderCircle size={14} className="sh-spin" /> : <ListRestart size={14} />}{" "}
					{stakes === null ? "Retry all" : "Retry all questions"}
				</button>
				{onNewQuiz !== null && (
					<button type="button" className="sh-btn" disabled={busy} onClick={onNewQuiz}>
						<Plus size={14} /> New quiz
					</button>
				)}
				<button type="button" className="sh-btn" onClick={onHistory}>
					<History size={14} /> All quizzes
				</button>
			</div>
			{summary.parts.length > 1 && (
				<section className="qz-section" aria-labelledby="qz-by-part">
					<h3 id="qz-by-part" className="qz-heading">
						By part
					</h3>
					<ul className="qz-parts">
						{summary.parts.map(part => (
							<li key={part.part} className="qz-part-row">
								<span className="qz-part-name">{part.title}</span>
								<span className="qz-part-score">
									{formatPoints(part.points)}/{part.total} · {part.percent}%
								</span>
								<span className="qz-bar qz-bar-thin" aria-hidden="true">
									<span className="qz-bar-fill" style={{ width: `${part.percent}%` }} />
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
			<section className="qz-section" aria-labelledby="qz-revisit">
				<h3 id="qz-revisit" className="qz-heading">
					Topics to revisit
				</h3>
				{summary.topics.length === 0 ? (
					<p className="qz-note">Nothing to revisit: every answer was right.</p>
				) : (
					<ul className="qz-topics">
						{summary.topics.map(topic => (
							<li key={`${topic.part}:${topic.topic}`} className="qz-topic">
								<div className="qz-topic-name">{topic.topic}</div>
								{summary.parts.length > 1 && <div className="qz-topic-part">{topic.partTitle}</div>}
								<div className="qz-topic-questions">
									{topic.questions.map(question => (
										<button
											key={question.id}
											type="button"
											className="qz-topic-link"
											onClick={() => onReview(question.id)}
											aria-label={`Review question ${question.number}`}
										>
											Question {question.number} <Mark kind={question.kind} />
										</button>
									))}
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
			<section className="qz-section" aria-labelledby="qz-answers">
				<h3 id="qz-answers" className="qz-heading">
					Your answers
				</h3>
				<ol className="qz-answers">
					{summary.questions.map(question => (
						<li key={question.id}>
							<button type="button" className="qz-answer-row" onClick={() => onReview(question.id)}>
								<span className="qz-answer-no">{question.number}</span>
								<span className="qz-answer-prompt">{question.prompt}</span>
								<Mark kind={question.kind} />
							</button>
						</li>
					))}
				</ol>
			</section>
			{warnings.length > 0 && (
				<details className="qz-reminder">
					<summary>Notes from writing this quiz ({warnings.length})</summary>
					<ul className="qz-notes">
						{warnings.map(warning => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</details>
			)}
			{attempts.length > 1 && (
				<section className="qz-section" aria-labelledby="qz-attempts">
					<h3 id="qz-attempts" className="qz-heading">
						Attempts
					</h3>
					<ul className="qz-attempts">
						{attempts.map((attempt, at) => (
							<li key={attempt.id}>
								<button
									type="button"
									className="qz-attempt"
									aria-current={attempt.id === attemptId ? "true" : undefined}
									onClick={() => onSelectAttempt(attempt.id)}
								>
									<span>Attempt {attempts.length - at}</span>
									<span>
										{attempt.finishedAt === undefined
											? "in progress"
											: `${formatPoints(attempt.score.points)}/${attempt.score.total} · ${attempt.score.percent}%`}
									</span>
									<span className="qz-hint">{relTime(attempt.startedAt)}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
