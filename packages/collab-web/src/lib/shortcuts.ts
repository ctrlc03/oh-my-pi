import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

/**
 * The keyboard map: one table that the key handlers match against and the help sheet lists, so
 * the two cannot drift. Shortcuts avoid what a browser tab keeps for itself (⌘L, ⌘T, ⌘W, ⌘N, ⌘R,
 * ⌘1–9, ⌘[ and ⌘]): a bare key when the reader is not typing, or ⌘/Ctrl with an arrow or `C` or
 * `K`, which Chrome, Safari and Firefox pass to the page.
 *
 * Each entry is a default: the reader may remap any of them (except Esc, which sheets and the editor
 * read for themselves) in the help sheet. Overrides live in localStorage and are read through
 * `effectiveKeys`, which `shortcutFires` and the help sheet use; the table's own `keys` are only the defaults.
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
	/** Not remappable: other code reads the key directly (Esc closes sheets and the editor's panels). */
	fixed?: true;
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
		fixed: true,
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
	stashDraft: {
		keys: { key: "s", mod: true },
		label: "Stash the draft in the message box",
		group: "Session",
		typing: "allow",
	},
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
		keys: { key: "\\", mod: true },
		label: "Show or hide the sessions sidebar",
		group: "View",
		typing: "suppress",
	},
	find: { keys: { key: "/" }, label: "Find in the session", group: "View", typing: "suppress" },
	help: { keys: { key: "?", shift: "any" }, label: "Show this list", group: "General", typing: "suppress" },
	palette: {
		keys: { key: "k", mod: true },
		label: "Open the command palette: actions, commands, sessions, messages",
		group: "General",
		typing: "allow",
	},
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

/** Whether `event` at `target` fires shortcut `id`: the keys (as remapped, if they were) match and typing does not suppress it. */
export function shortcutFires(id: ShortcutId, event: KeyLike, target: object | null, mac: boolean): boolean {
	const shortcut: Shortcut = SHORTCUTS[id];
	if (shortcut.typing === "suppress" && isTypingTarget(target)) return false;
	return matchCombo(event, effectiveKeys(id), mac);
}

const KEY_NAMES: Record<string, string> = {
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	Escape: "Esc",
	" ": "Space",
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

// --- remapping ---

/** The keys the reader chose instead of the defaults, by shortcut. */
export type Overrides = Partial<Record<ShortcutId, Combo>>;

export const KEYBINDINGS_KEY = "omp.collab.keybindings";

function isShortcutId(id: string): id is ShortcutId {
	return Object.hasOwn(SHORTCUTS, id);
}

/** `keys` as a combo with no stray `false`s, or null when it is not one. */
function parseCombo(raw: unknown): Combo | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { key, mod, shift } = raw as Record<string, unknown>;
	if (typeof key !== "string" || key === "" || key.length > 24) return null;
	if (mod !== undefined && typeof mod !== "boolean") return null;
	if (shift !== undefined && typeof shift !== "boolean" && shift !== "any") return null;
	const combo: Combo = { key: key.length === 1 ? key.toLowerCase() : key };
	if (mod === true) combo.mod = true;
	if (shift === true || shift === "any") combo.shift = shift;
	return combo;
}

/** Whether two combos are the same keys (an unset `mod` or `shift` means "not held"). */
export function sameCombo(a: Combo, b: Combo): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		(a.mod === true) === (b.mod === true) &&
		(a.shift === "any") === (b.shift === "any") &&
		(a.shift === true) === (b.shift === true)
	);
}

/**
 * Overrides from what was stored: unknown shortcuts, fixed ones, malformed combos and entries that equal the
 * default are dropped, so a stale or hand-edited value can never break the keymap.
 */
export function parseOverrides(raw: unknown): Overrides {
	const overrides: Overrides = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return overrides;
	for (const [id, value] of Object.entries(raw)) {
		if (!isShortcutId(id) || Object.hasOwn(SHORTCUTS[id], "fixed")) continue;
		const combo = parseCombo(value);
		if (combo !== null && !sameCombo(combo, SHORTCUTS[id].keys)) overrides[id] = combo;
	}
	return overrides;
}

let overrides: Overrides | null = null;
const overrideListeners = new Set<() => void>();

function currentOverrides(): Overrides {
	overrides ??= parseOverrides(readJson(KEYBINDINGS_KEY));
	return overrides;
}

function applyOverrides(next: Overrides): void {
	overrides = next;
	writeJson(KEYBINDINGS_KEY, Object.keys(next).length === 0 ? null : next);
	for (const listener of overrideListeners) listener();
}

/** Forget the in-memory overrides and read what is stored (another tab changed it; tests simulate a reload). */
export function reloadOverrides(): void {
	overrides = null;
	for (const listener of overrideListeners) listener();
}

/** The keys that fire `id` now: the reader's choice, else the default. */
export function effectiveKeys(id: ShortcutId): Combo {
	const own = currentOverrides();
	return Object.hasOwn(own, id) ? own[id]! : SHORTCUTS[id].keys;
}

