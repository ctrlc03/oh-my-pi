import { describe, expect, it } from "bun:test";
import {
	adjacentRoom,
	type Combo,
	formatCombo,
	GESTURES,
	isTypingTarget,
	matchCombo,
	SHORTCUTS,
	type ShortcutId,
	shortcutFires,
} from "../src/lib/shortcuts";

const key = (
	k: string,
	mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({
	key: k,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...mods,
});
const ids = Object.keys(SHORTCUTS) as ShortcutId[];

describe("modifier normalisation", () => {
	it("counts Command as the modifier on Mac and Control elsewhere", () => {
		expect(shortcutFires("blockNext", key("ArrowDown", { metaKey: true }), null, true)).toBe(true);
		expect(shortcutFires("blockNext", key("ArrowDown", { ctrlKey: true }), null, true)).toBe(false);
		expect(shortcutFires("blockNext", key("ArrowDown", { ctrlKey: true }), null, false)).toBe(true);
		expect(shortcutFires("blockNext", key("ArrowDown", { metaKey: true }), null, false)).toBe(false);
	});

	it("refuses both modifiers at once and Alt", () => {
		expect(matchCombo(key("c", { metaKey: true, ctrlKey: true }), SHORTCUTS.blockCopy.keys, true)).toBe(false);
		expect(matchCombo(key("c", { metaKey: true, altKey: true }), SHORTCUTS.blockCopy.keys, true)).toBe(false);
	});

	it("keeps plain keys plain: a modifier turns them into some other shortcut", () => {
		expect(shortcutFires("copyReply", key("y"), null, true)).toBe(true);
		expect(shortcutFires("copyReply", key("y", { metaKey: true }), null, true)).toBe(false);
		expect(shortcutFires("copyReply", key("y", { ctrlKey: true }), null, false)).toBe(false);
	});

	it("tells the plain, extending and copy variants apart", () => {
		const down = key("ArrowDown", { metaKey: true });
		const extend = key("ArrowDown", { metaKey: true, shiftKey: true });
		expect(shortcutFires("blockNext", down, null, true)).toBe(true);
		expect(shortcutFires("blockExtendNext", down, null, true)).toBe(false);
		expect(shortcutFires("blockExtendNext", extend, null, true)).toBe(true);
		expect(shortcutFires("blockNext", extend, null, true)).toBe(false);
	});

	it("takes capital G through Shift and not the lower-case g", () => {
		expect(shortcutFires("jumpLatest", key("G", { shiftKey: true }), null, true)).toBe(true);
		expect(shortcutFires("jumpLatest", key("g"), null, true)).toBe(false);
	});

	it("takes ? however the layout makes it", () => {
		expect(shortcutFires("help", key("?", { shiftKey: true }), null, true)).toBe(true);
		expect(shortcutFires("help", key("?"), null, true)).toBe(true);
	});
});

describe("typing suppression", () => {
	const field = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable });

	it("recognises text fields, selects and editable content", () => {
		expect(isTypingTarget(field("TEXTAREA"))).toBe(true);
		expect(isTypingTarget(field("INPUT"))).toBe(true);
		expect(isTypingTarget(field("SELECT"))).toBe(true);
		expect(isTypingTarget(field("DIV", true))).toBe(true);
		expect(isTypingTarget(field("DIV"))).toBe(false);
		expect(isTypingTarget(null)).toBe(false);
		expect(isTypingTarget({})).toBe(false);
	});

	it("stands every non-Esc shortcut down while typing", () => {
		const events = {
			blockPrev: key("ArrowUp", { metaKey: true }),
			blockCopy: key("c", { metaKey: true }),
			focusComposer: key("i"),
			copyReply: key("y"),
			find: key("/"),
			help: key("?", { shiftKey: true }),
		};
		for (const [id, event] of Object.entries(events)) {
			expect(shortcutFires(id as ShortcutId, event, null, true)).toBe(true);
			expect(shortcutFires(id as ShortcutId, event, field("TEXTAREA"), true)).toBe(false);
		}
	});

	it("keeps Esc working in a field", () => {
		expect(shortcutFires("escape", key("Escape"), field("TEXTAREA"), true)).toBe(true);
	});
});

describe("keymap table", () => {
	it("gives no two shortcuts the same keys", () => {
		const seen = new Set<string>();
		for (const id of ids) {
			const { key: k, mod, shift }: Combo = SHORTCUTS[id].keys;
			const signature = `${k.toLowerCase()}|${mod === true}|${shift === true}`;
			expect(seen.has(signature)).toBe(false);
			seen.add(signature);
		}
	});

	it("avoids what the browser keeps: no ⌘/Ctrl with L, T, W, N, R, digits or brackets", () => {
		for (const id of ids) {
			const { key: k, mod }: Combo = SHORTCUTS[id].keys;
			if (mod !== true) continue;
			expect(/^[ltwnr0-9[\]]$/i.test(k)).toBe(false);
		}
	});

	it("labels every shortcut and gesture", () => {
		for (const id of ids) expect(SHORTCUTS[id].label.length).toBeGreaterThan(0);
		for (const item of GESTURES) expect(item.label.length + item.gesture.length).toBeGreaterThan(0);
	});

	it("spells keycaps per platform", () => {
		expect(formatCombo({ key: "ArrowUp", mod: true, shift: true }, true)).toBe("⇧⌘↑");
		expect(formatCombo({ key: "ArrowUp", mod: true, shift: true }, false)).toBe("Ctrl+Shift+↑");
		expect(formatCombo({ key: "k", mod: true }, true)).toBe("⌘K");
		expect(formatCombo({ key: "k", mod: true }, false)).toBe("Ctrl+K");
	});
});

describe("adjacentRoom", () => {
	const room = (roomId: string, title: string) => ({ roomId, title });
	const rooms = [room("c", "Charlie"), room("a", "Alpha"), room("b", "Bravo")];

	it("steps through the list in a stable order and wraps", () => {
		expect(adjacentRoom(rooms, "a", 1)?.roomId).toBe("b");
		expect(adjacentRoom(rooms, "b", 1)?.roomId).toBe("c");
		expect(adjacentRoom(rooms, "c", 1)?.roomId).toBe("a");
		expect(adjacentRoom(rooms, "a", -1)?.roomId).toBe("c");
	});

	it("is not reordered by recency, so next then previous returns to the start", () => {
		const next = adjacentRoom(rooms, "a", 1)!;
		expect(adjacentRoom([next, ...rooms.filter(r => r !== next)], next.roomId, -1)?.roomId).toBe("a");
	});

	it("has nowhere to go with one session or none", () => {
		expect(adjacentRoom([room("a", "A")], "a", 1)).toBeNull();
		expect(adjacentRoom([], "a", 1)).toBeNull();
	});

	it("enters the list from either end when the current session is not in it", () => {
		expect(adjacentRoom(rooms, "zzz", 1)?.roomId).toBe("a");
		expect(adjacentRoom(rooms, null, -1)?.roomId).toBe("c");
	});
});
