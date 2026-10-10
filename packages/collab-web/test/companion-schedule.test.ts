import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createScheduler,
	dueState,
	loadSchedules,
	MAX_SCHEDULES,
	MISSED_GRACE_MS,
	nextRunAfter,
	parseScheduleInput,
	parseSchedules,
	type ScheduleNotice,
	saveSchedules,
} from "../scripts/companion-schedule";
import type { Schedule, ScheduleInput, ScheduleWhen } from "../src/lib/schedules";
import { describeWhen } from "../src/lib/schedules";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const MON_FRI = [1, 2, 3, 4, 5];
const originalTz = process.env.TZ;

beforeAll(() => {
	// DST rules matter to the maths below; pin a zone that has them whatever the machine uses.
	process.env.TZ = "America/New_York";
});
afterAll(() => {
	if (originalTz === undefined) delete process.env.TZ;
	else process.env.TZ = originalTz;
});

describe("nextRunAfter", () => {
	const weekdays: ScheduleWhen = { kind: "daily", time: "09:00", days: MON_FRI };

	it("runs later today when the time has not come, else on the next chosen weekday", () => {
		// Friday 2026-10-09
		expect(nextRunAfter(weekdays, local(2026, 10, 9, 8, 0))).toBe(local(2026, 10, 9, 9, 0));
		expect(nextRunAfter(weekdays, local(2026, 10, 9, 9, 0))).toBe(local(2026, 10, 12, 9, 0));
		expect(nextRunAfter(weekdays, local(2026, 10, 10, 12, 0))).toBe(local(2026, 10, 12, 9, 0));
	});

	it("finds a single chosen weekday a week away, and nothing without weekdays", () => {
		const sundays: ScheduleWhen = { kind: "daily", time: "09:00", days: [0] };
		expect(nextRunAfter(sundays, local(2026, 10, 11, 10, 0))).toBe(local(2026, 10, 18, 9, 0));
		expect(nextRunAfter({ kind: "daily", time: "09:00", days: [] }, local(2026, 10, 9))).toBeNull();
	});

	it("runs a once schedule only while its time is ahead", () => {
		const once: ScheduleWhen = { kind: "once", at: local(2026, 10, 9, 12) };
		expect(nextRunAfter(once, local(2026, 10, 9, 11, 59))).toBe(local(2026, 10, 9, 12));
		expect(nextRunAfter(once, local(2026, 10, 9, 12))).toBeNull();
	});

	it("moves a time the spring-forward gap skips to the first valid moment, on the same day", () => {
		const nightly: ScheduleWhen = { kind: "daily", time: "02:30", days: [0, 1, 2, 3, 4, 5, 6] };
		const next = new Date(nextRunAfter(nightly, local(2026, 3, 7, 12)) ?? 0);
		expect([next.getMonth(), next.getDate(), next.getHours()]).toEqual([2, 8, 3]);
		// The day after is back to the real 02:30.
		const after = new Date(nextRunAfter(nightly, next.getTime()) ?? 0);
		expect([after.getDate(), after.getHours(), after.getMinutes()]).toEqual([9, 2, 30]);
	});

	it("runs a time the fall-back hour repeats once, not twice", () => {
		const nightly: ScheduleWhen = { kind: "daily", time: "01:30", days: [0, 1, 2, 3, 4, 5, 6] };
		const first = nextRunAfter(nightly, local(2026, 10, 31, 12)) ?? 0;
		expect(new Date(first).getDate()).toBe(1);
		const second = new Date(nextRunAfter(nightly, first) ?? 0);
		expect([second.getDate(), second.getHours(), second.getMinutes()]).toEqual([2, 1, 30]);
	});
});

