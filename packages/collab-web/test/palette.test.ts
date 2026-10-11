import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { findMessages, snippetAround } from "../src/lib/palette-messages";
import {
	bumpRecent,
	MAX_RECENTS,
	type PaletteEntry,
	paletteEntries,
	parseQuery,
	parseRecents,
	rankItems,
	setPaletteEntries,
} from "../src/lib/palette";

const entry = (id: string, title = id): PaletteEntry => ({ id, title, run: () => undefined });
const item = (key: string, title: string, keywords?: string[]) => ({ key, title, keywords });

describe("registry", () => {
	it("lists what owners register, in order, and drops it when they withdraw", () => {
		const a = Symbol("a");
		const b = Symbol("b");
		const withdrawA = setPaletteEntries(a, [entry("a:one"), entry("a:two")]);
		const withdrawB = setPaletteEntries(b, [entry("b:one")]);
		expect(paletteEntries().map(e => e.id)).toEqual(["a:one", "a:two", "b:one"]);
		withdrawA();
		expect(paletteEntries().map(e => e.id)).toEqual(["b:one"]);
		withdrawB();
		expect(paletteEntries()).toEqual([]);
	});

	it("replaces an owner's earlier list instead of adding to it, and an empty list withdraws", () => {
		const owner = Symbol("owner");
		setPaletteEntries(owner, [entry("x:1"), entry("x:2")]);
		setPaletteEntries(owner, [entry("x:3")]);
		expect(paletteEntries().map(e => e.id)).toEqual(["x:3"]);
		setPaletteEntries(owner, []);
		expect(paletteEntries()).toEqual([]);
	});

	it("lets a later registration of the same id win, once", () => {
		const a = Symbol("a");
		const b = Symbol("b");
		setPaletteEntries(a, [entry("dup", "first")]);
		setPaletteEntries(b, [entry("dup", "second")]);
		const found = paletteEntries().filter(e => e.id === "dup");
		expect(found.map(e => e.title)).toEqual(["second"]);
		setPaletteEntries(a, []);
		setPaletteEntries(b, []);
	});

	it("hands out the same array until something changes (it feeds useSyncExternalStore)", () => {
		const owner = Symbol("owner");
		setPaletteEntries(owner, [entry("s:1")]);
		const before = paletteEntries();
		expect(paletteEntries()).toBe(before);
		setPaletteEntries(owner, [entry("s:1"), entry("s:2")]);
		expect(paletteEntries()).not.toBe(before);
		setPaletteEntries(owner, []);
	});

	it("withdraws only once", () => {
		const owner = Symbol("owner");
		const withdraw = setPaletteEntries(owner, [entry("w:1")]);
		withdraw();
		const after = paletteEntries();
		withdraw();
		expect(paletteEntries()).toBe(after);
	});
});

describe("parseQuery", () => {
	it("reads a scope prefix and trims what follows", () => {
		expect(parseQuery(">  deploy ")).toEqual({ scope: "actions", text: "deploy" });
		expect(parseQuery("/model")).toEqual({ scope: "commands", text: "model" });
		expect(parseQuery("@ auth")).toEqual({ scope: "sessions", text: "auth" });
		expect(parseQuery("#fix the bug")).toEqual({ scope: "messages", text: "fix the bug" });
	});

	it("searches everything without a prefix, and only a leading one counts", () => {
		expect(parseQuery(" open github ")).toEqual({ scope: null, text: "open github" });
		expect(parseQuery("a/b")).toEqual({ scope: null, text: "a/b" });
		expect(parseQuery("")).toEqual({ scope: null, text: "" });
		expect(parseQuery(">")).toEqual({ scope: "actions", text: "" });
	});
});

