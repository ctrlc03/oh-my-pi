import { describe, expect, it } from "bun:test";
import {
	dragSize,
	KEY_STEP,
	KEY_STEP_SHIFT,
	keyboardSize,
	MIN_MAIN,
	PANE_GAP,
	pxToStored,
	resolvePanes,
	storedToPx,
} from "../src/lib/pane-size";

const ROW = 1424;

describe("resolvePanes", () => {
	it("clamps a pane to its range", () => {
		const [low] = resolvePanes(ROW, [{ id: "sidebar", px: 50 }], null);
		expect(low?.px).toBe(200);
		const [high] = resolvePanes(ROW, [{ id: "sidebar", px: 900 }], null);
		expect(high?.px).toBe(480);
	});

	it("holds split panes between 25% and 75% of the row", () => {
		const [low] = resolvePanes(ROW, [{ id: "beside", px: 10 }], null);
		expect(low?.px).toBeCloseTo(ROW * 0.25);
		const [high] = resolvePanes(ROW, [{ id: "beside", px: ROW }], null);
		expect(high?.px).toBeCloseTo(ROW - MIN_MAIN - PANE_GAP);
	});

	it("keeps the conversation at its minimum width", () => {
		const sizes = resolvePanes(
			ROW,
			[
				{ id: "sidebar", px: 480 },
				{ id: "rail", px: 520 },
				{ id: "beside", px: 700 },
			],
			null,
		);
		const used = sizes.reduce((sum, s) => sum + s.px + PANE_GAP, 0);
		expect(ROW - used).toBeGreaterThanOrEqual(MIN_MAIN);
	});

	it("does not touch the preference when the row shrinks: the same want fits again once it grows", () => {
		const want = [{ id: "rail" as const, px: 400 }];
		expect(resolvePanes(700, want, null)[0]?.px).toBe(700 - MIN_MAIN - PANE_GAP);
		expect(resolvePanes(1400, want, null)[0]?.px).toBe(400);
	});

	it("serves the dragged pane first, so it can take room from the others", () => {
		const wants = [
			{ id: "beside" as const, px: 500 },
			{ id: "editor" as const, px: 500 },
		];
		const normal = resolvePanes(1200, wants, null);
		const dragged = resolvePanes(1200, wants, "editor");
		expect(normal[0]?.px).toBeGreaterThan(dragged[0]?.px ?? Infinity);
		expect(dragged[1]?.px).toBeGreaterThan(normal[1]?.px ?? 0);
		expect(dragged.map(s => s.id)).toEqual(["beside", "editor"]);
	});

	it("gives the minimums to a row too narrow for them", () => {
		const [size] = resolvePanes(500, [{ id: "sidebar", px: 300 }], null);
		expect(size?.px).toBe(200);
		expect(size?.max).toBe(200);
	});
});

describe("keyboardSize", () => {
	const size = { id: "sidebar" as const, px: 300, min: 200, max: 480 };

	it("moves the divider with the arrows: right widens a pane whose divider is on its end edge", () => {
		expect(keyboardSize("ArrowRight", false, "end", size)).toBe(300 + KEY_STEP);
		expect(keyboardSize("ArrowLeft", false, "end", size)).toBe(300 - KEY_STEP);
	});

	it("moves the other way for a pane whose divider is on its start edge", () => {
		expect(keyboardSize("ArrowRight", false, "start", size)).toBe(300 - KEY_STEP);
		expect(keyboardSize("ArrowLeft", true, "start", size)).toBe(300 + KEY_STEP_SHIFT);
	});

	it("stops at the ends of the range", () => {
		expect(keyboardSize("ArrowRight", true, "end", { ...size, px: 470 })).toBe(480);
		expect(keyboardSize("ArrowLeft", true, "end", { ...size, px: 210 })).toBe(200);
	});

	it("maps Home, End and Enter, and ignores other keys", () => {
		expect(keyboardSize("Home", false, "end", size)).toBe(200);
		expect(keyboardSize("End", false, "end", size)).toBe(480);
		expect(keyboardSize("Enter", false, "end", size)).toBe("reset");
		expect(keyboardSize("a", false, "end", size)).toBeNull();
	});
});

describe("drag and storage", () => {
	it("grows a start-edge pane when the pointer moves left", () => {
		expect(dragSize("start", 400, -50)).toBe(450);
		expect(dragSize("end", 400, 50)).toBe(450);
	});

	it("stores pixel panes as pixels and split panes as fractions of the row", () => {
		expect(pxToStored("sidebar", 301.4, ROW)).toBe(301);
		expect(pxToStored("beside", ROW / 2, ROW)).toBeCloseTo(0.5);
		expect(storedToPx("beside", 0.5, 2000)).toBe(1000);
		expect(storedToPx("rail", null, ROW)).toBe(296);
	});
});
