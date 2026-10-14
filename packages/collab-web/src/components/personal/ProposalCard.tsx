import type { PersonalProposal } from "@oh-my-pi/pi-wire/personal";
import { MAX_PROPOSAL_TEXT_CHARS } from "@oh-my-pi/pi-wire/personal-ipc";
import { Check, LoaderCircle, Pencil, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { relTime } from "../../lib/format";
import { evidenceLabel, PROPOSAL_STATUS, proposalRows, proposalTitle, proposalWhen } from "../../lib/personal-activity";
import { usePersonal } from "../../lib/use-personal";
import { useAction } from "./shared";
import "./activity.css";

export interface ProposalCardProps {
	proposal: PersonalProposal;
	/** The proposal after the owner's action (what the companion answered). */
	onChanged?(proposal: PersonalProposal): void;
}

/**
 * One proposed change to About you: what it does in words, the lines it touches, why the agent proposes it, and (while
 * pending) Accept, Edit and Reject. Nothing in About you changes until Accept.
 */
export function ProposalCard({ proposal: given, onChanged }: ProposalCardProps): ReactNode {
	const personal = usePersonal();
	// What the companion answered stays on screen until the list brings a newer copy.
	const [answered, setAnswered] = useState<{ from: PersonalProposal; value: PersonalProposal } | null>(null);
	const proposal = answered !== null && answered.from === given ? answered.value : given;
	const [draft, setDraft] = useState<string | null>(null);
	const [applied, setApplied] = useState(true);
	const accept = useAction();
	const save = useAction();
	const reject = useAction();
	const busy = accept.busy || save.busy || reject.busy;
	const error = accept.error ?? save.error ?? reject.error;

	const adopt = (next: PersonalProposal): void => {
		setAnswered({ from: given, value: next });
		onChanged?.(next);
	};
	const edit = async (text: string): Promise<void> => {
		if (text === proposal.text) return;
		adopt((await personal.call({ t: "personal-proposal-edit", id: proposal.id, text })).proposal);
	};
	const doAccept = (edited?: string): void => {
		void accept.run(async () => {
			if (edited !== undefined) await edit(edited);
			const reply = await personal.call({ t: "personal-proposal-accept", id: proposal.id });
			setApplied(reply.applied);
			setDraft(null);
			adopt(reply.proposal);
		});
	};
	const doSave = (text: string): void => {
		void save.run(async () => {
			await edit(text);
			setDraft(null);
		});
	};
	const doReject = (): void => {
		void reject.run(async () => {
			adopt((await personal.call({ t: "personal-proposal-reject", id: proposal.id })).proposal);
		});
	};

	const status = PROPOSAL_STATUS[proposal.status];
	const title = proposalTitle(proposal);
	const rows = proposalRows(proposal);
	const evidence = evidenceLabel(proposal.evidence?.length ?? 0);
	const pending = proposal.status === "pending";
	const text = draft?.trim() ?? "";

	return (
		<article className="pa-card pa-prop" aria-label={title}>
			<div className="pa-card-head">
				<h3 className="pa-card-title">{title}</h3>
				<span className="pa-act-meta">
					{proposal.edited && <span className="pa-act-tag pa-act-tag-idle">Edited by you</span>}
					{!pending && <span className={`pa-act-tag pa-act-tag-${status.tone}`}>{status.label}</span>}
					<span>{relTime(proposalWhen(proposal))}</span>
				</span>
			</div>
			{proposal.fromExternal && (
				<div className="pa-note pa-note-warn" role="note">
					The agent proposed this after reading outside content (web, email, an event). Check it carefully before
					accepting.
				</div>
			)}
			{rows.length > 0 && (
				<div className="pa-diff" role="list" aria-label="The change to About you">
					{rows.map((row, i) => (
						<div
							key={i}
							role="listitem"
							className={`pa-diff-row pa-diff-${row.op}`}
							aria-label={`${row.word}: ${row.text}`}
						>
							<span className="pa-diff-mark" aria-hidden="true">
								{row.marker}
							</span>
							<span className="pa-diff-text">{row.text}</span>
						</div>
					))}
				</div>
			)}
			{proposal.rationale !== "" && <blockquote className="pa-prop-why">“{proposal.rationale}”</blockquote>}
			{evidence !== null && <div className="sh-field-hint">{evidence}</div>}
			{!applied && (
				<div className="pa-note pa-note-warn" role="status">
					The line this points to has changed, so nothing was applied. Check About you and propose again.
				</div>
			)}
			{pending && draft !== null && (
				<div className="sh-field">
					<label className="sh-field-label" htmlFor={`pa-prop-edit-${proposal.id}`}>
						{proposal.op === "replace" ? "The replacement line" : "The line to add"}
					</label>
					<textarea
						id={`pa-prop-edit-${proposal.id}`}
						className="sh-input pa-prop-edit"
						value={draft}
						rows={3}
						maxLength={MAX_PROPOSAL_TEXT_CHARS}
						disabled={busy}
						onChange={e => setDraft(e.currentTarget.value.replace(/\s*\n\s*/g, " "))}
					/>
					<div className="sh-field-hint">
						One line. Saving keeps the proposal waiting; accepting writes it to About you.
					</div>
				</div>
			)}
			{pending && draft !== null ? (
				<div className="pa-actions">
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={busy || text === ""}
						onClick={() => doAccept(text)}
					>
						{accept.busy ? <LoaderCircle size={14} className="sh-spin" /> : <Check size={14} />} Accept this edit
					</button>
					<button
						type="button"
						className="sh-btn"
						disabled={busy || text === "" || text === proposal.text}
						onClick={() => doSave(text)}
					>
						{save.busy && <LoaderCircle size={14} className="sh-spin" />} Save and keep pending
					</button>
					<button type="button" className="sh-btn" disabled={busy} onClick={() => setDraft(null)}>
						Cancel
					</button>
				</div>
			) : (
				pending && (
					<>
						<div className="pa-actions">
							<button type="button" className="sh-btn sh-btn-primary" disabled={busy} onClick={() => doAccept()}>
								{accept.busy ? <LoaderCircle size={14} className="sh-spin" /> : <Check size={14} />} Accept
							</button>
							{proposal.op !== "remove" && (
								<button
									type="button"
									className="sh-btn"
									disabled={busy}
									onClick={() => setDraft(proposal.text)}
									aria-label="Edit the proposed line"
								>
									<Pencil size={14} /> Edit
								</button>
							)}
							<button type="button" className="sh-btn" disabled={busy} onClick={doReject}>
								{reject.busy ? <LoaderCircle size={14} className="sh-spin" /> : <X size={14} />} Reject
							</button>
						</div>
						<div className="sh-field-hint">
							Rejected proposals are remembered: the agent won't suggest the same thing again.
						</div>
					</>
				)
			)}
			{error !== null && <div className="sh-connect-error">{error}</div>}
		</article>
	);
}
