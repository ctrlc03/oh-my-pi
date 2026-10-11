import type { CacheMiss, CacheMissReason, SessionCacheStats } from "@oh-my-pi/pi-wire";

/** A miss every this many settled turns that nothing else explains: an idle gap past the cache lifetime. */
const IDLE_MISS_EVERY = 5;
const RECENT_MISSES = 5;

/**
 * Prompt-cache numbers for the mock host, one request per settled scripted turn. The first
 * request writes the cache, later ones read nearly all of it; a model, thinking-level or
 * compaction change (noted as it happens) makes the next one a miss with that cause, and an
 * otherwise quiet session misses with `ttl` every fifth turn, so the strip and its details
 * show every state without a real provider.
 */
export class MockCache {
	#requests = 0;
	#promptTotal = 0;
	#readTotal = 0;
	#causes: CacheMissReason[] = [];
	#misses: CacheMiss[] = [];
	#missCount = 0;
	#last: SessionCacheStats["last"];

	/** A change since the last request that breaks the cached prefix. */
	note(reason: CacheMissReason): void {
		if (!this.#causes.includes(reason)) this.#causes.push(reason);
	}

	/** Settles one request on `model`. */
	settle(model: string, now: number = Date.now()): void {
		this.#requests++;
		const prompt = 40_000 + this.#requests * 1_200;
		const idleMiss = this.#causes.length === 0 && this.#requests > 1 && this.#requests % IDLE_MISS_EVERY === 0;
		const reasons = idleMiss ? ["ttl" as const] : this.#causes;
		const missed = this.#requests > 1 && reasons.length > 0;
		const cacheRead = this.#requests === 1 || missed ? 0 : prompt - 1_200;
		const cacheWrite = prompt - cacheRead - 40;
		const input = 40;
		const output = 300 + (this.#requests % 4) * 120;
		this.#last = {
			at: now,
			model,
			input,
			output,
			cacheRead,
			cacheWrite,
			hitPct: (cacheRead / (cacheRead + cacheWrite + input)) * 100,
			tokensPerSecond: 38 + (this.#requests % 3) * 9,
			ttftMs: 700 + (this.#requests % 5) * 140,
			costUsd: (cacheRead * 0.3 + cacheWrite * 3.75 + input * 3 + output * 15) / 1_000_000,
		};
		this.#promptTotal += cacheRead + cacheWrite + input;
		this.#readTotal += cacheRead;
		if (missed) {
			this.#missCount++;
			this.#misses.push({ at: now, reasons: [...reasons], reprocessedTokens: cacheWrite + input, model });
		}
		this.#causes = [];
	}

	snapshot(): SessionCacheStats | undefined {
		if (this.#last === undefined) return undefined;
		return {
			last: this.#last,
			requests: this.#requests,
			hitPct: (this.#readTotal / this.#promptTotal) * 100,
			misses: this.#missCount,
			recentMisses: this.#misses.slice(-RECENT_MISSES),
		};
	}
}
