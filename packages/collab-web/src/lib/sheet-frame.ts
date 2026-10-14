/**
 * Where a big sheet (a `full`, `wide` or `settings` {@link Sheet}) sits and how large it is when the user has moved or
 * resized it. Everything here is a pure function of numbers in layout px (what CSS speaks, see `zoom.ts`) so the
 * decisions can be tested; the DOM side is `use-sheet-frame.ts`.
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

/** Narrowest and shortest a sheet may be made (a window narrower than this gets the whole window). */
export const MIN_W = 420;
export const MIN_H = 320;

/** What an arrow key moves the sheet by, or a Shift+arrow resizes it by. */
export const KEY_STEP = 16;

/** Per-device map from a sheet's key to its frame. */
export const FRAMES_KEY = "omp.collab.sheet-frames";

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * `frame` brought into the window: whole pixels, at least {@link MIN_W} by {@link MIN_H} (or the window, where that is
 * smaller), at most the window, and entirely inside it, so the top strip is always reachable.
 */
export function clampFrame(frame: Frame, view: View): Frame {
	const width = Math.floor(view.width);
	const height = Math.floor(view.height);
	const w = clamp(Math.round(frame.w), Math.min(MIN_W, width), width);
	const h = clamp(Math.round(frame.h), Math.min(MIN_H, height), height);
	return {
		x: clamp(Math.round(frame.x), 0, width - w),
		y: clamp(Math.round(frame.y), 0, height - h),
		w,
		h,
	};
}

/** `frame` moved by `dx`, `dy`, kept inside the window. */
export function moveFrame(frame: Frame, dx: number, dy: number, view: View): Frame {
	const at = clampFrame(frame, view);
	return clampFrame({ ...at, x: at.x + dx, y: at.y + dy }, view);
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
export function resizeFrame(frame: Frame, edge: Edge, dx: number, dy: number, view: View): Frame {
	const at = clampFrame(frame, view);
	const width = Math.floor(view.width);
	const height = Math.floor(view.height);
	const [x, w] = resizeAxis(
		at.x,
		at.w,
		dx,
		edge.includes("w") ? "start" : edge.includes("e") ? "end" : null,
		Math.min(MIN_W, width),
		width,
	);
	const [y, h] = resizeAxis(
		at.y,
		at.h,
		dy,
		edge.includes("n") ? "start" : edge.includes("s") ? "end" : null,
		Math.min(MIN_H, height),
		height,
	);
	return clampFrame({ x, y, w, h }, view);
}

/**
 * What a key does to the sheet: its new frame, `"reset"` for the default place, or null when the key is not for the
 * handle. Arrows move it, Shift+arrows resize it from its bottom right corner, Home resets.
 */
export function keyFrame(key: string, shift: boolean, frame: Frame, view: View): Frame | "reset" | null {
	if (key === "Home") return "reset";
	const dx = key === "ArrowLeft" ? -KEY_STEP : key === "ArrowRight" ? KEY_STEP : 0;
	const dy = key === "ArrowUp" ? -KEY_STEP : key === "ArrowDown" ? KEY_STEP : 0;
	if (dx === 0 && dy === 0) return null;
	return shift ? resizeFrame(frame, "se", dx, dy, view) : moveFrame(frame, dx, dy, view);
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

/** The saved frames out of whatever was stored: entries that are not a usable frame are dropped, anything else gives none. */
export function parseFrames(raw: unknown): Map<string, Frame> {
	const frames = new Map<string, Frame>();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return frames;
	for (const [key, value] of Object.entries(raw)) {
		if (isFrame(value)) frames.set(key, { x: value.x, y: value.y, w: value.w, h: value.h });
	}
	return frames;
}

/** `frames` with `key` set to `frame`, or forgotten for null (so that sheet is back at its default place and size). */
export function withFrame(frames: ReadonlyMap<string, Frame>, key: string, frame: Frame | null): Map<string, Frame> {
	const next = new Map(frames);
	if (frame === null) next.delete(key);
	else next.set(key, frame);
	return next;
}

/** The saved frame of the sheet `key`, or null when the user has not moved or resized it. */
export function readFrame(key: string): Frame | null {
	return parseFrames(readJson(FRAMES_KEY)).get(key) ?? null;
}

/** Saves (or, for null, forgets) one sheet's frame, leaving the others as the device has them now. */
export function saveFrame(key: string, frame: Frame | null): void {
	const next = withFrame(parseFrames(readJson(FRAMES_KEY)), key, frame);
	writeJson(FRAMES_KEY, next.size === 0 ? null : Object.fromEntries(next));
}
