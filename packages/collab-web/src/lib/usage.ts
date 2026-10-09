/** Token and cost totals summed from assistant message usage across a transcript. */

import type { SessionEntry, WireUsage } from "@oh-my-pi/pi-wire";
import { fmtCost, fmtTokens } from "./format";

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SessionUsage {
	total: UsageTotals;
	/** Usage of the newest assistant message that reported any; null when none did. */
	last: UsageTotals | null;
}

const num = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Aborted or errored turns, and older hosts, may carry no usage at all. */
function usageOf(usage: Partial<WireUsage> | undefined): UsageTotals | null {
	if (usage === undefined || usage === null) return null;
	return {
		input: num(usage.input),
		output: num(usage.output),
		cacheRead: num(usage.cacheRead),
		cacheWrite: num(usage.cacheWrite),
		cost: num(usage.cost?.total),
	};
}

/** Sums assistant `usage` across `entries`; null when no entry reported usage. */
export function sumUsage(entries: readonly SessionEntry[]): SessionUsage | null {
	const total: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let last: UsageTotals | null = null;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = usageOf(entry.message.usage);
		if (usage === null) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		last = usage;
	}
	return last === null ? null : { total, last };
}

/** "$1.24 · 812k in · 34k out". */
export function formatUsage(usage: UsageTotals): string {
	return `${fmtCost(usage.cost)} · ${fmtTokens(usage.input)} in · ${fmtTokens(usage.output)} out`;
}
