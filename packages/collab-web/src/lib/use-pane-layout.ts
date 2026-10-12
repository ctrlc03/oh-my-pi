/**
 * The DOM side of resizable panes: one layout row (the `.sh-main` flex container), the panes docked in it
 * and a divider between each pane and the transcript. A pane's width is a CSS custom property on the row
 * (`--sh-<pane>-w`, in pixels) that the stylesheet reads, so dragging touches the style and the dividers'
 * `aria-value*` attributes directly and React does not render per pointer move. What fits is decided by
 * `pane-size.ts`; the saved preference only changes when the user resizes or resets.
 */
import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
	dragSize,
	hasStoredSizes,
	keyboardSize,
	PANE_IDS,
	PANE_PRIORITY,
	PANES,
	type PaneId,
	type PaneSize,
	type PaneWant,
	pxToStored,
	readStored,
	resolvePanes,
	storedToPx,
	subscribePaneSizes,
	writeStored,
} from "./pane-size";
import { toLayout } from "./zoom";

interface Drag {
	id: PaneId;
	pointerId: number;
	startX: number;
	startPx: number;
	/** Width on screen after the latest move; null until the pointer moves. */
	px: number | null;
}

/** What a divider element needs: spread onto it. */
export interface SplitterProps {
	ref: (element: HTMLElement | null) => void;
	onPointerDown: (event: PointerEvent<HTMLElement>) => void;
	onPointerMove: (event: PointerEvent<HTMLElement>) => void;
	onPointerUp: (event: PointerEvent<HTMLElement>) => void;
	onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface PaneLayout {
	splitterProps: (id: PaneId) => SplitterProps;
}

/** Two taps on a divider this close together are a double tap. */
const DOUBLE_TAP_MS = 400;

const cssVar = (id: PaneId): string => `--sh-${id}-w`;

/** Content width of the row: what the panes and the transcript share. */
function rowWidth(row: HTMLElement): number {
	const style = getComputedStyle(row);
	return row.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
}

/**
 * Sizes the docked panes in `row`. `docked` lists the panes that are in the row right now (a pane that is
 * an overlay or closed is not listed and gets no width variable).
 */
export function usePaneLayout(row: RefObject<HTMLElement | null>, docked: readonly PaneId[]): PaneLayout {
	const prefs = useRef<Record<PaneId, number | null> | null>(null);
	const handles = useRef<Partial<Record<PaneId, HTMLElement>>>({});
	const drag = useRef<Drag | null>(null);
	/** The pane the user resized last: it is served first for the rest of the session, so the room it took stays its own. */
	const lastResized = useRef<PaneId | null>(null);
	const lastTap = useRef<{ id: PaneId; at: number } | null>(null);
	const dockedRef = useRef(docked);
	dockedRef.current = docked;

	const wants = useCallback((width: number, override?: PaneWant): PaneWant[] => {
		prefs.current ??= { sidebar: null, rail: null, beside: null, editor: null };
		const saved = prefs.current;
		return PANE_PRIORITY.filter(id => dockedRef.current.includes(id)).map(id =>
			override?.id === id ? override : { id, px: storedToPx(id, saved[id], width) },
		);
	}, []);

	/** Writes the widths and divider values for the current preferences (and `override`, the drag in progress). */
	const apply = useCallback(
		(override?: PaneWant): void => {
			const el = row.current;
			if (el === null) return;
			const width = rowWidth(el);
			if (!(width > 0)) return;
			const wanted = wants(width, override);
			const sizes = resolvePanes(width, wanted, override?.id ?? lastResized.current);
			for (const id of PANE_IDS) {
				const size = sizes.find(s => s.id === id);
				if (size === undefined) el.style.removeProperty(cssVar(id));
				else el.style.setProperty(cssVar(id), `${size.px}px`);
			}
			for (const size of sizes) {
				const handle = handles.current[size.id];
				if (handle === undefined) continue;
				// The range the user can reach by dragging this divider: the others give way for it.
				const reach = resolvePanes(width, wanted, size.id).find(s => s.id === size.id) ?? size;
				handle.setAttribute("aria-valuenow", String(Math.round(size.px)));
				handle.setAttribute("aria-valuemin", String(Math.ceil(reach.min)));
				handle.setAttribute("aria-valuemax", String(Math.floor(reach.max)));
			}
		},
		[row, wants],
	);

	/** Width on screen and reachable range of `id`, with it served first. */
	const measure = useCallback(
		(id: PaneId): { size: PaneSize; width: number } | null => {
			const el = row.current;
			if (el === null) return null;
			const width = rowWidth(el);
			const size = resolvePanes(width, wants(width), id).find(s => s.id === id);
			return size === undefined || !(width > 0) ? null : { size, width };
		},
		[row, wants],
	);

	const dockedKey = docked.join();
	// Before paint, so a pane that has just appeared (or a window that opens on a saved size) never shows the default.
	useLayoutEffect(() => {
		prefs.current ??= { sidebar: null, rail: null, beside: null, editor: null };
		for (const id of PANE_IDS) prefs.current[id] = readStored(id);
		apply();
	}, [apply, dockedKey]);

	useEffect(() => {
		const el = row.current;
		if (el === null) return;
		const observer = new ResizeObserver(() => apply());
		observer.observe(el);
		// Reset pane sizes (Settings) and other tabs of this app: read the preferences again.
		const unsubscribe = subscribePaneSizes(() => {
			if (drag.current !== null) return;
			prefs.current ??= { sidebar: null, rail: null, beside: null, editor: null };
			for (const id of PANE_IDS) prefs.current[id] = readStored(id);
			apply();
		});
		return () => {
			observer.disconnect();
			unsubscribe();
			delete el.dataset.resizing;
		};
	}, [apply, row]);

	const save = useCallback((id: PaneId, stored: number | null): void => {
		prefs.current ??= { sidebar: null, rail: null, beside: null, editor: null };
		prefs.current[id] = stored;
		writeStored(id, stored);
	}, []);

	const commit = useCallback(
		(id: PaneId, px: number): void => {
			const el = row.current;
			if (el === null) return;
			const width = rowWidth(el);
			const size = resolvePanes(width, wants(width, { id, px }), id).find(s => s.id === id);
			lastResized.current = id;
			if (size !== undefined) save(id, pxToStored(id, size.px, width));
		},
		[row, save, wants],
	);

	/** A second press-and-release on the divider without a drag, soon after the first, puts the pane back to its default. */
	const finish = useCallback(
		(id: PaneId, handle: HTMLElement, released: boolean): void => {
			const current = drag.current;
			if (current === null || current.id !== id) return;
			drag.current = null;
			handle.removeAttribute("data-dragging");
			if (row.current !== null) delete row.current.dataset.resizing;
			if (current.px !== null) {
				commit(id, current.px);
				lastTap.current = null;
				return;
			}
			if (!released) return;
			const now = performance.now();
			const previous = lastTap.current;
			if (previous !== null && previous.id === id && now - previous.at < DOUBLE_TAP_MS) {
				lastTap.current = null;
				save(id, null);
				apply();
			} else lastTap.current = { id, at: now };
		},
		[apply, commit, row, save],
	);

	const splitterProps = useCallback(
		(id: PaneId): SplitterProps => {
			const spec = PANES[id];
			const setPx = (px: number): void => {
				commit(id, px);
				apply();
			};
			return {
				ref: element => {
					if (element === null) delete handles.current[id];
					else handles.current[id] = element;
				},
				onPointerDown: event => {
					if (event.pointerType === "mouse" && event.button !== 0) return;
					const measured = measure(id);
					if (measured === null) return;
					event.preventDefault();
					event.currentTarget.setPointerCapture(event.pointerId);
					event.currentTarget.focus({ preventScroll: true });
					drag.current = {
						id,
						pointerId: event.pointerId,
						startX: event.clientX,
						startPx: measured.size.px,
						px: null,
					};
					event.currentTarget.setAttribute("data-dragging", "");
					if (row.current !== null) row.current.dataset.resizing = id;
				},
				onPointerMove: event => {
					const current = drag.current;
					if (current === null || current.id !== id || current.pointerId !== event.pointerId) return;
					// Pane widths are layout px; the pointer travels in viewport px, which the UI zoom stretches.
					const wanted = dragSize(spec.edge, current.startPx, toLayout(event.clientX - current.startX));
					const el = row.current;
					if (el === null) return;
					const width = rowWidth(el);
					const size = resolvePanes(width, wants(width, { id, px: wanted }), id).find(s => s.id === id);
					current.px = size?.px ?? wanted;
					apply({ id, px: wanted });
				},
				onPointerUp: event => finish(id, event.currentTarget, true),
				onPointerCancel: event => finish(id, event.currentTarget, false),
				onKeyDown: event => {
					if (event.ctrlKey || event.metaKey || event.altKey) return;
					const measured = measure(id);
					if (measured === null) return;
					const next = keyboardSize(event.key, event.shiftKey, spec.edge, measured.size);
					if (next === null) return;
					event.preventDefault();
					if (next === "reset") {
						save(id, null);
						apply();
					} else setPx(next);
				},
			};
		},
		[apply, commit, finish, measure, row, save, wants],
	);

	return { splitterProps };
}

/** Whether any pane has a saved size (so Settings can offer to forget them). */
export function useHasPaneSizes(): boolean {
	return useSyncExternalStore(subscribePaneSizes, hasStoredSizes, () => false);
}
