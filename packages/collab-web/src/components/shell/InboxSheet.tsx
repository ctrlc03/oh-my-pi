import { BellRing, CircleCheck, Inbox, Laptop, LoaderCircle, RefreshCw, SendHorizontal, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "../../lib/companion";
import type { ComputerHandle } from "../../lib/computers";
import { relTime, shortenPath } from "../../lib/format";
import { hostKey, inboxKey, loadDismissed, type OpenIntent, saveDismissed, setOpenIntent } from "../../lib/inbox";
import { useComputerRequests } from "../../lib/use-computer-requests";
import { AgentChip } from "./AgentChip";
import { Sheet } from "./Sheet";
import "./inbox.css";

export interface InboxSheetProps {
	computers: readonly ComputerHandle[];
	/** Fetch a link for a hosting session of `computerId` and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onClose(): void;
}

/**
 * Sessions across the computers that wait on an answer or just finished a turn. Tapping one opens
 * it; an option chip or the reply field opens it and delivers the answer once it has joined.
 */
export function InboxSheet({ computers, onOpenHost, onClose }: InboxSheetProps): ReactNode {
	const { entries, loading, reload } = useComputerRequests(computers, null, client => client.requestInbox());
	const [dismissed, setDismissed] = useState(loadDismissed);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const closedRef = useRef(false);
	useEffect(() => {
		closedRef.current = false;
		return () => {
			closedRef.current = true;
		};
	}, []);
	const several = computers.length > 1;

	const open = async (computerId: string, item: InboxItem, intent?: OpenIntent): Promise<void> => {
		if (busy !== null) return;
		setBusy(hostKey(computerId, item.instanceId));
		setError(null);
		if (intent) setOpenIntent(computerId, item.instanceId, intent);
		try {
			await onOpenHost(computerId, item.instanceId);
			if (!closedRef.current) onClose();
		} catch (err) {
			if (closedRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
		}
	};

	const dismiss = (computerId: string, item: InboxItem): void => {
		const next = [...dismissed, inboxKey(computerId, item)];
		setDismissed(next);
		saveDismissed(next);
	};

	// Each computer lists its newest first: merged, still newest first.
	const items = entries
		.flatMap(({ computer, state }) =>
			state?.status === "ready" ? state.value.map(item => ({ computer, item })) : [],
		)
		.filter(({ computer, item }) => !dismissed.includes(inboxKey(computer.id, item)))
		.sort((a, b) => b.item.at - a.item.at);
	const answered = entries.some(entry => entry.state?.status === "ready");

	return (
		<Sheet label="Inbox" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Inbox</div>
				<span className="sh-stats-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="Refresh"
					>
						{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{entries.map(({ computer, state }) =>
				state?.status === "error" ? (
					<div key={computer.id} className="sh-tree-error">
						<div className="sh-connect-error">
							{several ? `${computer.name}: ` : ""}
							{state.message}
						</div>
						<button type="button" className="sh-btn" onClick={reload}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				) : null,
			)}
			{several &&
				entries.map(({ computer, reason }) =>
					reason === null ? null : (
						<div key={computer.id} className="sh-field-hint">
							{computer.name}: {reason}
						</div>
					),
				)}
			{loading && items.length === 0 && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
				</div>
			)}
			{!loading && answered && items.length === 0 && (
				<div className="sh-companion-empty">Nothing needs you. Questions and finished turns show up here.</div>
			)}
			{items.length > 0 && (
				<ul className="sh-inbox-list">
					{items.map(({ computer, item }) => (
						<InboxRow
							key={inboxKey(computer.id, item)}
							item={item}
							computerName={several ? computer.name : null}
							busy={busy === hostKey(computer.id, item.instanceId)}
							disabled={busy !== null}
							onOpen={intent => void open(computer.id, item, intent)}
							onDismiss={() => dismiss(computer.id, item)}
						/>
					))}
				</ul>
			)}
			{error && <div className="sh-connect-error">{error}</div>}
		</Sheet>
	);
}

interface InboxRowProps {
	item: InboxItem;
	/** The computer's name, shown when there are several. */
	computerName: string | null;
	busy: boolean;
	disabled: boolean;
	onOpen(intent?: OpenIntent): void;
	onDismiss(): void;
}

function InboxRow({ item, computerName, busy, disabled, onOpen, onDismiss }: InboxRowProps): ReactNode {
	const [reply, setReply] = useState("");
	const waiting = item.kind === "input";
	// An answer is only matched against the ask when the question text is known.
	const question = item.text;

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const prompt = reply.trim();
		if (prompt) onOpen({ prompt });
	};

	return (
		<li className="sh-inbox-item">
			<div className="sh-inbox-head">
				<button
					type="button"
					className="sh-inbox-open"
					onClick={() => onOpen()}
					disabled={disabled}
					title={item.cwd}
				>
					<span className="sh-recent-title">
						{busy ? (
							<LoaderCircle size={14} className="sh-spin" />
						) : waiting ? (
							<BellRing size={14} className="sh-inbox-waiting" />
						) : (
							<CircleCheck size={14} />
						)}
						<span className="sh-recent-name">{item.title}</span>
						<AgentChip agent={item.agent} />
					</span>
					<span className="sh-recent-meta">
						{computerName !== null && (
							<span className="sh-inbox-computer">
								<Laptop size={12} /> {computerName}
							</span>
						)}
						<span className="sh-recent-cwd">{shortenPath(item.cwd)}</span>
						<span>{relTime(item.at)}</span>
					</span>
					<span className="sh-inbox-text">
						{item.text ?? (waiting ? "Needs your input" : "Finished, your turn")}
					</span>
				</button>
				{!waiting && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onDismiss}
						disabled={disabled}
						aria-label={`Dismiss ${item.title}`}
					>
						<X size={14} />
					</button>
				)}
			</div>
			{waiting && question !== null && item.options && (
				<div className="sh-inbox-options">
					{item.options.map(option => (
						<button
							key={option}
							type="button"
							className="sh-quick-chip"
							disabled={disabled}
							onClick={() => onOpen({ answer: { question, option } })}
							title={`Open and answer: ${option}`}
						>
							<span className="sh-quick-text">{option}</span>
						</button>
					))}
				</div>
			)}
			<form className="sh-inbox-reply" onSubmit={submit}>
				<input
					className="sh-input"
					value={reply}
					onChange={e => setReply(e.currentTarget.value)}
					placeholder="Reply…"
					aria-label={`Reply to ${item.title}`}
					enterKeyHint="send"
					disabled={disabled}
				/>
				<button
					type="submit"
					className="sh-btn sh-btn-icon"
					disabled={disabled || !reply.trim()}
					aria-label={`Send reply to ${item.title}`}
				>
					<SendHorizontal size={15} />
				</button>
			</form>
		</li>
	);
}

