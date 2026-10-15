import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { buildChatItems } from "../src/components/transcript/chat-items";
import {
	type Block,
	buildBlocks,
	buildChatBlocks,
	extendTo,
	NO_SELECTION,
	selectedBlocks,
	selectOnly,
	toolResults,
} from "../src/lib/blocks";
import {
	applyHidden,
	blocksMemberIds,
	changingIds,
	emptyHidden,
	exchangeBlocks,
	type HiddenDoc,
	hiddenIds,
	hiddenSlots,
	isBlockHidden,
	MAX_HIDDEN_ENTRIES,
	MAX_HIDDEN_SESSIONS,
	memberIds,
	mergeHidden,
	parseHidden,
	parseStore,
	pruneHidden,
	sameHidden,
	visibleBlocks,
	withoutHidden,
} from "../src/lib/hidden-messages";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 10, 12);
const stamp = "2026-10-10T08:30:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

const prompt = (id: string, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: stamp,
	message: { role: "user", content: text, timestamp: 0 },
});

function reply(id: string, ...parts: ({ text: string } | { call: string })[]): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: parts.map(part =>
				"text" in part
					? { type: "text" as const, text: part.text }
					: { type: "toolCall" as const, id: part.call, name: "bash", arguments: { command: part.call } },
			),
			model: "m",
			usage,
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

const result = (call: string): SessionEntry => ({
	type: "message",
	id: `r-${call}`,
	parentId: null,
	timestamp: stamp,
	message: {
		role: "toolResult",
		toolCallId: call,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	},
});

/** Two exchanges: u1 → text, two calls, text; u2 → one call, text. */
const session: SessionEntry[] = [
	prompt("u1", "first"),
	reply("a1", { text: "Looking." }, { call: "c1" }),
	result("c1"),
	reply("a2", { call: "c2" }),
	result("c2"),
	reply("a3", { text: "Done." }),
	prompt("u2", "second"),
	reply("a4", { call: "c3" }),
	result("c3"),
	reply("a5", { text: "Also done." }),
];

const full = (): Block[] => buildBlocks(session, toolResults(session));
const chat = (): Block[] => buildChatBlocks(buildChatItems(session, null, true, []), toolResults(session));
const ids = (blocks: readonly Block[]): string[] => blocks.map(block => block.id);

const doc = (entries: Record<string, [number, boolean]>): HiddenDoc => ({
	entries: Object.fromEntries(Object.entries(entries).map(([id, [at, hidden]]) => [id, { at, hidden }])),
});

describe("block ids", () => {
	it("names a prompt by its entry, a reply by entry and index, a tool by its call", () => {
		expect(ids(full())).toEqual(["u1", "a1:0", "c1", "c2", "a3:0", "u2", "c3", "a5:0"]);
	});

	it("folds a chat run into one block that stands for every call", () => {
		const blocks = chat();
		expect(ids(blocks)).toEqual(["u1", "a1:0", "tools:c1", "a3:0", "u2", "tools:c3", "a5:0"]);
		expect(memberIds(blocks[2]!)).toEqual(["c1", "c2"]);
		expect(memberIds(blocks[1]!)).toEqual(["a1:0"]);
	});

	it("hides a folded run only while every call in it is hidden", () => {
		const run = chat()[2]!;
		expect(isBlockHidden(run, new Set(["c1"]))).toBe(false);
		expect(isBlockHidden(run, new Set(["c1", "c2"]))).toBe(true);
	});
});

