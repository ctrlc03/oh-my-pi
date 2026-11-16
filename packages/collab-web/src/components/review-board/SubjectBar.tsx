import { ChevronRight, GitMerge, GitPullRequest, GitPullRequestClosed, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { PrOwnDiff, StackPr } from "../../lib/review-board";
import type { PromptTurn } from "../../lib/turn-changes";
import type { Load } from "./board-data";

export type BoardView = "pr" | "branch" | "session";

export interface SubjectBarProps {
	view: BoardView;
	/** The views this session can offer. */
	views: readonly BoardView[];
	onView(view: BoardView): void;
	turns: readonly PromptTurn[];
	/** The turn shown; undefined: the whole session. */
	entryId: string | undefined;
	onEntry(entryId: string | undefined): void;
	stack: Load<StackPr[]>;
	diffs: Readonly<Record<number, Load<PrOwnDiff>>>;
	/** The PR shown, or null while one is being picked. */
	current: number | null;
	onPr(number: number): void;
}

const VIEW_LABELS: Record<BoardView, string> = { pr: "Pull request", branch: "Branch", session: "Session" };

function StateIcon({ state }: { state: StackPr["state"] }): ReactNode {
	if (state === "merged") return <GitMerge size={13} className="rb-state-merged" aria-label="merged" />;
	if (state === "closed") return <GitPullRequestClosed size={13} className="rb-state-closed" aria-label="closed" />;
	return <GitPullRequest size={13} className="rb-state-open" aria-label="open" />;
}

/** The PRs of a stack, bottom first, each with its own +/-; the one shown is marked. */
function StackNav({
	stack,
	diffs,
	current,
	onPr,
}: Pick<SubjectBarProps, "stack" | "diffs" | "current" | "onPr">): ReactNode {
	if (stack.status === "loading") {
		return (
			<div className="rb-stack rb-working">
				<LoaderCircle size={14} className="sh-spin" /> Reading the stack…
			</div>
		);
	}
	if (stack.status === "error")
		return <div className="rb-stack rb-error">Could not read the stack: {stack.message}</div>;
	const prs = stack.value;
	const at = prs.findIndex(pr => pr.number === current);
	return (
		<div className="rb-stack" role="group" aria-label="Pull requests in the stack, bottom first">
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				disabled={at <= 0}
				aria-label="Previous pull request, one down the stack"
				onClick={() => onPr(prs[at - 1]!.number)}
			>
				<ChevronRight size={16} className="sh-tc-flip" />
			</button>
			<ol className="rb-chips">
				{prs.map((pr, i) => {
					const own = diffs[pr.number];
					return (
						<li key={pr.number}>
							<button
								type="button"
								className="rb-chip"
								aria-current={pr.number === current ? "true" : undefined}
								title={`#${pr.number} ${pr.title} · ${pr.head} → ${pr.base}`}
								onClick={() => onPr(pr.number)}
							>
								<span className="rb-chip-pos">{i + 1}</span>
								<StateIcon state={pr.state} />
								<span className="rb-chip-num">#{pr.number}</span>
								<span className="rb-chip-title">{pr.title}</span>
								{own?.status === "ready" && (
									<span className="rb-chip-size">
										<span className="sh-change-add">
											+{own.value.files.reduce((sum, f) => sum + f.added, 0)}
										</span>{" "}
										<span className="sh-change-del">
											−{own.value.files.reduce((sum, f) => sum + f.removed, 0)}
										</span>
									</span>
								)}
								{own?.status === "loading" && <LoaderCircle size={12} className="sh-spin" />}
							</button>
						</li>
					);
				})}
			</ol>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				disabled={at === -1 || at >= prs.length - 1}
				aria-label="Next pull request, one up the stack"
				onClick={() => onPr(prs[at + 1]!.number)}
			>
				<ChevronRight size={16} />
			</button>
		</div>
	);
}

/** What the board shows: a PR of a stack, the branch, or the session (or one of its turns). */
export function SubjectBar(props: SubjectBarProps): ReactNode {
	const { view, views, onView, turns, entryId, onEntry } = props;
	return (
		<div className="rb-subject">
			<div className="rb-subject-row">
				{views.length > 1 && (
					<div className="sh-segmented" role="radiogroup" aria-label="What to review">
						{views.map(value => (
							<button
								key={value}
								type="button"
								role="radio"
								aria-checked={view === value}
								className={view === value ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => onView(value)}
							>
								{VIEW_LABELS[value]}
							</button>
						))}
					</div>
				)}
				{view === "session" && (
					<select
						className="sh-input rb-turn-select"
						aria-label="Whole session or one turn"
						value={entryId ?? ""}
						onChange={e => onEntry(e.currentTarget.value === "" ? undefined : e.currentTarget.value)}
					>
						<option value="">Whole session</option>
						{turns.map(turn => (
							<option key={turn.id} value={turn.id}>
								Turn {turn.turn}
								{turn.label === "" ? "" : ` · ${turn.label}`}
							</option>
						))}
					</select>
				)}
			</div>
			{view === "pr" && props.current !== null && (
				<StackNav stack={props.stack} diffs={props.diffs} current={props.current} onPr={props.onPr} />
			)}
		</div>
	);
}
