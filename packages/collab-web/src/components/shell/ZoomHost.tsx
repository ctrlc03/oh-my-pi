import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import {
	currentAppearance,
	DEFAULT_APPEARANCE,
	setAppearance,
	stepZoom,
	useAppearance,
	ZOOM_STEPS,
} from "../../lib/appearance";
import { type PaletteEntry, usePaletteEntries } from "../../lib/palette";
import { IS_MAC, shortcutFires } from "../../lib/shortcuts";

function zoomBy(direction: 1 | -1): void {
	setAppearance({ zoom: stepZoom(currentAppearance().zoom, direction) });
}

function resetZoom(): void {
	setAppearance({ zoom: DEFAULT_APPEARANCE.zoom });
}

/**
 * Zoom's keys and palette actions, mounted once at the app's top: Zoom in, Zoom out and Reset zoom step through the
 * same sizes as Settings → Appearance. An action that would do nothing (zoom in at the largest size, reset at 100%)
 * is not offered.
 */
export function ZoomHost(): ReactNode {
	const { zoom } = useAppearance();

	const entries = useMemo<readonly PaletteEntry[]>(() => {
		const list: PaletteEntry[] = [];
		const keywords = ["zoom", "scale", "size", "magnify", "bigger", "smaller", "larger"];
		if (zoom < ZOOM_STEPS[ZOOM_STEPS.length - 1]!)
			list.push({
				id: "zoom:in",
				title: "Zoom in",
				section: "View",
				keywords,
				icon: ZoomIn,
				shortcut: "zoomIn",
				run: () => zoomBy(1),
			});
		if (zoom > ZOOM_STEPS[0])
			list.push({
				id: "zoom:out",
				title: "Zoom out",
				section: "View",
				keywords,
				icon: ZoomOut,
				shortcut: "zoomOut",
				run: () => zoomBy(-1),
			});
		if (zoom !== DEFAULT_APPEARANCE.zoom)
			list.push({
				id: "zoom:reset",
				title: "Reset zoom",
				section: "View",
				keywords,
				icon: RotateCcw,
				shortcut: "zoomReset",
				run: resetZoom,
			});
		return list;
	}, [zoom]);
	usePaletteEntries(entries);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			// A widget that took the key (the diagram viewer's own +/−/0) keeps it.
			if (e.isComposing || e.defaultPrevented) return;
			const target = e.target instanceof HTMLElement ? e.target : null;
			if (shortcutFires("zoomIn", e, target, IS_MAC)) zoomBy(1);
			else if (shortcutFires("zoomOut", e, target, IS_MAC)) zoomBy(-1);
			else if (shortcutFires("zoomReset", e, target, IS_MAC)) resetZoom();
			else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return null;
}