/** Make `combo` fire `id`; the default's own keys, or null, restore the default. Fixed shortcuts ignore it. */
export function setOverride(id: ShortcutId, combo: Combo | null): void {
	if (Object.hasOwn(SHORTCUTS[id], "fixed")) return;
	const next = { ...currentOverrides() };
	if (combo === null || sameCombo(combo, SHORTCUTS[id].keys)) delete next[id];
	else next[id] = combo;
	applyOverrides(next);
}

/** Back to the defaults for every shortcut. */
export function resetOverrides(): void {
	applyOverrides({});
}

function subscribeOverrides(listener: () => void): () => void {
	overrideListeners.add(listener);
	const onStorage = (e: StorageEvent): void => {
		if (e.key === KEYBINDINGS_KEY || e.key === null) reloadOverrides();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		overrideListeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

/** The reader's overrides, re-rendering when they change (here or in another tab); a server render reads the same stored value. */
export function useOverrides(): Overrides {
	return useSyncExternalStore(subscribeOverrides, currentOverrides, currentOverrides);
}

/** What a modifier key reports as `KeyboardEvent.key`: pressing one alone is not a combo. */
const MODIFIER_KEYS = new Set([
	"Shift",
	"Control",
	"Alt",
	"AltGraph",
	"Meta",
	"OS",
	"CapsLock",
	"Fn",
	"Dead",
	"Unidentified",
]);

/**
 * The combo a key press spells, for recording a new binding; null while only modifiers are held or when
 * the press cannot be matched (Alt, or Ctrl on Mac / ⌘ elsewhere, which `matchCombo` never accepts).
 */
export function comboFromEvent(event: KeyLike, mac: boolean): Combo | null {
	if (MODIFIER_KEYS.has(event.key) || event.altKey) return null;
	if (mac ? event.ctrlKey : event.metaKey) return null;
	const mod = mac ? event.metaKey : event.ctrlKey;
	const single = event.key.length === 1;
	const letter = single && event.key.toLowerCase() !== event.key.toUpperCase();
	const combo: Combo = { key: letter ? event.key.toLowerCase() : event.key };
	if (mod) combo.mod = true;
	// A shifted symbol (`?`) is already a different character, so it must not also demand Shift of the keyboard layout.
	if (event.shiftKey) combo.shift = single && !letter ? "any" : true;
	return combo;
}

/** Whether a press of one combo could be a press of the other (`shift: "any"` accepts either state). */
export function overlaps(a: Combo, b: Combo): boolean {
	if (a.key.toLowerCase() !== b.key.toLowerCase() || (a.mod === true) !== (b.mod === true)) return false;
	return a.shift === "any" || b.shift === "any" || (a.shift === true) === (b.shift === true);
}

/** Every shortcut's keys now: the defaults with the overrides laid over them. */
export function effectiveBindings(own: Overrides = currentOverrides()): Record<ShortcutId, Combo> {
	const bindings = {} as Record<ShortcutId, Combo>;
	for (const id of Object.keys(SHORTCUTS) as ShortcutId[])
		bindings[id] = Object.hasOwn(own, id) ? own[id]! : SHORTCUTS[id].keys;
	return bindings;
}

/** For each shortcut sharing keys with another, the others: both would fire on the same press. */
export function findConflicts(bindings: Record<ShortcutId, Combo>): Partial<Record<ShortcutId, ShortcutId[]>> {
	const ids = Object.keys(bindings) as ShortcutId[];
	const conflicts: Partial<Record<ShortcutId, ShortcutId[]>> = {};
	for (const id of ids) {
		const others = ids.filter(other => other !== id && overlaps(bindings[id], bindings[other]));
		if (others.length > 0) conflicts[id] = others;
	}
	return conflicts;
}

/** Keys a browser tab keeps for itself: the page never sees them, so a shortcut on them cannot work. */
const BROWSER_KEYS = /^[lqtwnr0-9[\]]$/i;

/**
 * Why `combo` cannot be the keys of `id`, or null when it can: a reserved browser key, or a bare printable
 * key for a shortcut that also works while typing (it would eat the letter).
 */
export function comboProblem(id: ShortcutId, combo: Combo): string | null {
	if (combo.mod === true && BROWSER_KEYS.test(combo.key)) return "The browser keeps this key for itself.";
	const printable = combo.key.length === 1 && combo.mod !== true;
	if (SHORTCUTS[id].typing === "allow" && printable) return "This one works while typing, so it needs ⌘ or Ctrl.";
	return null;
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

/** The keycaps of shortcut `id` as it is bound now; a control's `data-shortcut` shows them in its tooltip. Re-render with `useOverrides` to follow a remap. */
export function shortcutKeys(id: ShortcutId): string {
	return formatCombo(effectiveKeys(id), IS_MAC);
}
