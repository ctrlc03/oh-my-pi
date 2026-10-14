import type { SparSummary } from "@oh-my-pi/pi-wire/spar";
import {
	CircleCheck,
	Eye,
	Laptop,
	LoaderCircle,
	Plus,
	RefreshCw,
	Swords,
	Trash2,
	TriangleAlert,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { fmtCost, relTime } from "../../lib/format";
import { type ClientTarget, featureTargets, useStableTargets } from "../../lib/stable-targets";
import { useRequest } from "../../lib/use-request";
import { folderName } from "../quiz/quiz-flow";
import { deleteSpar, listSpars } from "./spar-api";
import { groupByRepo, rowStatus } from "./spar-flow";

export interface SparListProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null from the start screen. */
	computerId: string | null;
	/** The session's folder: only its repository's spars (on its computer) are listed. Null lists every repository's. */
	cwd: string | null;
	/** Host of the session on screen (on `computerId`), so its own spar-writing session is not offered as a link. */
	currentInstanceId: string | null;
	onOpen(computerId: string, spar: SparSummary): void;
	/** Start a new spar of what is on screen; null when there is nothing to start one from (the start screen). */
	onNew: (() => void) | null;
	/** Join the omp session that is preparing a running spar. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** Switch to the list of quizzes. */
	onShowQuizzes(): void;
	onClose(): void;
}

interface SparEntry {
	target: ClientTarget;
	spar: SparSummary;
}

interface Listing {
	entries: SparEntry[];
	failures: { target: ClientTarget; message: string }[];
}

interface Group {
	key: string;
	name: string;
	computerName: string;
	entries: SparEntry[];
}

/**
 * The spars of the repository (or of every repository) on every computer that writes them: how each stands, with
 * progress while one is being prepared. Each computer answers on its own: one that fails shows its own line.
 */
