import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ServiceTier, Usage } from "@oh-my-pi/pi-ai";
import { cacheHitPct, detectCacheInvalidation } from "@oh-my-pi/pi-tui/chat/cache-invalidation-marker";
import type { CacheMiss, CacheMissReason, CacheRequestStat, SessionCacheStats } from "@oh-my-pi/pi-wire";
import { observedPromptCacheTier } from "./cache-warmer";

export type { CacheMissReason };

/** Records kept per session; older ones are dropped, the running totals are not. */
const MAX_RECORDS = 500;
/** Misses kept for the report; the count keeps growing. */
const MAX_MISSES = 50;
/** Misses a state snapshot carries. */
const SNAPSHOT_MISSES = 5;
/** Prefix below which a cold read is expected rather than a loss (mirrors the TUI cache-miss marker). */
const MIN_CACHE_FOOTPRINT = 2048;
/** A request reading less than this share of the prefix the previous one left behind lost its cache. */
const MISS_READ_SHARE = 0.5;
/** Output over this many ms or less is too short to give a rate. */
const MIN_RATE_DURATION_MS = 100;

/** A model's prompt cache lifetimes in seconds by retention tier. */
export type PromptCacheSeconds = Partial<Record<"short" | "long", number>>;

/** What a request was built from, captured before it is sent. */
export interface RequestFingerprint {
	provider: string;
	model: string;
	thinking: string | undefined;
	/** Digest of the system prompt blocks sent. */
	promptDigest: string;
	/** Digest of the tool list sent: names, descriptions and schemas. */
	toolsDigest: string;
	/** History was compacted or pruned since the previous request. */
	rewritten: boolean;
	/** Prompt cache lifetimes in seconds by retention tier, as the model declares them. */
	promptCache?: PromptCacheSeconds;
	/** Lifetime in ms of the tier the response wrote, once it settled; undefined when unknown or caching is off. */
	ttlMs?: number;
}

/** One settled model request: usage, timing and cache attribution. */
export interface RequestRecord {
	/** 1-based, in request order across the session. */
	seq: number;
	/** `AssistantMessage.timestamp`: when the request started. Joins the record to its branch entry. */
	startedAt: number;
	/** Local wall-clock ms the response finished. */
	completedAt: number;
	provider: string;
	model: string;
	thinking: string | undefined;
	serviceTier?: ServiceTier;
	responseId?: string;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `cacheRead + cacheWrite + input`: every prompt token the request carried. */
	promptTokens: number;
	/** `cacheRead` over `promptTokens` as a percentage; undefined when the request carried no prompt. */
	hitPct?: number;
	costUsd: number;
	ttftMs?: number;
	durationMs?: number;
	tokensPerSecond?: number;
	/** Set when the request read less cache than the previous one left behind. */
	miss?: { reasons: CacheMissReason[]; reprocessedTokens: number };
}

