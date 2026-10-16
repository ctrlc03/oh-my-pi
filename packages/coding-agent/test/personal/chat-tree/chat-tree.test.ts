/**
 * Contract: ChatTree.open takes the chat's directory and lock; logMessage splits a long text into consecutive
 * messages and clips a tool's output (kind echo) to its head and tail; beginTurn waits until the messages before it
 * are summarized, renders the view, and only then logs the turn's messages; the view is saved in view.json and
 * comes back identical after a restart; status.json holds the six numbers after close; a second open of a chat
 * that is open is refused with ChatLockedError. The compaction transport is a stub; every run uses a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ChatTree, type ChatTreeOptions } from "../../../src/personal/chat-tree/chat-tree";
import { CacheGate, type CompactionCall, type CompactionTransport } from "../../../src/personal/chat-tree/compactor";
import {
	MESSAGE_SPLIT_BYTES,
	NOT_SUMMARIZED_TEXT,
	TOOL_OUTPUT_MAX_CHARS,
} from "../../../src/personal/chat-tree/constants";
import { ChatLockedError } from "../../../src/personal/chat-tree/log";
import { CHAT_STATUS_FILE, readChatStatus } from "../../../src/personal/chat-tree/status";
import { clipToolOutput, utf8Size } from "../../../src/personal/chat-tree/text";
import type { ChatKind } from "../../../src/personal/chat-tree/types";

const LOGGED_AT = "2026-03-01T10:00:00.000Z";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Lets the event loop turn until `ready` holds (bounded by turns, not by time). */
async function until(ready: () => boolean): Promise<void> {
	for (let turns = 0; turns < 2000; turns++) {
		if (ready()) return;
		await tick();
	}
	throw new Error("condition not reached");
}

/** Answers every compaction at once with a fixed line. */
const replying =
	(line: string): CompactionTransport =>
	async (_call, hooks) => {
		hooks.onResponseStart();
		return line;
	};

/** A transport whose calls stay open until the test answers them, oldest first; closing the chat aborts them. */
interface GatedTransport {
	transport: CompactionTransport;
	calls: CompactionCall[];
	answer(line: string): void;
}

function gated(): GatedTransport {
	const calls: CompactionCall[] = [];
	const open: { resolve(line: string): void }[] = [];
	const transport: CompactionTransport = (call, hooks) => {
		calls.push(call);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		open.push({ resolve });
		hooks.signal?.addEventListener("abort", () => reject(new Error("aborted")));
		hooks.onResponseStart();
		return promise;
	};
	return {
		transport,
		calls,
		answer(line) {
			const next = open.shift();
			if (!next) throw new Error("no call is open");
			next.resolve(line);
		},
	};
}

/** Never answers; gives up when the chat closes. */
const silent: CompactionTransport = (_call, hooks) =>
	new Promise((_resolve, reject) => {
		hooks.signal?.addEventListener("abort", () => reject(new Error("aborted")));
	});

let tmp: TempDir;
const opened: ChatTree[] = [];

const chatDir = () => tmp.join("chat");

async function openChat(
	transport: CompactionTransport = replying("summary"),
	extra: Partial<ChatTreeOptions> = {},
): Promise<ChatTree> {
	const chat = await ChatTree.open({
		dir: chatDir(),
		concurrency: 2,
		transport,
		modelKey: "m",
		gate: new CacheGate(),
		now: () => new Date(LOGGED_AT),
		waitForLockMs: 0,
		...extra,
	});
	opened.push(chat);
	return chat;
}

beforeEach(() => {
	tmp = TempDir.createSync("@ct-chat-");
});

afterEach(async () => {
	await Promise.all(opened.splice(0).map(chat => chat.close()));
	await tmp.remove();
});

async function textOf(chat: ChatTree, id: number): Promise<string> {
	const row = await chat.log.readMessage(id);
	if (!row) throw new Error(`message ${id} is missing`);
	return row.text;
}

