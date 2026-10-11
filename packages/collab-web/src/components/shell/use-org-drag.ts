import type { PointerEvent as ReactPointerEvent } from "react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
	gapTop,
	insertionIndex,
	type RowBox,
	rowAt,
	rowsBetween,
	slideDelta,
	type ZoneBox,
	zoneAt,
} from "../../lib/org-drag";
import { type DropIntent, type DropZone, dropIntent, type OrgSection } from "../../lib/session-org";

/** What a press-and-drag on a row's Settle / Un-settle / Wake button applies to the rows it sweeps over. */
export type RangeAction = "settle" | "unsettle" | "wake";

export type DragSpec =
	| { kind: "move"; key: string; section: OrgSection }
	| { kind: "range"; key: string; section: OrgSection; action: RangeAction };

/** What the list shows while a drag runs; it changes only when the pointer enters another zone, row or range. */
export interface DragView {
	kind: "move" | "range";
	key: string;
	section: OrgSection;
	/** `move`: the section under the pointer. */
	over: OrgSection | null;
	/** `move`: what dropping here does (null: nothing). */
	intent: DropIntent | null;
	/** `range`: the rows it would apply to, top to bottom. */
	keys: string[];
	action: RangeAction | null;
}

export interface OrgDragOptions {
	rootRef: RefObject<HTMLElement | null>;
	/** The active order is kept, so a row can be reordered within Active. */
	ordered: boolean;
	/** The drop landed: `key` (shown in `from`) goes into `zone` at `index` among that section's rows without it. */
	onDrop(key: string, from: OrgSection, zone: DropZone, index: number): void;
	onRange(action: RangeAction, keys: string[]): void;
}

export interface OrgDrag {
	view: DragView | null;
	/** Start tracking a press; the drag begins once the pointer travelled a few pixels. */
	begin(e: ReactPointerEvent, spec: DragSpec): void;
	/** The floating element that follows the pointer. */
	ghost(el: HTMLElement | null): void;
}

/** Travel before a press becomes a drag: the mouse is steadier than a finger. */
const SLOP_MOUSE_PX = 5;
const SLOP_TOUCH_PX = 3;
/** Near the top or bottom of the list a drag scrolls it. */
const EDGE_PX = 56;
const EDGE_SPEED_PX = 14;

const isDropZone = (section: OrgSection | null): section is DropZone =>
	section === "pinned" || section === "active" || section === "settled";

interface Slide {
	el: HTMLElement;
	top: number;
	delta: number;
}

interface Run {
	spec: DragSpec;
	root: HTMLElement;
	scroller: HTMLElement | null;
	rows: RowBox[];
	zones: ZoneBox[];
	slides: Slide[];
	source: { top: number; height: number };
	size: number;
	/** Where the ghost sits relative to the pointer. */
	grab: { y: number; left: number; width: number };
	signature: string;
	raf: number;
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if (overflow === "auto" || overflow === "scroll") return node;
	}
	return null;
}

/** Added to a viewport y to get its position in the list's content, whatever the scroll. */
function contentBase(scroller: HTMLElement | null): number {
	return scroller === null ? window.scrollY : scroller.scrollTop - scroller.getBoundingClientRect().top;
}

function boxOf(el: HTMLElement, base: number): { top: number; height: number } {
	const rect = el.getBoundingClientRect();
	return { top: rect.top + base, height: rect.height };
}

/** The section under the pointer at `y` (content coordinates); none once the pointer left the list's box, so a row let go outside lands nowhere. */
function sectionUnder(current: Run, point: { x: number; y: number }, y: number): OrgSection | null {
	const rect = current.scroller?.getBoundingClientRect();
	if (rect && (point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom))
		return null;
	return zoneAt(current.zones, y)?.section ?? null;
}

/**
 * Pointer-driven dragging of the rows of the session list: within a section, between sections, and the bulk
 * sweep of a row's Settle / Un-settle / Wake button. Works for mouse and touch (a touch drag starts from a
 * handle with `touch-action: none`). The list marks its parts: `[data-org-zone][data-org-section]` sections,
 * `[data-org-key]` rows, `[data-org-slide]` everything that slides aside to open the gap. Escape cancels.
 */
