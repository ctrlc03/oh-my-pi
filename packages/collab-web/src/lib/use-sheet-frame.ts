/**
 * The DOM side of a movable, resizable sheet (decisions are in `sheet-frame.ts`). While a drag runs the panel and its
 * handle layer are written directly, one `requestAnimationFrame` at a time, so React does not render per pointer
 * move; the frame is committed to state and storage when the pointer is released. Lengths are layout px: the pointer
 * travels in viewport px, which the UI zoom stretches (see `zoom.ts`).
 */
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	clampFrame,
	type Edge,
	type Frame,
	keyFrame,
	moveFrame,
	readFrame,
	resizeFrame,
	saveFrame,
	type View,
} from "./sheet-frame";
import { layoutViewport, toLayout, useUiZoom } from "./zoom";

/** The pointer must travel this far (viewport px) before a press on the bar counts as a drag, so a click saves nothing. */
const DRAG_SLOP = 3;
/** Two presses on the bar without a drag, this close together (ms), put the sheet back to its default. */
const DOUBLE_PRESS_MS = 400;

/** Where a press starts a move: the header rows of the sheets (Settings has its own). */
const HEAD_SELECTOR = ".sh-sheet-head, .sh-set-nav-head, .sh-set-head";
/** What a press on the header must leave alone. */
const INTERACTIVE_SELECTOR =
	'button, a, input, select, textarea, label, summary, [role="button"], [role="tab"], [role="switch"], [role="combobox"], [contenteditable="true"]';

/** `data-sheet-drag` on `<html>` while a drag runs: no text selection (see `sheet-frame.css`). */
const DRAG_ATTRIBUTE = "sheetDrag";

export type Grab = Edge | "move";

export interface SheetFrame {
	/** Inline style of the panel: its frame, or undefined while it is at its default place and size. */
	style: CSSProperties | undefined;
	/** The handle layer that sits over the panel; kept in step with it. */
	layer: RefObject<HTMLDivElement | null>;
	/** A press on the panel: starts a move from its header. */
	onPanelPointerDown(event: ReactPointerEvent<HTMLElement>): void;
	/** A press on a handle: starts a move or a resize from that edge. */
	grab(event: ReactPointerEvent<HTMLElement>, how: Grab): void;
	/** The move handle's keys. */
	onHandleKeyDown(event: KeyboardEvent<HTMLElement>): void;
}

function frameStyle(frame: Frame): CSSProperties {
	return {
		left: frame.x,
		top: frame.y,
		width: frame.w,
		height: frame.h,
		right: "auto",
		bottom: "auto",
		maxHeight: "none",
	};
}

function paintLayer(layer: HTMLElement, frame: Frame): void {
	layer.style.left = `${frame.x}px`;
	layer.style.top = `${frame.y}px`;
	layer.style.width = `${frame.w}px`;
	layer.style.height = `${frame.h}px`;
}

function paintPanel(panel: HTMLElement, frame: Frame): void {
	for (const [name, value] of Object.entries(frameStyle(frame))) {
		panel.style.setProperty(
			name === "maxHeight" ? "max-height" : name,
			typeof value === "number" ? `${value}px` : String(value),
		);
	}
}

/** Where the panel is now, in layout px (unmoved by its entry animation). */
function measure(panel: HTMLElement): Frame {
	return { x: panel.offsetLeft, y: panel.offsetTop, w: panel.offsetWidth, h: panel.offsetHeight };
}

/**
 * `enabled` turns the whole thing on (a floating frame only makes sense with a fine pointer and room). Every big sheet
 * reads and writes the one shared frame. Nothing is saved until the user moves or resizes.
 */
