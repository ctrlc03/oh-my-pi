/**
 * The decisions of the disk guard, with no I/O: the settings a device may write, what an auto-clean deletes (and in
 * which order, and why the rest is skipped), and when a low-space warning fires. Everything is a function of its
 * arguments, so the order, the stopping point and the anti-spam rule are testable without a disk.
 */

import {
	DEFAULT_DISK_SETTINGS,
	DISK_GB,
	DISK_MAX_IDLE_HOURS,
	DISK_MAX_LIMIT_GB,
	DISK_MIN_IDLE_HOURS,
	DISK_MIN_LIMIT_GB,
	type DiskGuardSettings,
	type DiskVolume,
} from "@oh-my-pi/pi-wire/disk";

const HOUR_MS = 3_600_000;

/**
 * The settings in `raw`; `strict` throws on the first invalid field (a device's edit), otherwise a missing or damaged
 * field falls back to its default (the file on disk).
 * @throws Error naming the invalid field in strict mode.
 */
export function parseDiskSettings(raw: unknown, strict: boolean): DiskGuardSettings {
	const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const defaults = DEFAULT_DISK_SETTINGS;
	const pick = <T>(key: string, valid: (input: unknown) => input is T, fallback: T): T => {
		const input = value[key];
		if (valid(input)) return input;
		if (strict) throw new Error(`invalid ${key}`);
		return fallback;
	};
	const whole =
		(min: number, max: number) =>
		(input: unknown): input is number =>
			typeof input === "number" && Number.isInteger(input) && input >= min && input <= max;
	return {
		limitGb: pick("limitGb", whole(DISK_MIN_LIMIT_GB, DISK_MAX_LIMIT_GB), defaults.limitGb),
		autoClean: pick("autoClean", (input): input is boolean => typeof input === "boolean", defaults.autoClean),
		idleHours: pick("idleHours", whole(DISK_MIN_IDLE_HOURS, DISK_MAX_IDLE_HOURS), defaults.idleHours),
	};
}

/** The limit in bytes. */
export function limitBytes(settings: DiskGuardSettings): number {
	return settings.limitGb * DISK_GB;
}

/** A worktree that holds build output, as far as the plan needs to know. */
export interface PlanCandidate {
	path: string;
	/** Bytes measured; null when the size scan did not finish in time. */
	bytes: number | null;
	/** Time since the worktree was last used. */
	idleMs: number;
	/** A session or process works in it. */
	busy: boolean;
}

export interface PlanInput {
	freeBytes: number;
	/** Cleaning starts below this much free space. */
	limitBytes: number;
	/** Cleaning stops once free space reaches `limitBytes + marginBytes`. */
	marginBytes: number;
	/** A worktree used within this many hours is left alone. */
	idleHours: number;
	candidates: readonly PlanCandidate[];
}

/** Why a candidate is not in the plan. */
export type PlanSkipReason = "busy" | "recent" | "not-needed";

export interface Plan {
	/** Free space the clean aims for. */
	targetBytes: number;
	/** How much more free space reaching the target takes; 0 when there is room. */
	deficitBytes: number;
	/** What to delete, in order. A null size is one that could not be measured: it may be the biggest of all. */
	clean: { path: string; bytes: number | null }[];
	skipped: { path: string; reason: PlanSkipReason }[];
	/** Even every eligible candidate would not close the gap (by the sizes that are known). */
	short: boolean;
}

/**
 * What to delete to bring a volume back above its limit. Nothing while free space is at or above the limit. Below it,
 * the eligible worktrees (not busy, not used within `idleHours`) go biggest first — one whose size could not be
 * measured first of all, since a scan that cannot finish in its time limit is looking at something huge or at a disk
 * that is struggling — until the sizes that are known cover the gap to `limit + margin`. The caller checks the real free
 * space after each deletion and stops early; the plan only bounds how far it may go.
 */
export function planClean(input: PlanInput): Plan {
	const targetBytes = input.limitBytes + input.marginBytes;
	const needed = input.freeBytes < input.limitBytes;
	const deficitBytes = needed ? Math.max(0, targetBytes - input.freeBytes) : 0;
	const minIdleMs = input.idleHours * HOUR_MS;
	const skipped: Plan["skipped"] = [];
	const eligible: PlanCandidate[] = [];
	for (const candidate of input.candidates) {
		if (candidate.busy) skipped.push({ path: candidate.path, reason: "busy" });
		else if (candidate.idleMs < minIdleMs) skipped.push({ path: candidate.path, reason: "recent" });
		else eligible.push(candidate);
	}
	const size = (candidate: PlanCandidate): number => candidate.bytes ?? Number.POSITIVE_INFINITY;
	eligible.sort((a, b) => size(b) - size(a) || b.idleMs - a.idleMs || a.path.localeCompare(b.path));
	const clean: Plan["clean"] = [];
	let covered = 0;
	for (const candidate of eligible) {
		if (!needed || covered >= deficitBytes) {
			skipped.push({ path: candidate.path, reason: "not-needed" });
			continue;
		}
		clean.push({ path: candidate.path, bytes: candidate.bytes });
		covered += candidate.bytes ?? 0;
	}
	const short = needed && covered < deficitBytes && !clean.some(item => item.bytes === null);
	return { targetBytes, deficitBytes, clean, skipped, short };
}

/** A watched volume's reading, keyed by what identifies the volume (its device). */
export interface DiskReading {
	key: string;
	path: string;
	freeBytes: number;
}

/**
 * The warning rule: a volume warns once when its free space drops below the limit, and is armed again only after
 * it recovers to `limit + margin` — so free space hovering around the limit, or an auto-clean that lifts it a little,
 * never repeats the notification. `alerted` holds the keys that already warned; a volume that is no longer read is
 * forgotten.
 */
export function nextAlerts(
	alerted: readonly string[],
	readings: readonly DiskReading[],
	limit: number,
	margin: number,
): { alerted: string[]; fresh: DiskReading[] } {
	const warned = new Set(alerted);
	const next: string[] = [];
	const fresh: DiskReading[] = [];
	for (const reading of readings) {
		const was = warned.has(reading.key);
		if (reading.freeBytes < limit) {
			next.push(reading.key);
			if (!was) fresh.push(reading);
		} else if (was && reading.freeBytes < limit + margin) next.push(reading.key);
	}
	return { alerted: next, fresh };
}

/** The volume that is lowest on space among those below the limit; null when none is. */
export function lowestVolume(volumes: readonly DiskVolume[]): DiskVolume | null {
	let lowest: DiskVolume | null = null;
	for (const volume of volumes) {
		if (volume.low && (lowest === null || volume.freeBytes < lowest.freeBytes)) lowest = volume;
	}
	return lowest;
}
