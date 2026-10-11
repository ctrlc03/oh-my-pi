import { describe, expect, it } from "bun:test";
import type { WireModel } from "@oh-my-pi/pi-wire";
import { arrangeModels, MODEL_FILTER_MIN } from "../src/lib/model-filter";

function model(provider: string, id: string, name = id): WireModel {
	return { provider, id, name, contextWindow: 200_000 };
}

const bedrock = Array.from({ length: 30 }, (_, i) => model("amazon-bedrock", `us.amazon.nova-${i}-v1:0`, `Nova ${i}`));
const catalogue: WireModel[] = [
	...bedrock,
	model("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-v1:0", "Claude Sonnet 4.5 (US)"),
	model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5"),
	model("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
	model("openai", "gpt-5", "GPT-5"),
];

const ids = (groups: ReturnType<typeof arrangeModels>): string[] =>
	groups.flatMap(group => group.models.map(m => `${m.provider}/${m.id}`));

describe("arrangeModels without a query", () => {
	it("keeps the host's order and provider grouping", () => {
		const groups = arrangeModels(catalogue, undefined, "");
		expect(groups.map(g => g.provider)).toEqual(["amazon-bedrock", "anthropic", "openai"]);
		expect(groups[0]?.models).toHaveLength(31);
	});

	it("puts the current model's provider first, the rest unchanged", () => {
		const groups = arrangeModels(catalogue, { provider: "anthropic" }, "  ");
		expect(groups.map(g => g.provider)).toEqual(["anthropic", "amazon-bedrock", "openai"]);
		expect(groups[1]?.models).toHaveLength(31);
	});

	it("ignores a current provider the list does not have", () => {
		expect(arrangeModels(catalogue, { provider: "nobody" }, "").map(g => g.provider)).toEqual([
			"amazon-bedrock",
			"anthropic",
			"openai",
		]);
	});
});

describe("arrangeModels with a query", () => {
	it("finds Sonnet among many rows, the tighter name first", () => {
		const found = ids(arrangeModels(catalogue, undefined, "sonnet"));
		expect(found).toEqual(["anthropic/claude-sonnet-4-5", "amazon-bedrock/us.anthropic.claude-sonnet-4-5-v1:0"]);
	});

	it("matches the id and the provider, every word needed", () => {
		expect(ids(arrangeModels(catalogue, undefined, "bedrock sonnet"))).toEqual([
			"amazon-bedrock/us.anthropic.claude-sonnet-4-5-v1:0",
		]);
		expect(ids(arrangeModels(catalogue, undefined, "haiku-4-5"))).toEqual(["anthropic/claude-haiku-4-5"]);
		expect(arrangeModels(catalogue, undefined, "openai")[0]?.models[0]?.id).toBe("gpt-5");
	});

	it("orders groups by their best match, not the host's order", () => {
		const groups = arrangeModels(catalogue, undefined, "claude 4.5");
		expect(groups.map(g => g.provider)).toEqual(["anthropic", "amazon-bedrock"]);
		const first = arrangeModels([model("a", "x-gpt", "Zed"), model("b", "gpt", "GPT")], undefined, "gpt");
		expect(first[0]?.provider).toBe("b");
	});

	it("falls back to letters in order only when nothing contains the query", () => {
		expect(ids(arrangeModels(catalogue, undefined, "cs45"))).toContain("anthropic/claude-sonnet-4-5");
		// "son" is contained in the Sonnet rows, so the subsequence hits (Nova ... "us.amazon") stay out.
		expect(ids(arrangeModels(catalogue, undefined, "son")).some(id => id.includes("nova"))).toBe(false);
	});

	it("is empty when nothing matches", () => {
		expect(arrangeModels(catalogue, undefined, "zzzzqq")).toEqual([]);
	});

	it("matches case-insensitively", () => {
		expect(ids(arrangeModels(catalogue, undefined, "GPT"))).toEqual(["openai/gpt-5"]);
	});
});

describe("MODEL_FILTER_MIN", () => {
	it("is smaller than the catalogue the picker has to search", () => {
		expect(catalogue.length).toBeGreaterThan(MODEL_FILTER_MIN);
	});
});
