import type { Bakeoff, BakeoffEntry, BakeoffSummary, BakeoffTakeResult } from "@oh-my-pi/pi-wire/bakeoff";
import type { BlueprintRef } from "@oh-my-pi/pi-wire/blueprint";
import {
	ChevronLeft,
	CircleAlert,
	Copy,
	Eye,
	EyeOff,
	LoaderCircle,
	Map as MapIcon,
	MessageSquarePlus,
	RefreshCw,
	RotateCcw,
	Square,
	Swords,
	Trash2,
	Trophy,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computerById, type ComputerHandle } from "../../lib/computers";
import type { CompanionClient } from "../../lib/companion";
import { relTime } from "../../lib/format";
import { copyText } from "../../lib/share";
import { useRequest } from "../../lib/use-request";
import type { ExportedExcerpt } from "../architecture/blueprint-model";
import type { ExcerptCache } from "../quiz/QuizCode";
import { useNarrow } from "../quiz/use-narrow";
import { Sheet } from "../shell/Sheet";
import type { BakeoffCodeAccess } from "./BakeoffCode";
import { EntryGrid, type EntryHandlers } from "./BakeoffEntries";
import { EntryDetail, ResultOverview } from "./BakeoffResultView";
import {
	deleteBakeoff,
	getBakeoff,
	getBakeoffExcerpts,
	listBakeoffs,
	reviewBakeoffAgain,
	stopBakeoff,
	takeBakeoff,
} from "./bakeoff-api";
import type { BakeoffJoins } from "./bakeoff-types";
import {
	canReviewAgain,
	canTake,
	costLine,
	designMarkdown,
	entryName,
	INELIGIBLE_NOTE,
	isReviewable,
	rankRows,
	reviewAgainNote,
	runState,
	stageCostLine,
	stageIndex,
	stageSteps,
	stageWord,
	takeLines,
	takePlan,
} from "./bakeoff-result-flow";

export interface BakeoffScreenProps {
	computers: readonly ComputerHandle[];
	/** The computer that holds the bake-off. */
	computerId: string;
	id: string;
	/** The list row, shown until the current state is read. */
	hint?: BakeoffSummary;
	/** What an entry can lead to; a button shows only for the ones given. */
	joins: BakeoffJoins;
	onBack(): void;
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** Opens a cited line of the checkout on screen, for the original's code when that checkout is this repository's. */
	onOpenFile?(path: string, line?: number): void;
	onClose(): void;
	onDeleted(): void;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface HeaderProps {
	title?: string;
	onBack(): void;
	onClose(): void;
}

/** The head of the screen: back to the list, the bake-off's name, and close. */
function Header({ title, onBack, onClose }: HeaderProps): ReactNode {
	return (
		<div className="sh-sheet-head bo-head">
			<button type="button" className="sh-btn sh-gh-back" onClick={onBack}>
				<ChevronLeft size={16} /> Bake-offs
			</button>
			{title !== undefined && <span className="bo-head-title">{title}</span>}
			<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
				<X size={16} />
			</button>
		</div>
	);
}

/** One bake-off opened from the list or just started: running, failed, or with its verdict. */
export function BakeoffScreen(props: BakeoffScreenProps): ReactNode {
	const client = computerById(props.computers, props.computerId)?.client ?? null;
	if (client === null)
		return (
			<>
				<Header onBack={props.onBack} onClose={props.onClose} />
				<div className="bo-center">
					<div className="bo-alert" role="alert">
						<span>This computer is not connected.</span>
					</div>
					<button type="button" className="sh-btn" onClick={props.onBack}>
						Back to the bake-offs
					</button>
				</div>
			</>
		);
	return <LoadedScreen {...props} client={client} />;
}

/** The bake-off and its list row, both re-read when the companion says it changed. */
function useBakeoff(
	client: CompanionClient,
	id: string,
	hint: BakeoffSummary | undefined,
): {
	bakeoff: Bakeoff | null;
	summary: BakeoffSummary | null;
	missing: boolean;
	error: string | null;
	reload(): void;
} {
	const loadDoc = useCallback(() => getBakeoff(client, id), [client, id]);
	const loadRow = useCallback(
		async () => (await listBakeoffs(client)).find(item => item.id === id) ?? null,
		[client, id],
	);
	const doc = useRequest(loadDoc);
	const row = useRequest(loadRow);
	const keptDoc = useRef<Bakeoff | null>(null);
	const keptRow = useRef<BakeoffSummary | null>(hint ?? null);
	if (doc.state.status === "ready") keptDoc.current = doc.state.value;
	if (row.state.status === "ready" && row.state.value !== null) keptRow.current = row.state.value;
	const reloadDoc = doc.reload;
	const reloadRow = row.reload;
	const reload = useCallback(() => {
		reloadDoc();
		reloadRow();
	}, [reloadDoc, reloadRow]);
	useEffect(() => client.onBakeoffChanged(changed => changed === id && reload()), [client, id, reload]);
	return {
		bakeoff: keptDoc.current,
		summary: keptRow.current,
		missing: row.state.status === "ready" && row.state.value === null,
		error: doc.state.status === "error" ? doc.state.message : row.state.status === "error" ? row.state.message : null,
		reload,
	};
}

type Busy = "stop" | "delete" | "review" | "take";

function LoadedScreen({
	client,
	computerId,
	id,
	hint,
	joins,
	onBack,
	onOpenHost,
	onOpenFile,
	onClose,
	onDeleted,
}: BakeoffScreenProps & { client: CompanionClient }): ReactNode {
	const { bakeoff, summary, missing, error: loadError, reload } = useBakeoff(client, id, hint);
	const narrow = useNarrow();
	const [reveal, setReveal] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState<Busy | null>(null);
	const [confirming, setConfirming] = useState<"stop" | "delete" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stopping, setStopping] = useState<string | null>(null);
	const [opening, setOpening] = useState<string | null>(null);
	const [taking, setTaking] = useState<BakeoffEntry | null>(null);
	const [takeDone, setTakeDone] = useState<{ label: string; result: BakeoffTakeResult | undefined } | null>(null);
	const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
	const cache = useMemo<ExcerptCache>(() => new Map(), []);
	const code = useMemo<BakeoffCodeAccess>(
		() => ({
			cache,
			excerpts: (entry, refs) => getBakeoffExcerpts(client, id, entry, refs) as Promise<(ExportedExcerpt | null)[]>,
		}),
		[client, id, cache],
	);

