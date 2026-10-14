import type { BakeoffSummary } from "@oh-my-pi/pi-wire/bakeoff";
import {
	CircleCheck,
	Eye,
	GitCompareArrows,
	Laptop,
	LoaderCircle,
	Plus,
	RefreshCw,
	Trash2,
	TriangleAlert,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { relTime } from "../../lib/format";
import { type ClientTarget, featureTargets, useStableTargets } from "../../lib/stable-targets";
import { useRequest } from "../../lib/use-request";
import { deleteBakeoff, listBakeoffs } from "./bakeoff-api";
import { costText, entryCountText, groupByRepo, modeWord, rankText, repoName, rowStatus } from "./bakeoff-flow";

export interface BakeoffListProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null when none is at hand. */
	computerId: string | null;
	/** The session's folder: only its repository's bake-offs (on its computer) are listed. Null lists every repository's. */
	cwd: string | null;
	/** Host of the session on screen (on `computerId`), so its own session is not offered as a link. */
	currentInstanceId: string | null;
	onOpen(computerId: string, bakeoff: BakeoffSummary): void;
	/** Start a new bake-off of what is on screen; null when there is nothing to start one from. */
	onNew: (() => void) | null;
	/** Join the omp session that is running a bake-off. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onClose(): void;
}

interface Listed {
	target: ClientTarget;
	bakeoff: BakeoffSummary;
}

interface Listing {
	entries: Listed[];
	failures: { target: ClientTarget; message: string }[];
}

interface Group {
	key: string;
	name: string;
	computerName: string;
	entries: Listed[];
}

/**
 * The bake-offs of the repository (or of every repository) on every computer that runs them: how each stands, with
 * progress while one runs and the result in a line once it is in. Each computer answers on its own: one that fails
 * shows its own line.
 */
export function BakeoffList({
	computers,
	computerId,
	cwd,
	currentInstanceId,
	onOpen,
	onNew,
	onOpenHost,
	onClose,
}: BakeoffListProps): ReactNode {
	const several = computers.length > 1;
	const targets = useStableTargets(featureTargets(computers, "bakeoff"));
	const away = computers.flatMap(computer => {
		const reason = unavailableReason(computer, "bakeoff");
		return reason === null ? [] : [{ computer, reason }];
	});
	const load = useCallback(async (): Promise<Listing> => {
		const answers = await Promise.allSettled(
			// The session's folder narrows its own computer's bake-offs; another computer has its own checkouts.
			targets.map(target => listBakeoffs(target.client, target.id === computerId ? (cwd ?? undefined) : undefined)),
		);
		const entries: Listed[] = [];
		const failures: Listing["failures"] = [];
		answers.forEach((answer, at) => {
			const target = targets[at]!;
			if (answer.status === "fulfilled") for (const bakeoff of answer.value) entries.push({ target, bakeoff });
			else
				failures.push({
					target,
					message: answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
				});
		});
		entries.sort((a, b) => b.bakeoff.createdAt - a.bakeoff.createdAt);
		return { entries, failures };
	}, [targets, computerId, cwd]);
	const { state, reload } = useRequest(load);
	// Keep the list on screen (dimmed) while a push refreshes it.
	const shown = useRef<Listing | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const listing = shown.current;
	useEffect(() => {
		const stops = targets.map(target => target.client.onBakeoffChanged(() => reload()));
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
					Bake-off
					{cwd !== null && <span className="bo-home-repo">{repoName(cwd)}</span>}
				</div>
				<span className="sh-sheet-head-actions">
					{onNew !== null && (
						<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
							<Plus size={14} /> New bake-off
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="Reload the bake-offs"
					>
						<RefreshCw size={15} className={loading ? "sh-spin" : undefined} />
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{away.map(({ computer, reason }) => (
				<div key={computer.id} className="bo-home-away">
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
			<div className="bo-home-scroll">
				{listing === null ? (
					loading && (
						<div className="sh-companion-empty sh-file-status">
							<LoaderCircle size={14} className="sh-spin" /> Loading the bake-offs…
						</div>
					)
				) : listing.entries.length === 0 ? (
					listing.failures.length === 0 &&
					targets.length > 0 && (
						<div className="bo-home-empty">
							<GitCompareArrows size={28} aria-hidden="true" />
							<p>No bake-offs yet{cwd !== null ? " for this repository" : ""}.</p>
							<p className="bo-home-muted">
								Several models each try to do better than a design or your changes, and a reviewer ranks them
								without knowing who wrote what.
							</p>
							{onNew !== null && (
								<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
									<Plus size={14} /> Start the first bake-off
								</button>
							)}
						</div>
					)
				) : (
					<div className={loading ? "sh-stats-stale" : undefined}>
						{groups.map(group => (
							<section key={group.key} className="bo-home-group">
								{headed && (
									<h3 className="bo-home-group-name">
										{group.name}
										{several && (
											<span className="bo-home-group-computer">
												<Laptop size={11} aria-hidden="true" /> {group.computerName}
											</span>
										)}
									</h3>
								)}
								<ul className="bo-home-rows">
									{group.entries.map(({ target, bakeoff }) => (
										<BakeoffRow
											key={`${target.id}:${bakeoff.id}`}
											bakeoff={bakeoff}
											client={target.client}
											canWatch={
												bakeoff.instanceId !== undefined &&
												!(target.id === computerId && bakeoff.instanceId === currentInstanceId)
											}
											onOpen={() => onOpen(target.id, bakeoff)}
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

/** The listing's bake-offs per computer and repository, the group with the newest bake-off first. */
function groupEntries(entries: readonly Listed[]): Group[] {
	const targets = [...new Map(entries.map(entry => [entry.target.id, entry.target])).values()];
	return targets
		.flatMap(target =>
			groupByRepo(entries.filter(entry => entry.target.id === target.id).map(entry => entry.bakeoff)).map(group => ({
				key: `${target.id}:${group.repoRoot}`,
				name: group.name,
				computerName: target.name,
				entries: group.bakeoffs.map(bakeoff => ({ target, bakeoff })),
			})),
		)
		.sort((a, b) => b.entries[0]!.bakeoff.createdAt - a.entries[0]!.bakeoff.createdAt);
}

interface BakeoffRowProps {
	bakeoff: BakeoffSummary;
	client: CompanionClient;
	canWatch: boolean;
	onOpen(): void;
	onOpenHost(instanceId: string): Promise<void>;
	onChanged(): void;
}

function BakeoffRow({ bakeoff, client, canWatch, onOpen, onOpenHost, onChanged }: BakeoffRowProps): ReactNode {
	const [busy, setBusy] = useState<"delete" | "watch" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const status = rowStatus(bakeoff);
	const failed = bakeoff.status === "failed";
	const mode = modeWord(bakeoff.mode);
	const entries = entryCountText(bakeoff.entryCount);
	const cost = costText(bakeoff);
	const rank = rankText(bakeoff);

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
		<li className="bo-row" data-status={bakeoff.status}>
			<button type="button" className="bo-row-main" onClick={onOpen} aria-label={`Open ${bakeoff.title}`}>
				<span className="bo-row-title">{bakeoff.title}</span>
				{bakeoff.subject !== bakeoff.title && <span className="bo-row-sub">{bakeoff.subject}</span>}
				<span className="bo-row-meta">
					<span className="bo-row-tag" data-kind={status.kind}>
						{status.kind === "ready" && <CircleCheck size={11} aria-hidden="true" />}
						{status.kind === "running" ? "Running" : status.kind === "failed" ? "Failed" : status.text}
					</span>
					{mode !== null && <span>{mode}</span>}
					{entries !== null && <span>{entries}</span>}
					<span>{relTime(bakeoff.createdAt)}</span>
					{cost !== null && <span>{cost}</span>}
				</span>
				{rank !== null && <span className="bo-row-rank">{rank}</span>}
				{bakeoff.note !== undefined && <span className="bo-row-note">{bakeoff.note}</span>}
				{bakeoff.status === "running" && (
					<span className="bo-row-progress" role="status">
						<LoaderCircle size={13} className="sh-spin" /> {status.text}
					</span>
				)}
				{failed && (
					<span className="bo-row-failed">
						<TriangleAlert size={13} /> {status.text}
					</span>
				)}
			</button>
			<span className="bo-row-actions">
				{bakeoff.status === "running" && canWatch && bakeoff.instanceId !== undefined && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy !== null}
						onClick={() =>
							bakeoff.instanceId !== undefined && void run("watch", () => onOpenHost(bakeoff.instanceId!))
						}
					>
						{busy === "watch" ? <LoaderCircle size={14} className="sh-spin" /> : <Eye size={14} />} Watch
					</button>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							className="sh-btn bo-danger"
							disabled={busy !== null}
							onClick={() => void run("delete", () => deleteBakeoff(client, bakeoff.id))}
						>
							{busy === "delete" ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
							{bakeoff.status === "running" ? "Stop and delete" : "Delete"}
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
						aria-label={`Delete ${bakeoff.title}`}
					>
						<Trash2 size={15} />
					</button>
				)}
			</span>
			{error !== null && (
				<span className="bo-row-error" role="alert">
					{error}
				</span>
			)}
		</li>
	);
}
