import {
	BLUEPRINT_EXCERPT_MAX_LINES,
	BLUEPRINT_EXCERPT_STEP,
	type BlueprintExcerpt,
	type BlueprintExcerptRef,
	type BlueprintRef,
} from "@oh-my-pi/pi-wire/blueprint";

export type WidenDirection = "up" | "down";

/** Last line number an excerpt holds. */
function endOf(excerpt: BlueprintExcerpt): number {
	return excerpt.start + excerpt.lines.length - 1;
}

/**
 * Lines still to show above (`up`) or below (`down`) an excerpt; 0 at the top or bottom of the file, and for a
 * companion that does not say how long the file is (it cannot read a range either, so there is nothing to ask for).
 */
export function linesLeft(excerpt: BlueprintExcerpt, direction: WidenDirection): number {
	if (excerpt.total === undefined) return 0;
	return direction === "up" ? Math.max(0, excerpt.start - 1) : Math.max(0, excerpt.total - endOf(excerpt));
}

/**
 * The request for {@link BLUEPRINT_EXCERPT_STEP} more lines on one side of an excerpt: the lines it holds plus the
 * step. At {@link BLUEPRINT_EXCERPT_MAX_LINES} the far side gives way, so a click always shows lines on the side asked.
 */
export function widenRequest(
	reference: BlueprintRef,
	excerpt: BlueprintExcerpt,
	direction: WidenDirection,
): BlueprintExcerptRef {
	const end = endOf(excerpt);
	if (direction === "up") {
		const from = Math.max(1, excerpt.start - BLUEPRINT_EXCERPT_STEP);
		return { ...reference, from, to: Math.min(end, from + BLUEPRINT_EXCERPT_MAX_LINES - 1) };
	}
	const to = Math.min(excerpt.total ?? end, end + BLUEPRINT_EXCERPT_STEP);
	return { ...reference, from: Math.max(excerpt.start, to - BLUEPRINT_EXCERPT_MAX_LINES + 1), to };
}
