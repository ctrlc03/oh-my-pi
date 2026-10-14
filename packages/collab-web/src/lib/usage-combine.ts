import type { UsageReport } from "./companion";

/** The totals of several computers' reports of one range, as one report. Empty input: null. */
export function combineUsage(reports: readonly UsageReport[]): UsageReport | null {
	if (reports.length === 0) return null;
	const overall: UsageReport["overall"] = {
		requests: 0,
		cost: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		cacheRate: 0,
		unpricedRequests: 0,
	};
	let promptTokens = 0;
	let cached = 0;
	for (const report of reports) {
		const o = report.overall;
		overall.requests += o.requests;
		overall.cost += o.cost;
		overall.inputTokens += o.inputTokens;
		overall.outputTokens += o.outputTokens;
		overall.cacheReadTokens += o.cacheReadTokens;
		overall.cacheWriteTokens += o.cacheWriteTokens;
		overall.totalTokens += o.totalTokens;
		overall.unpricedRequests += o.unpricedRequests;
		// The hit rate is a share of each computer's prompt tokens: weigh it by them.
		const prompt = o.inputTokens + o.cacheReadTokens + o.cacheWriteTokens;
		promptTokens += prompt;
		cached += o.cacheRate * prompt;
	}
	overall.cacheRate = promptTokens > 0 ? cached / promptTokens : 0;

	const byModel = new Map<string, UsageReport["byModel"][number]>();
	for (const report of reports) {
		for (const entry of report.byModel) {
			const key = `${entry.provider}/${entry.model}`;
			const sum = byModel.get(key);
			if (sum === undefined) byModel.set(key, { ...entry });
			else {
				sum.cost += entry.cost;
				sum.requests += entry.requests;
				sum.tokens += entry.tokens;
			}
		}
	}

	const series = new Map<number, UsageReport["series"][number]>();
	for (const report of reports) {
		for (const point of report.series) {
			const sum = series.get(point.t);
			if (sum === undefined) series.set(point.t, { ...point });
			else {
				sum.cost += point.cost;
				sum.tokens += point.tokens;
				sum.requests += point.requests;
			}
		}
	}

	return {
		range: reports[0].range,
		syncedAt: Math.min(...reports.map(report => report.syncedAt)),
		overall,
		series: [...series.values()].sort((a, b) => a.t - b.t),
		byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
		// Folders are paths on their own computer: the same path on two computers is not the same project.
		byProject: [],
	};
}

/**
 * Whether the reports' time buckets are the same instants. Daily buckets start at each computer's own midnight,
 * so computers in different time zones do not line up and their series cannot be added bar by bar.
 */
export function seriesAligned(reports: readonly UsageReport[]): boolean {
	const first = reports.find(report => report.series.length > 0);
	if (first === undefined) return true;
	return reports.every(
		report =>
			report.series.length === 0 ||
			(report.series.length === first.series.length &&
				report.series.every((point, i) => point.t === first.series[i].t)),
	);
}
