import { formatNumber } from "@oh-my-pi/pi-utils";
import type { CacheMiss, CacheMissReason } from "@oh-my-pi/pi-wire";
import type { RequestLedger } from "./request-ledger";

/** Plain-language cause for each attribution, as `/cache` prints it. */
export const CACHE_MISS_LABELS: Record<CacheMissReason, string> = {
	model: "model or provider changed",
	"system-prompt": "system prompt changed",
	tools: "tool list changed",
	compaction: "history compacted or pruned",
	thinking: "thinking level changed",
	ttl: "cache expired (idle past its lifetime)",
	unknown: "unknown cause",
};

/** Misses `/cache` lists, newest first. */
const REPORT_MISSES = 10;

function formatMissTime(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	return `${(seconds / 3600).toFixed(1)}h ago`;
}

function formatMiss(miss: CacheMiss, now: number): string {
	const [primary, ...others] = miss.reasons;
	const cause = primary === undefined ? CACHE_MISS_LABELS.unknown : CACHE_MISS_LABELS[primary];
	const extra = others.length > 0 ? ` (also ${others.join(", ")})` : "";
	return `  ${formatMissTime(miss.at, now)} · ${miss.model} · ${formatNumber(miss.reprocessedTokens)} tokens reprocessed · ${cause}${extra}`;
}

/** The `/cache` report: last request, session hit rate, and the recent misses with their causes. */
export function formatCacheReport(ledger: RequestLedger, now: number = Date.now()): string {
	const snapshot = ledger.snapshot();
	const last = snapshot?.last;
	if (!snapshot || !last) return "Cache: no request with a prompt yet.";
	const lines: string[] = [];
	const lastHit = last.hitPct === undefined ? "n/a" : `${last.hitPct.toFixed(1)}%`;
	lines.push(
		`Last request: ${lastHit} cache hit · ${formatNumber(last.cacheRead)} read · ${formatNumber(last.cacheWrite)} written · ${formatNumber(last.input)} uncached`,
	);
	const speed: string[] = [];
	if (last.ttftMs !== undefined) speed.push(`${Math.round(last.ttftMs)} ms to first token`);
	if (last.tokensPerSecond !== undefined) speed.push(`${last.tokensPerSecond.toFixed(1)} tok/s`);
	speed.push(`${formatNumber(last.output)} out`);
	speed.push(`$${last.costUsd.toFixed(4)}`);
	lines.push(`  ${speed.join(" · ")}`);
	const sessionHit = snapshot.hitPct === undefined ? "n/a" : `${snapshot.hitPct.toFixed(1)}%`;
	lines.push(
		`Session: ${sessionHit} hit rate over ${snapshot.requests} request${snapshot.requests === 1 ? "" : "s"} · ${snapshot.misses} miss${snapshot.misses === 1 ? "" : "es"}`,
	);
	const misses = ledger.misses();
	if (misses.length > 0) {
		lines.push("Misses (newest first):");
		for (const miss of misses.slice(-REPORT_MISSES).reverse()) lines.push(formatMiss(miss, now));
	}
	return lines.join("\n");
}
