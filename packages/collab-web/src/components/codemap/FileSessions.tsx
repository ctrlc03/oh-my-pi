import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { extractLink } from "../../lib/rooms";
import { useRequest } from "../../lib/use-request";
import { SessionRow } from "../shell/SessionsSheet";

export interface FileSessionsProps {
	client: CompanionClient;
	/** Companion host of the session whose repository the file belongs to. */
	instanceId: string;
	/** Repository-relative path of the file. */
	path: string;
	/** The companion can start omp, so ended sessions can be resumed. */
	canStart: boolean;
	/** Session on screen: marked and not openable. */
	currentSessionId: string | null;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
}

/**
 * "Sessions that changed this file": collapsed until asked for, since the companion has to read session
 * files to answer. Rows open, share or resume like the all-sessions list.
 */
export function FileSessions(props: FileSessionsProps): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<section className="sh-cm-sessions" aria-label="sessions that changed this file">
			<button type="button" className="sh-sheet-link" onClick={() => setOpen(o => !o)} aria-expanded={open}>
				Sessions that changed this file
				{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
			</button>
			{open && <FileSessionList {...props} />}
		</section>
	);
}

function FileSessionList({
	client,
	instanceId,
	path,
	canStart,
	currentSessionId,
	onOpenHost,
	onOpenLink,
}: FileSessionsProps): ReactNode {
	const load = useCallback(() => client.requestFileSessions(instanceId, path), [client, instanceId, path]);
	const { state, reload } = useRequest(load);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const closedRef = useRef(false);
	useEffect(() => {
		closedRef.current = false;
		return () => {
			closedRef.current = true;
		};
	}, []);

	/** Run one row's action; the list stays up (with the error) when it fails. */
	const run = async (id: string, action: () => Promise<void>): Promise<void> => {
		if (busy) return;
		setBusy(id);
		setError(null);
		try {
			await action();
		} catch (err) {
			if (!closedRef.current) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (!closedRef.current) setBusy(null);
		}
	};

	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Reading recent sessions…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{state.message}</div>
				<button type="button" className="sh-btn" onClick={reload}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	}
	if (state.value.length === 0) {
		return <div className="sh-companion-empty">No recent session changed this file.</div>;
	}
	return (
		<>
			<ul className="sh-recents-list">
				{state.value.map(session => (
					<SessionRow
						key={session.sessionId}
						session={session}
						current={session.sessionId === currentSessionId}
						busy={busy}
						canStart={canStart}
						onOpen={id => run(session.sessionId, () => onOpenHost(id))}
						onShare={id =>
							run(session.sessionId, async () => {
								const link = extractLink(await client.shareSession(id));
								if (!link) throw new Error("the computer returned an unreadable link");
								onOpenLink(link);
							})
						}
						onResume={() =>
							run(session.sessionId, async () =>
								onOpenHost(await client.startSession(session.folder, { resume: session.sessionId })),
							)
						}
					/>
				))}
			</ul>
			{error && <div className="sh-connect-error">{error}</div>}
		</>
	);
}
