/**
 * Routing tiers: the ordered `routing.tiers` list a classifier chooses from, and how a tier resolves to a
 * live model. The list runs from the cheapest tier to the strongest; the classifier is told to take the
 * cheaper tier when torn, and the router's stickiness rule orders choices by list position.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting, resolveModelOverride, resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import type { Settings } from "../config/settings";

/** One `routing.tiers` entry: a model role or a model selector, and when the classifier should pick it. */
export interface RoutingTier {
	/** Model role (`smol`, `default`, `slow`, or a custom one). `default` is the session's own model. */
	role?: string;
	/** Model selector (`provider/id`, a pattern, optionally `:level`); instead of `role`. */
	model?: string;
	/** What kind of prompt belongs on this tier; shown to the classifier. */
	when: string;
	/** Name shown in notices; defaults to the role, then the model selector. */
	name?: string;
}

export const DEFAULT_ROUTING_TIERS: readonly RoutingTier[] = [
	{
		role: "smol",
		when: "Trivial: a quick question, a lookup, explaining a snippet, or a one-line mechanical edit.",
	},
	{
		role: "default",
		when: "Normal coding work: a bug fix, a feature in a known area, or a refactor of a few files.",
	},
	{
		role: "slow",
		when: "Hard: architecture or design, a large cross-cutting refactor, a subtle concurrency or data-loss problem, or an unknown cause.",
	},
];

function nonBlank(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** Rejects a malformed `routing.tiers` value with a descriptive error. */
export function validateRoutingTiers(raw: unknown): void {
	if (raw === undefined) return;
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error("routing.tiers must be a non-empty list of { role | model, when } entries");
	}
	raw.forEach((entry, index) => {
		const at = `routing.tiers[${index}]`;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`${at} must be an object with a role or model and a when description`);
		}
		const { role, model, when, name } = entry as Record<string, unknown>;
		if (nonBlank(role) === nonBlank(model)) {
			throw new Error(`${at} needs exactly one of role or model`);
		}
		if (role !== undefined && !nonBlank(role)) throw new Error(`${at}.role must be a non-empty string`);
		if (model !== undefined && !nonBlank(model)) throw new Error(`${at}.model must be a non-empty string`);
		if (!nonBlank(when)) throw new Error(`${at}.when must describe which prompts use this tier`);
		if (name !== undefined && !nonBlank(name)) throw new Error(`${at}.name must be a non-empty string`);
	});
}

/** A tier with the unique label the classifier answers with. */
export interface LabeledTier {
	label: string;
	tier: RoutingTier;
}

/** Unique, single-token labels (the classifier answers with one): the tier's name, role, or `model-<n>`. */
export function labelTiers(tiers: readonly RoutingTier[]): LabeledTier[] {
	const used = new Set<string>();
	return tiers.map((tier, index) => {
		const base =
			(tier.name ?? tier.role ?? `model-${index + 1}`)
				.trim()
				.replace(/[^A-Za-z0-9_.-]+/g, "-")
				.replace(/^-+|-+$/g, "") || `tier-${index + 1}`;
		let label = base;
		for (let suffix = 2; used.has(label); suffix++) label = `${base}-${suffix}`;
		used.add(label);
		return { label, tier };
	});
}

/** A tier whose model resolved, credentialed and not cooling down after a failure. */
export interface ResolvedTier extends LabeledTier {
	/** Position in `routing.tiers`; higher is stronger. */
	index: number;
	model: Model;
	/** Thinking level the tier's own selector pins (`model: "p/id:high"`); beats the classifier's. */
	pinnedThinking?: ConfiguredThinkingLevel;
}

export interface TierResolveContext {
	settings: Settings;
	registry: ModelRegistry;
	/** The model the session runs on without routing; what the `default` role tier means. */
	baseline: Model | undefined;
}

/**
 * Resolve the tiers that can serve a prompt right now. A role tier walks the role's candidates in
 * fallback-chain order (`retry.fallbackChains`, then the built-in priority list) and takes the first one that
 * is credentialed and not suppressed by a recent failure, so a role whose primary is down routes to its
 * fallback exactly as a retry would. Tiers whose model cannot be resolved are dropped.
 */
export function resolveTiers(tiers: readonly RoutingTier[], context: TierResolveContext): ResolvedTier[] {
	const { settings, registry, baseline } = context;
	const resolved: ResolvedTier[] = [];
	labelTiers(tiers).forEach((labeled, index) => {
		const { tier } = labeled;
		if (tier.model) {
			const found = resolveModelOverride([tier.model.trim()], registry, settings);
			if (!found.model || registry.isSelectorSuppressed(formatModelStringWithRouting(found.model))) return;
			resolved.push({
				...labeled,
				index,
				model: found.model,
				...(found.explicitThinkingLevel && found.thinkingLevel !== undefined
					? { pinnedThinking: found.thinkingLevel }
					: {}),
			});
			return;
		}
		const role = tier.role?.trim();
		if (!role) return;
		if (role === "default") {
			if (baseline) resolved.push({ ...labeled, index, model: baseline });
			return;
		}
		const candidates = resolveRoleChain(role, settings, roleCandidatePool(role, settings, registry));
		const pick = candidates.find(
			candidate => !registry.isSelectorSuppressed(formatModelStringWithRouting(candidate.model)),
		);
		if (!pick) return;
		resolved.push({
			...labeled,
			index,
			model: pick.model,
			...(pick.thinkingLevel !== undefined ? { pinnedThinking: pick.thinkingLevel } : {}),
		});
	});
	return resolved;
}