	const act = async (what: Busy, action: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setBusy(null);
		}
	};

	const title = bakeoff?.title ?? hint?.title;
	const header = <Header title={title} onBack={onBack} onClose={onClose} />;

	if (missing)
		return (
			<>
				{header}
				<div className="bo-center">
					<p>This bake-off no longer exists.</p>
					<button type="button" className="sh-btn" onClick={onBack}>
						Back to the bake-offs
					</button>
				</div>
			</>
		);
	if (bakeoff === null)
		return (
			<>
				{header}
				{loadError === null ? (
					<div className="bo-center">
						<p className="bo-status">
							<LoaderCircle size={14} className="sh-spin" /> Opening the bake-off…
						</p>
					</div>
				) : (
					<div className="bo-center">
						<div className="bo-alert" role="alert">
							<span>{loadError}</span>
						</div>
						<button type="button" className="sh-btn" onClick={reload}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				)}
			</>
		);

	const state = runState(summary, bakeoff);
	const running = state === "running";
	const result = bakeoff.result;
	const rows = result === undefined ? [] : rankRows(result);
	// Beside the list the top entry is open; on a phone the list comes first and a tap opens one.
	const openLabel = selected ?? (narrow ? null : (rows[0]?.label ?? null));
	const entry = bakeoff.entries.find(item => item.label === openLabel);
	const cost = costLine(bakeoff, summary);
	const costs = stageCostLine(bakeoff.costs);
	const showDetail = result !== undefined && entry !== undefined;

	const handlers: EntryHandlers = {
		stopping,
		onStop: running
			? label => {
					setStopping(label);
					setError(null);
					stopBakeoff(client, id, label).then(
						() => setStopping(null),
						(err: unknown) => {
							setError(errorText(err));
							setStopping(null);
						},
					);
				}
			: undefined,
		opening,
		onOpenSession: item => {
			if (item.instanceId === undefined) return;
			setOpening(item.label);
			setError(null);
			onOpenHost(computerId, item.instanceId).then(
				() => setOpening(null),
				(err: unknown) => {
					setError(errorText(err));
					setOpening(null);
				},
			);
		},
		// The checkout on screen holds the original's code, not a challenger's worktree.
		openInEditor:
			onOpenFile === undefined
				? undefined
				: (item: BakeoffEntry, ref: BlueprintRef) => {
						if (item.kind === "original") onOpenFile(ref.path, ref.line);
					},
	};

	const take = (options: { removeOthers: boolean; discardDirty: boolean }): void => {
		if (taking === null) return;
		const target = taking;
		void act("take", async () => {
			const kept = await takeBakeoff(client, id, target.label, options);
			setTakeDone({ label: target.label, result: kept });
			setTaking(null);
			reload();
		});
	};

	const actions =
		entry === undefined || result === undefined ? null : (
			<div className="bo-actions" role="group" aria-label="What to do with this entry">
				{bakeoff.mode === "design" && entry.writeup !== undefined && (
					<button
						type="button"
						className="sh-btn"
						onClick={() =>
							void copyText(designMarkdown(bakeoff, entry)).then(ok => setCopied(ok ? "copied" : "failed"))
						}
					>
						<Copy size={14} /> Copy design
					</button>
				)}
				{bakeoff.mode === "design" && entry.writeup !== undefined && joins.startFromDesign !== undefined && (
					<button
						type="button"
						className="sh-btn"
						onClick={() => joins.startFromDesign?.(computerId, bakeoff, entry)}
					>
						<MessageSquarePlus size={14} /> Start a session from this design
					</button>
				)}
				{bakeoff.mode === "implementation" &&
					entry.path !== undefined &&
					isReviewable(entry) &&
					joins.mapEntry !== undefined && (
						<button type="button" className="sh-btn" onClick={() => joins.mapEntry?.(computerId, bakeoff, entry)}>
							<MapIcon size={14} /> Map this entry
						</button>
					)}
				{isReviewable(entry) && joins.sparEntry !== undefined && (
					<button type="button" className="sh-btn" onClick={() => joins.sparEntry?.(computerId, bakeoff, entry)}>
						<Swords size={14} /> Spar with this entry
					</button>
				)}
			</div>
		);

	const taken = result?.taken === undefined ? null : `Entry ${result.taken}`;
	const takeFor = showDetail && canTake(bakeoff, entry) ? entry : null;

	return (
		<div className="bo-screen">
			{header}
			<div className="bo-scroll">
				<section className="bo-status-block" aria-label="Progress">
					<h2 className="bo-title">{bakeoff.title}</h2>
					{running ? (
						<>
							<p className="bo-progress" role="status">
								{/* The companion's line is the more precise one; the stage word stands in until it sends one. */}
								<LoaderCircle size={15} className="sh-spin" />{" "}
								{summary?.progress ?? stageWord(bakeoff.stage, bakeoff.mode)}
							</p>
							<RunSteps bakeoff={bakeoff} />
						</>
					) : state === "failed" ? (
						<div className="bo-alert" role="alert">
							<CircleAlert size={15} aria-hidden="true" />
							<span>{summary?.error ?? "The bake-off could not finish."}</span>
						</div>
					) : (
						<p className="bo-hint">
							{bakeoff.mode === "design" ? "Design only" : "Implementation"} · started{" "}
							{relTime(bakeoff.createdAt)}
							{taken !== null && ` · ${taken} taken`}
						</p>
					)}
					{(cost !== null || costs !== null) && (
						<p className="bo-hint">
							{cost}
							{costs !== null && <span className="bo-cost-parts"> ({costs})</span>}
						</p>
					)}
					{error !== null && taking === null && (
						<div className="bo-alert" role="alert">
							<span>{error}</span>
						</div>
					)}
					<div className="bo-toolbar">
						<button type="button" className="sh-btn" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
							{reveal ? <EyeOff size={14} /> : <Eye size={14} />} Show models
						</button>
						{running &&
							(confirming === "stop" ? (
								<>
									<span className="bo-confirm-text">
										Stop the whole bake-off? Its sessions stop and what they did so far stays.
									</span>
									<button
										type="button"
										className="sh-btn bo-danger"
										disabled={busy !== null}
										onClick={() =>
											void act("stop", async () => {
												await stopBakeoff(client, id);
												setConfirming(null);
												reload();
											})
										}
									>
										{busy === "stop" ? <LoaderCircle size={14} className="sh-spin" /> : <Square size={14} />}{" "}
										Stop everything
									</button>
									<button type="button" className="sh-btn" onClick={() => setConfirming(null)}>
										Keep going
									</button>
								</>
							) : (
								<button type="button" className="sh-btn bo-danger" onClick={() => setConfirming("stop")}>
									<Square size={14} /> Stop
								</button>
							))}
						{state === "failed" && canReviewAgain(state, bakeoff) && (
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								disabled={busy !== null}
								onClick={() =>
									void act("review", async () => {
										await reviewBakeoffAgain(client, id);
										reload();
									})
								}
							>
								{busy === "review" ? <LoaderCircle size={14} className="sh-spin" /> : <RotateCcw size={14} />}{" "}
								Review again
							</button>
						)}
						{!running &&
							(confirming === "delete" ? (
								<>
									<button
										type="button"
										className="sh-btn bo-danger"
										disabled={busy !== null}
										onClick={() =>
											void act("delete", async () => {
												await deleteBakeoff(client, id);
												onDeleted();
											})
										}
									>
										{busy === "delete" ? (
											<LoaderCircle size={14} className="sh-spin" />
										) : (
											<Trash2 size={14} />
										)}{" "}
										Delete for good
									</button>
									<button type="button" className="sh-btn" onClick={() => setConfirming(null)}>
										Keep
									</button>
								</>
							) : (
								<button type="button" className="sh-btn" onClick={() => setConfirming("delete")}>
									<Trash2 size={14} /> Delete
								</button>
							))}
					</div>
					{state === "failed" && canReviewAgain(state, bakeoff) && (
						<p className="bo-hint">{reviewAgainNote(bakeoff)}</p>
					)}
					{confirming === "delete" && (
						<p className="bo-hint">
							Deleting does not remove any worktree. Remove those from the entry you take.
						</p>
					)}
				</section>
				{result === undefined ? (
					<EntryGrid bakeoff={bakeoff} reveal={reveal} code={code} detail={false} {...handlers} />
				) : (
					<div className="bo-result" data-open={entry !== undefined}>
						{(!narrow || entry === undefined) && (
							<div className="bo-pane-list">
								<ResultOverview
									bakeoff={bakeoff}
									result={result}
									reveal={reveal}
									code={code}
									selected={openLabel}
									onSelect={setSelected}
									{...handlers}
								/>
							</div>
						)}
						{showDetail && (
							<div className="bo-pane-detail">
								{narrow && (
									<button type="button" className="sh-btn bo-back" onClick={() => setSelected(null)}>
										<ChevronLeft size={14} /> Ranking
									</button>
								)}
								<EntryDetail
									key={entry.label}
									bakeoff={bakeoff}
									result={result}
									entry={entry}
									reveal={reveal}
									code={code}
									{...handlers}
								>
									{actions}
									{copied !== null && (
										<p className="bo-note" role="status">
											{copied === "copied" ? "Copied to the clipboard." : "The browser would not copy it."}
										</p>
									)}
									{takeDone?.label === entry.label && <TakenNote result={takeDone.result} reveal={reveal} />}
								</EntryDetail>
							</div>
						)}
					</div>
				)}
			</div>
			{takeFor !== null && (
				<div className="bo-take-bar">
					<span className="bo-take-for">{entryName(takeFor, reveal)}</span>
					<button
						type="button"
						className="sh-btn sh-btn-primary bo-take"
						disabled={busy !== null}
						onClick={() => {
							setError(null);
							setTaking(takeFor);
						}}
					>
						<Trophy size={14} /> Take this one
					</button>
				</div>
			)}
			{taking !== null && (
				<TakeDialog
					bakeoff={bakeoff}
					entry={taking}
					reveal={reveal}
					busy={busy === "take"}
					error={error}
					onCancel={() => {
						setTaking(null);
						setError(null);
					}}
					onConfirm={take}
				/>
			)}
		</div>
	);
}

