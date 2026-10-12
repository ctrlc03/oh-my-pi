/**
 * Roaming: what an idle pet does next. The pet walks along one horizontal band, pauses, and sometimes
 * hops. This module decides; the layer animates the plan with transforms in one rAF loop.
 */

export type RoamStep =
	| { kind: "pause"; ms: number }
	| { kind: "walk"; to: number; ms: number; state: "running-left" | "running-right" }
	| { kind: "hop"; ms: number };

/** The hop's length: one loop of the petdex jumping row. */
export const HOP_MS = 840;
const PAUSE_MIN_MS = 1600;
const PAUSE_SPAN_MS = 3400;
/** A walk covers at least this much, so the legs are not seen shuffling on the spot. */
const WALK_MIN_PX = 48;
const HOP_CHANCE = 0.25;

/** Walking speed in px per second: a body length per 0.7 s, never crawling. */
export function walkSpeed(size: number): number {
	return Math.max(40, size * 1.4);
}

/**
 * The step after `previous` for a pet at `x` that may stand anywhere in [`minX`, `maxX`]. `random` yields
 * numbers in [0, 1). A walk always ends inside the band and its state names the direction of travel; a
 * pause follows every walk and hop, so the pet never chains movements.
 */
export function nextRoamStep(
	random: () => number,
	x: number,
	minX: number,
	maxX: number,
	size: number,
	previous: RoamStep["kind"] | null,
): RoamStep {
	const pause = (): RoamStep => ({ kind: "pause", ms: PAUSE_MIN_MS + random() * PAUSE_SPAN_MS });
	if (previous !== "pause" && previous !== null) return pause();
	if (random() < HOP_CHANCE) return { kind: "hop", ms: HOP_MS };
	const left = x - minX;
	const right = maxX - x;
	if (Math.max(left, right) < WALK_MIN_PX) return pause();
	// Prefer the side with room; go either way when both have.
	const goRight = left < WALK_MIN_PX ? true : right < WALK_MIN_PX ? false : random() < 0.5;
	const room = goRight ? right : left;
	const distance = WALK_MIN_PX + random() * (room - WALK_MIN_PX);
	const to = goRight ? x + distance : x - distance;
	return {
		kind: "walk",
		to,
		ms: (distance / walkSpeed(size)) * 1000,
		state: goRight ? "running-right" : "running-left",
	};
}

/** How far above the floor a hop lifts the pet `t` of the way through (0..1): a parabola peaking at `height`. */
export function hopLift(t: number, height: number): number {
	const u = Math.min(1, Math.max(0, t));
	return 4 * height * u * (1 - u);
}
