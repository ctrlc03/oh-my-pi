/**
 * Where a movable sheet sits and how large it is when the user has moved or resized it. The big sheets (a `full`,
 * `wide` or `settings` {@link Sheet}) share one frame, so switching between them keeps the window where it was; every
 * regular sheet (a form such as Start a session) keeps a frame of its own, since one sized like a code map would leave
 * a short form mostly empty. Everything here is a pure function of numbers in layout px (what CSS speaks, see
 * `zoom.ts`) so the decisions can be tested; the DOM side is `use-sheet-frame.ts`.
 *
 * A saved frame is the user's preference and is never rewritten because the window shrank: the frame on screen is the
 * saved one clamped into the window, and it comes back when the room does.
 */
import { readJson, writeJson } from "./storage";

export interface Frame {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** The window in layout px. */
export interface View {
	width: number;
	height: number;
}

/** A side or corner of the sheet: `n`orth, `s`outh, `e`ast, `w`est, and the four pairs. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const EDGES: readonly Edge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/** Narrowest and shortest a big sheet may be made (a window narrower than this gets the whole window). */
export const MIN_W = 420;
export const MIN_H = 320;

/** Narrowest and shortest a regular sheet may be made: a little under its 380px default width. */
export const PANE_MIN_W = 320;
export const PANE_MIN_H = 200;

/** What an arrow key moves the sheet by, or a Shift+arrow resizes it by. */
export const KEY_STEP = 16;

/** The per-device frame of the big sheets; a regular sheet's is this key and the sheet's name. */
export const FRAME_KEY = "omp.collab.sheet-frame";

/** The smallest a sheet may be made. */
export interface FrameLimits {
	minW: number;
	minH: number;
}

/** Where a sheet's frame is saved, and how small it may be made. */
export interface FrameSlot extends FrameLimits {
	key: string;
}

/** The one frame every big sheet shares. */
export const BIG_SLOT: FrameSlot = { key: FRAME_KEY, minW: MIN_W, minH: MIN_H };

/** The frame of the regular sheet named `name` (its dialog label). */
export function paneSlot(name: string): FrameSlot {
	return { key: `${FRAME_KEY}.${name}`, minW: PANE_MIN_W, minH: PANE_MIN_H };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * `frame` brought into the window: whole pixels, at least `limits` (or the window, where that is smaller), at most the
 * window, and entirely inside it, so the top strip is always reachable.
 */
export function clampFrame(frame: Frame, view: View, limits: FrameLimits = BIG_SLOT): Frame {
	const width = Math.floor(view.width);
	const height = Math.floor(view.height);
	const w = clamp(Math.round(frame.w), Math.min(limits.minW, width), width);
	const h = clamp(Math.round(frame.h), Math.min(limits.minH, height), height);
	return {
		x: clamp(Math.round(frame.x), 0, width - w),
		y: clamp(Math.round(frame.y), 0, height - h),
		w,
		h,
	};
}

/** `frame` moved by `dx`, `dy`, kept inside the window. */
export function moveFrame(frame: Frame, dx: number, dy: number, view: View, limits: FrameLimits = BIG_SLOT): Frame {
	const at = clampFrame(frame, view, limits);
	return clampFrame({ ...at, x: at.x + dx, y: at.y + dy }, view, limits);
}

/** One axis of a resize: `side` is the edge being dragged (`start`: left or top, which moves the origin), null leaves it be. */
function resizeAxis(
	pos: number,
	size: number,
	delta: number,
	side: "start" | "end" | null,
	min: number,
	extent: number,
): [number, number] {
	if (side === null) return [pos, size];
	if (side === "end") return [pos, clamp(size + delta, min, extent - pos)];
	// The far edge stays where it is; the near one follows the pointer until the minimum or the window stops it.
	const far = pos + size;
	const next = clamp(size - delta, min, far);
	return [far - next, next];
}

/**
 * `frame` after dragging `edge` by `dx`, `dy`: the opposite side stays put, dragging a west or north edge moves the
 * origin, and the result keeps the minimum size and stays inside the window.
 */
export function resizeFrame(
	frame: Frame,
	edge: Edge,
	dx: number,
	dy: number,
	view: View,
	limits: FrameLimits = BIG_SLOT,
): Frame {
	const at = clampFrame(frame, view, limits);
	const width = Math.floor(view.width);
	const height = Math.floor(view.height);
	const [x, w] = resizeAxis(
		at.x,
		at.w,
		dx,
		edge.includes("w") ? "start" : edge.includes("e") ? "end" : null,
		Math.min(limits.minW, width),
		width,
	);
	const [y, h] = resizeAxis(
		at.y,
		at.h,
		dy,
		edge.includes("n") ? "start" : edge.includes("s") ? "end" : null,
		Math.min(limits.minH, height),
		height,
	);
	return clampFrame({ x, y, w, h }, view, limits);
}

/**
 * What a key does to the sheet: its new frame, `"reset"` for the default place, or null when the key is not for the
 * handle. Arrows move it, Shift+arrows resize it from its bottom right corner, Home resets.
 */
export function keyFrame(
	key: string,
	shift: boolean,
	frame: Frame,
	view: View,
	limits: FrameLimits = BIG_SLOT,
): Frame | "reset" | null {
	if (key === "Home") return "reset";
	const dx = key === "ArrowLeft" ? -KEY_STEP : key === "ArrowRight" ? KEY_STEP : 0;
	const dy = key === "ArrowUp" ? -KEY_STEP : key === "ArrowDown" ? KEY_STEP : 0;
	if (dx === 0 && dy === 0) return null;
	return shift ? resizeFrame(frame, "se", dx, dy, view, limits) : moveFrame(frame, dx, dy, view, limits);
}

function isFrame(value: unknown): value is Frame {
	if (typeof value !== "object" || value === null) return false;
	const { x, y, w, h } = value as Record<string, unknown>;
	return (
		typeof x === "number" &&
		typeof y === "number" &&
		typeof w === "number" &&
		typeof h === "number" &&
		Number.isFinite(x) &&
		Number.isFinite(y) &&
		Number.isFinite(w) &&
		Number.isFinite(h) &&
		w > 0 &&
		h > 0
	);
}

/** The saved frame out of whatever was stored; anything that is not a usable frame gives none. */
export function parseFrame(raw: unknown): Frame | null {
	return isFrame(raw) ? { x: raw.x, y: raw.y, w: raw.w, h: raw.h } : null;
}

/** The frame saved under `key`, or null when the user has not moved or resized that sheet. */
export function readFrame(key: string): Frame | null {
	return parseFrame(readJson(key));
}

/** Saves the frame under `key`, or forgets it for null (the sheet goes back to its default place and size). */
export function saveFrame(key: string, frame: Frame | null): void {
	writeJson(key, frame);
}
