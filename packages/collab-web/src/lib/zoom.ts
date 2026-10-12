/**
 * UI zoom: the CSS `zoom` on `<html>` that Settings → Appearance and the zoom shortcuts set, and everything the
 * page has to do so that zoom does not break it.
 *
 * Under CSS zoom Chrome (and Safari) keep two coordinate spaces apart:
 *   - layout px: what `offsetWidth`, `scrollTop`, `clientWidth`, `position: fixed; left: Npx` and every CSS length
 *     speak (so a 200px box is `offsetWidth === 200` however far the page is zoomed);
 *   - viewport px: what `getBoundingClientRect()`, `clientX/Y`, `innerWidth`, `visualViewport` and the root's
 *     `clientWidth` speak (the same box is 300px wide at 150%; any other element's `clientWidth` is layout px).
 * Code that mixes the two (a popover placed from a button's rect, a drag that sets a width, a scroll that is
 * corrected by a rect difference) is off by the zoom factor. {@link toLayout} and {@link layoutRect} bring viewport
 * measurements into layout px; {@link toViewport} goes back. Thresholds that are about a finger (a swipe, a long-press
 * slop, an edge-swipe zone) stay in viewport px on purpose: the finger does not zoom.
 *
 * Media queries do not see CSS zoom either: at 150% a 1440px window lays out in 960 CSS px while `(min-width: 1101px)`
 * still matches. {@link scaleQuery} rescales a query's width breakpoints by the zoom, the stylesheet rules are
 * rewritten with it (see {@link applyZoom}) and the script-side queries go through {@link matchesMedia} /
 * `useMedia`, so CSS and JS keep agreeing on which layout applies.
 *
 * `vw`/`vh`/`dvh` units are viewport units that are then zoomed again, so `100vw` overflows by the zoom factor:
 * base.css defines `--view-w` and `--view-h` (the viewport in layout px) for the stylesheets to use instead.
 */
import { useSyncExternalStore } from "react";

let zoom = 1;
const listeners = new Set<() => void>();

/** The zoom factor applied to the page now (1 = none). */
export function uiZoom(): number {
	return zoom;
}

/** A length measured in viewport px (a rect, a pointer coordinate, `innerWidth`) in layout px. */
export function toLayout(px: number): number {
	return px / zoom;
}

/** A length in layout px (what CSS and `offsetWidth` say) in viewport px. */
export function toViewport(px: number): number {
	return px * zoom;
}

export interface LayoutRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

/** `rect` (from `getBoundingClientRect`) in layout px. */
export function layoutRect(rect: DOMRectReadOnly): LayoutRect {
	return {
		left: toLayout(rect.left),
		top: toLayout(rect.top),
		right: toLayout(rect.right),
		bottom: toLayout(rect.bottom),
		width: toLayout(rect.width),
		height: toLayout(rect.height),
	};
}

/** The window in layout px: the room fixed elements are positioned in. */
export function layoutViewport(): { width: number; height: number } {
	return { width: toLayout(window.innerWidth), height: toLayout(window.innerHeight) };
}

// Width breakpoints in both syntaxes: `(min-width: 641px)` as written, and `(width >= 641px)` / `(641px <= width <= 900px)`
// as the stylesheet minifier rewrites them.
const LEGACY_WIDTH = /\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/g;
const RANGE_RIGHT = /\bwidth\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)px/g;
const RANGE_LEFT = /(\d+(?:\.\d+)?)px\s*(<=|<)\s*width\b/g;

/** A breakpoint the width must reach (`min-width`, `>=`): at whole pixels it pairs with `upper` of the pixel before it. */
function lower(px: number, factor: number): number {
	return Math.floor((px - 1) * factor) + 1;
}

/** A breakpoint the width must not pass (`max-width`, `<=`). */
function upper(px: number, factor: number): number {
	return Math.floor(px * factor);
}

