import {
	DISK_MAX_IDLE_HOURS,
	DISK_MAX_LIMIT_GB,
	DISK_MIN_IDLE_HOURS,
	DISK_MIN_LIMIT_GB,
	type DiskClean,
	type DiskGuardSettings,
	type DiskState,
	type DiskVolume,
} from "@oh-my-pi/pi-wire/disk";
import { Brush, Check, HardDrive, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { fmtGb, relTime } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { DiskCleanSheet } from "./DiskCleanSheet";
import "./disk.css";

/** The computer's disk guard: free space, the limit, auto-clean, *Clean now* and the cleans so far (needs `canDiskGuard`). */
export function DiskSettings({
	client,
	computerName,
}: {
	client: CompanionClient;
	/** The computer's name, given when several are paired so the text can say which one; undefined: "the computer". */
	computerName?: string;
}): ReactNode {
	const load = useCallback(() => client.diskGuard(), [client]);
	const { state, reload } = useRequest(load);
	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{state.message}</div>
				<button type="button" className="sh-btn" onClick={reload}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	}
	return <DiskForm client={client} saved={state.value} computerName={computerName} />;
}

const HOLDS: Record<DiskVolume["holds"], string> = {
	worktrees: "Worktrees",
	home: "Home folder",
	"worktrees-and-home": "Worktrees and home folder",
};

function VolumeRow({ volume, limitBytes }: { volume: DiskVolume; limitBytes: number }): ReactNode {
	const free = volume.totalBytes > 0 ? Math.min(100, (volume.freeBytes / volume.totalBytes) * 100) : 0;
	const mark = volume.totalBytes > 0 ? Math.min(100, (limitBytes / volume.totalBytes) * 100) : 0;
	return (
		<div
			className={volume.low ? "sh-disk-volume sh-disk-volume-low" : "sh-disk-volume"}
			role="group"
			aria-label={HOLDS[volume.holds]}
		>
			<div className="sh-disk-volume-head">
				{volume.low ? <TriangleAlert size={14} aria-hidden="true" /> : <HardDrive size={14} aria-hidden="true" />}
				<span className="sh-disk-volume-name">{HOLDS[volume.holds]}</span>
				<span className="sh-disk-volume-free">
					{fmtGb(volume.freeBytes)} free of {fmtGb(volume.totalBytes)}
				</span>
			</div>
			<div className="sh-disk-bar" aria-hidden="true">
				<span className="sh-disk-bar-free" style={{ width: `${free}%` }} />
				<span className="sh-disk-bar-limit" style={{ left: `${mark}%` }} />
			</div>
			<span className="sh-field-hint">
				{volume.path}
				{volume.low ? ` · below the ${fmtGb(limitBytes)} limit` : ""}
			</span>
		</div>
	);
}

function CleanRow({ clean }: { clean: DiskClean }): ReactNode {
	return (
		<div className="sh-disk-clean" role="group" aria-label={`Clean of ${clean.repo}/${clean.name}`}>
			<div className="sh-settle-head">
				<span
					className={
						clean.error === undefined ? "sh-settle-status sh-settle-ok" : "sh-settle-status sh-settle-failed"
					}
				>
					{clean.error === undefined ? "Freed" : "Partly freed"} {fmtGb(clean.bytes)}
				</span>
				<span className="sh-settle-name">
					{clean.repo}/{clean.name}
				</span>
			</div>
			<span className="sh-field-hint">
				{clean.kinds.join(", ")} · {clean.trigger === "auto" ? "automatic" : "Clean now"}
				{clean.freeBeforeBytes === null ? "" : ` · ${fmtGb(clean.freeBeforeBytes)} free before`} ·{" "}
				{relTime(clean.at)}
			</span>
			{clean.error !== undefined && <span className="sh-field-hint">{clean.error}</span>}
			<span className="sh-field-hint sh-disk-path">{clean.path}</span>
		</div>
	);
}

