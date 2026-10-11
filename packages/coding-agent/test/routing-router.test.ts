import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	applyStickiness,
	PromptRouter,
	type PromptRouterHost,
	ROUTING_NOTICE_SOURCE,
} from "@oh-my-pi/pi-coding-agent/routing/router";
import { cfgRoutingMode } from "@oh-my-pi/pi-coding-agent/routing/settings";
import { labelTiers, validateRoutingTiers } from "@oh-my-pi/pi-coding-agent/routing/tiers";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { SpendCapLevel } from "@oh-my-pi/pi-coding-agent/session/spend-cap";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function bundled(provider: "anthropic" | "local", id: string): Model {
	const model = getBundledModel(provider, id as never);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

const HAIKU = bundled("anthropic", "claude-haiku-4-5");
const SONNET = bundled("anthropic", "claude-sonnet-4-5");
const OPUS = bundled("anthropic", "claude-opus-4-6");
const JUDGE = bundled("local", "qwen3-1.7b");

const ROLES = {
	judge: `local/${JUDGE.id}`,
	smol: `anthropic/${HAIKU.id}`,
	slow: `anthropic/${OPUS.id}`,
};

describe("model routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createRouter(options: {
		settings?: Record<string, unknown>;
		spend?: SpendCapLevel;
		ultrathink?: boolean;
		baselineThinking?: ConfiguredThinkingLevel;
	}) {
		const settings = Settings.isolated({ modelRoles: ROLES, ...options.settings });
		const registry = new ModelRegistry(createInMemoryAuthStorage(), "/nonexistent/routing-models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue([HAIKU, SONNET, OPUS, JUDGE]);
		const notices: Array<{ level: string; message: string; source: string }> = [];
		const host: PromptRouterHost = {
			settings,
			modelRegistry: registry,
			sessionManager: { appendModelUsage: () => undefined, getSessionId: () => "s1", getLeafId: () => null },
			sessionId: () => "s1",
			baselineModel: () => SONNET,
			baselineThinking: () => options.baselineThinking,
			metadataForProvider: () => undefined,
			telemetry: () => undefined,
			spendLevel: () => options.spend ?? "ok",
			wantsUltrathink: () => options.ultrathink === true,
			emitNotice: (level, message, source) => notices.push({ level, message, source }),
		};
		return { router: new PromptRouter(host), registry, notices };
	}

	/** The local judge answers each routed prompt with the next scripted `[tier, bucket]`. */
	function scriptJudge(...answers: Array<[string, string]>) {
		const complete = vi.spyOn(tinyModelClient, "complete").mockImplementation(async () => {
			const answer = answers.shift();
			if (!answer) throw new Error("judge script exhausted");
			return `tier: ${answer[0]}\nbucket: ${answer[1]}`;
		});
		return complete;
	}

	const ON = { "routing.mode": "auto" };

	it("is off by default and never calls the classifier", async () => {
		expect(cfgRoutingMode.get(Settings.isolated({}))).toBe("off");
		const complete = scriptJudge(["slow", "hard"]);
		const { router, notices } = createRouter({});
		expect(router.enabled).toBe(false);
		expect(await router.route({ text: "refactor the whole scheduler" })).toBeUndefined();
		expect(complete).not.toHaveBeenCalled();
		expect(router.decisions).toEqual([]);
		expect(notices).toEqual([]);
	});

	it("runs a trivial question on the smol model and a hard refactor on the strong one", async () => {
		scriptJudge(["smol", "trivial"], ["slow", "hard"]);
		const { router, notices } = createRouter({ settings: { ...ON, "routing.stickiness": 0 } });

		const trivial = await router.route({ text: "what does Array.prototype.at do?" });
		expect(trivial?.model.id).toBe(HAIKU.id);
		expect(trivial?.thinkingLevel).toBe(Effort.Low);
		expect(router.activeTurn).toMatchObject({ status: "routed", tier: "smol", model: `anthropic/${HAIKU.id}` });

		const hard = await router.route({ text: "split the scheduler into per-queue workers across 40 files" });
		expect(hard?.model.id).toBe(OPUS.id);
		expect(hard?.thinkingLevel).toBeDefined();
		expect(router.activeTurn).toMatchObject({ tier: "slow" });

		expect(notices.map(notice => notice.source)).toEqual([ROUTING_NOTICE_SOURCE, ROUTING_NOTICE_SOURCE]);
		router.endTurn();
		expect(router.activeTurn).toBeUndefined();
	});

	it("leaves a normal prompt on the session's own model and thinking level", async () => {
		scriptJudge(["default", "moderate"]);
		const { router } = createRouter({ settings: ON, baselineThinking: Effort.High });
		expect(await router.route({ text: "fix the off-by-one in pagination" })).toBeUndefined();
		expect(router.activeTurn).toMatchObject({ status: "routed", tier: "default", model: `anthropic/${SONNET.id}` });
	});

	it("applies an effort the session does not already use to a default-tier prompt", async () => {
		scriptJudge(["default", "hard"]);
		const { router } = createRouter({ settings: ON });
		const routed = await router.route({ text: "fix the flaky retry test" });
		expect(routed?.model.id).toBe(SONNET.id);
		expect(routed?.thinkingLevel).toBeDefined();
	});

	it("never overrides an explicit model choice", async () => {
		const complete = scriptJudge(["slow", "hard"]);
		const { router } = createRouter({ settings: ON });
		const routed = await router.route({ text: "^opus do it", skip: "the message mentions a model" });
		expect(routed).toBeUndefined();
		expect(complete).not.toHaveBeenCalled();
		expect(router.activeTurn).toBeUndefined();
		expect(router.decisions).toEqual([expect.objectContaining({ status: "skipped" })]);
	});

	it("holds a stronger tier for `stickiness` turns, then follows the classifier down", async () => {
		scriptJudge(["slow", "hard"], ["smol", "trivial"], ["smol", "trivial"], ["smol", "trivial"], ["smol", "trivial"]);
		const { router } = createRouter({ settings: { ...ON, "routing.stickiness": 3 } });
		const tiers: string[] = [];
		for (let turn = 0; turn < 5; turn++) {
			await router.route({ text: `prompt ${turn}` });
			tiers.push(router.activeTurn?.tier ?? "none");
			router.endTurn();
		}
		expect(tiers).toEqual(["slow", "slow", "slow", "smol", "smol"]);
		expect(router.decisions[1]).toMatchObject({ classified: "smol", holdTurnsLeft: 1 });
	});

	it("follows the classifier every turn with stickiness 0", async () => {
		scriptJudge(["slow", "hard"], ["smol", "trivial"]);
		const { router } = createRouter({ settings: { ...ON, "routing.stickiness": 0 } });
		await router.route({ text: "one" });
		await router.route({ text: "two" });
		expect(router.activeTurn).toMatchObject({ tier: "smol" });
	});

	it("never steps up in price while the spend cap is at its warning level", async () => {
		const complete = scriptJudge(["default", "moderate"]);
		const { router } = createRouter({
			settings: {
				...ON,
				"routing.tiers": [
					{ role: "smol", when: "zzz-cheap" },
					{ role: "default", when: "yyy-normal" },
					{ role: "slow", when: "xxx-hard" },
				],
			},
			spend: "warning",
		});
		await router.route({ text: "redesign the storage layer" });
		const rendered = String(complete.mock.calls[0]?.[1]);
		expect(rendered).toContain("zzz-cheap");
		expect(rendered).toContain("yyy-normal");
		expect(rendered).not.toContain("xxx-hard");
	});

	it("routes a role tier to its fallback while the primary is cooling down", () => {
		const { router, registry } = createRouter({
			settings: { ...ON, "retry.fallbackChains": { smol: [`anthropic/${SONNET.id}`] } },
		});
		expect(router.resolveTiers().find(tier => tier.label === "smol")?.model.id).toBe(HAIKU.id);
		vi.spyOn(registry, "isSelectorSuppressed").mockImplementation(selector => selector.includes(HAIKU.id));
		expect(router.resolveTiers().find(tier => tier.label === "smol")?.model.id).toBe(SONNET.id);
	});

	it("keeps the prompt on the session model, with a warning, when classification fails", async () => {
		vi.spyOn(tinyModelClient, "complete").mockRejectedValue(new Error("worker down"));
		const { router, notices } = createRouter({ settings: ON });
		expect(await router.route({ text: "anything" })).toBeUndefined();
		expect(router.activeTurn).toBeUndefined();
		expect(notices).toEqual([expect.objectContaining({ level: "warning", source: ROUTING_NOTICE_SOURCE })]);
	});

	it("asks for the maximum effort on ultrathink", async () => {
		scriptJudge(["slow", "trivial"]);
		const { router } = createRouter({ settings: ON, ultrathink: true });
		const routed = await router.route({ text: "ultrathink about the lock order" });
		expect(routed?.thinkingLevel).toBe(Effort.Max);
	});

	it("/route can turn routing on or off for the session over routing.mode", async () => {
		const complete = scriptJudge(["smol", "trivial"]);
		const off = createRouter({});
		off.router.setSessionMode("auto");
		expect(off.router.enabled).toBe(true);
		expect((await off.router.route({ text: "what is a monad?" }))?.model.id).toBe(HAIKU.id);
		off.router.setSessionMode(undefined);
		expect(off.router.enabled).toBe(false);

		const on = createRouter({ settings: ON });
		on.router.setSessionMode("off");
		expect(on.router.enabled).toBe(false);
		expect(await on.router.route({ text: "what is a monad?" })).toBeUndefined();
		expect(complete).toHaveBeenCalledTimes(1);
	});
});

