import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WireModel } from "@oh-my-pi/pi-wire";
import { ModelControls, type ModelControlsProps, ModelList } from "../src/components/shell/ModelControls";
import { MODEL_FILTER_MIN } from "../src/lib/model-filter";

function render(extra: Partial<ModelControlsProps>): string {
	return renderToStaticMarkup(
		<ModelControls
			models={[]}
			model={undefined}
			thinkingLevel={undefined}
			thinkingLevels={undefined}
			disabled={false}
			onSessionCommand={() => {}}
			{...extra}
		/>,
	);
}

describe("ModelControls profile pill", () => {
	it("shows the active profile when the host offers profiles", () => {
		const html = render({ profiles: [{ name: "build" }, { name: "review" }], profile: "review" });
		expect(html).toContain('title="Switch profile"');
		expect(html).toContain(">review<");
	});

	it("hides the pill without a profile list", () => {
		expect(render({ profiles: null, profile: "build" })).not.toContain("Switch profile");
		expect(render({ profiles: [], profile: "build" })).not.toContain("Switch profile");
		expect(render({ profile: "build" })).not.toContain("Switch profile");
	});
});

describe("ModelList filter", () => {
	const many: WireModel[] = Array.from({ length: MODEL_FILTER_MIN + 1 }, (_, i) => ({
		provider: i % 2 === 0 ? "anthropic" : "openai",
		id: `m${i}`,
		name: `Model ${i}`,
		contextWindow: 100_000,
	}));
	const html = (models: WireModel[], current?: WireModel): string =>
		renderToStaticMarkup(<ModelList models={models} current={current} onChange={() => {}} />);

	it("shows a filter field past the threshold, with a count per provider", () => {
		const out = html(many);
		expect(out).toContain('aria-label="Filter models"');
		expect(out).toContain('<span class="sh-model-count">7</span>');
		expect(out).toContain('<span class="sh-model-count">6</span>');
	});

	it("leaves a short list as it was", () => {
		expect(html(many.slice(0, MODEL_FILTER_MIN))).not.toContain("Filter models");
	});

	it("lists the current model's provider first and marks the current model", () => {
		const out = html(many, many[1]);
		expect(out.indexOf("openai")).toBeLessThan(out.indexOf("anthropic"));
		expect(out).toContain('aria-selected="true"');
	});
});
