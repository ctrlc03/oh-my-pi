import { describe, expect, it } from "bun:test";
import { flowToSkeleton, focusToSkeleton, type GraphPalette } from "../src/lib/codemap-scene";
import type { CodemapFlowStep, CodemapLink, CodemapNode, CodemapView } from "../src/lib/companion";

const palette: GraphPalette = { line: "line", bridge: "bridge", lang: lang => `lang-${lang}` };

const node = (label: string, lang = "ts"): CodemapNode => ({
	kind: "symbol",
	path: `src/${label}.ts`,
	label,
	lang,
	line: 3,
});
const link = (label: string, edge: string, bridge = false): CodemapLink => ({
	node: node(label),
	label: edge,
	weight: 1,
	bridge,
});

function view(upstream: CodemapLink[], downstream: CodemapLink[]): CodemapView {
	return {
		repo: "repo",
		focus: node("focus", "rust"),
		crumbs: [],
		upstream,
		downstream,
		moreUpstream: 0,
		moreDownstream: 0,
		children: [],
		index: { files: 0, symbols: 0, refreshMs: 0 },
	};
}

describe("focusToSkeleton", () => {
	const elements = focusToSkeleton(
		view([link("caller", "calls")], [link("a", "uses"), link("b", "emits", true)]),
		palette,
	);
	const byId = Object.fromEntries(elements.map(element => [element.id, element]));

	it("draws the focus and every neighbour as a box", () => {
		const boxes = elements.filter(element => element.type === "rectangle").map(element => element.id);
		expect(boxes.sort()).toEqual(["down-0", "down-1", "focus", "up-0"]);
		expect(byId.focus?.strokeColor).toBe("lang-rust");
		expect(byId.focus?.label?.text).toContain("focus");
		expect(byId.focus?.label?.text).toContain("src/focus.ts:3");
	});

	it("points arrows user to focus to used", () => {
		expect(byId["up-0-edge"]?.start?.id).toBe("up-0");
		expect(byId["up-0-edge"]?.end?.id).toBe("focus");
		expect(byId["down-0-edge"]?.start?.id).toBe("focus");
		expect(byId["down-0-edge"]?.end?.id).toBe("down-0");
		expect(byId["down-0-edge"]?.label?.text).toBe("uses");
	});

	it("dashes and colours bridge links", () => {
		expect(byId["down-1-edge"]?.strokeStyle).toBe("dashed");
		expect(byId["down-1-edge"]?.strokeColor).toBe("bridge");
		expect(byId["down-0-edge"]?.strokeStyle).toBe("solid");
		expect(byId["down-0-edge"]?.strokeColor).toBe("line");
	});

	it("lays upstream left of the focus and downstream right of it", () => {
		expect(byId["up-0"]!.x).toBeLessThan(byId.focus!.x);
		expect(byId["down-0"]!.x).toBeGreaterThan(byId.focus!.x);
		expect(byId["down-0"]!.y).not.toBe(byId["down-1"]!.y);
	});

	it("has unique ids and only draws arrows between boxes that exist", () => {
		const ids = elements.map(element => element.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const element of elements) {
			if (element.type !== "arrow") continue;
			expect(ids).toContain(element.start!.id);
			expect(ids).toContain(element.end!.id);
		}
	});

	it("handles a focus with no links", () => {
		expect(focusToSkeleton(view([], []), palette).map(element => element.id)).toEqual(["focus"]);
	});

	it("cuts long captions", () => {
		const long = focusToSkeleton(view([], [link("x".repeat(200), "y".repeat(200))]), palette);
		for (const element of long) {
			for (const line of element.label?.text.split("\n") ?? []) expect(line.length).toBeLessThanOrEqual(34);
		}
	});
});

describe("flowToSkeleton", () => {
	const steps: CodemapFlowStep[] = [
		{ node: node("start"), hop: 0, from: null, label: null, bridge: false },
		{ node: node("mid"), hop: 1, from: 0, label: "calls", bridge: false },
		{ node: node("end"), hop: 2, from: 1, label: "emits", bridge: true },
		{ node: node("alt"), hop: 2, from: 1, label: null, bridge: false },
	];

	it("puts each hop in its own column", () => {
		const elements = flowToSkeleton(steps, "down", palette);
		const x = (id: string): number => elements.find(element => element.id === id)!.x;
		expect(x("step-0")).toBeLessThan(x("step-1"));
		expect(x("step-1")).toBeLessThan(x("step-2"));
		expect(x("step-2")).toBe(x("step-3"));
	});

	it("runs arrows with the data in both directions", () => {
		const down = flowToSkeleton(steps, "down", palette).find(element => element.id === "edge-1")!;
		expect([down.start?.id, down.end?.id]).toEqual(["step-0", "step-1"]);
		const up = flowToSkeleton(steps, "up", palette).find(element => element.id === "edge-1")!;
		expect([up.start?.id, up.end?.id]).toEqual(["step-1", "step-0"]);
	});

	it("labels and dashes the arrow of a step", () => {
		const edge = flowToSkeleton(steps, "down", palette).find(element => element.id === "edge-2")!;
		expect(edge.label?.text).toBe("emits");
		expect(edge.strokeStyle).toBe("dashed");
		expect(flowToSkeleton(steps, "down", palette).find(element => element.id === "edge-3")!.label).toBeUndefined();
	});

	it("draws one box per step and no arrow for the root", () => {
		const elements = flowToSkeleton(steps, "down", palette);
		expect(elements.filter(element => element.type === "rectangle")).toHaveLength(4);
		expect(elements.find(element => element.id === "edge-0")).toBeUndefined();
	});
});
