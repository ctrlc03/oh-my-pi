import {
	CircleX,
	ExternalLink,
	GitBranch,
	LoaderCircle,
	Plus,
	RefreshCw,
	SendHorizontal,
	Wrench,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CiLogFolder, CiLogReport, CiLogSession, CompanionClient } from "../../lib/companion";
import { fixPrompt } from "../../lib/fix-prompt";
import type { FixTarget } from "../../lib/fix-route";
import { applyOpenIntent, setOpenIntent } from "../../lib/inbox";
import { extractLink } from "../../lib/rooms";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";
import "./fixit.css";

export interface FixItSheetProps {
	client: CompanionClient;
	target: FixTarget;
	/** The companion can start omp (tmux): a new session may be offered. */
	canStart: boolean;
	/** Join a hosting session; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	/** Join a session by its link (one that had to be shared first). */
	onOpenLink(link: string): void;
	onClose(): void;
}

function folderName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/**
 * Fix a pull request's failing checks: the failing checks with their log tails, and the session on this
 * computer to work in (or a new one). Opening puts a prompt into that session's message box; the user
 * edits and sends it. Sharing an idle session or starting one only happens on the button press.
 */
export function FixItSheet({ client, target, canStart, onOpenHost, onOpenLink, onClose }: FixItSheetProps): ReactNode {
	const load = useCallback(
		() => client.requestCiLog(target.repo, target.number),
		[client, target.repo, target.number],
	);
	const { state, reload } = useRequest(load);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const closedRef = useRef(false);
	useEffect(() => {
		closedRef.current = false;
		return () => {
			closedRef.current = true;
		};
	}, []);

	/** Run `work` (which records the draft and joins a session), closing the sheet once the session is open. */
	const run = async (work: () => Promise<void>): Promise<void> => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await work();
			if (!closedRef.current) onClose();
		} catch (err) {
			if (closedRef.current) return;
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	return (
		<Sheet label="fix failing checks" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<span className="sh-sheet-title">
					<Wrench size={15} /> Fix it
				</span>
				<span className="sh-stats-head-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={state.status === "loading" || busy}
						aria-label="refresh"
						title="refresh"
					>
						{state.status === "loading" ? (
							<LoaderCircle size={15} className="sh-spin" />
						) : (
							<RefreshCw size={15} />
						)}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close" title="close">
						<X size={15} />
					</button>
				</span>
			</div>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Reading the failing checks of {target.repo}#
					{target.number}…
				</div>
			)}
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{state.status === "ready" && (
				<FixItBody
					client={client}
					target={target}
					report={state.value}
					canStart={canStart}
					busy={busy}
					error={error}
					run={run}
					onOpenHost={onOpenHost}
					onOpenLink={onOpenLink}
				/>
			)}
		</Sheet>
	);
}

interface FixItBodyProps {
	client: CompanionClient;
	target: FixTarget;
	report: CiLogReport;
	canStart: boolean;
	busy: boolean;
	error: string | null;
	run(work: () => Promise<void>): Promise<void>;
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
}

