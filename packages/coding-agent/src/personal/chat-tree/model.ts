/**
 * Which model writes the tree's lines (`personal.chatTree.model`, docs/personal-chat-tree.md): the setting when it is
 * set, else the cheapest Anthropic Haiku the profile can reach, else its `smol` role model, else the session model.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { cfgPersonalChatTreeModel } from "../settings";

/** The cheapest Anthropic Haiku among `models` (input price, then output price); the highest id among equals, so the newest. */
export function pickHaiku(models: readonly Model<Api>[]): Model<Api> | undefined {
	let best: Model<Api> | undefined;
	for (const model of models) {
		if (model.provider !== "anthropic" || !/haiku/i.test(model.id)) continue;
		if (!best) {
			best = model;
			continue;
		}
		const price = (m: Model<Api>) => [m.cost.input, m.cost.output];
		const [a0, a1] = price(model);
		const [b0, b1] = price(best);
		if (a0 < b0 || (a0 === b0 && (a1 < b1 || (a1 === b1 && model.id > best.id)))) best = model;
	}
	return best;
}

export interface ResolvedChatTreeModel {
	model: Model<Api>;
	/** Thinking level the setting asked for with a `:level` suffix. */
	thinkingLevel?: ThinkingLevel;
	/** Why this model was chosen, for the log and the doc. */
	source: "setting" | "haiku" | "smol" | "session";
}

/** The model the compactions run on. Throws when the setting names a model that is not available. */
export function resolveChatTreeModel(
	settings: Settings,
	available: readonly Model<Api>[],
	sessionModel: Model<Api> | undefined,
): ResolvedChatTreeModel {
	const options = { settings, matchPreferences: getModelMatchPreferences(settings) };
	const configured = cfgPersonalChatTreeModel.get(settings).trim();
	if (configured) {
		const resolved = resolveModelRoleValue(configured, [...available], options);
		if (!resolved.model) {
			throw new Error(
				`personal.chatTree.model "${configured}" is not an available model${resolved.warning ? `: ${resolved.warning}` : ""}`,
			);
		}
		return {
			model: resolved.model,
			thinkingLevel:
				resolved.explicitThinkingLevel && resolved.thinkingLevel !== "auto" ? resolved.thinkingLevel : undefined,
			source: "setting",
		};
	}
	const haiku = pickHaiku(available);
	if (haiku) return { model: haiku, source: "haiku" };
	const smol = resolveModelRoleValue("smol", [...available], options);
	if (smol.model) return { model: smol.model, source: "smol" };
	if (!sessionModel) throw new Error("The chat tree has no model to write its lines with");
	return { model: sessionModel, source: "session" };
}
