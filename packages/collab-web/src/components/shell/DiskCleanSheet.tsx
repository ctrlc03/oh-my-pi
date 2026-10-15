import type { DiskCandidate, DiskClean } from "@oh-my-pi/pi-wire/disk";
import { Brush, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { fmtAge, fmtGb } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";
import "./disk.css";

/** What the sheet is showing: the candidates, or the outcome of the last clean. */
interface Outcome {
	cleans: DiskClean[];
	refused: { path: string; reason: string }[];
}

const sizeText = (candidate: DiskCandidate): string =>
	candidate.bytes === 0 && !candidate.sized
		? "size not measured"
		: `${candidate.sized ? "" : "at least "}${fmtGb(candidate.bytes)}`;

const kindsText = (candidate: DiskCandidate): string =>
	candidate.artifacts
		.map(artifact => (artifact.bytes === null ? artifact.kind : `${artifact.kind} ${fmtGb(artifact.bytes)}`))
		.join(" · ");

/**
 * The worktrees whose build output could be deleted, with size, how long each sat idle and why some are skipped; tick
 * the ones to clean. A busy worktree cannot be ticked; one used recently can (you chose it). Works whether or not auto-clean is on.
 */
export function DiskCleanSheet({ client, onClose }: { client: CompanionClient; onClose(): void }): ReactNode {
	const load = useCallback(() => client.diskScan(), [client]);
	const { state, reload } = useRequest(load);
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	const [cleaning, setCleaning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);

	const candidates = state.status === "ready" ? state.value.candidates : [];
	const chosen = candidates.filter(candidate => picked.has(candidate.path));
	const chosenBytes = chosen.reduce((sum, candidate) => sum + candidate.bytes, 0);
	const eligible = candidates.filter(candidate => candidate.skip === null);

	const toggle = (path: string): void => {
		const next = new Set(picked);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		setPicked(next);
	};

	const clean = async (): Promise<void> => {
		if (cleaning || chosen.length === 0) return;
		setCleaning(true);
		setError(null);
		try {
			const reply = await client.diskClean(chosen.map(candidate => candidate.path));
			setOutcome({ cleans: reply.cleans, refused: reply.refused });
			setPicked(new Set());
			reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCleaning(false);
		}
	};

	const freed = outcome?.cleans.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;

	return (
		<Sheet label="clean build output" onClose={onClose}>
			<div className="sh-sheet-head">
				<span className="sh-sheet-title">Clean now</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={15} />
				</button>
			</div>
			<span className="sh-field-hint">
				Deletes rebuildable build folders (target, node_modules, .next, dist, build) in worktrees the companion
				made. Never source files, and never a worktree that is in use.
			</span>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Measuring build output…
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
			{outcome !== null && (
				<div className="sh-disk-outcome" role="status">
					{outcome.cleans.length > 0 && (
						<span>
							Cleaned {outcome.cleans.length} worktree{outcome.cleans.length === 1 ? "" : "s"}, freeing{" "}
							{fmtGb(freed)}.
						</span>
					)}
					{outcome.refused.map(refusal => (
						<span key={refusal.path} className="sh-disk-refused">
							{refusal.path}: {refusal.reason}
						</span>
					))}
					{outcome.cleans.map(entry =>
						entry.error === undefined ? null : (
							<span key={entry.path} className="sh-disk-refused">
								{entry.repo}/{entry.name}: {entry.error}
							</span>
						),
					)}
				</div>
			)}
			{state.status === "ready" && candidates.length === 0 && (
				<div className="sh-companion-empty">No worktree holds build output to clean.</div>
			)}
			{candidates.length > 0 && (
				<ul className="sh-disk-list" aria-label="Worktrees with build output">
					{candidates.map(candidate => (
						<li key={candidate.path}>
							<label
								className={candidate.skip === "busy" ? "sh-disk-row sh-disk-row-busy" : "sh-disk-row"}
								data-skip={candidate.skip ?? undefined}
							>
								<input
									type="checkbox"
									checked={picked.has(candidate.path)}
									disabled={candidate.skip === "busy" || cleaning}
									onChange={() => toggle(candidate.path)}
								/>
								<span className="sh-disk-row-body">
									<span className="sh-disk-row-head">
										<span className="sh-disk-row-name">
											{candidate.repo}/{candidate.name}
										</span>
										<span className="sh-disk-row-size">{sizeText(candidate)}</span>
									</span>
									<span className="sh-field-hint">
										{kindsText(candidate)} · idle {fmtAge(candidate.idleMs)}
									</span>
									{candidate.skip !== null && (
										<span
											className={
												candidate.skip === "busy" ? "sh-disk-skip sh-disk-skip-busy" : "sh-disk-skip"
											}
										>
											{candidate.skip === "busy" ? "In use" : "Used recently"}: {candidate.why}
										</span>
									)}
									<span className="sh-field-hint sh-disk-path">{candidate.path}</span>
								</span>
							</label>
						</li>
					))}
				</ul>
			)}
			{error && <div className="sh-connect-error">{error}</div>}
			{candidates.length > 0 && (
				<div className="sh-review-confirm-actions sh-disk-actions">
					<button
						type="button"
						className="sh-btn"
						disabled={cleaning || eligible.length === 0}
						onClick={() => setPicked(new Set(eligible.map(candidate => candidate.path)))}
					>
						Select all that are free to clean
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={cleaning || chosen.length === 0}
						onClick={() => void clean()}
					>
						{cleaning ? <LoaderCircle size={14} className="sh-spin" /> : <Brush size={14} />}{" "}
						{chosen.length === 0
							? "Clean selected"
							: `Clean ${chosen.length} · ${chosenBytes === 0 ? "size not measured" : `${chosen.every(candidate => candidate.sized) ? "" : "at least "}${fmtGb(chosenBytes)}`}`}
					</button>
				</div>
			)}
		</Sheet>
	);
}
