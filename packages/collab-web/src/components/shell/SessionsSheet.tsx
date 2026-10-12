import { LoaderCircle, Play, RefreshCw, Search, Share2, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentFilterOptions, filterByAgent } from "../../lib/agents";
import type { AgentRef, CompanionClient, SessionOverview, SessionSearchHit } from "../../lib/companion";
import { fmtCost, fmtTokens, relTime, shortenPath } from "../../lib/format";
import { setJumpIntent } from "../../lib/jump-intent";
import { extractLink } from "../../lib/rooms";
import { MIN_QUERY_CHARS, searchable } from "../../lib/search-terms";
import { useRequest } from "../../lib/use-request";
import { AgentChip } from "./AgentChip";
import { AgentsEntry } from "./AgentsSheet";
import { MessageSearch } from "./MessageSearch";
import { useOpenElsewhere } from "./OpenElsewhere";
import { Sheet } from "./Sheet";
import "./review.css";
import "./stats.css";

const SEARCH_DEBOUNCE_MS = 300;
const SESSION_LIMIT = 200;

export interface SessionsSheetProps {
	client: CompanionClient;
	/** The companion can start omp, so ended sessions can be resumed. */
	canStart: boolean;
	/** The companion answers message searches (`canSearch`); without it only the title and folder search is offered. */
	canSearch?: boolean;
	/** The companion can drive other vendors' agents (`canForeign`): the head offers the Agents settings. */
	canForeign?: boolean;
	/** A search to open on (from the command palette): sessions by title or folder, or messages. */
	initial?: { mode: "sessions" | "messages"; query: string };
	/** Session on screen: marked and not openable. */
	currentSessionId?: string | null;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	onClose(): void;
}

