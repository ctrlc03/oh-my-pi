/**
 * Contract: the words the model reads. leafTask and mergeTask have the exact shape of the spec's §4 tasks, with a
 * ruler of 512 dashes; the system prompt names the agent, the kinds, the tools and carries no date or state (it is
 * part of the cached prefix); the user's instructions follow it under their own heading; the "Too long" follow-up
 * names the real size and the cut where the limit falls.
 */
import { describe, expect, it } from "bun:test";
import { AGENT_NAME, NODE_MAX_BYTES } from "../../../src/personal/chat-tree/constants";
import {
	buildChatTreeSystemPrompt,
	CHAT_TREE_SYSTEM_PROMPT,
	leafTask,
	mergeTask,
	RULER,
	tooLongMessage,
	USER_INSTRUCTIONS_HEADING,
} from "../../../src/personal/chat-tree/prompt";
import { firstBytes } from "../../../src/personal/chat-tree/text";
import { CHAT_KINDS } from "../../../src/personal/chat-tree/types";

describe("RULER", () => {
	it("is 512 dashes", () => {
		expect(RULER.length).toBe(512);
		expect(RULER).toBe("-".repeat(512));
		expect(NODE_MAX_BYTES).toBe(512);
	});
});

describe("leafTask", () => {
	it("has the shape of the spec's compression task, the message in whole", () => {
		expect(leafTask(42, "user", "Remember the milk.")).toBe(
			`Compaction: compress message 42 into one line of at most 512 bytes
(about 70 words), the length of this ruler:
${"-".repeat(512)}
<input>
user: Remember the milk.
</input>`,
		);
	});

	it("puts the ruler on its own line and the kind before the text", () => {
		const lines = leafTask(0, "tool", "bash {}").split("\n");
		expect(lines[0]).toBe("Compaction: compress message 0 into one line of at most 512 bytes");
		expect(lines[2]).toBe("-".repeat(512));
		expect(lines.slice(3)).toEqual(["<input>", "tool: bash {}", "</input>"]);
	});

	it("keeps a multi-line message as it is", () => {
		const task = leafTask(1, "echo", "line one\nline two");
		expect(task).toContain("<input>\necho: line one\nline two\n</input>");
	});
});

describe("mergeTask", () => {
	it("has the shape of the spec's merge task, with the names and texts of both lines", () => {
		expect(mergeTask({ name: "8+2", text: "first line" }, { name: "10+2", text: "second line" }, 8, 11)).toBe(
			`Compaction: merge lines 8+2 and 10+2, adjacent, into one line of at most
512 bytes (about 70 words), the length of this ruler:
${"-".repeat(512)}
<chat> may hold their messages, 8 to 11, in more detail: take details
of them from there too.
<input>
first line
second line
</input>`,
		);
	});

	it("carries a ruler of 512 dashes", () => {
		const task = mergeTask({ name: "0+1", text: "a" }, { name: "1+1", text: "b" }, 0, 1);
		expect(task.split("\n")).toContain("-".repeat(512));
		expect(task).not.toContain("-".repeat(513));
	});
});

describe("tooLongMessage", () => {
	it("states the real size and shows the reply cut where the 512-byte limit falls", () => {
		const reply = `${"a".repeat(500)}${"é".repeat(20)}`;
		const message = tooLongMessage(reply, 540);
		expect(message.startsWith("Too long: your line is 540 bytes, over the 512-byte limit.")).toBe(true);
		const cut = firstBytes(reply, 512);
		expect(cut.length).toBeLessThan(reply.length);
		expect(message.endsWith(`${cut}| ← LIMIT`)).toBe(true);
		expect(message).toContain("for the same <input>");
	});
});

describe("CHAT_TREE_SYSTEM_PROMPT", () => {
	it("names the agent", () => {
		expect(AGENT_NAME).toBe("Personal");
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("You are Personal");
		expect(CHAT_TREE_SYSTEM_PROMPT).not.toContain("Unii,");
	});

	it("lists the six kinds", () => {
		for (const kind of CHAT_KINDS) expect(CHAT_TREE_SYSTEM_PROMPT).toContain(`- ${kind}: `);
		expect(CHAT_KINDS.join("|")).toBe("user|unii|tool|echo|work|note");
	});

	it("describes the zoom and date tools", () => {
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("zoom(id, n)");
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("zoom(id, 1)");
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("date(id)");
	});

	it("describes the view lines and the compaction task markers", () => {
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("id+n|text");
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("(not summarized yet: zoom it)");
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain('starting "Compaction:"');
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("# Turns");
		expect(CHAT_TREE_SYSTEM_PROMPT).toContain("# Compactions");
	});

	it("carries no date or other state: it is part of the cached prefix", () => {
		expect(CHAT_TREE_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(CHAT_TREE_SYSTEM_PROMPT).not.toContain("<state>");
		expect(CHAT_TREE_SYSTEM_PROMPT).not.toContain("Workspace:");
	});

	it("does not already hold the user's instructions heading", () => {
		expect(CHAT_TREE_SYSTEM_PROMPT).not.toContain(USER_INSTRUCTIONS_HEADING);
	});
});

describe("buildChatTreeSystemPrompt", () => {
	it("is the system prompt alone without instructions", () => {
		expect(buildChatTreeSystemPrompt([])).toBe(CHAT_TREE_SYSTEM_PROMPT);
		expect(buildChatTreeSystemPrompt(["", "  \n "])).toBe(CHAT_TREE_SYSTEM_PROMPT);
	});

	it("puts the user's instructions heading after the prompt and the given instructions after it", () => {
		const built = buildChatTreeSystemPrompt(["Keep notes in ~/notes.", "Answer briefly."]);
		expect(USER_INSTRUCTIONS_HEADING).toBe("# The user's instructions");
		expect(built.startsWith(CHAT_TREE_SYSTEM_PROMPT)).toBe(true);
		expect(built).toBe(
			`${CHAT_TREE_SYSTEM_PROMPT}\n\n# The user's instructions\n\nKeep notes in ~/notes.\n\nAnswer briefly.`,
		);
		const heading = built.indexOf("# The user's instructions");
		expect(heading).toBe(CHAT_TREE_SYSTEM_PROMPT.length + 2);
		expect(built.indexOf("Keep notes in ~/notes.")).toBeGreaterThan(heading);
		expect(built.indexOf("Answer briefly.")).toBeGreaterThan(built.indexOf("Keep notes in ~/notes."));
	});

	it("trims each instruction and drops the blank ones", () => {
		const built = buildChatTreeSystemPrompt(["  first \n", "", "second"]);
		expect(built.endsWith("# The user's instructions\n\nfirst\n\nsecond")).toBe(true);
	});
});
