import { ChevronLeft, FolderOpen, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient, RecentFolder } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { type RequestState, useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";

export interface StartSessionSheetProps {
	client: CompanionClient;
	/** Join the started host; rejects with a readable message. */
	onOpen(instanceId: string): Promise<void>;
	onClose(): void;
}

interface Starting {
	cwd: string;
	/** Session id being resumed; undefined for a new session. */
	resume?: string;
}

function folderName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** Pick a folder omp has run in, then start a new session there or resume one. */
export function StartSessionSheet({ client, onOpen, onClose }: StartSessionSheetProps): ReactNode {
	const load = useCallback(() => client.requestFolders(), [client]);
	const { state, reload } = useRequest(load);
	const [folder, setFolder] = useState<RecentFolder | null>(null);
	const [starting, setStarting] = useState<Starting | null>(null);
	const [error, setError] = useState<string | null>(null);
	const closedRef = useRef(false);
	useEffect(() => {
		closedRef.current = false;
		return () => {
			closedRef.current = true;
		};
	}, []);

	const start = async (target: Starting): Promise<void> => {
		setStarting(target);
		setError(null);
		try {
			const instanceId = await client.startSession(target.cwd, target.resume);
			// Closed while omp booted: the session still appears in the computer's list.
			if (!closedRef.current) await onOpen(instanceId);
		} catch (err) {
			if (closedRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
			setStarting(null);
		}
	};

	return (
		<Sheet label="start a session" onClose={onClose}>
			<div className="sh-sheet-head">
				{folder !== null && starting === null ? (
					<button type="button" className="sh-btn sh-btn-icon" onClick={() => setFolder(null)} aria-label="back">
						<ChevronLeft size={16} />
					</button>
				) : null}
				<div className="sh-sheet-title sh-start-title">
					{folder === null ? "Start a session" : folderName(folder.cwd)}
				</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{starting !== null ? (
				<div className="sh-start-progress" role="status">
					<LoaderCircle size={22} className="sh-spin" />
					<div className="sh-start-progress-title">
						{starting.resume ? "Resuming" : "Starting"} omp in {folderName(starting.cwd)}…
					</div>
					<div className="sh-field-hint">
						This can take up to a minute while omp boots. You can close this; the session appears in your
						computer's list when it is ready.
					</div>
				</div>
			) : folder === null ? (
				<FolderList state={state} onPick={setFolder} onRetry={reload} />
			) : (
				<>
					<button
						type="button"
						className="sh-btn sh-btn-primary sh-start-new"
						onClick={() => void start({ cwd: folder.cwd })}
					>
						<Plus size={16} /> New session
					</button>
					{folder.sessions.length > 0 && (
						<section className="sh-switch-section" aria-label="resume a session">
							<h2 className="sh-recents-title">Resume</h2>
							<ul className="sh-recents-list">
								{folder.sessions.map(session => (
									<li key={session.id} className="sh-recent">
										<button
											type="button"
											className="sh-recent-join"
											onClick={() => void start({ cwd: folder.cwd, resume: session.id })}
										>
											<span className="sh-recent-title">{session.title ?? "Untitled session"}</span>
											<span className="sh-recent-meta">
												<span>{relTime(session.lastActive)}</span>
											</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					)}
				</>
			)}
			{error && <div className="sh-connect-error">{error}</div>}
		</Sheet>
	);
}

function FolderList({
	state,
	onPick,
	onRetry,
}: {
	state: RequestState<RecentFolder[]>;
	onPick(folder: RecentFolder): void;
	onRetry(): void;
}): ReactNode {
	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading folders…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{state.message}</div>
				<button type="button" className="sh-btn" onClick={onRetry}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	}
	if (state.value.length === 0) {
		return <div className="sh-companion-empty">No folders yet. Run omp once in a project to list it here.</div>;
	}
	return (
		<section className="sh-switch-section" aria-label="folders">
			<h2 className="sh-recents-title">Pick a folder</h2>
			<ul className="sh-recents-list">
				{state.value.map(folder => (
					<li key={folder.cwd} className="sh-recent">
						<button type="button" className="sh-recent-join" onClick={() => onPick(folder)} title={folder.cwd}>
							<span className="sh-recent-title">
								<FolderOpen size={14} />
								{folderName(folder.cwd)}
							</span>
							<span className="sh-recent-meta">
								<span className="sh-recent-cwd">{shortenPath(folder.cwd)}</span>
								<span>{relTime(folder.lastActive)}</span>
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}
