import { describe, expect, it } from "bun:test";
import {
	createSpendMonitor,
	dayKey,
	detectCrossings,
	parseSpendLimits,
	SPEND_CHECK_MS,
	type SpendAlert,
	type SpendReading,
	type SpendState,
	withLimits,
} from "../scripts/companion-spend";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const reading = (dailyUsd: number, ...sessions: [string, number][]): SpendReading => ({
	dailyUsd,
	sessions: sessions.map(([id, usd]) => ({ sessionId: id, instanceId: `i-${id}`, title: id, usd })),
});

describe("detectCrossings", () => {
	const day1 = at(2026, 10, 9);
	const fresh = withLimits(undefined, { dailyUsd: 10, sessionUsd: 5 }, day1);

	it("alerts once when daily spend reaches the limit, not before and not again", () => {
		expect(detectCrossings(fresh, reading(9.99), day1).alerts).toEqual([]);
		const crossed = detectCrossings(fresh, reading(10), day1);
		expect(crossed.alerts.map(a => a.title)).toEqual(["Daily spend limit"]);
		expect(detectCrossings(crossed.state, reading(25), day1 + 3_600_000).alerts).toEqual([]);
	});

	it("alerts again on the next local day", () => {
		const crossed = detectCrossings(fresh, reading(12), day1).state;
		const day2 = at(2026, 10, 10, 0);
		expect(detectCrossings(crossed, reading(3), day2).alerts).toEqual([]);
		const again = detectCrossings(crossed, reading(11), day2 + 3_600_000);
		expect(again.alerts).toHaveLength(1);
		expect(again.state.day).toBe(dayKey(day2));
	});

	it("alerts once per session, naming the session to open, and keeps later days quiet", () => {
		const first = detectCrossings(fresh, reading(1, ["a", 6], ["b", 2]), day1);
		expect(first.alerts).toEqual([
			{ title: "a", body: "This session has spent $6.00, over your $5.00 limit.", instanceId: "i-a" },
		]);
		const next = detectCrossings(first.state, reading(1, ["a", 8], ["b", 5]), at(2026, 10, 11));
		expect(next.alerts.map(a => a.instanceId)).toEqual(["i-b"]);
	});

	it("ignores a limit that is off", () => {
		const off = withLimits(undefined, { dailyUsd: null, sessionUsd: null }, day1);
		expect(detectCrossings(off, reading(1e6, ["a", 1e6]), day1).alerts).toEqual([]);
	});
});

describe("withLimits", () => {
	const day = at(2026, 10, 9);
	it("re-arms only the limit that changed", () => {
		const alerted: SpendState = {
			limits: { dailyUsd: 10, sessionUsd: 5 },
			day: dayKey(day),
			dailyAlerted: true,
			sessionsAlerted: ["a"],
		};
		expect(withLimits(alerted, { dailyUsd: 20, sessionUsd: 5 }, day)).toMatchObject({
			dailyAlerted: false,
			sessionsAlerted: ["a"],
		});
		expect(withLimits(alerted, { dailyUsd: 10, sessionUsd: 7 }, day)).toMatchObject({
			dailyAlerted: true,
			sessionsAlerted: [],
		});
	});
});

describe("parseSpendLimits", () => {
	it("accepts positive amounts and null, rejects everything else", () => {
		expect(parseSpendLimits({ dailyUsd: 12.5, sessionUsd: null })).toEqual({ dailyUsd: 12.5, sessionUsd: null });
		for (const bad of [
			null,
			{},
			{ dailyUsd: 0, sessionUsd: null },
			{ dailyUsd: -1, sessionUsd: null },
			{ dailyUsd: "3", sessionUsd: null },
			{ dailyUsd: Number.NaN, sessionUsd: null },
			{ dailyUsd: 1e12, sessionUsd: null },
		])
			expect(() => parseSpendLimits(bad)).toThrow("invalid spend limits");
	});
});

describe("createSpendMonitor", () => {
	function harness(initial: SpendState | undefined, wanted = true) {
		let now = at(2026, 10, 9);
		let state = initial;
		let spent = reading(0);
		let reads = 0;
		const alerts: SpendAlert[] = [];
		const monitor = createSpendMonitor({
			now: () => now,
			state: () => state,
			save: async next => {
				state = next;
			},
			wanted: () => wanted,
			read: async () => {
				reads++;
				return spent;
			},
			alert: alert => alerts.push(alert),
			onError: err => {
				throw err;
			},
		});
		return {
			monitor,
			alerts,
			reads: () => reads,
			spend: (next: SpendReading) => {
				spent = next;
			},
			advance: (ms: number) => {
				now += ms;
			},
			setState: (next: SpendState) => {
				state = next;
			},
		};
	}
	const limits = withLimits(undefined, { dailyUsd: 10, sessionUsd: null }, at(2026, 10, 9));

	it("reads the stats at most once per interval and pushes one alert per crossing", async () => {
		const h = harness(limits);
		await h.monitor.tick();
		await h.monitor.tick();
		expect(h.reads()).toBe(1);
		h.spend(reading(11));
		h.advance(SPEND_CHECK_MS - 1);
		await h.monitor.tick();
		expect(h.reads()).toBe(1);
		h.advance(1);
		await h.monitor.tick();
		h.advance(SPEND_CHECK_MS);
		await h.monitor.tick();
		expect(h.reads()).toBe(3);
		expect(h.alerts).toHaveLength(1);
	});

	it("does not read the stats while no device can receive an alert, or without limits", async () => {
		const unwatched = harness(limits, false);
		await unwatched.monitor.tick(true);
		const unlimited = harness(withLimits(undefined, { dailyUsd: null, sessionUsd: null }, at(2026, 10, 9)));
		await unlimited.monitor.tick(true);
		const unset = harness(undefined);
		await unset.monitor.tick(true);
		expect(unwatched.reads() + unlimited.reads() + unset.reads()).toBe(0);
	});

	it("drops a reading that was taken against limits the user has since replaced", async () => {
		const h = harness(limits);
		h.spend(reading(50));
		const check = h.monitor.tick();
		h.setState(withLimits(limits, { dailyUsd: 100, sessionUsd: null }, at(2026, 10, 9)));
		await check;
		expect(h.alerts).toEqual([]);
	});
});
