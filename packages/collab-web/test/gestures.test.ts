import { describe, expect, it } from "bun:test";
import {
	classifyAxis,
	DISMISS_SWIPE_PX,
	DOUBLE_TAP_MS,
	DOUBLE_TAP_SLOP_PX,
	DRAWER_SWIPE_PX,
	EDGE_ZONE_PX,
	edgeZone,
	FLICK_MIN_PX,
	INTENT_PX,
	isDismissSwipe,
	isDoubleTap,
	resolveBlockSwipe,
	resolveDrawerClose,
	resolveEdgeOpen,
	SWIPE_COMMIT_RATIO,
	swipeProgress,
} from "../src/lib/gestures";

const WIDTH = 400;

describe("drag direction", () => {
	it("stays undecided until the finger has travelled the intent distance", () => {
		expect(classifyAxis(INTENT_PX - 1, 0)).toBe("pending");
		expect(classifyAxis(0, -(INTENT_PX - 1))).toBe("pending");
	});

	it("takes a mostly sideways drag for horizontal and anything else for vertical", () => {
		expect(classifyAxis(INTENT_PX * 3, INTENT_PX)).toBe("horizontal");
		expect(classifyAxis(-INTENT_PX * 3, INTENT_PX)).toBe("horizontal");
		expect(classifyAxis(INTENT_PX * 2, INTENT_PX * 2)).toBe("vertical");
		expect(classifyAxis(0, INTENT_PX * 2)).toBe("vertical");
	});

	it("needs more than 1.5 times the vertical travel to count as horizontal", () => {
		expect(classifyAxis(30, 20)).toBe("vertical");
		expect(classifyAxis(31, 20)).toBe("horizontal");
	});
});

describe("block swipe", () => {
	const slow = 10_000;

	it("commits right to send and left to copy past the commit share of the width", () => {
		const far = WIDTH * SWIPE_COMMIT_RATIO;
		expect(resolveBlockSwipe(far, slow, WIDTH)).toBe("send");
		expect(resolveBlockSwipe(-far, slow, WIDTH)).toBe("copy");
	});

	it("snaps back when it falls short and is slow", () => {
		expect(resolveBlockSwipe(WIDTH * SWIPE_COMMIT_RATIO - 1, slow, WIDTH)).toBeNull();
		expect(resolveBlockSwipe(-20, slow, WIDTH)).toBeNull();
	});

	it("commits a quick flick over a short distance", () => {
		expect(resolveBlockSwipe(FLICK_MIN_PX + 5, 40, WIDTH)).toBe("send");
		expect(resolveBlockSwipe(-(FLICK_MIN_PX + 5), 40, WIDTH)).toBe("copy");
	});

	it("does not count a tiny, fast twitch as a flick", () => {
		expect(resolveBlockSwipe(FLICK_MIN_PX - 5, 1, WIDTH)).toBeNull();
	});

	it("reports progress from nothing to full, either direction", () => {
		expect(swipeProgress(0, WIDTH)).toBe(0);
		expect(swipeProgress(WIDTH * SWIPE_COMMIT_RATIO, WIDTH)).toBe(1);
		expect(swipeProgress(-WIDTH, WIDTH)).toBe(1);
		expect(swipeProgress(30, WIDTH)).toBeGreaterThan(0);
		expect(swipeProgress(30, WIDTH)).toBeLessThan(1);
		expect(swipeProgress(30, 0)).toBe(0);
	});
});

describe("screen edges", () => {
	it("recognises a touch that starts inside the edge zone", () => {
		expect(edgeZone(0, WIDTH)).toBe("left");
		expect(edgeZone(EDGE_ZONE_PX, WIDTH)).toBe("left");
		expect(edgeZone(WIDTH, WIDTH)).toBe("right");
		expect(edgeZone(WIDTH - EDGE_ZONE_PX, WIDTH)).toBe("right");
		expect(edgeZone(WIDTH / 2, WIDTH)).toBeNull();
		expect(edgeZone(EDGE_ZONE_PX + 1, WIDTH)).toBeNull();
	});

	it("opens a drawer only for a swipe toward the middle", () => {
		expect(resolveEdgeOpen("left", DRAWER_SWIPE_PX, 10_000)).toBe(true);
		expect(resolveEdgeOpen("left", -DRAWER_SWIPE_PX, 10_000)).toBe(false);
		expect(resolveEdgeOpen("right", -DRAWER_SWIPE_PX, 10_000)).toBe(true);
		expect(resolveEdgeOpen("right", DRAWER_SWIPE_PX, 10_000)).toBe(false);
	});

	it("needs distance or a flick to open", () => {
		expect(resolveEdgeOpen("left", DRAWER_SWIPE_PX - 1, 10_000)).toBe(false);
		expect(resolveEdgeOpen("left", FLICK_MIN_PX + 5, 40)).toBe(true);
	});

	it("closes a drawer for a swipe toward its own edge only", () => {
		expect(resolveDrawerClose("left", -DRAWER_SWIPE_PX, 10_000)).toBe(true);
		expect(resolveDrawerClose("left", DRAWER_SWIPE_PX, 10_000)).toBe(false);
		expect(resolveDrawerClose("right", DRAWER_SWIPE_PX, 10_000)).toBe(true);
		expect(resolveDrawerClose("right", -DRAWER_SWIPE_PX, 10_000)).toBe(false);
	});
});

describe("keyboard dismiss", () => {
	it("takes a long, mostly vertical, downward drag", () => {
		expect(isDismissSwipe(0, DISMISS_SWIPE_PX)).toBe(true);
		expect(isDismissSwipe(5, DISMISS_SWIPE_PX * 2)).toBe(true);
	});

	it("ignores upward, short and sideways drags", () => {
		expect(isDismissSwipe(0, -DISMISS_SWIPE_PX * 2)).toBe(false);
		expect(isDismissSwipe(0, DISMISS_SWIPE_PX - 1)).toBe(false);
		expect(isDismissSwipe(DISMISS_SWIPE_PX * 2, DISMISS_SWIPE_PX)).toBe(false);
	});
});

describe("double tap", () => {
	const first = { t: 1000, x: 100, y: 100 };

	it("needs a previous tap", () => {
		expect(isDoubleTap(null, first)).toBe(false);
	});

	it("takes two close taps in quick succession", () => {
		expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS, x: 104, y: 98 })).toBe(true);
	});

	it("rejects slow or distant second taps", () => {
		expect(isDoubleTap(first, { t: 1000 + DOUBLE_TAP_MS + 1, x: 100, y: 100 })).toBe(false);
		expect(isDoubleTap(first, { t: 1100, x: 100 + DOUBLE_TAP_SLOP_PX + 1, y: 100 })).toBe(false);
	});
});
