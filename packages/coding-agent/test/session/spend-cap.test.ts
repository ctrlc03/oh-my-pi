import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	evaluateSpendCap,
	SpendCapController,
	type SpendCapNoticeLevel,
	type SpendUsage,
} from "@oh-my-pi/pi-coding-agent/session/spend-cap";
import { parseBudgetArgs, parseTokenCount, parseUsdAmount } from "@oh-my-pi/pi-coding-agent/session/spend-cap-input";

describe("evaluateSpendCap", () => {
	const none = { maxCostUsd: 0, maxTokens: 0 };

	it("is off without limits", () => {
		expect(evaluateSpendCap(none, { costUsd: 99, tokens: 9e9 }).level).toBe("off");
	});

	it("warns from 80% and caps at 100% of a limit", () => {
		const limits = { maxCostUsd: 1, maxTokens: 0 };
		expect(evaluateSpendCap(limits, { costUsd: 0.79, tokens: 0 }).level).toBe("ok");
		expect(evaluateSpendCap(limits, { costUsd: 0.8, tokens: 0 }).level).toBe("warning");
		expect(evaluateSpendCap(limits, { costUsd: 1, tokens: 0 }).level).toBe("capped");
	});

	it("lets the nearest of two limits decide", () => {
		const limits = { maxCostUsd: 100, maxTokens: 1000 };
		expect(evaluateSpendCap(limits, { costUsd: 1, tokens: 1000 }).level).toBe("capped");
	});
});

describe("spend-cap input parsing", () => {
	it("parses amounts and token counts, rejecting non-positive or malformed input", () => {
		expect(parseUsdAmount("$2.50")).toBe(2.5);
		expect(parseUsdAmount("0")).toBeUndefined();
		expect(parseUsdAmount("-1")).toBeUndefined();
		expect(parseUsdAmount("abc")).toBeUndefined();
		expect(parseTokenCount("200k")).toBe(200_000);
		expect(parseTokenCount("1.5M")).toBe(1_500_000);
		expect(parseTokenCount("12000")).toBe(12_000);
		expect(parseTokenCount("0")).toBeUndefined();
		expect(parseTokenCount("-5")).toBeUndefined();
	});

	it("parses /budget arguments", () => {
		expect(parseBudgetArgs("")).toEqual({ action: "status" });
		expect(parseBudgetArgs("5")).toEqual({ action: "set", maxCostUsd: 5 });
		expect(parseBudgetArgs("off")).toEqual({ action: "set", maxCostUsd: 0, maxTokens: 0 });
		expect(parseBudgetArgs("tokens 200k")).toEqual({ action: "set", maxTokens: 200_000 });
		expect(parseBudgetArgs("tokens off")).toEqual({ action: "set", maxTokens: 0 });
		expect(parseBudgetArgs("banana").action).toBe("error");
		expect(parseBudgetArgs("tokens").action).toBe("error");
		expect(parseBudgetArgs("1 2").action).toBe("error");
	});
});

describe("SpendCapController", () => {
	function create(settings: Record<string, unknown>, enforced = true) {
		const usage: SpendUsage = { costUsd: 0, tokens: 0 };
		const notices: SpendCapNoticeLevel[] = [];
		const controller = new SpendCapController(
			{
				settings: Settings.isolated(settings),
				readSpend: () => ({ ...usage }),
				emitNotice: level => notices.push(level),
			},
			enforced,
		);
		return { controller, usage, notices };
	}

	it("announces the warning and the cap once each", () => {
		const { controller, usage, notices } = create({ "session.maxCostUsd": 1 });
		usage.costUsd = 0.85;
		controller.onTurnEnd();
		controller.onTurnEnd();
		usage.costUsd = 1.2;
		controller.onTurnEnd();
		controller.onTurnEnd();
		expect(notices).toEqual(["warning", "error"]);
		expect(controller.shouldStop()).toBe(true);
	});

	it("announces only the cap when one turn jumps past both thresholds", () => {
		const { controller, usage, notices } = create({ "session.maxCostUsd": 1 });
		usage.costUsd = 3;
		controller.onTurnEnd();
		expect(notices).toEqual(["error"]);
	});

	it("never stops without a limit, and does not read spend", () => {
		const notices: SpendCapNoticeLevel[] = [];
		const controller = new SpendCapController(
			{
				settings: Settings.isolated({}),
				readSpend: () => {
					throw new Error("spend must not be read without a cap");
				},
				emitNotice: level => notices.push(level),
			},
			true,
		);
		expect(controller.shouldStop()).toBe(false);
		controller.onTurnEnd();
		expect(controller.status().level).toBe("off");
		expect(notices).toEqual([]);
	});

	it("raising the cap un-caps; spending past it caps again with a fresh notice", () => {
		const { controller, usage, notices } = create({ "session.maxCostUsd": 1 });
		usage.costUsd = 1.5;
		controller.onTurnEnd();
		expect(controller.shouldStop()).toBe(true);

		controller.setLimits({ maxCostUsd: 5 });
		expect(controller.shouldStop()).toBe(false);
		expect(() => controller.assertCanPrompt()).not.toThrow();

		usage.costUsd = 6;
		controller.onTurnEnd();
		expect(controller.shouldStop()).toBe(true);
		expect(notices.filter(level => level === "error")).toHaveLength(2);
	});

	it("clears both limits with 0", () => {
		const { controller, usage } = create({ "session.maxCostUsd": 1, "session.maxTokens": 10 });
		usage.costUsd = 5;
		usage.tokens = 50;
		controller.setLimits({ maxCostUsd: 0, maxTokens: 0 });
		expect(controller.status().level).toBe("off");
		expect(controller.shouldStop()).toBe(false);
	});

	it("does not enforce for sessions that spend through a parent", () => {
		const { controller, usage } = create({ "session.maxCostUsd": 1 }, false);
		usage.costUsd = 5;
		expect(controller.shouldStop()).toBe(false);
		expect(controller.status().level).toBe("off");
	});
});
