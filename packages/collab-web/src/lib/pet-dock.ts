import { layoutRect } from "./zoom";

/**
 * Where the message box starts. The session panel (`.sh-panel`) stacks the transcript above its bars
 * (limits, tasks, cache) and the composer; the pet keeps above the highest of them.
 */

/** The panel that reaches furthest right: the pet's default spot is the bottom right corner. */
function rightmostPanel(): Element | null {
	let best: Element | null = null;
	let bestRight = -Infinity;
	for (const panel of document.querySelectorAll(".sh-panel")) {
		const right = panel.getBoundingClientRect().right;
		if (right > bestRight) {
			best = panel;
			bestRight = right;
		}
	}
	return best;
}

/** Elements stacked below the transcript in `panel`: the bars and the composer. */
function dockElements(panel: Element): Element[] {
	const dock: Element[] = [];
	for (let el = panel.querySelector(":scope > .sh-transcript")?.nextElementSibling; el; el = el.nextElementSibling) {
		dock.push(el);
	}
	return dock;
}

/** Room kept for the transcript's jump-to-latest button, which floats at the transcript's bottom right. */
const JUMP_CLEARANCE = 48;

/**
 * The highest edge, in layout px (the pet is placed in them), of what is stacked at the bottom of the session; null
 * when no session is open. A pet whose left edge is at `petLeft` stands above the jump-to-latest button when the
 * transcript reaches that far right (a phone), so it never sits on the button.
 */
export function measureDockTop(petLeft: number): number | null {
	const panel = rightmostPanel();
	if (panel === null) return null;
	let top = Infinity;
	for (const el of dockElements(panel)) {
		const rect = layoutRect(el.getBoundingClientRect());
		if (rect.height > 0) top = Math.min(top, rect.top);
	}
	if (!Number.isFinite(top)) return null;
	const transcript = panel.querySelector(":scope > .sh-transcript");
	return transcript !== null && layoutRect(transcript.getBoundingClientRect()).right > petLeft
		? top - JUMP_CLEARANCE
		: top;
}

/** Calls `onChange` when the dock may have moved: its elements resize, or bars appear and disappear. Returns the stop function. */
export function observeDock(onChange: () => void): () => void {
	const resizes = new ResizeObserver(onChange);
	const watch = (): void => {
		resizes.disconnect();
		const panel = rightmostPanel();
		if (panel === null) return;
		resizes.observe(panel);
		for (const el of dockElements(panel)) resizes.observe(el);
	};
	const mutations = new MutationObserver(() => {
		track();
		watch();
		onChange();
	});
	// Re-observing a node it already watches is harmless, so this also picks up panels that appear later.
	const track = (): void => {
		const main = document.querySelector(".sh-main");
		if (main === null) return;
		mutations.observe(main, { childList: true });
		for (const panel of main.querySelectorAll(".sh-panel")) mutations.observe(panel, { childList: true });
	};
	track();
	watch();
	return () => {
		resizes.disconnect();
		mutations.disconnect();
	};
}
