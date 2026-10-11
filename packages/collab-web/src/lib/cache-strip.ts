import type { CacheMiss, CacheMissReason, SessionCacheStats } from "@oh-my-pi/pi-wire";

/** What each attribution means, as the strip shows it. */
const MISS_LABELS: Record<CacheMissReason, string> = {
	model: "model or provider changed",
	"system-prompt": "system prompt changed",
	tools: "tool list changed",
	compaction: "history compacted or pruned",
	thinking: "thinking level changed",
	ttl: "cache expired while idle",
	unknown: "unknown cause",
};

/** A reason a newer host sends that this build does not know shows as sent. */
export function missLabel(reason: string): string {
	return Object.hasOwn(MISS_LABELS, reason) ? MISS_LABELS[reason as CacheMissReason] : reason;
}

/** The miss that belongs to the last request, if that request missed. */
export function lastRequestMiss(cache: SessionCacheStats): CacheMiss | undefined {
	const miss = cache.recentMisses.at(-1);
	return miss !== undefined && miss.at === cache.last?.at ? miss : undefined;
}

/** "92%", or an em dash for a request that carried no prompt. */
export function fmtHit(pct: number | undefined): string {
	return pct === undefined || !Number.isFinite(pct) ? "—" : `${Math.round(pct)}%`;
}

/** "38 tok/s", "420 tok/s". */
export function fmtRate(tokensPerSecond: number): string {
	return `${tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`;
}
