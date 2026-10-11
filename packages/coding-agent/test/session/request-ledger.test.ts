import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { CacheMissReason } from "@oh-my-pi/pi-wire";
import { formatCacheReport } from "../../src/session/cache-report";
import { digestTools, type RequestFingerprint, RequestLedger } from "../../src/session/request-ledger";

const FINGERPRINT: Omit<RequestFingerprint, "rewritten" | "ttlMs"> = {
	provider: "anthropic",
	model: "claude-a",
	thinking: "medium",
	promptDigest: "p1",
	toolsDigest: "t1",
	promptCache: { short: 300, long: 3600 },
};

function usage(parts: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	};
}

function message(at: number, parts: Parameters<typeof usage>[0], overrides: Partial<AssistantMessage> = {}) {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-a",
		usage: usage(parts),
		stopReason: "stop",
		timestamp: at,
		...overrides,
	} as AssistantMessage;
}

/** Two requests; the first warms the cache, the second changes `change` and reads nothing back. */
function missAfter(
	change: Partial<Omit<RequestFingerprint, "rewritten" | "ttlMs">>,
	options: { rewrite?: boolean; gapMs?: number } = {},
): CacheMissReason[] | undefined {
	const ledger = new RequestLedger();
	ledger.beginRequest(FINGERPRINT);
	ledger.record(message(1_000, { cacheRead: 40_000, cacheWrite: 1_000, input: 10 }), 2_000);
	if (options.rewrite) ledger.noteRewrite();
	ledger.beginRequest({ ...FINGERPRINT, ...change });
	const at = 2_000 + (options.gapMs ?? 1_000);
	const record = ledger.record(
		message(
			at,
			{ cacheRead: 0, cacheWrite: 41_000, input: 20 },
			{ provider: change.provider ?? FINGERPRINT.provider, model: change.model ?? FINGERPRINT.model },
		),
		at + 500,
	);
	return record.miss?.reasons;
}

describe("RequestLedger miss attribution", () => {
	it("attributes a model change", () => {
		expect(missAfter({ model: "claude-b" })).toEqual(["model"]);
	});

	it("attributes a provider change", () => {
		expect(missAfter({ provider: "bedrock" })).toEqual(["model"]);
	});

	it("attributes a system prompt change", () => {
		expect(missAfter({ promptDigest: "p2" })).toEqual(["system-prompt"]);
	});

	it("attributes a tool list change", () => {
		expect(missAfter({ toolsDigest: "t2" })).toEqual(["tools"]);
	});

	it("attributes a compaction or prune", () => {
		expect(missAfter({}, { rewrite: true })).toEqual(["compaction"]);
	});

	it("attributes a thinking level change", () => {
		expect(missAfter({ thinking: "high" })).toEqual(["thinking"]);
	});

	it("attributes an idle gap past the cache lifetime", () => {
		expect(missAfter({}, { gapMs: 301_000 })).toEqual(["ttl"]);
	});

	it("does not call a gap inside the lifetime a TTL miss", () => {
		expect(missAfter({}, { gapMs: 299_000 })).toEqual(["unknown"]);
	});

	it("reports unknown when nothing changed", () => {
		expect(missAfter({})).toEqual(["unknown"]);
	});

	it("lists every cause that applied, most likely first", () => {
		expect(missAfter({ promptDigest: "p2", thinking: "high" }, { gapMs: 400_000 })).toEqual([
			"system-prompt",
			"thinking",
			"ttl",
		]);
	});

	it("reads the lifetime of the tier the earlier response wrote", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		const first = message(1_000, { cacheWrite: 41_000, input: 10 });
		first.usage.cttl = { ephemeral1h: 41_000 };
		ledger.record(first, 2_000);
		ledger.beginRequest(FINGERPRINT);
		const record = ledger.record(message(2_000 + 400_000, { cacheWrite: 41_000, input: 10 }), 500_000);
		expect(record.miss?.reasons).toEqual(["unknown"]);
	});

	it("carries a rewrite through a request that failed before sending a prompt", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, { cacheRead: 40_000, cacheWrite: 1_000 }), 2_000);
		ledger.noteRewrite();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(3_000, {}, { stopReason: "error", errorMessage: "boom" }), 3_100);
		ledger.beginRequest(FINGERPRINT);
		const record = ledger.record(message(4_000, { cacheWrite: 41_000, input: 20 }), 5_000);
		expect(record.miss?.reasons).toEqual(["compaction"]);
	});
});

describe("RequestLedger reset", () => {
	it("forgets the totals, misses and the prefix the next request is measured against", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, { cacheRead: 40_000, cacheWrite: 1_000 }), 1_500);
		ledger.noteRewrite();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(2_000, { cacheWrite: 41_000, input: 20 }), 2_500);
		expect(ledger.missCount).toBe(1);
		const lastSeq = ledger.latest()?.seq ?? 0;

		ledger.reset();
		expect(ledger.records()).toHaveLength(0);
		expect(ledger.missCount).toBe(0);
		expect(ledger.requests).toBe(0);
		expect(ledger.hitPct).toBeUndefined();
		expect(ledger.snapshot()).toBeUndefined();

		// A cold first request of the new conversation is not a miss against the old one's warm prefix.
		ledger.beginRequest({ ...FINGERPRINT, promptDigest: "other" });
		const first = ledger.record(message(3_000, { cacheWrite: 41_000, input: 20 }), 3_500);
		expect(first.miss).toBeUndefined();
		expect(first.seq).toBeGreaterThan(lastSeq);
	});

	it("keeps subscribers across a reset", () => {
		const ledger = new RequestLedger();
		const seen: number[] = [];
		ledger.subscribe(record => seen.push(record.seq));
		ledger.reset();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, { input: 10 }), 1_100);
		expect(seen).toHaveLength(1);
	});
});

