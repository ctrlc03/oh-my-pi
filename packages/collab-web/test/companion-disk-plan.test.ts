import { describe, expect, test } from "bun:test";
import { DISK_GB, DISK_MIN_MARGIN_BYTES, type DiskVolume, diskMarginBytes } from "@oh-my-pi/pi-wire/disk";
import {
	limitBytes,
	lowestVolume,
	nextAlerts,
	type PlanCandidate,
	parseDiskSettings,
	planClean,
} from "../scripts/companion-disk-plan";

const GB = DISK_GB;
const HOUR = 3_600_000;
const LIMIT = 40 * GB;
const MARGIN = diskMarginBytes(LIMIT);

const tree = (name: string, gb: number | null, idleHours = 48, busy = false): PlanCandidate => ({
	path: `/w/${name}`,
	bytes: gb === null ? null : gb * GB,
	idleMs: idleHours * HOUR,
	busy,
});

const plan = (freeGb: number, candidates: PlanCandidate[], idleHours = 6) =>
	planClean({ freeBytes: freeGb * GB, limitBytes: LIMIT, marginBytes: MARGIN, idleHours, candidates });

describe("planClean", () => {
	test("deletes the biggest first and stops once the known sizes reach limit plus margin", () => {
		// 5 GB free; the target is 44 GB, so 39 GB must come back.
		const result = plan(5, [tree("small", 4), tree("huge", 30), tree("mid", 12), tree("tiny", 1)]);
		expect(result.targetBytes).toBe(44 * GB);
		expect(result.deficitBytes).toBe(39 * GB);
		expect(result.clean.map(item => item.path)).toEqual(["/w/huge", "/w/mid"]);
		expect(result.short).toBe(false);
		expect(result.skipped).toEqual([
			{ path: "/w/small", reason: "not-needed" },
			{ path: "/w/tiny", reason: "not-needed" },
		]);
	});

	test("deletes nothing at or above the limit", () => {
		for (const free of [40, 41, 200]) {
			const result = plan(free, [tree("a", 30)]);
			expect(result.clean).toEqual([]);
			expect(result.deficitBytes).toBe(0);
			expect(result.skipped).toEqual([{ path: "/w/a", reason: "not-needed" }]);
		}
	});

	test("skips a busy worktree however big, and one used within the idle hours", () => {
		const result = plan(5, [
			tree("busy", 80, 100, true),
			tree("recent", 50, 5.9),
			tree("old", 10, 6),
			tree("ancient", 3, 500),
		]);
		expect(result.clean.map(item => item.path)).toEqual(["/w/old", "/w/ancient"]);
		expect(result.skipped).toEqual([
			{ path: "/w/busy", reason: "busy" },
			{ path: "/w/recent", reason: "recent" },
		]);
		expect(result.short).toBe(true);
	});

	test("the idle hours are the user's: a longer window protects more", () => {
		const candidates = [tree("a", 20, 30), tree("b", 20, 60)];
		expect(plan(5, candidates, 6).clean).toHaveLength(2);
		expect(plan(5, candidates, 48).clean.map(item => item.path)).toEqual(["/w/b"]);
	});

	test("a size that could not be measured goes first, and the plan is not short because of it", () => {
		const result = plan(5, [tree("known", 38), tree("unknown", null)]);
		expect(result.clean.map(item => item.path)).toEqual(["/w/unknown", "/w/known"]);
		expect(plan(5, [tree("unknown", null)]).short).toBe(false);
	});

	test("ties go to the one idle longer, then by path", () => {
		const result = plan(1, [tree("b", 10, 50), tree("a", 10, 50), tree("c", 10, 90), tree("d", 10, 20)]);
		expect(result.clean.map(item => item.path)).toEqual(["/w/c", "/w/a", "/w/b", "/w/d"]);
	});

	test("reports a short plan when everything eligible is not enough", () => {
		const result = plan(5, [tree("a", 3), tree("b", 2)]);
		expect(result.clean).toHaveLength(2);
		expect(result.short).toBe(true);
	});
});

