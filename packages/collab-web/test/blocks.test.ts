import { describe, expect, it } from "bun:test";
import type { SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import {
	type Block,
	blockCommand,
	blockHasText,
	blockOutput,
	blocksMarkdown,
	blocksQuote,
	buildBlocks,
	buildChatBlocks,
	EXCERPT_OUTPUT_LINES,
	extendTo,
	moveSelection,
	NO_SELECTION,
	pruneSelection,
	selectedBlocks,
	selectOnly,
	toggleBlock,
	toolMarkdown,
	toolMeta,
	toolOutput,
	toolResults,
	toolStatus,
} from "../src/lib/blocks";

const stamp = "2026-10-10T08:30:00.000Z";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };

const prompt = (id: string, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: stamp,
	message: { role: "user", content: text, timestamp: 0 },
});

function reply(
	id: string,
	...parts: ({ text: string } | { call: string; name: string; args: unknown })[]
): SessionEntry {
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
					: {
							type: "toolCall" as const,
							id: part.call,
							name: part.name,
							arguments: part.args as Record<string, unknown>,
						},
			),
			model: "m",
			usage,
			stopReason: "stop",
			timestamp: 0,
		},
	};
}

function result(call: string, text: string, extra: Partial<ToolResultMessage> = {}): SessionEntry {
	return {
		type: "message",
		id: `r-${call}`,
		parentId: null,
		timestamp: stamp,
		message: {
			role: "toolResult",
			toolCallId: call,
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 0,
			...extra,
		},
	};
}

const ESC = "\u001b";

const entries: SessionEntry[] = [
	prompt("u1", "run the tests"),
	reply("a1", { text: "Running them." }, { call: "c1", name: "bash", args: { command: "bun test", i: "intent" } }),
	result("c1", `${ESC}[32mpass${ESC}[0m\n3 tests`, { details: { exitCode: 0, wallTimeMs: 1500 } }),
	reply("a2", { call: "c2", name: "read", args: { path: "src/a.ts", offset: 3 } }),
	result("c2", "file text"),
	prompt("u2", "thanks"),
];

function blocksOf(list: readonly SessionEntry[]): Block[] {
	return buildBlocks(list, toolResults(list));
}

