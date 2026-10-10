import { LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionClient, PrReviewEvent } from "../../lib/companion";
import { toReviewComments } from "../../lib/pr-review";
import type { ReviewComment } from "../../lib/review-comments";
import { Sheet } from "./Sheet";
import "./review.css";
import "./pr-review.css";

export interface PrReviewSheetProps {
	client: CompanionClient;
	instanceId: string;
	number: number;
	/** The commit the comments were written against; the review is posted on it. */
	head: string;
	comments: Readonly<Record<string, ReviewComment>>;
	/** The review is on GitHub; `link` is its URL. */
	onPosted(link: string): void;
	onClose(): void;
}

const EVENTS: { value: PrReviewEvent; label: string; verb: string }[] = [
	{ value: "COMMENT", label: "Comment", verb: "comment" },
	{ value: "APPROVE", label: "Approve", verb: "approve" },
	{ value: "REQUEST_CHANGES", label: "Request changes", verb: "request changes on" },
];

/**
 * Confirm-first review: pick the verdict, write the summary, and see exactly what GitHub will receive
 * (as the signed-in user on the computer) before it is posted.
 */
export function PrReviewSheet({
	client,
	instanceId,
	number,
	head,
	comments,
	onPosted,
	onClose,
}: PrReviewSheetProps): ReactNode {
	const [event, setEvent] = useState<PrReviewEvent>("COMMENT");
	const [body, setBody] = useState("");
	const [posting, setPosting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inline = toReviewComments(comments);
	const verb = EVENTS.find(e => e.value === event)?.verb ?? "comment";
	// GitHub refuses a comment or a change request without a summary.
	const needsBody = event !== "APPROVE";
	const ready = !posting && (!needsBody || body.trim().length > 0);

	const post = async (): Promise<void> => {
		setPosting(true);
		setError(null);
		try {
			const link = await client.submitPrReview(instanceId, number, {
				event,
				body: body.trim(),
				comments: inline,
				commit: head,
			});
			onPosted(link);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPosting(false);
		}
	};

	return (
		<Sheet label="submit review" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<h2 className="sh-recents-title">Submit review · #{number}</h2>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close" title="close">
					<X size={15} />
				</button>
			</div>
			<div className="sh-review-confirm" role="group" aria-label="review">
				<div className="sh-segmented" role="radiogroup" aria-label="review verdict">
					{EVENTS.map(e => (
						<button
							key={e.value}
							type="button"
							role="radio"
							aria-checked={event === e.value}
							className={event === e.value ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setEvent(e.value)}
						>
							{e.label}
						</button>
					))}
				</div>
				<label className="sh-field">
					<span className="sh-field-label">Summary{needsBody ? "" : " (optional)"}</span>
					<textarea
						className="sh-input sh-review-textarea"
						rows={4}
						value={body}
						onChange={e => setBody(e.currentTarget.value)}
					/>
				</label>
				<div className="sh-field-label">This will be posted to GitHub as you:</div>
				<div className="sh-prr-post">
					<div>
						<strong>{verb}</strong> pull request #{number} at <code>{head.slice(0, 7)}</code>
					</div>
					{body.trim() !== "" && <div className="sh-prr-post-body">{body.trim()}</div>}
					{inline.length === 0 ? (
						<div className="sh-gh-muted">No inline comments.</div>
					) : (
						<ul className="sh-prr-post-list">
							{inline.map((c, i) => (
								<li key={`${c.path}:${c.startLine ?? ""}:${c.line}:${c.side}:${i}`}>
									<code>
										{c.path}:{c.startLine === undefined ? c.line : `${c.startLine}-${c.line}`}
										{c.side === "LEFT" ? " (removed)" : ""}
									</code>
									<div className="sh-prr-post-body">{c.body}</div>
								</li>
							))}
						</ul>
					)}
				</div>
				{error !== null && <div className="sh-connect-error sh-review-error">{error}</div>}
				<div className="sh-review-confirm-actions">
					<button type="button" className="sh-btn" onClick={onClose} disabled={posting}>
						Cancel
					</button>
					<button type="button" className="sh-btn sh-btn-primary" disabled={!ready} onClick={() => void post()}>
						{posting && <LoaderCircle size={14} className="sh-spin" />} Post review
					</button>
				</div>
			</div>
		</Sheet>
	);
}