describe("hidden runs", () => {
	it("groups blocks next to each other into one run with one start", () => {
		const slots = hiddenSlots(full(), new Set(["a1:0", "c1", "c2", "u2"]));
		expect([...slots.keys()]).toEqual(["a1:0", "c1", "c2", "u2"]);
		expect(slots.get("a1:0")).toEqual({ group: "a1:0", start: true, size: 3 });
		expect(slots.get("c1")).toEqual({ group: "a1:0", start: false, size: 3 });
		expect(slots.get("c2")?.group).toBe("a1:0");
		// a3:0 is shown between them and the last one, so u2 is a run of its own.
		expect(slots.get("u2")).toEqual({ group: "u2", start: true, size: 1 });
	});

	it("gives shown blocks no slot, and nothing hidden no runs", () => {
		expect(hiddenSlots(full(), new Set()).size).toBe(0);
		expect(hiddenSlots(full(), new Set(["a3:0"])).get("a1:0")).toBeUndefined();
	});

	it("counts a folded tool group as one message", () => {
		const slots = hiddenSlots(chat(), new Set(["a1:0", "c1", "c2"]));
		expect(slots.get("a1:0")?.size).toBe(2);
		expect(slots.get("tools:c1")).toEqual({ group: "a1:0", start: false, size: 2 });
	});

	it("keeps a partly hidden folded group visible", () => {
		expect(hiddenSlots(chat(), new Set(["c1"])).size).toBe(0);
	});

	it("runs through the whole transcript when everything is hidden", () => {
		const blocks = full();
		const slots = hiddenSlots(blocks, new Set(blocksMemberIds(blocks)));
		expect([...slots.values()].filter(slot => slot.start)).toEqual([
			{ group: "u1", start: true, size: blocks.length },
		]);
	});
});

describe("exchanges", () => {
	it("runs from a prompt to the next prompt, tool calls included", () => {
		expect(ids(exchangeBlocks(full(), "u1"))).toEqual(["u1", "a1:0", "c1", "c2", "a3:0"]);
		expect(ids(exchangeBlocks(full(), "u2"))).toEqual(["u2", "c3", "a5:0"]);
	});

	it("takes a folded tool group whole in the chat view", () => {
		const exchange = exchangeBlocks(chat(), "u1");
		expect(ids(exchange)).toEqual(["u1", "a1:0", "tools:c1", "a3:0"]);
		expect(blocksMemberIds(exchange)).toEqual(["u1", "a1:0", "c1", "c2", "a3:0"]);
	});

	it("is empty for an id that is not a prompt", () => {
		expect(exchangeBlocks(full(), "a1:0")).toEqual([]);
		expect(exchangeBlocks(full(), "nope")).toEqual([]);
	});

	it("is a prompt alone when the agent has not answered", () => {
		const blocks = buildBlocks([prompt("u9", "hi")], new Map());
		expect(ids(exchangeBlocks(blocks, "u9"))).toEqual(["u9"]);
	});
});

describe("picking a range", () => {
	it("a range over the shown blocks skips what a marker folds away", () => {
		const hidden = new Set(["c1", "c2"]);
		const shown = full().filter(block => !hidden.has(block.id));
		const range = extendTo(selectOnly("u1"), shown, "u2");
		expect(ids(selectedBlocks(range, shown))).toEqual(["u1", "a1:0", "a3:0", "u2"]);
		const picked = visibleBlocks(selectedBlocks(range, shown), hidden);
		expect(blocksMemberIds(picked)).toEqual(["u1", "a1:0", "a3:0", "u2"]);
	});

	it("a backwards range is the same range", () => {
		const blocks = full();
		const forward = extendTo(selectOnly("a1:0"), blocks, "c2");
		const backward = extendTo(selectOnly("c2"), blocks, "a1:0");
		expect([...forward.ids].sort()).toEqual([...backward.ids].sort());
		expect([...forward.ids].sort()).toEqual(["a1:0", "c1", "c2"]);
	});

	it("counts only the picked blocks that are not hidden yet", () => {
		const blocks = chat();
		const hidden = new Set(["a1:0"]);
		const range = extendTo(selectOnly("u1"), blocks, "a3:0");
		expect(selectedBlocks(range, blocks).length).toBe(4);
		expect(ids(visibleBlocks(selectedBlocks(range, blocks), hidden))).toEqual(["u1", "tools:c1", "a3:0"]);
		expect(visibleBlocks(selectedBlocks(NO_SELECTION, blocks), hidden)).toEqual([]);
	});
});

