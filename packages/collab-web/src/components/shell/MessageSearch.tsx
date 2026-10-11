import { LoaderCircle, Play, RefreshCw, Share2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CompanionClient, SessionSearchHit } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { groupBySession, queryTerms, splitMatches } from "../../lib/search-terms";
import { useRequest } from "../../lib/use-request";
import "./message-search.css";

export interface MessageSearchProps {
	client: CompanionClient;
	/** Debounced and long enough to search ({@link searchable}). */
	query: string;
	/** The companion can start omp, so ended sessions can be resumed. */
	canStart: boolean;
	/** Session on screen: its hits jump straight there. */
	currentSessionId?: string | null;
	/** sessionId whose action is running; any value disables every action. */
	busy: string | null;
	/** Hit of a session that is hosting (or on screen): open it at the message. */
	onOpen(hit: SessionSearchHit): void;
	onShare(hit: SessionSearchHit): void;
	onResume(hit: SessionSearchHit): void;
}

const hitKey = (hit: SessionSearchHit): string => `${hit.sessionId}:${hit.entryId}`;

/** `text` with every search term marked. */
function Marked({ text, terms }: { text: string; terms: readonly string[] }): ReactNode {
	return splitMatches(text, terms).map((part, i) =>
		// Parts are positional and never reorder.
		part.hit ? (
			<mark key={`${i}:${part.text}`} className="sh-msg-mark">
				{part.text}
			</mark>
		) : (
			part.text
		),
	);
}

/** Prompts and replies of every session that contain the query, grouped by session; tap one to open it at that message. */
export function MessageSearch({
	client,
	query,
	canStart,
	currentSessionId,
	busy,
	onOpen,
	onShare,
	onResume,
}: MessageSearchProps): ReactNode {
	const load = useCallback(() => client.searchSessions(query), [client, query]);
	const { state, reload } = useRequest(load);
	// Keep the previous answer on screen (dimmed) while a new search runs.
	const shown = useRef<{ results: SessionSearchHit[]; truncated: boolean } | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const answer = shown.current;
	const loading = state.status === "loading";
	const terms = useMemo(() => queryTerms(query), [query]);
	const groups = useMemo(() => groupBySession(answer?.results ?? []), [answer]);
	/** The hit of a session that is not open, awaiting a choice. */
	const [picked, setPicked] = useState<string | null>(null);

	return (
		<>
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{answer === null ? (
				state.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Searching your sessions…
					</div>
				)
			) : answer.results.length === 0 ? (
				<div className="sh-companion-empty">
					{loading
						? "Searching…"
						: answer.truncated
							? "No match yet; the search ran out of time. Try again."
							: "No message matches."}
				</div>
			) : (
				<div className={loading ? "sh-stats-body sh-stats-stale" : "sh-stats-body"}>
					{groups.map(group => {
						const first = group[0]!;
						const current = first.sessionId === currentSessionId;
						return (
							<section key={first.sessionId} className="sh-msg-group" aria-label={first.title ?? "Untitled"}>
								<div className="sh-msg-group-head" title={first.cwd}>
									<span className="sh-msg-group-title">{first.title ?? "Untitled"}</span>
									{current && <span className="sh-chip">here</span>}
									{first.live === "host" && <span className="sh-chip sh-chip-live">live</span>}
									{first.live === "idle" && <span className="sh-chip">running</span>}
									<span className="sh-recent-meta">
										<span className="sh-recent-cwd">{shortenPath(first.cwd)}</span>
										<span>{relTime(first.time)}</span>
									</span>
								</div>
								<ul className="sh-msg-hits">
									{group.map(hit => {
										const key = hitKey(hit);
										const direct = current || (hit.live === "host" && hit.instanceId !== undefined);
										const open = picked === key;
										return (
											<li key={key}>
												<button
													type="button"
													className="sh-msg-hit"
													disabled={busy !== null}
													aria-expanded={direct ? undefined : open}
													onClick={() => (direct ? onOpen(hit) : setPicked(open ? null : key))}
												>
													<span className="sh-msg-hit-meta">
														<span>{hit.role === "user" ? "You" : "Agent"}</span>
														<span>{relTime(hit.time)}</span>
													</span>
													<span className="sh-msg-snippet">
														<Marked text={hit.snippet} terms={terms} />
													</span>
												</button>
												{open && (
													<OpenChoice
														hit={hit}
														canStart={canStart}
														working={busy === hit.sessionId}
														disabled={busy !== null}
														onShare={onShare}
														onResume={onResume}
													/>
												)}
											</li>
										);
									})}
								</ul>
							</section>
						);
					})}
					{answer.truncated && (
						<div className="sh-field-hint sh-msg-more">
							Showing the newest matches. Add a word to narrow the search.
						</div>
					)}
				</div>
			)}
		</>
	);
}

interface OpenChoiceProps {
	hit: SessionSearchHit;
	canStart: boolean;
	working: boolean;
	disabled: boolean;
	onShare(hit: SessionSearchHit): void;
	onResume(hit: SessionSearchHit): void;
}

/** What opening a session that is not hosting involves, before anything starts. */
function OpenChoice({ hit, canStart, working, disabled, onShare, onResume }: OpenChoiceProps): ReactNode {
	const spinner = working ? <LoaderCircle size={14} className="sh-spin" /> : null;
	if (hit.live === "idle" && hit.instanceId !== undefined) {
		return (
			<div className="sh-msg-open" role="group" aria-label="Open session">
				<div className="sh-field-hint">
					This session is running on your computer but not shared. Sharing starts hosting it with control access,
					then opens it at this message.
				</div>
				<button type="button" className="sh-btn" disabled={disabled} onClick={() => onShare(hit)}>
					{spinner ?? <Share2 size={14} />} Share and open
				</button>
			</div>
		);
	}
	return (
		<div className="sh-msg-open" role="group" aria-label="Open session">
			<div className="sh-field-hint">
				{canStart
					? "This session has ended. Resuming starts omp for it on your computer, then opens it at this message."
					: "This session has ended, and this computer cannot start sessions."}
			</div>
			{canStart && (
				<button type="button" className="sh-btn" disabled={disabled} onClick={() => onResume(hit)}>
					{spinner ?? <Play size={14} />} Resume and open
				</button>
			)}
		</div>
	);
}
