import { describe, expect, it } from "bun:test";
import {
	checkSessionId,
	createRunSlots,
	type Locks,
	locked,
	partExcerpts,
	positiveInt,
	prRange,
	pullRequestNumbers,
	verifiedRefs,
} from "../scripts/companion-review-base";
import { seeded } from "../scripts/companion-seed";

describe("request checks", () => {
	it("takes whole positive numbers, session ids of the right shape, and stacks of one to eight", () => {
		expect(positiveInt(3, "x")).toBe(3);
		for (const bad of [0, -1, 1.5, "3", Number.NaN, 1e12])
			expect(() => positiveInt(bad, "number")).toThrow(/invalid number/);
		expect(checkSessionId(undefined)).toBeUndefined();
		expect(checkSessionId("01a12fa5-758e-7595-b768-bb9462d6e44e")).toBe("01a12fa5-758e-7595-b768-bb9462d6e44e");
		for (const bad of ["../x", "short", 4, "has space in it"])
			expect(() => checkSessionId(bad)).toThrow(/invalid session/);
		expect(pullRequestNumbers({})).toBeUndefined();
		expect(pullRequestNumbers({ pr: 4 })).toEqual([4]);
		expect(pullRequestNumbers({ stack: [1, 2] })).toEqual([1, 2]);
		expect(() => pullRequestNumbers({ stack: [] })).toThrow(/between 1 and/);
		expect(() => pullRequestNumbers({ stack: [2, 2] })).toThrow(/invalid stack/);
		expect(prRange([4])).toBe("PR #4");
		expect(prRange([4, 5, 6])).toBe("PRs #4–#6");
	});
});

describe("run slots and locks", () => {
	it("lets a limited number of runs go at once, in the order they asked", async () => {
		const slots = createRunSlots(1);
		const order: string[] = [];
		await slots.acquire();
		const second = slots.acquire().then(() => order.push("second"));
		const third = slots.acquire().then(() => order.push("third"));
		await Promise.resolve();
		expect(order).toEqual([]);
		slots.release();
		await second;
		expect(order).toEqual(["second"]);
		slots.release();
		await third;
		expect(order).toEqual(["second", "third"]);
		slots.release();
	});

	it("runs the work on one document one piece after the other, even when one fails", async () => {
		const locks: Locks = new Map();
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const slow = locked(locks, "a", async () => {
			events.push("slow start");
			await gate.promise;
			events.push("slow end");
			throw new Error("boom");
		});
		const fast = locked(locks, "a", async () => {
			events.push("fast");
			return 1;
		});
		const other = locked(locks, "b", async () => events.push("other"));
		await other;
		gate.resolve();
		await expect(slow).rejects.toThrow("boom");
		expect(await fast).toBe(1);
		await other;
		expect(events.indexOf("other")).toBeLessThan(events.indexOf("slow end"));
		expect(events.slice(events.indexOf("slow end"))).toEqual(["slow end", "fast"]);
		expect(locks.size).toBe(0);
	});
});

describe("documents that are not in git", () => {
	const subject = {
		repo: { root: "/does/not/exist" },
		parts: [{ index: 0, title: "Design", head: { commit: "0".repeat(40) } }],
		documents: new Map([["@design", ["# Plan", "We use Redis.", "TTL is five minutes."]]]),
	};

	it("reads cited lines of the document from its stored lines, without touching the repository", async () => {
		const [excerpt, missing] = await partExcerpts(subject, 0, [
			{ path: "@design", line: 2, token: "Redis" },
			{ path: "@design", line: 99, token: "x" },
		]);
		expect(excerpt!.lines[excerpt!.line - excerpt!.start]).toBe("We use Redis.");
		expect(missing).toBeNull();
		await expect(partExcerpts(subject, 4, [])).rejects.toThrow(/no such part/);
	});

	it("keeps the citations of the document that hold and moves one that is off by a line", async () => {
		const refs = await verifiedRefs(subject, 0, [
			{ path: "@design", line: 1, token: "Redis" },
			{ path: "@design", line: 1, token: "unicorn" },
		]);
		expect(refs).toEqual([{ path: "@design", line: 2, token: "Redis" }]);
		expect(await verifiedRefs(subject, 7, [{ path: "@design", line: 1, token: "Plan" }])).toEqual([]);
	});
});

describe("seeded", () => {
	it("gives the same numbers for the same seed and different ones for another", () => {
		const a = seeded("sp-1");
		const b = seeded("sp-1");
		const first = [a(), a(), a()];
		expect([b(), b(), b()]).toEqual(first);
		expect(seeded("sp-2")()).not.toBe(first[0]!);
		for (const n of first) {
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThan(1);
		}
	});
});