export function SparList({
	computers,
	computerId,
	cwd,
	currentInstanceId,
	onOpen,
	onNew,
	onOpenHost,
	onShowQuizzes,
	onClose,
}: SparListProps): ReactNode {
	const several = computers.length > 1;
	const targets = useStableTargets(featureTargets(computers, "spar"));
	const away = computers.flatMap(computer => {
		const reason = unavailableReason(computer, "spar");
		return reason === null ? [] : [{ computer, reason }];
	});
	const load = useCallback(async (): Promise<Listing> => {
		const answers = await Promise.allSettled(
			// The session's folder narrows its own computer's spars; another computer has its own checkouts.
			targets.map(target => listSpars(target.client, target.id === computerId ? (cwd ?? undefined) : undefined)),
		);
		const entries: SparEntry[] = [];
		const failures: Listing["failures"] = [];
		answers.forEach((answer, at) => {
			const target = targets[at]!;
			if (answer.status === "fulfilled") for (const spar of answer.value) entries.push({ target, spar });
			else
				failures.push({
					target,
					message: answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
				});
		});
		entries.sort((a, b) => b.spar.createdAt - a.spar.createdAt);
		return { entries, failures };
	}, [targets, computerId, cwd]);
	const { state, reload } = useRequest(load);
	// Keep the list on screen (dimmed) while a push refreshes it.
	const shown = useRef<Listing | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const listing = shown.current;
	useEffect(() => {
		const stops = targets.map(target => target.client.onSparChanged(() => reload()));
		return () => {
			for (const stop of stops) stop();
		};
	}, [targets, reload]);
	const loading = state.status === "loading";
	const groups = listing === null ? [] : groupEntries(listing.entries);
	const headed = cwd === null || groups.length > 1;

	return (
		<>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					Sparring
					{cwd !== null && <span className="sp-repo">{folderName(cwd)}</span>}
				</div>
				<span className="sh-sheet-head-actions">
					{onNew !== null && (
						<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
							<Plus size={14} /> New spar
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="Reload the spars"
					>
						<RefreshCw size={15} className={loading ? "sh-spin" : undefined} />
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			<div className="sh-segmented sp-tabs" role="tablist" aria-label="Quizzes or sparring">
				<button type="button" role="tab" aria-selected={false} className="sh-segment" onClick={onShowQuizzes}>
					Quizzes
				</button>
				<button type="button" role="tab" aria-selected={true} className="sh-segment sh-segment-on">
					Sparring
				</button>
			</div>
			{away.map(({ computer, reason }) => (
				<div key={computer.id} className="sp-away">
					<span className="sh-dot" aria-hidden="true" /> {several ? `${computer.name}: ${reason}` : reason}
				</div>
			))}
			{listing?.failures.map(failure => (
				<div key={failure.target.id} className="sh-tree-error">
					<div className="sh-connect-error">
						{several ? `${failure.target.name}: ${failure.message}` : failure.message}
					</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			))}
			<div className="sp-scroll">
				{listing === null ? (
					loading && (
						<div className="sh-companion-empty sh-file-status">
							<LoaderCircle size={14} className="sh-spin" /> Loading the spars…
						</div>
					)
				) : listing.entries.length === 0 ? (
					listing.failures.length === 0 &&
					targets.length > 0 && (
						<div className="sp-empty">
							<Swords size={28} aria-hidden="true" />
							<p>No spars yet{cwd !== null ? " for this repository" : ""}.</p>
							<p className="sp-muted">
								A sparring partner argues against your changes or a design, and you defend them.
							</p>
							{onNew !== null && (
								<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
									<Plus size={14} /> Start the first spar
								</button>
							)}
						</div>
					)
				) : (
					<div className={loading ? "sh-stats-stale" : undefined}>
						{groups.map(group => (
							<section key={group.key} className="sp-group">
								{headed && (
									<h3 className="sp-group-name">
										{group.name}
										{several && (
											<span className="sp-group-computer">
												<Laptop size={11} aria-hidden="true" /> {group.computerName}
											</span>
										)}
									</h3>
								)}
								<ul className="sp-spars">
									{group.entries.map(({ target, spar }) => (
										<SparRow
											key={`${target.id}:${spar.id}`}
											spar={spar}
											client={target.client}
											canWatch={
												spar.instanceId !== undefined &&
												!(target.id === computerId && spar.instanceId === currentInstanceId)
											}
											onOpen={() => onOpen(target.id, spar)}
											onOpenHost={instanceId => onOpenHost(target.id, instanceId)}
											onChanged={reload}
										/>
									))}
								</ul>
							</section>
						))}
					</div>
				)}
			</div>
		</>
	);
}

/** The listing's spars per computer and repository, the group with the newest spar first. */
function groupEntries(entries: readonly SparEntry[]): Group[] {
	const targets = [...new Map(entries.map(entry => [entry.target.id, entry.target])).values()];
	return targets
		.flatMap(target =>
			groupByRepo(entries.filter(entry => entry.target.id === target.id).map(entry => entry.spar)).map(group => ({
				key: `${target.id}:${group.repoRoot}`,
				name: group.name,
				computerName: target.name,
				entries: group.spars.map(spar => ({ target, spar })),
			})),
		)
		.sort((a, b) => b.entries[0]!.spar.createdAt - a.entries[0]!.spar.createdAt);
}

interface SparRowProps {
	spar: SparSummary;
	client: CompanionClient;
	canWatch: boolean;
	onOpen(): void;
	onOpenHost(instanceId: string): Promise<void>;
	onChanged(): void;
}

function SparRow({ spar, client, canWatch, onOpen, onOpenHost, onChanged }: SparRowProps): ReactNode {
	const [busy, setBusy] = useState<"delete" | "watch" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const status = rowStatus(spar);
	const failed = spar.status === "failed";

	const run = async (what: "delete" | "watch", action: () => Promise<void>): Promise<void> => {
		setBusy(what);
		setError(null);
		try {
			await action();
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
			setConfirming(false);
		}
	};

	return (
		<li className="sp-spar" data-status={spar.status}>
			<button
				type="button"
				className="sp-spar-main"
				onClick={onOpen}
				disabled={failed}
				aria-label={failed ? undefined : `Open ${spar.subject}`}
			>
				<span className="sp-spar-title">{spar.subject}</span>
				{spar.title !== spar.subject && <span className="sp-spar-sub">{spar.title}</span>}
				<span className="sp-spar-meta">
					<span className="sp-tag" data-kind={status.kind}>
						{status.kind === "score" && <CircleCheck size={11} aria-hidden="true" />}
						{status.text}
					</span>
					{spar.pointCount !== undefined && (
						<span>
							{spar.pointCount} {spar.pointCount === 1 ? "point" : "points"}
							{spar.partCount !== undefined && spar.partCount > 1 ? ` in ${spar.partCount} parts` : ""}
						</span>
					)}
					{spar.runCount !== undefined && spar.runCount > 1 && <span>{spar.runCount} runs</span>}
					<span>{relTime(spar.createdAt)}</span>
					{spar.costUsd !== undefined && <span>{fmtCost(spar.costUsd)}</span>}
				</span>
				{spar.status === "running" && (
					<span className="sp-spar-progress" role="status">
						<LoaderCircle size={13} className="sh-spin" /> {spar.progress ?? "Starting"}
					</span>
				)}
				{failed && (
					<span className="sp-spar-failed">
						<TriangleAlert size={13} /> {spar.error ?? "The spar could not be made."}
					</span>
				)}
			</button>
			<span className="sp-spar-actions">
				{spar.status === "running" && canWatch && spar.instanceId !== undefined && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy !== null}
						onClick={() => spar.instanceId !== undefined && void run("watch", () => onOpenHost(spar.instanceId!))}
					>
						{busy === "watch" ? <LoaderCircle size={14} className="sh-spin" /> : <Eye size={14} />} Watch
					</button>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							className="sh-btn sp-danger"
							disabled={busy !== null}
							onClick={() => void run("delete", () => deleteSpar(client, spar.id))}
						>
							{busy === "delete" ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
							{spar.status === "running" ? "Stop and delete" : "Delete"}
						</button>
						<button type="button" className="sh-btn" onClick={() => setConfirming(false)}>
							Keep
						</button>
					</>
				) : (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setConfirming(true)}
						aria-label={`Delete ${spar.subject}`}
					>
						<Trash2 size={15} />
					</button>
				)}
			</span>
			{error !== null && (
				<span className="sp-spar-error" role="alert">
					{error}
				</span>
			)}
		</li>
	);
}