/** Where a running bake-off is among its steps. */
function RunSteps({ bakeoff }: { bakeoff: Bakeoff }): ReactNode {
	const steps = stageSteps(bakeoff.mode);
	const at = stageIndex(bakeoff.stage, bakeoff.mode);
	if (at < 0 || at >= steps.length) return null;
	return (
		<div className="bo-steps">
			<span className="bo-bar" role="img" aria-label={`Step ${at + 1} of ${steps.length}`}>
				<span className="bo-bar-fill" style={{ width: `${Math.round(((at + 1) / steps.length) * 100)}%` }} />
			</span>
			<span className="bo-hint">
				Step {at + 1} of {steps.length}
			</span>
		</div>
	);
}

/** What taking an implementation did to the other worktrees. */
function TakenNote({ result, reveal }: { result: BakeoffTakeResult | undefined; reveal: boolean }): ReactNode {
	const lines = takeLines(result, reveal);
	return (
		<div className="bo-notice" data-tone="info" role="status">
			<Trophy size={15} aria-hidden="true" />
			<span>
				Taken.
				{lines.map(line => (
					<span key={line} className="bo-notice-line">
						{line}
					</span>
				))}
			</span>
		</div>
	);
}

interface TakeDialogProps {
	bakeoff: Bakeoff;
	entry: BakeoffEntry;
	reveal: boolean;
	busy: boolean;
	error: string | null;
	onCancel(): void;
	onConfirm(options: { removeOthers: boolean; discardDirty: boolean }): void;
}