export function useOrgDrag(options: OrgDragOptions): OrgDrag {
	const [view, setView] = useState<DragView | null>(null);
	const latest = useRef(options);
	latest.current = options;
	const ghostEl = useRef<HTMLElement | null>(null);
	const pointer = useRef({ x: 0, y: 0 });
	const run = useRef<Run | null>(null);
	/** Ends the press being tracked (listeners, frame) without applying it. */
	const abort = useRef<(() => void) | null>(null);

	const place = useCallback((): void => {
		const ghost = ghostEl.current;
		const current = run.current;
		if (!ghost || !current) return;
		const { x, y } = pointer.current;
		const { grab, spec } = current;
		if (spec.kind === "move") {
			ghost.style.width = `${grab.width}px`;
			ghost.style.transform = `translate3d(${grab.left}px, ${y - grab.y}px, 0)`;
		} else ghost.style.transform = `translate3d(${x + 14}px, ${y + 16}px, 0)`;
	}, []);

	const ghost = useCallback(
		(el: HTMLElement | null): void => {
			ghostEl.current = el;
			place();
		},
		[place],
	);

	const slide = useCallback((current: Run, gap: number | null): void => {
		for (const item of current.slides) {
			const delta = gap === null ? 0 : slideDelta(item.top, current.source.top, gap, current.size);
			if (delta === item.delta) continue;
			item.delta = delta;
			item.el.style.transform = delta === 0 ? "" : `translateY(${delta}px)`;
		}
	}, []);

	/** Work out what the pointer is over, slide rows aside, and report a change to the list. */
	const update = useCallback(
		(current: Run): void => {
			place();
			const { spec } = current;
			const y = pointer.current.y + contentBase(current.scroller);
			let next: DragView;
			let gap: number | null = null;
			if (spec.kind === "move") {
				const over = sectionUnder(current, pointer.current, y);
				const zone = isDropZone(over) ? over : null;
				const intent = zone === null ? null : dropIntent(spec.section, zone, latest.current.ordered);
				if (zone === "pinned" || zone === "active") {
					const rest = current.rows.filter(row => row.section === zone && row.key !== spec.key);
					if (intent !== null) gap = gapTop(rest, insertionIndex(rest, y));
				}
				next = { kind: "move", key: spec.key, section: spec.section, over, intent, keys: [], action: null };
			} else {
				const rows = current.rows.filter(row => row.section === spec.section);
				const hovered = rowAt(rows, y) ?? spec.key;
				const keys = rowsBetween(rows, spec.key, hovered);
				next = {
					kind: "range",
					key: spec.key,
					section: spec.section,
					over: null,
					intent: null,
					keys,
					action: spec.action,
				};
			}
			slide(current, gap);
			const signature = `${next.over}|${next.intent}|${next.keys.join(",")}`;
			if (signature !== current.signature) {
				current.signature = signature;
				setView(next);
			}
		},
		[place, slide],
	);

	/** Scrolls the list while the pointer rests near its edge, and keeps the target current meanwhile. */
	const autoscroll = useCallback(
		(current: Run): void => {
			const { scroller } = current;
			if (scroller === null || current.raf !== 0) return;
			const step = (): void => {
				current.raf = 0;
				if (run.current !== current) return;
				const rect = scroller.getBoundingClientRect();
				const top = pointer.current.y - rect.top;
				const bottom = rect.bottom - pointer.current.y;
				const speed = top < EDGE_PX ? -EDGE_SPEED_PX : bottom < EDGE_PX ? EDGE_SPEED_PX : 0;
				if (speed === 0) return;
				scroller.scrollTop += speed;
				update(current);
				current.raf = requestAnimationFrame(step);
			};
			current.raf = requestAnimationFrame(step);
		},
		[update],
	);

	const begin = useCallback(
		(e: ReactPointerEvent, spec: DragSpec): void => {
			if (abort.current !== null || (e.pointerType === "mouse" && e.button !== 0)) return;
			const root = latest.current.rootRef.current;
			if (root === null) return;
			const { pointerId, pointerType } = e;
			const start = { x: e.clientX, y: e.clientY };
			const slop = pointerType === "mouse" ? SLOP_MOUSE_PX : SLOP_TOUCH_PX;
			pointer.current = start;

			const stopClick = (ev: Event): void => {
				ev.stopPropagation();
				ev.preventDefault();
			};

			const activate = (): Run | null => {
				const sourceEl = [...root.querySelectorAll<HTMLElement>("[data-org-key]")].find(
					el => el.dataset.orgKey === spec.key,
				);
				if (!sourceEl) return null;
				// Placeholders of empty sections appear with the drag: measure after they did.
				const fresh: DragView = {
					kind: spec.kind,
					key: spec.key,
					section: spec.section,
					over: null,
					intent: null,
					keys: [],
					action: null,
				};
				flushSync(() => setView(fresh));
				const scroller = scrollerOf(root);
				const base = contentBase(scroller);
				const rows = [...root.querySelectorAll<HTMLElement>("[data-org-key]")].map(el => ({
					key: el.dataset.orgKey ?? "",
					section: el.dataset.orgSection as OrgSection,
					...boxOf(el, base),
				}));
				const zones = [...root.querySelectorAll<HTMLElement>("[data-org-zone]")].map(el => {
					const { top, height } = boxOf(el, base);
					return { section: el.dataset.orgSection as OrgSection, top, bottom: top + height };
				});
				const slides = [...root.querySelectorAll<HTMLElement>("[data-org-slide]")]
					.filter(el => el !== sourceEl)
					.map(el => ({ el, top: boxOf(el, base).top, delta: 0 }));
				const source = boxOf(sourceEl, base);
				const rect = sourceEl.getBoundingClientRect();
				const list = sourceEl.parentElement;
				const gapPx = list === null ? 0 : Number.parseFloat(getComputedStyle(list).rowGap) || 0;
				root.dataset.orgDragging = spec.kind;
				return {
					spec,
					root,
					scroller,
					rows,
					zones,
					slides,
					source,
					size: source.height + gapPx,
					grab: { y: start.y - rect.top, left: rect.left, width: rect.width },
					signature: "",
					raf: 0,
				};
			};

			/** Remove the listeners and every trace of the drag; `drop` says whether it lands. */
			const finish = (drop: boolean): void => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onCancel);
				window.removeEventListener("keydown", onKey, true);
				abort.current = null;
				const current = run.current;
				run.current = null;
				if (current === null) return;
				cancelAnimationFrame(current.raf);
				delete current.root.dataset.orgDragging;
				const landed = drop ? latest.current : null;
				const target = current.spec.kind === "move" && landed !== null ? targetOf(current) : null;
				const range = current.spec.kind === "range" && landed !== null ? rangeOf(current) : null;
				if (landed !== null && (target !== null || range !== null)) {
					// The rows are already where they will be: set them there without animating, in the same frame as the drop.
					current.root.dataset.orgDropping = "";
					for (const item of current.slides) item.el.style.transform = "";
				} else slide(current, null);
				flushSync(() => {
					setView(null);
					if (target !== null && current.spec.kind === "move")
						latest.current.onDrop(current.spec.key, current.spec.section, target.zone, target.index);
					else if (range !== null && current.spec.kind === "range")
						latest.current.onRange(current.spec.action, range);
				});
				requestAnimationFrame(() => delete current.root.dataset.orgDropping);
				// The press that ends a drag must not also click what is under the pointer.
				window.addEventListener("click", stopClick, { capture: true, once: true });
				setTimeout(() => window.removeEventListener("click", stopClick, true), 0);
			};

			const targetOf = (current: Run): { zone: DropZone; index: number } | null => {
				const y = pointer.current.y + contentBase(current.scroller);
				const over = sectionUnder(current, pointer.current, y);
				if (!isDropZone(over)) return null;
				if (current.spec.kind !== "move") return null;
				if (dropIntent(current.spec.section, over, latest.current.ordered) === null) return null;
				const key = current.spec.key;
				const rest = current.rows.filter(row => row.section === over && row.key !== key);
				return { zone: over, index: over === "settled" ? 0 : insertionIndex(rest, y) };
			};

			const rangeOf = (current: Run): string[] | null => {
				if (current.spec.kind !== "range") return null;
				const y = pointer.current.y + contentBase(current.scroller);
				const rows = current.rows.filter(row => row.section === current.spec.section);
				const keys = rowsBetween(rows, current.spec.key, rowAt(rows, y) ?? current.spec.key);
				return keys.length > 1 ? keys : null;
			};

			const onMove = (ev: PointerEvent): void => {
				if (ev.pointerId !== pointerId) return;
				pointer.current = { x: ev.clientX, y: ev.clientY };
				if (run.current === null) {
					if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < slop) return;
					// A sweep is vertical; sideways is a press that wandered off.
					if (spec.kind === "range" && Math.abs(ev.clientY - start.y) < slop) return;
					run.current = activate();
					if (run.current === null) {
						finish(false);
						return;
					}
				}
				update(run.current);
				autoscroll(run.current);
			};
			const onUp = (ev: PointerEvent): void => {
				if (ev.pointerId !== pointerId) return;
				pointer.current = { x: ev.clientX, y: ev.clientY };
				finish(true);
			};
			const onCancel = (ev: PointerEvent): void => {
				if (ev.pointerId === pointerId) finish(false);
			};
			const onKey = (ev: KeyboardEvent): void => {
				if (ev.key !== "Escape" || run.current === null) return;
				ev.preventDefault();
				ev.stopPropagation();
				finish(false);
			};

			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onCancel);
			window.addEventListener("keydown", onKey, true);
			abort.current = () => finish(false);
		},
		[autoscroll, slide, update],
	);

	useEffect(() => () => abort.current?.(), []);

	return { view, begin, ghost };
}