describe("recents", () => {
	it("moves a pick to the front without duplicating it and caps the list", () => {
		expect(bumpRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
		expect(bumpRecent([], "a")).toEqual(["a"]);
		const many = Array.from({ length: MAX_RECENTS + 5 }, (_, i) => `k${i}`);
		expect(bumpRecent(many, "new")).toHaveLength(MAX_RECENTS);
		expect(bumpRecent(many, "new")[0]).toBe("new");
	});

	it("keeps only strings from stored junk", () => {
		expect(parseRecents(["a", 3, "", "a", null, "b"])).toEqual(["a", "b"]);
		expect(parseRecents({ a: 1 })).toEqual([]);
		expect(parseRecents(null)).toEqual([]);
	});
});

describe("rankItems", () => {
	const items = [
		item("action:usage", "Usage: spend and tokens", ["cost"]),
		item("action:github", "GitHub issues and pull requests", ["gh", "pr"]),
		item("action:changes", "Changed files and working tree"),
		item("command:model", "/model"),
	];

	it("lists everything in the given order when nothing is typed", () => {
		expect(rankItems(items, "", []).map(r => r.item.key)).toEqual(items.map(i => i.key));
	});

	it("puts recent picks first, newest first, when nothing is typed", () => {
		const ranked = rankItems(items, "", ["command:model", "action:changes"]).map(r => r.item.key);
		expect(ranked).toEqual(["command:model", "action:changes", "action:usage", "action:github"]);
	});

	it("keeps only matches, best first", () => {
		const ranked = rankItems(items, "git", []).map(r => r.item.key);
		expect(ranked[0]).toBe("action:github");
		expect(ranked).not.toContain("action:usage");
	});

	it("finds by keyword, below a title hit, with no title highlight", () => {
		const byKeyword = rankItems(items, "cost", []);
		expect(byKeyword.map(r => r.item.key)).toEqual(["action:usage"]);
		expect(byKeyword[0]!.positions).toEqual([]);
		const mixed = rankItems([item("a", "Cost report"), item("b", "Usage", ["cost"])], "cost", []);
		expect(mixed.map(r => r.item.key)).toEqual(["a", "b"]);
	});

	it("lets recency settle a near-tie but not beat a clearly better match", () => {
		const twins = [item("one", "Open sheet"), item("two", "Open sheet")];
		expect(rankItems(twins, "open", ["two"]).map(r => r.item.key)).toEqual(["two", "one"]);
		const mixed = [item("exact", "Terminal"), item("weak", "Tool for emails and runtime")];
		expect(rankItems(mixed, "term", ["weak"]).map(r => r.item.key)[0]).toBe("exact");
	});

	it("keeps the given order for equal scores", () => {
		const same = [item("a", "Sheet"), item("b", "Sheet"), item("c", "Sheet")];
		expect(rankItems(same, "sheet", []).map(r => r.item.key)).toEqual(["a", "b", "c"]);
	});
});

const message = (
	id: string,
	role: "user" | "assistant",
	text: string,
	timestamp = "2026-01-01T00:00:00.000Z",
): SessionEntry =>
	role === "user"
		? ({
				type: "message",
				id,
				parentId: null,
				timestamp,
				message: { role, content: text },
			} as unknown as SessionEntry)
		: ({
				type: "message",
				id,
				parentId: null,
				timestamp,
				message: { role, content: [{ type: "text", text }] },
			} as unknown as SessionEntry);

describe("findMessages", () => {
	const entries = [
		message("1", "user", "please fix the flaky login test"),
		message("2", "assistant", "The login test was flaky because of a race."),
		message("3", "user", "now deploy"),
	];

	it("returns the newest matches first, with role and snippet", () => {
		const hits = findMessages(entries, "login test", 10);
		expect(hits.map(h => h.entryId)).toEqual(["2", "1"]);
		expect(hits.map(h => h.role)).toEqual(["assistant", "user"]);
		expect(hits[0]!.time).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
	});

	it("needs every word, ignores case, and honours the limit", () => {
		expect(findMessages(entries, "LOGIN deploy", 10)).toEqual([]);
		expect(findMessages(entries, "login", 1).map(h => h.entryId)).toEqual(["2"]);
		expect(findMessages(entries, "  ", 10)).toEqual([]);
	});

	it("does not look inside tool calls or non-message entries", () => {
		const other = [
			{ type: "model_change", id: "m", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", model: "login/x" },
		] as unknown as SessionEntry[];
		expect(findMessages(other, "login", 10)).toEqual([]);
	});
});

describe("snippetAround", () => {
	it("returns short text whole, on one line", () => {
		expect(snippetAround("a\n\nb   c", ["b"])).toBe("a b c");
	});

	it("centres long text on the first hit and marks the cuts", () => {
		const text = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
		const snippet = snippetAround(text, ["needle"]);
		expect(snippet).toContain("needle");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBeLessThan(160);
	});

	it("starts at the beginning when the hit is near it", () => {
		const snippet = snippetAround(`needle ${"y".repeat(400)}`, ["needle"]);
		expect(snippet.startsWith("needle")).toBe(true);
	});
});
