import type {
	PersonalDigest,
	PersonalInboxItem,
	PersonalInboxKind,
	PersonalProposal,
} from "@oh-my-pi/pi-wire/personal";
import { BookOpen, CircleHelp, Info, LoaderCircle, PenLine, SendHorizontal, TriangleAlert } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useMemo, useState } from "react";
import { relTime } from "../../lib/format";
import {
	alertTone,
	answerText,
	decisionText,
	INBOX_KIND_LABEL,
	inboxDimmed,
	inboxNeeds,
} from "../../lib/personal-activity";
import type { RequestState } from "../../lib/use-request";
import { usePersonal, usePersonalQuery } from "../../lib/use-personal";
import { DigestView } from "./DigestView";
import { ProposalCard } from "./ProposalCard";
import { useAction } from "./shared";
import "./activity.css";

/** What the rows share, loaded once for the whole list. */
export interface PersonalInboxData {
	/** The pending proposals by id; asked for only while the list has an open proposal item. */
	proposals: RequestState<ReadonlyMap<string, PersonalProposal>>;
	/** The newest digests by id; asked for only while the list has a digest item. */
	digests: RequestState<ReadonlyMap<string, PersonalDigest>>;
}

const DIGESTS_LOADED = 30;

/** Loads the proposals and digests the Personal inbox rows show, once, and again when the companion says they moved. */
export function usePersonalInboxData(items: readonly PersonalInboxItem[]): PersonalInboxData {
	const personal = usePersonal();
	const needs = inboxNeeds(items);
	const proposals = usePersonalQuery(
		personal,
		["proposals"],
		async call => {
			const reply = await call({ t: "personal-proposals", status: "pending" });
			return new Map(reply.proposals.map(proposal => [proposal.id, proposal]));
		},
		needs.proposals,
	);
	const digests = usePersonalQuery(
		personal,
		["digests"],
		async call => {
			const reply = await call({ t: "personal-digests", limit: DIGESTS_LOADED });
			return new Map(reply.digests.map(digest => [digest.id, digest]));
		},
		needs.digests,
	);
	return useMemo(() => ({ proposals: proposals.state, digests: digests.state }), [proposals.state, digests.state]);
}

export interface PersonalInboxRowProps {
	item: PersonalInboxItem;
	data: PersonalInboxData;
	onReload(): void;
}

const KIND_ICON: Record<PersonalInboxKind, typeof Info> = {
	question: CircleHelp,
	proposal: PenLine,
	digest: BookOpen,
	alert: TriangleAlert,
	info: Info,
};

/** One Personal inbox item: a question to answer, a proposal to decide, a digest to read, or an alert or note to dismiss. */
export function PersonalInboxRow({ item, data, onReload }: PersonalInboxRowProps): ReactNode {
	const Icon = KIND_ICON[item.kind];
	const tone = item.kind === "alert" ? alertTone(item.title) : null;
	return (
		<li className={inboxDimmed(item) ? "sh-inbox-item pa-inbox-item pa-inbox-dim" : "sh-inbox-item pa-inbox-item"}>
			<div className="pa-inbox-top">
				<span className={tone === null ? "pa-inbox-tag" : `pa-inbox-tag pa-inbox-tag-${tone}`}>
					<Icon size={12} aria-hidden="true" /> Personal · {INBOX_KIND_LABEL[item.kind]}
				</span>
				{item.origin === "external" && <span className="pa-act-tag pa-act-tag-warn">From outside content</span>}
				<span className="pa-inbox-time">{relTime(item.at)}</span>
			</div>
			<div className="pa-inbox-title">{item.title}</div>
			{item.kind === "question" && <QuestionBody item={item} onReload={onReload} />}
			{item.kind === "proposal" && <ProposalBody item={item} data={data} onReload={onReload} />}
			{item.kind === "digest" && <DigestBody item={item} data={data} onReload={onReload} />}
			{(item.kind === "alert" || item.kind === "info") && <NoteBody item={item} onReload={onReload} />}
		</li>
	);
}

interface BodyProps {
	item: PersonalInboxItem;
	onReload(): void;
}

