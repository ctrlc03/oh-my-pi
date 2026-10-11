/**
 * Per-prompt route classifier. One judge call answers two questions about the user's request: which
 * `routing.tiers` entry should serve it, and how hard it is (the same effort ladder the `auto` thinking
 * level uses, so a routed turn costs one classification, not two). The judge comes from the role named by
 * `routing.classifier`, `judge` by default. A local on-device candidate gets the coarser `trivial|moderate|hard`
 * bucket instead of the effort ladder, as in {@link classifyDifficulty}.
 *
 * Throws on any failure (no judge, no key, unparseable output, abort/timeout); the router then leaves the turn
 * on the session's model.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type ChoiceQuestion, Effort, type Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { BUCKET_EFFORT, LEVEL_EFFORT, REQUEST_QUESTIONS } from "../auto-thinking/classifier";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import tierQuestionInstructions from "../prompts/system/routing-tier-question.md" with { type: "text" };
import { preprocessTinyMessage } from "../tiny/message-preproc";

/** A tier as the classifier sees it: the label it answers with and the description it chooses by. */
export interface ClassifierTier {
	label: string;
	when: string;
}

/** The classifier's verdict: the chosen tier's label and an effort, before it is clamped to the tier's model. */
export interface RouteClassification {
	label: string;
	effort: Effort;
}

export interface ClassifyRouteDeps {
	settings: Settings;
	registry: ModelRegistry;
	/** Role whose candidates answer (`routing.classifier`). */
	role: string;
	/** The session's model; appended to the classifier's candidates when the role does not already route to it. */
	sessionModel: Model | undefined;
	sessionId?: string;
	signal?: AbortSignal;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
}

function tierQuestion(tiers: readonly ClassifierTier[]): ChoiceQuestion {
	const criteria: Record<string, string> = {};
	for (const tier of tiers) criteria[tier.label] = tier.when;
	return { type: "choice", instructions: prompt.render(tierQuestionInstructions), criteria };
}

/**
 * Classify `request` against `tiers`.
 * @throws when the backend cannot produce a usable classification.
 */
export async function classifyRoute(
	request: string,
	tiers: readonly ClassifierTier[],
	deps: ClassifyRouteDeps,
): Promise<RouteClassification> {
	const judge = resolveJudge({
		settings: deps.settings,
		registry: deps.registry,
		role: deps.role,
		sessionModel: deps.sessionModel,
		sessionId: deps.sessionId,
		metadataResolver: deps.metadataResolver,
		purpose: "routing",
		onUsage: deps.onUsage,
		telemetry: deps.telemetry,
		cache: sharedJudgmentCache(),
	});
	const state = { request: preprocessTinyMessage(request) };
	const tier = tierQuestion(tiers);
	const options = { signal: deps.signal };
	return judge.withCandidate(async (candidate, kind) => {
		if (kind === "local") {
			const { answers } = await candidate.judge(
				{ state, questions: { tier, bucket: REQUEST_QUESTIONS.bucket } },
				options,
			);
			return { label: answers.tier.choice, effort: BUCKET_EFFORT[answers.bucket.choice] };
		}
		const { answers } = await candidate.judge(
			{ state, questions: { tier, level: REQUEST_QUESTIONS.level } },
			options,
		);
		return { label: answers.tier.choice, effort: LEVEL_EFFORT[answers.level.choice] };
	}, options);
}
