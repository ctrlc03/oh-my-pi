import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { assertProviderAllowedInPrivateMode } from "../private-mode";
import { embedOpenAI, type EmbeddingOptions } from "./openai-embeddings";
import type { EmbeddingRequest, EmbeddingResult } from "./types";

export * from "./openai-embeddings";
export * from "./types";

/** Dispatch an embedding request through the transport selected by the catalog model. */
export function embed(
	model: Model<Api>,
	request: EmbeddingRequest,
	options: EmbeddingOptions,
): Promise<EmbeddingResult> {
	assertProviderAllowedInPrivateMode(model.provider);
	if (model.api === "openai-embeddings") return embedOpenAI(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported embeddings API: ${model.api}`);
}
