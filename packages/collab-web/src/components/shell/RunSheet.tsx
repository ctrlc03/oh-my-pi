import {
	ArrowDown,
	ChevronLeft,
	ChevronRight,
	LoaderCircle,
	Play,
	RefreshCw,
	SendHorizontal,
	Square,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ansiClass, parseAnsi } from "../../lib/ansi";
import type { CompanionClient, RunInfo, RunSource, RunTarget } from "../../lib/companion";
import { relTime } from "../../lib/format";
import { collapseOverwrites, lastLines, outputPrompt, runDuration, runStatus, VIEW_LINES } from "../../lib/run-output";
import { useRequest } from "../../lib/use-request";
import { followTranscriptTail, updateTranscriptTailLock } from "../transcript/Transcript";
import { Sheet } from "./Sheet";
import "./pane.css";
import "./run.css";

/** Between output requests while a run goes and nothing new arrived. */
const POLL_MS = 1_000;
/** Between requests while output keeps arriving: drains a backlog without hammering the relay. */
const BACKLOG_MS = 40;
/** Output kept in the page; the companion keeps the same amount. */
const KEEP_CHARS = 1_048_576;

const SOURCE_LABELS: Record<RunSource, string> = {
	package: "package.json",
	make: "Makefile",
	just: "justfile",
	cargo: "Cargo",
};
const SOURCES: RunSource[] = ["package", "make", "just", "cargo"];

export interface RunSheetProps {
	client: CompanionClient;
	/** Companion host of the session whose repository runs. */
	instanceId: string;
	/** The computer's name, for the confirmation. */
	machine: string | null;
	/** Put a prompt into the composer; null when this device cannot prompt. */
	onSendToAgent: ((prompt: string) => void) | null;
	onClose(): void;
}

/**
 * Scripts and build targets of the session's repository, started on the computer. Only targets the
 * companion lists can run, and each asks first with the exact command line. A run keeps going on the
 * computer when this sheet or the app closes; its output and exit status are here to come back to.
 */
