/** What the pet reads from the page around it: whether it is visible, how big the screen is, where the message box starts. */

import { useEffect, useState, useSyncExternalStore } from "react";
import { measureDockTop, observeDock } from "./pet-dock";
import type { Viewport } from "./pet-layout";
import { toLayout, useUiZoom } from "./zoom";

function subscribeVisibility(listener: () => void): () => void {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
}

/** False while the page is hidden (another tab, a minimised window): the pet freezes and stops its timers. */
export function usePageVisible(): boolean {
	return useSyncExternalStore(
		subscribeVisibility,
		() => document.visibilityState === "visible",
		() => true,
	);
}

function readViewport(): Viewport {
	return { width: toLayout(document.documentElement.clientWidth), height: toLayout(window.innerHeight) };
}

/** The window in layout px (the pet is placed in them), following resizes, rotation and the UI zoom. */
export function useViewport(): Viewport {
	const [view, setView] = useState(readViewport);
	const zoom = useUiZoom();
	useEffect(() => {
		const update = (): void =>
			setView(prev => {
				const next = readViewport();
				return prev.width === next.width && prev.height === next.height ? prev : next;
			});
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, [zoom]);
	return view;
}

/**
 * The highest edge of the session's message box and the bars above it, or null on the home screen.
 * `session` identifies the open session, so the measurement restarts when one opens or closes; `petLeft` is the
 * left edge of the pet's default spot.
 */
export function useDockTop(session: unknown, petLeft: number): number | null {
	const [top, setTop] = useState<number | null>(null);
	useEffect(() => {
		const measure = (): void => setTop(measureDockTop(petLeft));
		measure();
		const stop = observeDock(measure);
		window.addEventListener("resize", measure);
		return () => {
			stop();
			window.removeEventListener("resize", measure);
		};
	}, [session, petLeft]);
	return top;
}