/** The confirmation before an entry is taken: which worktree stays, whether the others go, and, for an entry whose tests fail, why it needs one more tap. */
function TakeDialog({ bakeoff, entry, reveal, busy, error, onCancel, onConfirm }: TakeDialogProps): ReactNode {
	const plan = takePlan(bakeoff, entry);
	const [removeOthers, setRemoveOthers] = useState(false);
	const [discardDirty, setDiscardDirty] = useState(false);
	const [anyway, setAnyway] = useState(false);
	const name = entryName(entry, reveal);
	const others = plan.others.map(label => {
		const other = bakeoff.entries.find(item => item.label === label);
		return other === undefined ? `Entry ${label}` : entryName(other, reveal);
	});
	return (
		<Sheet label="taking an entry" size="wide" onClose={onCancel}>
			<div className="sh-sheet-head bo-head">
				<span className="bo-head-title">Take {name}?</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onCancel} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<div className="bo-take-body">
				<p className="bo-text">
					{plan.keepsWorktree ? (
						<>
							Its session and worktree stay
							{reveal && entry.branch !== undefined && (
								<>
									{" "}
									on branch <code>{entry.branch}</code>
								</>
							)}
							. From there you commit, push and open the pull request.
						</>
					) : bakeoff.mode === "design" ? (
						"This marks it as the winner. Nothing is removed."
					) : (
						"This marks the original as the winner. Nothing is changed or removed."
					)}
				</p>
				{plan.ineligible !== null && (
					<div className="bo-notice" data-tone="warn" role="alert">
						<CircleAlert size={15} aria-hidden="true" />
						<span>{INELIGIBLE_NOTE}. Taking an entry that breaks the tests is usually a mistake.</span>
					</div>
				)}
				{plan.ineligible !== null && (
					<label className="bo-check bo-check-danger">
						<input type="checkbox" checked={anyway} onChange={e => setAnyway(e.currentTarget.checked)} />
						<span className="bo-check-text">
							<span className="bo-check-title">Take it anyway</span>
						</span>
					</label>
				)}
				{others.length > 0 && (
					<label className="bo-check">
						<input
							type="checkbox"
							checked={removeOthers}
							onChange={e => {
								setRemoveOthers(e.currentTarget.checked);
								setDiscardDirty(false);
							}}
						/>
						<span className="bo-check-text">
							<span className="bo-check-title">Remove the other worktrees</span>
							<span className="bo-hint">
								Ends their sessions and deletes their folders; their branches stay. {others.join(", ")}
							</span>
						</span>
					</label>
				)}
				{removeOthers && (
					<label className="bo-check bo-check-danger">
						<input
							type="checkbox"
							checked={discardDirty}
							onChange={e => setDiscardDirty(e.currentTarget.checked)}
						/>
						<span className="bo-check-text">
							<span className="bo-check-title">Discard uncommitted changes</span>
							<span className="bo-hint">
								Any of those worktrees with uncommitted work loses it for good. Without this, they stay.
							</span>
						</span>
					</label>
				)}
				{error !== null && (
					<div className="bo-alert" role="alert">
						<span>{error}</span>
					</div>
				)}
				<div className="bo-actions bo-actions-end">
					<button type="button" className="sh-btn" onClick={onCancel} disabled={busy}>
						Cancel
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={busy || (plan.ineligible !== null && !anyway)}
						onClick={() => onConfirm({ removeOthers, discardDirty: removeOthers && discardDirty })}
					>
						{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Trophy size={14} />} Take this one
					</button>
				</div>
			</div>
		</Sheet>
	);
}
