/**
 * The keyboard map: one table that the key handlers match against and the help sheet lists, so
 * the two cannot drift. Shortcuts avoid what a browser tab keeps for itself (⌘L, ⌘T, ⌘W, ⌘N, ⌘R,
 * ⌘1–9, ⌘[ and ⌘]): a bare key when the reader is not typing, or ⌘/Ctrl with an arrow or `C` or
 * `K`, which Chrome, Safari and Firefox pass to the page.
 */

export type ShortcutGroup = "Blocks" | "Session" | "View" | "General";

export interface Combo {
	/** `KeyboardEvent.key`; letters compare lower-case. */
	key: string;
	/** ⌘ on Mac, Ctrl elsewhere. Without it no modifier may be held. */
	mod?: boolean;
	/** `true`: Shift is required; `"any"`: the key is already a shifted character (`?`) so Shift does not matter. */
	shift?: boolean | "any";
}

export interface Shortcut {
	keys: Combo;
	label: string;
	group: ShortcutGroup;
	/** `allow`: also works while typing in a field (Esc); `suppress`: ignored there. */
	typing: "allow" | "suppress";
}

export const SHORTCUTS = {
	blockPrev: {
		keys: { key: "ArrowUp", mod: true },
		label: "Select the previous block",
		group: "Blocks",
		typing: "suppress",
	},
	blockNext: {
		keys: { key: "ArrowDown", mod: true },
		label: "Select the next block",
		group: "Blocks",
		typing: "suppress",
	},
	blockExtendPrev: {
		keys: { key: "ArrowUp", mod: true, shift: true },
		label: "Extend the selection upward",
		group: "Blocks",
		typing: "suppress",
	},
	blockExtendNext: {
		keys: { key: "ArrowDown", mod: true, shift: true },
		label: "Extend the selection downward",
		group: "Blocks",
		typing: "suppress",
	},
	blockCopy: {
		keys: { key: "c", mod: true },
		label: "Copy the selected blocks as Markdown",
		group: "Blocks",
		typing: "suppress",
	},
	escape: {
		keys: { key: "Escape" },
		label: "Clear the selection, close a panel, or stop the running turn",
		group: "General",
		typing: "allow",
	},
	focusComposer: { keys: { key: "i" }, label: "Focus the message box", group: "Session", typing: "suppress" },
	jumpLatest: {
		keys: { key: "g", shift: true },
		label: "Jump to the latest message",
		group: "Session",
		typing: "suppress",
	},
	copyReply: { keys: { key: "y" }, label: "Copy the last reply", group: "Session", typing: "suppress" },
	editPrompt: { keys: { key: "e" }, label: "Edit and resend the last prompt", group: "Session", typing: "suppress" },
	prevSession: {
		keys: { key: "[" },
		label: "Previous session in the recent list",
		group: "Session",
		typing: "suppress",
	},
	nextSession: { keys: { key: "]" }, label: "Next session in the recent list", group: "Session", typing: "suppress" },
	sessionSheet: { keys: { key: "s" }, label: "Open the session sheet", group: "Session", typing: "suppress" },
	toggleChat: { keys: { key: "v" }, label: "Toggle the chat view", group: "View", typing: "suppress" },
	sidebar: {
		keys: { key: "k", mod: true },
		label: "Show or hide the sessions sidebar",
		group: "View",
		typing: "suppress",
	},
	find: { keys: { key: "/" }, label: "Find in the session", group: "View", typing: "suppress" },
	help: { keys: { key: "?", shift: "any" }, label: "Show this list", group: "General", typing: "suppress" },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** What the handlers read off a keyboard event; a `KeyboardEvent` satisfies it. */
export interface KeyLike {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/** Whether `event` is the combo: ⌘ on Mac and Ctrl elsewhere count as the same modifier, the other one never does. */
export function matchCombo(event: KeyLike, combo: Combo, mac: boolean): boolean {
	if (event.altKey) return false;
	const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	const stray = event.metaKey || event.ctrlKey;
	if (combo.mod === true ? !mod : stray) return false;
	if (combo.shift !== "any" && event.shiftKey !== (combo.shift === true)) return false;
	return event.key.toLowerCase() === combo.key.toLowerCase();
}

/** Whether keys typed at `target` (an event's target; any object with the DOM's `tagName` / `isContentEditable`) go into a field: shortcuts that are not meant for fields stand down. */
export function isTypingTarget(target: object | null): boolean {
	if (target === null) return false;
	if ("isContentEditable" in target && target.isContentEditable === true) return true;
	const tag = "tagName" in target && typeof target.tagName === "string" ? target.tagName : "";
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Whether `event` at `target` fires shortcut `id`: the keys match and typing does not suppress it. */
export function shortcutFires(id: ShortcutId, event: KeyLike, target: object | null, mac: boolean): boolean {
	const shortcut: Shortcut = SHORTCUTS[id];
	if (shortcut.typing === "suppress" && isTypingTarget(target)) return false;
	return matchCombo(event, shortcut.keys, mac);
}

const KEY_NAMES: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Escape: "Esc",
};

/** The combo as keycaps: `⇧⌘↑` on Mac, `Ctrl+Shift+↑` elsewhere. */
export function formatCombo(combo: Combo, mac: boolean): string {
	const key = Object.hasOwn(KEY_NAMES, combo.key)
		? KEY_NAMES[combo.key]!
		: combo.key.length === 1
			? combo.key.toUpperCase()
			: combo.key;
	// A capital letter already says Shift; with ⌘ held it needs spelling out.
	const letter = combo.key.length === 1 && /[a-z]/i.test(combo.key);
	const showShift = combo.shift === true && (!letter || combo.mod === true);
	if (mac) return `${showShift ? "⇧" : ""}${combo.mod === true ? "⌘" : ""}${key}`;
	return [combo.mod === true ? "Ctrl" : "", showShift ? "Shift" : "", key].filter(Boolean).join("+");
}

/** Touch gestures, listed in the help sheet beside the keys. */
export const GESTURES: readonly { gesture: string; label: string }[] = [
	{ gesture: "Swipe a block right", label: "Quote it into the message box" },
	{ gesture: "Swipe a block left", label: "Copy it" },
	{ gesture: "Double-tap a block", label: "Copy it" },
	{ gesture: "Press and hold a block", label: "Open its actions" },
	{ gesture: "Swipe in from the left edge", label: "Open the sessions sidebar" },
	{ gesture: "Swipe in from the right edge", label: "Open the agents rail" },
	{ gesture: "Swipe an open drawer toward its edge", label: "Close it" },
	{ gesture: "Swipe down on the message box", label: "Hide the keyboard" },
];

/**
 * The session `delta` places from `currentId` in the recent list, wrapping around, or null when there is
 * no other. The list is ordered by title (then id) rather than by last visit, which moves the session
 * just opened to the front and would make "next" bounce between two.
 */
export function adjacentRoom<T extends { roomId: string; title: string }>(
	rooms: readonly T[],
	currentId: string | null,
	delta: -1 | 1,
): T | null {
	const order = [...rooms].sort((a, b) => a.title.localeCompare(b.title) || a.roomId.localeCompare(b.roomId));
	if (order.length === 0 || (order.length === 1 && order[0]!.roomId === currentId)) return null;
	const at = order.findIndex(room => room.roomId === currentId);
	if (at < 0) return order[delta > 0 ? 0 : order.length - 1]!;
	return order[(at + delta + order.length) % order.length]!;
}

/** ⌘ is the shortcut modifier on Apple platforms (iPad included); everywhere else it is Ctrl. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