function FixItBody({
	client,
	target,
	report,
	canStart,
	busy,
	error,
	run,
	onOpenHost,
	onOpenLink,
}: FixItBodyProps): ReactNode {
	const { pr, failures, moreFailures, sessions, folders } = report;
	// The report ranks the best match first; sandboxed sessions cannot run the tests the prompt asks for.
	const usable = sessions.filter(session => !session.sandboxed);
	const [pickedId, setPickedId] = useState<string | null>(null);
	const [folderCwd, setFolderCwd] = useState<string | null>(null);
	const session = usable.find(s => s.instanceId === pickedId) ?? usable[0] ?? null;
	const folder = folders.find(f => f.cwd === folderCwd) ?? folders[0] ?? null;
	// A new session needs tmux on the computer.
	const startFolder = canStart ? folder : null;
	const draft = (sessionBranch: string | null): string =>
		fixPrompt({ number: target.number, pr, failures, moreFailures, sessionBranch });

	const openSession = (chosen: CiLogSession): Promise<void> =>
		run(async () => {
			if (chosen.host) {
				setOpenIntent(chosen.instanceId, { draft: draft(chosen.branch) });
				await onOpenHost(chosen.instanceId);
				return;
			}
			const link = extractLink(await client.shareSession(chosen.instanceId));
			if (!link) throw new Error("the computer returned an unreadable link");
			setOpenIntent(chosen.instanceId, { draft: draft(chosen.branch) });
			applyOpenIntent(chosen.instanceId, link);
			onOpenLink(link);
		});

	const startIn = (chosen: CiLogFolder): Promise<void> =>
		run(async () => {
			const instanceId = await client.startSession(chosen.cwd);
			setOpenIntent(instanceId, { draft: draft(chosen.branch) });
			await onOpenHost(instanceId);
		});

	return (
		<div className="sh-fix">
			<div className="sh-fix-head">
				<h2 className="sh-gh-title">
					{pr.title || `Pull request #${target.number}`} <span className="sh-gh-number">#{target.number}</span>
				</h2>
				<div className="sh-gh-row-meta">
					<span>{target.repo}</span>
					{pr.branch && (
						<span className="sh-gh-branch">
							<code>{pr.branch}</code>
						</span>
					)}
					{pr.url && (
						<a href={pr.url} target="_blank" rel="noopener noreferrer">
							<ExternalLink size={12} /> GitHub
						</a>
					)}
				</div>
			</div>
			{failures.length === 0 ? (
				<div className="sh-companion-empty">No check is failing on this pull request right now.</div>
			) : (
				<section aria-label="failing checks">
					<h3 className="sh-recents-title">
						Failing checks{moreFailures > 0 ? ` (${failures.length} of ${failures.length + moreFailures})` : ""}
					</h3>
					<ul className="sh-fix-checks">
						{failures.map((failure, i) => (
							<li key={`${failure.check}:${i}`} className="sh-fix-check">
								<div className="sh-fix-check-name">
									<CircleX size={14} className="sh-gh-check-fail" aria-label="failed" />
									{failure.url ? (
										<a href={failure.url} target="_blank" rel="noopener noreferrer">
											{failure.check}
										</a>
									) : (
										<span>{failure.check}</span>
									)}
								</div>
								{failure.log ? (
									<pre className="sh-fix-log" tabIndex={0}>
										{failure.log}
									</pre>
								) : (
									<div className="sh-field-hint">No log from GitHub Actions for this check.</div>
								)}
							</li>
						))}
					</ul>
				</section>
			)}
			{usable.length > 0 && (
				<section aria-label="session">
					<h3 className="sh-recents-title">Session</h3>
					<div className="sh-fix-picks" role="radiogroup" aria-label="session to fix in">
						{usable.map(candidate => (
							<SessionPick
								key={candidate.instanceId}
								session={candidate}
								prBranch={pr.branch}
								on={candidate === session}
								disabled={busy}
								onPick={() => setPickedId(candidate.instanceId)}
							/>
						))}
					</div>
				</section>
			)}
			{sessions.length > usable.length && (
				<div className="sh-field-hint">
					{sessions.length - usable.length === 1 ? "A sandboxed session is" : "Sandboxed sessions are"} not
					offered: they cannot run the tests.
				</div>
			)}
			{session !== null && (
				<>
					{!session.host && (
						<div className="sh-field-hint">
							This session is not shared yet: opening it shares it with control access, as <em>Share</em> does.
						</div>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={busy || failures.length === 0}
						onClick={() => void openSession(session)}
					>
						{busy ? <LoaderCircle size={15} className="sh-spin" /> : <SendHorizontal size={15} />} Open & fill
						prompt
					</button>
				</>
			)}
			{startFolder !== null && (
				<section aria-label="new session">
					<h3 className="sh-recents-title">
						{session === null ? "No session is open in this repository" : "Or a new session"}
					</h3>
					{folders.length > 1 && (
						<div className="sh-fix-picks" role="radiogroup" aria-label="folder to start in">
							{folders.map(candidate => (
								<button
									key={candidate.cwd}
									type="button"
									role="radio"
									aria-checked={candidate === folder}
									className={candidate === folder ? "sh-fix-pick sh-fix-pick-on" : "sh-fix-pick"}
									disabled={busy}
									onClick={() => setFolderCwd(candidate.cwd)}
									title={candidate.cwd}
								>
									<span className="sh-fix-pick-name">{folderName(candidate.cwd)}</span>
									{candidate.branch && (
										<span className="sh-fix-pick-meta">
											<GitBranch size={12} /> {candidate.branch}
										</span>
									)}
								</button>
							))}
						</div>
					)}
					<button
						type="button"
						className={session === null ? "sh-btn sh-btn-primary" : "sh-btn"}
						disabled={busy || failures.length === 0}
						onClick={() => void startIn(startFolder)}
						title={startFolder.cwd}
					>
						{busy ? <LoaderCircle size={15} className="sh-spin" /> : <Plus size={15} />} Start session in{" "}
						{folderName(startFolder.cwd)}
					</button>
					<div className="sh-field-hint">
						Starts omp in {startFolder.cwd} on this computer. Nothing is sent until you press Send.
					</div>
				</section>
			)}
			{session === null && startFolder === null && (
				<div className="sh-companion-empty">
					{canStart
						? `No session or recent folder of ${target.repo} on this computer.`
						: `No session of ${target.repo} is running on this computer, and it cannot start one.`}{" "}
					Start omp in a checkout of it, then open Fix it again.
				</div>
			)}
			{error !== null && <div className="sh-connect-error">{error}</div>}
		</div>
	);
}

function SessionPick({
	session,
	prBranch,
	on,
	disabled,
	onPick,
}: {
	session: CiLogSession;
	prBranch: string;
	on: boolean;
	disabled: boolean;
	onPick(): void;
}): ReactNode {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={on}
			className={on ? "sh-fix-pick sh-fix-pick-on" : "sh-fix-pick"}
			disabled={disabled}
			onClick={onPick}
			title={session.cwd}
		>
			<span className="sh-fix-pick-name">{session.title}</span>
			<span className="sh-fix-pick-meta">
				{session.branch !== null && (
					<span className={session.branch === prBranch ? "sh-fix-branch-match" : undefined}>
						<GitBranch size={12} /> {session.branch}
					</span>
				)}
				{session.busy && <span>working</span>}
				{!session.host && <span>not shared</span>}
			</span>
		</button>
	);
}
