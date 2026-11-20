import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { assertProviderAllowedInPrivateMode } from "../private-mode";
import {
	downloadOpenRouterVideo,
	pollOpenRouterVideo,
	submitOpenRouterVideo,
	type VideoOptions,
} from "./openrouter-video";
import type { VideoContent, VideoGenerationRequest, VideoJob } from "./types";

export * from "./openrouter-video";
export * from "./types";

/** Submit an asynchronous video generation job through the model's transport. */
export function submitVideo(
	model: Model<Api>,
	request: VideoGenerationRequest,
	options: VideoOptions,
): Promise<VideoJob> {
	assertProviderAllowedInPrivateMode(model.provider);
	if (model.api === "openrouter-video") return submitOpenRouterVideo(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
}

/** Poll an asynchronous video generation job through the model's transport. */
export function pollVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoJob> {
	assertProviderAllowedInPrivateMode(model.provider);
	if (model.api === "openrouter-video") return pollOpenRouterVideo(model, jobId, options);
	throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
}

/** Stream generated video content through the model's transport. */
export function downloadVideo(model: Model<Api>, jobId: string, options: VideoOptions): Promise<VideoContent> {
	assertProviderAllowedInPrivateMode(model.provider);
	if (model.api === "openrouter-video") return downloadOpenRouterVideo(model, jobId, options);
	throw new AIError.ConfigurationError(`Unsupported video API: ${model.api}`);
}