describe("the document", () => {
	it("hides and shows messages, and says what it changed", () => {
		const hidden = applyHidden(emptyHidden(), ["a", "b"], true, T0);
		expect([...hiddenIds(hidden)].sort()).toEqual(["a", "b"]);
		expect(changingIds(hidden, ["a", "c", "a"], true)).toEqual(["c"]);
		const shown = applyHidden(hidden, ["a"], false, T0 + 1);
		expect([...hiddenIds(shown)]).toEqual(["b"]);
		expect(shown.entries.a).toEqual({ at: T0 + 1, hidden: false });
	});

	it("returns the same document when nothing changes", () => {
		const hidden = applyHidden(emptyHidden(), ["a"], true, T0);
		expect(applyHidden(hidden, ["a"], true, T0 + 5)).toBe(hidden);
		expect(applyHidden(emptyHidden(), ["a"], false, T0)).toEqual(emptyHidden());
	});

	it("an action in the same millisecond as the last still wins", () => {
		const hidden = applyHidden(emptyHidden(), ["a"], true, T0);
		const shown = applyHidden(hidden, ["a"], false, T0);
		expect(shown.entries.a!.at).toBe(T0 + 1);
		expect(mergeHidden(hidden, shown).entries.a!.hidden).toBe(false);
	});

	it("ignores ids that cannot be keys", () => {
		expect(changingIds(emptyHidden(), ["", "__proto__", "x".repeat(300), "ok"], true)).toEqual(["ok"]);
	});

	it("compares documents by what they say", () => {
		expect(sameHidden(doc({ a: [1, true] }), doc({ a: [1, true] }))).toBe(true);
		expect(sameHidden(doc({ a: [1, true] }), doc({ a: [2, true] }))).toBe(false);
		expect(sameHidden(doc({ a: [1, true] }), doc({ b: [1, true] }))).toBe(false);
	});
});

describe("merging copies", () => {
	const a = doc({ x: [10, true], y: [5, true], z: [3, false] });
	const b = doc({ x: [20, false], y: [4, false], w: [1, true] });
	const c = doc({ x: [15, true], w: [2, false] });

	it("the later action wins per message", () => {
		const merged = mergeHidden(a, b);
		expect(merged.entries).toEqual({
			x: { at: 20, hidden: false },
			y: { at: 5, hidden: true },
			z: { at: 3, hidden: false },
			w: { at: 1, hidden: true },
		});
	});

	it("is commutative, associative and idempotent", () => {
		expect(sameHidden(mergeHidden(a, b), mergeHidden(b, a))).toBe(true);
		expect(sameHidden(mergeHidden(mergeHidden(a, b), c), mergeHidden(a, mergeHidden(b, c)))).toBe(true);
		expect(sameHidden(mergeHidden(a, a), a)).toBe(true);
	});

	it("at the same instant hidden wins on every device", () => {
		const hide = doc({ m: [7, true] });
		const show = doc({ m: [7, false] });
		expect(mergeHidden(hide, show).entries.m!.hidden).toBe(true);
		expect(mergeHidden(show, hide).entries.m!.hidden).toBe(true);
	});

	it("does not change its inputs", () => {
		const before = JSON.stringify(a);
		mergeHidden(a, b);
		expect(JSON.stringify(a)).toBe(before);
	});
});

describe("pruning", () => {
	it("drops old shown-again entries and keeps hidden ones and fresh tombstones", () => {
		const pruned = pruneHidden(
			doc({ old: [T0 - 31 * DAY, false], oldHidden: [T0 - 90 * DAY, true], fresh: [T0 - DAY, false] }),
			T0,
		);
		expect(Object.keys(pruned.entries).sort()).toEqual(["fresh", "oldHidden"]);
	});

	it("returns the same document when there is nothing to drop", () => {
		const kept = doc({ a: [T0, true] });
		expect(pruneHidden(kept, T0)).toBe(kept);
	});

	it("keeps the newest entries past the cap", () => {
		const entries: Record<string, [number, boolean]> = {};
		for (let i = 0; i < MAX_HIDDEN_ENTRIES + 3; i++) entries[`m${i}`] = [T0 + i, true];
		const pruned = pruneHidden(doc(entries), T0);
		expect(Object.keys(pruned.entries).length).toBe(MAX_HIDDEN_ENTRIES);
		expect(pruned.entries[`m${MAX_HIDDEN_ENTRIES + 2}`]).toBeDefined();
		expect(pruned.entries.m0).toBeUndefined();
	});
});