/**
 * `query` as it must be written to hold for a page zoomed by `factor`: each width breakpoint compares the window
 * against a length in layout px, so in viewport px (what a media query measures) it is N × factor. The two halves
 * of the usual `min-width: 641px` / `max-width: 640px` pair stay complementary at whole pixels (no width matches
 * neither or both), and at factor 1 the query is returned as it came.
 */
export function scaleQuery(query: string, factor: number): string {
	if (factor === 1) return query;
	return query
		.replace(LEGACY_WIDTH, (_all, kind: string, px: string) =>
			kind === "min" ? `(min-width: ${lower(Number(px), factor)}px)` : `(max-width: ${upper(Number(px), factor)}px)`,
		)
		.replace(RANGE_LEFT, (_all, px: string, op: string) =>
			op === "<=" ? `${lower(Number(px), factor)}px <= width` : `${Math.floor(Number(px) * factor)}px < width`,
		)
		.replace(RANGE_RIGHT, (_all, op: string, px: string) => {
			const n = Number(px);
			if (op === "<=") return `width <= ${upper(n, factor)}px`;
			if (op === ">=") return `width >= ${lower(n, factor)}px`;
			return op === "<" ? `width < ${Math.ceil(n * factor)}px` : `width > ${Math.floor(n * factor)}px`;
		});
}

/** Whether the media query matches the page as zoomed (the breakpoints in layout px). */
export function matchesMedia(query: string): boolean {
	return matchMedia(scaleQuery(query, zoom)).matches;
}

/** The zoom factor, re-rendering when it changes. */
export function useUiZoom(): number {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		uiZoom,
		() => 1,
	);
}

// --- stylesheet media rules ---

/** What each width-dependent `@media` rule said before it was rescaled. */
const written = new WeakMap<CSSMediaRule, string>();

function scaleRules(rules: CSSRuleList): void {
	for (const rule of Array.from(rules)) {
		if (rule instanceof CSSMediaRule) {
			if (!written.has(rule) && scaleQuery(rule.media.mediaText, 2) !== rule.media.mediaText)
				written.set(rule, rule.media.mediaText);
			const original = written.get(rule);
			if (original !== undefined) {
				const next = scaleQuery(original, zoom);
				if (rule.media.mediaText !== next) rule.media.mediaText = next;
			}
		}
		if ("cssRules" in rule && rule.cssRules instanceof CSSRuleList) scaleRules(rule.cssRules);
	}
}

function scaleSheets(): void {
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			scaleRules(sheet.cssRules);
		} catch {
			// A stylesheet from another origin (the Excalidraw CDN one) cannot be read, and has none of ours.
		}
	}
}

let watching = false;

/** Rules that arrive later (a stylesheet that was still loading, one added by a lazy chunk) follow the zoom too. */
function watchSheets(): void {
	if (watching) return;
	watching = true;
	const onLoad = (): void => scaleSheets();
	const hook = (node: Node): void => {
		if (node instanceof HTMLLinkElement && node.rel === "stylesheet" && node.sheet === null)
			node.addEventListener("load", onLoad, { once: true });
		else if (node instanceof HTMLLinkElement || node instanceof HTMLStyleElement) scaleSheets();
	};
	for (const node of Array.from(document.head.children)) hook(node);
	new MutationObserver(records => {
		for (const record of records) for (const node of Array.from(record.addedNodes)) hook(node);
	}).observe(document.head, { childList: true });
}

/**
 * Applies zoom `factor` (1 = none) to `root`: the `--ui-zoom` variable the stylesheets read and the CSS `zoom`
 * (cleared at 1, so a page at 100% carries no zoom at all), and rescales the stylesheets' width breakpoints.
 * Zoom sits on `<html>` so that everything that renders, the sheets, toasts and menus portalled to `<body>` included, is covered.
 */
export function applyZoom(factor: number, root: HTMLElement): void {
	root.style.setProperty("--ui-zoom", String(factor));
	root.style.zoom = factor === 1 ? "" : String(factor);
	if (factor === zoom) return;
	zoom = factor;
	if (typeof document !== "undefined" && document.head !== null) {
		scaleSheets();
		watchSheets();
	}
	for (const listener of listeners) listener();
}
