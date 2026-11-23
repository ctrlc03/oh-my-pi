import { describe, expect, it } from "bun:test";
import { dropIndex, mergeOrder, moveInOrder, orderComputers, parseOrder } from "../src/lib/computer-order";

const computers = (...ids: string[]): { id: string }[] => ids.map(id => ({ id }));
const idsOf = (items: readonly { id: string }[]): string[] => items.map(item => item.id);

describe("parseOrder", () => {
	it("keeps the string ids once, in order, and nothing from a document that is not a list", () => {
		expect(parseOrder(["b", "a", "b", 3, null, "c"])).toEqual(["b", "a", "c"]);
		expect(parseOrder(null)).toEqual([]);
		expect(parseOrder({ 0: "a" })).toEqual([]);
		expect(parseOrder("a")).toEqual([]);
	});
});

describe("mergeOrder", () => {
	it("forgets computers no longer paired and puts new ones at the end in their own order", () => {
		expect(mergeOrder(["c", "gone", "a"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
	});

	it("is the paired order until one was arranged", () => {
		expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
	});
});

describe("orderComputers", () => {
	it("lists computers in the stored order, the ones it does not name last", () => {
		expect(idsOf(orderComputers(computers("mac", "studio", "vm"), ["studio", "mac"]))).toEqual([
			"studio",
			"mac",
			"vm",
		]);
		expect(idsOf(orderComputers(computers("mac", "studio"), ["gone", "studio"]))).toEqual(["studio", "mac"]);
	});

	it("returns the very list it was given when the order changes nothing", () => {
		const list = computers("mac", "studio");
		expect(orderComputers(list, [])).toBe(list);
		expect(orderComputers(list, ["mac", "studio"])).toBe(list);
		expect(orderComputers(list, ["mac"])).toBe(list);
	});
});

describe("moveInOrder", () => {
	it("puts the id at the index, clamped, and leaves an unknown id alone", () => {
		expect(moveInOrder(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
		expect(moveInOrder(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
		expect(moveInOrder(["a", "b", "c"], "a", 9)).toEqual(["b", "c", "a"]);
		expect(moveInOrder(["a", "b", "c"], "b", -4)).toEqual(["b", "a", "c"]);
		expect(moveInOrder(["a", "b"], "x", 0)).toEqual(["a", "b"]);
	});
});

describe("dropIndex", () => {
	it("is where the dragged group ends up once it left its place", () => {
		// a b c d: drag a behind c → b c a d.
		expect(dropIndex(0, 2, true)).toBe(2);
		// drag d before b → a d b c.
		expect(dropIndex(3, 1, false)).toBe(1);
		// dropped next to itself changes nothing.
		expect(dropIndex(1, 2, false)).toBe(1);
		expect(dropIndex(2, 1, true)).toBe(2);
		expect(dropIndex(1, 0, true)).toBe(1);
	});
});
