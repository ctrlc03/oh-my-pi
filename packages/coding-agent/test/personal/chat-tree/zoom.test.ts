/**
 * Contract: zoom(id, n) opens line `id+n` into the two lines it was made from, as the view shows them (a placeholder
 * for a node not built yet); zoom(id, 1) gives message `id` whole, in pages of 12,000 characters for a longer one;
 * a bad n (not a power of 2), an id that is not a multiple of n, or an id outside the chat is a ZoomError; dateOf
 * gives the message's logged date in ISO form.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { CacheGate, type CompactionTransport } from "../../../src/personal/chat-tree/compactor";
import { ChatTree } from "../../../src/personal/chat-tree/chat-tree";
import { NOT_SUMMARIZED_TEXT, ZOOM_PAGE_CHARS } from "../../../src/personal/chat-tree/constants";
import { dateOf, formatLocal, ZoomError, zoom } from "../../../src/personal/chat-tree/zoom";

const LOGGED_AT = "2026-03-01T10:00:00.000Z";

/** Answers every compaction at once with a fixed line. */
const replying =
	(line: string): CompactionTransport =>
	async (_call, hooks) => {
		hooks.onResponseStart();
		return line;
	};

/** Never answers a compaction; gives up when the chat closes. */
const silent: CompactionTransport = (_call, hooks) =>
	new Promise((_resolve, reject) => {
		hooks.signal?.addEventListener("abort", () => reject(new Error("aborted")));
	});

let tmp: TempDir;
const open: ChatTree[] = [];

async function openChat(transport: CompactionTransport = replying("summary")): Promise<ChatTree> {
	const chat = await ChatTree.open({
		dir: tmp.join("chat"),
		concurrency: 2,
		transport,
		modelKey: "m",
		gate: new CacheGate(),
		now: () => new Date(LOGGED_AT),
		waitForLockMs: 0,
	});
	open.push(chat);
	return chat;
}

beforeEach(() => {
	tmp = TempDir.createSync("@ct-zoom-");
});

afterEach(async () => {
	await Promise.all(open.splice(0).map(chat => chat.close()));
	await tmp.remove();
});

describe("zoom(id, n)", () => {
	it("returns the two child lines of a node, as the view shows them", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "alpha");
		await chat.logMessage("unii", "beta");
		await chat.tree.idle();
		expect(await zoom(chat, 0, 2)).toBe("0+1|user: alpha\n1+1|unii: beta");
	});

	it("opens a higher node into its two halves, newlines shown as spaces", async () => {
		const chat = await openChat();
		for (const word of ["a", "b", "c", "d"]) await chat.logMessage("user", word);
		await chat.tree.idle();
		// node (1, 0) is "user: a\nuser: b": one line in the view, the newline as a space.
		expect(await zoom(chat, 0, 4)).toBe("0+2|user: a user: b\n2+2|user: c user: d");
		expect(await zoom(chat, 2, 2)).toBe("2+1|user: c\n3+1|user: d");
	});

	it("shows the placeholder for a child that is not built yet", async () => {
		const chat = await openChat(silent);
		await chat.logMessage("user", "short one");
		await chat.logMessage("user", "x".repeat(900));
		expect(await zoom(chat, 0, 2)).toBe(`0+1|user: short one\n1+1|${NOT_SUMMARIZED_TEXT}`);
	});

	it("says so for a child that covers messages the chat does not have yet", async () => {
		const chat = await openChat();
		for (const word of ["a", "b", "c"]) await chat.logMessage("user", word);
		await chat.tree.idle();
		expect(await zoom(chat, 0, 8)).toBe(`0+4|${NOT_SUMMARIZED_TEXT}\n4+4|(no messages there yet: the chat has 3)`);
	});

	it("answers the same twice", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "a");
		await chat.logMessage("user", "b");
		await chat.tree.idle();
		expect(await zoom(chat, 0, 2)).toBe(await zoom(chat, 0, 2));
	});
});

describe("zoom errors", () => {
	async function chatOf(count: number): Promise<ChatTree> {
		const chat = await openChat();
		for (let i = 0; i < count; i++) await chat.logMessage("user", `m${i}`);
		await chat.tree.idle();
		return chat;
	}

	it("rejects an n that is not a power of 2", async () => {
		const chat = await chatOf(4);
		// 6442450944 is 3 * 2^31: its low 32 bits are 0, so a bitwise test passes it. 2^53 - 1 rounds to 2^53 in log2.
		const wide = [6_442_450_944, 2 ** 53 - 1, 2 ** 53, Number.POSITIVE_INFINITY, "4" as unknown as number];
		for (const n of [0, 3, 6, 12, -2, 1.5, Number.NaN, ...wide]) {
			const error = await zoom(chat, 0, n).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ZoomError);
			expect((error as ZoomError).message).toContain("power of 2");
		}
	});

	it("takes a power of 2 wider than 32 bits", async () => {
		const chat = await chatOf(4);
		const out = await zoom(chat, 0, 2 ** 32);
		expect(out.split("\n")[1]).toBe(`2147483648+2147483648|(no messages there yet: the chat has 4)`);
	});

	it("rejects a page that is not a number, and cuts a fractional one to a whole page", async () => {
		const chat = await openChat();
		await chat.logMessage("user", `${"a".repeat(ZOOM_PAGE_CHARS)}tail`);
		for (const page of [Number.NaN, "2" as unknown as number]) {
			const error = await zoom(chat, 0, 1, page).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ZoomError);
			expect((error as ZoomError).message).toContain("page must be a number");
		}
		expect(await zoom(chat, 0, 1, 2.9)).toBe(await zoom(chat, 0, 1, 2));
		expect(await zoom(chat, 0, 1, 1.5)).toBe(await zoom(chat, 0, 1, 1));
		expect(await zoom(chat, 0, 1, Number.POSITIVE_INFINITY)).toBe(await zoom(chat, 0, 1, 2));
	});

	it("rejects an id that is not a multiple of n", async () => {
		const chat = await chatOf(8);
		const error = await zoom(chat, 3, 2).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ZoomError);
		expect((error as ZoomError).message).toContain("multiple of n");
		await expect(zoom(chat, 2, 4)).rejects.toBeInstanceOf(ZoomError);
		// Message ids are multiples of 1: n = 1 takes any id.
		await expect(zoom(chat, 3, 1)).resolves.toContain("message 3");
	});

	it("rejects an id outside the chat", async () => {
		const chat = await chatOf(3);
		for (const id of [3, 10]) {
			const error = await zoom(chat, id, 1).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ZoomError);
			expect((error as ZoomError).message).toContain(`There is no message ${id}`);
		}
		await expect(zoom(chat, 4, 2)).rejects.toBeInstanceOf(ZoomError);
	});

	it("rejects an id that is negative or not a whole number", async () => {
		const chat = await chatOf(3);
		for (const id of [-1, 0.5, Number.NaN]) await expect(zoom(chat, id, 1)).rejects.toBeInstanceOf(ZoomError);
		await expect(zoom(chat, "0" as unknown as number, 1)).rejects.toBeInstanceOf(ZoomError);
	});

	it("rejects any id in an empty chat", async () => {
		const chat = await openChat();
		await expect(zoom(chat, 0, 1)).rejects.toBeInstanceOf(ZoomError);
		expect(() => dateOf(chat, 0)).toThrow(ZoomError);
	});
});