describe("route stickiness", () => {
	it("takes a stronger or equal request at once and holds a weaker one for the window", () => {
		const held = { tier: 2, effort: 3, turns: 1 };
		expect(applyStickiness(undefined, { tier: 0, effort: 0 }, 3).choice).toEqual({ tier: 0, effort: 0, turns: 1 });
		expect(applyStickiness(held, { tier: 2, effort: 3 }, 3)).toEqual({ choice: { ...held, turns: 2 }, held: false });
		expect(applyStickiness(held, { tier: 2, effort: 4 }, 3)).toEqual({
			choice: { tier: 2, effort: 4, turns: 1 },
			held: false,
		});
		expect(applyStickiness(held, { tier: 1, effort: 3 }, 3)).toEqual({ choice: { ...held, turns: 2 }, held: true });
		expect(applyStickiness({ ...held, turns: 3 }, { tier: 1, effort: 3 }, 3)).toEqual({
			choice: { tier: 1, effort: 3, turns: 1 },
			held: false,
		});
	});
});

describe("routing.tiers", () => {
	it("rejects entries without exactly one of role or model, or without a description", () => {
		expect(() => validateRoutingTiers([])).toThrow();
		expect(() => validateRoutingTiers([{ when: "x" }])).toThrow();
		expect(() => validateRoutingTiers([{ role: "smol", model: "a/b", when: "x" }])).toThrow();
		expect(() => validateRoutingTiers([{ role: "smol" }])).toThrow();
		expect(() =>
			validateRoutingTiers([
				{ role: "smol", when: "x" },
				{ model: "a/b", when: "y" },
			]),
		).not.toThrow();
	});

	it("gives every tier a unique single-token label", () => {
		const labels = labelTiers([
			{ role: "smol", when: "a" },
			{ role: "smol", when: "b" },
			{ model: "openai/gpt 5", when: "c" },
			{ role: "default", name: "big one", when: "d" },
		]).map(entry => entry.label);
		expect(new Set(labels).size).toBe(4);
		for (const label of labels) expect(label).toMatch(/^[A-Za-z0-9_.-]+$/);
	});
});
