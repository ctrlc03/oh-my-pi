import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import type { Spar, SparGetAnswer, SparRun, SparSummary } from "@oh-my-pi/pi-wire/spar";
import { ChevronLeft, Eye, LoaderCircle, RefreshCw, Swords, Trash2, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import type { ExcerptCache, ExcerptReader } from "../quiz/QuizCode";
import { PointView, type PointPending } from "./PointView";
import { SparSummaryView } from "./SparSummaryView";
import { againSpar, closeSpar, deleteSpar, getSpar, getSparExcerpts, listSpars, replySpar } from "./spar-api";
import { firstOpen, landingOf, latestRun, nextPoint, positionLabel, recordOf, runPoints, summaryOf } from "./spar-flow";

export interface SparScreenProps {
	client: CompanionClient;
	id: string;
	/** The spar's row when the list had it: shown at once while the current state is read. */
	hint?: SparSummary;
	/** Host of the session on screen when it is on this spar's computer, so its own spar-writing session is not offered as a link. */
	currentInstanceId: string | null;
	onOpenHost(instanceId: string): Promise<void>;
	/** Opens a cited line of the checkout on screen when it is this spar's repository. */
	editor?: { root: string; open(path: string, line?: number): void };
	/** Start another spar about the same subject; null when it cannot be done from here. */
	onNewSpar: ((spar: Spar) => void) | null;
	/** Bake off the change or design this spar is about, taking the run shown; absent when it cannot be done from here. */
	onBakeoff?(spar: Spar, run: SparRun): void;
	onHistory(): void;
	onClose(): void;
}

interface HeaderProps {
	title?: string;
	/** "Run 2 of 3"; absent with one run. */
	runLabel?: string;
	onHistory(): void;
	onClose(): void;
}

/** The head of a spar screen: back to the list, the spar's name and run, and close. */
function SparHeader({ title, runLabel, onHistory, onClose }: HeaderProps): ReactNode {
	return (
		<div className="sh-sheet-head sp-head">
			<button type="button" className="sh-btn sh-gh-back" onClick={onHistory}>
				<ChevronLeft size={16} /> Sparring
			</button>
			{title !== undefined && <span className="sp-head-title">{title}</span>}
			{runLabel !== undefined && <span className="sp-head-run">{runLabel}</span>}
			<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
				<X size={16} />
			</button>
		</div>
	);
}

/** The spar's summary row, kept current by the companion's pushes while a spar is being prepared. */
function useSummary(
	client: CompanionClient,
	id: string,
	hint: SparSummary | undefined,
): { summary: SparSummary | null; missing: boolean; error: string | null; reload(): void } {
	const load = useCallback(async () => (await listSpars(client)).find(item => item.id === id) ?? null, [client, id]);
	const { state, reload } = useRequest(load);
	const kept = useRef<SparSummary | null>(hint ?? null);
	if (state.status === "ready" && state.value !== null) kept.current = state.value;
	useEffect(() => client.onSparChanged(changed => changed === id && reload()), [client, id, reload]);
	return {
		summary: kept.current,
		missing: state.status === "ready" && state.value === null,
		error: state.status === "error" ? state.message : null,
		reload,
	};
}

/** One spar opened from the list or just started: being prepared, failed, or ready to argue. */
export function SparScreen({
	client,
	id,
	hint,
	currentInstanceId,
	onOpenHost,
	editor,
	onNewSpar,
	onBakeoff,
	onHistory,
	onClose,
}: SparScreenProps): ReactNode {
	const { summary, missing, error, reload } = useSummary(client, id, hint);
	const header = <SparHeader onHistory={onHistory} onClose={onClose} />;
	if (missing) {
		return (
			<>
				{header}
				<div className="sp-center">
					<p>This spar no longer exists.</p>
					<button type="button" className="sh-btn" onClick={onHistory}>
						Back to the spars
					</button>
				</div>
			</>
		);
	}
	if (summary === null) {
		return (
			<>
				{header}
				{error === null ? (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Opening the spar…
					</div>
				) : (
					<div className="sp-center">
						<div className="sp-alert" role="alert">
							{error}
						</div>
						<button type="button" className="sh-btn" onClick={reload}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				)}
			</>
		);
	}
	if (summary.status !== "ready") {
		return (
			<>
				{header}
				<Preparing
					client={client}
					summary={summary}
					watchable={summary.instanceId !== currentInstanceId}
					onOpenHost={onOpenHost}
					onGone={onHistory}
				/>
			</>
		);
	}
	return (
		<ReadySpar
			client={client}
			summary={summary}
			editor={editor}
			onNewSpar={onNewSpar}
			onBakeoff={onBakeoff}
			onHistory={onHistory}
			onClose={onClose}
		/>
	);
}

function Preparing({
	client,
	summary,
	watchable,
	onOpenHost,
	onGone,
}: {
	client: CompanionClient;
	summary: SparSummary;
	watchable: boolean;
	onOpenHost(instanceId: string): Promise<void>;
	onGone(): void;
}): ReactNode {
	const [busy, setBusy] = useState<"delete" | "watch" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const failed = summary.status === "failed";
	const act = async (what: "delete" | "watch", action: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
			setConfirming(false);
		}
	};
	return (
		<div className="sp-center">
			<Swords size={30} aria-hidden="true" />
			<h2 className="sp-form-title">{summary.subject}</h2>
			{failed ? (
				<div className="sp-alert" role="alert">
					<TriangleAlert size={15} aria-hidden="true" />
					<span>{summary.error ?? "The spar could not be made."}</span>
				</div>
			) : (
				<>
					<p className="sp-progress" role="status">
						<LoaderCircle size={15} className="sh-spin" /> {summary.progress ?? "Starting"}
					</p>
					<p className="sp-muted">
						The partner is reading the code and writing its challenges. This takes a few minutes; the spar is in
						the list when it is ready.
					</p>
				</>
			)}
			{error !== null && (
				<div className="sp-alert" role="alert">
					{error}
				</div>
			)}
			<div className="sp-actions">
				{!failed && watchable && summary.instanceId !== undefined && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy !== null}
						onClick={() =>
							summary.instanceId !== undefined && void act("watch", () => onOpenHost(summary.instanceId!))
						}
					>
						{busy === "watch" ? <LoaderCircle size={14} className="sh-spin" /> : <Eye size={14} />} Watch the
						agent
					</button>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							className="sh-btn sp-danger"
							disabled={busy !== null}
							onClick={() =>
								void act("delete", async () => {
									await deleteSpar(client, summary.id);
									onGone();
								})
							}
						>
							{busy === "delete" ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
							{failed ? "Delete" : "Stop and delete"}
						</button>
						<button type="button" className="sh-btn" onClick={() => setConfirming(false)}>
							Keep
						</button>
					</>
				) : (
					<>
						<button type="button" className="sh-btn" disabled={busy !== null} onClick={() => setConfirming(true)}>
							<Trash2 size={14} /> {failed ? "Delete" : "Cancel and delete"}
						</button>
						{failed && (
							<button type="button" className="sh-btn" onClick={onGone}>
								Back to the spars
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}

function ReadySpar({
	client,
	summary,
	editor,
	onNewSpar,
	onBakeoff,
	onHistory,
	onClose,
}: {
	client: CompanionClient;
	summary: SparSummary;
	editor?: SparScreenProps["editor"];
	onNewSpar: SparScreenProps["onNewSpar"];
	onBakeoff?: SparScreenProps["onBakeoff"];
	onHistory(): void;
	onClose(): void;
}): ReactNode {
	const load = useCallback(() => getSpar(client, summary.id), [client, summary.id]);
	const { state, reload } = useRequest(load);
	// Another device's reply refreshes this one; the points stay on screen while it is read.
	const kept = useRef<SparGetAnswer | null>(null);
	if (state.status === "ready") kept.current = state.value;
	useEffect(() => client.onSparChanged(changed => changed === summary.id && reload()), [client, summary.id, reload]);
	if (kept.current !== null) {
		return (
			<SparPlay
				client={client}
				spar={kept.current.spar}
				given={kept.current.runs}
				costUsd={summary.costUsd}
				editor={editor}
				onNewSpar={onNewSpar}
				onBakeoff={onBakeoff}
				onHistory={onHistory}
				onClose={onClose}
			/>
		);
	}
	return (
		<>
			<SparHeader onHistory={onHistory} onClose={onClose} />
			{state.status === "error" ? (
				<div className="sp-center">
					<div className="sp-alert" role="alert">
						{state.message}
					</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			) : (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Opening the spar…
				</div>
			)}
		</>
	);
}

type View = { kind: "point"; id: string; review: boolean } | { kind: "summary" };

interface Pending {
	key: string;
	what: PointPending;
}

interface SparPlayProps {
	client: CompanionClient;
	spar: Spar;
	/** Every run the companion holds; the latest unfinished one is resumed at its first open point. */
	given: readonly SparRun[];
	costUsd: number | undefined;
	editor?: SparScreenProps["editor"];
	onNewSpar: SparScreenProps["onNewSpar"];
	onBakeoff?: SparScreenProps["onBakeoff"];
	onHistory(): void;
	onClose(): void;
}

/**
 * A loaded spar being argued: one point at a time with the partner's replies and the outcome, then the summary. The
 * records live on the companion, so closing the sheet or reloading comes back to the first open point.
 */
function SparPlay({
	client,
	spar,
	given,
	costUsd,
	editor,
	onNewSpar,
	onBakeoff,
	onHistory,
	onClose,
}: SparPlayProps): ReactNode {
	const [runs, setRuns] = useState<readonly SparRun[]>(given);
	const [seen, setSeen] = useState(given);
	const landing = useMemo(() => landingOf(spar, given), [spar, given]);
	const [runId, setRunId] = useState<string | null>(landing?.run ?? null);
	const [view, setView] = useState<View>(
		landing?.kind === "point" ? { kind: "point", id: landing.point, review: false } : { kind: "summary" },
	);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [pending, setPending] = useState<Pending | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [again, setAgain] = useState<"all" | "unsettled" | null>(null);
	const [againError, setAgainError] = useState<string | null>(null);
	const cache = useRef<ExcerptCache>(new Map()).current;
	const excerpts = useCallback<ExcerptReader>(
		(part, refs) => getSparExcerpts(client, spar.id, part, refs),
		[client, spar.id],
	);
	const openInEditor =
		editor !== undefined && editor.root === spar.repo.root
			? (ref: BlueprintRef) => editor.open(`${editor.root}/${ref.path}`, ref.line)
			: undefined;

	// A newer reading of the spar (a reply made elsewhere) replaces the runs, unless a reply of this screen is in flight.
	if (seen !== given) {
		setSeen(given);
		if (pending === null) setRuns(given);
	}

	const run = runs.find(item => item.id === runId) ?? latestRun(runs) ?? null;
	const points = useMemo(() => (run === null ? [] : runPoints(spar, run)), [spar, run]);

	const act = async (
		point: string,
		what: PointPending,
		action: (run: SparRun) => Promise<SparRun>,
	): Promise<boolean> => {
		if (run === null) return false;
		const key = `${run.id}:${point}`;
		setPending({ key, what });
		setErrors(list => Object.fromEntries(Object.entries(list).filter(([name]) => name !== key)));
		try {
			const updated = await action(run);
			setRuns(list => list.map(item => (item.id === updated.id ? updated : item)));
			return true;
		} catch (err) {
			setErrors(list => ({ ...list, [key]: err instanceof Error ? err.message : String(err) }));
			return false;
		} finally {
			setPending(null);
		}
	};

	const send = async (point: string, text: string): Promise<void> => {
		const sent = await act(
			point,
			"reply",
			async current => (await replySpar(client, spar.id, current.id, point, text)).run,
		);
		if (sent && run !== null) setDrafts(list => ({ ...list, [`${run.id}:${point}`]: "" }));
	};

	const startRun = async (only: "all" | "unsettled"): Promise<void> => {
		setAgain(only);
		setAgainError(null);
		try {
			const fresh = await againSpar(client, spar.id, only, run?.id);
			setRuns(list => [...list.filter(item => item.id !== fresh.id), fresh]);
			setRunId(fresh.id);
			const first = runPoints(spar, fresh)[0];
			setView(first === undefined ? { kind: "summary" } : { kind: "point", id: first.id, review: false });
		} catch (err) {
			setAgainError(err instanceof Error ? err.message : String(err));
		} finally {
			setAgain(null);
		}
	};

	const runLabel =
		run === null || runs.length < 2
			? undefined
			: `Run ${[...runs].sort((a, b) => a.startedAt - b.startedAt).findIndex(item => item.id === run.id) + 1} of ${runs.length}`;
	const header = <SparHeader title={spar.title} runLabel={runLabel} onHistory={onHistory} onClose={onClose} />;

	if (run === null) {
		return (
			<>
				{header}
				<div className="sp-center">
					<p>This spar has nothing to argue yet.</p>
				</div>
			</>
		);
	}

	const point = view.kind === "point" ? points.find(item => item.id === view.id) : undefined;
	if (view.kind === "point" && point !== undefined) {
		const key = `${run.id}:${point.id}`;
		const following = nextPoint(points, run, point.id);
		return (
			<>
				{header}
				<div className="sp-scroll sp-scroll-point">
					<PointView
						key={key}
						code={{ excerpts, cache, openInEditor }}
						point={point}
						label={positionLabel(points, points.indexOf(point))}
						progress={{
							closed: points.filter(item => recordOf(run, item.id).outcome !== undefined).length,
							total: points.length,
						}}
						record={recordOf(run, point.id)}
						draft={drafts[key] ?? ""}
						onDraft={text => setDrafts(list => ({ ...list, [key]: text }))}
						pending={pending?.key === key ? pending.what : null}
						error={errors[key] ?? null}
						onSend={text => void send(point.id, text)}
						onConcede={() =>
							void act(
								point.id,
								"concede",
								async current => (await closeSpar(client, spar.id, current.id, point.id, "lost")).run,
							)
						}
						onAccept={note =>
							void act(
								point.id,
								"accept",
								async current => (await closeSpar(client, spar.id, current.id, point.id, "open", note)).run,
							)
						}
						review={view.review}
						next={
							following === null
								? { label: "See the summary", summary: true }
								: { label: "Next point", summary: false }
						}
						onNext={() =>
							setView(
								following === null ? { kind: "summary" } : { kind: "point", id: following.id, review: false },
							)
						}
						onBackToSummary={() => setView({ kind: "summary" })}
					/>
				</div>
			</>
		);
	}
	const model = summaryOf(spar, run);
	const resume = firstOpen(points, run);
	return (
		<>
			{header}
			<div className="sp-scroll">
				<SparSummaryView
					code={{ excerpts, cache, openInEditor }}
					spar={spar}
					run={run}
					summary={model}
					runs={[...runs].sort((a, b) => b.startedAt - a.startedAt)}
					costUsd={costUsd}
					again={again}
					error={againError}
					onReview={id => setView({ kind: "point", id, review: true })}
					onContinue={() => {
						if (resume !== -1) setView({ kind: "point", id: points[resume]!.id, review: false });
					}}
					onAgain={only => void startRun(only)}
					onSelectRun={id => {
						const chosen = runs.find(item => item.id === id);
						if (chosen === undefined) return;
						setRunId(id);
						setAgainError(null);
						// A run left half done resumes where it stopped.
						const open = firstOpen(runPoints(spar, chosen), chosen);
						if (open !== -1) setView({ kind: "point", id: runPoints(spar, chosen)[open]!.id, review: false });
					}}
					onNewSpar={onNewSpar === null ? null : () => onNewSpar(spar)}
					onBakeoff={onBakeoff === undefined ? undefined : () => onBakeoff(spar, run)}
					onHistory={onHistory}
				/>
			</div>
		</>
	);
}
