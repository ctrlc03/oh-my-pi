import { Laptop, LoaderCircle, Play, RefreshCw, Search, Share2, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { agentFilterOptions, filterByAgent } from "../../lib/agents";
import type { AgentRef, CompanionClient, SessionOverview, SessionSearchHit } from "../../lib/companion";
import type { ComputerHandle } from "../../lib/computers";
import { fmtCost, fmtTokens, relTime, shortenPath } from "../../lib/format";
import { setJumpIntent } from "../../lib/jump-intent";
import { extractLink } from "../../lib/rooms";
import { MIN_QUERY_CHARS, searchable } from "../../lib/search-terms";
import { deletableOverview } from "../../lib/session-delete";
import { useRequest } from "../../lib/use-request";
import { AgentChip } from "./AgentChip";
import { AgentsEntry } from "./AgentsSheet";
import { ComputerChip } from "./ComputerChip";
import { useDeleteSessions } from "./DeleteSessions";
import { MessageSearch } from "./MessageSearch";
import { useOpenElsewhere } from "./OpenElsewhere";
import { Sheet } from "./Sheet";
import "./review.css";
import "./stats.css";

const SEARCH_DEBOUNCE_MS = 300;
const SESSION_LIMIT = 200;

/** A computer that is connected and answering: the ones whose sessions can be listed. */
type Reachable = ComputerHandle & { client: CompanionClient };

const isReachable = (computer: ComputerHandle): computer is Reachable =>
	computer.client !== null && computer.snap.phase === "live";

/** One listed session and the computer it is on. */
interface Listed {
	session: SessionOverview;
	computerId: string;
}

/** The sessions of every computer that answered, and the ones that did not. */
interface Combined {
	rows: Listed[];
	failures: { name: string; message: string }[];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const recency = (session: SessionOverview): number => session.endedAt ?? session.startedAt;

/** Why a computer's sessions are not listed. */
function unreachableNote(computer: ComputerHandle): string {
	if (computer.snap.phase === "connecting") return "connecting…";
	const reason = computer.error ?? computer.snap.error;
	return reason === null ? "not reachable." : `not reachable. ${reason}`;
}

/** The sessions of one folder of one computer, listed together. */
interface FolderGroup {
	computer: Reachable;
	folder: string;
	sessions: SessionOverview[];
	cost: number;
}

export interface SessionsSheetProps {
	/** Every paired computer: the sessions of those that are connected are listed together. */
	computers: readonly ComputerHandle[];
	/** A search to open on (from the command palette): sessions by title or folder, or messages. */
	initial?: { mode: "sessions" | "messages"; query: string };
	/** Session on screen: marked and not openable. */
	currentSessionId?: string | null;
	/** Fetch a link for a hosting session of a computer and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	onClose(): void;
}

/** Every omp session on the computers across projects, grouped by folder; open, share or resume from here. */
export function SessionsSheet({
	computers,
	initial,
	currentSessionId,
	onOpenHost,
	onOpenLink,
	onClose,
}: SessionsSheetProps): ReactNode {
	const several = computers.length > 1;
	/** Id of the computer the list is narrowed to; null: every computer. */
	const [computerFilter, setComputerFilter] = useState<string | null>(null);
	const activeComputer = computers.some(computer => computer.id === computerFilter) ? computerFilter : null;
	const inScope = computers.filter(computer => activeComputer === null || computer.id === activeComputer);
	const targets = inScope.filter(isReachable);
	const unreachable = inScope.filter(computer => !isReachable(computer));
	const targetsRef = useRef(targets);
	targetsRef.current = targets;
	const targetIds = targets.map(computer => computer.id).join(",");
	const searchTargets = targets.filter(computer => computer.snap.canSearch);
	const foreignTargets = targets.filter(computer => computer.snap.canForeign);

	const [query, setQuery] = useState(initial?.mode === "sessions" ? initial.query : "");
	const [q, setQ] = useState(query.trim());
	useEffect(() => {
		const timer = setTimeout(() => setQ(query.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);
	const [mode, setMode] = useState<"sessions" | "messages">(initial?.mode ?? "sessions");
	const messages = searchTargets.length > 0 && mode === "messages";
	const [msgQuery, setMsgQuery] = useState(initial?.mode === "messages" ? initial.query : "");
	const [mq, setMq] = useState(msgQuery.trim());
	useEffect(() => {
		const timer = setTimeout(() => setMq(msgQuery.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [msgQuery]);
	// Re-lists when the computers asked change (targetIds) or the search does; their clients are stable.
	const load = useCallback(async (): Promise<Combined> => {
		const asked = targetsRef.current;
		const answers = await Promise.allSettled(
			asked.map(computer => computer.client.requestSessions({ limit: SESSION_LIMIT, q: q || undefined })),
		);
		const refused = answers.flatMap(answer => (answer.status === "rejected" ? [messageOf(answer.reason)] : []));
		// Every computer failing is the list failing; one failing is a line under the others.
		if (answers.length > 0 && refused.length === answers.length) throw new Error(refused[0]);
		const rows: Listed[] = [];
		const failures: Combined["failures"] = [];
		for (let i = 0; i < asked.length; i++) {
			const answer = answers[i]!;
			if (answer.status === "fulfilled") {
				for (const session of answer.value) rows.push({ session, computerId: asked[i]!.id });
			} else failures.push({ name: asked[i]!.name, message: messageOf(answer.reason) });
		}
		if (asked.length > 1) rows.sort((a, b) => recency(b.session) - recency(a.session));
		return { rows, failures };
	}, [targetIds, q]);
	const { state, reload } = useRequest(load);
	// Sessions deleted or put back (from here or the Undo of the toast) change the list.
	const deleter = useDeleteSessions();
	const deleteRev = deleter?.rev ?? 0;
	const seenRev = useRef(deleteRev);
	useEffect(() => {
		if (seenRev.current === deleteRev) return;
		seenRev.current = deleteRev;
		reload();
	}, [deleteRev, reload]);
	// Keep the previous list on screen (dimmed) while a new search loads.
	const shown = useRef<Combined | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const listed = shown.current;
	const loading = state.status === "loading";
	const byId = new Map(targets.map(computer => [computer.id, computer]));

	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** The folder (of one computer) whose worktree removal awaits confirmation. */
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
				setError(messageOf(err));
			}
		} finally {
			if (!closedRef.current) setBusy(null);
		}
	};

	const share = async (computer: Reachable, instanceId: string): Promise<void> => {
		const link = extractLink(await computer.client.shareSession(instanceId));
		if (!link) throw new Error("the computer returned an unreadable link");
		onOpenLink(link);
	};

	const resume = async (
		computer: Reachable,
		session: { sessionId: string; folder: string; agent?: AgentRef },
		force: boolean,
	): Promise<void> => {
		await onOpenHost(
			computer.id,
			await computer.client.startSession(session.folder, {
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

	const openHit = (computer: Reachable, hit: SessionSearchHit): void => {
		if (hit.sessionId === currentSessionId) {
			setJumpIntent({ sessionId: hit.sessionId, entryId: hit.entryId });
			onClose();
			return;
		}
		const { instanceId } = hit;
		if (instanceId !== undefined)
			void run(hit.sessionId, () => withJump(hit, () => onOpenHost(computer.id, instanceId)));
	};
	const shareHit = (computer: Reachable, hit: SessionSearchHit): void => {
		const { instanceId } = hit;
		if (instanceId !== undefined) void run(hit.sessionId, () => withJump(hit, () => share(computer, instanceId)));
	};
	const resumeHit = (computer: Reachable, hit: SessionSearchHit): void => {
		void run(hit.sessionId, force =>
			withJump(hit, () => resume(computer, { sessionId: hit.sessionId, folder: hit.cwd, agent: hit.agent }, force)),
		);
	};

	const removeWorktree = async (computer: Reachable, folder: string): Promise<void> => {
		await computer.client.removeWorktree(folder);
		if (closedRef.current) return;
		setRemoving(null);
		reload();
	};

	// A computer that left the list (went offline since) takes its rows with it.
	const rows = (listed?.rows ?? []).filter(row => byId.has(row.computerId));
	const agentOptions = agentFilterOptions(rows.map(row => row.session));
	// A filter whose agent left the list (a narrower search) shows everything again rather than nothing.
	const activeAgent = agentOptions.some(option => option.id === agentFilter) ? agentFilter : null;
	const visible = filterByAgent(
		rows.map(row => ({ ...row, agent: row.session.agent })),
		activeAgent,
	);

	const groups = new Map<string, FolderGroup>();
	for (const { session, computerId } of visible) {
		const key = `${computerId}\n${session.folder}`;
		const group = groups.get(key);
		if (group) {
			group.sessions.push(session);
			group.cost += session.cost;
		} else {
			groups.set(key, {
				computer: byId.get(computerId)!,
				folder: session.folder,
				sessions: [session],
				cost: session.cost,
			});
		}
	}

	return (
		<Sheet label="All sessions" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">All sessions</div>
				<span className="sh-stats-head-actions">
					<AgentsEntry computers={foreignTargets} variant="icon" />
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
			{several && (
				<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-label="Filter by computer">
					<button
						type="button"
						role="radio"
						aria-checked={activeComputer === null}
						className={activeComputer === null ? "sh-segment sh-segment-on" : "sh-segment"}
						onClick={() => setComputerFilter(null)}
					>
						All computers
					</button>
					{computers.map(computer => (
						<button
							key={computer.id}
							type="button"
							role="radio"
							aria-checked={activeComputer === computer.id}
							className={activeComputer === computer.id ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => setComputerFilter(computer.id)}
						>
							<span
								className={`sh-dot${computer.snap.phase === "live" ? " sh-dot-live" : ""}`}
								aria-hidden="true"
							/>
							{computer.name}
						</button>
					))}
				</div>
			)}
			{unreachable.map(computer => (
				<div key={computer.id} className="sh-companion-empty">
					{computer.name}: {unreachableNote(computer)}
				</div>
			))}
			{(listed?.failures ?? []).map(failure => (
				<div key={failure.name} className="sh-companion-empty">
					{failure.name}: {failure.message}
				</div>
			))}
			{searchTargets.length > 0 && (
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
					searchTargets.map(computer => {
						const search = (
							<MessageSearch
								client={computer.client}
								query={mq}
								canStart={computer.snap.canStart}
								currentSessionId={currentSessionId}
								busy={busy}
								onOpen={hit => openHit(computer, hit)}
								onShare={hit => shareHit(computer, hit)}
								onResume={hit => resumeHit(computer, hit)}
								agent={activeAgent}
							/>
						);
						return several ? (
							<section key={computer.id} className="sh-switch-section" aria-label={computer.name}>
								<h2 className="sh-recents-title">
									<Laptop size={14} />
									{computer.name}
								</h2>
								{search}
							</section>
						) : (
							<div key={computer.id}>{search}</div>
						);
					})
				) : (
					<div className="sh-companion-empty">
						Type at least {MIN_QUERY_CHARS} characters to search what was said in your sessions.
					</div>
				)
			) : listed === null ? (
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
					{[...groups].map(([groupKey, group]) => {
						const { computer, folder } = group;
						return (
							<section key={groupKey} className="sh-switch-section" aria-label={folder}>
								<h2 className="sh-recents-title sh-stats-group" title={folder}>
									<span className="sh-recent-cwd">{shortenPath(folder)}</span>
									{group.sessions.length > 1 && (
										<span className="sh-stats-group-cost">{fmtCost(group.cost)}</span>
									)}
								</h2>
								{group.sessions.every(session => session.worktree === true && session.live === undefined) && (
									<div className="sh-review-worktree">
										{removing === groupKey ? (
											<div className="sh-review-confirm" role="group" aria-label="Confirm">
												<div className="sh-field-label">
													This will run on {several ? computer.name : "your computer"}:
												</div>
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
														onClick={() => void run(groupKey, () => removeWorktree(computer, folder))}
													>
														{busy === groupKey ? (
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
												onClick={() => setRemoving(groupKey)}
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
											canStart={computer.snap.canStart}
											computerName={several && activeComputer === null ? computer.name : undefined}
											onOpen={instanceId =>
												run(session.sessionId, () => onOpenHost(computer.id, instanceId))
											}
											onShare={instanceId => run(session.sessionId, () => share(computer, instanceId))}
											onResume={() => run(session.sessionId, force => resume(computer, session, force))}
											onDelete={
												deleter !== null && deletableOverview(computer, session)
													? () =>
															deleter.request({
																computerId: computer.id,
																sessions: [
																	{ sessionId: session.sessionId, title: session.title ?? "Untitled" },
																],
																openSessionId: currentSessionId ?? null,
															})
													: undefined
											}
										/>
									))}
								</ul>
							</section>
						);
					})}
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
	/** The computer the session is on, named when there are several. */
	computerName?: string;
	onOpen(instanceId: string): void;
	onShare(instanceId: string): void;
	onResume(): void;
	/** Delete the session (after a confirmation); absent where it cannot be deleted. */
	onDelete?: () => void;
}

export function SessionRow({
	session,
	current,
	busy,
	canStart,
	computerName,
	onOpen,
	onShare,
	onResume,
	onDelete,
}: SessionRowProps): ReactNode {
	const { instanceId } = session;
	const working = busy === session.sessionId;
	const spinner = working ? <LoaderCircle size={14} className="sh-spin" /> : null;
	return (
		<li className="sh-recent">
			<div className="sh-recent-join sh-idle-info" title={session.folder}>
				<span className="sh-recent-title sh-recent-title-wrap">
					<span className="sh-recent-name">{session.title ?? "Untitled"}</span>
					<AgentChip agent={session.agent} />
					{computerName !== undefined && <ComputerChip name={computerName} />}
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
			{onDelete !== undefined && (
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={onDelete}
					disabled={busy !== null}
					aria-label={`Delete ${session.title ?? "Untitled"}`}
				>
					<Trash2 size={15} />
				</button>
			)}
		</li>
	);
}
