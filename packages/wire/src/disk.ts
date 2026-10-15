/**
 * The disk guard: the companion watches the free space of the volumes its worktrees and the user's home live on,
 * warns below a limit the user sets, and (opt-in) deletes rebuildable build output (`target/`, `node_modules/`, …) in
 * the worktrees it created, biggest first, until the space is back above the limit plus a margin. Shared by the
 * companion (which checks, scans and deletes) and the web app (which shows it and lets the user clean now).
 *
 * Sizes are decimal gigabytes, as Finder and `df -H` count them. Every field added to an older frame is optional, so
 * a companion or an app that predates the guard ignores it; a companion advertises `canDiskGuard` when it answers
 * `disk-*` requests.
 */

/** Bytes in the gigabytes the limit is set in (decimal, as Finder reports free space). */
export const DISK_GB = 1_000_000_000;
export const DISK_DEFAULT_LIMIT_GB = 40;
export const DISK_MIN_LIMIT_GB = 1;
/** Far above any real disk: a typo like 1e9 is refused rather than warning forever. */
export const DISK_MAX_LIMIT_GB = 10_000;
export const DISK_DEFAULT_IDLE_HOURS = 6;
export const DISK_MIN_IDLE_HOURS = 1;
export const DISK_MAX_IDLE_HOURS = 24 * 30;
/** Free space has to climb this far above the limit (at least) before a warning can fire again or a clean stops. */
export const DISK_MIN_MARGIN_BYTES = 2 * DISK_GB;
export const DISK_MARGIN_SHARE = 0.1;

/** The margin above `limitBytes` that free space must reach before the guard counts the volume as recovered. */
export function diskMarginBytes(limitBytes: number): number {
	return Math.max(DISK_MIN_MARGIN_BYTES, Math.round(limitBytes * DISK_MARGIN_SHARE));
}

/** The route a low-space notification opens (see the app's notify-route): Settings → Sessions, where the Disk space group is. */
export const DISK_ROUTE = "disk:space";

export interface DiskGuardSettings {
	/** Warn (and, with `autoClean`, clean) when a watched volume has less than this many GB free. */
	limitGb: number;
	/** Delete rebuildable build output in worktrees the companion made while free space is below the limit. Off by default. */
	autoClean: boolean;
	/** A worktree whose session was active within this many hours is left alone by auto-clean. */
	idleHours: number;
}

export const DEFAULT_DISK_SETTINGS: DiskGuardSettings = {
	limitGb: DISK_DEFAULT_LIMIT_GB,
	autoClean: false,
	idleHours: DISK_DEFAULT_IDLE_HOURS,
};

/** A watched volume. */
export interface DiskVolume {
	/** A folder on the volume, as the companion knows it: its worktrees folder, the home folder, or the one both sit on. */
	path: string;
	holds: "worktrees" | "home" | "worktrees-and-home";
	freeBytes: number;
	totalBytes: number;
	/** Free space is below the limit now. */
	low: boolean;
}

/** What a clean may delete; each is rebuilt by the project's own tool. */
export type DiskArtifactKind = "target" | "node_modules" | ".next" | "dist" | "build";

export interface DiskArtifact {
	/** Absolute folder, symlinks resolved. */
	path: string;
	kind: DiskArtifactKind;
	/** Bytes on disk; null when the size scan did not finish in time. */
	bytes: number | null;
}

/** Why a worktree is not cleaned now: a process or session works in it, or it was used within the idle window. */
export type DiskSkip = "busy" | "recent";

/** A worktree holding rebuildable build output. */
export interface DiskCandidate {
	/** The worktree folder, symlinks resolved. */
	path: string;
	repo: string;
	name: string;
	artifacts: DiskArtifact[];
	/** Bytes measured across the artifacts (a lower bound while `sized` is false). */
	bytes: number;
	/** Every artifact's size was measured. */
	sized: boolean;
	/** Time since the worktree was last used: its sessions' activity, its newest commit or checkout, its newest build output. */
	idleMs: number;
	skip: DiskSkip | null;
	/** What `skip` rests on, in words ("cargo (pid 4121) runs in it"); null when not skipped. */
	why: string | null;
}

/** One clean of one worktree, kept for the app's list. */
export interface DiskClean {
	/** The worktree folder. */
	path: string;
	repo: string;
	name: string;
	kinds: DiskArtifactKind[];
	/** Bytes removed (measured before deleting; the free-space gain when an artifact could not be sized). */
	bytes: number;
	trigger: "auto" | "manual";
	/** Free bytes on the volume when the clean began; null when unknown. */
	freeBeforeBytes: number | null;
	/** The limit in force then. */
	limitBytes: number;
	/** Unix ms the clean finished. */
	at: number;
	/** Why some or all of it was not removed. */
	error?: string;
}

export interface DiskState {
	settings: DiskGuardSettings;
	volumes: DiskVolume[];
	limitBytes: number;
	marginBytes: number;
	/** Newest first. */
	cleans: DiskClean[];
	/** Unix ms of the last check of the volumes; 0 before the first. */
	checkedAt: number;
}

/** `disk-guard`: read the state, or replace the settings first. `disk-scan`: list the worktrees that could be cleaned (slow: measures sizes). `disk-clean`: clean the picked worktrees now, with auto-clean off or on. */
export type DiskRequest =
	| { t: "disk-guard"; reqId: number; settings?: DiskGuardSettings }
	| { t: "disk-scan"; reqId: number }
	| { t: "disk-clean"; reqId: number; paths: string[] };

export type DiskReply =
	| ({ t: "disk-guard"; reqId: number } & DiskState)
	| { t: "disk-scan"; reqId: number; candidates: DiskCandidate[]; volumes: DiskVolume[]; scannedAt: number }
	| {
			t: "disk-clean";
			reqId: number;
			/** What was cleaned, in order. */
			cleans: DiskClean[];
			/** Picked worktrees that were not cleaned, with why (busy, no longer a candidate, …). */
			refused: { path: string; reason: string }[];
			volumes: DiskVolume[];
	  };

/** On the `hosts` frame while a watched volume is below the limit; absent otherwise. */
export interface DiskHealth {
	/** The volume that is lowest on space: a folder on it. */
	path: string;
	/** Rounded down to 100 MB so the frame does not change with every written file. */
	freeBytes: number;
	limitBytes: number;
}
