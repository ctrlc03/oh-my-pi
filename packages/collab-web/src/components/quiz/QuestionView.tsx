import type { Quiz, QuizAnswerRecord, QuizQuestion } from "@oh-my-pi/pi-wire/quiz";
import { QUIZ_MAX_ANSWER_CHARS, QUIZ_POINTS } from "@oh-my-pi/pi-wire/quiz";
import { ArrowRight, CircleAlert, CircleCheck, CircleX, ListChecks, LoaderCircle, Send } from "lucide-react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { refKey } from "../architecture/blueprint-model";
import { Markdown } from "../transcript/Markdown";
import { QuizCode, type QuizCodeProps } from "./QuizCode";
import {
	answerKeyAction,
	canSubmit,
	formatPoints,
	type Position,
	type Progress,
	partTitle,
	verdictLook,
} from "./quiz-flow";
import type { QuizGiven } from "./quiz-api";

/** What has been typed or picked for a question and not sent yet. */
export interface Draft {
	text?: string;
	choice?: string;
}

/** Primary input is a finger: the return key breaks the line, and the Submit button is in reach. */
function onTouchInput(): boolean {
	return typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export interface QuestionViewProps {
	code: Pick<QuizCodeProps, "excerpts" | "cache" | "openInEditor">;
	quiz: Quiz;
	question: QuizQuestion;
	position: Position;
	progress: Progress;
	/** The recorded answer: the question shows its verdict instead of the answer box. */
	record: QuizAnswerRecord | undefined;
	draft: Draft | undefined;
	onDraft(next: Draft): void;
	submitting: boolean;
	/** Why the last submit failed (limit reached, grading failed); the draft stays. */
	error: string | null;
	onSubmit(given: QuizGiven): void;
	/** Looking back at an answered question from the results rather than just answering it. */
	review: boolean;
	/** The button that moves on after a verdict: the next question, or the results. */
	next: { label: string; results: boolean } | null;
	onNext(): void;
	onBackToResults(): void;
}

/**
 * One question: where it is in the quiz, the prompt, the code it cites, and the answer box; once answered, the
 * verdict with its explanation. On wide screens the code sits beside the question.
 */
export function QuestionView({
	code,
	quiz,
	question,
	position,
	progress,
	record,
	draft,
	onDraft,
	submitting,
	error,
	onSubmit,
	review,
	next,
	onNext,
	onBackToResults,
}: QuestionViewProps): ReactNode {
	const verdictRefs = (record?.verdict.refs ?? []).filter(
		ref => !question.refs.some(own => refKey(own) === refKey(ref)),
	);
	return (
		<div className="qz-question">
			<div className="qz-qhead">
				<div className="qz-crumbs">
					<span>
						Part {position.part} of {position.partCount}
					</span>
					<span aria-hidden="true">·</span>
					<span>
						Question {position.question} of {position.questionCount}
					</span>
				</div>
				<h2 className="qz-part-title">{partTitle(quiz, question.part)}</h2>
				<div
					className="qz-bar"
					role="progressbar"
					aria-label="Questions answered"
					aria-valuemin={0}
					aria-valuemax={progress.total}
					aria-valuenow={progress.answered}
				>
					<span className="qz-bar-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
				</div>
			</div>
			<div className="qz-split">
				<div className="qz-prompt-area">
					<div className="qz-prompt">
						<Markdown text={question.prompt} />
					</div>
					{question.reminder !== undefined && question.reminder !== "" && (
						<details className="qz-reminder">
							<summary>Reminder</summary>
							<Markdown text={question.reminder} />
						</details>
					)}
				</div>
				<div className="qz-code-area">
					<h3 className="qz-heading">{question.refs.length === 1 ? "The code" : "The code this is about"}</h3>
					<QuizCode {...code} part={question.part} refs={question.refs} />
					{verdictRefs.length > 0 && (
						<>
							<h3 className="qz-heading">What the explanation points at</h3>
							<QuizCode {...code} part={question.part} refs={verdictRefs} />
						</>
					)}
				</div>
				<div className="qz-answer-area">
					{record === undefined ? (
						<AnswerBox
							key={question.id}
							question={question}
							draft={draft}
							onDraft={onDraft}
							submitting={submitting}
							error={error}
							onSubmit={onSubmit}
						/>
					) : (
						<VerdictBox
							question={question}
							record={record}
							review={review}
							next={next}
							onNext={onNext}
							onBackToResults={onBackToResults}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

function AnswerBox({
	question,
	draft,
	onDraft,
	submitting,
	error,
	onSubmit,
}: {
	question: QuizQuestion;
	draft: Draft | undefined;
	onDraft(next: Draft): void;
	submitting: boolean;
	error: string | null;
	onSubmit(given: QuizGiven): void;
}): ReactNode {
	const area = useRef<HTMLTextAreaElement>(null);
	const composing = useRef(false);
	const choice = question.kind === "choice";
	const ready = canSubmit(question, draft);
	const touch = onTouchInput();
	useEffect(() => {
		// A finger would bring up the keyboard over the code: only a keyboard user lands in the box.
		if (!touch) area.current?.focus();
	}, [touch]);

	const send = (): void => {
		if (!ready || submitting) return;
		onSubmit(choice ? { choice: draft?.choice ?? "" } : { text: draft?.text ?? "" });
	};
	const submit = (e: FormEvent): void => {
		e.preventDefault();
		send();
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		const action = answerKeyAction({
			key: e.key,
			shiftKey: e.shiftKey,
			ctrlKey: e.ctrlKey,
			metaKey: e.metaKey,
			composing: e.nativeEvent.isComposing || composing.current,
			touch,
		});
		if (e.key === "Enter" && action === "submit") {
			e.preventDefault();
			send();
		}
	};
	const text = draft?.text ?? "";
	return (
		<form className="qz-answer" onSubmit={submit}>
			{choice ? (
				<fieldset className="qz-choices" disabled={submitting}>
					<legend className="qz-label">Pick one</legend>
					{(question.choices ?? []).map(item => (
						<label key={item.id} className={draft?.choice === item.id ? "qz-choice qz-choice-on" : "qz-choice"}>
							<input
								type="radio"
								name={`choice-${question.id}`}
								value={item.id}
								checked={draft?.choice === item.id}
								onChange={() => onDraft({ choice: item.id })}
							/>
							<span className="qz-choice-id" aria-hidden="true">
								{item.id.toUpperCase()}
							</span>
							<span className="qz-choice-text">
								<Markdown text={item.text} />
							</span>
						</label>
					))}
				</fieldset>
			) : (
				<div className="qz-field">
					<label className="qz-label" htmlFor={`answer-${question.id}`}>
						Your answer
					</label>
					<textarea
						id={`answer-${question.id}`}
						ref={area}
						className="sh-input qz-textarea"
						rows={5}
						maxLength={QUIZ_MAX_ANSWER_CHARS}
						value={text}
						readOnly={submitting}
						placeholder="Answer in your own words"
						onChange={e => onDraft({ text: e.target.value })}
						onKeyDown={onKey}
						onCompositionStart={() => {
							composing.current = true;
						}}
						onCompositionEnd={() => {
							// WebKit sends the confirming Enter after `compositionend`.
							setTimeout(() => {
								composing.current = false;
							}, 0);
						}}
					/>
					<div className="qz-field-foot">
						<span className="qz-hint">{touch ? "" : "Enter submits · Shift+Enter adds a line"}</span>
						{text.length > QUIZ_MAX_ANSWER_CHARS * 0.8 && (
							<span className="qz-hint">
								{text.length} / {QUIZ_MAX_ANSWER_CHARS}
							</span>
						)}
					</div>
				</div>
			)}
			{error !== null && (
				<div className="qz-alert" role="alert">
					<CircleAlert size={15} aria-hidden="true" />
					<span>{error}</span>
				</div>
			)}
			<div className="qz-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={!ready || submitting}>
					{submitting ? <LoaderCircle size={14} className="sh-spin" /> : <Send size={14} />}{" "}
					{submitting ? "Grading…" : error === null ? "Submit the answer" : "Try again"}
				</button>
			</div>
		</form>
	);
}

const TONE_ICON = { right: CircleCheck, partly: CircleAlert, wrong: CircleX } as const;

function VerdictBox({
	question,
	record,
	review,
	next,
	onNext,
	onBackToResults,
}: {
	question: QuizQuestion;
	record: QuizAnswerRecord;
	review: boolean;
	next: QuestionViewProps["next"];
	onNext(): void;
	onBackToResults(): void;
}): ReactNode {
	const { verdict } = record;
	const look = verdictLook(verdict.kind);
	const Icon = TONE_ICON[look.tone];
	const advance = useRef<HTMLButtonElement>(null);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// Straight after answering the verdict is brought into view and focus goes to the way on; looking back from the results moves nothing.
		if (review) return;
		box.current?.scrollIntoView({ block: "nearest" });
		advance.current?.focus({ preventScroll: true });
	}, [review]);
	return (
		<div ref={box} className="qz-verdict" data-tone={look.tone} role="status">
			<div className="qz-verdict-head">
				<span className="qz-badge">
					<Icon size={16} aria-hidden="true" /> {look.label}
				</span>
				<span className="qz-points">{formatPoints(QUIZ_POINTS[verdict.kind])} of 1 point</span>
			</div>
			{question.kind === "choice" ? (
				<ul className="qz-choices qz-choices-done" aria-label="The choices">
					{(question.choices ?? []).map(item => {
						const picked = record.choice === item.id;
						const right = verdict.answer === item.id;
						return (
							<li
								key={item.id}
								className={`qz-choice${right ? " qz-choice-right" : picked ? " qz-choice-wrong" : ""}`}
							>
								<span className="qz-choice-id" aria-hidden="true">
									{item.id.toUpperCase()}
								</span>
								<span className="qz-choice-text">
									<Markdown text={item.text} />
								</span>
								{(right || picked) && (
									<span className="qz-choice-tag">
										{right && picked ? "Your answer, right" : right ? "Right answer" : "Your answer"}
									</span>
								)}
							</li>
						);
					})}
				</ul>
			) : (
				record.text !== undefined && (
					<div className="qz-given">
						<div className="qz-label">Your answer</div>
						<p className="qz-given-text">{record.text}</p>
					</div>
				)
			)}
			<div className="qz-explanation">
				<Markdown text={verdict.explanation} />
			</div>
			{verdict.keyPoints !== undefined && verdict.keyPoints.length > 0 && (
				<div className="qz-keypoints">
					<h3 className="qz-heading">What a full answer covers</h3>
					<ul>
						{verdict.keyPoints.map(point => (
							<li key={point}>
								<Markdown text={point} />
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="qz-actions">
				{review ? (
					<button type="button" className="sh-btn sh-btn-primary" onClick={onBackToResults}>
						<ListChecks size={14} /> Back to the results
					</button>
				) : (
					next !== null && (
						<button ref={advance} type="button" className="sh-btn sh-btn-primary" onClick={onNext}>
							{next.label} {next.results ? <ListChecks size={14} /> : <ArrowRight size={14} />}
						</button>
					)
				)}
			</div>
		</div>
	);
}
