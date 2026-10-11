import type { SessionCacheStats } from "@oh-my-pi/pi-wire";
import { Database } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { fmtHit, fmtRate, lastRequestMiss, missLabel } from "../../lib/cache-strip";
import { fmtCost, fmtDuration, fmtTokens, relTime } from "../../lib/format";
import { Sheet } from "./Sheet";
import "./cache-strip.css";

export interface CacheStripProps {
	/** The host's prompt-cache numbers; absent when the host predates feature `cache-stats` or has not settled a request. */
	cache: SessionCacheStats | undefined;
}

/**
 * The last request's cache hit, speed, tokens and cost as one slim line above the
 * composer; a miss names its cause. On a phone it collapses to the hit share and the
 * cost. Tapping opens the full numbers and the recent misses.
 */
export function CacheStrip({ cache }: CacheStripProps): ReactNode {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const last = cache?.last;
	if (cache === undefined || last === undefined) return null;

	const miss = lastRequestMiss(cache);
	const prompt = last.cacheRead + last.cacheWrite + last.input;
	return (
		<div className="sh-cachestrip">
			<button
				type="button"
				className="sh-cachestrip-btn"
				data-miss={miss !== undefined ? "true" : undefined}
				onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}
				aria-label="prompt cache details"
				title="Prompt cache of the last request"
			>
				<Database size={13} />
				<span className="sh-cachestrip-hit">{fmtHit(last.hitPct)}</span>
				<span className="sh-cachestrip-wide">cache</span>
				{miss !== undefined && (
					<span className="sh-cachestrip-miss">{missLabel(miss.reasons[0] ?? "unknown")}</span>
				)}
				<span className="sh-cachestrip-spacer" />
				{last.tokensPerSecond !== undefined && (
					<span className="sh-cachestrip-wide">{fmtRate(last.tokensPerSecond)}</span>
				)}
				{last.ttftMs !== undefined && <span className="sh-cachestrip-wide">{fmtDuration(last.ttftMs)} ttft</span>}
				<span className="sh-cachestrip-wide">
					{fmtTokens(prompt)} in · {fmtTokens(last.output)} out
				</span>
				<span className="sh-cachestrip-cost">{fmtCost(last.costUsd)}</span>
			</button>
			{anchor !== null && (
				<Sheet label="prompt cache" anchor={anchor} onClose={() => setAnchor(null)}>
					<div className="sh-sheet-head">
						<div className="sh-sheet-title">Prompt cache</div>
					</div>
					<dl className="sh-sheet-rows">
						<div className="sh-sheet-row">
							<dt>Last request</dt>
							<dd>
								<span className="sh-sheet-mono">{fmtHit(last.hitPct)} hit</span>
								<span className="sh-sheet-faint">{last.model}</span>
							</dd>
						</div>
						<div className="sh-sheet-row">
							<dt>Prompt</dt>
							<dd>
								<span className="sh-sheet-mono">{fmtTokens(last.cacheRead)} read</span>
								<span className="sh-sheet-mono">{fmtTokens(last.cacheWrite)} written</span>
								<span className="sh-sheet-mono">{fmtTokens(last.input)} uncached</span>
							</dd>
						</div>
						<div className="sh-sheet-row">
							<dt>Speed</dt>
							<dd>
								<span className="sh-sheet-mono">
									{last.tokensPerSecond !== undefined ? fmtRate(last.tokensPerSecond) : "no rate"}
								</span>
								<span className="sh-sheet-mono">
									{last.ttftMs !== undefined
										? `${fmtDuration(last.ttftMs)} to first token`
										: "no first-token time"}
								</span>
							</dd>
						</div>
						<div className="sh-sheet-row">
							<dt>Output</dt>
							<dd>
								<span className="sh-sheet-mono">{fmtTokens(last.output)} tokens</span>
								<span className="sh-sheet-mono">{fmtCost(last.costUsd)}</span>
							</dd>
						</div>
						<div className="sh-sheet-row">
							<dt>Session</dt>
							<dd>
								<span className="sh-sheet-mono">{fmtHit(cache.hitPct)} hit rate</span>
								<span className="sh-sheet-faint">
									{cache.requests} request{cache.requests === 1 ? "" : "s"} · {cache.misses} miss
									{cache.misses === 1 ? "" : "es"}
								</span>
							</dd>
						</div>
						{cache.recentMisses.length > 0 && (
							<div className="sh-sheet-row sh-sheet-row-top">
								<dt>Misses</dt>
								<dd>
									<ol className="sh-cachestrip-misses">
										{[...cache.recentMisses].reverse().map(item => (
											<li key={item.at} className="sh-cachestrip-missrow">
												<span>{item.reasons.map(missLabel).join(", ")}</span>
												<span className="sh-sheet-faint">
													{fmtTokens(item.reprocessedTokens)} reprocessed · {item.model} ·{" "}
													{relTime(item.at)}
												</span>
											</li>
										))}
									</ol>
								</dd>
							</div>
						)}
					</dl>
				</Sheet>
			)}
		</div>
	);
}
