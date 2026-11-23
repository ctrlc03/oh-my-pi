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
const ON_BY_DEFAULT = ["agents"];
const OFF_BY_DEFAULT = TOP_BAR_BUTTONS.map(button => button.id).filter(id => !ON_BY_DEFAULT.includes(id));
/** The bar every device had before the header went quiet: a choice saved then lists these, in this order. */
const OLD_BAR = [
	"settings",
	"find",
	"editor",
	"codemap",
	"quizzes",
	"github",
	"agents",
	"sparring",
	"bakeoff",
	"leave",
];

describe("parseTopBar", () => {
	it("is the quiet default bar for anything that is not a saved choice, with every other button off", () => {
		for (const raw of [null, undefined, "find", 7, [], {}]) {
			expect(parseTopBar(raw)).toEqual([...DEFAULT_TOP_BAR]);
		}
		expect(shown(DEFAULT_TOP_BAR)).toEqual(ON_BY_DEFAULT);
		expect(ids(DEFAULT_TOP_BAR).slice(0, ON_BY_DEFAULT.length)).toEqual(ON_BY_DEFAULT);
		expect(OFF_BY_DEFAULT.length).toBeGreaterThan(0);
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

	it("puts buttons the saved order lacks last: the default-on ones shown, the rest off", () => {
		const items = parseTopBar({ order: ["leave", "find"] });
		expect(ids(items).slice(0, 2)).toEqual(["leave", "find"]);
		expect(new Set(ids(items)).size).toBe(TOP_BAR_BUTTONS.length);
		expect(shown(items).sort()).toEqual([...ON_BY_DEFAULT, "leave", "find"].sort());
	});

	it("keeps a choice saved with the old bar as it was, and turns nothing else on", () => {
		// A choice saved when the bar had ten default buttons, one of them hidden.
		const before = { order: [...OLD_BAR].reverse(), hidden: ["quizzes"] };
		const items = parseTopBar(before);
		expect(shown(items)).toEqual(OLD_BAR.filter(id => id !== "quizzes").reverse());
		expect(ids(items).slice(0, OLD_BAR.length)).toEqual([...OLD_BAR].reverse());
		expect(items.filter(item => !OLD_BAR.includes(item.id)).every(item => !item.shown)).toBe(true);
	});

	it("keeps an off-by-default button the choice turned on", () => {
		const items = parseTopBar({
			order: [...ON_BY_DEFAULT, ...OFF_BY_DEFAULT],
			hidden: OFF_BY_DEFAULT.filter(id => id !== "terminal"),
		});
		expect(shown(items)).toEqual([...ON_BY_DEFAULT, "terminal"]);
	});
});

describe("editing", () => {
	it("moves a button one place and stops at the ends", () => {
		expect(ids(moveTopBarItem(DEFAULT_TOP_BAR, "editor", -1)).slice(0, 4)).toEqual([
			"agents",
			"settings",
			"editor",
			"find",
		]);
		expect(ids(moveTopBarItem(DEFAULT_TOP_BAR, "agents", 1)).slice(0, 2)).toEqual(["settings", "agents"]);
		expect(moveTopBarItem(DEFAULT_TOP_BAR, "agents", -1)).toEqual([...DEFAULT_TOP_BAR]);
		expect(moveTopBarItem(DEFAULT_TOP_BAR, DEFAULT_TOP_BAR.at(-1)!.id, 1)).toEqual([...DEFAULT_TOP_BAR]);
	});

	it("keeps a hidden button's place and tells the default from a change", () => {
		const hidden = showTopBarItem(DEFAULT_TOP_BAR, "agents", false);
		expect(ids(hidden)).toEqual(ids(DEFAULT_TOP_BAR));
		expect(isDefaultTopBar(hidden)).toBe(false);
		expect(isDefaultTopBar(showTopBarItem(hidden, "agents", true))).toBe(true);
		expect(isDefaultTopBar(moveTopBarItem(DEFAULT_TOP_BAR, "find", 1))).toBe(false);
		expect(isDefaultTopBar(showTopBarItem(DEFAULT_TOP_BAR, "terminal", true))).toBe(false);
	});
});

describe("visibleTopBar", () => {
	const all = (): boolean => true;

	it("draws the shown buttons in order", () => {
		const items = showTopBarItem(moveTopBarItem(parseTopBar({ order: OLD_BAR }), "agents", -1), "settings", false);
		expect(visibleTopBar(items, all)).toEqual([
			"find",
			"editor",
			"codemap",
			"quizzes",
			"agents",
			"github",
			"sparring",
			"bakeoff",
			"leave",
		]);
	});

	it("draws only Agents in the default bar", () => {
		expect(visibleTopBar(DEFAULT_TOP_BAR, all)).toEqual(["agents"]);
	});

	it("skips a button whose action is missing without forgetting the choice", () => {
		const missing = new Set<TopBarId>(["codemap", "github"]);
		const items = parseTopBar({ order: ["github", "codemap", ...OLD_BAR] });
		expect(visibleTopBar(items, id => !missing.has(id))).toEqual([
			"settings",
			"find",
			"editor",
			"quizzes",
			"agents",
			"sparring",
			"bakeoff",
			"leave",
		]);
		expect(visibleTopBar(items, all).slice(0, 2)).toEqual(["github", "codemap"]);
	});
});

describe("phoneTopBar", () => {
	it("keeps only Agents in the phone bar for the default choice", () => {
		expect(phoneTopBar(visibleTopBar(DEFAULT_TOP_BAR, () => true))).toEqual(["agents"]);
	});

	it("keeps the old phone bar for a choice saved with the old bar", () => {
		expect(phoneTopBar(visibleTopBar(parseTopBar({ order: OLD_BAR }), () => true))).toEqual([
			"find",
			"editor",
			"codemap",
			"agents",
		]);
	});

	it("leaves out the buttons that never fit a phone and stops at the room there is", () => {
		const old = parseTopBar({ order: OLD_BAR });
		const items = showTopBarItem(showTopBarItem(old, "terminal", true), "preview", true);
		// Terminal and Preview come after Agents, which is already the fourth that fits.
		expect(phoneTopBar(visibleTopBar(items, () => true))).toEqual(["find", "editor", "codemap", "agents"]);
		const first = phoneTopBar(visibleTopBar(parseTopBar({ order: ["terminal", ...OLD_BAR] }), () => true));
		expect(first).toEqual(["terminal", "find", "editor", "codemap"]);
		expect(first).toHaveLength(PHONE_SLOTS);
	});
});
