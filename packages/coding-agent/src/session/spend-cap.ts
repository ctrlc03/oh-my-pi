/**
 * Hard per-session spend cap (`session.maxCostUsd` / `session.maxTokens`, `--max-cost` / `--max-tokens`,
 * `/budget`). Limits live in settings so a runtime override (CLI flag, `/budget`) takes effect on the next
 * check; `0` means no cap. Spend is the session's cumulative usage accounting, see
 * {@link SessionStatsTracker.getSpendUsage}.
 */
import type { Settings } from "../config/settings";
import { cfgSessionMaxCostUsd, cfgSessionMaxTokens } from "./settings";

/** `AgentSessionEvent` `notice` source of every spend-cap notice. */
export const SPEND_CAP_NOTICE_SOURCE = "budget";
/** Process exit status of a headless run that stopped on the cap (1 stays "failed", 2 "usage"). */
export const SPEND_CAP_EXIT_CODE = 3;
/** Fraction of a limit at which the first warning is shown. */
export const SPEND_CAP_WARNING_RATIO = 0.8;

export interface SpendUsage {
	costUsd: number;
	tokens: number;
}

/** Configured limits; `0` = not capped. */
export interface SpendCapLimits {
	maxCostUsd: number;
	maxTokens: number;
}

export type SpendCapLevel = "off" | "ok" | "warning" | "capped";

export interface SpendCapStatus extends SpendCapLimits, SpendUsage {
	level: SpendCapLevel;
}

/** Classifies `usage` against `limits`: the most advanced of the active limits decides the level. */
export function evaluateSpendCap(limits: SpendCapLimits, usage: SpendUsage): SpendCapStatus {
	const ratios: number[] = [];
	if (limits.maxCostUsd > 0) ratios.push(usage.costUsd / limits.maxCostUsd);
	if (limits.maxTokens > 0) ratios.push(usage.tokens / limits.maxTokens);
	let level: SpendCapLevel = "off";
	if (ratios.length > 0) {
		const highest = Math.max(...ratios);
		level = highest >= 1 ? "capped" : highest >= SPEND_CAP_WARNING_RATIO ? "warning" : "ok";
	}
	return { ...limits, ...usage, level };
}

function formatUsd(value: number): string {
	return `$${value >= 0.01 || value === 0 ? value.toFixed(2) : value.toFixed(4)}`;
}

/** One-line `spent of cap` description of every active limit. */
export function describeSpend(status: SpendCapStatus): string {
	const parts: string[] = [];
	if (status.maxCostUsd > 0) parts.push(`${formatUsd(status.costUsd)} of ${formatUsd(status.maxCostUsd)}`);
	if (status.maxTokens > 0) {
		parts.push(`${status.tokens.toLocaleString("en-US")} of ${status.maxTokens.toLocaleString("en-US")} tokens`);
	}
	return parts.join(", ");
}

export function formatSpendCapReached(status: SpendCapStatus): string {
	return `Spend cap reached (${describeSpend(status)}). Stopped at a safe point; new prompts are refused until the cap is raised (/budget <usd>) or cleared (/budget off).`;
}

/** Thrown by `AgentSession.prompt` while the session is at its cap. */
export class SpendCapExceededError extends Error {
	readonly status: SpendCapStatus;

	constructor(status: SpendCapStatus) {
		super(formatSpendCapReached(status));
		this.name = "SpendCapExceededError";
		this.status = status;
	}
}

/** `/budget` status line. */
export function formatBudgetStatus(status: SpendCapStatus): string {
	if (status.level === "off") return "No spend cap. Set one with /budget <usd> (or /budget tokens <n>).";
	return `Spend ${describeSpend(status)}${status.level === "capped" ? " (cap reached)" : ""}.`;
}

export type SpendCapNoticeLevel = "info" | "warning" | "error";

export interface SpendCapHost {
	settings: Settings;
	/** Cumulative spend; only read while a limit is configured. */
	readSpend(): SpendUsage;
	emitNotice(level: SpendCapNoticeLevel, message: string, source: string): void;
}

/** Evaluates the cap for one session and announces threshold crossings once each. */
export class SpendCapController {
	readonly #host: SpendCapHost;
	/** Subagents spend through their parent's `task` call; only the owning session enforces. */
	readonly #enforced: boolean;
	#level: SpendCapLevel = "off";

	constructor(host: SpendCapHost, enforced: boolean) {
		this.#host = host;
		this.#enforced = enforced;
	}

	limits(): SpendCapLimits {
		return {
			maxCostUsd: cfgSessionMaxCostUsd.get(this.#host.settings),
			maxTokens: cfgSessionMaxTokens.get(this.#host.settings),
		};
	}

	status(): SpendCapStatus {
		const limits = this.#enforced ? this.limits() : { maxCostUsd: 0, maxTokens: 0 };
		const capped = limits.maxCostUsd > 0 || limits.maxTokens > 0;
		return evaluateSpendCap(limits, capped ? this.#host.readSpend() : { costUsd: 0, tokens: 0 });
	}

	/** The agent loop's boundary stop predicate: true from the first check at or past a limit. */
	shouldStop(): boolean {
		return this.status().level === "capped";
	}

	/** @throws SpendCapExceededError when the session is at its cap. */
	assertCanPrompt(): void {
		const status = this.status();
		if (status.level === "capped") throw new SpendCapExceededError(status);
	}

	/** Announces the 80% warning and the cap once per crossing; call after each completed turn. */
	onTurnEnd(): void {
		this.#announce(this.status());
	}

	/**
	 * Replaces limits for this session only (runtime override, never persisted) and reports the result;
	 * `undefined` leaves a limit unchanged, `0` clears it.
	 */
	setLimits(next: Partial<SpendCapLimits>): SpendCapStatus {
		if (next.maxCostUsd !== undefined) cfgSessionMaxCostUsd.override(this.#host.settings, next.maxCostUsd);
		if (next.maxTokens !== undefined) cfgSessionMaxTokens.override(this.#host.settings, next.maxTokens);
		const status = this.status();
		this.#level = status.level;
		this.#host.emitNotice(
			"info",
			status.level === "off" ? "Spend cap cleared." : `Spend cap set: ${describeSpend(status)}.`,
			SPEND_CAP_NOTICE_SOURCE,
		);
		return status;
	}

	#announce(status: SpendCapStatus): void {
		const previous = this.#level;
		this.#level = status.level;
		if (status.level === previous) return;
		if (status.level === "capped") {
			this.#host.emitNotice("error", formatSpendCapReached(status), SPEND_CAP_NOTICE_SOURCE);
		} else if (status.level === "warning" && previous !== "capped") {
			this.#host.emitNotice(
				"warning",
				`Approaching the spend cap (${describeSpend(status)}).`,
				SPEND_CAP_NOTICE_SOURCE,
			);
		}
	}
}
