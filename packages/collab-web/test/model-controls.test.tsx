import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelControls, type ModelControlsProps } from "../src/components/shell/ModelControls";

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
		expect(html).toContain('title="switch profile"');
		expect(html).toContain(">review<");
	});

	it("hides the pill without a profile list", () => {
		expect(render({ profiles: null, profile: "build" })).not.toContain("switch profile");
		expect(render({ profiles: [], profile: "build" })).not.toContain("switch profile");
		expect(render({ profile: "build" })).not.toContain("switch profile");
	});
});