describe("ChatTree.logMessage", () => {
	it("logs a short text as one message and returns its id", async () => {
		const chat = await openChat();
		expect(await chat.logMessage("user", "hello")).toEqual([0]);
		expect(await chat.logMessage("unii", "hi")).toEqual([1]);
		expect(chat.messageCount).toBe(2);
		expect(await chat.log.readMessage(1)).toMatchObject({ i: 1, kind: "unii", text: "hi", size: 2 });
	});

	it("splits a long text into consecutive messages that join back to the text", async () => {
		const chat = await openChat();
		const text = "word ".repeat(10_000);
		const ids = await chat.logMessage("user", text);
		expect(ids.length).toBeGreaterThan(1);
		expect(ids).toEqual(ids.map((_, k) => k));
		const pieces: string[] = [];
		for (const id of ids) {
			const row = await chat.log.readMessage(id);
			expect(row?.kind).toBe("user");
			expect(row?.size).toBeLessThanOrEqual(MESSAGE_SPLIT_BYTES);
			pieces.push(row?.text ?? "");
		}
		expect(pieces.join("")).toBe(text);
		expect(utf8Size(text)).toBeGreaterThan(MESSAGE_SPLIT_BYTES);
	});

	it("goes on from the last id", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "one");
		const ids = await chat.logMessage("note", "x ".repeat(20_000));
		expect(ids[0]).toBe(1);
		expect(ids.length).toBeGreaterThan(1);
		expect(chat.messageCount).toBe(1 + ids.length);
	});

	it("clips a tool's output (echo) to its head and tail instead of splitting it", async () => {
		const chat = await openChat();
		const output = `HEAD${"x".repeat(40_000)}TAIL`;
		const ids = await chat.logMessage("echo", output);
		expect(ids).toEqual([0]);
		const stored = await textOf(chat, 0);
		expect(stored).toBe(clipToolOutput(output));
		expect(Array.from(stored).length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS);
		expect(stored.startsWith("HEAD")).toBe(true);
		expect(stored.endsWith("TAIL")).toBe(true);
		expect(stored).toMatch(/\[\.\.\. \d+ characters cut \.\.\.\]/);
	});

	it("keeps an echo that fits the clip whole, even over the split size", async () => {
		const chat = await openChat();
		const output = "y".repeat(20_000);
		expect(await chat.logMessage("echo", output)).toEqual([0]);
		expect(await textOf(chat, 0)).toBe(output);
		// The same text of another kind is split.
		expect((await chat.logMessage("tool", output)).length).toBe(2);
	});

	it("keeps the order of loggings made without waiting", async () => {
		const chat = await openChat();
		const ids = await Promise.all([
			chat.logMessage("user", "first"),
			chat.logMessage("unii", "second"),
			chat.logMessage("tool", "third"),
		]);
		expect(ids).toEqual([[0], [1], [2]]);
		expect([await textOf(chat, 0), await textOf(chat, 1), await textOf(chat, 2)]).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("refuses a kind that does not exist", async () => {
		const chat = await openChat();
		expect(() => chat.logMessage("bogus" as ChatKind, "x")).toThrow("Unknown chat kind");
	});

	it("refuses to log once closed", async () => {
		const chat = await openChat();
		await chat.close();
		await expect(chat.logMessage("user", "late")).rejects.toThrow();
	});
});

describe("ChatTree.beginTurn", () => {
	it("waits for the messages before it to be summarized, renders the view, then logs", async () => {
		const model = gated();
		const chat = await openChat(model.transport);
		await chat.logMessage("user", "x".repeat(900));
		await until(() => model.calls.length === 1);

		let resolved = false;
		const turn = chat.beginTurn([{ kind: "user", text: "next question" }]).then(view => {
			resolved = true;
			return view;
		});
		await tick();
		await tick();
		// Still waiting for message 0's line; the new message is not logged yet.
		expect(resolved).toBe(false);
		expect(chat.messageCount).toBe(1);

		model.answer("S0 summary");
		const view = await turn;
		expect(view.blocks.join("") + view.tail).toBe("<chat>\n0+1|S0 summary\n</chat>");
		// The view was rendered before the turn's message was logged: it is not in it.
		expect(view.tail).not.toContain("next question");
		expect(chat.messageCount).toBe(2);
		expect(await textOf(chat, 1)).toBe("next question");
		await chat.tree.idle();
		const after = await chat.renderView();
		expect(after.blocks.join("") + after.tail).toContain("1+1|user: next question");
	});

	it("logs every message of the turn after the view", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "before");
		const view = await chat.beginTurn([
			{ kind: "user", text: "a" },
			{ kind: "echo", text: "b" },
		]);
		expect(view.blocks.join("") + view.tail).toBe("<chat>\n0+1|user: before\n</chat>");
		expect(chat.messageCount).toBe(3);
		expect(await textOf(chat, 1)).toBe("a");
		expect(await textOf(chat, 2)).toBe("b");
	});

	it("goes on with placeholders when the wait runs out", async () => {
		// The wait is a real timer in the code under test: 10 ms is its smallest honest test.
		const chat = await openChat(silent, { turnWaitMs: 10 });
		await chat.logMessage("user", "x".repeat(900));
		const view = await chat.beginTurn([{ kind: "user", text: "go on" }]);
		expect(view.blocks.join("") + view.tail).toBe(`<chat>\n0+1|${NOT_SUMMARIZED_TEXT}\n</chat>`);
		expect(await textOf(chat, 1)).toBe("go on");
	});

	it("stops waiting when the signal aborts and logs nothing of the turn", async () => {
		const chat = await openChat(silent, { turnWaitMs: 60_000 });
		await chat.logMessage("user", "x".repeat(900));
		const abort = new AbortController();
		const outcome = chat.beginTurn([{ kind: "user", text: "go on" }], abort.signal).then(
			() => undefined,
			error => error as Error,
		);
		await tick();
		abort.abort();
		expect(await outcome).toMatchObject({ name: "AbortError" });
		expect(chat.messageCount).toBe(1);
	});

	it("does not start a turn whose signal has aborted already", async () => {
		const chat = await openChat();
		await expect(chat.beginTurn([{ kind: "user", text: "late" }], AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(chat.messageCount).toBe(0);
	});

	it("tries a failed compaction again at the start of the turn", async () => {
		let calls = 0;
		const transport: CompactionTransport = async (_call, hooks) => {
			calls++;
			if (calls === 1) throw new Error("provider down");
			hooks.onResponseStart();
			return "second try";
		};
		const chat = await openChat(transport);
		await chat.logMessage("user", "x".repeat(900));
		await until(() => chat.compactionsFailed === 1);
		const view = await chat.beginTurn([]);
		expect(view.blocks.join("") + view.tail).toBe("<chat>\n0+1|second try\n</chat>");
		expect(chat.compactionsFailed).toBe(0);
		expect(calls).toBe(2);
	});
});

