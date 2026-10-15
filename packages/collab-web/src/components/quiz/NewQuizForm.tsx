import { QUIZ_DEFAULT_FOCUS, QUIZ_DEFAULT_MAX_COST_USD, type QuizFocus } from "@oh-my-pi/pi-wire/quiz";
import { ChevronLeft, GraduationCap, LoaderCircle, Play, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import type { FanoutModel } from "../../lib/fanout";
import { shortenPath } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { SubjectPicker, useSubjectPick } from "../shell/SubjectPicker";
import { createQuiz } from "./quiz-api";
import {
	buildCreate,
	effectiveFocus,
	focusChoices,
	isGitFolder,
	type QuizStartSubject,
	quizChoices,
} from "./quiz-flow";
import { useQuizFolder } from "./use-quiz-folder";

/** What the form is about, and where it runs. */
export interface NewQuizTarget {
	/** The computer that holds the repository (and the session, for a quiz about its changes). */
	computerId: string;
	/** Any folder of the repository on that computer. */
	cwd: string;
	/** The omp session whose conversation may be read to ask why; null when none is at hand. */
	sessionId: string | null;
	/** What the form starts on; the person can pick another. */
	subject: QuizStartSubject;
}

export interface NewQuizFormProps {
	computers: readonly ComputerHandle[];
	target: NewQuizTarget;
	onBack(): void;
	onStarted(computerId: string, id: string): void;
	onClose(): void;
}

const DEFAULT_LIMIT = String(QUIZ_DEFAULT_MAX_COST_USD);

const TOPIC_CHOICES = [{ value: "topic", label: "This session's topic" }] as const;

/** The form that confirms what to quiz and starts it: the session's changes, a branch or a pull request (with its stack), the spend limit, the model. */
export function NewQuizForm({ computers, target, onBack, onStarted, onClose }: NewQuizFormProps): ReactNode {
	const ids = useId();
	const computer = computerById(computers, target.computerId);
	const client = computer?.client ?? null;
	const canTopic = computer?.snap.canQuizTopic === true;
	// Only the topic subject asks what the folder holds; a diff quiz needs a repository, which the companion checks.
	const folder = useQuizFolder(client, target.cwd, canTopic && target.sessionId !== null);
	const git = isGitFolder(target.cwd, canTopic, folder);
	const offered = quizChoices({ canTopic, sessionId: target.sessionId, git, subject: target.subject });
	const topicChoices = offered.includes("topic") ? TOPIC_CHOICES : [];
	const startsOnTopic = target.subject.kind === "topic" || (!git && offered.includes("topic"));
	const pick = useSubjectPick<"topic">({
		client,
		cwd: target.cwd,
		sessionId: target.sessionId,
		subject: target.subject.kind === "topic" ? { kind: "changes" } : target.subject,
		extra: ["topic"],
		startOn: startsOnTopic ? "topic" : undefined,
	});
	const { choice, setChoice } = pick;
	// The folder turned out not to be a repository: the diff subjects go, and the form moves to the one that is left.
	const fallback = offered[0];
	const stranded = !offered.includes(choice);
	useEffect(() => {
		if (stranded && fallback !== undefined) setChoice(fallback);
	}, [stranded, fallback, setChoice]);
	const [focusPick, setFocusPick] = useState<QuizFocus>(QUIZ_DEFAULT_FOCUS);
	const focuses = focusChoices(choice === "topic" ? "topic" : "changes", folder);
	const focus = effectiveFocus(focusPick, focuses);
	const blocked = focuses.find(item => item.disabled !== null)?.disabled ?? undefined;
	const [useConversation, setUseConversation] = useState(true);
	const [limit, setLimit] = useState(DEFAULT_LIMIT);
	const [model, setModel] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// omp's own models (not other vendors' agents), grouped by provider; a computer that cannot list them gets a text field.
	const modelList = useRequest(
		useCallback(async () => {
			if (client === null) return [];
			const byProvider = new Map<string, FanoutModel[]>();
			for (const entry of await client.requestFanoutModels()) {
				if (entry.agent !== undefined) continue;
				const group = byProvider.get(entry.provider);
				if (group) group.push(entry);
				else byProvider.set(entry.provider, [entry]);
			}
			return [...byProvider];
		}, [client]),
	).state;

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		if (client === null) return setError("This computer is not connected.");
		const subject = choice === "topic" ? { kind: "topic" as const } : pick.picked;
		if (subject === null) return setError("Pick a pull request.");
		const made = buildCreate({
			cwd: target.cwd,
			subject,
			sessionId: target.sessionId,
			useConversation,
			stack: pick.stack,
			scope: pick.scope,
			focus,
			canTopic,
			limit,
			model,
		});
		if ("error" in made) return setError(made.error);
		setStarting(true);
		setError(null);
		try {
			const id = await createQuiz(client, made.request);
			saveLastComputer(target.computerId);
			onStarted(target.computerId, id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStarting(false);
		}
	};

	return (
		<form className="qz-form" onSubmit={e => void submit(e)}>
			<div className="sh-sheet-head">
				<button type="button" className="sh-btn sh-gh-back" onClick={onBack}>
					<ChevronLeft size={16} /> Quizzes
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<h2 className="qz-form-title">New quiz</h2>
			<div className="qz-form-body">
				<SubjectPicker
					pick={pick}
					label="What to quiz"
					summaryLabel="What you will be quizzed on"
					used="quizzed"
					extraChoices={topicChoices}
					builtIn={git}
					onChoose={() => setError(null)}
				/>
				{choice === "topic" && (
					<div className="sh-field">
						<span className="sh-field-label">What you will be quizzed on</span>
						<div className="sh-subject">
							<GraduationCap size={16} aria-hidden="true" />
							<div>
								<div className="sh-subject-title">This session's topic</div>
								<div className="sh-subject-meta">
									<code>{shortenPath(target.cwd)}</code>: the conversation, the files as they are now, and the
									background of the topic.
								</div>
							</div>
						</div>
					</div>
				)}
				{canTopic && (
					<div className="sh-field">
						<span className="sh-field-label" id={`${ids}-focus`}>
							Focus
						</span>
						<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-labelledby={`${ids}-focus`}>
							{focuses.map(item => (
								<button
									key={item.value}
									type="button"
									role="radio"
									aria-checked={focus === item.value}
									aria-describedby={item.disabled === null ? undefined : `${ids}-focus-why`}
									disabled={item.disabled !== null}
									className={focus === item.value ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => setFocusPick(item.value)}
								>
									{item.label}
								</button>
							))}
						</div>
						{blocked !== undefined && (
							<span className="sh-field-hint" id={`${ids}-focus-why`}>
								{blocked}
							</span>
						)}
					</div>
				)}
				{choice === "changes" && target.sessionId !== null && (
					<label className="qz-check">
						<input
							type="checkbox"
							checked={useConversation}
							onChange={e => setUseConversation(e.target.checked)}
						/>
						<span>
							Ask about why things were done
							<span className="sh-field-hint"> (uses this session's conversation)</span>
						</span>
					</label>
				)}
				<label className="sh-field">
					<span className="sh-field-label">Cost limit (USD)</span>
					<input
						className="sh-input qz-limit"
						type="number"
						inputMode="decimal"
						min="0.1"
						step="any"
						value={limit}
						onChange={e => setLimit(e.target.value)}
					/>
					<span className="sh-field-hint">
						Covers writing the questions and grading your answers; the quiz stops at this cost.
					</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">Model</span>
					{modelList.status === "ready" && modelList.value.length > 0 ? (
						<select className="sh-input" value={model} onChange={e => setModel(e.currentTarget.value)}>
							<option value="">The computer's default model</option>
							{modelList.value.map(([provider, entries]) => (
								<optgroup key={provider} label={provider}>
									{entries.map(entry => (
										<option key={entry.selector} value={entry.selector}>
											{entry.name}
										</option>
									))}
								</optgroup>
							))}
						</select>
					) : modelList.status === "loading" ? (
						<select className="sh-input" disabled value="">
							<option value="">Loading models…</option>
						</select>
					) : (
						<input
							className="sh-input"
							type="text"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							placeholder="provider/model"
							value={model}
							onChange={e => setModel(e.target.value)}
						/>
					)}
					<span className="sh-field-hint">
						Writes the questions; free-text answers are graded by the computer's small (smol) model.
					</span>
				</label>
			</div>
			{error !== null && (
				<div className="sh-connect-error" role="alert">
					{error}
				</div>
			)}
			<div className="qz-form-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={starting || client === null}>
					{starting ? <LoaderCircle size={14} className="sh-spin" /> : <Play size={14} />} Start the quiz
				</button>
			</div>
		</form>
	);
}
