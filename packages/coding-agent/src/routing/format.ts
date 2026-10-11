/** Text for routing: the per-turn notice, the usage-row label, and the `/route` report. */
import type { RouteDecision } from "./router";

/** Where `routing.mode` was last decided. */
export type RouteModeSource = "settings" | "session";

export interface RouteTierStatus {
	label: string;
	when: string;
	/** `provider/id` the tier serves now; absent when no credentialed, healthy model resolves for it. */
	model?: string;
}

export interface RouteStatus {
	enabled: boolean;
	source: RouteModeSource;
	classifier: string;
	stickiness: number;
	tiers: readonly RouteTierStatus[];
	held: { tier: string; turns: number } | undefined;
	decisions: readonly RouteDecision[];
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** `smol → anthropic/claude-haiku-4-5 · low`, plus why a held choice differs from the classifier's. */
export function formatRouteNotice(decision: RouteDecision): string {
	if (decision.status === "skipped") return `prompt kept on the session model: ${decision.reason ?? "not routed"}`;
	const thinking = decision.thinkingLevel === undefined ? "" : ` · thinking ${decision.thinkingLevel}`;
	let text = `${decision.tier} → ${decision.model}${thinking}`;
	if (decision.classified !== undefined) {
		const left = decision.holdTurnsLeft ?? 0;
		const until = left > 0 ? `held for ${plural(left, "more turn")}` : "may move down next turn";
		text += ` · classifier chose ${decision.classified}; ${until} (routing.stickiness)`;
	}
	return text;
}

/** Short tag for a turn's usage row; undefined when the turn was not routed. */
export function formatRouteLabel(decision: RouteDecision | undefined): string | undefined {
	return decision?.status === "routed" ? `route ${decision.tier}` : undefined;
}

function clock(ms: number): string {
	return new Date(ms).toTimeString().slice(0, 8);
}

/** The `/route` report. */
export function formatRouteStatus(status: RouteStatus): string {
	const mode = status.enabled ? "auto" : "off";
	const lines = [
		`Routing: ${mode}${status.source === "session" ? " (set for this session with /route)" : " (routing.mode)"}`,
		`Classifier role: ${status.classifier} · stickiness: ${plural(status.stickiness, "turn")}`,
		"Tiers, cheapest to strongest:",
	];
	for (const tier of status.tiers) {
		lines.push(`  ${tier.label} → ${tier.model ?? "unavailable (no credentialed model)"} — ${tier.when}`);
	}
	if (status.held) lines.push(`Held: ${status.held.tier}, ${plural(status.held.turns, "turn")} so far`);
	if (status.decisions.length === 0) {
		lines.push("No routing decisions yet this session.");
		return lines.join("\n");
	}
	lines.push("Recent decisions:");
	for (const decision of status.decisions) {
		const prompt = JSON.stringify(decision.prompt);
		lines.push(`  ${clock(decision.at)} ${formatRouteNotice(decision)} — ${prompt}`);
	}
	return lines.join("\n");
}
