/**
 * Spend and session history for the companion, read from omp's stats database
 * (`<config>/stats.db`, which honors PI_CONFIG_DIR like the rest of the
 * companion). Subpath imports only: the stats package root bundles its
 * dashboard server.
 *
 * Reshaping lives in pure exported functions so it is testable without a
 * database; `usageReport` and `sessionOverview` add the (throttled) sync and
 * the queries around them.
 */

import * as path from "node:path";
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { refreshRollups } from "@oh-my-pi/omp-stats/rollup";
import type { DashboardStats, SessionSummary } from "@oh-my-pi/omp-stats/shared-types";
import { listSessionSummaries } from "@oh-my-pi/omp-stats/trace";
import type {
	CompanionHost,
	CompanionIdleSession,
	SessionOverview,
	UsageRange,
	UsageReport,
} from "../src/lib/companion";

/** Sessions files are re-read at most this often; between syncs the database is served as is. */
const SYNC_INTERVAL_MS = 60_000;
/** A request waits this long for a sync (the client gives up at 60s) before serving the database as it is. */
const SYNC_DEADLINE_MS = 20_000;
const MODEL_LIMIT = 12;
const PROJECT_LIMIT = 15;
const DEFAULT_SESSION_LIMIT = 100;
const MAX_SESSION_LIMIT = 300;
const MAX_QUERY_LENGTH = 200;
/** A chart past this many buckets (`all` over years) is compacted into wider ones. */
const MAX_SERIES_BUCKETS = 120;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Span (null: unbounded) and bucket size per range; matches omp-stats' `getTimeRangeConfig`. */
const RANGES: Record<UsageRange, { spanMs: number | null; bucketMs: number }> = {
	"24h": { spanMs: DAY_MS, bucketMs: HOUR_MS },
	"7d": { spanMs: 7 * DAY_MS, bucketMs: DAY_MS },
	"30d": { spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
	"90d": { spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
	all: { spanMs: null, bucketMs: DAY_MS },
};

type UsageSource = Pick<DashboardStats, "overall" | "byModel" | "byFolder" | "timeSeries">;

/**
 * One zero-filled point per bucket from `from` to `to` (bucket starts, epoch-aligned),
 * so quiet hours and days show as gaps instead of vanishing from the chart.
 */
export function fillSeries(
	points: readonly DashboardStats["timeSeries"][number][],
	bucketMs: number,
	from: number,
	to: number,
): UsageReport["series"] {
	const byBucket = new Map(points.map(point => [point.timestamp, point]));
	const series: UsageReport["series"] = [];
	for (let t = Math.floor(from / bucketMs) * bucketMs; t <= to; t += bucketMs) {
		const point = byBucket.get(t);
		series.push({ t, cost: point?.cost ?? 0, tokens: point?.tokens ?? 0, requests: point?.requests ?? 0 });
	}
	return series;
}

/** Sum runs of adjacent buckets so the series holds at most `max` points; each keeps its first bucket's start. */
export function compactSeries(series: UsageReport["series"], max: number): UsageReport["series"] {
	if (series.length <= max) return series;
	const group = Math.ceil(series.length / max);
	const out: UsageReport["series"] = [];
	for (let i = 0; i < series.length; i += group) {
		const run = series.slice(i, i + group);
		out.push({
			t: run[0].t,
			cost: run.reduce((sum, p) => sum + p.cost, 0),
			tokens: run.reduce((sum, p) => sum + p.tokens, 0),
			requests: run.reduce((sum, p) => sum + p.requests, 0),
		});
	}
	return out;
}

/**
 * The stats database names a project by its session directory (`-Documents-zk-app`), which cannot be
 * turned back into a path (hyphens are ambiguous). Session summaries carry the real folder next to the
 * directory, so map one to the other, keyed the way the stats database spells it.
 */
export function projectNames(summaries: readonly SessionSummary[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const summary of summaries) {
		const dir = path.basename(path.dirname(summary.file));
		names.set(dir.replace(/^--/, "/").replace(/--/g, "/"), summary.folder);
	}
	return names;
}

/**
 * Wire-sized usage report from the dashboard aggregates: top models and projects by spend, zero-filled series.
 * `names` maps the database's project keys to real folders; unknown keys stay as they are.
 */
export function reshapeUsage(
	stats: UsageSource,
	range: UsageRange,
	syncedAt: number,
	now: number,
	names: ReadonlyMap<string, string>,
): UsageReport {
	const { overall } = stats;
	const { spanMs, bucketMs } = RANGES[range];
	const first = stats.timeSeries[0]?.timestamp ?? now;
	const series = compactSeries(
		fillSeries(stats.timeSeries, bucketMs, spanMs === null ? first : now - spanMs, now),
		MAX_SERIES_BUCKETS,
	);
	const tokensOf = (s: UsageSource["overall"]) =>
		s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheWriteTokens;
	return {
		range,
		syncedAt,
		overall: {
			requests: overall.totalRequests,
			cost: overall.totalCost,
			inputTokens: overall.totalInputTokens,
			outputTokens: overall.totalOutputTokens,
			cacheReadTokens: overall.totalCacheReadTokens,
			cacheWriteTokens: overall.totalCacheWriteTokens,
			totalTokens: tokensOf(overall),
			cacheRate: overall.cacheRate,
			unpricedRequests: overall.unpricedRequests,
		},
		series,
		byModel: stats.byModel
			.map(m => ({
				model: m.model,
				provider: m.provider,
				cost: m.totalCost,
				requests: m.totalRequests,
				tokens: tokensOf(m),
			}))
			.sort((a, b) => b.cost - a.cost || b.requests - a.requests)
			.slice(0, MODEL_LIMIT),
		byProject: stats.byFolder
			.map(f => ({
				folder: names.get(f.folder) ?? f.folder,
				cost: f.totalCost,
				requests: f.totalRequests,
				tokens: tokensOf(f),
			}))
			.sort((a, b) => b.cost - a.cost || b.requests - a.requests)
			.slice(0, PROJECT_LIMIT),
	};
}

/**
 * The session id of a root session file, `<timestamp>_<sessionId>.jsonl`; null for any other name.
 * The timestamp has no underscore, the id may.
 */
export function sessionIdOfFile(file: string): string | null {
	const name = path.basename(file, ".jsonl");
	const at = name.indexOf("_");
	return at > 0 && at < name.length - 1 ? name.slice(at + 1) : null;
}

/** Clamp a client-supplied `limit` to 1..300 (default 100). */
export function clampSessionLimit(limit: unknown): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SESSION_LIMIT;
	return Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Session summaries with the listed hosts and idle sessions merged in by session id (a host wins over idle). */
export function mergeLive(
	summaries: readonly SessionSummary[],
	live: { hosts: readonly CompanionHost[]; idle: readonly CompanionIdleSession[] },
): SessionOverview[] {
	const instances = new Map<string, { instanceId: string; live: "host" | "idle" }>();
	for (const idle of live.idle) instances.set(idle.sessionId, { instanceId: idle.instanceId, live: "idle" });
	for (const host of live.hosts) instances.set(host.sessionId, { instanceId: host.instanceId, live: "host" });
	const sessions: SessionOverview[] = [];
	for (const summary of summaries) {
		const sessionId = sessionIdOfFile(summary.file);
		if (!sessionId) continue;
		sessions.push({
			sessionId,
			title: summary.title,
			folder: summary.folder,
			startedAt: summary.startedAt,
			endedAt: summary.endedAt || null,
			requests: summary.requests,
			toolCalls: summary.toolCalls,
			subagents: summary.subagents,
			tokens: summary.totalTokens,
			cost: summary.costTotal,
			models: summary.models,
			...instances.get(sessionId),
		});
	}
	return sessions;
}

export interface SyncGateOptions {
	sync(): Promise<unknown>;
	/** A sync is started at most this often, counted from the last attempt's start or end. */
	intervalMs: number;
	/** `run` stops waiting for a running sync after this long; the sync itself carries on. */
	deadlineMs: number;
	now?(): number;
	/** Resolves after `ms`; replaceable so tests need no real timers. */
	delay?(ms: number): Promise<void>;
}

/**
 * Throttles and bounds a sync of the stats database. Concurrent callers share one run; a failed
 * run is throttled like a successful one; a run stuck behind the sync lock (held by `omp stats` or
 * an omp launch) keeps going in the background while callers move on after `deadlineMs`.
 */
export function createSyncGate(options: SyncGateOptions): { run(): Promise<void>; syncedAt(): number } {
	const { sync, intervalMs, deadlineMs } = options;
	const now = options.now ?? Date.now;
	const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms, undefined)));
	let lastAttemptAt = Number.NEGATIVE_INFINITY;
	let lastSuccessAt = 0;
	let running: Promise<void> | null = null;
	return {
		async run() {
			if (!running && now() - lastAttemptAt >= intervalMs) {
				lastAttemptAt = now();
				running = sync()
					.then(() => {
						lastSuccessAt = now();
					})
					// A held lock or unreadable file must not hide the data already in the database.
					.catch(() => {})
					.finally(() => {
						lastAttemptAt = now();
						running = null;
					});
			}
			if (running) await Promise.race([running, delay(deadlineMs)]);
		},
		syncedAt: () => lastSuccessAt,
	};
}

/** Ingest new session files, then fold them into the rollup tables the aggregate queries read. */
const syncGate = createSyncGate({
	sync: async () => {
		await syncAllSessions();
		await refreshRollups();
	},
	intervalMs: SYNC_INTERVAL_MS,
	deadlineMs: SYNC_DEADLINE_MS,
});

export async function usageReport(range: UsageRange): Promise<UsageReport> {
	await syncGate.run();
	const [stats, summaries] = await Promise.all([getDashboardStats(range), listSessionSummaries(MAX_SESSION_LIMIT)]);
	return reshapeUsage(stats, range, syncGate.syncedAt(), Date.now(), projectNames(summaries));
}

export async function sessionOverview(
	request: { limit?: unknown; q?: unknown },
	live: { hosts: readonly CompanionHost[]; idle: readonly CompanionIdleSession[] },
): Promise<SessionOverview[]> {
	await syncGate.run();
	const q = typeof request.q === "string" ? request.q.trim().slice(0, MAX_QUERY_LENGTH) : "";
	return mergeLive(await listSessionSummaries(clampSessionLimit(request.limit), q || undefined), live);
}

export function isUsageRange(value: unknown): value is UsageRange {
	return typeof value === "string" && Object.hasOwn(RANGES, value);
}