/** Prompt tokens a usage carries: cached reads, cache writes and uncached input. */
export function promptTokensOf(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number {
	return usage.cacheRead + usage.cacheWrite + usage.input;
}

/**
 * Prompt tokens `current` had to process because its cache read fell short of
 * the prefix `previous` left behind, or undefined when it did not fall short.
 *
 * A full collapse after a warm read is the TUI marker's condition
 * ({@link detectCacheInvalidation}). Beyond it, a request is a miss when it read
 * under half of what the previous one cached (`cacheRead + cacheWrite`) while
 * reprocessing a non-trivial prompt: that covers a cache that expired after only
 * being written, and a prefix broken part-way down.
 */
export function cacheMissTokens(previous: Usage, current: Usage): number | undefined {
	const collapsed = detectCacheInvalidation(previous, current);
	if (collapsed) return collapsed.reprocessedTokens;
	const expected = previous.cacheRead + previous.cacheWrite;
	if (expected < MIN_CACHE_FOOTPRINT) return undefined;
	if (current.cacheRead >= expected * MISS_READ_SHARE) return undefined;
	const reprocessed = promptTokensOf(current) - current.cacheRead;
	return reprocessed >= MIN_CACHE_FOOTPRINT ? reprocessed : undefined;
}

/**
 * Every cause that applies to a cache miss between two requests, most likely
 * first: a different model or provider has its own cache; a changed system prompt
 * or tool list breaks the prefix at its head; a compaction or prune rewrote the
 * history; a different thinking level changes what the provider keys on; a gap
 * past the cache lifetime lets the entry expire. `unknown` when none applies.
 */
export function attributeCacheMiss(
	previous: RequestFingerprint,
	current: RequestFingerprint,
	gapMs: number,
): CacheMissReason[] {
	const reasons: CacheMissReason[] = [];
	if (previous.provider !== current.provider || previous.model !== current.model) reasons.push("model");
	if (previous.promptDigest !== current.promptDigest) reasons.push("system-prompt");
	if (previous.toolsDigest !== current.toolsDigest) reasons.push("tools");
	if (current.rewritten) reasons.push("compaction");
	if (previous.thinking !== current.thinking) reasons.push("thinking");
	if (previous.ttlMs !== undefined && gapMs > previous.ttlMs) reasons.push("ttl");
	if (reasons.length === 0) reasons.push("unknown");
	return reasons;
}

const toolSchemaJson = new WeakMap<object, string>();

/** Digest of a tool list as the model sees it: order, names, descriptions and parameter schemas. */
export function digestTools(tools: readonly Pick<AgentTool, "name" | "description" | "parameters">[]): string {
	let hash = BigInt(tools.length);
	for (const tool of tools) {
		let schema = toolSchemaJson.get(tool.parameters);
		if (schema === undefined) {
			schema = JSON.stringify(tool.parameters) ?? "";
			toolSchemaJson.set(tool.parameters, schema);
		}
		hash = Bun.hash.wyhash(tool.name, hash);
		hash = Bun.hash.wyhash(tool.description, hash);
		hash = Bun.hash.wyhash(schema, hash);
	}
	return hash.toString(16);
}

/** Lifetime in ms of the tier the response wrote (short unless it reports a long write), when the model declares one. */
function responseCacheTtlMs(promptCache: PromptCacheSeconds | undefined, usage: Usage): number | undefined {
	const seconds = promptCache?.[observedPromptCacheTier(usage) ?? "short"];
	return seconds === undefined ? undefined : seconds * 1000;
}

function recordRate(message: AssistantMessage): number | undefined {
	const duration = message.duration;
	if (duration === undefined || !Number.isFinite(duration) || duration < MIN_RATE_DURATION_MS) return undefined;
	if (!Number.isFinite(message.usage.output) || message.usage.output <= 0) return undefined;
	return (message.usage.output * 1000) / duration;
}

type RecordListener = (record: RequestRecord) => void;

/**
 * Per-session ledger of model requests. The session calls {@link beginRequest}
 * just before each primary model call with what the request is built from,
 * {@link noteRewrite} when compaction or pruning rewrites history, and
 * {@link record} when the response settles. A settled request that read far less
 * cache than the previous one left behind is attributed to what changed between
 * the two fingerprints.
 */
export class RequestLedger {
	#records: RequestRecord[] = [];
	#listeners = new Set<RecordListener>();
	#pending: RequestFingerprint | undefined;
	#rewritten = false;
	#seq = 0;
	#lastFingerprint: RequestFingerprint | undefined;
	/** Last request that carried a prompt: the prefix the next one is measured against. */
	#baseline: { record: RequestRecord; usage: Usage; fingerprint: RequestFingerprint } | undefined;
	#requests = 0;
	#cacheRead = 0;
	#promptTokens = 0;
	#missCount = 0;
	#misses: CacheMiss[] = [];

	/** Records in request order, oldest first. */
	records(): readonly RequestRecord[] {
		return this.#records;
	}

	/** The most recent record, if any request settled. */
	latest(): RequestRecord | undefined {
		return this.#records.at(-1);
	}

	/** Called for every settled request, after it is recorded. Returns an unsubscribe. */
	subscribe(listener: RecordListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** History was compacted or pruned: the next request's prefix no longer matches the last one's. */
	noteRewrite(): void {
		this.#rewritten = true;
	}

	/**
	 * A different conversation took over the session (`/new`, a session switch): drop
	 * the records, totals, misses and the prefix the next request would be measured
	 * against. `seq` keeps counting so a listener keyed by it never sees a number twice;
	 * subscribers stay subscribed.
	 */
	reset(): void {
		this.#records = [];
		this.#pending = undefined;
		this.#rewritten = false;
		this.#lastFingerprint = undefined;
		this.#baseline = undefined;
		this.#requests = 0;
		this.#cacheRead = 0;
		this.#promptTokens = 0;
		this.#missCount = 0;
		this.#misses = [];
	}

	/** Captures what the next response was requested with. */
	beginRequest(fingerprint: Omit<RequestFingerprint, "rewritten" | "ttlMs">): void {
		this.#pending = { ...fingerprint, rewritten: this.#rewritten || this.#pending?.rewritten === true };
		this.#rewritten = false;
	}

	/** Records a settled assistant message as one request. Returns the record. */
	record(message: AssistantMessage, completedAt: number = Date.now()): RequestRecord {
		const usage = message.usage;
		const pending = this.#pending;
		const fingerprint: RequestFingerprint = {
			...(pending ??
				this.#lastFingerprint ?? { thinking: undefined, promptDigest: "", toolsDigest: "", rewritten: false }),
			provider: message.provider,
			model: message.model,
			rewritten: pending?.rewritten ?? false,
		};
		this.#pending = undefined;
		const promptTokens = promptTokensOf(usage);
		const record: RequestRecord = {
			seq: ++this.#seq,
			startedAt: message.timestamp,
			completedAt,
			provider: message.provider,
			model: message.model,
			thinking: fingerprint.thinking,
			serviceTier: message.serviceTier,
			responseId: message.responseId,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			promptTokens,
			hitPct: cacheHitPct(usage),
			costUsd: usage.cost.total,
			ttftMs: message.ttft,
			durationMs: message.duration,
			tokensPerSecond: recordRate(message),
		};
		if (promptTokens > 0) {
			fingerprint.ttlMs = responseCacheTtlMs(fingerprint.promptCache, usage);
			this.#requests++;
			this.#cacheRead += usage.cacheRead;
			this.#promptTokens += promptTokens;
			const baseline = this.#baseline;
			if (baseline) {
				const reprocessedTokens = cacheMissTokens(baseline.usage, usage);
				if (reprocessedTokens !== undefined) {
					const gapMs = message.timestamp - baseline.record.completedAt;
					const reasons = attributeCacheMiss(baseline.fingerprint, fingerprint, gapMs);
					record.miss = { reasons, reprocessedTokens };
					this.#missCount++;
					this.#misses.push({ at: record.startedAt, reasons, reprocessedTokens, model: record.model });
					if (this.#misses.length > MAX_MISSES) this.#misses.shift();
				}
			}
			this.#baseline = { record, usage, fingerprint };
		} else if (fingerprint.rewritten) {
			// A request that failed before carrying a prompt compared nothing: its successor still follows the rewrite.
			this.#rewritten = true;
		}
		this.#lastFingerprint = fingerprint;
		this.#records.push(record);
		if (this.#records.length > MAX_RECORDS) this.#records.shift();
		for (const listener of this.#listeners) listener(record);
		return record;
	}

	/** Session hit rate as a percentage over every request that carried a prompt; undefined before the first. */
	get hitPct(): number | undefined {
		return this.#promptTokens > 0 ? (this.#cacheRead / this.#promptTokens) * 100 : undefined;
	}

	/** Requests that carried prompt tokens. */
	get requests(): number {
		return this.#requests;
	}

	/** Cache misses seen this session. */
	get missCount(): number {
		return this.#missCount;
	}

	/** The most recent misses, oldest first. */
	misses(): readonly CacheMiss[] {
		return this.#misses;
	}

	/** Wire snapshot for the session state frame; undefined until a request carried a prompt. */
	snapshot(): SessionCacheStats | undefined {
		let last: RequestRecord | undefined;
		for (let index = this.#records.length - 1; index >= 0; index--) {
			const candidate = this.#records[index]!;
			if (candidate.promptTokens > 0) {
				last = candidate;
				break;
			}
		}
		if (!last) return undefined;
		const stat: CacheRequestStat = {
			at: last.startedAt,
			model: last.model,
			input: last.input,
			output: last.output,
			cacheRead: last.cacheRead,
			cacheWrite: last.cacheWrite,
			hitPct: last.hitPct,
			tokensPerSecond: last.tokensPerSecond,
			ttftMs: last.ttftMs,
			costUsd: last.costUsd,
		};
		return {
			last: stat,
			requests: this.#requests,
			hitPct: this.hitPct,
			misses: this.#missCount,
			recentMisses: this.#misses.slice(-SNAPSHOT_MISSES),
		};
	}
}
