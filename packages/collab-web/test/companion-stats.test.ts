import { describe, expect, it } from "bun:test";
import type { DashboardStats, SessionSummary } from "@oh-my-pi/omp-stats/shared-types";
import type { CompanionHost, CompanionIdleSession } from "../src/lib/companion";
import {
	clampSessionLimit,
	compactSeries,
	createSyncGate,
	mergeLive,
	projectNames,
	reshapeUsage,
	sessionIdOfFile,
} from "../scripts/companion-stats";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function agg(over: Partial<DashboardStats["overall"]> = {}): DashboardStats["overall"] {
	return {
		totalRequests: 1,
		successfulRequests: 1,
		failedRequests: 0,
		errorRate: 0,
		totalInputTokens: 10,
		totalOutputTokens: 20,
		totalCacheReadTokens: 300,
		totalCacheWriteTokens: 4000,
		cacheRate: 0.5,
		cacheSavings: 0,
		totalCost: 1,
		unpricedRequests: 0,
		totalPremiumRequests: 0,
		avgDuration: null,
		avgTtft: null,
		avgTokensPerSecond: null,
		firstTimestamp: 0,
		lastTimestamp: 0,
		...over,
	};
}

function summary(file: string, over: Partial<SessionSummary> = {}): SessionSummary {
	return {
		file,
		folder: "/work/app",
		title: "t",
		startedAt: 1,
		endedAt: 2,
		requests: 3,
		toolCalls: 4,
		subagents: 0,
		totalTokens: 5,
		costTotal: 6,
		unpricedRequests: 0,
		models: ["m"],
		...over,
	};
}

describe("reshapeUsage", () => {
	const now = Date.UTC(2026, 0, 10, 12);
	const stats = {
		overall: agg(),
		byModel: Array.from({ length: 20 }, (_, i) => ({
			...agg({ totalCost: i, totalRequests: 1 }),
			model: `m${i}`,
			provider: "p",
		})),
		byFolder: Array.from({ length: 30 }, (_, i) => ({ ...agg({ totalCost: i }), folder: `-dir${i}` })),
		timeSeries: [{ timestamp: Date.UTC(2026, 0, 8), requests: 2, errors: 0, tokens: 50, cost: 3 }],
	};
	const report = reshapeUsage(stats, "7d", 99, now, new Map([["-dir29", "/real/path"]]));

	it("counts cache tokens in the total", () => {
		expect(report.overall.totalTokens).toBe(10 + 20 + 300 + 4000);
		expect(report.byModel[0].tokens).toBe(4330);
	});

	it("keeps the highest-spend models and projects, in spend order", () => {
		expect(report.byModel).toHaveLength(12);
		expect(report.byModel.map(m => m.model).slice(0, 2)).toEqual(["m19", "m18"]);
		expect(report.byProject).toHaveLength(15);
		expect(report.byProject[0]).toMatchObject({ folder: "/real/path", cost: 29 });
		expect(report.byProject[1].folder).toBe("-dir28");
	});

	it("fills quiet days with zeros up to now", () => {
		expect(report.series.map(p => p.t)).toEqual(report.series.map((_, i) => report.series[0].t + i * DAY));
		expect(report.series.at(-1)!.t).toBe(Date.UTC(2026, 0, 10));
		const busy = report.series.filter(p => p.requests > 0);
		expect(busy).toEqual([{ t: Date.UTC(2026, 0, 8), cost: 3, tokens: 50, requests: 2 }]);
	});
});

describe("compactSeries", () => {
	it("sums merged buckets and keeps the totals", () => {
		const series = Array.from({ length: 250 }, (_, i) => ({ t: i * DAY, cost: 1, tokens: 2, requests: 3 }));
		const out = compactSeries(series, 120);
		expect(out.length).toBeLessThanOrEqual(120);
		expect(out.reduce((sum, p) => sum + p.cost, 0)).toBe(250);
		expect(out.reduce((sum, p) => sum + p.requests, 0)).toBe(750);
		expect(out[1].t).toBe(3 * DAY);
	});
});

