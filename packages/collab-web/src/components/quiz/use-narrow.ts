import { useSyncExternalStore } from "react";
import { matchesMedia, useUiZoom } from "../../lib/zoom";

/** Where the question screen stops being two columns (the same breakpoint as `quiz.css`). */
const NARROW = "(max-width: 979px)";

function subscribe(listener: () => void): () => void {
	window.addEventListener("resize", listener);
	return () => window.removeEventListener("resize", listener);
}

/** Whether the screen is too narrow for the code beside the question: the answer comes first and the code is compact. */
export function useNarrow(): boolean {
	useUiZoom();
	return useSyncExternalStore(
		subscribe,
		() => matchesMedia(NARROW),
		() => false,
	);
}
