/**
 * Automatic per-prompt model routing (`routing.mode: auto`, `/route`).
 *
 * For each real user prompt the router asks one cheap classifier call (see {@link classifyRoute}) which
 * `routing.tiers` entry should serve it and how much thinking it needs, then hands the session a per-prompt
 * model override ({@link PromptModelOverride}) — the same mechanism a collab guest's per-message model uses, so
 * the session's own model and thinking level come back when the turn settles and nothing is persisted.
 *
 * Switching models rebuilds the prompt cache, so a choice is held for `routing.stickiness` turns before the
 * router may move to a cheaper tier or lower effort ({@link applyStickiness}); moving up is never delayed,
 * because an under-powered hard prompt costs more than a cache miss.
 *
 * What always wins over routing is decided by the caller and passed as `skip`: a per-prompt model, a model
 * mention, a profile model, subagent and synthetic turns. A session at its spend-cap warning may only route to
 * a tier no pricier than its own model; a capped session never gets here (the prompt is refused first).
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { type ConfiguredThinkingLevel, clampAutoThinkingEffort } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { PromptModelOverride } from "../session/agent-session-types";
import type { SpendCapLevel } from "../session/spend-cap";
import type { SessionManager } from "../session/session-manager";
import { type ClassifierTier, classifyRoute } from "./classifier";
import { formatRouteNotice, type RouteStatus } from "./format";
import { cfgRoutingClassifier, cfgRoutingMode, cfgRoutingStickiness, cfgRoutingTiers } from "./settings";
import { labelTiers, type ResolvedTier, resolveTiers, type RoutingTier } from "./tiers";

/** `AgentSessionEvent` `notice` source of every routing notice. */
export const ROUTING_NOTICE_SOURCE = "routing";

/** Bound on one classification before the turn runs on the session's model instead. */
const CLASSIFY_TIMEOUT_MS = 4000;
/** Decisions `/route` can show. */
const MAX_DECISIONS = 20;
/** Prompt characters kept per decision. */
const PROMPT_PREVIEW_CHARS = 80;

/** Effort when the prompt asks for `ultrathink`; clamped to what the tier's model supports. */
const ULTRATHINK_EFFORT = Effort.Max;
/** The classifier never picks past this; `max` is reserved for an explicit `ultrathink`. */
const CLASSIFIER_EFFORT_CEILING = Effort.XHigh;

/** One routing outcome, as `/route` lists it. */
export interface RouteDecision {
	at: number;
	/** Start of the prompt this decision was made for. */
	prompt: string;
	status: "routed" | "skipped";
	/** Label of the tier the turn ran on (`routed`). */
	tier?: string;
	/** `provider/id` the turn ran on. */
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Tier the classifier chose when stickiness kept a different one. */
	classified?: string;
	/** Turns left before the held choice may move down (`routed` and held). */
	holdTurnsLeft?: number;
	/** Why the turn was not routed (`skipped`). */
	reason?: string;
}

/** A routing choice, ordered for stickiness: tier position, then effort. */
export interface RouteChoice {
	/** Position in `routing.tiers`. */
	tier: number;
	/** Rank in {@link THINKING_EFFORTS}; -1 when the tier's model has no effort dial. */
	effort: number;
}

/** The choice currently held and how many routed turns it has served. */
export interface HeldChoice extends RouteChoice {
	turns: number;
}

function compareChoices(a: RouteChoice, b: RouteChoice): number {
	return a.tier !== b.tier ? a.tier - b.tier : a.effort - b.effort;
}

/**
 * Decide between the held choice and what the classifier just asked for. A stronger or equal request is taken
 * at once; a weaker one only after the held choice has served `stickiness` turns. `turns` of the result counts
 * the turn being decided.
 */
export function applyStickiness(
	held: HeldChoice | undefined,
	requested: RouteChoice,
	stickiness: number,
): { choice: HeldChoice; held: boolean } {
	if (!held) return { choice: { ...requested, turns: 1 }, held: false };
	const order = compareChoices(requested, held);
	if (order === 0) return { choice: { ...held, turns: held.turns + 1 }, held: false };
	if (order > 0 || held.turns >= stickiness) return { choice: { ...requested, turns: 1 }, held: false };
	return { choice: { ...held, turns: held.turns + 1 }, held: true };
}

/** What the router borrows from its session. */
export interface PromptRouterHost {
	settings: Settings;
	modelRegistry: ModelRegistry;
	/** Journal of off-transcript model cost: the classifier call is billed to the session. */
	sessionManager: Pick<SessionManager, "appendModelUsage" | "getSessionId" | "getLeafId">;
	sessionId(): string;
	/** The model a prompt runs on without routing. */
	baselineModel(): Model | undefined;
	/** The thinking selector a prompt runs on without routing (`auto` included). */
	baselineThinking(): ConfiguredThinkingLevel | undefined;
	metadataForProvider(provider: string): Record<string, unknown> | undefined;
	telemetry(): AgentTelemetryConfig | undefined;
	spendLevel(): SpendCapLevel;
	/** Whether the prompt asks for maximum thinking (`ultrathink`). */
	wantsUltrathink(text: string): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source: string): void;
}

