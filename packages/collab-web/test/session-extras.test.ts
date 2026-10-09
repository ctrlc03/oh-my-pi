import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, GuestFrame, HostFrame, SessionEntry, SessionState } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url, formatCollabLink } from "../src/lib/link";
import { newSinceLeft } from "../src/lib/new-since";
import { loadPromptQueue } from "../src/lib/rooms";
import { CollabSocket } from "../src/lib/socket";
import { sumUsage } from "../src/lib/usage";

const ROOM = "roomroomroom1234";
const KEY = new Uint8Array(32);
const WRITE_LINK = formatCollabLink("wss://relay.test", ROOM, KEY, new Uint8Array(16).fill(7));
const VIEW_LINK = `${ROOM}#${encodeBase64Url(KEY)}`;

const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

function welcome(readOnly?: boolean): HostFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" },
		state: STATE,
		agents: [],
		entryCount: 0,
		readOnly,
	};
}

describe("offline prompt queue", () => {
	const store = new Map<string, string>();
	const sent: GuestFrame[] = [];
	let sendSpy: { mockRestore(): void };

	beforeEach(() => {
		store.clear();
		sent.length = 0;
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v),
				removeItem: (k: string) => void store.delete(k),
			},
		});
		sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
	});

	afterEach(() => {
		sendSpy.mockRestore();
		Reflect.deleteProperty(globalThis, "localStorage");
	});

	it("holds prompts typed before the session is live and sends them once, in order, after welcome", () => {
		const client = new GuestClient(WRITE_LINK, "tester");
		client.sendPrompt("first");
		client.sendPrompt("second", [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		expect(sent).toEqual([]);
		expect(client.getSnapshot().queued.map(p => p.text)).toEqual(["first", "second"]);

		client.applyFrameForTest(welcome());
		expect(sent).toEqual([
			{ t: "prompt", text: "first", images: undefined },
			{ t: "prompt", text: "second", images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
		]);
		expect(client.getSnapshot().queued).toEqual([]);

		// A later frame must not resend anything.
		client.applyFrameForTest({ t: "state", state: STATE });
		expect(sent).toHaveLength(2);
	});

	it("survives an app kill: a new client for the same room restores the queue and flushes it", () => {
		new GuestClient(WRITE_LINK, "tester").sendPrompt("kept");
		expect(loadPromptQueue(ROOM).map(p => p.text)).toEqual(["kept"]);

		const reopened = new GuestClient(WRITE_LINK, "tester");
		expect(reopened.getSnapshot().queued.map(p => p.text)).toEqual(["kept"]);
		reopened.applyFrameForTest(welcome());
		expect(sent).toEqual([{ t: "prompt", text: "kept", images: undefined }]);
		expect(loadPromptQueue(ROOM)).toEqual([]);
	});

	it("drops a cancelled prompt before it can be sent", () => {
		const client = new GuestClient(WRITE_LINK, "tester");
		client.sendPrompt("oops");
		client.cancelQueued(client.getSnapshot().queued[0]!.id);
		client.applyFrameForTest(welcome());
		expect(sent).toEqual([]);
		expect(loadPromptQueue(ROOM)).toEqual([]);
	});

	it("sends immediately while live", () => {
		const client = new GuestClient(WRITE_LINK, "tester");
		client.applyFrameForTest(welcome());
		client.sendPrompt("now");
		expect(sent).toEqual([{ t: "prompt", text: "now", images: undefined }]);
		expect(client.getSnapshot().queued).toEqual([]);
	});

	it("never queues or sends for a view link", () => {
		const client = new GuestClient(VIEW_LINK, "tester");
		expect(client.getSnapshot().readOnly).toBe(true);
		client.sendPrompt("nope");
		expect(client.getSnapshot().queued).toEqual([]);
		expect(loadPromptQueue(ROOM)).toEqual([]);
	});

	it("discards a restored queue when the host turns out to treat the guest as read-only", () => {
		new GuestClient(WRITE_LINK, "tester").sendPrompt("stale");
		const client = new GuestClient(WRITE_LINK, "tester");
		client.applyFrameForTest(welcome(true));
		expect(sent).toEqual([]);
		expect(client.getSnapshot().queued).toEqual([]);
		expect(loadPromptQueue(ROOM)).toEqual([]);
	});
});

function userEntry(id: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "t", message: { role: "user", content: id, timestamp: 1 } };
}

function assistantEntry(id: string, usage: Partial<AssistantMessage["usage"]> | undefined): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "t",
		message: {
			role: "assistant",
			content: [],
			model: "m",
			usage: usage as AssistantMessage["usage"],
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

describe("newSinceLeft", () => {
	const entries = [userEntry("a"), userEntry("b"), userEntry("c")];

	it("reports entries after the last seen one", () => {
		const result = newSinceLeft(entries, "a");
		expect([...(result?.ids ?? [])]).toEqual(["b", "c"]);
		expect(result?.count).toBe(2);
	});

	it("reports nothing when unknown, caught up, or already gone from the transcript", () => {
		expect(newSinceLeft(entries, null)).toBeNull();
		expect(newSinceLeft(entries, "c")).toBeNull();
		expect(newSinceLeft(entries, "compacted-away")).toBeNull();
	});

	it("ignores newer entries that render nothing", () => {
		const resultOnly: SessionEntry = {
			type: "message",
			id: "r",
			parentId: null,
			timestamp: "t",
			message: { role: "toolResult", toolCallId: "x", toolName: "t", content: [], isError: false, timestamp: 1 },
		};
		expect(newSinceLeft([userEntry("a"), resultOnly], "a")).toBeNull();
	});
});

describe("sumUsage", () => {
	it("sums assistant usage and exposes the last turn, skipping messages without usage", () => {
		const usage = (input: number, output: number, total: number): Partial<AssistantMessage["usage"]> => ({
			input,
			output,
			cacheRead: 10,
			cacheWrite: 1,
			cost: { total },
		});
		const result = sumUsage([
			userEntry("u"),
			assistantEntry("a1", usage(100, 20, 0.5)),
			assistantEntry("a2", undefined),
			assistantEntry("a3", usage(300, 40, 0.25)),
		]);
		expect(result?.total).toEqual({ input: 400, output: 60, cacheRead: 20, cacheWrite: 2, cost: 0.75 });
		expect(result?.last).toEqual({ input: 300, output: 40, cacheRead: 10, cacheWrite: 1, cost: 0.25 });
	});

	it("is null when nothing reported usage", () => {
		expect(sumUsage([userEntry("u"), assistantEntry("a", undefined)])).toBeNull();
	});
});
