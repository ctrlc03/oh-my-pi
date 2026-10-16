import { describe, expect, it } from "bun:test";
import {
	BIG_SLOT,
	clampFrame,
	EDGES,
	FRAME_KEY,
	type Frame,
	KEY_STEP,
	keyFrame,
	MIN_H,
	MIN_W,
	moveFrame,
	PANE_MIN_H,
	PANE_MIN_W,
	paneSlot,
	parseFrame,
	resizeFrame,
} from "../src/lib/sheet-frame";

const VIEW = { width: 1440, height: 900 };
const FRAME: Frame = { x: 200, y: 100, w: 800, h: 600 };

describe("clampFrame", () => {
	it("leaves a frame inside the window alone", () => {
		expect(clampFrame(FRAME, VIEW)).toEqual(FRAME);
	});

	it("pulls a frame that sticks out back inside, keeping its size", () => {
		expect(clampFrame({ x: 1300, y: 700, w: 800, h: 600 }, VIEW)).toEqual({ x: 640, y: 300, w: 800, h: 600 });
		expect(clampFrame({ x: -50, y: -9, w: 800, h: 600 }, VIEW)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
	});

	it("shrinks a frame larger than the window to the window", () => {
		expect(clampFrame({ x: 100, y: 100, w: 3000, h: 2000 }, VIEW)).toEqual({ x: 0, y: 0, w: 1440, h: 900 });
	});

	it("never goes under the minimum size", () => {
		expect(clampFrame({ x: 10, y: 10, w: 100, h: 50 }, VIEW)).toEqual({ x: 10, y: 10, w: MIN_W, h: MIN_H });
	});

	it("gives a window smaller than the minimum the whole window", () => {
		expect(clampFrame(FRAME, { width: 380, height: 300 })).toEqual({ x: 0, y: 0, w: 380, h: 300 });
	});

	it("rounds to whole pixels and clamps against a fractional window", () => {
		expect(clampFrame({ x: 10.4, y: 20.6, w: 500.4, h: 400.5 }, VIEW)).toEqual({ x: 10, y: 21, w: 500, h: 401 });
		expect(clampFrame({ x: 900, y: 0, w: 600, h: 400 }, { width: 1200.7, height: 800 }).x).toBe(600);
	});

	it("brings the saved size back when the window grows again", () => {
		const saved: Frame = { x: 100, y: 50, w: 1200, h: 700 };
		expect(clampFrame(saved, { width: 1000, height: 900 })).toEqual({ x: 0, y: 50, w: 1000, h: 700 });
		expect(clampFrame(saved, VIEW)).toEqual(saved);
	});
});

describe("moveFrame", () => {
	it("moves by the distance", () => {
		expect(moveFrame(FRAME, 30, -40, VIEW)).toEqual({ x: 230, y: 60, w: 800, h: 600 });
	});

	it("stops at the window's edges", () => {
		expect(moveFrame(FRAME, 5000, 5000, VIEW)).toEqual({ x: 640, y: 300, w: 800, h: 600 });
		expect(moveFrame(FRAME, -5000, -5000, VIEW)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
	});
});

describe("resizeFrame", () => {
	it("grows from the east edge, leaving the origin", () => {
		expect(resizeFrame(FRAME, "e", 50, 99, VIEW)).toEqual({ x: 200, y: 100, w: 850, h: 600 });
	});

	it("grows from the south edge, leaving the origin", () => {
		expect(resizeFrame(FRAME, "s", 99, 40, VIEW)).toEqual({ x: 200, y: 100, w: 800, h: 640 });
	});

	it("moves the origin when the west edge is dragged, and keeps the east edge in place", () => {
		const next = resizeFrame(FRAME, "w", -60, 0, VIEW);
		expect(next).toEqual({ x: 140, y: 100, w: 860, h: 600 });
		expect(next.x + next.w).toBe(FRAME.x + FRAME.w);
	});

	it("moves the origin when the north edge is dragged, and keeps the south edge in place", () => {
		const next = resizeFrame(FRAME, "n", 0, 70, VIEW);
		expect(next).toEqual({ x: 200, y: 170, w: 800, h: 530 });
		expect(next.y + next.h).toBe(FRAME.y + FRAME.h);
	});

	it("resizes both axes from a corner", () => {
		expect(resizeFrame(FRAME, "se", 40, 30, VIEW)).toEqual({ x: 200, y: 100, w: 840, h: 630 });
		expect(resizeFrame(FRAME, "nw", -40, -30, VIEW)).toEqual({ x: 160, y: 70, w: 840, h: 630 });
		expect(resizeFrame(FRAME, "ne", 40, -30, VIEW)).toEqual({ x: 200, y: 70, w: 840, h: 630 });
		expect(resizeFrame(FRAME, "sw", -40, 30, VIEW)).toEqual({ x: 160, y: 100, w: 840, h: 630 });
	});

	it("stops at the minimum size, with the opposite side still in place", () => {
		expect(resizeFrame(FRAME, "e", -5000, 0, VIEW)).toEqual({ x: 200, y: 100, w: MIN_W, h: 600 });
		expect(resizeFrame(FRAME, "w", 5000, 0, VIEW)).toEqual({ x: 1000 - MIN_W, y: 100, w: MIN_W, h: 600 });
		expect(resizeFrame(FRAME, "s", 0, -5000, VIEW)).toEqual({ x: 200, y: 100, w: 800, h: MIN_H });
		expect(resizeFrame(FRAME, "n", 0, 5000, VIEW)).toEqual({ x: 200, y: 700 - MIN_H, w: 800, h: MIN_H });
	});

	it("stops at the window's edge", () => {
		expect(resizeFrame(FRAME, "se", 5000, 5000, VIEW)).toEqual({ x: 200, y: 100, w: 1240, h: 800 });
		expect(resizeFrame(FRAME, "nw", -5000, -5000, VIEW)).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
	});

	it("does nothing with a zero drag from any edge or corner", () => {
		for (const edge of EDGES) expect(resizeFrame(FRAME, edge, 0, 0, VIEW)).toEqual(FRAME);
	});

	it("starts from the frame as it fits the window", () => {
		const big: Frame = { x: 0, y: 0, w: 1200, h: 700 };
		expect(resizeFrame(big, "e", 100, 0, { width: 1000, height: 900 })).toEqual({ x: 0, y: 0, w: 1000, h: 700 });
		expect(resizeFrame(big, "e", -100, 0, { width: 1000, height: 900 })).toEqual({ x: 0, y: 0, w: 900, h: 700 });
	});
});

describe("regular sheets", () => {
	const pane = paneSlot("Start a session");
	const form: Frame = { x: 1048, y: 60, w: 380, h: 420 };

	it("can be made narrower and shorter than a big sheet, down to their own minimum", () => {
		expect(resizeFrame(form, "w", 40, 0, VIEW, pane)).toEqual({ ...form, x: 1088, w: 340 });
		expect(resizeFrame(form, "se", -5000, -5000, VIEW, pane)).toEqual({ ...form, w: PANE_MIN_W, h: PANE_MIN_H });
		expect(keyFrame("ArrowUp", true, { ...form, h: PANE_MIN_H }, VIEW, pane)).toEqual({ ...form, h: PANE_MIN_H });
	});

	it("keep a saved size under the big sheets' minimum", () => {
		expect(clampFrame(form, VIEW, pane)).toEqual(form);
		expect(clampFrame(form, VIEW, BIG_SLOT)).toEqual({ ...form, x: 1440 - MIN_W, w: MIN_W });
	});

	it("each save under a key of their own, apart from the frame the big sheets share", () => {
		expect(BIG_SLOT.key).toBe(FRAME_KEY);
		expect(pane.key).not.toBe(FRAME_KEY);
		expect(paneSlot("Agents").key).not.toBe(pane.key);
		expect(paneSlot("Start a session").key).toBe(pane.key);
	});
});

describe("keyFrame", () => {
	it("moves with the arrow keys", () => {
		expect(keyFrame("ArrowRight", false, FRAME, VIEW)).toEqual({ ...FRAME, x: 200 + KEY_STEP });
		expect(keyFrame("ArrowLeft", false, FRAME, VIEW)).toEqual({ ...FRAME, x: 200 - KEY_STEP });
		expect(keyFrame("ArrowUp", false, FRAME, VIEW)).toEqual({ ...FRAME, y: 100 - KEY_STEP });
		expect(keyFrame("ArrowDown", false, FRAME, VIEW)).toEqual({ ...FRAME, y: 100 + KEY_STEP });
	});

	it("resizes with Shift and the arrow keys", () => {
		expect(keyFrame("ArrowRight", true, FRAME, VIEW)).toEqual({ ...FRAME, w: 800 + KEY_STEP });
		expect(keyFrame("ArrowLeft", true, FRAME, VIEW)).toEqual({ ...FRAME, w: 800 - KEY_STEP });
		expect(keyFrame("ArrowDown", true, FRAME, VIEW)).toEqual({ ...FRAME, h: 600 + KEY_STEP });
		expect(keyFrame("ArrowUp", true, FRAME, VIEW)).toEqual({ ...FRAME, h: 600 - KEY_STEP });
	});

	it("keeps the frame inside the window and above the minimum", () => {
		expect(keyFrame("ArrowLeft", false, { ...FRAME, x: 4 }, VIEW)).toEqual({ ...FRAME, x: 0 });
		expect(keyFrame("ArrowLeft", true, { ...FRAME, w: MIN_W }, VIEW)).toEqual({ ...FRAME, w: MIN_W });
	});

	it("resets on Home", () => {
		expect(keyFrame("Home", false, FRAME, VIEW)).toBe("reset");
		expect(keyFrame("Home", true, FRAME, VIEW)).toBe("reset");
	});

	it("leaves every other key alone", () => {
		for (const key of ["Escape", "Enter", "Tab", "a", "End"]) expect(keyFrame(key, false, FRAME, VIEW)).toBeNull();
	});
});

describe("parseFrame", () => {
	it("reads a stored frame and copies only the four numbers", () => {
		expect(parseFrame({ x: 1, y: 2, w: 600, h: 500, extra: "x" })).toEqual({ x: 1, y: 2, w: 600, h: 500 });
	});

	it("gives none for anything that is not a usable frame", () => {
		for (const junk of [
			null,
			undefined,
			7,
			"x",
			true,
			[],
			[{ x: 1, y: 1, w: 500, h: 500 }],
			{ x: 1, y: 2, w: 600 },
			{ x: "1", y: 2, w: 600, h: 500 },
			{ x: Number.NaN, y: 2, w: 600, h: 500 },
			{ x: 1, y: 2, w: Number.POSITIVE_INFINITY, h: 500 },
			{ x: 1, y: 2, w: 0, h: 500 },
			{ x: 1, y: 2, w: 600, h: -5 },
			// The per-sheet map an earlier build stored under another key.
			{ quizzes: { x: 1, y: 2, w: 600, h: 500 } },
		]) {
			expect(parseFrame(junk)).toBeNull();
		}
	});
});
