import { CornerDownRight, Send } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ReviewComment } from "../../lib/review-comments";

export interface SendBarProps {
	comments: Readonly<Record<string, ReviewComment>>;
	/** A view-only viewer: it cannot send, so the bar says so instead of offering to. */
	readOnly: boolean;
	onDiscard(): void;
	/** Sends the review as one prompt; throws when it could not go, which keeps the comments. */
	onSend(deliver: "follow-up" | undefined): void;
}

/** How long "Sent" stays up. */
const SENT_MS = 4000;

/** The comments waiting to go back to the agent, and the two ways to send them. */
export function SendBar({ comments, readOnly, onDiscard, onSend }: SendBarProps): ReactNode {
	const count = Object.keys(comments).length;
	const [discarding, setDiscarding] = useState(false);
	const [sent, setSent] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (sent === null) return;
		const timer = setTimeout(() => setSent(null), SENT_MS);
		return () => clearTimeout(timer);
	}, [sent]);
	useEffect(() => {
		if (count === 0) setDiscarding(false);
	}, [count]);

	const send = (deliver: "follow-up" | undefined): void => {
		try {
			onSend(deliver);
			setError(null);
			setSent(deliver === "follow-up" ? "Queued as a follow-up." : "Sent to the agent.");
		} catch (e) {
			setError(`Could not send: ${e instanceof Error ? e.message : String(e)}. Your comments are kept.`);
		}
	};

	if (readOnly) {
		return (
			<div className="sh-review-bar rb-send" role="group" aria-label="Review">
				<span className="sh-review-bar-text">View only: this link cannot send comments to the agent.</span>
			</div>
		);
	}
	if (count === 0) {
		return (
			<div className="sh-review-bar rb-send" role="group" aria-label="Review">
				<span className="sh-review-bar-text">
					{error ?? sent ?? "Tap lines to comment. Comments go back to the agent in one message."}
				</span>
			</div>
		);
	}
	return (
		<div className="sh-review-bar rb-send" role="group" aria-label="Review">
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
							onDiscard();
							setDiscarding(false);
						}}
					>
						Discard
					</button>
				</>
			) : (
				<>
					<span className="sh-review-bar-text">{error ?? `${count} comment${count === 1 ? "" : "s"}`}</span>
					<button type="button" className="sh-btn" onClick={() => setDiscarding(true)}>
						Discard
					</button>
					<button
						type="button"
						className="sh-btn"
						title="Send after the agent finishes what it is doing"
						onClick={() => send("follow-up")}
					>
						<CornerDownRight size={14} /> Queue as follow-up
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						title="Interrupt the agent's current work with these comments"
						onClick={() => send(undefined)}
					>
						<Send size={14} /> Steer now
					</button>
				</>
			)}
		</div>
	);
}
