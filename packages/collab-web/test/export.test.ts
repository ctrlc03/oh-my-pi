import { describe, expect, it } from "bun:test";
import type { AssistantContent, SessionEntry } from "@oh-my-pi/pi-wire";
import { exportFilename, replyText, sessionMarkdown, turnMarkdown, turnRanges } from "../src/lib/export";

let seq = 0;
const base = () => ({ id: `e${seq++}`, parentId: null, timestamp: "2026-10-10T08:30:00.000Z" });
const user = (content: string | { type: string; [k: string]: unknown }[]): SessionEntry =>
	({ ...base(), type: "message", message: { role: "user", content, timestamp: 0 } }) as SessionEntry;
const guest = (content: string, from?: string): SessionEntry =>
	({
		...base(),
		type: "custom_message",
		customType: "collab-prompt",
		content,
		display: true,
		details: from === undefined ? undefined : { from },
	}) as SessionEntry;
const reply = (...content: AssistantContent[]): SessionEntry =>
	({ ...base(), type: "message", message: { role: "assistant", content, timestamp: 0 } }) as SessionEntry;
const text = (value: string): AssistantContent => ({ type: "text", text: value });
const call = (name: string, args: Record<string, unknown>, intent?: string): AssistantContent => ({
	type: "toolCall",
	id: `c${seq++}`,
	name,
	arguments: args,
	intent,
});

describe("turn boundaries", () => {
	it("opens a turn at a user message or a guest prompt and runs to the next one", () => {
		const entries = [
			reply(text("setup")),
			user("one"),
			reply(text("a")),
			guest("two", "mia"),
			reply(text("b")),
			reply(text("c")),
			user("three"),
		];
		expect(turnRanges(entries)).toEqual([
			{ from: 1, to: 3 },
			{ from: 3, to: 6 },
			{ from: 6, to: 7 },
		]);
	});

	it("labels prompts with the transcript's gutter names", () => {
		const md = turnMarkdown([user("fix it"), reply(text("done")), guest("and test it", "mia"), guest("me too")]);
		expect(md).toBe("**host:**\n\nfix it\n\ndone\n\n**mia:**\n\nand test it\n\n**guest:**\n\nme too");
	});
});

describe("turnMarkdown", () => {
	it("renders each tool call as one compact line, preferring the intent, and drops thinking", () => {
		const md = turnMarkdown([
			user("go"),
			reply(
				{ type: "thinking", thinking: "secret reasoning" },
				text("Looking."),
				call("read", { path: "src/a.ts" }, "Reading a"),
				call("bash", { command: "ls -la" }),
				{ type: "redactedThinking", data: "x" },
			),
		]);
		expect(md).toBe('**host:**\n\ngo\n\nLooking.\n\n- ⚙ read · Reading a\n- ⚙ bash · {"command":"ls -la"}');
		expect(md).not.toContain("secret reasoning");
	});

	it("notes images and quotes compaction and branch summaries", () => {
		const entries = [
			user([
				{ type: "text", text: "see this" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
			]),
			{
				...base(),
				type: "compaction",
				summary: "long",
				shortSummary: "short\nsecond",
				firstKeptEntryId: "x",
				tokensBefore: 9,
			},
			{ ...base(), type: "branch_summary", fromId: "x", summary: "went elsewhere" },
		] as SessionEntry[];
		expect(turnMarkdown(entries)).toBe(
			"**host:**\n\nsee this\n\n[image]\n\n> Context compacted\n>\n> short\n> second\n\n> Branch summary\n>\n> went elsewhere",
		);
	});
});

describe("replyText", () => {
	it("joins the assistant's text blocks across messages, skipping prompts, tools and thinking", () => {
		const turn = [
			user("go"),
			reply({ type: "thinking", thinking: "hmm" }, text(" First. "), call("bash", { command: "x" })),
			reply(text("Second."), text("  ")),
		];
		expect(replyText(turn)).toBe("First.\n\nSecond.");
	});

	it("is empty for a turn the agent only ran tools in", () => {
		expect(replyText([user("go"), reply(call("bash", { command: "x" }))])).toBe("");
	});
});

describe("sessionMarkdown", () => {
	it("starts with the title and start date and separates turns with a rule", () => {
		const md = sessionMarkdown([user("one"), reply(text("a")), user("two"), reply(text("b"))], {
			title: "Fix  the bug",
		});
		expect(md).toBe("# Fix the bug\n\n*2026-10-10*\n\n**host:**\n\none\n\na\n\n---\n\n**host:**\n\ntwo\n\nb\n");
	});
});

describe("exportFilename", () => {
	it("slugs the title and falls back when nothing usable remains", () => {
		expect(exportFilename("Fix: the Bug / now! Ünïcode")).toBe("fix-the-bug-now-unicode.md");
		expect(exportFilename("日本語")).toBe("session.md");
	});
});