describe("ChatTree failed compactions", () => {
	it("tries a failed node again at the next message", async () => {
		let calls = 0;
		const transport: CompactionTransport = async (_call, hooks) => {
			calls++;
			if (calls === 1) throw new Error("provider down");
			hooks.onResponseStart();
			return "built later";
		};
		const chat = await openChat(transport);
		await chat.logMessage("user", "x".repeat(900));
		await until(() => chat.compactionsFailed === 1);
		expect(chat.log.hasNode(0, 0)).toBe(false);

		await chat.logMessage("user", "tiny");
		await chat.tree.idle();
		expect(calls).toBe(2);
		expect(chat.compactionsFailed).toBe(0);
		expect((await chat.log.readNode(0, 0))?.text).toBe("built later");
		expect((await chat.log.readNode(0, 1))?.text).toBe("user: tiny");
	});
});

describe("ChatTree persistence", () => {
	it("saves the view in view.json and reloads it identically after a restart", async () => {
		const chat = await openChat();
		for (let i = 0; i < 6; i++) await chat.logMessage(i % 2 === 0 ? "user" : "unii", `message number ${i}`);
		await chat.tree.idle();
		const rendered = await chat.renderView();
		const bytes = chat.viewBytes;
		await chat.close();

		const saved = JSON.parse(await Bun.file(`${chatDir()}/view.json`).text());
		expect(saved).toEqual([
			[0, 0],
			[0, 1],
			[0, 2],
			[0, 3],
			[0, 4],
			[0, 5],
		]);

		const again = await openChat();
		expect(again.messageCount).toBe(6);
		expect(again.viewBytes).toBe(bytes);
		expect(await again.renderView()).toEqual(rendered);
		// The chat goes on from where it was.
		expect(await again.logMessage("user", "after the restart")).toEqual([6]);
	});

	it("reloads a view that has merged lines identically", async () => {
		const chat = await openChat();
		// Short lines of ~410 bytes: the view passes its 128,000-byte mark, and merges of pairs need a model call.
		for (let i = 0; i < 320; i++) await chat.logMessage("user", `${String(i).padStart(4, "0")}${"p".repeat(396)}`);
		await chat.tree.idle();
		await chat.logMessage("user", "one more to settle the view");
		await chat.tree.idle();
		const rendered = await chat.renderView();
		const bytes = chat.viewBytes;
		await chat.close();

		const saved = JSON.parse(await Bun.file(`${chatDir()}/view.json`).text()) as [number, number][];
		expect(saved.some(([l]) => l >= 1)).toBe(true);

		const again = await openChat();
		expect(again.viewBytes).toBe(bytes);
		expect(await again.renderView()).toEqual(rendered);
		await again.close();
		expect(JSON.parse(await Bun.file(`${chatDir()}/view.json`).text())).toEqual(saved);
	});

	it("appends the messages logged after the saved view, and rebuilds no node", async () => {
		const chat = await openChat();
		for (let i = 0; i < 4; i++) await chat.logMessage("user", `m${i}`);
		await chat.tree.idle();
		const rendered = await chat.renderView();
		const nodes = chat.log.nodeCount;
		await chat.close();

		// A view saved when only two messages existed.
		await Bun.write(`${chatDir()}/view.json`, "[[0,0],[0,1]]");
		const again = await openChat();
		expect(await again.renderView()).toEqual(rendered);
		expect(again.log.nodeCount).toBe(nodes);
	});

	it("makes the view from the log when view.json cannot be read", async () => {
		const chat = await openChat();
		for (let i = 0; i < 3; i++) await chat.logMessage("user", `m${i}`);
		await chat.tree.idle();
		const rendered = await chat.renderView();
		await chat.close();

		await Bun.write(`${chatDir()}/view.json`, "{ this is not json");
		const again = await openChat();
		expect(await again.renderView()).toEqual(rendered);
		await again.close();
		expect(JSON.parse(await Bun.file(`${chatDir()}/view.json`).text())).toEqual([
			[0, 0],
			[0, 1],
			[0, 2],
		]);
	});

	it("builds again, after a restart, only the nodes that were missing", async () => {
		const first = await openChat(silent);
		await first.logMessage("user", "x".repeat(900));
		await first.logMessage("user", "short");
		await first.close();

		const calls: string[] = [];
		const second = await openChat(async (call, hooks) => {
			calls.push(call.turns[0] as string);
			hooks.onResponseStart();
			return "rebuilt";
		});
		await second.tree.idle();
		// Message 0 needs its call; the short message's node and the pair of two short lines need none.
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("compress message 0");
		expect((await second.log.readNode(0, 0))?.text).toBe("rebuilt");
		expect((await second.log.readNode(0, 1))?.text).toBe("user: short");
		expect((await second.log.readNode(1, 0))?.text).toBe("rebuilt\nuser: short");
	});
});

