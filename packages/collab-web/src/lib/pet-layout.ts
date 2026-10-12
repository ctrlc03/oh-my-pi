/** Where the pet stands: the saved spot as pixels, the default spot above the message box, and back. */

import { CELL_ASPECT } from "./petdex";
import type { PetSpot } from "./pet-settings";

/** Gap kept between the pet and the screen edge or the message box. */
export const PET_MARGIN = 12;

export interface PetPoint {
	x: number;
	y: number;
}

export interface Viewport {
	width: number;
	height: number;
}

/** Left edge of the pet's default spot. */
export function defaultLeft(view: Viewport, size: number): number {
	return Math.max(0, view.width - size - PET_MARGIN);
}

/** Height of the pet's box for a width of `size`. */
export function petHeight(size: number): number {
	return size * CELL_ASPECT;
}

function clamp(value: number, max: number): number {
	return Math.min(Math.max(0, max), Math.max(0, value));
}

/** Room the pet's top-left corner has: the viewport minus the pet. */
function room(view: Viewport, size: number): PetPoint {
	return { x: Math.max(0, view.width - size), y: Math.max(0, view.height - petHeight(size)) };
}

/**
 * Where the pet stands. A saved spot is fractions of the room the viewport leaves, so it survives a resize.
 * Without one the pet sits at the bottom right, above the top of the message box (`dockTop`, the highest edge of what is stacked at the bottom of the session;
 * null on the home screen: the viewport's bottom).
 */
export function homePoint(spot: PetSpot | null, view: Viewport, size: number, dockTop: number | null): PetPoint {
	const free = room(view, size);
	if (spot !== null) return { x: spot.x * free.x, y: spot.y * free.y };
	const bottom = dockTop ?? view.height;
	return { x: defaultLeft(view, size), y: clamp(bottom - petHeight(size) - PET_MARGIN, free.y) };
}

/** The spot for a pet dropped with its top-left at `point`. */
export function spotAt(point: PetPoint, view: Viewport, size: number): PetSpot {
	const free = room(view, size);
	return {
		x: free.x === 0 ? 0 : Math.min(1, Math.max(0, point.x / free.x)),
		y: free.y === 0 ? 0 : Math.min(1, Math.max(0, point.y / free.y)),
	};
}

/** Keeps a dragged pet inside the viewport. */
export function clampPoint(point: PetPoint, view: Viewport, size: number): PetPoint {
	const free = room(view, size);
	return { x: clamp(point.x, free.x), y: clamp(point.y, free.y) };
}

/**
 * The height a roaming pet walks at: its own spot's, lifted when that would put it over the message box, so
 * it never wanders across the text field or the send button.
 */
export function roamY(home: PetPoint, size: number, dockTop: number | null): number {
	if (dockTop === null) return home.y;
	return Math.min(home.y, Math.max(0, dockTop - petHeight(size) - 4));
}