describe("block model", () => {
	it("lists prompts, reply text and tool calls in transcript order", () => {
		expect(blocksOf(entries).map(block => block.kind)).toEqual(["prompt", "reply", "tool", "tool", "prompt"]);
	});

	it("gives every block a distinct id", () => {
		const ids = blocksOf(entries).map(block => block.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("skips empty reply text", () => {
		expect(blocksOf([reply("a", { text: "  \n" })])).toEqual([]);
	});

	it("folds chat-view tool runs into one block that keeps every call", () => {
		const items = [
			{ kind: "entry" as const, entry: entries[0]! },
			{ kind: "text" as const, key: "a1:0", entryId: "a1", text: "Running them." },
			{
				kind: "tools" as const,
				key: "tools:c1",
				entryId: "a1",
				calls: [
					{ id: "c1", name: "bash", args: { command: "bun test" } },
					{ id: "c2", name: "read", args: { path: "src/a.ts" } },
				],
			},
			// Not in the session yet: nothing to select or copy.
			{ kind: "text" as const, key: "stream:0", entryId: null, text: "typing" },
		];
		const blocks = buildChatBlocks(items, toolResults(entries));
		expect(blocks.map(block => block.kind)).toEqual(["prompt", "reply", "run"]);
		const run = blocks[2]!;
		expect(run.kind === "run" && run.tools.map(tool => tool.id)).toEqual(["c1", "c2"]);
	});

	it("uses the same ids for a reply in both views", () => {
		const items = [{ kind: "text" as const, key: "a1:0", entryId: "a1", text: "Running them." }];
		expect(buildChatBlocks(items, new Map())[0]!.id).toBe(blocksOf(entries)[1]!.id);
	});
});

describe("tool serialisation", () => {
	const tool = blocksOf(entries)[2]!;
	if (tool.kind !== "tool") throw new Error("fixture");

	it("copies the shell command without the intent field", () => {
		expect(blockCommand(tool)).toBe("bun test");
	});

	it("names a non-shell call by tool and main argument", () => {
		const read = blocksOf(entries)[3]!;
		expect(blockCommand(read)).toBe("read src/a.ts");
	});

	it("strips ANSI from copied output", () => {
		expect(blockOutput(tool)).toBe("pass\n3 tests");
		expect(blockOutput(tool)).not.toContain(ESC);
	});

	it("writes both as a sh fence for the command and a fence for the output", () => {
		expect(toolMarkdown(tool)).toBe("```sh\nbun test\n```\n\n```\npass\n3 tests\n```");
	});

	it("widens a fence past any backticks in the content", () => {
		const list = [
			reply("a", { call: "c", name: "bash", args: { command: "echo '```'" } }),
			result("c", "```\nhi\n```"),
		];
		const md = toolMarkdown(blocksOf(list)[0] as Extract<Block, { kind: "tool" }>);
		expect(md.startsWith("````sh\n")).toBe(true);
		expect(md).toContain("````\n```\nhi\n```\n````");
	});

	it("reads status, exit code and wall time from the result", () => {
		expect(toolStatus(tool)).toBe("ok");
		expect(toolMeta(tool.name, tool.args, tool.result)).toMatchObject({
			exitCode: 0,
			durationMs: 1500,
			failed: false,
		});
	});

	it("marks a non-zero exit as failed and says so in the copy", () => {
		const list = [
			reply("a", { call: "c", name: "bash", args: { command: "false" } }),
			result("c", "", { details: { exitCode: 2 } }),
		];
		const failing = blocksOf(list)[0] as Extract<Block, { kind: "tool" }>;
		expect(toolStatus(failing)).toBe("err");
		expect(toolOutput(failing)).toContain("2");
	});

	it("states truncated output instead of cutting it silently", () => {
		const list = [
			reply("a", { call: "c", name: "bash", args: { command: "yes" } }),
			result("c", "y\ny", { details: { meta: { truncation: { outputLines: 2, totalLines: 900 } } } }),
		];
		const out = toolOutput(blocksOf(list)[0] as Extract<Block, { kind: "tool" }>);
		expect(out.startsWith("y\ny")).toBe(true);
		expect(out).toContain("2");
		expect(out).toContain("900");
	});

	it("states a call that has no result yet", () => {
		const list = [reply("a", { call: "c", name: "bash", args: { command: "sleep 9" } })];
		const pending = blocksOf(list)[0] as Extract<Block, { kind: "tool" }>;
		expect(toolStatus(pending)).toBe("pending");
		expect(toolOutput({ ...pending, running: true, partial: `${ESC}[1mso far` })).toContain("so far");
		expect(toolOutput({ ...pending, running: true, partial: `${ESC}[1mso far` })).not.toContain(ESC);
		expect(toolOutput(pending)).not.toBe("");
	});

	it("says when images in the result were not copied", () => {
		const list = [
			reply("a", { call: "c", name: "read", args: { path: "x.png" } }),
			result("c", "", { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }),
		];
		expect(toolOutput(blocksOf(list)[0] as Extract<Block, { kind: "tool" }>)).toContain("image");
	});

	it("keeps only the last lines of a long output in a quoted excerpt, and says how many went", () => {
		const long = Array.from({ length: EXCERPT_OUTPUT_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
		const list = [reply("a", { call: "c", name: "bash", args: { command: "seq" } }), result("c", long)];
		const quoted = blocksQuote(blocksOf(list));
		expect(quoted.split("\n").every(line => line === ">" || line.startsWith("> "))).toBe(true);
		expect(quoted).toContain(`line ${EXCERPT_OUTPUT_LINES + 9}`);
		expect(quoted).not.toContain("line 0\n");
		expect(quoted).toContain("10");
	});
});

describe("multi-block copy", () => {
	it("copies in transcript order whatever order the blocks were picked in", () => {
		const blocks = blocksOf(entries);
		const picked = toggleBlock(toggleBlock(NO_SELECTION, blocks[4]!.id), blocks[0]!.id);
		const text = blocksMarkdown(selectedBlocks(picked, blocks));
		expect(text.indexOf("run the tests")).toBeLessThan(text.indexOf("thanks"));
	});

	it("names prompt authors only when several blocks go together", () => {
		const blocks = blocksOf(entries);
		expect(blocksMarkdown([blocks[0]!])).toBe("run the tests");
		expect(blocksMarkdown([blocks[0]!, blocks[1]!])).toContain("**host:**");
	});

	it("copies a folded run as every call's command and output", () => {
		const run: Block = {
			kind: "run",
			id: "tools:c1",
			entryId: "a1",
			tools: blocksOf(entries).filter(block => block.kind === "tool"),
		};
		expect(blockCommand(run)).toBe("bun test\nread src/a.ts");
		expect(blockOutput(run)).toContain("file text");
	});
});

describe("Read in full", () => {
	it("is offered for every block that has text to copy", () => {
		const folded: Block = {
			kind: "run",
			id: "tools:c1",
			entryId: "a1",
			tools: blocksOf(entries).filter(block => block.kind === "tool"),
		};
		expect([...blocksOf(entries), folded].map(blockHasText)).toEqual([true, true, true, true, true, true]);
	});

	it("is not offered where copying gives nothing", () => {
		expect(blocksOf([prompt("u", "  ")]).map(blockHasText)).toEqual([false]);
	});
});

describe("selection", () => {
	const order = blocksOf(entries);
	const ids = order.map(block => block.id);

	it("extends a range from the anchor in either direction", () => {
		const down = extendTo(selectOnly(ids[1]!), order, ids[3]!);
		expect([...down.ids]).toEqual([ids[1], ids[2], ids[3]]);
		const up = extendTo(selectOnly(ids[3]!), order, ids[1]!);
		expect([...up.ids].sort()).toEqual([ids[1], ids[2], ids[3]].sort());
		expect(up.anchor).toBe(ids[3]);
	});

	it("shrinks the range when it is extended back toward the anchor", () => {
		const grown = extendTo(selectOnly(ids[1]!), order, ids[3]!);
		expect(extendTo(grown, order, ids[2]!).ids.size).toBe(2);
	});

	it("extends from the clicked block when there is no anchor", () => {
		expect([...extendTo(NO_SELECTION, order, ids[2]!).ids]).toEqual([ids[2]]);
	});

	it("ignores extending to a block that is not there", () => {
		const one = selectOnly(ids[0]!);
		expect(extendTo(one, order, "gone")).toBe(one);
	});

	it("moves one block and stops at the ends", () => {
		expect(moveSelection(selectOnly(ids[1]!), order, 1, false).focus).toBe(ids[2]);
		expect(moveSelection(selectOnly(ids[0]!), order, -1, false).focus).toBe(ids[0]);
		expect(moveSelection(selectOnly(ids[4]!), order, 1, false).focus).toBe(ids[4]);
	});

	it("starts from the last block going up and from the one in view going down", () => {
		expect(moveSelection(NO_SELECTION, order, -1, false).focus).toBe(ids[4]);
		expect(moveSelection(NO_SELECTION, order, 1, false, ids[2]).focus).toBe(ids[2]);
		expect(moveSelection(NO_SELECTION, order, 1, false).focus).toBe(ids[0]);
	});

	it("moves the focus while extending, keeping the anchor", () => {
		const first = moveSelection(selectOnly(ids[1]!), order, 1, true);
		const second = moveSelection(first, order, 1, true);
		expect(second.anchor).toBe(ids[1]);
		expect(second.focus).toBe(ids[3]);
		expect([...second.ids]).toEqual([ids[1], ids[2], ids[3]]);
	});

	it("drops blocks that left the transcript and leaves a clean selection alone", () => {
		const picked = extendTo(selectOnly(ids[0]!), order, ids[2]!);
		expect(pruneSelection(picked, order)).toBe(picked);
		const pruned = pruneSelection(picked, order.slice(1));
		expect(pruned.ids.has(ids[0]!)).toBe(false);
		expect(pruned.anchor).toBeNull();
		expect(pruneSelection(selectOnly(ids[0]!), order.slice(1))).toBe(NO_SELECTION);
	});

	it("toggles a block in and out", () => {
		const on = toggleBlock(NO_SELECTION, ids[0]!);
		expect(on.ids.has(ids[0]!)).toBe(true);
		expect(toggleBlock(on, ids[0]!).ids.size).toBe(0);
	});
});
