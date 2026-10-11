/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";
import { DEFAULT_ROUTING_TIERS, validateRoutingTiers } from "./tiers";

export const ROUTING_MODE_VALUES = ["off", "auto"] as const;

export const cfgRoutingMode = register({
	id: "routing.mode",
	type: "enum",
	values: ROUTING_MODE_VALUES,
	default: "off",
	ui: {
		tab: "model",
		group: "Routing",
		label: "Model Routing",
		description:
			"Pick the model role and thinking level for each prompt with one cheap classifier call. Off keeps every prompt on the session's model. A model chosen for a single prompt, a model mention, or a profile model always wins.",
		options: [
			{ value: "off", label: "Off", description: "Every prompt runs on the session's model (default)" },
			{ value: "auto", label: "Auto", description: "A classifier routes each prompt to a tier of `routing.tiers`" },
		],
	},
});

// Config-file-only: the tier list is structured, so it is edited in the settings file.
export const cfgRoutingTiers = register({
	id: "routing.tiers",
	type: "array",
	default: DEFAULT_ROUTING_TIERS,
	validate: validateRoutingTiers,
});

export const cfgRoutingClassifier = register({
	id: "routing.classifier",
	type: "string",
	default: "judge",
});

export const cfgRoutingStickiness = register({
	id: "routing.stickiness",
	type: "number",
	default: 3,
	validate: raw => {
		if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)) {
			throw new Error("routing.stickiness must be a number of turns, 0 or more");
		}
	},
	normalize: value => (typeof value === "number" ? Math.floor(value) : value),
	ui: {
		tab: "model",
		group: "Routing",
		label: "Routing Stickiness",
		description:
			"Turns a routed choice is kept before routing may move to a cheaper tier or lower thinking level. Switching models rebuilds the prompt cache, so a short trivial prompt right after a hard one stays on the strong tier; moving up is never delayed. 0 follows the classifier every turn.",
		options: [
			{ value: "0", label: "0", description: "Follow the classifier every turn" },
			{ value: "1", label: "1", description: "Hold a choice for one more turn" },
			{ value: "3", label: "3", description: "Hold a choice for three more turns (default)" },
			{ value: "5", label: "5", description: "Hold a choice for five more turns" },
		],
	},
});
