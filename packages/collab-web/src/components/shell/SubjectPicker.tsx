import type { QuizStackPr } from "@oh-my-pi/pi-wire/quiz";
import { GitBranch, GitCompare, GitPullRequest, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { shortenPath } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { getQuizStack } from "../quiz/quiz-api";
import { currentFirst, offeredStack, parsePrNumber, type QuizSubject } from "../quiz/quiz-flow";
import {
	BranchSelect,
	PrList,
	RefFilter,
	type RefPr,
	RefsLoading,
	type RepoRefs,
	useDebounced,
	useRepoRefs,
	withGivenPr,
} from "./RefPicker";
import "./subject-picker.css";

/** A pull request number being typed is looked up for a stack once it has stopped changing. */
const STACK_LOOKUP_DEBOUNCE_MS = 250;

const BUILT_IN_CHOICES: { value: QuizSubject["kind"]; label: string }[] = [
	{ value: "changes", label: "This session's changes" },
	{ value: "branch", label: "A branch" },
	{ value: "pr", label: "A pull request" },
];

export interface SubjectPickerOptions<Extra extends string> {
	/** The connection to the computer that holds the repository; null while there is none. */
	client: CompanionClient | null;
	/** Any folder of the repository on that computer. */
	cwd: string;
	/** The omp session whose changes can be taken; null when none is at hand. */
	sessionId: string | null;
	/** What the picker starts on; the person can pick another. */
	subject: QuizSubject;
	/** Choices beside the three built in (the form shows what they need itself). */
	extra?: readonly Extra[];
	/** An extra choice to start on instead of `subject`'s kind. */
	startOn?: Extra;
}

/** What the person has picked so far, and what the repository offers for it. */
export interface SubjectPick<Extra extends string = never> {
	options: SubjectPickerOptions<Extra>;
	choice: QuizSubject["kind"] | Extra;
	setChoice(choice: QuizSubject["kind"] | Extra): void;
	/** The session's own changes are offered where there is a session to take them from. */
	canChanges: boolean;
	branch: string | null;
	setBranch(name: string): void;
	pr: number | null;
	prText: string;
	pickPr(number: number | null, text: string): void;
	scope: "stack" | "single";
	setScope(scope: "stack" | "single"): void;
	refs: RepoRefs;
	branches: string[];
	prs: RefPr[];
	branchListed: boolean;
	prListed: boolean;
	effectiveBranch: string;
	prTitle: string;
	/** The stack of the picked pull request (more than one pull request), else empty. */
	stack: QuizStackPr[];
	/** The stack lookup has finished for the picked pull request. */
	stackSettled: boolean;
	stackError: string | null;
	/** The pick as a subject; null while the choice is one of the extras, or a pull request is still to pick. */
	picked: QuizSubject | null;
}

/** The state of a {@link SubjectPicker}: the choice, the branch or pull request, the repository's lists, and the stack. */
export function useSubjectPick<Extra extends string = never>(options: SubjectPickerOptions<Extra>): SubjectPick<Extra> {
	const { client, cwd, sessionId, subject } = options;
	const canChanges = subject.kind === "changes" || sessionId !== null;
	const [choice, setChoice] = useState<QuizSubject["kind"] | Extra>(options.startOn ?? subject.kind);
	const [branch, setBranch] = useState<string | null>(subject.kind === "branch" ? subject.name : null);
	const [pr, setPr] = useState<number | null>(subject.kind === "pr" ? subject.number : null);
	const [prText, setPrText] = useState(subject.kind === "pr" ? String(subject.number) : "");
	const [scope, setScope] = useState<"stack" | "single">("stack");
	const picks = choice === "branch" || choice === "pr";

	// The session's changes need no listing; a branch or pull request is picked from the repository's own.
	const refs = useRepoRefs(picks ? client : null, cwd);
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
	// The checked-out branch is the default pick while the (filtered) list shows it; a hidden one is not picked by surprise.
	const defaultBranch = answer.current !== undefined && branches.includes(answer.current) ? answer.current : "";
	const effectiveBranch = branch ?? defaultBranch;

	const lookupPr = useDebounced(pr, STACK_LOOKUP_DEBOUNCE_MS);
	const lookup = useRequest(
		useCallback(async () => {
			if (client === null || choice !== "pr" || lookupPr === null) return [];
			return (await getQuizStack(client, cwd, lookupPr)).stack;
		}, [client, cwd, choice, lookupPr]),
	);
	const stackSettled = lookupPr === pr && lookup.state.status !== "loading";
	const stack =
		pr !== null && stackSettled && lookup.state.status === "ready" ? offeredStack(lookup.state.value, pr) : [];
	const pickedPr = pr === null ? undefined : prs.find(item => item.number === pr);
	const prTitle = pickedPr?.title ?? (subject.kind === "pr" && subject.number === pr ? subject.title : "");

	let picked: QuizSubject | null = null;
	if (choice === "changes") picked = { kind: "changes" };
	else if (choice === "branch") picked = { kind: "branch", name: effectiveBranch };
	else if (choice === "pr" && pr !== null) picked = { kind: "pr", number: pr, title: prTitle };

	return {
		options,
		choice,
		setChoice,
		canChanges,
		branch,
		setBranch,
		pr,
		prText,
		pickPr: (number, text) => {
			setPr(number);
			setPrText(text);
		},
		scope,
		setScope,
		refs,
		branches,
		prs,
		branchListed,
		prListed,
		effectiveBranch,
		prTitle,
		stack,
		stackSettled,
		stackError: lookup.state.status === "error" ? lookup.state.message : null,
		picked,
	};
}

export interface SubjectPickerProps<Extra extends string> {
	pick: SubjectPick<Extra>;
	/** The label over the choices: "What to quiz". */
	label: string;
	/** The label over the summary of the pick: "What you will be quizzed on". */
	summaryLabel: string;
	/** What the stack's pull requests are called when taken: "quizzed" in "only #12 is quizzed". */
	used: string;
	/** Labels of the extra choices, in the order to show them. */
	extraChoices?: readonly { value: Extra; label: string }[];
	/** Offer the choice between a pull request's whole stack and the pull request alone (default true); false for a use that takes one pull request. */
	stacks?: boolean;
	/** Offer the session's changes, a branch and a pull request (default true); false for a folder that is not a git repository. */
	builtIn?: boolean;
	/** Called when the choice changes, so a form can clear its error. */
	onChoose?(): void;
}

/**
 * Which change to work on: the session's changes, a branch or a pull request (with the stack it is part of), picked from the
 * repository's own lists. Renders form fields as siblings, to sit inside a form body. The pick is `useSubjectPick`.
 */
export function SubjectPicker<Extra extends string = never>({
	pick,
	label,
	summaryLabel,
	used,
	extraChoices = [],
	builtIn = true,
	stacks = true,
	onChoose,
}: SubjectPickerProps<Extra>): ReactNode {
	const ids = useId();
	const { choice, refs, pr, scope, stack } = pick;
	const { answer } = refs;
	const loading = refs.status === "loading";
	const cwd = pick.options.cwd;
	const choices: { value: QuizSubject["kind"] | Extra; label: string }[] = [
		...(builtIn ? BUILT_IN_CHOICES.filter(item => item.value !== "changes" || pick.canChanges) : []),
		...extraChoices,
	];
	return (
		<>
			<div className="sh-field">
				<span className="sh-field-label" id={`${ids}-what`}>
					{label}
				</span>
				<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-labelledby={`${ids}-what`}>
					{choices.map(item => (
						<button
							key={item.value}
							type="button"
							role="radio"
							aria-checked={choice === item.value}
							className={choice === item.value ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => {
								pick.setChoice(item.value);
								onChoose?.();
							}}
						>
							{item.label}
						</button>
					))}
				</div>
			</div>
			{choice === "branch" && pick.branchListed && (
				<RefFilter kind="branch" value={refs.filter} onChange={refs.setFilter} />
			)}
			{choice === "branch" && pick.branchListed && (
				<div className="sh-field">
					<span className="sh-field-label">Branch</span>
					<BranchSelect
						branches={pick.branches}
						current={answer.current}
						value={pick.effectiveBranch}
						onChange={pick.setBranch}
					/>
					{loading && <RefsLoading />}
					{refs.status === "ready" && pick.branches.length === 0 && (
						<span className="sh-field-hint">No branches match.</span>
					)}
				</div>
			)}
			{choice === "branch" && !pick.branchListed && (
				<label className="sh-field">
					<span className="sh-field-label">Branch name</span>
					<input
						className="sh-input sh-subject-input"
						type="text"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						placeholder="feature/my-branch"
						value={pick.branch ?? ""}
						onChange={e => pick.setBranch(e.target.value)}
					/>
					<span className="sh-field-hint">
						{refs.status === "error"
							? `The branches could not be listed (${refs.message}). Type the name of one.`
							: "No branches were found. Type the name of one."}
					</span>
				</label>
			)}
			{choice === "pr" && pick.prListed && <RefFilter kind="pr" value={refs.filter} onChange={refs.setFilter} />}
			{choice === "pr" && pick.prListed && (
				<div className="sh-field">
					<span className="sh-field-label">Pull request</span>
					<PrList prs={pick.prs} value={pr} onChange={number => pick.pickPr(number, String(number))} />
					{loading && <RefsLoading />}
					{refs.status === "ready" && pick.prs.length === 0 && (
						<span className="sh-field-hint">No open pull requests match.</span>
					)}
				</div>
			)}
			{choice === "pr" && !pick.prListed && (
				<label className="sh-field">
					<span className="sh-field-label">Pull request number</span>
					<input
						className="sh-input sh-subject-input sh-subject-number"
						type="text"
						inputMode="numeric"
						autoComplete="off"
						placeholder="#123"
						value={pick.prText}
						onChange={e => pick.pickPr(parsePrNumber(e.target.value), e.target.value)}
					/>
					<span className="sh-field-hint">
						{refs.status === "error"
							? `The open pull requests could not be listed (${refs.message}). Type the number of one.`
							: "The open pull requests could not be listed here. Type the number of one."}
					</span>
				</label>
			)}
			{(choice === "changes" || choice === "branch" || choice === "pr") && (
				<div className="sh-field">
					<span className="sh-field-label">{summaryLabel}</span>
					{choice === "changes" ? (
						<div className="sh-subject">
							<GitCompare size={16} aria-hidden="true" />
							<div>
								<div className="sh-subject-title">What this session changed</div>
								<div className="sh-subject-meta">
									<code>{shortenPath(cwd)}</code>: the files as they are now, uncommitted changes included,
									compared with the default branch.
								</div>
							</div>
						</div>
					) : choice === "branch" ? (
						<div className="sh-subject">
							<GitBranch size={16} aria-hidden="true" />
							<div>
								<div className="sh-subject-title">
									{pick.effectiveBranch === "" ? "No branch picked yet" : pick.effectiveBranch}
								</div>
								<div className="sh-subject-meta">
									<code>{shortenPath(cwd)}</code>: what this branch changed, compared with the default branch.
								</div>
							</div>
						</div>
					) : (
						<div className="sh-subject">
							<GitPullRequest size={16} aria-hidden="true" />
							<div>
								<div className="sh-subject-title">
									{pr === null ? "No pull request picked yet" : `#${pr} ${pick.prTitle}`}
								</div>
								<div className="sh-subject-meta">
									<code>{shortenPath(cwd)}</code>
								</div>
							</div>
						</div>
					)}
				</div>
			)}
			{stacks && choice === "pr" && pr !== null && (
				<div className="sh-field">
					<span className="sh-field-label" id={`${ids}-scope`}>
						Scope
					</span>
					{!pick.stackSettled ? (
						<span className="sh-field-hint">
							<LoaderCircle size={12} className="sh-spin" /> Looking for a stack…
						</span>
					) : stack.length > 1 ? (
						<>
							<div className="sh-radios" role="radiogroup" aria-labelledby={`${ids}-scope`}>
								<label className="sh-radio">
									<input
										type="radio"
										name={`${ids}-scope`}
										checked={scope === "stack"}
										onChange={() => pick.setScope("stack")}
									/>
									<span>Whole stack ({stack.length} PRs, one part each)</span>
								</label>
								<label className="sh-radio">
									<input
										type="radio"
										name={`${ids}-scope`}
										checked={scope === "single"}
										onChange={() => pick.setScope("single")}
									/>
									<span>Only #{pr}</span>
								</label>
							</div>
							<ol className="sh-stack" aria-label="The stack, bottom first">
								{stack.map(item => (
									<li
										key={item.number}
										className={
											scope === "single" && item.number !== pr
												? "sh-stack-pr sh-stack-off"
												: item.number === pr
													? "sh-stack-pr sh-stack-here"
													: "sh-stack-pr"
										}
									>
										<span className="sh-stack-title">
											#{item.number} {item.title}
										</span>
										<span className="sh-stack-branches">
											{item.head} → {item.base}
										</span>
									</li>
								))}
							</ol>
						</>
					) : (
						<span className="sh-field-hint">
							{pick.stackError !== null
								? `Could not check for a stack (${pick.stackError}); only #${pr} is ${used}.`
								: `#${pr} is not part of a stack; one part is ${used}.`}
						</span>
					)}
				</div>
			)}
		</>
	);
}
