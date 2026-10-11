/**
 * The pure parts of the app-wide tooltip layer (components/shell/Tooltip.tsx): which element gets a
 * tooltip, what it says, and where it sits. Kept free of the DOM so they can be tested.
 */

/** Elements that get a tooltip: controls, plus anything that opts in with `data-tip`. */
export const TIP_TARGET =
	'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], summary, [data-tip]';

/** What an element offers a tooltip, as read off its attributes. */
export interface TipSource {
	/** `data-tip`: the tooltip's own text (a `title` the layer already took over lands here too). */
	dataTip: string | null;
	title: string | null;
	ariaLabel: string | null;
	/** The element's visible text (`textContent`); empty for an icon-only control. */
	text: string;
}

/** Runs of blanks collapsed to one space; line breaks kept, so a two-line `title` stays two lines. */
function squash(value: string): string {
	return value
		.replace(/[^\S\n]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.trim();
}

function canon(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/**
 * The tooltip text: `data-tip`, else `title`, else the `aria-label` of an icon-only control. Null when
 * there is none, or when the control's visible text already says it (a "Copy" button titled "Copy").
 */
export function resolveTipText(source: TipSource): string | null {
	const visible = squash(source.text);
	const raw = source.dataTip ?? source.title ?? (visible === "" ? source.ariaLabel : null);
	const tip = raw === null ? "" : squash(raw);
	if (tip === "") return null;
	if (visible !== "" && canon(visible).includes(canon(tip))) return null;
	return tip;
}

/** How each modifier or named key reads on Apple platforms and elsewhere (a key not listed reads as itself). */
const KEY_NAMES: Record<string, { mac: string; other: string }> = {
	meta: { mac: "⌘", other: "Ctrl" },
	control: { mac: "⌃", other: "Ctrl" },
	shift: { mac: "⇧", other: "Shift" },
	alt: { mac: "⌥", other: "Alt" },
	arrowup: { mac: "↑", other: "↑" },
	arrowdown: { mac: "↓", other: "↓" },
	arrowleft: { mac: "←", other: "←" },
	arrowright: { mac: "→", other: "→" },
	escape: { mac: "Esc", other: "Esc" },
};

/**
 * The keycaps of an `aria-keyshortcuts` value ("Meta+K" → "⌘K" on Mac, "Ctrl+K" elsewhere); only the
 * first of several space-separated alternatives is shown. Null for an empty value.
 */
export function formatKeyshortcuts(value: string, mac: boolean): string | null {
	const first = value.trim().split(/\s+/)[0] ?? "";
	if (first === "") return null;
	const parts = first.split("+").map(part => {
		const key = Object.hasOwn(KEY_NAMES, part.toLowerCase()) ? KEY_NAMES[part.toLowerCase()] : undefined;
		if (key !== undefined) return mac ? key.mac : key.other;
		return part.length === 1 ? part.toUpperCase() : part;
	});
	return mac ? parts.join("") : parts.join("+");
}

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

export interface TipPlacement {
	/** Viewport coordinates of the tooltip's top-left corner. */
	left: number;
	top: number;
	/** Which side of the target it sits on: `top` is above it. */
	side: "top" | "bottom";
	/** Where the arrow points, from the tooltip's left edge. */
	arrow: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Place a tooltip of `tip` size by `target`: above it with `gap` between, below when there is no room
 * above, centred on it but kept `margin` (plus the safe-area `insets`) inside the viewport. When neither
 * side has room the roomier one is used.
 */
export function placeTip(
	target: Box,
	tip: { width: number; height: number },
	view: { width: number; height: number },
	insets: Insets,
	gap = 10,
	margin = 8,
): TipPlacement {
	const minX = margin + insets.left;
	const maxX = view.width - margin - insets.right - tip.width;
	const left = clamp(target.left + target.width / 2 - tip.width / 2, minX, maxX);
	const minY = margin + insets.top;
	const maxY = view.height - margin - insets.bottom - tip.height;
	const above = target.top - minY;
	const below = view.height - margin - insets.bottom - (target.top + target.height);
	const need = tip.height + gap;
	const side = above >= need ? "top" : below >= need ? "bottom" : above >= below ? "top" : "bottom";
	const top = side === "top" ? target.top - gap - tip.height : target.top + target.height + gap;
	const arrowInset = Math.min(12, tip.width / 2);
	return {
		left,
		top: clamp(top, minY, maxY),
		side,
		arrow: clamp(target.left + target.width / 2 - left, arrowInset, tip.width - arrowInset),
	};
}
