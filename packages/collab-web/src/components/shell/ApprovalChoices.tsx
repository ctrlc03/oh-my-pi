import type { CollabApprovalChoiceKind, CollabUiApproval } from "@oh-my-pi/pi-wire";
import { Check, FolderCheck, FolderX, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";

interface ApprovalChoicesProps {
	approval: CollabUiApproval;
	/** Answers the request with the chosen option's label. */
	onChoose(label: string): void;
}

const ICONS: Record<CollabApprovalChoiceKind, ReactNode> = {
	once: <Check size={15} />,
	session: <ShieldCheck size={15} />,
	project: <FolderCheck size={15} />,
	deny: <X size={15} />,
	"deny-project": <FolderX size={15} />,
};

/** What each choice does, in words a thumb-sized button can carry. */
const HINTS: Record<CollabApprovalChoiceKind, string> = {
	once: "Run this call only",
	session: "Until this session ends",
	project: "Saved in this project",
	deny: "Refuse this call only",
	"deny-project": "Refuse it every time in this project",
};

/**
 * The prompt's title: its first line is the question, the lines after it are details. A detail written
 * `Label: value` shows the value in mono, so a command or a rule reads as code.
 */
export function AskTitle({ title }: { title: string }): ReactNode {
	const [head = "", ...details] = title.split("\n");
	return (
		<div className="sh-ask-title">
			<div className="sh-ask-headline">{head}</div>
			{details.map((line, index) => {
				const split = line.indexOf(": ");
				return (
					<div key={`${index}:${line}`} className="sh-ask-detail">
						{split < 0 ? (
							line
						) : (
							<>
								<span className="sh-ask-detail-label">{line.slice(0, split)}</span>
								<code className="sh-ask-detail-value">{line.slice(split + 2)}</code>
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}

/**
 * Tool-approval answer for a host with feature `approval-grants`: allow once, "always" for the session or the
 * project, deny, deny always. A project-scoped choice a guest may not save (`guestProject: false`) stays visible
 * but disabled, so the reason is on screen rather than the button silently missing.
 */
export function ApprovalChoices({ approval, onChoose }: ApprovalChoicesProps): ReactNode {
	const byKind = (kind: CollabApprovalChoiceKind): { label: string; kind: CollabApprovalChoiceKind } | undefined =>
		approval.choices.find(choice => choice.kind === kind);
	const render = (kind: CollabApprovalChoiceKind, className: string): ReactNode => {
		const choice = byKind(kind);
		if (!choice) return null;
		const locked = (kind === "project" || kind === "deny-project") && !approval.guestProject;
		return (
			<button
				key={kind}
				type="button"
				className={`sh-ask-option sh-approval-choice ${className}`}
				disabled={locked}
				title={
					locked ? "The host does not let guests save project rules (collab.guestsCanSaveApprovals)" : undefined
				}
				onClick={() => onChoose(choice.label)}
			>
				<span className="sh-ask-option-marker">{ICONS[kind]}</span>
				<span className="sh-ask-option-copy">
					<span className="sh-ask-option-label">{choice.label}</span>
					<span className="sh-ask-option-description">
						{locked ? "Guests cannot save project rules here" : HINTS[kind]}
					</span>
				</span>
			</button>
		);
	};
	// A host offers the kinds it implements (a vendor agent's only once, session and deny): no empty rows for the rest.
	const rows: [CollabApprovalChoiceKind, string][][] = [
		[
			["once", "sh-approval-allow"],
			["deny", "sh-approval-deny"],
		],
		[
			["session", ""],
			["project", ""],
		],
		[["deny-project", "sh-approval-deny"]],
	];
	return (
		<div className="sh-ask-options sh-approval">
			{rows
				.filter(row => row.some(([kind]) => byKind(kind) !== undefined))
				.map(row => (
					<div key={row[0]?.[0]} className="sh-approval-row">
						{row.map(([kind, className]) => render(kind, className))}
					</div>
				))}
		</div>
	);
}
