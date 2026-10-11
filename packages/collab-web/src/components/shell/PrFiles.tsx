import { ChevronRight, LoaderCircle, MessageSquare, RefreshCw, SendHorizontal, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, PrFile } from "../../lib/companion";
import { splitPath } from "../../lib/format";
import { countByPath, loadPrComments, prReviewPrompt, savePrComments } from "../../lib/pr-review";
import { commentId, type DiffReview, type ReviewComment } from "../../lib/review-comments";
import { useRequest } from "../../lib/use-request";
import { PrReviewSheet } from "./PrReviewSheet";
import { UnifiedDiff } from "./ReviewDiff";
import "./review.css";
import "./pr-review.css";

export interface PrFilesProps {
	client: CompanionClient;
	instanceId: string;
	number: number;
	/** The pull request's page: keys its unsent comments on this device. */
	url: string;
	/** Put a prompt into the composer; null on a view-only link, where nothing can be commented or sent. */
	onSendToAgent: ((prompt: string) => void) | null;
	/** Reviews may be posted to GitHub from here: not view-only, not a sandboxed session. */
	canSubmit: boolean;
}

const STATUS: Record<PrFile["status"], { letter: string; tone: string; label: string }> = {
	added: { letter: "A", tone: "add", label: "added" },
	removed: { letter: "D", tone: "del", label: "removed" },
	modified: { letter: "M", tone: "mod", label: "modified" },
	renamed: { letter: "R", tone: "move", label: "renamed" },
	copied: { letter: "C", tone: "add", label: "copied" },
	changed: { letter: "M", tone: "mod", label: "changed" },
};

/**
 * The files a pull request changes, each opening its diff; lines can be commented. Comments stay on the device
 * per pull request until they are handed to the agent as one prompt or posted to GitHub as one review.
 */
export function PrFiles({ client, instanceId, number, url, onSendToAgent, canSubmit }: PrFilesProps): ReactNode {
	const load = useCallback(() => client.requestPrFiles(instanceId, number), [client, instanceId, number]);
	const { state, reload } = useRequest(load);
	const [comments, setComments] = useState<Record<string, ReviewComment>>(() => loadPrComments(url));
	const [open, setOpen] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [posted, setPosted] = useState<string | null>(null);

	const change = (next: Record<string, ReviewComment>): void => {
		setComments(next);
		savePrComments(url, next);
	};
	const review: DiffReview | null =
		onSendToAgent === null
			? null
			: {
					comments,
					save: comment => change({ ...comments, [commentId(comment)]: comment }),
					remove: id => change(Object.fromEntries(Object.entries(comments).filter(([key]) => key !== id))),
				};
	const count = Object.keys(comments).length;
	const perFile = countByPath(comments);

	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading files…
			</div>
		);
	}
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
	const { head, files } = state.value;

	return (
		<div className="sh-prr">
			{files.length === 0 ? (
				<div className="sh-companion-empty">No changed files.</div>
			) : (
				<ul className="sh-changes">
					{files.map(file => {
						const { dir, base } = splitPath(file.path);
						const badge = STATUS[file.status];
						const expanded = open === file.path;
						const notes = perFile.get(file.path) ?? 0;
						return (
							<li key={file.path} className="sh-change">
								<button
									type="button"
									className="sh-change-head"
									onClick={() => setOpen(expanded ? null : file.path)}
									aria-expanded={expanded}
									title={file.from ? `${file.from} → ${file.path}` : file.path}
								>
									<ChevronRight size={14} className={expanded ? "tr-chev tr-chev--open" : "tr-chev"} />
									<span className={`sh-status-badge sh-status-badge-${badge.tone}`} aria-label={badge.label}>
										{badge.letter}
									</span>
									<span className="sh-change-path">
										<span className="sh-change-dir">{dir}</span>
										<span className="sh-change-base">{base}</span>
									</span>
									{notes > 0 && (
										<span className="sh-prr-notes" title={`${notes} comment${notes === 1 ? "" : "s"}`}>
											<MessageSquare size={12} /> {notes}
										</span>
									)}
									{file.additions > 0 && <span className="sh-change-add">+{file.additions}</span>}
									{file.deletions > 0 && <span className="sh-change-del">−{file.deletions}</span>}
								</button>
								{expanded && (
									<div className="sh-change-body">
										<FileDiff
											client={client}
											instanceId={instanceId}
											number={number}
											head={head}
											path={file.path}
											review={review}
										/>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{posted !== null && (
				<div className="sh-review-done" role="status">
					Review posted.
					{posted !== "" && (
						<a href={posted} target="_blank" rel="noreferrer" className="sh-review-link">
							{posted}
						</a>
					)}
				</div>
			)}
			{(review !== null || canSubmit) && (
				<div className="sh-prr-bar" role="group" aria-label="Review">
					<span className="sh-prr-count">
						{count} comment{count === 1 ? "" : "s"}
					</span>
					{onSendToAgent !== null && (
						<button
							type="button"
							className="sh-btn"
							disabled={count === 0}
							onClick={() => onSendToAgent(prReviewPrompt(number, comments))}
							title="Put these comments into the message box, to edit and send"
						>
							<SendHorizontal size={15} /> Send to agent
						</button>
					)}
					{canSubmit && (
						<button type="button" className="sh-btn sh-btn-primary" onClick={() => setSubmitting(true)}>
							<Upload size={15} /> Submit review
						</button>
					)}
				</div>
			)}
			{submitting && (
				<PrReviewSheet
					client={client}
					instanceId={instanceId}
					number={number}
					head={head}
					comments={comments}
					onPosted={link => {
						change({});
						setPosted(link);
						setSubmitting(false);
					}}
					onClose={() => setSubmitting(false)}
				/>
			)}
		</div>
	);
}

interface FileDiffProps {
	client: CompanionClient;
	instanceId: string;
	number: number;
	head: string;
	path: string;
	review: DiffReview | null;
}

function FileDiff({ client, instanceId, number, head, path, review }: FileDiffProps): ReactNode {
	const load = useCallback(
		() => client.requestPrDiff(instanceId, number, head, path),
		[client, instanceId, number, head, path],
	);
	const { state } = useRequest(load);
	if (state.status === "error") return <div className="sh-connect-error">{state.message}</div>;
	if (state.status !== "ready") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading diff…
			</div>
		);
	}
	return (
		<>
			<UnifiedDiff diff={state.value.diff} scope="pr" path={path} review={review} />
			{state.value.truncated && <div className="sh-file-note">The diff is longer than the viewer reads.</div>}
		</>
	);
}