export function useSheetFrame(enabled: boolean, panel: RefObject<HTMLDivElement | null>): SheetFrame {
	const zoom = useUiZoom();
	const [saved, setSaved] = useState(readFrame);
	const [view, setView] = useState<View>(layoutViewport);
	useEffect(() => {
		if (!enabled) return;
		const sync = (): void =>
			setView(previous => {
				const next = layoutViewport();
				return previous.width === next.width && previous.height === next.height ? previous : next;
			});
		sync();
		window.addEventListener("resize", sync);
		return () => window.removeEventListener("resize", sync);
	}, [enabled, zoom]);

	// The saved frame as it fits the window now; the saved one itself is never rewritten by a smaller window.
	const frame = useMemo(() => (enabled && saved !== null ? clampFrame(saved, view) : null), [enabled, saved, view]);

	const layer = useRef<HTMLDivElement>(null);
	const syncLayer = useCallback((): void => {
		if (panel.current !== null && layer.current !== null) paintLayer(layer.current, measure(panel.current));
	}, [panel]);
	// Before paint, so the handles are never seen where the panel was.
	useLayoutEffect(() => {
		syncLayer();
	}, [syncLayer, enabled, frame, view]);
	useEffect(() => {
		const node = panel.current;
		if (!enabled || node === null) return;
		// A wide sheet is as tall as its content, which changes as it loads.
		const observer = new ResizeObserver(syncLayer);
		observer.observe(node);
		return () => observer.disconnect();
	}, [enabled, panel, syncLayer]);

	const stop = useRef<(() => void) | null>(null);
	const lastPress = useRef(Number.NEGATIVE_INFINITY);
	useEffect(() => () => stop.current?.(), []);

	const commit = useCallback((next: Frame | null): void => {
		saveFrame(next);
		setSaved(next);
	}, []);

	const begin = useCallback(
		(start: { pointerId: number; clientX: number; clientY: number }, how: Grab, holder: HTMLElement): void => {
			const node = panel.current;
			if (node === null) return;
			stop.current?.();
			const room = layoutViewport();
			const from = clampFrame(measure(node), room);
			let latest = from;
			let moved = false;
			let pending = 0;
			holder.setPointerCapture(start.pointerId);
			document.documentElement.dataset[DRAG_ATTRIBUTE] = how;

			const paint = (): void => {
				pending = 0;
				paintPanel(node, latest);
				if (layer.current !== null) paintLayer(layer.current, latest);
			};
			const onMove = (event: PointerEvent): void => {
				if (event.pointerId !== start.pointerId) return;
				const travelX = event.clientX - start.clientX;
				const travelY = event.clientY - start.clientY;
				if (!moved && Math.hypot(travelX, travelY) < DRAG_SLOP) return;
				moved = true;
				const dx = toLayout(travelX);
				const dy = toLayout(travelY);
				latest = how === "move" ? moveFrame(from, dx, dy, room) : resizeFrame(from, how, dx, dy, room);
				if (pending === 0) pending = requestAnimationFrame(paint);
			};
			// `released`: the pointer went up (a cancelled press is not half of a double press).
			const finish = (released: boolean): void => {
				holder.removeEventListener("pointermove", onMove);
				holder.removeEventListener("pointerup", onEnd);
				holder.removeEventListener("pointercancel", onEnd);
				cancelAnimationFrame(pending);
				if (holder.hasPointerCapture(start.pointerId)) holder.releasePointerCapture(start.pointerId);
				delete document.documentElement.dataset[DRAG_ATTRIBUTE];
				stop.current = null;
				if (moved) {
					lastPress.current = Number.NEGATIVE_INFINITY;
					paint();
					commit(latest);
				} else if (released && how === "move") {
					// Not the browser's `dblclick`: the press was captured, so that event is aimed at the capturing element.
					const now = performance.now();
					if (now - lastPress.current < DOUBLE_PRESS_MS) {
						lastPress.current = Number.NEGATIVE_INFINITY;
						// The second press selects a word of the title.
						getSelection()?.removeAllRanges();
						commit(null);
					} else lastPress.current = now;
				}
			};
			const onEnd = (event: PointerEvent): void => {
				if (event.pointerId === start.pointerId) finish(event.type === "pointerup");
			};
			holder.addEventListener("pointermove", onMove);
			holder.addEventListener("pointerup", onEnd);
			holder.addEventListener("pointercancel", onEnd);
			stop.current = () => finish(false);
		},
		[commit, panel],
	);

	const onHeader = (event: { target: EventTarget; currentTarget: Element }): boolean => {
		// A sheet opened from this one is a React child through its portal: its presses reach here too.
		if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return false;
		return event.target.closest(HEAD_SELECTOR) !== null && event.target.closest(INTERACTIVE_SELECTOR) === null;
	};

	return {
		style: frame === null ? undefined : frameStyle(frame),
		layer,
		onPanelPointerDown: event => {
			if (!enabled || event.button !== 0 || !event.isPrimary || event.pointerType === "touch") return;
			if (onHeader(event)) begin(event.nativeEvent, "move", event.currentTarget);
		},
		grab: (event, how) => {
			if (event.button !== 0 || !event.isPrimary) return;
			event.preventDefault();
			begin(event.nativeEvent, how, event.currentTarget);
		},
		onHandleKeyDown: event => {
			if (event.ctrlKey || event.metaKey || event.altKey || panel.current === null) return;
			const room = layoutViewport();
			const next = keyFrame(event.key, event.shiftKey, clampFrame(measure(panel.current), room), room);
			if (next === null) return;
			event.preventDefault();
			commit(next === "reset" ? null : next);
		},
	};
}