/** Every omp session on the computer across projects, grouped by folder; open, share or resume from here. */
export function SessionsSheet({
	client,
	canStart,
	canSearch,
	canForeign,
	initial,
	currentSessionId,
	onOpenHost,
	onOpenLink,
	onClose,
}: SessionsSheetProps): ReactNode {
	const [query, setQuery] = useState(initial?.mode === "sessions" ? initial.query : "");
	const [q, setQ] = useState(query.trim());
	useEffect(() => {
		const timer = setTimeout(() => setQ(query.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);
	const [mode, setMode] = useState<"sessions" | "messages">(initial?.mode ?? "sessions");
	const messages = canSearch === true && mode === "messages";
	const [msgQuery, setMsgQuery] = useState(initial?.mode === "messages" ? initial.query : "");
	const [mq, setMq] = useState(msgQuery.trim());
	useEffect(() => {
		const timer = setTimeout(() => setMq(msgQuery.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [msgQuery]);
	const load = useCallback(() => client.requestSessions({ limit: SESSION_LIMIT, q: q || undefined }), [client, q]);
	const { state, reload } = useRequest(load);
	// Keep the previous list on screen (dimmed) while a new search loads.
	const shown = useRef<SessionOverview[] | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const sessions = shown.current;
	const loading = state.status === "loading";

	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** Folder of the worktree whose removal awaits confirmation. */
	const [removing, setRemoving] = useState<string | null>(null);
	/** Id of the agent the list is narrowed to; null: every agent. */
	const [agentFilter, setAgentFilter] = useState<string | null>(null);
	const closedRef = useRef(false);
	useEffect(() => {
		closedRef.current = false;
		return () => {
			closedRef.current = true;
		};
	}, []);

	const openElsewhere = useOpenElsewhere();

	/** Run one row's action (`force` is passed to a resume); the sheet stays up (with the error) when it fails. */
	const run = async (id: string, action: (force: boolean) => Promise<void>, force = false): Promise<void> => {
		if (busy) return;
		setBusy(id);
		setError(null);
		openElsewhere.dismiss();
		try {
			await action(force);
		} catch (err) {
			if (closedRef.current) return;
			if (!openElsewhere.intercept(err, () => void run(id, action, true))) {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			if (!closedRef.current) setBusy(null);
		}
	};

	const share = async (instanceId: string): Promise<void> => {
		const link = extractLink(await client.shareSession(instanceId));
		if (!link) throw new Error("the computer returned an unreadable link");
		onOpenLink(link);
	};

	const resume = async (
		session: { sessionId: string; folder: string; agent?: AgentRef },
		force: boolean,
	): Promise<void> => {
		await onOpenHost(
			await client.startSession(session.folder, {
				resume: session.sessionId,
				agent: session.agent?.id,
				force: force || undefined,
			}),
		);
	};

	/**
	 * Remember where to scroll, run `action` (which opens the session), and forget it again when that
	 * fails. The session screen applies it once the session is joined.
	 */
	const withJump = async (hit: SessionSearchHit, action: () => Promise<void>): Promise<void> => {
		setJumpIntent({ sessionId: hit.sessionId, entryId: hit.entryId });
		try {
			await action();
		} catch (err) {
			setJumpIntent(null);
			throw err;
		}
	};

	const openHit = (hit: SessionSearchHit): void => {
		if (hit.sessionId === currentSessionId) {
			setJumpIntent({ sessionId: hit.sessionId, entryId: hit.entryId });
			onClose();
			return;
		}
		const { instanceId } = hit;
		if (instanceId !== undefined) void run(hit.sessionId, () => withJump(hit, () => onOpenHost(instanceId)));
	};
	const shareHit = (hit: SessionSearchHit): void => {
		const { instanceId } = hit;
		if (instanceId !== undefined) void run(hit.sessionId, () => withJump(hit, () => share(instanceId)));
	};
	const resumeHit = (hit: SessionSearchHit): void => {
		void run(hit.sessionId, force =>
			withJump(hit, () => resume({ sessionId: hit.sessionId, folder: hit.cwd, agent: hit.agent }, force)),
		);
	};

	const removeWorktree = async (folder: string): Promise<void> => {
		await client.removeWorktree(folder);
		if (closedRef.current) return;
		setRemoving(null);
		reload();
	};

	const agentOptions = agentFilterOptions(sessions ?? []);
	// A filter whose agent left the list (a narrower search) shows everything again rather than nothing.
	const activeAgent = agentOptions.some(option => option.id === agentFilter) ? agentFilter : null;
	const visible = filterByAgent(sessions ?? [], activeAgent);

	const groups = new Map<string, { sessions: SessionOverview[]; cost: number }>();
	for (const session of visible) {
		const group = groups.get(session.folder);
		if (group) {
			group.sessions.push(session);
			group.cost += session.cost;
		} else groups.set(session.folder, { sessions: [session], cost: session.cost });
	}

	return (
		<Sheet label="All sessions" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">All sessions</div>
				<span className="sh-stats-head-actions">
					{canForeign === true && <AgentsEntry client={client} variant="icon" />}
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
			{openElsewhere.notice}
			{error && <div className="sh-connect-error">{error}</div>}
			{canSearch === true && (
				<div className="sh-segmented sh-segmented-fill" role="radiogroup" aria-label="Search in">
					<button
						type="button"
						role="radio"
						aria-checked={!messages}
						className={messages ? "sh-segment" : "sh-segment sh-segment-on"}
						onClick={() => setMode("sessions")}
					>
						Sessions
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={messages}
						className={messages ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => setMode("messages")}
					>
						Messages
					</button>
				</div>
			)}
			<label className="sh-stats-search">
				<Search size={14} />
				<input
					className="sh-input"
					type="search"
					value={messages ? msgQuery : query}
					onChange={e => (messages ? setMsgQuery : setQuery)(e.currentTarget.value)}
					placeholder={messages ? "Search what was said" : "Search title or folder"}
					aria-label={messages ? "Search messages" : "Search sessions"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			</label>
			{agentOptions.length > 0 && (
				<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-label="Filter by agent">
					<button
						type="button"
						role="radio"
						aria-checked={activeAgent === null}
						className={activeAgent === null ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => setAgentFilter(null)}
					>
						All
					</button>
					{agentOptions.map(option => (
						<button
							key={option.id}
							type="button"
							role="radio"
							aria-checked={activeAgent === option.id}
							className={activeAgent === option.id ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setAgentFilter(option.id)}
						>
							{option.name}
						</button>
					))}
				</div>
			)}
			{!messages && state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{messages ? (
				searchable(mq) ? (
					<MessageSearch
						client={client}
						query={mq}
						canStart={canStart}
						currentSessionId={currentSessionId}
						busy={busy}
						onOpen={openHit}
						onShare={shareHit}
						onResume={resumeHit}
						agent={activeAgent}
					/>
				) : (
					<div className="sh-companion-empty">
						Type at least {MIN_QUERY_CHARS} characters to search what was said in your sessions.
					</div>
				)
			) : sessions === null ? (
				state.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Loading sessions… the first read can take a while.
					</div>
				)
			) : visible.length === 0 ? (
				<div className="sh-companion-empty">
					{q || activeAgent !== null ? "No session matches." : "No sessions yet."}
				</div>
			) : (
				<div className={loading ? "sh-stats-body sh-stats-cols sh-stats-stale" : "sh-stats-body sh-stats-cols"}>
					{[...groups].map(([folder, group]) => (
						<section key={folder} className="sh-switch-section" aria-label={folder}>
							<h2 className="sh-recents-title sh-stats-group" title={folder}>
								<span className="sh-recent-cwd">{shortenPath(folder)}</span>
								{group.sessions.length > 1 && (
									<span className="sh-stats-group-cost">{fmtCost(group.cost)}</span>
								)}
							</h2>
							{group.sessions.every(session => session.worktree === true && session.live === undefined) && (
								<div className="sh-review-worktree">
									{removing === folder ? (
										<div className="sh-review-confirm" role="group" aria-label="Confirm">
											<div className="sh-field-label">This will run on your computer:</div>
											<pre className="sh-review-cmd">git worktree remove {folder}</pre>
											<div className="sh-field-hint">
												The branch is kept. Refused if the tree has uncommitted changes.
											</div>
											<div className="sh-review-confirm-actions">
												<button
													type="button"
													className="sh-btn"
													onClick={() => setRemoving(null)}
													disabled={busy !== null}
												>
													Cancel
												</button>
												<button
													type="button"
													className="sh-btn sh-btn-stop"
													disabled={busy !== null}
													onClick={() => void run(folder, () => removeWorktree(folder))}
												>
													{busy === folder ? (
														<LoaderCircle size={14} className="sh-spin" />
													) : (
														<Trash2 size={14} />
													)}{" "}
													Remove
												</button>
											</div>
										</div>
									) : (
										<button
											type="button"
											className="sh-btn"
											disabled={busy !== null}
											onClick={() => setRemoving(folder)}
										>
											<Trash2 size={14} /> Remove worktree
										</button>
									)}
								</div>
							)}
							<ul className="sh-recents-list">
								{group.sessions.map(session => (
									<SessionRow
										key={session.sessionId}
										session={session}
										current={session.sessionId === currentSessionId}
										busy={busy}
										canStart={canStart}
										onOpen={instanceId => run(session.sessionId, () => onOpenHost(instanceId))}
										onShare={instanceId => run(session.sessionId, () => share(instanceId))}
										onResume={() => run(session.sessionId, force => resume(session, force))}
									/>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
		</Sheet>
	);
}

export interface SessionRowProps {
	session: SessionOverview;
	current: boolean;
	/** sessionId whose action is running; any value disables every action. */
	busy: string | null;
	canStart: boolean;
	onOpen(instanceId: string): void;
	onShare(instanceId: string): void;
	onResume(): void;
}

export function SessionRow({
	session,
	current,
	busy,
	canStart,
	onOpen,
	onShare,
	onResume,
}: SessionRowProps): ReactNode {
	const { instanceId } = session;
	const working = busy === session.sessionId;
	const spinner = working ? <LoaderCircle size={14} className="sh-spin" /> : null;
	return (
		<li className="sh-recent">
			<div className="sh-recent-join sh-idle-info" title={session.folder}>
				<span className="sh-recent-title">
					<span className="sh-recent-name">{session.title ?? "Untitled"}</span>
					<AgentChip agent={session.agent} />
					{current && <span className="sh-chip">here</span>}
					{session.live === "host" && <span className="sh-chip sh-chip-live">live</span>}
					{session.live === "idle" && <span className="sh-chip">running</span>}
				</span>
				<span className="sh-recent-meta">
					<span>{relTime(session.endedAt ?? session.startedAt)}</span>
					<span>{fmtCost(session.cost)}</span>
					<span>{fmtTokens(session.tokens)} tok</span>
				</span>
				{session.models.length > 0 && (
					<span className="sh-stats-models">
						{session.models.slice(0, 3).map(model => (
							<span key={model} className="sh-chip">
								{model}
							</span>
						))}
						{session.models.length > 3 && <span className="sh-stats-more">+{session.models.length - 3}</span>}
					</span>
				)}
			</div>
			{session.live === "host" && instanceId !== undefined && !current && (
				<button
					type="button"
					className="sh-btn sh-idle-share"
					onClick={() => onOpen(instanceId)}
					disabled={busy !== null}
				>
					{spinner ?? <Play size={14} />} Open
				</button>
			)}
			{session.live === "idle" && instanceId !== undefined && (
				<button
					type="button"
					className="sh-btn sh-idle-share"
					onClick={() => onShare(instanceId)}
					disabled={busy !== null}
				>
					{spinner ?? <Share2 size={14} />} Share
				</button>
			)}
			{session.live === undefined && canStart && (
				<button type="button" className="sh-btn sh-idle-share" onClick={onResume} disabled={busy !== null}>
					{spinner ?? <Play size={14} />} Resume
				</button>
			)}
		</li>
	);
}