function QuestionBody({ item: given, onReload }: BodyProps): ReactNode {
	const personal = usePersonal();
	const [answered, setAnswered] = useState<{ from: PersonalInboxItem; value: PersonalInboxItem } | null>(null);
	const item = answered !== null && answered.from === given ? answered.value : given;
	const [text, setText] = useState("");
	const answer = useAction();

	const send = (reply: { option: string } | { text: string }): void => {
		void answer.run(async () => {
			const next = (await personal.call({ t: "personal-answer", itemId: item.id, ...reply })).item;
			setAnswered({ from: given, value: next });
			setText("");
			onReload();
		});
	};
	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const typed = text.trim();
		if (typed !== "") send({ text: typed });
	};

	return (
		<>
			{item.body !== "" && <div className="sh-inbox-text">{item.body}</div>}
			{item.state === "done" ? (
				<div className="pa-inbox-answer">{answerText(item)}</div>
			) : (
				<>
					{item.options !== undefined && item.options.length > 0 && (
						<div className="sh-inbox-options">
							{item.options.map(option => (
								<button
									key={option}
									type="button"
									className="sh-quick-chip"
									disabled={answer.busy}
									onClick={() => send({ option })}
									title={`Answer: ${option}`}
								>
									<span className="sh-quick-text">{option}</span>
								</button>
							))}
						</div>
					)}
					<form className="sh-inbox-reply" onSubmit={submit}>
						<input
							className="sh-input"
							value={text}
							onChange={e => setText(e.currentTarget.value)}
							placeholder="Or write an answer…"
							aria-label={`Answer ${item.title}`}
							enterKeyHint="send"
							disabled={answer.busy}
						/>
						<button
							type="submit"
							className="sh-btn sh-btn-icon"
							disabled={answer.busy || text.trim() === ""}
							aria-label={`Send answer to ${item.title}`}
						>
							{answer.busy ? <LoaderCircle size={15} className="sh-spin" /> : <SendHorizontal size={15} />}
						</button>
					</form>
				</>
			)}
			{answer.error !== null && <div className="sh-connect-error">{answer.error}</div>}
		</>
	);
}

function ProposalBody({ item, data, onReload }: BodyProps & { data: PersonalInboxData }): ReactNode {
	if (item.state === "done") return <div className="pa-inbox-answer">Decided: {decisionText(item)}</div>;
	const { proposals } = data;
	const proposal =
		proposals.status === "ready" && item.proposalId !== undefined ? proposals.value.get(item.proposalId) : undefined;
	if (proposal !== undefined) return <ProposalCard proposal={proposal} onChanged={onReload} />;
	return (
		<>
			{item.body !== "" && <div className="sh-inbox-text">{item.body}</div>}
			{proposals.status === "loading" && (
				<div className="sh-field-hint">
					<LoaderCircle size={12} className="sh-spin" /> Loading the proposal…
				</div>
			)}
			{proposals.status === "error" && <div className="sh-connect-error">{proposals.message}</div>}
			{proposals.status === "ready" && (
				<div className="sh-field-hint">
					This proposal is no longer waiting. Check Settings → Personal agent → Activity.
				</div>
			)}
		</>
	);
}

function DigestBody({ item, data, onReload }: BodyProps & { data: PersonalInboxData }): ReactNode {
	const personal = usePersonal();
	const [open, setOpen] = useState(false);
	const ack = useAction();
	const { digests } = data;
	const digest =
		digests.status === "ready" && item.digestId !== undefined ? digests.value.get(item.digestId) : undefined;

	const toggle = (): void => {
		setOpen(!open);
		if (open || item.readAt !== undefined) return;
		void ack.run(async () => {
			await personal.call({ t: "personal-inbox-ack", ids: [item.id] });
			onReload();
		});
	};

	return (
		<>
			{item.body !== "" && <div className="sh-inbox-text">{item.body}</div>}
			<div className="pa-actions">
				<button type="button" className="sh-btn" aria-expanded={open} onClick={toggle}>
					{open ? "Hide" : "Read"}
				</button>
			</div>
			{open && digest !== undefined && <DigestView digest={digest} bare defaultOpen />}
			{open && digest === undefined && (
				<div className="sh-field-hint">
					{digests.status === "loading"
						? "Loading the digest…"
						: digests.status === "error"
							? digests.message
							: "This digest is no longer in the newest ones. Find it in Settings → Personal agent → Activity."}
				</div>
			)}
			{ack.error !== null && <div className="sh-connect-error">{ack.error}</div>}
		</>
	);
}

function NoteBody({ item, onReload }: BodyProps): ReactNode {
	const personal = usePersonal();
	const dismiss = useAction();
	const read = item.readAt !== undefined;
	return (
		<>
			{item.body !== "" && <div className="sh-inbox-text">{item.body}</div>}
			{!read && (
				<div className="pa-actions">
					<button
						type="button"
						className="sh-btn"
						disabled={dismiss.busy}
						onClick={() =>
							void dismiss.run(async () => {
								await personal.call({ t: "personal-inbox-ack", ids: [item.id] });
								onReload();
							})
						}
						aria-label={`Dismiss ${item.title}`}
					>
						{dismiss.busy && <LoaderCircle size={14} className="sh-spin" />} Dismiss
					</button>
				</div>
			)}
			{dismiss.error !== null && <div className="sh-connect-error">{dismiss.error}</div>}
		</>
	);
}