describe("RequestLedger miss detection", () => {
	function second(first: Parameters<typeof usage>[0], next: Parameters<typeof usage>[0]) {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, first), 1_500);
		ledger.beginRequest(FINGERPRINT);
		return ledger.record(message(2_000, next), 2_500);
	}

	it("flags a prefix broken part-way down", () => {
		const record = second(
			{ cacheRead: 40_000, cacheWrite: 1_000 },
			{ cacheRead: 10_000, cacheWrite: 31_000, input: 5 },
		);
		expect(record.miss?.reprocessedTokens).toBe(31_005);
	});

	it("flags a cache that expired after only being written", () => {
		const record = second({ cacheWrite: 41_000, input: 10 }, { cacheWrite: 41_000, input: 10 });
		expect(record.miss).toBeDefined();
	});

	it("flags an implicit cache that dropped to a trickle (DeepSeek: miss lives in input)", () => {
		const record = second({ cacheRead: 30_000, input: 2_000 }, { cacheRead: 1_000, input: 33_000 });
		expect(record.miss?.reprocessedTokens).toBe(33_000);
	});

	it("does not flag a request that kept most of the prefix", () => {
		expect(
			second({ cacheRead: 40_000, cacheWrite: 1_000 }, { cacheRead: 41_000, cacheWrite: 500 }).miss,
		).toBeUndefined();
	});

	it("does not flag a small prompt", () => {
		expect(second({ cacheRead: 1_000, input: 100 }, { input: 1_200 }).miss).toBeUndefined();
	});

	it("does not flag the first request", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		expect(ledger.record(message(1_000, { cacheWrite: 41_000, input: 10 }), 2_000).miss).toBeUndefined();
	});
});

describe("RequestLedger hit rate", () => {
	it("computes a request's hit share over every prompt token", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		const record = ledger.record(message(1_000, { cacheRead: 600, cacheWrite: 300, input: 100 }), 2_000);
		expect(record.hitPct).toBeCloseTo(60);
		expect(record.promptTokens).toBe(1_000);
	});

	it("weights the session rate by tokens, not by request", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, { cacheRead: 0, cacheWrite: 1_000 }), 1_100);
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(2_000, { cacheRead: 9_000, cacheWrite: 1_000 }), 2_100);
		// 9_000 read over 11_000 prompt tokens; a mean of the two percentages would say 45%.
		expect(ledger.hitPct).toBeCloseTo((9_000 / 11_000) * 100);
		expect(ledger.requests).toBe(2);
	});

	it("leaves requests without a prompt out of the rate", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, { cacheRead: 500, input: 500 }), 1_100);
		ledger.beginRequest(FINGERPRINT);
		const failed = ledger.record(message(2_000, {}, { stopReason: "error" }), 2_100);
		expect(failed.hitPct).toBeUndefined();
		expect(ledger.hitPct).toBeCloseTo(50);
		expect(ledger.requests).toBe(1);
		expect(ledger.records()).toHaveLength(2);
	});

	it("derives output rate and carries timing", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		const record = ledger.record(message(1_000, { input: 100, output: 200 }, { duration: 4_000, ttft: 350 }), 6_000);
		expect(record.tokensPerSecond).toBeCloseTo(50);
		expect(record.ttftMs).toBe(350);
		expect(record.costUsd).toBeCloseTo(0.01);
	});

	it("has no snapshot until a request carried a prompt", () => {
		expect(new RequestLedger().snapshot()).toBeUndefined();
	});
});

describe("cache report", () => {
	it("lists the cause of each miss", () => {
		const ledger = new RequestLedger();
		ledger.beginRequest(FINGERPRINT);
		ledger.record(message(1_000, { cacheRead: 40_000, cacheWrite: 1_000 }), 1_500);
		ledger.beginRequest({ ...FINGERPRINT, promptDigest: "p2" });
		ledger.record(message(2_000, { cacheWrite: 41_000, input: 20 }), 2_500);
		const report = formatCacheReport(ledger, 12_000);
		expect(report).toContain("system prompt changed");
		expect(report).toContain("1 miss");
	});
});

describe("digestTools", () => {
	const tool = (description: string, parameters: object = {}) => ({ name: "read", description, parameters }) as never;

	it("changes when a description or schema changes, not when nothing does", () => {
		const base = digestTools([tool("reads")]);
		expect(digestTools([tool("reads")])).toBe(base);
		expect(digestTools([tool("reads more")])).not.toBe(base);
		expect(digestTools([tool("reads", { type: "object" })])).not.toBe(base);
	});
});
