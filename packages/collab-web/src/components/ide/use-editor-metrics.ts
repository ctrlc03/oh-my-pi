import type { RefObject } from "react";
import { useLayoutEffect, useState } from "react";
import { THEME_ATTRIBUTES } from "./backend/monaco-theme";

/** The size the app's code font gives the editor when the browser has not been asked (12.5px at the default text size). */
export const FALLBACK_FONT_SIZE = 12.5;

export interface EditorMetrics {
	/** The editing surface's width in CSS pixels (0 while it is hidden or not measured). */
	width: number;
	/** The size its text is drawn at now: the user's own choice, else the app's code font size; null until measured. */
	fontSize: number | null;
}

/**
 * What the editing surface `host` measures: its width, and the font size it computes to. With no choice of the
 * user's (`fontSize` null) that is what the app's code font size and text size make it, so it is read again
 * when the page's appearance changes.
 */
export function useEditorMetrics(host: RefObject<HTMLElement | null>, fontSize: number | null): EditorMetrics {
	const [measured, setMeasured] = useState<EditorMetrics>({ width: 0, fontSize: null });
	useLayoutEffect(() => {
		const element = host.current;
		if (element === null) return;
		const read = (): void => {
			const next = {
				width: element.clientWidth,
				fontSize: Number.parseFloat(getComputedStyle(element).fontSize) || FALLBACK_FONT_SIZE,
			};
			setMeasured(previous =>
				previous.width === next.width && previous.fontSize === next.fontSize ? previous : next,
			);
		};
		read();
		const resize = new ResizeObserver(read);
		resize.observe(element);
		const appearance = new MutationObserver(read);
		appearance.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
		return () => {
			resize.disconnect();
			appearance.disconnect();
		};
	}, [host, fontSize]);
	return { width: measured.width, fontSize: fontSize ?? measured.fontSize };
}
