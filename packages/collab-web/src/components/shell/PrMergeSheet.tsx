import { LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionClient, GithubCheckState, GithubItemDetail, PrMergeMethod } from "../../lib/companion";
import { Sheet } from "./Sheet";
import "./review.css";
import "./pr-review.css";

export interface PrMergeSheetProps {
	client: CompanionClient;
	instanceId: string;
	pr: GithubItemDetail;
	/** The pull request is merged. */
	onMerged(): void;
	onClose(): void;
}

const METHODS: { value: PrMergeMethod; label: string }[] = [
	{ value: "squash", label: "Squash" },
	{ value: "merge", label: "Merge commit" },
	{ value: "rebase", label: "Rebase" },
];

const CHECKS: Record<GithubCheckState | "none", { label: string; tone: string }> = {
	pass: { label: "All checks passed", tone: "ok" },
	pending: { label: "Checks are still running", tone: "warn" },
	fail: { label: "Checks are failing", tone: "err" },
	none: { label: "No checks", tone: "faint" },
};

/** `o/r` of a pull request's page (`https://github.com/o/r/pull/7`); empty when the URL has another shape. */
function repoOf(url: string): string {
	const match = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
	return match?.[1] ?? "";
}

/**
 * Confirm-first merge: the method, whether the branch is deleted, the checks as they are, and the exact
 * commands. A draft, failing checks and running checks each need their own tick: the companion refuses the
 * merge otherwise. The pull request is frozen as it was when the sheet opened (a refresh underneath must not
 * change what is being confirmed), and the merge is pinned to that head commit.
 */
export function PrMergeSheet({ client, instanceId, pr: opened, onMerged, onClose }: PrMergeSheetProps): ReactNode {
	const [pr] = useState(opened);
	const [method, setMethod] = useState<PrMergeMethod>("squash");
	const [deleteBranch, setDeleteBranch] = useState(false);
	const [allowDraft, setAllowDraft] = useState(false);
	const [allowFailing, setAllowFailing] = useState(false);
	const [allowPending, setAllowPending] = useState(false);
	const [merging, setMerging] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const checks = CHECKS[pr.checks ?? "none"];
	const head = pr.head;
	const blocked =
		head === undefined ||
		(pr.draft && !allowDraft) ||
		(pr.checks === "fail" && !allowFailing) ||
		(pr.checks === "pending" && !allowPending);

	const repo = repoOf(pr.url);
	const target = `${pr.number}${repo ? ` --repo ${repo}` : ""}`;
	const commands = [
		...(pr.draft && allowDraft ? [`gh pr ready ${target}`] : []),
		`gh pr merge ${target} --${method} --match-head-commit ${head?.slice(0, 7) ?? "?"}${deleteBranch ? " --delete-branch" : ""}`,
	];

	const merge = async (): Promise<void> => {
		if (head === undefined) return;
		setMerging(true);
		setError(null);
		try {
			await client.mergePr(instanceId, pr.number, {
				method,
				deleteBranch,
				head,
				allowDraft,
				allowFailing,
				allowPending,
			});
			onMerged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setMerging(false);
		}
	};

	return (
		<Sheet label="merge pull request" onClose={onClose}>
			<div className="sh-sheet-head">
				<h2 className="sh-recents-title">
					Merge #{pr.number} · {pr.title}
				</h2>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close" title="Close">
					<X size={15} />
				</button>
			</div>
			<div className="sh-review-confirm" role="group" aria-label="Merge">
				{pr.branch && (
					<div className="sh-gh-branch">
						<code>{pr.branch.head}</code> → <code>{pr.branch.base}</code>
					</div>
				)}
				<div className={`sh-prr-checks sh-prr-checks-${checks.tone}`}>{checks.label}</div>
				<div className="sh-segmented" role="radiogroup" aria-label="Merge method">
					{METHODS.map(m => (
						<button
							key={m.value}
							type="button"
							role="radio"
							aria-checked={method === m.value}
							className={method === m.value ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setMethod(m.value)}
						>
							{m.label}
						</button>
					))}
				</div>
				<label className="sh-review-draft">
					<input type="checkbox" checked={deleteBranch} onChange={e => setDeleteBranch(e.currentTarget.checked)} />
					Delete the branch on GitHub after merging
				</label>
				{pr.draft && (
					<label className="sh-review-draft sh-prr-override">
						<input type="checkbox" checked={allowDraft} onChange={e => setAllowDraft(e.currentTarget.checked)} />
						This is a draft: mark it ready for review, then merge
					</label>
				)}
				{pr.checks === "fail" && (
					<label className="sh-review-draft sh-prr-override">
						<input
							type="checkbox"
							checked={allowFailing}
							onChange={e => setAllowFailing(e.currentTarget.checked)}
						/>
						Merge even though checks are failing
					</label>
				)}
				{pr.checks === "pending" && (
					<label className="sh-review-draft sh-prr-override">
						<input
							type="checkbox"
							checked={allowPending}
							onChange={e => setAllowPending(e.currentTarget.checked)}
						/>
						Merge while checks are still running
					</label>
				)}
				{head !== undefined && (
					<div className="sh-field-hint">
						Merges commit <code>{head.slice(0, 7)}</code>. If more commits are pushed first, the merge is refused.
					</div>
				)}
				<div className="sh-field-label">This will run on your computer, against GitHub:</div>
				<pre className="sh-review-cmd">{commands.join("\n")}</pre>
				{error !== null && <div className="sh-connect-error sh-review-error">{error}</div>}
				<div className="sh-review-confirm-actions">
					<button type="button" className="sh-btn" onClick={onClose} disabled={merging}>
						Cancel
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={blocked || merging}
						onClick={() => void merge()}
					>
						{merging && <LoaderCircle size={14} className="sh-spin" />} Merge
					</button>
				</div>
			</div>
		</Sheet>
	);
}
