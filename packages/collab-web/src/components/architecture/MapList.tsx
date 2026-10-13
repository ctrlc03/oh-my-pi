import type { BlueprintSummary } from "@oh-my-pi/pi-wire/blueprint";
import { Eye, GitCompare, LoaderCircle, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { fmtCost, relTime } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { createBlueprint, deleteBlueprint, listBlueprints } from "./blueprint-api";
import { refLabel, shortCommit } from "./blueprint-model";

export interface MapListProps {
	client: CompanionClient;
	/** The session's folder: only its repository's maps are listed. Null lists every repository's. */
	cwd: string | null;
	/** Host of the session on screen, so its own map-writing session is not offered as a link. */
	currentInstanceId: string | null;
	onOpen(id: string): void;
	onNew(): void;
	/** Join the omp session that is writing a running map. */
	onOpenHost(instanceId: string): Promise<void>;
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

/** The maps of the repository (or of every repository), with progress while they build. */
export function MapList({ client, cwd, currentInstanceId, onOpen, onNew, onOpenHost }: MapListProps): ReactNode {
	const load = useCallback(() => listBlueprints(client, cwd ?? undefined), [client, cwd]);
	const { state, reload } = useRequest(load);
	// Keep the list on screen (dimmed) while a push refreshes it.
	const shown = useRef<BlueprintSummary[] | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const maps = shown.current;
	useEffect(() => client.onBlueprintChanged(() => reload()), [client, reload]);
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
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{maps === null ? (
				loading && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Loading the maps…
					</div>
				)
			) : maps.length === 0 ? (
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
			) : (
				<ul className={loading ? "ar-maps sh-stats-stale" : "ar-maps"}>
					{maps.map(map => (
						<MapRow
							key={map.id}
							map={map}
							client={client}
							showRepo={cwd === null}
							canWatch={map.instanceId !== undefined && map.instanceId !== currentInstanceId}
							onOpen={onOpen}
							onOpenHost={onOpenHost}
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
	showRepo: boolean;
	canWatch: boolean;
	onOpen(id: string): void;
	onOpenHost(instanceId: string): Promise<void>;
	onChanged(): void;
}

function MapRow({ map, client, showRepo, canWatch, onOpen, onOpenHost, onChanged }: MapRowProps): ReactNode {
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