function DiskForm({
	client,
	saved,
	computerName,
}: {
	client: CompanionClient;
	saved: DiskState;
	computerName: string | undefined;
}): ReactNode {
	const [current, setCurrent] = useState(saved);
	const [draft, setDraft] = useState<{ limitGb: string; autoClean: boolean; idleHours: string }>({
		limitGb: String(saved.settings.limitGb),
		autoClean: saved.settings.autoClean,
		idleHours: String(saved.settings.idleHours),
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [cleaning, setCleaning] = useState(false);

	const limitGb = draft.limitGb.trim() === "" ? Number.NaN : Number(draft.limitGb);
	const idleHours = draft.idleHours.trim() === "" ? Number.NaN : Number(draft.idleHours);
	const limitOk = Number.isInteger(limitGb) && limitGb >= DISK_MIN_LIMIT_GB && limitGb <= DISK_MAX_LIMIT_GB;
	const idleOk = Number.isInteger(idleHours) && idleHours >= DISK_MIN_IDLE_HOURS && idleHours <= DISK_MAX_IDLE_HOURS;
	const next: DiskGuardSettings = { limitGb, autoClean: draft.autoClean, idleHours };
	const dirty =
		limitOk &&
		idleOk &&
		(limitGb !== current.settings.limitGb ||
			draft.autoClean !== current.settings.autoClean ||
			idleHours !== current.settings.idleHours);

	const edit = (patch: Partial<typeof draft>): void => {
		setDraft({ ...draft, ...patch });
		setNotice(null);
	};

	const save = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		if (!dirty || busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const reply = await client.diskGuard(next);
			setCurrent(reply);
			setDraft({
				limitGb: String(reply.settings.limitGb),
				autoClean: reply.settings.autoClean,
				idleHours: String(reply.settings.idleHours),
			});
			setNotice("Saved.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const refresh = async (): Promise<void> => {
		try {
			setCurrent(await client.diskGuard());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<form className="sh-spend" onSubmit={e => void save(e)}>
			{current.volumes.length === 0 ? (
				<span className="sh-field-hint">{computerName ?? "The computer"} did not report its free space.</span>
			) : (
				<div className="sh-disk-volumes">
					{current.volumes.map(volume => (
						<VolumeRow key={volume.path} volume={volume} limitBytes={current.limitBytes} />
					))}
				</div>
			)}
			<label className="sh-field">
				<span className="sh-field-label">Warn below</span>
				<span className="sh-review-draft">
					<input
						className="sh-input"
						type="number"
						min={DISK_MIN_LIMIT_GB}
						max={DISK_MAX_LIMIT_GB}
						step={1}
						inputMode="numeric"
						value={draft.limitGb}
						onChange={e => edit({ limitGb: e.currentTarget.value })}
						aria-invalid={!limitOk}
					/>
					GB free
				</span>
				<span className="sh-field-hint">
					Checked every few minutes on the disks holding the worktrees and the home folder; each warning is sent
					once.
				</span>
			</label>
			<label className="sh-org-check sh-org-check-hinted">
				<input
					type="checkbox"
					checked={draft.autoClean}
					onChange={e => edit({ autoClean: e.currentTarget.checked })}
				/>
				<span className="sh-org-check-text">
					Clean build output automatically below the limit
					<span className="sh-field-hint">
						Deletes target, node_modules and similar rebuildable folders in worktrees the companion made, biggest
						first. Off by default.
					</span>
				</span>
			</label>
			<label className="sh-field">
				<span className="sh-field-label">Leave worktrees alone that were used in the last</span>
				<span className="sh-review-draft">
					<input
						className="sh-input"
						type="number"
						min={DISK_MIN_IDLE_HOURS}
						max={DISK_MAX_IDLE_HOURS}
						step={1}
						inputMode="numeric"
						value={draft.idleHours}
						onChange={e => edit({ idleHours: e.currentTarget.value })}
						aria-invalid={!idleOk}
					/>
					hours
				</span>
			</label>
			{(!limitOk || !idleOk) && (
				<div className="sh-connect-error" role="alert">
					{!limitOk
						? `Use a whole number of GB from ${DISK_MIN_LIMIT_GB} to ${DISK_MAX_LIMIT_GB}.`
						: `Use a whole number of hours from ${DISK_MIN_IDLE_HOURS} to ${DISK_MAX_IDLE_HOURS}.`}
				</div>
			)}
			<div className="sh-review-confirm-actions">
				<button type="button" className="sh-btn" onClick={() => setCleaning(true)}>
					<Brush size={14} /> Clean now
				</button>
				<button type="submit" className="sh-btn sh-btn-primary" disabled={busy || !dirty}>
					{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Check size={14} />} Save
				</button>
			</div>
			{notice && <div className="sh-field-hint">{notice}</div>}
			{error && <div className="sh-connect-error">{error}</div>}
			{current.cleans.length > 0 && (
				<div className="sh-field" role="group" aria-label="Recent cleans">
					<span className="sh-field-label">Recent cleans</span>
					{current.cleans.slice(0, 10).map(clean => (
						<CleanRow key={`${clean.path}@${clean.at}`} clean={clean} />
					))}
				</div>
			)}
			{cleaning && (
				<DiskCleanSheet
					client={client}
					onClose={() => {
						setCleaning(false);
						void refresh();
					}}
				/>
			)}
		</form>
	);
}
