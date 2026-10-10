import { ChevronLeft, FolderOpen, GitBranch, LoaderCircle, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient, RecentFolder } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import { setOpenIntent } from "../../lib/inbox";
import { type RequestState, useRequest } from "../../lib/use-request";
import { QuickReplies } from "./QuickReplies";
import { Sheet } from "./Sheet";

export interface StartSessionSheetProps {
	client: CompanionClient;
	/** The companion can start sandboxed sessions: offer the toggle. */
	canSandbox: boolean;
	/** Join the started host; rejects with a readable message. */
	onOpen(instanceId: string): Promise<void>;
	onClose(): void;
}

interface Starting {
	cwd: string;
	/** Session id being resumed; undefined for a new session. */
	resume?: string;
	sandboxed: boolean;
	/** Run on a new branch in its own git worktree (new sessions only). */
	worktree?: { branch?: string };
}

function folderName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** Pick a folder omp has run in, then start a new session there or resume one. */
export function StartSessionSheet({ client, canSandbox, onOpen, onClose }: StartSessionSheetProps): ReactNode {
	const load = useCallback(() => client.requestFolders(), [client]);
	const { state, reload } = useRequest(load);
	const [folder, setFolder] = useState<RecentFolder | null>(null);
	const [starting, setStarting] = useState<Starting | null>(null);
	const [sandboxed, setSandboxed] = useState(false);
	const [worktree, setWorktree] = useState(false);
	const [branch, setBranch] = useState("");
	const [prompt, setPrompt] = useState("");
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
			const instanceId = await client.startSession(target.cwd, {
				resume: target.resume,
				sandboxed: target.sandboxed || undefined,
				worktree: target.worktree,
			});
			const first = prompt.trim();
			// Recorded even if the sheet was closed meanwhile: opening the session later still sends it.
			if (first) setOpenIntent(instanceId, { prompt: first });
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
			{error && <div className="sh-connect-error">{error}</div>}
			{starting !== null ? (
				<div className="sh-start-progress" role="status">
					<LoaderCircle size={22} className="sh-spin" />
					<div className="sh-start-progress-title">
						{starting.resume ? "Resuming" : "Starting"} {starting.sandboxed ? "sandboxed " : ""}omp in{" "}
						{folderName(starting.cwd)}
						{starting.worktree ? " on a new worktree" : ""}…
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
					{canSandbox && (
						<label className="sh-start-sandbox">
							<input type="checkbox" checked={sandboxed} onChange={e => setSandboxed(e.currentTarget.checked)} />
							<span className="sh-start-sandbox-text">
								<span className="sh-start-sandbox-title">
									<ShieldCheck size={14} /> Sandboxed
								</span>
								<span className="sh-field-hint">
									Reads and edits files only; changes stay in this folder. No commands run.
								</span>
							</span>
						</label>
					)}
					<label className="sh-start-sandbox">
						<input type="checkbox" checked={worktree} onChange={e => setWorktree(e.currentTarget.checked)} />
						<span className="sh-start-sandbox-text">
							<span className="sh-start-sandbox-title">
								<GitBranch size={14} /> New git worktree
							</span>
							<span className="sh-field-hint">
								New session only: work on a fresh branch in its own checkout, so this folder stays untouched.
							</span>
						</span>
					</label>
					{worktree && (
						<input
							className="sh-input sh-input-mono"
							value={branch}
							onChange={e => setBranch(e.currentTarget.value)}
							placeholder="branch name (default omp/<date>-<id>)"
							aria-label="worktree branch name"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
					)}
					<label className="sh-start-prompt">
						<span className="sh-field-label">First prompt (optional)</span>
						<textarea
							className="sh-input sh-start-prompt-input"
							value={prompt}
							onChange={e => setPrompt(e.currentTarget.value)}
							placeholder="Sent as soon as the session is up"
							rows={3}
							spellCheck={false}
						/>
					</label>
					<QuickReplies disabled={false} onPick={text => setPrompt(prev => (prev ? `${prev}\n${text}` : text))} />
					<button
						type="button"
						className="sh-btn sh-btn-primary sh-start-new"
						onClick={() =>
							void start({
								cwd: folder.cwd,
								sandboxed,
								worktree: worktree ? { branch: branch.trim() || undefined } : undefined,
							})
						}
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
											onClick={() => void start({ cwd: folder.cwd, resume: session.id, sandboxed })}
										>
											<span className="sh-recent-title">
												<span className="sh-recent-name">{session.title ?? "Untitled session"}</span>
											</span>
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
								<span className="sh-recent-name">{folderName(folder.cwd)}</span>
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