describe("session identity", () => {
	it("reads the session id after the first underscore of the file name", () => {
		expect(sessionIdOfFile("/s/-p/2026-10-08T10-10-11-376Z_01a11afd-ed30.jsonl")).toBe("01a11afd-ed30");
		expect(sessionIdOfFile("/s/-p/2026-10-08T10-10-11-376Z_my_session_1.jsonl")).toBe("my_session_1");
		expect(sessionIdOfFile("/s/-p/notes.jsonl")).toBeNull();
	});

	it("maps a session directory to its real folder the way the stats database spells it", () => {
		const names = projectNames([
			summary("/s/-Documents-zk-app/2026_a.jsonl", { folder: "/home/u/Documents/zk-app" }),
			summary("/s/--tmp-work--/2026_b.jsonl", { folder: "/tmp/work" }),
		]);
		expect(names.get("-Documents-zk-app")).toBe("/home/u/Documents/zk-app");
		expect(names.get("/tmp-work/")).toBe("/tmp/work");
	});
});

describe("mergeLive", () => {
	const host = (sessionId: string, instanceId: string): CompanionHost => ({
		instanceId,
		sessionId,
		sessionName: null,
		cwd: "/work/app",
		model: null,
		startedAt: 1,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
	});
	const idle = (sessionId: string, instanceId: string): CompanionIdleSession => ({
		instanceId,
		sessionId,
		sessionName: null,
		cwd: "/work/app",
		model: null,
		startedAt: 1,
		busy: false,
	});
	const rows = [
		summary("/s/-p/2026_aaa.jsonl"),
		summary("/s/-p/2026_bbb.jsonl"),
		summary("/s/-p/2026_ccc.jsonl"),
		summary("/s/-p/garbage.jsonl"),
	];

	it("attaches live hosts and idle sessions by session id, preferring a host", () => {
		const out = mergeLive(rows, {
			hosts: [host("aaa", "h1"), host("bbb", "h2")],
			idle: [idle("bbb", "i1"), idle("ccc", "i2")],
		});
		expect(out.map(s => [s.sessionId, s.live, s.instanceId])).toEqual([
			["aaa", "host", "h1"],
			["bbb", "host", "h2"],
			["ccc", "idle", "i2"],
		]);
	});

	it("leaves ended sessions without live fields", () => {
		const [ended] = mergeLive(rows, { hosts: [], idle: [] });
		expect(ended.live).toBeUndefined();
		expect(ended.instanceId).toBeUndefined();
	});
});

describe("clampSessionLimit", () => {
	it("defaults and bounds client input", () => {
		expect(clampSessionLimit(undefined)).toBe(100);
		expect(clampSessionLimit("5")).toBe(100);
		expect(clampSessionLimit(9999)).toBe(300);
		expect(clampSessionLimit(-3)).toBe(1);
		expect(clampSessionLimit(7.9)).toBe(7);
	});
});

describe("createSyncGate", () => {
	function gate(sync: () => Promise<unknown>) {
		const clock = { t: 1_000_000 };
		const timeout = Promise.withResolvers<void>();
		const g = createSyncGate({
			sync,
			intervalMs: 60_000,
			deadlineMs: 20_000,
			now: () => clock.t,
			delay: () => timeout.promise,
		});
		return { g, clock, expire: () => timeout.resolve() };
	}

	it("stops waiting for a sync stuck behind the lock, and does not start a second one", async () => {
		const stuck = Promise.withResolvers<void>();
		let calls = 0;
		const { g, expire } = gate(() => {
			calls++;
			return stuck.promise;
		});
		const first = g.run();
		expire();
		await first; // returned although the sync is still pending
		await g.run();
		expect(calls).toBe(1);
		expect(g.syncedAt()).toBe(0);
		stuck.resolve();
		await Bun.sleep(0);
		expect(g.syncedAt()).toBeGreaterThan(0);
	});

	it("throttles after a failed sync instead of retrying on every request", async () => {
		let calls = 0;
		const { g, clock } = gate(async () => {
			calls++;
			throw new Error("locked");
		});
		await g.run();
		await g.run();
		expect(calls).toBe(1);
		expect(g.syncedAt()).toBe(0);
		clock.t += 60_000;
		await g.run();
		expect(calls).toBe(2);
	});
});
