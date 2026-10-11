import { describe, expect, it } from "bun:test";
import type { WirePrWatch } from "@oh-my-pi/pi-wire/pr-watch";
import type { PrWatchManager } from "../../src/pr-watch/manager";
import type { ToolSession } from "../../src/tools";
import { WatchPrTool } from "../../src/tools/watch-pr";

const WATCHED: WirePrWatch = {
	key: "acme/app#7",
	repo: "acme/app",
	number: 7,
	url: "https://github.com/acme/app/pull/7",
	title: "Add widgets",
	state: "open",
	checks: "failing",
	conflict: false,
	wakes: 0,
	queued: false,
};

function tool(watched: WirePrWatch[], merged = false): WatchPrTool {
	const manager = {
		list: () => watched,
		unwatch: (target: string) => target === WATCHED.key,
		watch: async () => ({ pr: merged ? { ...WATCHED, state: "merged" as const } : WATCHED, watching: !merged }),
	} as unknown as PrWatchManager;
	return new WatchPrTool({ getPrWatch: () => manager } as unknown as ToolSession);
}

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
	result.content.map(part => part.text ?? "").join("");

describe("watch_pr", () => {
	it("needs approval to watch or unwatch, not to list", () => {
		const watch = tool([]);
		expect(watch.approval({ action: "list" })).toBe("read");
		expect(watch.approval({ action: "watch" })).toBe("write");
		expect(watch.approval({ action: "unwatch", pr: "#7" })).toBe("write");
	});

	it("reports the status of what it watches and what it lists", async () => {
		const watch = tool([WATCHED]);
		expect(textOf(await watch.execute("1", { action: "watch" }))).toContain("acme/app#7");
		expect(textOf(await watch.execute("2", { action: "list" }))).toContain("checks failing");
		expect(textOf(await tool([]).execute("3", { action: "list" }))).toContain("No pull requests");
	});

	it("says there is nothing to watch for a finished pull request", async () => {
		expect(textOf(await tool([], true).execute("1", { action: "watch", pr: "#7" }))).toContain("Nothing to watch");
	});

	it("fails to unwatch what is not watched", async () => {
		const watch = tool([WATCHED]);
		expect(textOf(await watch.execute("1", { action: "unwatch", pr: "acme/app#7" }))).toContain("Stopped");
		await expect(watch.execute("2", { action: "unwatch", pr: "acme/app#8" })).rejects.toThrow();
		await expect(watch.execute("3", { action: "unwatch" })).rejects.toThrow();
	});
});
