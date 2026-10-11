import type { SessionCommand, WirePrWatch } from "@oh-my-pi/pi-wire";
import { Eye, GitPullRequest, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import "./pr-watch.css";

export interface PrWatchProps {
	/** The pull requests the session watches (`state.prWatch`). */
	prs: readonly WirePrWatch[];
	/** This guest may start and stop watches (host feature `pr-watch`, write access, live). */
	canWatch: boolean;
	onSessionCommand(cmd: SessionCommand, arg?: string): void;
}

const CHECKS_LABEL: Record<WirePrWatch["checks"], string> = {
	passing: "checks passing",
	failing: "checks failing",
	pending: "checks running",
	none: "no checks",
};

const CHECKS_CLASS: Record<WirePrWatch["checks"], string> = {
	passing: "sh-prw-ok",
	failing: "sh-prw-bad",
	pending: "sh-prw-wait",
	none: "",
};

const STATE_LABEL: Record<WirePrWatch["state"], string> = { open: "open", merged: "merged", closed: "closed" };

/**
 * The pull requests linked to the session, each with status chips (checks, conflict, review) and a
 * button to stop watching, plus a field to watch another (empty: the host's current branch's pull
 * request). The host wakes the agent when a watched pull request needs it.
 */
export function PrWatch({ prs, canWatch, onSessionCommand }: PrWatchProps): ReactNode {
	const [target, setTarget] = useState("");

	const watch = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		onSessionCommand("pr-watch", target.trim());
		setTarget("");
	};

	return (
		<div className="sh-prw">
			{prs.length > 0 && (
				<ul className="sh-prw-list">
					{prs.map(pr => (
						<li key={pr.key} className="sh-prw-item">
							<span className="sh-prw-main">
								<GitPullRequest size={13} className="sh-prw-icon" />
								<a className="sh-sheet-link sh-prw-title" href={pr.url} target="_blank" rel="noreferrer">
									<span className="sh-prw-text">
										{pr.key}
										{pr.title && <span className="sh-sheet-faint"> {pr.title}</span>}
									</span>
								</a>
								{canWatch && (
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										aria-label={`Stop watching ${pr.key}`}
										title="Stop watching"
										onClick={() => onSessionCommand("pr-unwatch", pr.key)}
									>
										<X size={14} />
									</button>
								)}
							</span>
							<span className="sh-prw-chips">
								<span className="sh-chip">{STATE_LABEL[pr.state]}</span>
								<span className={`sh-chip ${CHECKS_CLASS[pr.checks]}`}>{CHECKS_LABEL[pr.checks]}</span>
								{pr.conflict && <span className="sh-chip sh-prw-bad">merge conflict</span>}
								{pr.review && (
									<span className={`sh-chip ${pr.review === "approved" ? "sh-prw-ok" : "sh-prw-bad"}`}>
										{pr.review === "approved" ? "approved" : "changes requested"}
									</span>
								)}
								{pr.queued && <span className="sh-chip sh-prw-wait">waiting to wake the agent</span>}
								{pr.wakes > 0 && <span className="sh-chip">woke the agent {pr.wakes}×</span>}
							</span>
							{pr.error && <span className="sh-prw-error">{pr.error}</span>}
						</li>
					))}
				</ul>
			)}
			{canWatch && (
				<form className="sh-prw-form" onSubmit={watch}>
					<input
						className="sh-sheet-input"
						value={target}
						onChange={e => setTarget(e.target.value)}
						placeholder="URL or owner/repo#N"
						aria-label="Pull request to watch"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
					/>
					<button
						type="submit"
						className="sh-btn sh-btn-primary"
						aria-label={target.trim() === "" ? "Watch this branch's pull request" : "Watch this pull request"}
					>
						<Eye size={13} /> {target.trim() === "" ? "Watch this branch" : "Watch"}
					</button>
				</form>
			)}
			<span className="sh-sheet-faint">
				A watched pull request wakes the agent when its required checks fail (with the failing log), someone else
				reviews or comments, or a conflict appears. Passing checks, merges and closes only notify.
				{canWatch && " Leave the field empty to watch this branch's pull request."}
			</span>
		</div>
	);
}
