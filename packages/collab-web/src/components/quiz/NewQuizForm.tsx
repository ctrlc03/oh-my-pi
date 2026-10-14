import { QUIZ_DEFAULT_MAX_COST_USD } from "@oh-my-pi/pi-wire/quiz";
import { ChevronLeft, GitCompare, GitPullRequest, LoaderCircle, Play, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useId, useState } from "react";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import { shortenPath } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { createQuiz, getQuizStack } from "./quiz-api";
import { buildCreate, offeredStack, type QuizSubject } from "./quiz-flow";

/** What the form is about, and where it runs. */
export interface NewQuizTarget {
	/** The computer that holds the repository (and the session, for a quiz about its changes). */
	computerId: string;
	/** Any folder of the repository on that computer. */
	cwd: string;
	/** The omp session whose conversation may be read to ask why; null when none is at hand. */
	sessionId: string | null;
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

/** The form that confirms what to quiz and starts it: the changes or pull request (with its stack), the spend limit, the model. */
export function NewQuizForm({ computers, target, onBack, onStarted, onClose }: NewQuizFormProps): ReactNode {
	const client = computerById(computers, target.computerId)?.client ?? null;
	const ids = useId();
	const [useConversation, setUseConversation] = useState(true);
	const [scope, setScope] = useState<"stack" | "single">("stack");
	const [limit, setLimit] = useState(DEFAULT_LIMIT);
	const [model, setModel] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { subject } = target;
	const prNumber = subject.kind === "pr" ? subject.number : null;
	const lookup = useRequest(
		useCallback(async () => {
			if (client === null || prNumber === null) return [];
			return (await getQuizStack(client, target.cwd, prNumber)).stack;
		}, [client, target.cwd, prNumber]),
	);
	const stack = prNumber !== null && lookup.state.status === "ready" ? offeredStack(lookup.state.value, prNumber) : [];

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		if (client === null) return setError("This computer is not connected.");
		const made = buildCreate({
			cwd: target.cwd,
			subject,
			sessionId: target.sessionId,
			useConversation,
			stack,
			scope,
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
				<div className="sh-field">
					<span className="sh-field-label">What you will be quizzed on</span>
					{subject.kind === "changes" ? (
						<div className="qz-subject">
							<GitCompare size={16} aria-hidden="true" />
							<div>
								<div className="qz-subject-title">What this session changed</div>
								<div className="qz-subject-meta">
									<code>{shortenPath(target.cwd)}</code>: the files as they are now, uncommitted changes
									included, compared with the default branch.
								</div>
							</div>
						</div>
					) : (
						<div className="qz-subject">
							<GitPullRequest size={16} aria-hidden="true" />
							<div>
								<div className="qz-subject-title">
									#{subject.number} {subject.title}
								</div>
								<div className="qz-subject-meta">
									<code>{shortenPath(target.cwd)}</code>
								</div>
							</div>
						</div>
					)}
				</div>
				{subject.kind === "pr" && (
					<div className="sh-field">
						<span className="sh-field-label" id={`${ids}-scope`}>
							Scope
						</span>
						{lookup.state.status === "loading" ? (
							<span className="sh-field-hint">
								<LoaderCircle size={12} className="sh-spin" /> Looking for a stack…
							</span>
						) : stack.length > 1 ? (
							<>
								<div className="qz-radios" role="radiogroup" aria-labelledby={`${ids}-scope`}>
									<label className="qz-radio">
										<input
											type="radio"
											name={`${ids}-scope`}
											checked={scope === "stack"}
											onChange={() => setScope("stack")}
										/>
										<span>Whole stack ({stack.length} PRs, one part each)</span>
									</label>
									<label className="qz-radio">
										<input
											type="radio"
											name={`${ids}-scope`}
											checked={scope === "single"}
											onChange={() => setScope("single")}
										/>
										<span>Only #{subject.number}</span>
									</label>
								</div>
								<ol className="qz-stack" aria-label="The stack, bottom first">
									{stack.map(pr => (
										<li
											key={pr.number}
											className={
												scope === "single" && pr.number !== subject.number
													? "qz-stack-pr qz-stack-off"
													: pr.number === subject.number
														? "qz-stack-pr qz-stack-here"
														: "qz-stack-pr"
											}
										>
											<span className="qz-stack-title">
												#{pr.number} {pr.title}
											</span>
											<span className="qz-stack-branches">
												{pr.head} → {pr.base}
											</span>
										</li>
									))}
								</ol>
							</>
						) : (
							<span className="sh-field-hint">
								{lookup.state.status === "error"
									? `Could not check for a stack (${lookup.state.message}); only #${subject.number} is quizzed.`
									: `#${subject.number} is not part of a stack; one part is quizzed.`}
							</span>
						)}
					</div>
				)}
				{subject.kind === "changes" && target.sessionId !== null && (
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
					<span className="sh-field-label">Model (optional)</span>
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
					<span className="sh-field-hint">Leave empty for the computer's default model.</span>
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
