import { ChevronRight, GraduationCap, Swords, Trophy, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { FileChange } from "../../lib/changes";
import type { CompanionClient } from "../../lib/companion";
import { splitPath } from "../../lib/format";
import {
	buildReviewPrompt,
	commentId,
	type DiffReview,
	loadReviewComments,
	type ReviewComment,
	saveReviewComments,
} from "../../lib/review-comments";
import { type ToolRenderHost, ToolView } from "../../tool-render";
import { Sheet } from "./Sheet";
import { ReviewPanel } from "./ReviewPanel";
import { WorkingTree } from "./WorkingTree";

/** The paired computer's companion host for this session: enables the working tree. */
export interface ChangesTree {
	client: CompanionClient;
	instanceId: string;
	/** The companion can open pull requests. */
	canPr: boolean;
	/** The companion writes commit and pull request text (`git-message`). */
	canGitFlow: boolean;
	/** The session's agent is mid-turn. */
	busy: boolean | null;
	/** Session title, offered as the commit message and pull request title. */
	title: string | null;
}

export interface ChangesSheetProps {
	changes: readonly FileChange[];
	host: ToolRenderHost;
	/** null: no companion host for this session, so only the agent's own edits are known. */
	tree: ChangesTree | null;
	/** Keys the unsent review in storage; null: nothing is remembered. */
	sessionId: string | null;
	/** Puts the review prompt into the composer. null (read-only viewer): no commenting. */
	onSendToAgent: ((text: string) => void) | null;
	/** Start a quiz on this session's changes; null unless the paired computer can write quizzes. */
	onQuiz?: (() => void) | null;
	/** Open a quiz by id, on the computer that runs this session (the one a blocked push needs); null unless the paired computer can write quizzes. */
	onOpenQuiz?: ((id: string) => void) | null;
	/** Start a sparring session on this session's changes; null unless the paired computer can spar. */
	onSpar?: (() => void) | null;
	/** Start a bake-off on this session's changes; null unless the paired computer can run bake-offs. */
	onBakeoff?: (() => void) | null;
	onClose(): void;
	/** Open on the branch review (commit, push, pull request), e.g. after keeping a model comparison's winner. */
	initialTab?: "branch";
}

type Tab = "agent" | "tree" | "branch";

/**
 * What changed: the agent's edit-tool calls from the transcript, and, when the
 * session's computer is paired, the repository's working tree.
 */
export function ChangesSheet({
	changes,
	host,
	tree,
	sessionId,
	onSendToAgent,
	onQuiz,
	onOpenQuiz,
	onSpar,
	onBakeoff,
	onClose,
	initialTab,
}: ChangesSheetProps): ReactNode {
	const [tab, setTab] = useState<Tab>(initialTab ?? (changes.length === 0 && tree !== null ? "tree" : "agent"));
	const [comments, setComments] = useState<Record<string, ReviewComment>>(() =>
		onSendToAgent === null || sessionId === null || tree === null ? {} : loadReviewComments(sessionId),
	);
	const [discarding, setDiscarding] = useState(false);
	const change = (next: Record<string, ReviewComment>): void => {
		setComments(next);
		if (sessionId !== null) saveReviewComments(sessionId, next);
	};
	// Comments live here, not in the diff views, so they outlive switching files and tabs.
	const review: DiffReview | null =
		onSendToAgent === null || tree === null
			? null
			: {
					comments,
					save: comment => change({ ...comments, [commentId(comment)]: comment }),
					remove: id => change(Object.fromEntries(Object.entries(comments).filter(([key]) => key !== id))),
				};
	const count = Object.keys(comments).length;
	const send = (): void => {
		if (onSendToAgent === null) return;
		onSendToAgent(buildReviewPrompt(Object.values(comments)));
		change({});
	};
	return (
		<Sheet label="changes" size="wide" onClose={onClose}>
			<div className="sh-sheet-head sh-changes-head">
				<div className="sh-sheet-title">
					{tree === null
						? `${changes.length} file${changes.length === 1 ? "" : "s"} changed`
						: tab === "agent"
							? "Agent edits"
							: tab === "tree"
								? "Working tree"
								: "Branch review"}
				</div>
				<span className="sh-sheet-head-actions">
					{onQuiz && (
						<button type="button" className="sh-btn" onClick={onQuiz}>
							<GraduationCap size={14} /> Quiz me
						</button>
					)}
					{onSpar && (
						<button type="button" className="sh-btn" onClick={onSpar}>
							<Swords size={14} /> Spar with this change
						</button>
					)}
					{onBakeoff && (
						<button type="button" className="sh-btn" onClick={onBakeoff}>
							<Trophy size={14} /> Bake off this change
						</button>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{tree !== null && (
				<div className="sh-tabs" role="tablist" aria-label="Changes view">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "agent"}
						className="sh-tab"
						onClick={() => setTab("agent")}
					>
						Agent edits{changes.length > 0 && <span className="sh-tab-count">{changes.length}</span>}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "tree"}
						className="sh-tab"
						onClick={() => setTab("tree")}
					>
						Working tree
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "branch"}
						className="sh-tab"
						onClick={() => setTab("branch")}
					>
						Branch
					</button>
				</div>
			)}
			{tab === "tree" && tree !== null ? (
				<WorkingTree client={tree.client} instanceId={tree.instanceId} host={host} review={review} />
			) : tab === "branch" && tree !== null ? (
				<ReviewPanel
					client={tree.client}
					instanceId={tree.instanceId}
					host={host}
					canPr={tree.canPr}
					canGitFlow={tree.canGitFlow}
					busy={tree.busy}
					title={tree.title}
					diffReview={review}
					onOpenQuiz={onOpenQuiz ?? null}
				/>
			) : (
				<AgentEdits changes={changes} host={host} />
			)}
			{review !== null && count > 0 && (
				<div className="sh-review-bar" role="group" aria-label="Review">
					{discarding ? (
						<>
							<span className="sh-review-bar-text">
								Discard {count === 1 ? "the comment" : `all ${count} comments`}?
							</span>
							<button type="button" className="sh-btn" onClick={() => setDiscarding(false)}>
								Keep
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => {
									change({});
									setDiscarding(false);
								}}
							>
								Discard
							</button>
						</>
					) : (
						<>
							<span className="sh-review-bar-text">
								{count} comment{count === 1 ? "" : "s"}
							</span>
							<button type="button" className="sh-btn" onClick={() => setDiscarding(true)}>
								Discard
							</button>
							<button type="button" className="sh-btn sh-btn-primary" onClick={send}>
								Send to agent
							</button>
						</>
					)}
				</div>
			)}
		</Sheet>
	);
}

