import { describe, expect, it } from "bun:test";
import {
	BLUEPRINT_EXCERPT_MAX_LINES,
	BLUEPRINT_EXCERPT_STEP,
	type BlueprintExcerpt,
} from "@oh-my-pi/pi-wire/blueprint";
import { linesLeft, widenRequest } from "../src/components/architecture/excerpt-range";

const ref = { path: "a.ts", line: 100, token: "x" };

function excerpt(start: number, end: number, total?: number): BlueprintExcerpt {
	return {
		path: "a.ts",
		start,
		lines: Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`),
		line: 100,
		side: "head",
		commit: "c",
		...(total === undefined ? {} : { total }),
	};
}

describe("linesLeft", () => {
	it("counts the lines above and below, none at either end of the file", () => {
		expect(linesLeft(excerpt(88, 112, 300), "up")).toBe(87);
		expect(linesLeft(excerpt(88, 112, 300), "down")).toBe(188);
		expect(linesLeft(excerpt(1, 112, 300), "up")).toBe(0);
		expect(linesLeft(excerpt(88, 300, 300), "down")).toBe(0);
	});

	it("offers nothing from a companion that does not say how long the file is", () => {
		expect(linesLeft(excerpt(88, 112), "up")).toBe(0);
		expect(linesLeft(excerpt(88, 112), "down")).toBe(0);
	});
});

describe("widenRequest", () => {
	it("asks for the lines held plus a step on the side clicked, for the same ref", () => {
		const step = BLUEPRINT_EXCERPT_STEP;
		expect(widenRequest(ref, excerpt(88, 112, 300), "up")).toEqual({ ...ref, from: 88 - step, to: 112 });
		expect(widenRequest(ref, excerpt(88, 112, 300), "down")).toEqual({ ...ref, from: 88, to: 112 + step });
		expect(widenRequest({ ...ref, side: "base" }, excerpt(88, 112, 300), "up")).toMatchObject({ side: "base" });
	});

	it("stops at the file's ends", () => {
		expect(widenRequest(ref, excerpt(10, 112, 300), "up")).toEqual({ ...ref, from: 1, to: 112 });
		expect(widenRequest(ref, excerpt(88, 295, 300), "down")).toEqual({ ...ref, from: 88, to: 300 });
	});

	it("gives way on the far side at the most lines one excerpt may have, so the click still shows lines on its own", () => {
		const max = BLUEPRINT_EXCERPT_MAX_LINES;
		const full = excerpt(1_000, 1_000 + max - 1, 10_000);
		expect(widenRequest(ref, full, "up")).toEqual({
			...ref,
			from: 1_000 - BLUEPRINT_EXCERPT_STEP,
			to: 1_000 - BLUEPRINT_EXCERPT_STEP + max - 1,
		});
		const down = widenRequest(ref, full, "down");
		expect(down.to).toBe(1_000 + max - 1 + BLUEPRINT_EXCERPT_STEP);
		expect(down.to! - down.from! + 1).toBe(max);
	});
});