/** What {@link PromptRouter.route} needs to know about the prompt. */
export interface RouteRequest {
	text: string;
	/** Why the prompt keeps its own model (an explicit one always wins); routing records the reason and steps aside. */
	skip?: string;
	signal?: AbortSignal;
}

function effortRank(level: ConfiguredThinkingLevel | undefined): number {
	return level === undefined ? -1 : THINKING_EFFORTS.indexOf(level as Effort);
}

/** Price per million tokens, input and output together; compares tiers for the spend-cap warning. */
function priceOf(model: Model): number {
	return model.cost.input + model.cost.output;
}

export class PromptRouter {
	readonly #host: PromptRouterHost;
	#sessionMode: "auto" | "off" | undefined;
	#held: (HeldChoice & { label: string }) | undefined;
	#decisions: RouteDecision[] = [];
	#active: RouteDecision | undefined;
	#sessionId: string | undefined;

	constructor(host: PromptRouterHost) {
		this.#host = host;
	}

	/** Whether prompts are routed: `/route on|off` for this session, else `routing.mode`. */
	get enabled(): boolean {
		return (this.#sessionMode ?? cfgRoutingMode.get(this.#host.settings)) === "auto";
	}

	/** `/route on|off` for this session; `undefined` goes back to `routing.mode`. */
	setSessionMode(mode: "auto" | "off" | undefined): void {
		this.#sessionMode = mode;
		if (!this.enabled) this.#held = undefined;
	}

	/** Newest last. */
	get decisions(): readonly RouteDecision[] {
		return this.#decisions;
	}

	/** The choice currently held and the tier labels, for `/route`. */
	get held(): { tier: string; turns: number } | undefined {
		return this.#held && { tier: this.#held.label, turns: this.#held.turns };
	}

	/** The routed decision of the turn in flight, or undefined between turns. */
	get activeTurn(): RouteDecision | undefined {
		return this.#active;
	}

	/** Called when the prompt run settles. */
	endTurn(): void {
		this.#active = undefined;
	}

	/** `routing.tiers` resolved against the live registry, as the next prompt would see them. */
	resolveTiers(): ResolvedTier[] {
		return resolveTiers(cfgRoutingTiers.get(this.#host.settings) as readonly RoutingTier[], {
			settings: this.#host.settings,
			registry: this.#host.modelRegistry,
			baseline: this.#host.baselineModel(),
		});
	}

	/** Everything `/route` reports. */
	status(): RouteStatus {
		const { settings } = this.#host;
		const resolved = this.resolveTiers();
		return {
			enabled: this.enabled,
			source: this.#sessionMode === undefined ? "settings" : "session",
			classifier: cfgRoutingClassifier.get(settings),
			stickiness: cfgRoutingStickiness.get(settings),
			tiers: labelTiers(cfgRoutingTiers.get(settings) as readonly RoutingTier[]).map(({ label, tier }, index) => {
				const model = resolved.find(entry => entry.index === index)?.model;
				return { label, when: tier.when, ...(model ? { model: formatModelString(model) } : {}) };
			}),
			held: this.held,
			decisions: this.#decisions,
		};
	}

	/**
	 * Choose the model and thinking level for one prompt. Returns the per-prompt override to run it on, or
	 * undefined when routing is off or the turn stays on the session's model. Never throws into the turn.
	 */
	async route(request: RouteRequest): Promise<PromptModelOverride | undefined> {
		if (!this.enabled) return undefined;
		const sessionId = this.#host.sessionId();
		if (this.#sessionId !== sessionId) {
			this.#sessionId = sessionId;
			this.#held = undefined;
			this.#decisions = [];
		}
		if (request.skip) {
			this.#record({ status: "skipped", prompt: request.text, reason: request.skip }, false);
			return undefined;
		}
		try {
			return await this.#decide(request);
		} catch (error) {
			if (request.signal?.aborted) return undefined;
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("routing: classification failed; prompt stays on the session model", { error: message });
			this.#record({ status: "skipped", prompt: request.text, reason: `classifier failed: ${message}` }, true);
			return undefined;
		}
	}

	async #decide(request: RouteRequest): Promise<PromptModelOverride | undefined> {
		const { settings } = this.#host;
		const baseline = this.#host.baselineModel();
		let tiers = this.resolveTiers();
		if (this.#host.spendLevel() === "warning" && baseline) {
			// Close to the cap: routing may keep or lower the price of a prompt, never raise it.
			const ceiling = priceOf(baseline);
			tiers = tiers.filter(tier => priceOf(tier.model) <= ceiling);
		}
		const [first] = tiers;
		if (!first) {
			this.#record({ status: "skipped", prompt: request.text, reason: "no routing tier is available" }, false);
			return undefined;
		}

		// A single tier has nothing to choose between, so it costs no classification (and picks no effort).
		let classified: { label: string; effort: Effort | undefined } = { label: first.label, effort: undefined };
		if (tiers.length > 1) classified = await this.#classify(request, tiers);
		const requested = tiers.find(tier => tier.label === classified.label);
		if (!requested) throw new Error(`classifier answered with unknown tier ${JSON.stringify(classified.label)}`);
		const ultrathink = this.#host.wantsUltrathink(request.text);

		/** The tier's thinking level for a wanted effort: its own pin, else the effort clamped to its model. */
		const levelFor = (tier: ResolvedTier, wanted: Effort | undefined): ConfiguredThinkingLevel | undefined => {
			if (tier.pinnedThinking !== undefined) return tier.pinnedThinking;
			const effort = ultrathink ? ULTRATHINK_EFFORT : wanted;
			if (effort === undefined) return undefined;
			return clampAutoThinkingEffort(tier.model, effort, ultrathink ? undefined : CLASSIFIER_EFFORT_CEILING);
		};
		const previous = this.#held;
		const heldTier = previous && tiers.find(tier => tier.label === previous.label && tier.index === previous.tier);
		const requestedLevel = levelFor(requested, classified.effort);
		const stickiness = cfgRoutingStickiness.get(settings);
		const { choice, held } = applyStickiness(
			heldTier ? previous : undefined,
			{ tier: requested.index, effort: effortRank(requestedLevel) },
			stickiness,
		);

		let applied = { tier: requested, level: requestedLevel };
		if (held && heldTier && previous) {
			applied = { tier: heldTier, level: levelFor(heldTier, THINKING_EFFORTS[previous.effort]) };
		}
		this.#held = { ...choice, label: applied.tier.label };
		const model = formatModelString(applied.tier.model);
		this.#active = this.#record(
			{
				status: "routed",
				prompt: request.text,
				tier: applied.tier.label,
				model,
				...(applied.level === undefined ? {} : { thinkingLevel: applied.level }),
				...(held ? { classified: requested.label, holdTurnsLeft: Math.max(0, stickiness - choice.turns) } : {}),
			},
			true,
		);
		// The session already runs on this model at this level: no override, no provider-session churn.
		const sameLevel = applied.level === undefined || applied.level === this.#host.baselineThinking();
		if (baseline && model === formatModelString(baseline) && sameLevel) {
			return undefined;
		}
		return { model: applied.tier.model, ...(applied.level === undefined ? {} : { thinkingLevel: applied.level }) };
	}

	async #classify(request: RouteRequest, tiers: readonly ResolvedTier[]): Promise<{ label: string; effort: Effort }> {
		const { settings, sessionManager } = this.#host;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		request.signal?.addEventListener("abort", onAbort, { once: true });
		const usageOwner = { sessionId: sessionManager.getSessionId(), parentId: sessionManager.getLeafId() };
		try {
			return await classifyRoute(
				request.text,
				tiers.map(tier => ({ label: tier.label, when: tier.tier.when }) satisfies ClassifierTier),
				{
					settings,
					registry: this.#host.modelRegistry,
					role: cfgRoutingClassifier.get(settings),
					sessionModel: this.#host.baselineModel(),
					sessionId: this.#host.sessionId(),
					signal: controller.signal,
					metadataResolver: provider => this.#host.metadataForProvider(provider),
					onUsage: usage => {
						const entryId = sessionManager.appendModelUsage(usage, usageOwner);
						if (entryId) usageOwner.parentId = entryId;
					},
					telemetry: this.#host.telemetry(),
				},
			);
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Remember a decision and announce it; `announce: false` for the silent skips that are only listed. */
	#record(entry: Omit<RouteDecision, "at" | "prompt"> & { prompt: string }, announce: boolean): RouteDecision {
		const decision: RouteDecision = {
			...entry,
			at: Date.now(),
			prompt: entry.prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_PREVIEW_CHARS),
		};
		this.#decisions.push(decision);
		if (this.#decisions.length > MAX_DECISIONS) this.#decisions.splice(0, this.#decisions.length - MAX_DECISIONS);
		if (announce) {
			this.#host.emitNotice(
				decision.status === "skipped" ? "warning" : "info",
				formatRouteNotice(decision),
				ROUTING_NOTICE_SOURCE,
			);
		}
		return decision;
	}
}
