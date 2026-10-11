/**
 * The pan/zoom model of the diagram viewer. A view is `translate(x, y) scale(scale)` applied to content
 * whose top-left corner is the origin; every function maps one view to the next and is pure, so the pointer
 * handling stays a thin layer over it.
 */

export interface View {
	x: number;
	y: number;
	scale: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 24;
/** Zoom of the fit view never goes past this: a tiny diagram is centred, not blown up. */
const MAX_FIT_SCALE = 3;

export function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The view that shows all of `content` inside `viewport`, centred, with `padding` pixels around it. */
export function fitView(content: Size, viewport: Size, padding = 16): View {
	if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
		return { x: 0, y: 0, scale: 1 };
	}
	const scale = clampScale(
		Math.min(
			MAX_FIT_SCALE,
			(viewport.width - 2 * padding) / content.width,
			(viewport.height - 2 * padding) / content.height,
		),
	);
	return {
		x: (viewport.width - content.width * scale) / 2,
		y: (viewport.height - content.height * scale) / 2,
		scale,
	};
}

/**
 * The view a diagram opens in: all of it when that keeps it at least `minScale` (the smallest zoom at which its
 * text is still readable), otherwise at `minScale` with the start of the diagram in view, to be panned.
 * An axis that fits is centred; one that does not starts `padding` pixels in from the top or left.
 */
export function openingView(content: Size, viewport: Size, minScale: number, padding = 16): View {
	const fit = fitView(content, viewport, padding);
	if (fit.scale >= minScale) return fit;
	const place = (extent: number, room: number): number =>
		extent * minScale + 2 * padding <= room ? (room - extent * minScale) / 2 : padding;
	return { x: place(content.width, viewport.width), y: place(content.height, viewport.height), scale: minScale };
}

/** Zoom by `factor` keeping the content point under `anchor` (viewport coordinates) where it is. */
export function zoomAt(view: View, factor: number, anchor: Point): View {
	const scale = clampScale(view.scale * factor);
	const ratio = scale / view.scale;
	return { x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio, scale };
}

export function panBy(view: View, dx: number, dy: number): View {
	return { ...view, x: view.x + dx, y: view.y + dy };
}

export interface Pair {
	a: Point;
	b: Point;
}

const mid = (pair: Pair): Point => ({ x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 });
const gap = (pair: Pair): number => Math.hypot(pair.a.x - pair.b.x, pair.a.y - pair.b.y);

/** A two-finger gesture from `from` to `to`: the content under the first midpoint follows the second, scaled by the change in finger spread. */
export function pinchView(view: View, from: Pair, to: Pair): View {
	const before = gap(from);
	const factor = before < 1 ? 1 : gap(to) / before;
	const start = mid(from);
	const end = mid(to);
	const zoomed = zoomAt(view, factor, start);
	return panBy(zoomed, end.x - start.x, end.y - start.y);
}

/** Zoom factor of one wheel notch: a trackpad pinch (ctrl + wheel) sends small deltas, a mouse wheel large ones. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
	return Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.0025);
}
