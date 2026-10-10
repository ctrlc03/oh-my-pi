import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { trimEntries } from "../src/lib/trim";

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
const guestPrompt = (): SessionEntry =>
	({
		...base,
		id: `e${seq++}`,
		type: "custom_message",
		customType: "collab-prompt",
		content: "hi",
		display: true,
	}) as SessionEntry;
const setup = (): SessionEntry => ({ ...base, id: `e${seq++}`, type: "model_change" }) as unknown as SessionEntry;

describe("trimEntries", () => {
	it("starts at the last N prompts and counts the turns before", () => {
		const entries = [setup(), user(), reply(), user(), reply(), reply(), guestPrompt(), reply()];
		expect(trimEntries(entries, 1)).toEqual({ from: 6, hiddenTurns: 2 });
		expect(trimEntries(entries, 2)).toEqual({ from: 3, hiddenTurns: 1 });
	});

	it("shows everything when the session has no more turns than kept", () => {
		const entries = [setup(), user(), reply(), user(), reply()];
		expect(trimEntries(entries, 2)).toEqual({ from: 0, hiddenTurns: 0 });
		expect(trimEntries(entries, 10)).toEqual({ from: 0, hiddenTurns: 0 });
		expect(trimEntries([reply(), reply()], 1)).toEqual({ from: 0, hiddenTurns: 0 });
	});
});
