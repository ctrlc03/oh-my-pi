import { describe, expect, it } from "bun:test";
import {
	clampRatio,
	geometry,
	type LayoutNode,
	leafIds,
	MIN_RATIO,
	neighbour,
	parseLayout,
	reconcile,
	removeLeaf,
	setRatio,
	splitLeaf,
} from "../src/lib/terminal-layout";

const leaf = (id: string): LayoutNode => ({ kind: "leaf", id });

describe("splitLeaf", () => {
	it("puts the new terminal after the target and halves the room", () => {
		const tree = splitLeaf(leaf("a"), "a", "row", "b");
		expect(tree).toEqual({ kind: "split", id: "split-b", axis: "row", ratio: 0.5, first: leaf("a"), second: leaf("b") });
	});

	it("splits a terminal deep in the tree and leaves the rest as it was", () => {
		const two = splitLeaf(leaf("a"), "a", "row", "b");
		const three = splitLeaf(two, "b", "column", "c");
		expect(leafIds(three)).toEqual(["a", "b", "c"]);
		if (two.kind !== "split" || three.kind !== "split") throw new Error("expected splits");
		expect(three.first).toBe(two.first);
	});

	it("ignores a target that is not there", () => {
		const tree = leaf("a");
		expect(splitLeaf(tree, "zzz", "row", "b")).toBe(tree);
	});
});

describe("removeLeaf", () => {
	it("gives the room to the sibling, wherever the divider was", () => {
		const tree = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c");
		expect(removeLeaf(tree, "b")).toEqual({
			kind: "split",
			id: "split-b",
			axis: "row",
			ratio: 0.5,
			first: leaf("a"),
			second: leaf("c"),
		});
		expect(removeLeaf(removeLeaf(tree, "b")!, "a")).toEqual(leaf("c"));
	});

	it("leaves nothing when the last terminal goes", () => {
		expect(removeLeaf(leaf("a"), "a")).toBeNull();
	});
});

describe("setRatio", () => {
	const tree = splitLeaf(leaf("a"), "a", "row", "b");

	it("moves the named divider", () => {
		expect(setRatio(tree, "split-b", 0.3)).toMatchObject({ ratio: 0.3 });
	});

	it("never lets a terminal shrink below the minimum, or take a ratio that is not a number", () => {
		expect(setRatio(tree, "split-b", -5)).toMatchObject({ ratio: MIN_RATIO });
		expect(setRatio(tree, "split-b", 9)).toMatchObject({ ratio: 1 - MIN_RATIO });
		expect(clampRatio(Number.NaN)).toBe(0.5);
	});
});

describe("neighbour", () => {
	const tree = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c");

	it("walks the reading order and wraps", () => {
		expect(neighbour(tree, "a", 1)).toBe("b");
		expect(neighbour(tree, "c", 1)).toBe("a");
		expect(neighbour(tree, "a", -1)).toBe("c");
	});

	it("has nowhere to go with one terminal", () => {
		expect(neighbour(leaf("a"), "a", 1)).toBeNull();
	});
});

describe("reconcile", () => {
	const stored = splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c");

	it("keeps a layout whose terminals all still exist", () => {
		expect(reconcile(stored, ["c", "a", "b"])).toBe(stored);
	});

	it("drops terminals that ended and adds ones the layout never saw", () => {
		const tree = reconcile(stored, ["a", "c", "d"]);
		expect(leafIds(tree!)).toEqual(["a", "c", "d"]);
	});

	it("builds a layout from nothing and is empty when no terminal exists", () => {
		expect(leafIds(reconcile(null, ["x", "y"])!)).toEqual(["x", "y"]);
		expect(reconcile(stored, [])).toBeNull();
		expect(reconcile(null, [])).toBeNull();
	});
});

describe("parseLayout", () => {
	it("reads back what was stored", () => {
		const tree = splitLeaf(leaf("a"), "a", "column", "b");
		expect(parseLayout(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
	});

	it("drops anything that is not a well-formed tree of distinct terminals", () => {
		expect(parseLayout(null)).toBeNull();
		expect(parseLayout({ kind: "leaf" })).toBeNull();
		expect(parseLayout({ kind: "split", id: "s", axis: "diagonal", ratio: 0.5, first: leaf("a"), second: leaf("b") })).toBeNull();
		expect(parseLayout({ kind: "split", id: "s", axis: "row", ratio: 0.5, first: leaf("a"), second: leaf("a") })).toBeNull();
	});

	it("clamps a stored ratio instead of trusting it", () => {
		const read = parseLayout({ kind: "split", id: "s", axis: "row", ratio: 7, first: leaf("a"), second: leaf("b") });
		expect(read).toMatchObject({ ratio: 1 - MIN_RATIO });
	});
});

describe("geometry", () => {
	it("places side-by-side and stacked terminals and their dividers", () => {
		const tree = setRatio(splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c"), "split-b", 0.25);
		const { panes, dividers } = geometry(tree);
		expect(panes).toEqual([
			{ id: "a", area: { x: 0, y: 0, w: 0.25, h: 1 } },
			{ id: "b", area: { x: 0.25, y: 0, w: 0.75, h: 0.5 } },
			{ id: "c", area: { x: 0.25, y: 0.5, w: 0.75, h: 0.5 } },
		]);
		expect(dividers.map(divider => [divider.id, divider.axis, divider.ratio])).toEqual([
			["split-b", "row", 0.25],
			["split-c", "column", 0.5],
		]);
		// The inner divider moves within the area its split was given, not within the whole body.
		expect(dividers[1]!.area).toEqual({ x: 0.25, y: 0, w: 0.75, h: 1 });
	});
});
