/**
 * On-disk record of an assistant turn the provider's classifier refused.
 *
 * A refused turn never becomes a session message: replaying it would feed the
 * classifier its own verdict and the partial output it stopped. `AgentSession`
 * writes this projection as a custom entry instead, which `buildSessionContext`
 * skips, so the refusal stays inspectable in the JSONL without reaching any
 * later request.
 */
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";

export const PROVIDER_REFUSAL_CUSTOM_TYPE = "provider_refusal";

/** What a refused turn looked like when the provider stopped it. */
export interface ProviderRefusalData {
	api: AssistantMessage["api"];
	provider: string;
	model: string;
	/** `refusal`, or `sensitive` for a safety-filter stop. */
	stopType: string;
	/** Policy category such as `reasoning_extraction`; absent when the provider names none. */
	category?: string;
	explanation?: string;
	errorMessage?: string;
	responseId?: string;
	/** Other models' reasoning blocks the refused request replayed as text. */
	demotedReasoningBlocks?: number;
	usage: Usage;
	/** Request start, ms since epoch. */
	timestamp: number;
	duration?: number;
	ttft?: number;
	/** Output streamed before the refusal, secrets as placeholders like persisted messages. */
	content: AssistantMessage["content"];
}

/**
 * Projects a refused turn for {@link PROVIDER_REFUSAL_CUSTOM_TYPE}. Drops the
 * fallback-credit token and the in-memory credit handle: both are redeemable
 * only for minutes and the handle holds the whole request body.
 */
export function providerRefusalData(message: AssistantMessage): ProviderRefusalData {
	const details = message.stopDetails;
	return {
		api: message.api,
		provider: message.provider,
		model: message.model,
		stopType: details?.type ?? message.stopReason,
		category: details?.category ?? undefined,
		explanation: details?.explanation ?? undefined,
		errorMessage: message.errorMessage,
		responseId: message.responseId,
		demotedReasoningBlocks: message.demotedReasoningBlocks,
		usage: message.usage,
		timestamp: message.timestamp,
		duration: message.duration,
		ttft: message.ttft,
		content: message.content,
	};
}

/**
 * A displayed, never-sent message for a turn that ended in a classifier refusal (no resample, retry or fallback
 * answered). The refused turn itself is not a session message, so without this a reader of the transcript, in the
 * app or after a reload, saw the prompt and then nothing.
 */
export const PROVIDER_REFUSAL_NOTICE_TYPE = "provider-refusal-notice";

/** `details` of a {@link PROVIDER_REFUSAL_NOTICE_TYPE} message. */
export interface ProviderRefusalNotice {
	provider: string;
	model: string;
	/** Policy category such as `cyber` or `reasoning_extraction`; absent when the provider names none. */
	category?: string;
	/** The provider's own explanation, with any link it gives. */
	explanation?: string;
}

export function providerRefusalNotice(message: AssistantMessage): { text: string; details: ProviderRefusalNotice } {
	const details: ProviderRefusalNotice = {
		provider: message.provider,
		model: message.model,
		category: message.stopDetails?.category ?? undefined,
		explanation: message.stopDetails?.explanation ?? undefined,
	};
	const why = details.explanation ?? message.errorMessage ?? "The provider gave no reason.";
	const category = details.category === undefined ? "" : ` (${details.category})`;
	return {
		text: `${details.provider}/${details.model} refused this turn${category}; nothing was answered. ${why}`,
		details,
	};
}
