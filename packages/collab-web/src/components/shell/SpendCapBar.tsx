import type { SessionSpend } from "@oh-my-pi/pi-wire";
import { Gauge } from "lucide-react";
import type { ReactNode } from "react";
import "./spend-cap.css";

export interface SpendCapBarProps {
	/** The host's spend against its cap; absent while no cap is set or when the host predates feature `spend-cap`. */
	spend: SessionSpend | undefined;
}

const usd = (value: number): string => `$${value.toFixed(value >= 0.01 ? 2 : 4)}`;

/** What was spent against each limit the host set, e.g. "$0.0123 of $0.01 · 4,200 of 4,000 tokens". */
function describe(spend: SessionSpend): string {
	const parts: string[] = [];
	if (spend.maxCostUsd !== undefined) parts.push(`${usd(spend.costUsd)} of ${usd(spend.maxCostUsd)}`);
	if (spend.maxTokens !== undefined) {
		parts.push(`${spend.tokens.toLocaleString("en")} of ${spend.maxTokens.toLocaleString("en")} tokens`);
	}
	return parts.join(" · ");
}

/** Shown while the host's session sits at its spend cap: it stopped at a safe point and refuses new prompts. */
export function SpendCapBar({ spend }: SpendCapBarProps): ReactNode {
	if (spend === undefined || !spend.capped) return null;
	return (
		<div className="sh-spendcap-bar" role="status">
			<Gauge size={14} />
			<span className="sh-spendcap-msg">{`Spend cap reached: ${describe(spend)}`}</span>
			<span className="sh-spendcap-hint">Raise it on the host with /budget</span>
		</div>
	);
}
