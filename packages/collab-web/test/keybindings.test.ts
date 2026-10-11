import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Combo,
	comboFromEvent,
	comboProblem,
	effectiveBindings,
	effectiveKeys,
	findConflicts,
	KEYBINDINGS_KEY,
	overlaps,
	parseOverrides,
	reloadOverrides,
	resetOverrides,
	SHORTCUTS,
	sameCombo,
	setOverride,
	shortcutFires,
} from "../src/lib/shortcuts";

const key = (
	k: string,
	mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

/** A localStorage that outlives the module's cache, as the browser's does across a reload. */
function installStorage(): Map<string, string> {
	const data = new Map<string, string>();
	Object.assign(globalThis, {
		localStorage: {
			getItem: (name: string) => data.get(name) ?? null,
			setItem: (name: string, value: string) => void data.set(name, value),
			removeItem: (name: string) => void data.delete(name),
		},
	});
	return data;
}

describe("parseOverrides", () => {
	it("keeps well-formed combos for known shortcuts and normalises them", () => {
		expect(
			parseOverrides({ find: { key: "F", mod: true, shift: false }, jumpLatest: { key: "J", shift: true } }),
		).toEqual({
			find: { key: "f", mod: true },
			jumpLatest: { key: "j", shift: true },
		});
	});

	it("drops unknown ids, fixed shortcuts, malformed combos and entries equal to the default", () => {
		const parsed = parseOverrides({
			nope: { key: "x" },
			escape: { key: "q" },
			find: { key: "" },
			help: { key: "?", shift: "yes" },
			copyReply: { key: "y" },
			editPrompt: "e",
			toggleChat: { key: "b", mod: 1 },
			__proto__: { key: "z" },
		});
		expect(parsed).toEqual({});
	});

	it("survives junk that is not an object", () => {
		expect(parseOverrides(null)).toEqual({});
		expect(parseOverrides("find")).toEqual({});
		expect(parseOverrides([{ key: "x" }])).toEqual({});
	});
});

describe("combos", () => {
	it("compares keys without regard to case and treats unset modifiers as not held", () => {
		expect(sameCombo({ key: "K", mod: true }, { key: "k", mod: true, shift: false })).toBe(true);
		expect(sameCombo({ key: "k", mod: true }, { key: "k" })).toBe(false);
		expect(sameCombo({ key: "?", shift: "any" }, { key: "?", shift: true })).toBe(false);
	});

	it("overlaps when one press could be either, which `shift: any` makes of both Shift states", () => {
		expect(overlaps({ key: "?", shift: "any" }, { key: "?" })).toBe(true);
		expect(overlaps({ key: "?", shift: "any" }, { key: "?", shift: true })).toBe(true);
		expect(overlaps({ key: "g" }, { key: "g", shift: true })).toBe(false);
		expect(overlaps({ key: "k", mod: true }, { key: "k" })).toBe(false);
	});
});

describe("findConflicts", () => {
	it("is empty for the defaults", () => {
		expect(findConflicts(effectiveBindings({}))).toEqual({});
	});

	it("flags both sides of a clash and names the other shortcut", () => {
		const bindings = effectiveBindings({ find: { key: "y" } });
		const conflicts = findConflicts(bindings);
		expect(conflicts.find).toEqual(["copyReply"]);
		expect(conflicts.copyReply).toEqual(["find"]);
		expect(Object.keys(conflicts).sort()).toEqual(["copyReply", "find"]);
	});

	it("sees through case and a Shift that does not matter", () => {
		const conflicts = findConflicts(effectiveBindings({ find: { key: "?" } }));
		expect(conflicts.help).toEqual(["find"]);
	});
});

describe("comboFromEvent", () => {
	it("spells ⌘ on Mac and Ctrl elsewhere as mod, and lower-cases letters", () => {
		expect(comboFromEvent(key("K", { metaKey: true, shiftKey: true }), true)).toEqual({
			key: "k",
			mod: true,
			shift: true,
		});
		expect(comboFromEvent(key("k", { ctrlKey: true }), false)).toEqual({ key: "k", mod: true });
		expect(comboFromEvent(key("j"), true)).toEqual({ key: "j" });
	});

	it("takes a shifted symbol as shift: any, so it follows the keyboard layout", () => {
		expect(comboFromEvent(key("?", { shiftKey: true }), true)).toEqual({ key: "?", shift: "any" });
		expect(comboFromEvent(key("ArrowUp", { metaKey: true, shiftKey: true }), true)).toEqual({
			key: "ArrowUp",
			mod: true,
			shift: true,
		});
	});

	it("refuses what matchCombo can never match: bare modifiers, Alt, and the other platform's modifier", () => {
		expect(comboFromEvent(key("Shift", { shiftKey: true }), true)).toBeNull();
		expect(comboFromEvent(key("Meta", { metaKey: true }), true)).toBeNull();
		expect(comboFromEvent(key("k", { altKey: true }), true)).toBeNull();
		expect(comboFromEvent(key("k", { ctrlKey: true }), true)).toBeNull();
		expect(comboFromEvent(key("k", { metaKey: true }), false)).toBeNull();
	});

	it("produces combos that match the very press they came from", () => {
		const press = key("G", { metaKey: true, shiftKey: true });
		const combo = comboFromEvent(press, true) as Combo;
		expect(shortcutFires("find", press, null, true)).toBe(false);
		setOverride("find", combo);
		expect(shortcutFires("find", press, null, true)).toBe(true);
		resetOverrides();
	});
});

describe("comboProblem", () => {
	it("rejects the keys a browser tab keeps", () => {
		for (const k of ["t", "w", "n", "r", "l", "q", "1", "[", "]"]) {
			expect(comboProblem("find", { key: k, mod: true })).not.toBeNull();
		}
		expect(comboProblem("find", { key: "k", mod: true })).toBeNull();
		expect(comboProblem("find", { key: "t" })).toBeNull();
	});

	it("insists on ⌘/Ctrl for a shortcut that also works while typing", () => {
		expect(SHORTCUTS.palette.typing).toBe("allow");
		expect(comboProblem("palette", { key: "p" })).not.toBeNull();
		expect(comboProblem("palette", { key: "p", mod: true })).toBeNull();
		expect(comboProblem("palette", { key: "F2" })).toBeNull();
	});
});

describe("remapping", () => {
	let store: Map<string, string>;
	beforeEach(() => {
		store = installStorage();
		reloadOverrides();
	});
	afterEach(() => {
		resetOverrides();
	});

	it("uses the default until an override is set, then only the override", () => {
		expect(shortcutFires("find", key("/"), null, true)).toBe(true);
		setOverride("find", { key: "f", mod: true });
		expect(shortcutFires("find", key("/"), null, true)).toBe(false);
		expect(shortcutFires("find", key("f", { metaKey: true }), null, true)).toBe(true);
		expect(effectiveKeys("find")).toEqual({ key: "f", mod: true });
	});

	it("persists across a reload and falls back when the override is cleared", () => {
		setOverride("blockCopy", { key: "x", mod: true });
		expect(JSON.parse(store.get(KEYBINDINGS_KEY)!)).toEqual({ blockCopy: { key: "x", mod: true } });
		reloadOverrides();
		expect(shortcutFires("blockCopy", key("x", { metaKey: true }), null, true)).toBe(true);
		expect(shortcutFires("blockCopy", key("c", { metaKey: true }), null, true)).toBe(false);
		setOverride("blockCopy", null);
		expect(store.has(KEYBINDINGS_KEY)).toBe(false);
		expect(shortcutFires("blockCopy", key("c", { metaKey: true }), null, true)).toBe(true);
	});

	it("stores nothing for the default's own keys, and ignores fixed shortcuts", () => {
		setOverride("find", SHORTCUTS.find.keys);
		expect(store.has(KEYBINDINGS_KEY)).toBe(false);
		setOverride("escape", { key: "q" });
		expect(store.has(KEYBINDINGS_KEY)).toBe(false);
		expect(shortcutFires("escape", key("Escape"), null, true)).toBe(true);
	});

	it("resets every override at once", () => {
		setOverride("find", { key: "f", mod: true });
		setOverride("copyReply", { key: "u" });
		resetOverrides();
		expect(store.has(KEYBINDINGS_KEY)).toBe(false);
		expect(effectiveKeys("copyReply")).toEqual(SHORTCUTS.copyReply.keys);
	});

	it("reads a stored value that was hand-edited into nonsense as no overrides", () => {
		store.set(KEYBINDINGS_KEY, "{not json");
		reloadOverrides();
		expect(effectiveKeys("find")).toEqual(SHORTCUTS.find.keys);
		store.set(KEYBINDINGS_KEY, JSON.stringify({ find: { key: 5 }, escape: { key: "q" } }));
		reloadOverrides();
		expect(effectiveKeys("find")).toEqual(SHORTCUTS.find.keys);
		expect(effectiveKeys("escape")).toEqual(SHORTCUTS.escape.keys);
	});

	it("keeps the palette on ⌘K and moves the sessions sidebar off it by default", () => {
		expect(shortcutFires("palette", key("k", { metaKey: true }), { tagName: "TEXTAREA" }, true)).toBe(true);
		expect(shortcutFires("sidebar", key("k", { metaKey: true }), null, true)).toBe(false);
		expect(shortcutFires("sidebar", key("\\", { metaKey: true }), null, true)).toBe(true);
	});
});