describe("dueState", () => {
	const schedule = (nextRun: number | null, enabled = true): Schedule => ({
		id: "a",
		title: "t",
		prompt: "p",
		cwd: "/tmp",
		mode: "new",
		when: { kind: "daily", time: "09:00", days: MON_FRI },
		enabled,
		nextRun,
	});

	it("is due from nextRun on, and a missed run is only worth starting for an hour", () => {
		const at = local(2026, 10, 9, 9);
		expect(dueState(schedule(at), at - 1)).toBeNull();
		expect(dueState(schedule(at), at)).toBe("run");
		expect(dueState(schedule(at), at + MISSED_GRACE_MS)).toBe("run");
		expect(dueState(schedule(at), at + MISSED_GRACE_MS + 1)).toBe("missed");
	});

	it("never fires a disabled schedule or one with nothing left", () => {
		const at = local(2026, 10, 9, 9);
		expect(dueState(schedule(at, false), at + 1)).toBeNull();
		expect(dueState(schedule(null), at + 1)).toBeNull();
	});
});

describe("scheduler", () => {
	const base: Omit<Schedule, "id" | "title" | "when" | "nextRun"> = {
		prompt: "run the tests",
		cwd: "/work/app",
		mode: "new",
		enabled: true,
	};
	const daily = (id: string, nextRun: number): Schedule => ({
		...base,
		id,
		title: `job ${id}`,
		when: { kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] },
		nextRun,
	});

	function harness(initial: Schedule[], opts: { spendReached?: boolean | Error; working?: string[] } = {}) {
		let clock = local(2026, 10, 9, 9, 0);
		const started: Schedule[] = [];
		const notices: ScheduleNotice[] = [];
		const saved: Schedule[][] = [];
		const errors: unknown[] = [];
		let failStart: Error | null = null;
		let refreshes = 0;
		let gate: { entered: () => void; finish: Promise<void> } | null = null;
		const scheduler = createScheduler({
			now: () => clock,
			initial,
			save: async list => {
				saved.push(list);
			},
			start: async schedule => {
				started.push(schedule);
				if (gate) {
					gate.entered();
					await gate.finish;
				}
				if (failStart) throw failStart;
				return `inst-${started.length}`;
			},
			spendLimitReached: async () => {
				if (opts.spendReached instanceof Error) throw opts.spendReached;
				return opts.spendReached === true;
			},
			refreshSessions: async () => {
				refreshes++;
			},
			isWorking: id => opts.working?.includes(id) === true,
			notify: notice => notices.push(notice),
			onError: err => errors.push(err),
		});
		return {
			scheduler,
			started,
			notices,
			saved,
			errors,
			refreshCount: () => refreshes,
			setNow: (ms: number) => {
				clock = ms;
			},
			failNextStart: (err: Error) => {
				failStart = err;
			},
			/** The next start parks until `finish()`; `entered` settles once it has begun. */
			holdStarts: () => {
				let entered!: () => void;
				let finish!: () => void;
				const begun = new Promise<void>(resolve => (entered = resolve));
				gate = { entered, finish: new Promise<void>(resolve => (finish = resolve)) };
				return { begun, finish };
			},
		};
	}

	it("starts a due schedule once, records the session, tells the user and moves on to tomorrow", async () => {
		const h = harness([daily("a", local(2026, 10, 9, 9))]);
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.started).toHaveLength(1);
		const [job] = h.scheduler.list();
		expect(job?.lastRun).toEqual({ at: local(2026, 10, 9, 9), instanceId: "inst-1" });
		expect(job?.nextRun).toBe(local(2026, 10, 10, 9));
		expect(h.notices).toEqual([
			{ title: "Scheduled: job a started", body: "Working in app", instanceId: "inst-1", tag: "schedule:a" },
		]);
	});

	it("does not start the same schedule twice while its start is still in flight", async () => {
		const h = harness([daily("a", local(2026, 10, 9, 9))]);
		const hold = h.holdStarts();
		const first = h.scheduler.tick();
		await hold.begun;
		await h.scheduler.tick();
		await expect(h.scheduler.runNow("a")).rejects.toThrow("already starting");
		expect(h.started).toHaveLength(1);
		hold.finish();
		await first;
		expect(h.scheduler.list()[0]?.lastRun?.instanceId).toBe("inst-1");
	});

	it("starts a run that woke up under an hour late, but only records one missed longer ago", async () => {
		const late = harness([daily("a", local(2026, 10, 9, 9))]);
		late.setNow(local(2026, 10, 9, 9, 59));
		await late.scheduler.tick();
		expect(late.started).toHaveLength(1);

		const missed = harness([daily("a", local(2026, 10, 9, 9))]);
		missed.setNow(local(2026, 10, 9, 10, 1));
		await missed.scheduler.tick();
		expect(missed.started).toHaveLength(0);
		expect(missed.notices).toHaveLength(0);
		const [job] = missed.scheduler.list();
		expect(job?.lastRun?.error).toBe("skipped: missed (was due 2026-10-09 09:00)");
		expect(job?.nextRun).toBe(local(2026, 10, 10, 9));
	});

	it("runs a day's missed slot once when the computer wakes days later, never once per day", async () => {
		const h = harness([daily("a", local(2026, 10, 9, 9))]);
		h.setNow(local(2026, 10, 14, 9, 5));
		await h.scheduler.tick();
		expect(h.started).toHaveLength(0);
		expect(h.scheduler.list()[0]?.nextRun).toBe(local(2026, 10, 15, 9));
	});

	it("turns a once schedule off after it ran or was missed", async () => {
		const once = (at: number): Schedule => ({ ...daily("o", at), when: { kind: "once", at } });
		const ran = harness([once(local(2026, 10, 9, 9))]);
		await ran.scheduler.tick();
		expect(ran.scheduler.list()[0]).toMatchObject({ enabled: false, nextRun: null });
		expect(ran.started).toHaveLength(1);

		const missed = harness([once(local(2026, 10, 8, 9))]);
		await missed.scheduler.tick();
		expect(missed.started).toHaveLength(0);
		expect(missed.scheduler.list()[0]).toMatchObject({ enabled: false, nextRun: null });
	});

	it("does not start while the daily spend limit is reached, and says so in the record", async () => {
		const h = harness([daily("a", local(2026, 10, 9, 9))], { spendReached: true });
		await h.scheduler.tick();
		expect(h.started).toHaveLength(0);
		expect(h.scheduler.list()[0]?.lastRun?.error).toBe("skipped: daily spend limit");
		expect(h.scheduler.list()[0]?.nextRun).toBe(local(2026, 10, 10, 9));
		await expect(h.scheduler.runNow("a")).rejects.toThrow("Not started: daily spend limit");
		expect(h.started).toHaveLength(0);
	});

	it("treats a spend check that cannot answer as a reason not to spend", async () => {
		const h = harness([daily("a", local(2026, 10, 9, 9))], { spendReached: new Error("stats db locked") });
		await h.scheduler.tick();
		expect(h.started).toHaveLength(0);
		expect(h.scheduler.list()[0]?.lastRun?.error).toBe("skipped: could not check the daily spend limit");
		expect(h.errors).toHaveLength(1);
	});

	it("skips a trigger while the session the previous run started is still working", async () => {
		const job: Schedule = { ...daily("a", local(2026, 10, 9, 9)), lastRun: { at: 1, instanceId: "inst-old" } };
		const h = harness([job], { working: ["inst-old"] });
		await h.scheduler.tick();
		expect(h.started).toHaveLength(0);
		expect(h.scheduler.list()[0]?.lastRun?.error).toBe("skipped: previous run is still working");
		// The session list is stale while no device watches: it is re-read before deciding.
		expect(h.refreshCount()).toBe(1);
	});

	it("re-reads sessions only when a run is due and an earlier run exists", async () => {
		const h = harness([{ ...daily("a", local(2026, 10, 9, 10)), lastRun: { at: 1, instanceId: "inst-old" } }]);
		await h.scheduler.tick();
		expect(h.refreshCount()).toBe(0);
		const fresh = harness([daily("b", local(2026, 10, 9, 9))]);
		await fresh.scheduler.tick();
		expect(fresh.refreshCount()).toBe(0);
	});

	it("records and announces a run that failed to start, and keeps the timetable", async () => {
		const h = harness([daily("a", local(2026, 10, 9, 9))]);
		h.failNextStart(new Error("tmux is not installed on this computer"));
		await h.scheduler.tick();
		expect(h.scheduler.list()[0]?.lastRun).toEqual({
			at: local(2026, 10, 9, 9),
			error: "tmux is not installed on this computer",
		});
		expect(h.scheduler.list()[0]?.nextRun).toBe(local(2026, 10, 10, 9));
		expect(h.notices).toEqual([
			{
				title: "Scheduled: job a failed to start",
				body: "tmux is not installed on this computer",
				tag: "schedule:a",
			},
		]);
	});

	it("runs now without moving a repeating schedule's next run", async () => {
		const h = harness([daily("a", local(2026, 10, 10, 9))]);
		const ran = await h.scheduler.runNow("a");
		expect(ran.lastRun?.instanceId).toBe("inst-1");
		expect(ran.nextRun).toBe(local(2026, 10, 10, 9));
		expect(ran.enabled).toBe(true);
	});

	it("keeps the stored list in step with every change", async () => {
		const h = harness([]);
		const input: ScheduleInput = { ...base, title: "nightly", when: { kind: "daily", time: "09:00", days: MON_FRI } };
		const created = await h.scheduler.save(input);
		expect(created.id).toBeTruthy();
		expect(created.nextRun).toBe(local(2026, 10, 12, 9));
		const renamed = await h.scheduler.save({ ...input, id: created.id, title: "nightly 2" });
		expect(renamed.nextRun).toBe(created.nextRun);
		expect(h.saved.at(-1)?.map(s => s.title)).toEqual(["nightly 2"]);
		await expect(h.scheduler.save({ ...input, id: "nope" })).rejects.toThrow("no such schedule");
		await h.scheduler.remove(created.id);
		expect(h.scheduler.list()).toEqual([]);
		expect(h.saved.at(-1)).toEqual([]);
	});

	it("refuses a once schedule whose time passed and a list past the limit", async () => {
		const h = harness([]);
		const past: ScheduleInput = { ...base, title: "x", when: { kind: "once", at: local(2026, 10, 9, 8) } };
		await expect(h.scheduler.save(past)).rejects.toThrow("already passed");
		await h.scheduler.save({ ...past, enabled: false });
		for (let i = 1; i < MAX_SCHEDULES; i++) await h.scheduler.save({ ...past, enabled: false });
		await expect(h.scheduler.save({ ...past, enabled: false })).rejects.toThrow(`at most ${MAX_SCHEDULES}`);
	});
});

