/** Pure math behind the Timeline view: bar fractions, cache share, medians and totals over `inspect` rows. */

import type { InspectRow } from "@oh-my-pi/pi-wire";

/** `cacheRead / (input + cacheRead + cacheWrite)` as a 0–1 fraction; null when the request reported no input at all. */
export function cacheFraction(row: Pick<InspectRow, "input" | "cacheRead" | "cacheWrite">): number | null {
	const total = row.input + row.cacheRead + row.cacheWrite;
	if (!(total > 0)) return null;
	return Math.min(1, Math.max(0, row.cacheRead / total));
}

/** How the bar of one request splits: widths are fractions (0–1) of the whole track. */
export interface TimingBar {
	/** Waiting for the first token. */
	wait: number;
	/** Streaming the response. */
	decode: number;
}

/**
 * The timing bar of `row` against the slowest request (`maxMs`): the bar's total width is
 * `durationMs / maxMs`, split into the wait for the first token and the decode after it.
 * Null when the host reported no duration. A missing TTFT makes the whole bar decode; a TTFT
 * longer than the duration (clock skew) is clamped to it.
 */
export function timingBar(row: Pick<InspectRow, "ttftMs" | "durationMs">, maxMs: number): TimingBar | null {
	const duration = row.durationMs;
	if (duration === undefined || !Number.isFinite(duration) || duration <= 0 || !(maxMs > 0)) return null;
	const total = Math.min(1, duration / maxMs);
	const ttft =
		row.ttftMs !== undefined && Number.isFinite(row.ttftMs) ? Math.min(duration, Math.max(0, row.ttftMs)) : 0;
	const wait = (ttft / duration) * total;
	return { wait, decode: total - wait };
}

/** Milliseconds spent streaming after the first token; null when either timing is missing. */
export function decodeMs(row: Pick<InspectRow, "ttftMs" | "durationMs">): number | null {
	if (row.ttftMs === undefined || row.durationMs === undefined) return null;
	return Math.max(0, row.durationMs - row.ttftMs);
}

/** The longest duration among `rows`; 0 when none reported one. */
export function slowestMs(rows: readonly Pick<InspectRow, "durationMs">[]): number {
	let max = 0;
	for (const row of rows) if (row.durationMs !== undefined && row.durationMs > max) max = row.durationMs;
	return max;
}

/** Median of `values`; null when empty. */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface TimelineSummary {
	requests: number;
	cost: number;
	/** Input, cache and output tokens of every request. */
	tokens: number;
	/** Median time to first token across requests that reported one. */
	medianTtftMs: number | null;
	/** Cache reads as a share of all input-side tokens across every request; null with none. */
	cacheFraction: number | null;
	errors: number;
}

export function summarize(rows: readonly InspectRow[]): TimelineSummary {
	let cost = 0;
	let tokens = 0;
	let input = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let errors = 0;
	const ttfts: number[] = [];
	for (const row of rows) {
		cost += row.cost;
		tokens += row.input + row.output + row.cacheRead + row.cacheWrite;
		input += row.input;
		cacheRead += row.cacheRead;
		cacheWrite += row.cacheWrite;
		if (row.error !== undefined) errors++;
		if (row.ttftMs !== undefined) ttfts.push(row.ttftMs);
	}
	return {
		requests: rows.length,
		cost,
		tokens,
		medianTtftMs: median(ttfts),
		cacheFraction: cacheFraction({ input, cacheRead, cacheWrite }),
		errors,
	};
}

/** `provider/model` without the provider: `anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`. */
export function shortModel(model: string): string {
	const slash = model.lastIndexOf("/");
	return slash < 0 ? model : model.slice(slash + 1);
}
