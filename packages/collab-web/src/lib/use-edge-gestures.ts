import { useEffect, useRef } from "react";
import {
	classifyAxis,
	type Edge,
	edgeZone,
	haptic,
	isDismissSwipe,
	resolveDrawerClose,
	resolveEdgeOpen,
} from "./gestures";

/** Where the drawers stand and how to move them; read at gesture time, so it may change every render. */
export interface EdgeGestureState {
	/** The sessions sidebar has something to show, so a swipe from the left edge may open it. */
	canOpenSidebar: boolean;
	/** The sidebar is open as a drawer over the transcript (not docked beside it). */
	sidebarDrawerOpen: boolean;
	railOpen: boolean;
	setSidebar(open: boolean): void;
	setRail(open: boolean): void;
}

/** What a touch that just began may turn into. */
type Intent = { kind: "open"; edge: Edge } | { kind: "close"; side: Edge };

interface Start {
	intent: Intent;
	x: number;
	y: number;
	t: number;
}

/** The composer's field, when it has the focus (the keyboard is up on a phone). */
function focusedComposerField(): HTMLElement | null {
	const active = document.activeElement;
	return active instanceof HTMLElement &&
		active.closest(".sh-composer") !== null &&
		/^(TEXTAREA|INPUT)$/.test(active.tagName)
		? active
		: null;
}

/**
 * App-level touch gestures: a swipe in from the left edge opens the sessions sidebar, from the right
 * edge the agents rail, a swipe toward its own edge closes an open drawer, and a downward swipe on the
 * composer while the keyboard is up hides the keyboard. Touch only; ignored while a sheet is open.
 */
export function useEdgeGestures(state: EdgeGestureState): void {
	const latest = useRef(state);
	latest.current = state;

	useEffect(() => {
		let start: Start | null = null;

		const onDown = (e: PointerEvent): void => {
			start = null;
			if (e.pointerType !== "touch" || !e.isPrimary || document.querySelector('[role="dialog"]') !== null) return;
			const target = e.target;
			if (!(target instanceof Element)) return;
			const now = latest.current;
			let intent: Intent | null = null;
			if (now.sidebarDrawerOpen && target.closest(".sh-sidebar-dock, .sh-sidebar-backdrop") !== null) {
				intent = { kind: "close", side: "left" };
			} else if (now.railOpen && target.closest(".sh-rail, .sh-rail-backdrop") !== null) {
				intent = { kind: "close", side: "right" };
			} else if (edgeZone(e.clientX, window.innerWidth) !== null) {
				intent = { kind: "open", edge: edgeZone(e.clientX, window.innerWidth)! };
			}
			if (intent !== null) start = { intent, x: e.clientX, y: e.clientY, t: e.timeStamp };
		};

		const onUp = (e: PointerEvent): void => {
			const began = start;
			start = null;
			if (began === null) return;
			const dx = e.clientX - began.x;
			const dt = e.timeStamp - began.t;
			if (classifyAxis(dx, e.clientY - began.y) !== "horizontal") return;
			const now = latest.current;
			const { intent } = began;
			if (intent.kind === "open" && resolveEdgeOpen(intent.edge, dx, dt)) {
				if (intent.edge === "left" && now.canOpenSidebar && !now.sidebarDrawerOpen) now.setSidebar(true);
				else if (intent.edge === "right" && !now.railOpen) now.setRail(true);
				else return;
				haptic();
			} else if (intent.kind === "close" && resolveDrawerClose(intent.side, dx, dt)) {
				if (intent.side === "left") now.setSidebar(false);
				else now.setRail(false);
				haptic();
			}
		};

		const onCancel = (): void => {
			start = null;
		};

		// The composer scrolls vertically, so the browser takes a downward drag over it and cancels its pointer
		// events; touch events keep coming, so the keyboard dismissal is read from those.
		let dismissFrom: Touch | null = null;
		const onTouchStart = (e: TouchEvent): void => {
			const target = e.target;
			const first = e.touches[0];
			dismissFrom =
				e.touches.length === 1 &&
				first !== undefined &&
				target instanceof Element &&
				target.closest(".sh-composer") !== null &&
				focusedComposerField() !== null &&
				document.querySelector('[role="dialog"]') === null
					? first
					: null;
		};
		const onTouchMove = (e: TouchEvent): void => {
			const first = e.touches[0];
			if (dismissFrom === null || first === undefined) return;
			if (!isDismissSwipe(first.clientX - dismissFrom.clientX, first.clientY - dismissFrom.clientY)) return;
			dismissFrom = null;
			focusedComposerField()?.blur();
		};
		const onTouchEnd = (): void => {
			dismissFrom = null;
		};

		window.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointercancel", onCancel, true);
		window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
		window.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
		window.addEventListener("touchend", onTouchEnd, true);
		window.addEventListener("touchcancel", onTouchEnd, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointercancel", onCancel, true);
			window.removeEventListener("touchstart", onTouchStart, true);
			window.removeEventListener("touchmove", onTouchMove, true);
			window.removeEventListener("touchend", onTouchEnd, true);
			window.removeEventListener("touchcancel", onTouchEnd, true);
		};
	}, []);
}
