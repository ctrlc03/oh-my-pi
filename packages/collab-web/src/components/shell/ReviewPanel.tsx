import { ExternalLink, GitBranch, GitPullRequest, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";
import type { CompanionClient, GitReview } from "../../lib/companion";
import { relTime } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import type { ToolRenderHost } from "../../tool-render";
import { TreeFile } from "./WorkingTree";
import "./review.css";

export interface ReviewPanelProps {
	client: CompanionClient;
	instanceId: string;
	host: ToolRenderHost;
	/** The companion can open pull requests (`gh` installed and signed in). */
	canPr: boolean;
	/** The session's agent is mid-turn (the companion refuses writes then) or unknown (null, an omp that predates the field). */
	busy: boolean | null;
	/** Session title: the suggested commit message and pull request title. */
	title: string | null;
}

type Step = "commit" | "push" | "pr";

const STEP_LABEL: Record<Step, string> = {
	commit: "Commit",
	push: "Push",
	pr: "Pull request",
};

const BUSY_REASON = "Agent is working; wait until it is idle";
const UNKNOWN_BUSY_REASON = "Agent state unknown; update omp on the computer";
const NO_PR_REASON = "gh is not installed or not signed in on the computer";

/** Double-quoted for the confirm preview, as a shell would take the text. */
function quote(text: string): string {
	return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** What to run for the chain "commit, push, open PR", skipping steps the branch no longer needs. */
function chainSteps(review: GitReview): Step[] {
	return [
		...(review.dirty ? (["commit"] as const) : []),
		...(review.dirty || !review.pushed ? (["push"] as const) : []),
		"pr",
	];
}

/** Why a step cannot run now, or null. */
function blockedReason(step: Step | "chain", review: GitReview, busy: boolean | null, canPr: boolean): string | null {
	if (busy === null) return UNKNOWN_BUSY_REASON;
	if (busy) return BUSY_REASON;
	if (review.branch === null) return "HEAD is detached; switch to a branch first";
	if (review.isDefaultBranch) return `${review.branch} is the base branch; work on another branch`;
	if (step === "commit") return review.dirty ? null : "Nothing to commit";
	if (step === "push") {
		if (review.remote === null) return "No origin remote";
		if (review.pushed) return "Already pushed";
		return review.commits.length === 0 ? "No commits to push" : null;
	}
	if (!canPr) return NO_PR_REASON;
	if (review.pr?.state === "OPEN") return "A pull request is already open";
	if (review.base === null) return "No base branch found (origin/HEAD, main or master)";
	if (step === "pr") return review.pushed ? null : "Push the branch first";
	if (review.remote === null) return "No origin remote";
	return review.files.length === 0 && review.commits.length === 0 ? "No changes against the base branch" : null;
}

/** The branch against its base: commits, changed files with diffs, and commit / push / pull request actions. */
export function ReviewPanel(props: ReviewPanelProps): ReactNode {
	const { client, instanceId } = props;
	const load = useCallback(() => client.requestReview(instanceId), [client, instanceId]);
	const { state, reload } = useRequest(load);
	// Keep showing the last review (and the inputs under it) while a refresh is in flight.
	const last = useRef<GitReview | null>(null);
	if (state.status === "ready") last.current = state.value;
	if (last.current === null) {
		if (state.status === "error") {
			return (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			);
		}
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Comparing with the base branch…
			</div>
		);
	}
	return (
		<ReviewView
			{...props}
			review={last.current}
			refreshing={state.status === "loading"}
			loadError={state.status === "error" ? state.message : null}
			onRefresh={reload}
		/>
	);
}

interface ReviewViewProps extends ReviewPanelProps {
	review: GitReview;
	refreshing: boolean;
	loadError: string | null;
	onRefresh(): void;
}

function ReviewView({ review, refreshing, loadError, onRefresh, ...props }: ReviewViewProps): ReactNode {
	const { client, instanceId, host, canPr, busy, title } = props;
	const [plan, setPlan] = useState<Step[] | null>(null);
	const [running, setRunning] = useState<Step | null>(null);
	const [message, setMessage] = useState(title ?? review.commits[0]?.subject ?? "");
	const [prTitle, setPrTitle] = useState(title ?? review.commits[0]?.subject ?? "");
	const [prBody, setPrBody] = useState("");
	const [draft, setDraft] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<{ text: string; url?: string } | null>(null);

	const loadDiff = useCallback((file: string) => client.requestReviewDiff(instanceId, file), [client, instanceId]);
	const baseName = review.base?.replace(/^origin\//, "") ?? "";
	const added = review.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
	const removedLines = review.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
	const [openFile, setOpenFile] = useState<string | null>(null);

	const commands = (step: Step): string => {
		switch (step) {
			case "commit":
				return `git add -A && git commit -m ${quote(message.trim())}`;
			case "push":
				return "git push -u origin HEAD";
			case "pr":
				return `gh pr create --base ${baseName} --head ${review.branch} --title ${quote(prTitle.trim())} --body ${quote(prBody)}${draft ? " --draft" : ""}`;
		}
	};

	const run = async (steps: Step[]): Promise<void> => {
		setPlan(null);
		setError(null);
		setDone(null);
		const finished: string[] = [];
		let url: string | undefined;
		for (const step of steps) {
			setRunning(step);
			try {
				if (step === "commit") await client.commitChanges(instanceId, message.trim());
				else if (step === "push") await client.pushBranch(instanceId);
				else url = await client.createPullRequest(instanceId, prTitle.trim(), prBody, draft);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				setError(
					`${STEP_LABEL[step]} failed: ${reason}${finished.length > 0 ? `\nDone before that: ${finished.join(", ")}` : ""}`,
				);
				setRunning(null);
				onRefresh();
				return;
			}
			finished.push(STEP_LABEL[step]);
		}
		setRunning(null);
		setDone({ text: `Done: ${finished.join(", ")}`, url });
		onRefresh();
	};

	const confirmReady =
		plan !== null &&
		(!plan.includes("commit") || message.trim().length > 0) &&
		(!plan.includes("pr") || prTitle.trim().length > 0);
	const chain = chainSteps(review);
	const actions: { label: string; steps: Step[]; reason: string | null; primary?: boolean }[] = [
		{ label: "Commit", steps: ["commit"], reason: blockedReason("commit", review, busy, canPr) },
		{ label: "Push", steps: ["push"], reason: blockedReason("push", review, busy, canPr) },
		{ label: "Create PR", steps: ["pr"], reason: blockedReason("pr", review, busy, canPr) },
		{
			label: "Commit, push & open PR",
			steps: chain,
			reason: blockedReason("chain", review, busy, canPr),
			primary: true,
		},
	];
	// Disabled actions grouped by why, so one cause reads once.
	const disabledReasons: Record<string, string[]> = {};
	for (const action of actions) if (action.reason !== null) (disabledReasons[action.reason] ??= []).push(action.label);

	return (
		<>
			<div className="sh-tree-head">
				<span className="sh-tree-branch">
					<GitBranch size={14} />
					<span className="sh-tree-branch-name">{review.branch ?? "detached HEAD"}</span>
					{review.base !== null && <span className="sh-tree-sync">→ {review.base}</span>}
				</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={onRefresh}
					disabled={refreshing || running !== null}
					aria-label="refresh review"
					title="refresh"
				>
					{refreshing ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
				</button>
			</div>
			<div className="sh-review-chips">
				<span className="sh-tree-sync">
					{review.files.length} file{review.files.length === 1 ? "" : "s"}
				</span>
				{added > 0 && <span className="sh-change-add">+{added}</span>}
				{removedLines > 0 && <span className="sh-change-del">−{removedLines}</span>}
				<span className="sh-tree-sync">
					{review.commits.length} commit{review.commits.length === 1 ? "" : "s"}
				</span>
				{review.dirty && <span className="sh-chip">uncommitted</span>}
				{!review.isDefaultBranch && <span className="sh-chip">{review.pushed ? "pushed" : "not pushed"}</span>}
				{review.worktree && <span className="sh-chip">worktree</span>}
				{review.pr !== null && (
					<a className="sh-chip sh-review-pr" href={review.pr.url} target="_blank" rel="noreferrer">
						<GitPullRequest size={12} /> #{review.pr.number} {review.pr.state.toLowerCase()}
					</a>
				)}
			</div>
			{review.remote !== null && <div className="sh-field-hint sh-review-remote">origin {review.remote}</div>}
			{loadError !== null && <div className="sh-connect-error">{loadError}</div>}

			<div className="sh-review-actions">
				{actions.map(action => (
					<button
						key={action.label}
						type="button"
						className={`sh-btn${action.primary ? " sh-btn-primary" : ""}`}
						disabled={action.reason !== null || running !== null}
						onClick={() => {
							setPlan(action.steps);
							setDone(null);
							setError(null);
						}}
					>
						{action.label}
					</button>
				))}
			</div>
			{plan === null && Object.keys(disabledReasons).length > 0 && (
				<ul className="sh-review-reasons">
					{Object.entries(disabledReasons).map(([reason, labels]) => (
						<li key={reason}>
							{labels.join(", ")}: {reason}
						</li>
					))}
				</ul>
			)}

			{plan !== null && (
				<div className="sh-review-confirm" role="group" aria-label="confirm">
					{plan.includes("commit") && (
						<label className="sh-field">
							<span className="sh-field-label">Commit message</span>
							<textarea
								className="sh-input sh-review-textarea"
								rows={3}
								value={message}
								onChange={e => setMessage(e.currentTarget.value)}
							/>
						</label>
					)}
					{plan.includes("pr") && (
						<>
							<label className="sh-field">
								<span className="sh-field-label">Pull request title</span>
								<input className="sh-input" value={prTitle} onChange={e => setPrTitle(e.currentTarget.value)} />
							</label>
							<label className="sh-field">
								<span className="sh-field-label">Description</span>
								<textarea
									className="sh-input sh-review-textarea"
									rows={4}
									value={prBody}
									onChange={e => setPrBody(e.currentTarget.value)}
								/>
							</label>
							<label className="sh-review-draft">
								<input type="checkbox" checked={draft} onChange={e => setDraft(e.currentTarget.checked)} />
								Open as draft
							</label>
						</>
					)}
					<div className="sh-field-label">This will run on your computer:</div>
					<pre className="sh-review-cmd">{plan.map(commands).join("\n")}</pre>
					<div className="sh-review-confirm-actions">
						<button type="button" className="sh-btn" onClick={() => setPlan(null)}>
							Cancel
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							disabled={!confirmReady}
							onClick={() => void run(plan)}
						>
							{plan.length > 1 ? `Run ${plan.length} steps` : "Run"}
						</button>
					</div>
				</div>
			)}
			{running !== null && (
				<div className="sh-companion-empty sh-file-status" role="status">
					<LoaderCircle size={14} className="sh-spin" /> {STEP_LABEL[running]}…
				</div>
			)}
			{error !== null && <div className="sh-connect-error sh-review-error">{error}</div>}
			{done !== null && (
				<div className="sh-review-done" role="status">
					{done.text}
					{done.url !== undefined && (
						<a href={done.url} target="_blank" rel="noreferrer" className="sh-review-link">
							<ExternalLink size={13} /> {done.url}
						</a>
					)}
				</div>
			)}

			{review.commits.length > 0 && (
				<section className="sh-switch-section" aria-label="branch commits">
					<h2 className="sh-recents-title">Commits on {review.branch ?? "HEAD"}</h2>
					<ul className="sh-commits">
						{review.commits.map(commit => (
							<li key={commit.hash} className="sh-commit">
								<span className="sh-commit-subject">{commit.subject}</span>
								<span className="sh-recent-meta">
									<span>{commit.hash.slice(0, 7)}</span>
									<span className="sh-recent-cwd">{commit.author}</span>
									<span>{relTime(commit.time)}</span>
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
			{review.files.length === 0 ? (
				<div className="sh-companion-empty">No changes against {review.base ?? "HEAD"}.</div>
			) : (
				<ul className="sh-changes">
					{review.files.map(file => (
						<TreeFile
							key={file.path}
							file={file}
							root={review.root}
							loadDiff={loadDiff}
							host={host}
							expanded={openFile === file.path}
							onToggle={() => setOpenFile(openFile === file.path ? null : file.path)}
						/>
					))}
				</ul>
			)}
		</>
	);
}
