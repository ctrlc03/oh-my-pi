import type { Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { PromptModelOverride } from "../session/agent-session-types";

/** What a guest's `prompt` frame asked for: `model` is `provider/id`, `thinking` one of that model's selectors. */
export interface PromptModelRequest {
	model?: unknown;
	thinking?: unknown;
}

/** `override` is absent when the prompt should simply run on the session's own model. */
export type PromptModelResolution = { override?: PromptModelOverride } | { error: string };

/**
 * Validate a guest's per-prompt model choice against the models the host lets
 * guests select. Frames arrive as untrusted JSON, so every field is type-checked.
 * A choice that names the session's current model still resolves to an override:
 * a run already on another model's override must not silently carry over.
 */
export function resolvePromptModel(
	request: PromptModelRequest,
	selectable: () => readonly Model[],
	effortSelectors: (model: Model) => readonly ConfiguredThinkingLevel[],
): PromptModelResolution {
	const { model: modelArg, thinking } = request;
	if (modelArg === undefined) {
		return thinking === undefined ? {} : { error: "a thinking level needs a model to apply to" };
	}
	if (typeof modelArg !== "string") return { error: "model must be a provider/id string" };
	const model = selectable().find(candidate => `${candidate.provider}/${candidate.id}` === modelArg);
	if (!model) return { error: `unknown model ${JSON.stringify(modelArg)}` };
	if (thinking === undefined) return { override: { model } };
	if (typeof thinking !== "string") return { error: "thinking must be a string" };
	const thinkingLevel = effortSelectors(model).find(selector => selector === thinking);
	if (!thinkingLevel) {
		return { error: `${model.provider}/${model.id} does not accept thinking level ${JSON.stringify(thinking)}` };
	}
	return { override: { model, thinkingLevel } };
}