/** Files the agent changed through its edit tools; tap a file for each change's diff. */
function AgentEdits({ changes, host }: { changes: readonly FileChange[]; host: ToolRenderHost }): ReactNode {
	const [open, setOpen] = useState<string | null>(changes.length === 1 ? (changes[0]?.path ?? null) : null);
	if (changes.length === 0) {
		return <div className="sh-companion-empty">The agent has not edited any files in this session yet.</div>;
	}
	return (
		<ul className="sh-changes">
			{changes.map(file => {
				const expanded = open === file.path;
				const { dir, base } = splitPath(file.path);
				return (
					<li key={file.path} className="sh-change">
						<button
							type="button"
							className="sh-change-head"
							onClick={() => setOpen(expanded ? null : file.path)}
							aria-expanded={expanded}
							title={file.path}
						>
							<ChevronRight size={14} className={expanded ? "tr-chev tr-chev--open" : "tr-chev"} />
							<span className="sh-change-path">
								<span className="sh-change-dir">{dir}</span>
								<span className="sh-change-base">{base}</span>
							</span>
							{file.added > 0 && <span className="sh-change-add">+{file.added}</span>}
							{file.removed > 0 && <span className="sh-change-del">−{file.removed}</span>}
						</button>
						{expanded && (
							<div className="sh-change-body">
								{file.calls.map(call => (
									<ToolView
										key={call.id}
										name={call.name}
										args={call.args}
										intent={call.intent}
										result={call.result}
										host={host}
										defaultOpen
									/>
								))}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}