export function RunSheet({ client, instanceId, machine, onSendToAgent, onClose }: RunSheetProps): ReactNode {
	const [active, setActive] = useState<RunInfo | null>(null);
	const [confirm, setConfirm] = useState<RunTarget | null>(null);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadTargets = useCallback(() => client.requestRunTargets(instanceId), [client, instanceId]);
	const targets = useRequest(loadTargets);
	const loadRuns = useCallback(() => client.requestRuns(instanceId), [client, instanceId]);
	const runs = useRequest(loadRuns);
	const reloadRuns = runs.reload;

	const start = async (target: RunTarget): Promise<void> => {
		setStarting(true);
		setError(null);
		try {
			const run = await client.startRun(instanceId, target);
			setConfirm(null);
			setActive(run);
			reloadRuns();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setStarting(false);
		}
	};

	const back = (): void => {
		setActive(null);
		reloadRuns();
	};

	if (active !== null) {
		return (
			<Sheet label="run output" size="full" onClose={onClose}>
				<RunDetail
					key={active.runId}
					client={client}
					initial={active}
					onBack={back}
					onSettled={reloadRuns}
					onSendToAgent={onSendToAgent}
					onClose={onClose}
				/>
			</Sheet>
		);
	}

	const loading = targets.state.status === "loading" || runs.state.status === "loading";
	const refresh = (): void => {
		targets.reload();
		reloadRuns();
	};
	const list = targets.state.status === "ready" ? targets.state.value : null;
	const recent = runs.state.status === "ready" ? runs.state.value : [];

	return (
		<Sheet label="run" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					Run
					<span className="sh-run-sub">in the repository root, on {machine ?? "the computer"}</span>
				</div>
				<span className="sh-file-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={refresh}
						disabled={loading}
						aria-label="Refresh"
						title="Refresh"
					>
						{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{error !== null && <div className="sh-connect-error">{error}</div>}
			{confirm !== null && (
				<div className="sh-run-confirm" role="group" aria-label="Confirm run">
					<div>Run this on {machine ?? "the computer"}?</div>
					<code className="sh-run-command">{confirm.command}</code>
					{confirm.detail !== undefined && (
						<>
							<div className="sh-run-note">That command executes, from the repository's files:</div>
							<pre className="sh-run-detail">{confirm.detail}</pre>
						</>
					)}
					<div className="sh-run-note">
						It runs in the repository root with your computer's access, and keeps running if you close the app.
					</div>
					<div className="sh-run-actions">
						<button type="button" className="sh-btn" onClick={() => setConfirm(null)} disabled={starting}>
							Cancel
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={() => void start(confirm)}
							disabled={starting}
						>
							{starting ? <LoaderCircle size={14} className="sh-spin" /> : <Play size={14} />} Run
						</button>
					</div>
				</div>
			)}
			{targets.state.status === "error" && <div className="sh-connect-error">{targets.state.message}</div>}
			{list === null
				? targets.state.status === "loading" && (
						<div className="sh-companion-empty sh-file-status">
							<LoaderCircle size={14} className="sh-spin" /> Looking for scripts…
						</div>
					)
				: list.length === 0 && (
						<div className="sh-companion-empty">
							Nothing to run here: no package.json scripts, Makefile targets, justfile recipes or Cargo project.
						</div>
					)}
			{list !== null &&
				SOURCES.map(source => {
					const group = list.filter(t => t.source === source);
					if (group.length === 0) return null;
					return (
						<section key={source} className="sh-run-group">
							<h3 className="sh-run-heading">{SOURCE_LABELS[source]}</h3>
							<ul className="sh-run-list">
								{group.map(target => (
									<li key={target.id} className="sh-run-row">
										<span className="sh-run-row-main">
											<span className="sh-run-name">{target.name}</span>
											<span className="sh-run-line">{target.command}</span>
										</span>
										<button
											type="button"
											className="sh-btn"
											onClick={() => setConfirm(target)}
											disabled={starting}
											aria-label={`Run ${target.command}`}
										>
											<Play size={14} /> Run
										</button>
									</li>
								))}
							</ul>
						</section>
					);
				})}
			{recent.length > 0 && (
				<section className="sh-run-group">
					<h3 className="sh-run-heading">Recent runs</h3>
					<ul className="sh-run-list">
						{recent.map(run => (
							<li key={run.runId}>
								<button type="button" className="sh-run-row sh-run-open" onClick={() => setActive(run)}>
									<span className="sh-run-row-main">
										<span className="sh-run-name">{run.command}</span>
										<span className="sh-run-line">
											{relTime(run.startedAt)} · {runDuration(run, Date.now())}
										</span>
									</span>
									<StatusChip run={run} />
									<ChevronRight size={14} />
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
			{runs.state.status === "error" && <div className="sh-connect-error">{runs.state.message}</div>}
		</Sheet>
	);
}

function StatusChip({ run }: { run: RunInfo }): ReactNode {
	const tone = run.state === "running" ? "run" : run.state === "exited" && run.exitCode === 0 ? "ok" : "err";
	return (
		<span className={`sh-run-chip sh-run-chip-${tone}`}>
			{run.state === "running" && <LoaderCircle size={11} className="sh-spin" />} {runStatus(run)}
		</span>
	);
}

interface RunDetailProps {
	client: CompanionClient;
	initial: RunInfo;
	onBack(): void;
	/** The run ended and its output is complete. */
	onSettled(): void;
	onSendToAgent: ((prompt: string) => void) | null;
	onClose(): void;
}

/** Live output of one run, polled from the companion while the page is visible. */
function RunDetail({ client, initial, onBack, onSettled, onSendToAgent, onClose }: RunDetailProps): ReactNode {
	const [run, setRun] = useState(initial);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [stopping, setStopping] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const runId = initial.runId;

	useEffect(() => {
		let closed = false;
		let timer: Timer | undefined;
		let next = 0;
		const tick = async (): Promise<void> => {
			let delay = POLL_MS;
			if (document.visibilityState === "visible") {
				try {
					const out = await client.requestRunOutput(runId, next);
					if (closed) return;
					setError(null);
					setRun(out.run);
					next = out.next;
					if (out.text !== "") {
						// Output the companion already dropped leaves a gap: show only what follows it.
						setText(prev => (out.truncated ? out.text : (prev + out.text).slice(-KEEP_CHARS)));
						delay = BACKLOG_MS;
					} else if (out.run.state !== "running") {
						onSettled();
						return;
					}
				} catch (err) {
					if (closed) return;
					setError(err instanceof Error ? err.message : String(err));
				}
			}
			if (!closed) timer = setTimeout(tick, delay);
		};
		const onVisible = (): void => {
			if (document.visibilityState !== "visible") return;
			clearTimeout(timer);
			void tick();
		};
		void tick();
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			closed = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [client, runId, onSettled]);

	const running = run.state === "running";
	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(id);
	}, [running]);

	const stop = async (): Promise<void> => {
		setStopping(true);
		try {
			setRun(await client.stopRun(runId));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStopping(false);
		}
	};

	const view = useMemo(() => lastLines(collapseOverwrites(text), VIEW_LINES), [text]);
	const spans = useMemo(() => parseAnsi(view.text), [view]);

	// Follow the output until the reader scrolls up; the button brings them back, as in the transcript.
	const scroller = useRef<HTMLDivElement>(null);
	const lock = useRef(true);
	const [away, setAway] = useState(false);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el !== null) followTranscriptTail(el, lock);
	}, [spans]);
	const onScroll = (): void => {
		const el = scroller.current;
		if (el === null) return;
		updateTranscriptTailLock(el, lock);
		setAway(!lock.current);
	};
	const latest = (): void => {
		const el = scroller.current;
		if (el !== null) followTranscriptTail(el, lock, true);
		setAway(false);
	};

	return (
		<>
			<div className="sh-sheet-head">
				<button type="button" className="sh-btn" onClick={onBack}>
					<ChevronLeft size={16} /> Run
				</button>
				<span className="sh-file-actions">
					{running && (
						<button type="button" className="sh-btn sh-btn-stop" onClick={() => void stop()} disabled={stopping}>
							{stopping ? <LoaderCircle size={14} className="sh-spin" /> : <Square size={14} />}{" "}
							{stopping ? "Stopping…" : "Stop"}
						</button>
					)}
					{onSendToAgent && (
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							disabled={text === ""}
							onClick={() => onSendToAgent(outputPrompt(run, text))}
							title="Put the last 200 lines into the message box, to edit and send"
						>
							<SendHorizontal size={15} /> Send output to agent
						</button>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			<div className="sh-run-summary">
				<code className="sh-run-command">{run.command}</code>
				<StatusChip run={run} />
				<span className="sh-run-line">{runDuration(run, now)}</span>
			</div>
			{error !== null && <div className="sh-connect-error">{error}</div>}
			<div className="sh-term-view sh-run-view" ref={scroller} onScroll={onScroll}>
				{view.dropped > 0 && (
					<div className="sh-run-dropped">{view.dropped.toLocaleString("en-US")} earlier lines not shown</div>
				)}
				<pre className="sh-term">
					{spans.length === 0 && running ? "Waiting for output…" : null}
					{spans.map((span, i) => {
						const className = ansiClass(span);
						return className === "" ? (
							span.text
						) : (
							<span key={i} className={className}>
								{span.text}
							</span>
						);
					})}
				</pre>
				{away && (
					<div className="tr-jump-dock">
						<button type="button" className="tr-jump" onClick={latest}>
							<ArrowDown size={14} /> Latest
						</button>
					</div>
				)}
			</div>
		</>
	);
}
