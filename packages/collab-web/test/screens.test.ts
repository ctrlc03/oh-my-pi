import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { collectScreens } from "../src/lib/screens";

interface Call {
	id: string;
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	/** Image blocks in the result content (base64 data). */
	images?: string[];
	details?: unknown;
	at?: string;
}

let seq = 0;

/** One assistant turn calling `calls`, followed by each call's result. */
function turn(...calls: Call[]): SessionEntry[] {
	const assistant: SessionEntry = {
		type: "message",
		id: `a${++seq}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: calls.map(c => ({
				type: "toolCall" as const,
				id: c.id,
				name: c.name,
				arguments: c.args,
				intent: c.intent,
			})),
			model: "test/model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
		},
	};
	const results: SessionEntry[] = calls.map(c => ({
		type: "message",
		id: `r${++seq}`,
		parentId: null,
		timestamp: c.at ?? "2026-07-09T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: c.id,
			toolName: c.name,
			content: [
				{ type: "text", text: "ok" },
				...(c.images ?? []).map(data => ({ type: "image" as const, data, mimeType: "image/png" })),
			],
			details: c.details,
			isError: false,
			timestamp: 1,
		},
	}));
	return [assistant, ...results];
}

const userPrompt = (images: string[]): SessionEntry => ({
	type: "message",
	id: `u${++seq}`,
	parentId: null,
	timestamp: "2026-07-09T00:00:00Z",
	message: {
		role: "user",
		content: [
			{ type: "text", text: "look at this" },
			...images.map(data => ({ type: "image" as const, data, mimeType: "image/png" })),
		],
		timestamp: 1,
	},
});

const summary = (entries: SessionEntry[]) =>
	collectScreens(entries).map(s => ({ data: s.image.data, tool: s.tool, label: s.label }));

describe("collectScreens", () => {
	it("lists tool result images oldest first, naming the tool and what the call was for", () => {
		const entries = [
			...turn({ id: "c1", name: "browser", args: { action: "run", url: "http://localhost:5173" }, images: ["A"] }),
			...turn({
				id: "c2",
				name: "browser",
				args: { action: "run" },
				intent: "Checking the login page",
				images: ["B", "C"],
			}),
		];
		expect(summary(entries)).toEqual([
			{ data: "A", tool: "browser", label: "http://localhost:5173" },
			{ data: "B", tool: "browser", label: "Checking the login page" },
			{ data: "C", tool: "browser", label: "Checking the login page" },
		]);
	});

	it("reads the intent from the call arguments when the entry carries none", () => {
		const entries = turn({
			id: "c1",
			name: "read",
			args: { path: "shot.png", i: "Reading the screenshot" },
			images: ["A"],
		});
		expect(collectScreens(entries)[0]?.label).toBe("Reading the screenshot");
	});

	it("includes images that travel in details.images, as generate_image ships them", () => {
		const entries = turn({
			id: "c1",
			name: "generate_image",
			args: { subject: "a red fox" },
			details: { images: [{ data: "G1", mimeType: "image/png" }, { data: 7 }] },
		});
		expect(summary(entries)).toEqual([{ data: "G1", tool: "generate_image", label: "a red fox" }]);
	});

	it("skips results without images and never counts images the user attached", () => {
		const entries = [
			userPrompt(["U1"]),
			...turn({ id: "c1", name: "bash", args: { command: "ls" } }),
			...turn({ id: "c2", name: "browser", args: { url: "http://x" }, images: ["A"] }),
			userPrompt(["U2"]),
		];
		expect(summary(entries).map(s => s.data)).toEqual(["A"]);
	});

	it("attributes an image to the entry that made the call, with the result's time", () => {
		const entries = turn({ id: "c1", name: "browser", args: {}, images: ["A"], at: "2026-07-09T10:00:00Z" });
		const [screen] = collectScreens(entries);
		expect(screen?.entryId).toBe(entries[0]?.id);
		expect(screen?.at).toBe(Date.parse("2026-07-09T10:00:00Z"));
		expect(screen?.id).toBe("c1:0");
	});

	it("names a device tool run through write xd:// by the device", () => {
		const entries = turn({
			id: "c1",
			name: "write",
			args: { path: "xd://browser", content: "{}" },
			images: ["A"],
			details: { xdev: { mode: "execute", tool: "browser", args: { url: "http://dev" }, inner: {} } },
		});
		expect(summary(entries)).toEqual([{ data: "A", tool: "browser", label: "http://dev" }]);
	});
});