describe("parseScheduleInput", () => {
	const deps = {
		now: () => local(2026, 10, 9, 12),
		sandboxAvailable: true,
		checkDirectory: async (dir: string) => {
			if (dir.includes("missing")) throw new Error("folder does not exist on this computer");
		},
	};
	const valid = {
		title: "Nightly",
		prompt: "run the tests",
		cwd: "/work/app",
		mode: "new",
		when: { kind: "daily", time: "09:30", days: [5, 1, 1] },
		enabled: true,
	};
	const parse = (patch: Record<string, unknown>, d = deps) => parseScheduleInput({ ...valid, ...patch }, d);

	it("normalises a valid schedule", async () => {
		const input = await parse({ prompt: "  run the tests \n", sandboxed: false });
		expect(input).toMatchObject({
			title: "Nightly",
			prompt: "run the tests",
			when: { kind: "daily", time: "09:30", days: [1, 5] },
			sandboxed: undefined,
		});
	});

	it("names the schedule after the first line of its prompt when no title is given", async () => {
		expect((await parse({ title: " ", prompt: "\nFix the flaky test\nthen push" })).title).toBe("Fix the flaky test");
	});

	it("bounds the prompt", async () => {
		await expect(parse({ prompt: "  " })).rejects.toThrow("prompt is empty");
		await expect(parse({ prompt: "x".repeat(20_001) })).rejects.toThrow("over 20000");
		expect((await parse({ prompt: "x".repeat(20_000) })).prompt).toHaveLength(20_000);
	});

	it("rejects a bad time, weekdays, folder, or mode", async () => {
		await expect(parse({ when: { kind: "daily", time: "9:30", days: [1] } })).rejects.toThrow("HH:MM");
		await expect(parse({ when: { kind: "daily", time: "24:00", days: [1] } })).rejects.toThrow("HH:MM");
		await expect(parse({ when: { kind: "daily", time: "09:30", days: [] } })).rejects.toThrow("weekday");
		await expect(parse({ when: { kind: "daily", time: "09:30", days: [7] } })).rejects.toThrow("weekday");
		await expect(parse({ cwd: "work/app" })).rejects.toThrow("absolute");
		await expect(parse({ cwd: "/work/missing" })).rejects.toThrow("does not exist");
		await expect(parse({ mode: "fork" })).rejects.toThrow("invalid mode");
	});

	it("needs a safe session id to resume, and no worktree with it", async () => {
		await expect(parse({ mode: "resume" })).rejects.toThrow("session to resume");
		await expect(parse({ mode: "resume", sessionId: "--force" })).rejects.toThrow("session to resume");
		await expect(parse({ mode: "resume", sessionId: "abc123", worktree: true })).rejects.toThrow("worktree");
		expect((await parse({ mode: "resume", sessionId: "abc123" })).sessionId).toBe("abc123");
		await expect(parse({ sessionId: "abc123" })).rejects.toThrow("only a resumed run");
	});

	it("accepts a once schedule only in the future, unless it is off", async () => {
		const at = local(2026, 10, 9, 11);
		await expect(parse({ when: { kind: "once", at } })).rejects.toThrow("already passed");
		expect((await parse({ when: { kind: "once", at }, enabled: false })).enabled).toBe(false);
		expect((await parse({ when: { kind: "once", at: local(2026, 10, 9, 13) } })).when.kind).toBe("once");
	});

	it("refuses a sandboxed run where the computer cannot sandbox", async () => {
		await expect(parse({ sandboxed: true }, { ...deps, sandboxAvailable: false })).rejects.toThrow("sandbox");
		expect((await parse({ sandboxed: true })).sandboxed).toBe(true);
	});
});

