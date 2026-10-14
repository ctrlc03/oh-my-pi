import { describe, expect, it } from "bun:test";
import {
	DEFAULT_TOP_BAR,
	isDefaultTopBar,
	moveTopBarItem,
	PHONE_SLOTS,
	parseTopBar,
	phoneTopBar,
	showTopBarItem,
	TOP_BAR_BUTTONS,
	type TopBarId,
	visibleTopBar,
} from "../src/lib/top-bar";

const ids = (items: readonly { id: string }[]): string[] => items.map(item => item.id);
const shown = (items: readonly { id: string; shown: boolean }[]): string[] =>
	items.filter(item => item.shown).map(item => item.id);
const TODAYS = ["settings", "find", "editor", "codemap", "quizzes", "github", "agents", "leave"];
const SHEET_ONLY = TOP_BAR_BUTTONS.map(button => button.id).filter(id => !TODAYS.includes(id));

describe("parseTopBar", () => {
	it("is today's bar for anything that is not a saved choice, with the sheet-only buttons off", () => {
		for (const raw of [null, undefined, "find", 7, [], {}]) {
			expect(parseTopBar(raw)).toEqual([...DEFAULT_TOP_BAR]);
		}
		expect(shown(DEFAULT_TOP_BAR)).toEqual(TODAYS);
		expect(ids(DEFAULT_TOP_BAR).slice(0, TODAYS.length)).toEqual(TODAYS);
		expect(SHEET_ONLY.length).toBeGreaterThan(0);
	});

	it("keeps a saved order and the hidden buttons", () => {
		const items = parseTopBar({ order: ["agents", "find", "settings"], hidden: ["find"] });
		expect(ids(items).slice(0, 3)).toEqual(["agents", "find", "settings"]);
		expect(items.slice(0, 3).map(item => item.shown)).toEqual([true, false, true]);
	});

	it("ignores unknown and repeated ids, and wrong types", () => {
		const items = parseTopBar({
			order: ["github", "bogus", "github", 3, null, "find"],
			hidden: ["bogus", "editor", 9],
		});
		expect(ids(items).slice(0, 2)).toEqual(["github", "find"]);
		expect(items.find(item => item.id === "editor")?.shown).toBe(false);
		expect(new Set(ids(items)).size).toBe(TOP_BAR_BUTTONS.length);
	});

	it("puts buttons the saved order lacks last: today's shown, the sheet-only ones off", () => {
		const items = parseTopBar({ order: ["leave", "find"] });
		expect(ids(items).slice(0, 2)).toEqual(["leave", "find"]);
		expect(new Set(ids(items)).size).toBe(TOP_BAR_BUTTONS.length);
		expect(shown(items).sort()).toEqual([...TODAYS].sort());
	});

	it("never turns on a button added after the choice was made", () => {
		// A choice saved when the bar had only today's eight buttons, one of them hidden.
		const before = { order: [...TODAYS].reverse(), hidden: ["quizzes"] };
		const items = parseTopBar(before);
		expect(shown(items)).toEqual(TODAYS.filter(id => id !== "quizzes").reverse());
		expect(ids(items).slice(0, TODAYS.length)).toEqual([...TODAYS].reverse());
		expect(items.filter(item => SHEET_ONLY.includes(item.id)).every(item => !item.shown)).toBe(true);
	});

	it("keeps a sheet-only button the choice turned on", () => {
		const items = parseTopBar({
			order: [...TODAYS, ...SHEET_ONLY],
			hidden: SHEET_ONLY.filter(id => id !== "terminal"),
		});
		expect(shown(items)).toEqual([...TODAYS, "terminal"]);
	});
});

describe("editing", () => {
	it("moves a button one place and stops at the ends", () => {
		expect(ids(moveTopBarItem(DEFAULT_TOP_BAR, "editor", -1)).slice(0, 3)).toEqual(["settings", "editor", "find"]);
		expect(ids(moveTopBarItem(DEFAULT_TOP_BAR, "settings", 1)).slice(0, 2)).toEqual(["find", "settings"]);
		expect(moveTopBarItem(DEFAULT_TOP_BAR, "settings", -1)).toEqual([...DEFAULT_TOP_BAR]);
		expect(moveTopBarItem(DEFAULT_TOP_BAR, DEFAULT_TOP_BAR.at(-1)!.id, 1)).toEqual([...DEFAULT_TOP_BAR]);
	});

	it("keeps a hidden button's place and tells the default from a change", () => {
		const hidden = showTopBarItem(DEFAULT_TOP_BAR, "codemap", false);
		expect(ids(hidden)).toEqual(ids(DEFAULT_TOP_BAR));
		expect(isDefaultTopBar(hidden)).toBe(false);
		expect(isDefaultTopBar(showTopBarItem(hidden, "codemap", true))).toBe(true);
		expect(isDefaultTopBar(moveTopBarItem(DEFAULT_TOP_BAR, "find", 1))).toBe(false);
		expect(isDefaultTopBar(showTopBarItem(DEFAULT_TOP_BAR, "terminal", true))).toBe(false);
	});
});

describe("visibleTopBar", () => {
	const all = (): boolean => true;

	it("draws the shown buttons in order", () => {
		const items = showTopBarItem(moveTopBarItem(DEFAULT_TOP_BAR, "agents", -1), "settings", false);
		expect(visibleTopBar(items, all)).toEqual(["find", "editor", "codemap", "quizzes", "agents", "github", "leave"]);
	});

	it("skips a button whose action is missing without forgetting the choice", () => {
		const missing = new Set<TopBarId>(["codemap", "github"]);
		const items = parseTopBar({ order: ["github", "codemap"] });
		expect(visibleTopBar(items, id => !missing.has(id))).toEqual([
			"settings",
			"find",
			"editor",
			"quizzes",
			"agents",
			"leave",
		]);
		expect(visibleTopBar(items, all).slice(0, 2)).toEqual(["github", "codemap"]);
	});
});

describe("phoneTopBar", () => {
	it("keeps today's phone bar for the default choice", () => {
		expect(phoneTopBar(visibleTopBar(DEFAULT_TOP_BAR, () => true))).toEqual(["find", "editor", "codemap", "agents"]);
	});

	it("leaves out the buttons that never fit a phone and stops at the room there is", () => {
		const items = showTopBarItem(showTopBarItem(DEFAULT_TOP_BAR, "terminal", true), "preview", true);
		// Terminal and Preview come after Agents, which is already the fourth that fits.
		expect(phoneTopBar(visibleTopBar(items, () => true))).toEqual(["find", "editor", "codemap", "agents"]);
		const first = phoneTopBar(visibleTopBar(parseTopBar({ order: ["terminal"] }), () => true));
		expect(first).toEqual(["terminal", "find", "editor", "codemap"]);
		expect(first).toHaveLength(PHONE_SLOTS);
	});
});
