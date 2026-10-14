/**
 * What each metric of a bake-off means, in plain words, for the reviewer and the judge: a definition and five score
 * levels per preset, and the person's own words for a custom one. Both read the same text, so "simplicity" means the
 * same to every party. See docs/design-review.md.
 */

import type { BakeoffMetric, BakeoffPreset } from "@oh-my-pi/pi-wire/bakeoff";

/** Levels 1 (worst) to 5 (best), as the reviewer scores and as the judge's `score` question lists them. */
export type Levels = readonly [string, string, string, string, string];

export interface MetricDefinition {
	/** What the metric asks, one or two sentences. */
	definition: string;
	/** The five levels, lowest first. */
	levels: Levels;
}

export const PRESET_DEFINITIONS: Record<BakeoffPreset, MetricDefinition> = {
	simplicity: {
		definition:
			"How easy the solution is to read and reason about: few special cases, one obvious way things flow, names that say what things are. Not how short it is, and not how clever.",
		levels: [
			"Much harder to follow than a typical solution: many special cases or tangled flow",
			"Harder to follow than typical",
			"About as easy to follow as a typical solution",
			"Easier to follow than typical",
			"Much easier to follow than a typical solution: one clear flow, almost no special cases",
		],
	},
	performance: {
		definition:
			"How fast it runs and how little it uses (time, memory, round trips, work repeated for no reason) on the paths that matter, judged from the code.",
		levels: [
			"Much worse than a typical solution: wasteful work on a hot path",
			"Worse than typical",
			"About as fast and light as a typical solution",
			"Better than typical",
			"Much better than a typical solution: avoids work a typical solution does",
		],
	},
	"fewer-parts": {
		definition:
			"How few new moving parts it adds: new files, modules, services, settings, dependencies, background jobs, concepts to learn. Fewer is better.",
		levels: [
			"Many more new parts than a typical solution",
			"More new parts than typical",
			"About as many new parts as a typical solution",
			"Fewer new parts than typical",
			"Far fewer new parts than a typical solution: it reuses what is already there",
		],
	},
	"migration-risk": {
		definition:
			"How safe it is to roll out and to undo: what breaks for existing data, callers and deployments in flight, whether old and new can run side by side, and what the rollback is.",
		levels: [
			"Much riskier than a typical solution: breaks data or callers with no way back",
			"Riskier than typical",
			"About as risky as a typical solution",
			"Safer than typical",
			"Much safer than a typical solution: compatible with what exists and easy to roll back",
		],
	},
	"lines-changed": {
		definition: "How small the change is, measured from the diff alone.",
		levels: ["Far larger diff", "Larger diff", "Typical diff", "Smaller diff", "Far smaller diff"],
	},
};

/** The definition of `metric`: a preset's own text, or the person's words (custom metrics have no level descriptions of their own, so the generic ones apply). */
export function definitionOf(metric: BakeoffMetric): MetricDefinition {
	if (metric.id.startsWith("custom:"))
		return {
			definition: metric.text?.trim() || metric.label,
			levels: [
				"Much worse than a typical solution on this",
				"Worse than typical on this",
				"About typical on this",
				"Better than typical on this",
				"Much better than a typical solution on this",
			],
		};
	return PRESET_DEFINITIONS[metric.id as BakeoffPreset];
}

/** The metrics as a prompt lists them: in the person's order, with weights, definitions and their own words verbatim. */
export function renderMetrics(metrics: readonly BakeoffMetric[], measured: ReadonlySet<string>): string {
	return metrics
		.map((metric, index) => {
			const def = definitionOf(metric);
			const lines = [
				`${index + 1}. \`${metric.id}\` — ${metric.label} (weight ${metric.weight} of 3)`,
				`   ${def.definition}`,
			];
			if (metric.text && metric.text.trim() !== def.definition)
				lines.push(`   The person's own words: ${JSON.stringify(metric.text.trim())}`);
			if (measured.has(metric.id))
				lines.push("   This one is also measured from the code's facts; score what you read anyway.");
			return lines.join("\n");
		})
		.join("\n");
}