describe("schedule file", () => {
	it("round-trips through a 0600 file and drops damaged entries", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-schedules-"));
		try {
			const file = path.join(dir, "schedules.json");
			const kept: Schedule = {
				id: "keep",
				title: "t",
				prompt: "p",
				cwd: "/work/app",
				mode: "new",
				when: { kind: "daily", time: "09:00", days: [1] },
				enabled: true,
				lastRun: { at: 5, error: "skipped: daily spend limit" },
				nextRun: local(2026, 10, 12, 9),
			};
			await saveSchedules(file, [kept]);
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
			expect(await loadSchedules(file, local(2026, 10, 9))).toEqual([kept]);
			expect(await loadSchedules(path.join(dir, "absent.json"), 0)).toEqual([]);

			const mixed = parseSchedules(
				{ schedules: [{ id: "bad", prompt: "" }, { ...kept, nextRun: undefined }, 7] },
				local(2026, 10, 9, 12),
			);
			expect(mixed.map(s => s.id)).toEqual(["keep"]);
			// A schedule that lost its nextRun gets one from the clock rather than never firing.
			expect(mixed[0]?.nextRun).toBe(local(2026, 10, 12, 9));
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("describeWhen", () => {
	it("names common weekday sets", () => {
		expect(describeWhen({ kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("Daily 09:00");
		expect(describeWhen({ kind: "daily", time: "09:00", days: [5, 4, 3, 2, 1] })).toBe("Weekdays 09:00");
		expect(describeWhen({ kind: "daily", time: "18:30", days: [3, 1] })).toBe("Mon, Wed 18:30");
	});
});
