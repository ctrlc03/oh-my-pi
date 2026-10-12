import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { latestClear } from "../src/lib/context-clear";
import { buildChatItems } from "../src/components/transcript/chat-items";
import { sessionMarkdown } from "../src/lib/export";

let seq = 0;
const base = { parentId: null, timestamp: "2026-10-10T00:00:00.000Z" };
const user = (): SessionEntry =>
	({
		...base,
		id: `e${seq++}`,
		type: "message",
		message: { role: "user", content: "hi", timestamp: 0 },
	}) as SessionEntry;
const reply = (): SessionEntry =>
	({
		...base,
		id: `e${seq++}`,
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 },
	}) as SessionEntry;
const toolResult = (): SessionEntry =>
	({
		...base,
		id: `e${seq++}`,
		type: "message",
		message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError: false, timestamp: 0 },
	}) as SessionEntry;
const guestPrompt = (): SessionEntry =>
	({
		...base,
		id: `e${seq++}`,
		type: "custom_message",
		customType: "collab-prompt",
		content: "hi",
		display: true,
	}) as SessionEntry;
const marker = (): SessionEntry => ({ ...base, id: `e${seq++}`, type: "model_change", model: "x" }) as SessionEntry;
const boundary = (): SessionEntry => ({ ...base, id: `e${seq++}`, type: "reset_boundary" });

describe("latestClear", () => {
	it("folds everything before the latest boundary and counts its prompts and replies", () => {
		const entries = [marker(), user(), reply(), toolResult(), guestPrompt(), reply(), boundary(), user(), reply()];
		const found = latestClear(entries);
		expect(found).toEqual({ from: 6, boundaryId: entries[6]!.id, hiddenMessages: 4 });
	});

	it("uses the newest boundary when the session was cleared more than once", () => {
		const entries = [user(), reply(), boundary(), user(), boundary(), user()];
		expect(latestClear(entries)).toEqual({ from: 4, boundaryId: entries[4]!.id, hiddenMessages: 3 });
	});

	it("folds nothing when there is no boundary, or nothing readable before it", () => {
		expect(latestClear([user(), reply()])).toBeNull();
		expect(latestClear([marker(), boundary(), user()])).toBeNull();
		expect(latestClear([boundary(), user()])).toBeNull();
		expect(latestClear([])).toBeNull();
	});

	it("finds no boundary once a rewind cut the replica back before it", () => {
		const entries = [user(), reply(), boundary(), user()];
		expect(latestClear(entries.slice(0, 2))).toBeNull();
	});
});

describe("a /clear boundary in the other views", () => {
	it("stays an item of the chat view, between the turns it separates", () => {
		const entries = [user(), reply(), boundary(), user()];
		const items = buildChatItems(entries, null, true, []);
		expect(items.map(item => item.kind)).toEqual(["entry", "text", "entry", "entry"]);
		expect(items[2]).toMatchObject({ kind: "entry", entry: { type: "reset_boundary" } });
	});

	it("is marked in the Markdown export", () => {
		const entries = [user(), reply(), boundary(), user()];
		expect(sessionMarkdown(entries, { title: "t" })).toContain("> Context cleared");
	});
});