describe("stored junk", () => {
	it("reads anything that is not a document as empty", () => {
		for (const raw of [null, undefined, 3, "x", [], { entries: null }, { entries: [1, 2] }, { entries: "a" }]) {
			expect(parseHidden(raw)).toEqual({ entries: {} });
		}
	});

	it("drops damaged entries and keeps the good ones", () => {
		const parsed = parseHidden({
			entries: {
				good: { at: 5, hidden: true },
				noTime: { hidden: true },
				badTime: { at: "5", hidden: true },
				negative: { at: -1, hidden: true },
				infinite: { at: Number.POSITIVE_INFINITY, hidden: true },
				badFlag: { at: 5, hidden: "yes" },
				nothing: null,
				list: [1],
				"": { at: 5, hidden: true },
				["x".repeat(300)]: { at: 5, hidden: true },
				extra: { at: 6, hidden: false, other: 1 },
			},
		});
		expect(parsed).toEqual({ entries: { good: { at: 5, hidden: true }, extra: { at: 6, hidden: false } } });
	});

	it("never lets a document plant a prototype key", () => {
		const parsed = parseHidden(
			JSON.parse('{"entries":{"__proto__":{"at":1,"hidden":true},"ok":{"at":1,"hidden":true}}}'),
		);
		expect(Object.keys(parsed.entries)).toEqual(["ok"]);
		expect(({} as Record<string, unknown>).hidden).toBeUndefined();
	});

	it("reads a store of sessions, dropping empty and damaged ones", () => {
		const store = parseStore({
			v: 1,
			sessions: {
				s1: { entries: { a: { at: 1, hidden: true } } },
				empty: { entries: {} },
				junk: 4,
				"": { entries: { a: { at: 1, hidden: true } } },
			},
		});
		expect(Object.keys(store)).toEqual(["s1"]);
		expect(parseStore("nope")).toEqual({});
		expect(parseStore({ sessions: [] })).toEqual({});
	});

	it("keeps the sessions changed most recently past the cap", () => {
		const sessions: Record<string, unknown> = {};
		for (let i = 0; i < MAX_HIDDEN_SESSIONS + 2; i++)
			sessions[`s${i}`] = { entries: { a: { at: i + 1, hidden: true } } };
		const store = parseStore({ sessions });
		expect(Object.keys(store).length).toBe(MAX_HIDDEN_SESSIONS);
		expect(store.s0).toBeUndefined();
		expect(store[`s${MAX_HIDDEN_SESSIONS + 1}`]).toBeDefined();
	});
});

describe("leaving hidden messages out of an export", () => {
	const hiddenSet = (...hidden: string[]): ReadonlySet<string> => new Set(hidden);
	const entryIds = (entries: readonly SessionEntry[]): string[] => entries.map(entry => entry.id);

	it("is the same list when nothing is hidden", () => {
		expect(withoutHidden(session, new Set())).toBe(session);
	});

	it("drops a hidden prompt", () => {
		expect(entryIds(withoutHidden(session, hiddenSet("u2")))).not.toContain("u2");
	});

	it("drops a hidden reply and a hidden call from their message and keeps the rest", () => {
		const out = withoutHidden(session, hiddenSet("a1:0", "c1"));
		// a1 held only that text and that call, so the whole message and its result go.
		expect(entryIds(out)).not.toContain("a1");
		expect(entryIds(out)).not.toContain("r-c1");
		expect(entryIds(out)).toContain("a2");
	});

	it("keeps a message that still has text or a call left", () => {
		const out = withoutHidden(session, hiddenSet("c1"));
		const a1 = out.find(entry => entry.id === "a1");
		expect(a1?.type === "message" && a1.message.role === "assistant" && a1.message.content.map(b => b.type)).toEqual([
			"text",
		]);
		expect(entryIds(out)).not.toContain("r-c1");
	});

	it("leaves entries that are not messages alone", () => {
		const marker: SessionEntry = {
			type: "model_change",
			id: "m1",
			parentId: null,
			timestamp: stamp,
			model: "x",
		} as SessionEntry;
		expect(entryIds(withoutHidden([marker, ...session], hiddenSet("u1")))[0]).toBe("m1");
	});

	it("does not change the entries it was given", () => {
		const before = JSON.stringify(session);
		withoutHidden(session, hiddenSet("a1:0", "c1", "u2"));
		expect(JSON.stringify(session)).toBe(before);
	});
});
