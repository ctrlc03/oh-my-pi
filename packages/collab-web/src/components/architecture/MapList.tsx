import type { BlueprintSummary } from "@oh-my-pi/pi-wire/blueprint";
import { Eye, GitCompare, Laptop, LoaderCircle, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { fmtCost, relTime } from "../../lib/format";
import { type ClientTarget, featureTargets, useStableTargets } from "../../lib/stable-targets";
import { useRequest } from "../../lib/use-request";
import { createBlueprint, deleteBlueprint, listBlueprints } from "./blueprint-api";
import { refLabel, shortCommit } from "./blueprint-model";

export interface MapListProps {
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen; null from the start screen. */
	computerId: string | null;
	/** The session's folder: only its repository's maps (on its computer) are listed. Null lists every repository's. */
	cwd: string | null;
	/** Host of the session on screen (on `computerId`), so its own map-writing session is not offered as a link. */
	currentInstanceId: string | null;
	onOpen(computerId: string, id: string): void;
	onNew(): void;
	/** Join the omp session that is writing a running map. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
}

/** A map and the computer that holds it. */
interface MapEntry {
	target: ClientTarget;
	map: BlueprintSummary;
}

interface Listing {
	entries: MapEntry[];
	failures: { target: ClientTarget; message: string }[];
}

/** `/a/b/repo` → `repo`. */
function folderName(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Where a map was taken: `feature/x @ 3fa91c0`, and what it was compared with. */
function describe(map: BlueprintSummary): string {
	const head = `${refLabel(map.head.ref)} @ ${shortCommit(map.head.commit)}`;
	if (map.base === undefined) return head;
	return `${head} vs ${map.base.ref === undefined ? shortCommit(map.base.commit) : refLabel(map.base.ref)}`;
}

/**
 * The maps of the repository (or of every repository) on every computer that makes them, with progress while they
 * build. Each computer answers on its own: one that fails shows its own line and the others are listed anyway.
 */
export function MapList({
	computers,
	computerId,
	cwd,
	currentInstanceId,
	onOpen,
	onNew,
	onOpenHost,
}: MapListProps): ReactNode {
	const several = computers.length > 1;
	const targets = useStableTargets(featureTargets(computers, "blueprint"));
	const away = computers.flatMap(computer => {
		const reason = unavailableReason(computer, "blueprint");
		return reason === null ? [] : [{ computer, reason }];
	});
	const load = useCallback(async (): Promise<Listing> => {
		const answers = await Promise.allSettled(
			// The session's folder narrows its own computer's maps; another computer has its own checkouts.
			targets.map(target =>
				listBlueprints(target.client, target.id === computerId ? (cwd ?? undefined) : undefined),
			),
		);
		const entries: MapEntry[] = [];
		const failures: Listing["failures"] = [];
		answers.forEach((answer, at) => {
			const target = targets[at]!;
			if (answer.status === "fulfilled") for (const map of answer.value) entries.push({ target, map });
			else
				failures.push({
					target,
					message: answer.reason instanceof Error ? answer.reason.message : String(answer.reason),
				});
		});
		if (targets.length > 1) entries.sort((a, b) => b.map.createdAt - a.map.createdAt);
		return { entries, failures };
	}, [targets, computerId, cwd]);
	const { state, reload } = useRequest(load);
	// Keep the list on screen (dimmed) while a push refreshes it.
	const shown = useRef<Listing | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const listing = shown.current;
	useEffect(() => {
		const stops = targets.map(target => target.client.onBlueprintChanged(() => reload()));
		return () => {
			for (const stop of stops) stop();
		};
	}, [targets, reload]);
	const loading = state.status === "loading";

	return (
		<>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">
					Architecture maps
					{cwd !== null && <span className="ar-repo">{folderName(cwd)}</span>}
				</div>
				<span className="sh-sheet-head-actions">
					<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
						<Plus size={14} /> New map
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={reload}
						disabled={loading}
						aria-label="Reload maps"
					>
						<RefreshCw size={15} className={loading ? "sh-spin" : undefined} />
					</button>
				</span>
			</div>
			{away.map(({ computer, reason }) => (
				<div key={computer.id} className="ar-computer-away">
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
			{listing === null ? (
				loading && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Loading the maps…
					</div>
				)
			) : listing.entries.length === 0 ? (
				listing.failures.length === 0 &&
				targets.length > 0 && (
					<div className="ar-home-empty">
						<p>No maps yet{cwd !== null ? " for this repository" : ""}.</p>
						<p className="ar-muted">
							A map shows how the code fits together: the whole system, then each part down to files and symbols,
							with the code behind every arrow.
						</p>
						<button type="button" className="sh-btn sh-btn-primary" onClick={onNew}>
							<Plus size={14} /> Make the first map
						</button>
					</div>
				)
			) : (
				<ul className={loading ? "ar-maps sh-stats-stale" : "ar-maps"}>
					{listing.entries.map(({ target, map }) => (
						<MapRow
							key={`${target.id}:${map.id}`}
							map={map}
							client={target.client}
							computerName={several ? target.name : null}
							showRepo={cwd === null || target.id !== computerId}
							canWatch={
								map.instanceId !== undefined &&
								!(target.id === computerId && map.instanceId === currentInstanceId)
							}
							onOpen={id => onOpen(target.id, id)}
							onOpenHost={instanceId => onOpenHost(target.id, instanceId)}
							onChanged={reload}
						/>
					))}
				</ul>
			)}
		</>
	);
}

interface MapRowProps {
	map: BlueprintSummary;
	client: CompanionClient;
	/** The computer holding the map, named when there are several; null with one. */
	computerName: string | null;
	showRepo: boolean;
	canWatch: boolean;
	onOpen(id: string): void;
	onOpenHost(instanceId: string): Promise<void>;
	onChanged(): void;
}

function MapRow({
	map,
	client,
	computerName,
	showRepo,
	canWatch,
	onOpen,
	onOpenHost,
	onChanged,
}: MapRowProps): ReactNode {
	const [busy, setBusy] = useState<"update" | "delete" | "watch" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ready = map.status === "ready";

	const run = async (what: "update" | "delete" | "watch", action: () => Promise<void>): Promise<void> => {
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
	const update = (): Promise<void> =>
		run("update", async () => {
			await createBlueprint(client, {
				cwd: map.repoRoot,
				ref: map.head.ref,
				base: map.base?.ref ?? map.base?.commit,
				refresh: map.id,
			});
		});

	return (
		<li className="ar-map" data-status={map.status}>
			<button
				type="button"
				className="ar-map-main"
				onClick={() => onOpen(map.id)}
				disabled={!ready}
				aria-label={ready ? `Open ${map.title}` : undefined}
			>
				<span className="ar-map-title">{map.title}</span>
				<span className="ar-map-meta">
					<span className={map.base === undefined ? "ar-tag" : "ar-tag ar-tag-diff"}>
						{map.base === undefined ? (
							"Full map"
						) : (
							<>
								<GitCompare size={11} /> Changes
							</>
						)}
					</span>
					{computerName !== null && (
						<span className="ar-map-computer">
							<Laptop size={11} /> {computerName}
						</span>
					)}
					{showRepo && <span>{folderName(map.repoRoot)}</span>}
					<span>{describe(map)}</span>
					<span>{relTime(map.createdAt)}</span>
					{map.diagramCount !== undefined && (
						<span>
							{map.diagramCount} {map.diagramCount === 1 ? "diagram" : "diagrams"}
						</span>
					)}
					{map.costUsd !== undefined && <span>{fmtCost(map.costUsd)}</span>}
				</span>
				{map.status === "running" && (
					<span className="ar-map-progress" role="status">
						<LoaderCircle size={13} className="sh-spin" /> {map.progress ?? "Starting"}
					</span>
				)}
				{map.status === "failed" && (
					<span className="ar-map-failed">
						<TriangleAlert size={13} /> {map.error ?? "The map could not be made."}
					</span>
				)}
			</button>
			<span className="ar-map-actions">
				{map.stale === true && ready && (
					<span className="ar-tag ar-tag-stale" title={`${map.head.ref ?? "The ref"} has moved on`}>
						Behind
					</span>
				)}
				{map.status === "running" && canWatch && map.instanceId !== undefined && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy !== null}
						onClick={() => map.instanceId !== undefined && void run("watch", () => onOpenHost(map.instanceId!))}
					>
						{busy === "watch" ? <LoaderCircle size={14} className="sh-spin" /> : <Eye size={14} />} Watch
					</button>
				)}
				{(map.stale === true || map.status === "failed") && (
					<button type="button" className="sh-btn" disabled={busy !== null} onClick={() => void update()}>
						<RefreshCw size={14} className={busy === "update" ? "sh-spin" : undefined} />{" "}
						{map.status === "failed" ? "Retry" : "Update"}
					</button>
				)}
				{confirming ? (
					<>
						<button
							type="button"
							className="sh-btn ar-btn-danger"
							disabled={busy !== null}
							onClick={() => void run("delete", () => deleteBlueprint(client, map.id))}
						>
							{busy === "delete" ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />}{" "}
							{map.status === "running" ? "Stop and delete" : "Delete"}
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
						aria-label={`Delete ${map.title}`}
					>
						<Trash2 size={15} />
					</button>
				)}
			</span>
			{error !== null && (
				<span className="ar-map-error" role="alert">
					{error}
				</span>
			)}
		</li>
	);
}
