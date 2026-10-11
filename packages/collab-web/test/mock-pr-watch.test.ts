import { describe, expect, it } from "bun:test";
import { MockPrWatch } from "../scripts/mock-pr-watch";

function setup() {
	let now = 0;
	const wakes: string[] = [];
	const notices: string[] = [];
	let busy = false;
	const watch = new MockPrWatch({
		onState: () => {},
		notice: (_level, message) => notices.push(message),
		busy: () => busy,
		wake: text => wakes.push(text),
		now: () => now,
	});
	return {
		watch,
		wakes,
		notices,
		setBusy: (value: boolean) => {
			busy = value;
		},
		advance: (seconds: number) => {
			now += seconds * 1000;
			watch.tick();
		},
	};
}

describe("MockPrWatch", () => {
	it("watches a pull request, wakes on its failing check and its comment, and stops on merge", () => {
		const { watch, wakes, advance } = setup();
		expect(watch.watch("")).toBeUndefined();
		expect(watch.list()?.map(pr => pr.key)).toEqual(["acme/web#42"]);
		advance(10);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]).toContain("Required checks failed: test");
		advance(60);
		expect(wakes).toHaveLength(2);
		expect(wakes[1]).toContain("retry delay");
		advance(20);
		expect(watch.list()).toBeUndefined();
	});

	it("holds the wake while the session is running", () => {
		const { watch, wakes, advance, setBusy } = setup();
		watch.watch("acme/web#9");
		setBusy(true);
		advance(10);
		expect(wakes).toEqual([]);
		expect(watch.list()?.[0]?.queued).toBe(true);
		setBusy(false);
		advance(1);
		expect(wakes).toHaveLength(1);
	});

	it("unwatches by key and refuses what is not a pull request", () => {
		const { watch } = setup();
		expect(watch.watch("nonsense")).toContain("not a pull request");
		watch.watch("acme/web#9");
		expect(watch.unwatch("acme/web#1")).toContain("not a watched");
		expect(watch.unwatch("acme/web#9")).toBeUndefined();
		expect(watch.list()).toBeUndefined();
	});
});
