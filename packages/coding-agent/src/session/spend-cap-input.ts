/** Parsers for user-typed spend-cap values (`--max-cost`, `--max-tokens`, `/budget`). Dependency-free: CLI parsing imports it. */

/** A positive USD amount such as `2.5` or `$2.50`; `undefined` for anything else. */
export function parseUsdAmount(text: string): number | undefined {
	const usd = Number(text.trim().replace(/^\$/, ""));
	return Number.isFinite(usd) && usd > 0 ? usd : undefined;
}

const TOKEN_COUNT_RE = /^(\d+(?:\.\d+)?)([km]?)$/i;

/** A positive token count such as `200000`, `200k`, or `1.5m`; `undefined` for anything else. */
export function parseTokenCount(text: string): number | undefined {
	const match = TOKEN_COUNT_RE.exec(text.trim());
	if (!match) return undefined;
	const unit = match[2].toLowerCase();
	const tokens = Math.floor(Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
	return tokens > 0 ? tokens : undefined;
}

export const BUDGET_USAGE = "Usage: /budget [<usd>|off] | /budget tokens <n|off>";

export type BudgetCommand =
	| { action: "status" }
	| { action: "set"; maxCostUsd?: number; maxTokens?: number }
	| { action: "error"; message: string };

/** Parses `/budget` arguments: nothing shows the cap, `<usd>` sets it, `off` clears both limits, `tokens <n|off>` sets the token cap. */
export function parseBudgetArgs(args: string): BudgetCommand {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return { action: "status" };
	const first = words[0].toLowerCase();
	if (words.length === 1) {
		if (first === "off") return { action: "set", maxCostUsd: 0, maxTokens: 0 };
		const usd = parseUsdAmount(first);
		if (usd !== undefined) return { action: "set", maxCostUsd: usd };
	} else if (words.length === 2 && first === "tokens") {
		if (words[1].toLowerCase() === "off") return { action: "set", maxTokens: 0 };
		const tokens = parseTokenCount(words[1]);
		if (tokens !== undefined) return { action: "set", maxTokens: tokens };
	}
	return { action: "error", message: BUDGET_USAGE };
}