export interface InboxEntryProps {
	computers: readonly ComputerHandle[];
	/** Fetch a link for a hosting session of `computerId` and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** `card`: labelled button in the start screen's action row; `icon`: sidebar footer button. */
	variant: "card" | "icon";
}

/** The button that opens the inbox, badged with the number of sessions waiting on an answer on any live computer. */
export function InboxEntry({ computers, onOpenHost, variant }: InboxEntryProps): ReactNode {
	const [open, setOpen] = useState(false);
	// From the hosts frames: no request is made while the sheet is closed.
	const count = computers.reduce(
		(sum, computer) =>
			computer.snap.phase === "live" ? sum + computer.snap.hosts.filter(host => host.inputRequired).length : sum,
		0,
	);
	return (
		<>
			<button
				type="button"
				className={variant === "card" ? "sh-btn sh-card-action" : "sh-btn sh-btn-icon"}
				onClick={() => setOpen(true)}
				aria-label={count > 0 ? `Inbox, ${count} waiting` : "Inbox"}
			>
				<Inbox size={15} />
				{variant === "card" && " Inbox"}
				{count > 0 && <span className="sh-inbox-badge">{count}</span>}
			</button>
			{open && <InboxSheet computers={computers} onOpenHost={onOpenHost} onClose={() => setOpen(false)} />}
		</>
	);
}