describe("ChatTree status.json", () => {
	const KEYS = ["compactionsFailed", "messages", "nodesBuilt", "nodesPending", "updatedAt", "viewBytes"];

	it("holds the six numbers of a fully built chat after close", async () => {
		const chat = await openChat();
		for (const word of ["a", "b", "c"]) await chat.logMessage("user", word);
		await chat.tree.idle();
		await chat.close();
		const status = JSON.parse(await Bun.file(`${chatDir()}/${CHAT_STATUS_FILE}`).text());
		expect(Object.keys(status).sort()).toEqual(KEYS);
		// Nodes: 3 messages + the pair (1, 0). Three view lines of `0+1|user: a\n` = 12 bytes.
		expect(status).toEqual({
			messages: 3,
			nodesBuilt: 4,
			nodesPending: 0,
			viewBytes: 36,
			compactionsFailed: 0,
			updatedAt: LOGGED_AT,
		});
		expect(await readChatStatus(chatDir())).toEqual(status);
	});

	it("counts the nodes still to build", async () => {
		const chat = await openChat(silent);
		await chat.logMessage("user", "x".repeat(900));
		await chat.logMessage("user", "y".repeat(900));
		const viewBytes = chat.viewBytes;
		await chat.close();
		const status = await readChatStatus(chatDir());
		expect(status).toEqual({
			messages: 2,
			nodesBuilt: 0,
			nodesPending: 3,
			viewBytes,
			compactionsFailed: 0,
			updatedAt: LOGGED_AT,
		});
		expect(viewBytes).toBeGreaterThan(0);
	});

	it("counts the nodes whose compaction failed", async () => {
		const transport: CompactionTransport = async () => {
			throw new Error("provider down");
		};
		const chat = await openChat(transport);
		await chat.logMessage("user", "x".repeat(900));
		await until(() => chat.compactionsFailed === 1);
		await chat.close();
		const status = await readChatStatus(chatDir());
		expect(status?.compactionsFailed).toBe(1);
		expect(status?.nodesBuilt).toBe(0);
		expect(status?.nodesPending).toBe(1);
		expect(status?.messages).toBe(1);
	});
});

describe("ChatTree lock", () => {
	it("refuses a second open of a chat that is open", async () => {
		const chat = await openChat();
		await expect(openChat(replying("s"), { waitForLockMs: 5 })).rejects.toBeInstanceOf(ChatLockedError);
		// The refused open took nothing from the first.
		expect(await chat.logMessage("user", "still mine")).toEqual([0]);
	});

	it("lets the chat be opened again once it is closed", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "kept");
		await chat.close();
		const again = await openChat();
		expect(again.messageCount).toBe(1);
		expect(await textOf(again, 0)).toBe("kept");
	});
});
