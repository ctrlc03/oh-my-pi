import type { AgentSession } from "../../session/agent-session";
import { type ContextPruneResult, selectContextItems } from "../../session/context-items";
import { CONTEXT_ITEM_ROWS, computeSessionContextBreakdown } from "../../session/context-usage-runtime";
import type { SlashCommandRuntime } from "../types";
import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";

export const CONTEXT_USAGE = "Usage: /context [prune [<rank>[,<rank>…]]]";

export type ContextCommandArgs = { action: "show" } | { action: "prune"; selectors: string[] } | { error: string };

/**
 * Parse `/context` arguments. `prune` with no ranks means "pick interactively"
 * (TUI) and yields an empty selector list; ranks are the 1-based numbers the
 * report prints, ids (`tr:<entry>`) are accepted for scripted callers.
 */
export function parseContextArgs(args: string): ContextCommandArgs {
	const tokens = args
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	if (tokens.length === 0) return { action: "show" };
	if (tokens[0]!.toLowerCase() !== "prune") return { error: CONTEXT_USAGE };
	const selectors = tokens.slice(1);
	if (selectors.some(selector => !/^\d+$/.test(selector) && !selector.includes(":"))) return { error: CONTEXT_USAGE };
	return { action: "prune", selectors };
}

/** One-line operator summary of a prune. */
export function formatContextPruneSummary(result: ContextPruneResult): string {
	if (result.entriesRewritten === 0) return "Nothing to prune.";
	const entries = `${result.entriesRewritten} entr${result.entriesRewritten === 1 ? "y" : "ies"}`;
	return `Pruned ${entries} (~${result.tokensFreed} tokens freed).`;
}

/** Result of {@link pruneContextSelectors}; `ok: false` carries a user-facing reason. */
export interface ContextPruneOutcome {
	ok: boolean;
	text: string;
}

/** Prune the ranked items named by `selectors`. */
export async function pruneContextSelectors(
	session: AgentSession,
	selectors: readonly string[],
): Promise<ContextPruneOutcome> {
	if (session.isBusyForSnapshot) {
		return { ok: false, text: "Cannot prune the context while a response or command is still running." };
	}
	const items = session.getContextItems();
	const { selected, missing } = selectContextItems(items, selectors);
	if (missing.length > 0) {
		return { ok: false, text: `No context item ${missing.join(", ")}. Run /context to list the current items.` };
	}
	const fixed = selected.filter(item => item.targets.length === 0);
	if (fixed.length > 0) {
		return { ok: false, text: `Cannot prune: ${fixed.map(item => item.label).join(", ")}.` };
	}
	if (selected.length === 0) return { ok: false, text: CONTEXT_USAGE };
	return { ok: true, text: formatContextPruneSummary(await session.pruneContextItems(selected)) };
}

/**
 * Build the `/context` ACP-mode text. Tries the rich breakdown first
 * (categories + auto-compact buffer + free slack) and falls back to the
 * minimal "window/used" lines when the breakdown helper throws.
 */
export function buildContextReportText(runtime: SlashCommandRuntime): string {
	try {
		const breakdown = computeSessionContextBreakdown(runtime.session, {
			snapcompactSavings: true,
			items: CONTEXT_ITEM_ROWS,
		});
		if (breakdown.contextWindow <= 0) {
			return "Context usage is unavailable: no model is selected for this session.";
		}
		const usedPct = Math.round((breakdown.usedTokens / breakdown.contextWindow) * 100);
		const lines = [`Context window: ${breakdown.contextWindow} tokens (${usedPct}% used)`];
		for (const category of breakdown.categories) {
			if (category.tokens === 0) continue;
			const fraction = category.tokens / breakdown.contextWindow;
			lines.push(`  ${category.label.padEnd(16)} ${renderAsciiBar(fraction)}  ${category.tokens} tokens`);
		}
		if (breakdown.autoCompactBufferTokens > 0) {
			const fraction = breakdown.autoCompactBufferTokens / breakdown.contextWindow;
			lines.push(
				`  ${"Auto-compact buf".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.autoCompactBufferTokens} tokens`,
			);
		}
		if (breakdown.freeTokens > 0) {
			const fraction = breakdown.freeTokens / breakdown.contextWindow;
			lines.push(`  ${"Free".padEnd(16)} ${renderAsciiBar(fraction)}  ${breakdown.freeTokens} tokens`);
		}
		if (breakdown.items && breakdown.items.length > 0) {
			lines.push("What fills the context:");
			for (const item of breakdown.items) {
				const share = (item.share * 100).toFixed(1);
				lines.push(
					`  ${String(item.rank).padStart(2)}. ${item.label}  ${item.tokens} tokens (${share}%)${item.prunable ? "" : "  fixed"}`,
				);
			}
			lines.push("Prune an item with /context prune <rank>.");
		}
		const snap = breakdown.snapcompact;
		if (snap) {
			if (!snap.visionCapable) {
				lines.push("Snapcompact: inactive (model has no image input)");
			} else {
				lines.push("Snapcompact (estimated wire savings):");
				if (snap.systemPrompt) {
					const sp = snap.systemPrompt;
					lines.push(
						sp.applied
							? `  System prompt: ${sp.textTokens} text tokens → ${sp.frames} frame${sp.frames === 1 ? "" : "s"} ≈ ${sp.imageTokens} tokens (saves ~${sp.savedTokens})`
							: "  System prompt: stays text (no net savings)",
					);
				}
				if (snap.toolResults) {
					const tr = snap.toolResults;
					lines.push(
						tr.swapped > 0
							? `  Tool results: ${tr.swapped} of ${tr.total} imaged, ${tr.textTokens} text tokens → ${tr.frames} frames ≈ ${tr.imageTokens} tokens (saves ~${tr.savedTokens})`
							: `  Tool results: none imaged (${tr.total} in history)`,
					);
				}
				if (snap.savedTokens > 0) {
					lines.push(`  Estimated next request: ~${breakdown.usedTokens - snap.savedTokens} tokens on the wire`);
				}
			}
		}
		return lines.join("\n");
	} catch {
		const fallback = runtime.session.getContextUsage();
		if (!fallback) return "Context usage is unavailable.";
		return ["Context", `Window: ${fallback.contextWindow}`, `Used: ${fallback.tokens ?? 0}`].join("\n");
	}
}
