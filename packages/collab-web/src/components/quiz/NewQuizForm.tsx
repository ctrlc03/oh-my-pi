import { QUIZ_DEFAULT_MAX_COST_USD } from "@oh-my-pi/pi-wire/quiz";
import { ChevronLeft, LoaderCircle, Play, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import type { FanoutModel } from "../../lib/fanout";
import { useRequest } from "../../lib/use-request";
import { SubjectPicker, useSubjectPick } from "../shell/SubjectPicker";
import { createQuiz } from "./quiz-api";
import { buildCreate, type QuizSubject } from "./quiz-flow";

/** What the form is about, and where it runs. */
export interface NewQuizTarget {
	/** The computer that holds the repository (and the session, for a quiz about its changes). */
	computerId: string;
	/** Any folder of the repository on that computer. */
	cwd: string;
	/** The omp session whose conversation may be read to ask why; null when none is at hand. */
	sessionId: string | null;
	/** What the form starts on; the person can pick another. */
	subject: QuizSubject;
}

export interface NewQuizFormProps {
	computers: readonly ComputerHandle[];
	target: NewQuizTarget;
	onBack(): void;
	onStarted(computerId: string, id: string): void;
	onClose(): void;
}

const DEFAULT_LIMIT = String(QUIZ_DEFAULT_MAX_COST_USD);

/** The form that confirms what to quiz and starts it: the session's changes, a branch or a pull request (with its stack), the spend limit, the model. */
export function NewQuizForm({ computers, target, onBack, onStarted, onClose }: NewQuizFormProps): ReactNode {
	const client = computerById(computers, target.computerId)?.client ?? null;
	const pick = useSubjectPick({ client, cwd: target.cwd, sessionId: target.sessionId, subject: target.subject });
	const { choice } = pick;
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
		if (pick.picked === null) return setError("Pick a pull request.");
		const made = buildCreate({
			cwd: target.cwd,
			subject: pick.picked,
			sessionId: target.sessionId,
			useConversation,
			stack: pick.stack,
			scope: pick.scope,
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
					onChoose={() => setError(null)}
				/>
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