describe("zoom(id, 1)", () => {
	it("gives the message whole, under a header of its id, kind and size", async () => {
		const chat = await openChat();
		await chat.logMessage("tool", 'bash {"cmd":"ls"}');
		await chat.logMessage("echo", "line 1\nline 2");
		expect(await zoom(chat, 0, 1)).toBe('message 0, tool, 17 bytes\nbash {"cmd":"ls"}');
		expect(await zoom(chat, 1, 1)).toBe("message 1, echo, 13 bytes\nline 1\nline 2");
	});

	it("gives a message of 12,000 characters or fewer on one page, with no page note", async () => {
		const chat = await openChat();
		// 8,000 characters of 2 bytes: 16,000 bytes, under the split size, and under the page size in characters.
		const text = "é".repeat(8000);
		await chat.logMessage("user", text);
		const out = await zoom(chat, 0, 1);
		expect(out.split("\n")[0]).toBe("message 0, user, 16000 bytes");
		expect(out.slice(out.indexOf("\n") + 1)).toBe(text);
	});

	it("pages a message of more than 12,000 characters", async () => {
		const chat = await openChat();
		const text = `${"a".repeat(ZOOM_PAGE_CHARS)}${"b".repeat(3000)}`;
		await chat.logMessage("user", text);
		const first = await zoom(chat, 0, 1);
		expect(first.split("\n")[0]).toBe("message 0, user, 15000 bytes, page 1 of 2. Next: zoom(0, 1, page=2).");
		expect(first.slice(first.indexOf("\n") + 1)).toBe("a".repeat(ZOOM_PAGE_CHARS));
		const second = await zoom(chat, 0, 1, 2);
		expect(second.split("\n")[0]).toBe("message 0, user, 15000 bytes, page 2 of 2.");
		expect(second.slice(second.indexOf("\n") + 1)).toBe("b".repeat(3000));
	});

	it("clamps a page number to the pages that exist", async () => {
		const chat = await openChat();
		await chat.logMessage("user", `${"a".repeat(ZOOM_PAGE_CHARS)}tail`);
		expect(await zoom(chat, 0, 1, 99)).toBe(await zoom(chat, 0, 1, 2));
		expect(await zoom(chat, 0, 1, 0)).toBe(await zoom(chat, 0, 1, 1));
	});

	it("does not cut a surrogate pair between pages", async () => {
		const chat = await openChat();
		const text = `${"a".repeat(ZOOM_PAGE_CHARS - 1)}😀tail`;
		await chat.logMessage("user", text);
		const first = await zoom(chat, 0, 1);
		const second = await zoom(chat, 0, 1, 2);
		const body = (page: string) => page.slice(page.indexOf("\n") + 1);
		expect(body(first)).toBe("a".repeat(ZOOM_PAGE_CHARS - 1));
		expect(body(second)).toBe("😀tail");
		expect(body(first) + body(second)).toBe(text);
	});
});

describe("dateOf", () => {
	it("gives the logged date as an ISO string with a local reading", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "hello");
		const out = dateOf(chat, 0);
		expect(out).toContain(LOGGED_AT);
		expect(out).toMatch(
			/^message 0: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \w+day, UTC[+-]\d{2}:\d{2} \(2026-03-01T10:00:00\.000Z\)$/,
		);
		expect(out).toBe(`message 0: ${formatLocal(new Date(LOGGED_AT))} (${LOGGED_AT})`);
	});

	it("rejects an id outside the chat", async () => {
		const chat = await openChat();
		await chat.logMessage("user", "hello");
		expect(() => dateOf(chat, 1)).toThrow(ZoomError);
	});
});

describe("formatLocal", () => {
	it("writes the local wall clock with the weekday and the UTC offset", () => {
		const date = new Date(2026, 9, 16, 14, 3, 22);
		expect(formatLocal(date)).toMatch(/^2026-10-16 14:03:22 Friday, UTC[+-]\d{2}:\d{2}$/);
	});
});
