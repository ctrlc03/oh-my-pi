import { BellRing, CircleCheck, Inbox, LoaderCircle, RefreshCw, SendHorizontal, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient, InboxItem } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { inboxKey, loadDismissed, type OpenIntent, saveDismissed, setOpenIntent } from "../../lib/inbox";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";
import "./inbox.css";

export interface InboxSheetProps {
	client: CompanionClient;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onClose(): void;
}

/**
 * Sessions across the computer that wait on an answer or just finished a turn. Tapping one opens
 * it; an option chip or the reply field opens it and delivers the answer once it has joined.
 */
export function InboxSheet({ client, onOpenHost, onClose }: InboxSheetProps): ReactNode {
	const load = useCallback(() => client.requestInbox(), [client]);
	const { state, reload } = useRequest(load);
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

	const open = async (item: InboxItem, intent?: OpenIntent): Promise<void> => {
		if (busy !== null) return;
		setBusy(item.instanceId);
		setError(null);
		if (intent) setOpenIntent(item.instanceId, intent);
		try {
			await onOpenHost(item.instanceId);
			if (!closedRef.current) onClose();
		} catch (err) {
			if (closedRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
		}
	};

	const dismiss = (item: InboxItem): void => {
		const next = [...dismissed, inboxKey(item)];
		setDismissed(next);
		saveDismissed(next);
	};

	const items = state.status === "ready" ? state.value.filter(item => !dismissed.includes(inboxKey(item))) : null;
	const loading = state.status === "loading";

	return (
		<Sheet label="inbox" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Inbox</div>
				<span className="sh-stats-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="refresh"
						title="refresh"
					>
						{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{loading && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
				</div>
			)}
			{items !== null && items.length === 0 && (
				<div className="sh-companion-empty">Nothing needs you. Questions and finished turns show up here.</div>
			)}
			{items !== null && items.length > 0 && (
				<ul className="sh-inbox-list">
					{items.map(item => (
						<InboxRow
							key={inboxKey(item)}
							item={item}
							busy={busy === item.instanceId}
							disabled={busy !== null}
							onOpen={intent => void open(item, intent)}
							onDismiss={() => dismiss(item)}
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
	busy: boolean;
	disabled: boolean;
	onOpen(intent?: OpenIntent): void;
	onDismiss(): void;
}

function InboxRow({ item, busy, disabled, onOpen, onDismiss }: InboxRowProps): ReactNode {
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
					</span>
					<span className="sh-recent-meta">
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
						aria-label={`dismiss ${item.title}`}
						title="dismiss"
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
							title={`open and answer: ${option}`}
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
					aria-label={`reply to ${item.title}`}
					enterKeyHint="send"
					disabled={disabled}
				/>
				<button
					type="submit"
					className="sh-btn sh-btn-icon"
					disabled={disabled || !reply.trim()}
					aria-label={`send reply to ${item.title}`}
					title="open the session and send"
				>
					<SendHorizontal size={15} />
				</button>
			</form>
		</li>
	);
}

export interface InboxEntryProps {
	client: CompanionClient;
	/** Sessions waiting on an answer, from the hosts frame; no request is made while the sheet is closed. */
	count: number;
	onOpenHost(instanceId: string): Promise<void>;
	/** `card`: labelled button in the start screen's action row; `icon`: sidebar footer button. */
	variant: "card" | "icon";
}

/** The button that opens the inbox, badged with the number of sessions waiting on an answer. */
export function InboxEntry({ client, count, onOpenHost, variant }: InboxEntryProps): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className={variant === "card" ? "sh-btn sh-card-action" : "sh-btn sh-btn-icon"}
				onClick={() => setOpen(true)}
				aria-label={count > 0 ? `inbox, ${count} waiting` : "inbox"}
				title="inbox"
			>
				<Inbox size={15} />
				{variant === "card" && " Inbox"}
				{count > 0 && <span className="sh-inbox-badge">{count}</span>}
			</button>
			{open && <InboxSheet client={client} onOpenHost={onOpenHost} onClose={() => setOpen(false)} />}
		</>
	);
}
