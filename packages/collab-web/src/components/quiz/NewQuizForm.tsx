import { QUIZ_DEFAULT_MAX_COST_USD } from "@oh-my-pi/pi-wire/quiz";
import { ChevronLeft, GitBranch, GitCompare, GitPullRequest, LoaderCircle, Play, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import { shortenPath } from "../../lib/format";
import type { FanoutModel } from "../../lib/fanout";
import { useRequest } from "../../lib/use-request";
import {
	BranchSelect,
	PrList,
	RefFilter,
	RefsLoading,
	useDebounced,
	useRepoRefs,
	withGivenPr,
} from "../shell/RefPicker";
import { createQuiz, getQuizStack } from "./quiz-api";
import { buildCreate, currentFirst, offeredStack, parsePrNumber, type QuizSubject } from "./quiz-flow";

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
/** A pull request number being typed is looked up for a stack once it has stopped changing. */
const STACK_LOOKUP_DEBOUNCE_MS = 250;

const CHOICES: { value: QuizSubject["kind"]; label: string }[] = [
	{ value: "changes", label: "This session's changes" },
	{ value: "branch", label: "A branch" },
	{ value: "pr", label: "A pull request" },
];

/** The form that confirms what to quiz and starts it: the session's changes, a branch or a pull request (with its stack), the spend limit, the model. */
export function NewQuizForm({ computers, target, onBack, onStarted, onClose }: NewQuizFormProps): ReactNode {
	const client = computerById(computers, target.computerId)?.client ?? null;
	const ids = useId();
	const { subject } = target;
	/** The session's own changes are offered where there is a session to take them from. */
	const canChanges = subject.kind === "changes" || target.sessionId !== null;
	const [choice, setChoice] = useState<QuizSubject["kind"]>(subject.kind);
	const [branch, setBranch] = useState<string | null>(subject.kind === "branch" ? subject.name : null);
	const [pr, setPr] = useState<number | null>(subject.kind === "pr" ? subject.number : null);
	const [prText, setPrText] = useState(subject.kind === "pr" ? String(subject.number) : "");
	const [useConversation, setUseConversation] = useState(true);
	const [scope, setScope] = useState<"stack" | "single">("stack");
	const [limit, setLimit] = useState(DEFAULT_LIMIT);
	const [model, setModel] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The session's changes need no listing; a branch or pull request is picked from the repository's own.
	const refs = useRepoRefs(choice === "changes" ? null : client, target.cwd);
	const { answer } = refs;
	const loading = refs.status === "loading";
	const branches = useMemo(() => currentFirst(answer.branches, answer.current), [answer.branches, answer.current]);
	const given = subject.kind === "pr" && refs.query === "" ? subject : undefined;
	const prs = useMemo(() => withGivenPr(answer.prs ?? [], given), [answer.prs, given]);
	// When the repository's lists cannot be read (an old companion, no `gh`, an error), a name or number can be typed.
	const branchListed =
		refs.status !== "error" && !(refs.status === "ready" && refs.query === "" && branches.length === 0);
	const prListed =
		loading || (refs.status === "ready" && answer.prs !== undefined && (refs.query !== "" || prs.length > 0));
	// The checked-out branch is the default pick while the (filtered) list shows it; a hidden one is not quizzed by surprise.
	const defaultBranch = answer.current !== undefined && branches.includes(answer.current) ? answer.current : "";
	const effectiveBranch = branch ?? defaultBranch;

	const lookupPr = useDebounced(pr, STACK_LOOKUP_DEBOUNCE_MS);
	const lookup = useRequest(
		useCallback(async () => {
			if (client === null || choice !== "pr" || lookupPr === null) return [];
			return (await getQuizStack(client, target.cwd, lookupPr)).stack;
		}, [client, target.cwd, choice, lookupPr]),
	);
	const settled = lookupPr === pr && lookup.state.status !== "loading";
	const stack = pr !== null && settled && lookup.state.status === "ready" ? offeredStack(lookup.state.value, pr) : [];
	const pickedPr = pr === null ? undefined : prs.find(item => item.number === pr);
	const prTitle = pickedPr?.title ?? (subject.kind === "pr" && subject.number === pr ? subject.title : "");
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

	const pickPr = (number: number | null, text: string): void => {
		setPr(number);
		setPrText(text);
	};

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		if (client === null) return setError("This computer is not connected.");
		if (choice === "pr" && pr === null) return setError("Pick a pull request.");
		const picked: QuizSubject =
			choice === "changes"
				? { kind: "changes" }
				: choice === "branch"
					? { kind: "branch", name: effectiveBranch }
					: { kind: "pr", number: pr!, title: prTitle };
		const made = buildCreate({
			cwd: target.cwd,
			subject: picked,
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
					<span className="sh-field-label" id={`${ids}-what`}>
						What to quiz
					</span>
					<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-labelledby={`${ids}-what`}>
						{CHOICES.filter(item => item.value !== "changes" || canChanges).map(item => (
							<button
								key={item.value}
								type="button"
								role="radio"
								aria-checked={choice === item.value}
								className={choice === item.value ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => {
									setChoice(item.value);
									setError(null);
								}}
							>
								{item.label}
							</button>
						))}
					</div>
				</div>
				{choice === "branch" && branchListed && (
					<RefFilter kind="branch" value={refs.filter} onChange={refs.setFilter} />
				)}
				{choice === "branch" && branchListed && (
					<div className="sh-field">
						<span className="sh-field-label">Branch</span>
						<BranchSelect
							branches={branches}
							current={answer.current}
							value={effectiveBranch}
							onChange={setBranch}
						/>
						{loading && <RefsLoading />}
						{refs.status === "ready" && branches.length === 0 && (
							<span className="sh-field-hint">No branches match.</span>
						)}
					</div>
				)}
				{choice === "branch" && !branchListed && (
					<label className="sh-field">
						<span className="sh-field-label">Branch name</span>
						<input
							className="sh-input"
							type="text"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							placeholder="feature/my-branch"
							value={branch ?? ""}
							onChange={e => setBranch(e.target.value)}
						/>
						<span className="sh-field-hint">
							{refs.status === "error"
								? `The branches could not be listed (${refs.message}). Type the name of one.`
								: "No branches were found. Type the name of one."}
						</span>
					</label>
				)}
				{choice === "pr" && prListed && <RefFilter kind="pr" value={refs.filter} onChange={refs.setFilter} />}
				{choice === "pr" && prListed && (
					<div className="sh-field">
						<span className="sh-field-label">Pull request</span>
						<PrList prs={prs} value={pr} onChange={number => pickPr(number, String(number))} />
						{loading && <RefsLoading />}
						{refs.status === "ready" && prs.length === 0 && (
							<span className="sh-field-hint">No open pull requests match.</span>
						)}
					</div>
				)}
				{choice === "pr" && !prListed && (
					<label className="sh-field">
						<span className="sh-field-label">Pull request number</span>
						<input
							className="sh-input qz-limit"
							type="text"
							inputMode="numeric"
							autoComplete="off"
							placeholder="#123"
							value={prText}
							onChange={e => pickPr(parsePrNumber(e.target.value), e.target.value)}
						/>
						<span className="sh-field-hint">
							{refs.status === "error"
								? `The open pull requests could not be listed (${refs.message}). Type the number of one.`
								: "The open pull requests could not be listed here. Type the number of one."}
						</span>
					</label>
				)}
				<div className="sh-field">
					<span className="sh-field-label">What you will be quizzed on</span>
					{choice === "changes" ? (
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
					) : choice === "branch" ? (
						<div className="qz-subject">
							<GitBranch size={16} aria-hidden="true" />
							<div>
								<div className="qz-subject-title">
									{effectiveBranch === "" ? "No branch picked yet" : effectiveBranch}
								</div>
								<div className="qz-subject-meta">
									<code>{shortenPath(target.cwd)}</code>: what this branch changed, compared with the default
									branch.
								</div>
							</div>
						</div>
					) : (
						<div className="qz-subject">
							<GitPullRequest size={16} aria-hidden="true" />
							<div>
								<div className="qz-subject-title">
									{pr === null ? "No pull request picked yet" : `#${pr} ${prTitle}`}
								</div>
								<div className="qz-subject-meta">
									<code>{shortenPath(target.cwd)}</code>
								</div>
							</div>
						</div>
					)}
				</div>
				{choice === "pr" && pr !== null && (
					<div className="sh-field">
						<span className="sh-field-label" id={`${ids}-scope`}>
							Scope
						</span>
						{!settled ? (
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
										<span>Only #{pr}</span>
									</label>
								</div>
								<ol className="qz-stack" aria-label="The stack, bottom first">
									{stack.map(item => (
										<li
											key={item.number}
											className={
												scope === "single" && item.number !== pr
													? "qz-stack-pr qz-stack-off"
													: item.number === pr
														? "qz-stack-pr qz-stack-here"
														: "qz-stack-pr"
											}
										>
											<span className="qz-stack-title">
												#{item.number} {item.title}
											</span>
											<span className="qz-stack-branches">
												{item.head} → {item.base}
											</span>
										</li>
									))}
								</ol>
							</>
						) : (
							<span className="sh-field-hint">
								{lookup.state.status === "error"
									? `Could not check for a stack (${lookup.state.message}); only #${pr} is quizzed.`
									: `#${pr} is not part of a stack; one part is quizzed.`}
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