describe("nextAlerts", () => {
	const reading = (freeGb: number, key = "1") => ({ key, path: "/w", freeBytes: freeGb * GB });

	test("warns once when free space drops below the limit, not again while it stays low", () => {
		let alerted: string[] = [];
		const fresh: number[] = [];
		for (const free of [60, 39, 30, 20, 39.9, 12]) {
			const next = nextAlerts(alerted, [reading(free)], LIMIT, MARGIN);
			alerted = next.alerted;
			fresh.push(next.fresh.length);
		}
		expect(fresh).toEqual([0, 1, 0, 0, 0, 0]);
	});

	test("hovering around the limit does not warn again; recovering past limit plus margin re-arms it", () => {
		let alerted: string[] = [];
		const fresh: number[] = [];
		// below, back at the limit, 43.9 (under limit + margin 44), below again: one warning.
		for (const free of [39, 40, 43.9, 39, 44, 39, 50, 39]) {
			const next = nextAlerts(alerted, [reading(free)], LIMIT, MARGIN);
			alerted = next.alerted;
			fresh.push(next.fresh.length);
		}
		// 39 warns; 40/43.9 keep it armed-off; 39 stays quiet; 44 re-arms; 39 warns; 50 re-arms (it was low, now above); 39 warns.
		expect(fresh).toEqual([1, 0, 0, 0, 0, 1, 0, 1]);
	});

	test("volumes are tracked separately, and one that is no longer read is forgotten", () => {
		let state = nextAlerts([], [reading(30, "a"), reading(80, "b")], LIMIT, MARGIN);
		expect(state.fresh.map(item => item.key)).toEqual(["a"]);
		state = nextAlerts(state.alerted, [reading(30, "a"), reading(10, "b")], LIMIT, MARGIN);
		expect(state.fresh.map(item => item.key)).toEqual(["b"]);
		state = nextAlerts(state.alerted, [reading(10, "b")], LIMIT, MARGIN);
		expect(state.alerted).toEqual(["b"]);
		expect(state.fresh).toEqual([]);
	});

	test("the margin is at least 2 GB and a tenth of the limit", () => {
		expect(diskMarginBytes(10 * GB)).toBe(DISK_MIN_MARGIN_BYTES);
		expect(diskMarginBytes(100 * GB)).toBe(10 * GB);
	});
});

describe("lowestVolume", () => {
	const volume = (freeGb: number, low: boolean): DiskVolume => ({
		path: `/v${freeGb}`,
		holds: "worktrees",
		freeBytes: freeGb * GB,
		totalBytes: 500 * GB,
		low,
	});

	test("the lowest of the volumes below the limit, none when all have room", () => {
		expect(lowestVolume([volume(30, true), volume(10, true), volume(5, false)])?.path).toBe("/v10");
		expect(lowestVolume([volume(50, false)])).toBeNull();
	});
});

describe("parseDiskSettings", () => {
	test("a missing or empty file is the defaults: 40 GB, auto-clean off, 6 hours", () => {
		for (const raw of [undefined, null, {}]) {
			expect(parseDiskSettings(raw, false)).toEqual({ limitGb: 40, autoClean: false, idleHours: 6 });
		}
		expect(limitBytes(parseDiskSettings({ limitGb: 25 }, false))).toBe(25 * GB);
	});

	test("a device's edit names every field: a missing one is refused", () => {
		const whole = { limitGb: 40, autoClean: false, idleHours: 6 };
		expect(parseDiskSettings(whole, true)).toEqual(whole);
		expect(() => parseDiskSettings({ limitGb: 40, autoClean: false }, true)).toThrow("invalid idleHours");
		expect(() => parseDiskSettings(undefined, true)).toThrow("invalid limitGb");
	});

	test("strict mode names the first invalid field", () => {
		const ok = { limitGb: 40, autoClean: false, idleHours: 6 };
		expect(() => parseDiskSettings({ ...ok, limitGb: 0 }, true)).toThrow("invalid limitGb");
		expect(() => parseDiskSettings({ ...ok, limitGb: 12.5 }, true)).toThrow("invalid limitGb");
		expect(() => parseDiskSettings({ ...ok, limitGb: "40" }, true)).toThrow("invalid limitGb");
		expect(() => parseDiskSettings({ ...ok, limitGb: 10_001 }, true)).toThrow("invalid limitGb");
		expect(() => parseDiskSettings({ ...ok, autoClean: "yes" }, true)).toThrow("invalid autoClean");
		expect(() => parseDiskSettings({ ...ok, idleHours: 0 }, true)).toThrow("invalid idleHours");
		expect(() => parseDiskSettings({ ...ok, idleHours: 721 }, true)).toThrow("invalid idleHours");
		expect(() => parseDiskSettings("nope", true)).toThrow();
	});

	test("lenient mode (a file on disk) keeps the valid fields and defaults the rest", () => {
		expect(parseDiskSettings({ limitGb: -3, autoClean: true, idleHours: 12 }, false)).toEqual({
			limitGb: 40,
			autoClean: true,
			idleHours: 12,
		});
		expect(parseDiskSettings("garbage", false)).toEqual({ limitGb: 40, autoClean: false, idleHours: 6 });
	});

	test("accepts the bounds", () => {
		expect(parseDiskSettings({ limitGb: 1, idleHours: 1, autoClean: true }, true)).toEqual({
			limitGb: 1,
			autoClean: true,
			idleHours: 1,
		});
		expect(parseDiskSettings({ limitGb: 10_000, idleHours: 720, autoClean: false }, true)).toMatchObject({
			limitGb: 10_000,
			idleHours: 720,
		});
	});
});
