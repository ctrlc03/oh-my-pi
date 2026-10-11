/**
 * Touch gesture rules, kept apart from the pointer plumbing so they can be tested: which way a
 * drag is going, when a swipe commits, whether a touch started at a screen edge, and what makes
 * two taps a double tap. Distances are CSS pixels, times milliseconds.
 */

export type Axis = "pending" | "horizontal" | "vertical";

/** A drag decides its direction once it has travelled this far. */
export const INTENT_PX = 10;
/** Horizontal intent: |dx| must exceed |dy| by this factor, so a diagonal scroll is never taken for a swipe. */
export const HORIZONTAL_RATIO = 1.5;

/** Which way a drag of (`dx`, `dy`) is going; pending until it has travelled `INTENT_PX`. */
export function classifyAxis(dx: number, dy: number): Axis {
	const x = Math.abs(dx);
	const y = Math.abs(dy);
	if (Math.max(x, y) < INTENT_PX) return "pending";
	return x > y * HORIZONTAL_RATIO ? "horizontal" : "vertical";
}

/** A block swipe commits after travelling this share of its width... */
export const SWIPE_COMMIT_RATIO = 0.3;
/** ...or, as a quick flick, after this speed (px/ms) over at least `FLICK_MIN_PX`. */
export const FLICK_SPEED = 0.5;
export const FLICK_MIN_PX = 40;

/** What a block swipe does: right quotes the block into the message box, left copies it. */
export type SwipeAction = "send" | "copy";

/** How far a swipe has come toward committing, 0 to 1: drives the reveal of the action icon. */
export function swipeProgress(dx: number, width: number): number {
	if (width <= 0) return 0;
	return Math.min(1, Math.abs(dx) / (width * SWIPE_COMMIT_RATIO));
}

/** Whether a drag of `dx` over `dtMs` has gone far or fast enough to commit. */
function committed(dx: number, dtMs: number, width: number, minPx: number): boolean {
	const distance = Math.abs(dx);
	if (distance >= Math.max(minPx, width * SWIPE_COMMIT_RATIO)) return true;
	return distance >= FLICK_MIN_PX && dtMs > 0 && distance / dtMs >= FLICK_SPEED;
}

/** The action a finished block swipe commits to, or null when it falls short. */
export function resolveBlockSwipe(dx: number, dtMs: number, width: number): SwipeAction | null {
	if (!committed(dx, dtMs, width, FLICK_MIN_PX)) return null;
	return dx > 0 ? "send" : "copy";
}

export type Edge = "left" | "right";

/** How close to a screen edge a touch must start to count as an edge swipe. */
export const EDGE_ZONE_PX = 20;

/** The screen edge a touch at `x` started on, if any. */
export function edgeZone(x: number, viewportWidth: number, zone = EDGE_ZONE_PX): Edge | null {
	if (x <= zone) return "left";
	if (x >= viewportWidth - zone) return "right";
	return null;
}

/** An edge swipe or a drawer swipe commits after this distance, or as a flick. */
export const DRAWER_SWIPE_PX = 60;

/** A swipe from `edge` toward the middle of the screen finished: opens that edge's drawer. */
export function resolveEdgeOpen(edge: Edge, dx: number, dtMs: number): boolean {
	return (edge === "left" ? dx > 0 : dx < 0) && committed(dx, dtMs, 0, DRAWER_SWIPE_PX);
}

/** A swipe inside an open drawer finished: toward its own edge closes it. */
export function resolveDrawerClose(side: Edge, dx: number, dtMs: number): boolean {
	return (side === "left" ? dx < 0 : dx > 0) && committed(dx, dtMs, 0, DRAWER_SWIPE_PX);
}

/** A downward drag that dismisses the keyboard: mostly vertical and long enough. */
export const DISMISS_SWIPE_PX = 40;

export function isDismissSwipe(dx: number, dy: number): boolean {
	return dy >= DISMISS_SWIPE_PX && classifyAxis(dx, dy) === "vertical";
}

/** Two taps are a double tap within this time... */
export const DOUBLE_TAP_MS = 300;
/** ...and this distance. */
export const DOUBLE_TAP_SLOP_PX = 24;

export interface Tap {
	t: number;
	x: number;
	y: number;
}

export function isDoubleTap(previous: Tap | null, next: Tap): boolean {
	if (previous === null) return false;
	return (
		next.t - previous.t <= DOUBLE_TAP_MS && Math.hypot(next.x - previous.x, next.y - previous.y) <= DOUBLE_TAP_SLOP_PX
	);
}

/** A short buzz where the browser has one (not iOS Safari). */
export function haptic(ms = 12): void {
	if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(ms);
}
