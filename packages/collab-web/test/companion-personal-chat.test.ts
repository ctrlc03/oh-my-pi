import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	chatHasMessages,
	NOTE_CHUNK_CHARS,
	NOTE_CONTROL_PREFIX,
	noteChunks,
	readChatTreeStatus,
} from "../scripts/companion-personal-chat";
import { MAX_EVENT_BODY_CHARS } from "@oh-my-pi/pi-wire/personal-ipc";
import { type PersonalPaths, personalPaths } from "../scripts/companion-personal-store";

let root: string;
let paths: PersonalPaths;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "personal-chat-"));
	paths = personalPaths(root);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("the chat's status.json", () => {
	const write = async (text: string): Promise<void> => {
		await fs.mkdir(paths.chatDir, { recursive: true });
		await Bun.write(paths.chatStatusFile, text);
	};

	it("lives in personal-chat/ of the profile's agent dir", () => {
		expect(paths.chatDir).toBe(path.join(paths.agentDir, "personal-chat"));
		expect(paths.chatStatusFile).toBe(path.join(paths.chatDir, "status.json"));
	});

	it("reads the four numbers the app shows and ignores the rest", async () => {
		await write(
			JSON.stringify({
				messages: 3,
				nodesBuilt: 2,
				nodesPending: 1,
				viewBytes: 640,
				compactionsFailed: 0,
				updatedAt: "2026-10-16T10:00:00.000Z",
			}),
		);
		expect(await readChatTreeStatus(paths)).toEqual({
			messages: 3,
			nodesPending: 1,
			viewBytes: 640,
			compactionsFailed: 0,
		});
	});

	it("is null when the file is missing, damaged, or holds anything but counts", async () => {
		expect(await readChatTreeStatus(paths)).toBeNull();
		await write("{ torn");
		expect(await readChatTreeStatus(paths)).toBeNull();
		await write("null");
		expect(await readChatTreeStatus(paths)).toBeNull();
		await write(JSON.stringify({ messages: 1, nodesPending: 0, viewBytes: 1 }));
		expect(await readChatTreeStatus(paths)).toBeNull();
		await write(JSON.stringify({ messages: -1, nodesPending: 0, viewBytes: 1, compactionsFailed: 0 }));
		expect(await readChatTreeStatus(paths)).toBeNull();
		await write(JSON.stringify({ messages: 1, nodesPending: "0", viewBytes: 1, compactionsFailed: 0 }));
		expect(await readChatTreeStatus(paths)).toBeNull();
	});
});

describe("whether the chat has messages", () => {
	it("is false for no folder, no file, and an empty file; true for a logged message", async () => {
		expect(await chatHasMessages(paths)).toBe(false);
		const main = path.join(paths.chatDir, "main");
		await fs.mkdir(main, { recursive: true });
		expect(await chatHasMessages(paths)).toBe(false);
		await Bun.write(path.join(main, "2026-10-09.jsonl"), "");
		await Bun.write(path.join(main, "notes.txt"), "not a log");
		expect(await chatHasMessages(paths)).toBe(false);
		await Bun.write(path.join(main, "2026-10-10.jsonl"), `${JSON.stringify({ i: 0, kind: "user", text: "hi" })}\n`);
		expect(await chatHasMessages(paths)).toBe(true);
	});
});

describe("the note as control events", () => {
	it("fits an event body with its prefix", () => {
		expect(NOTE_CONTROL_PREFIX.length + NOTE_CHUNK_CHARS).toBe(MAX_EVENT_BODY_CHARS);
	});

	it("keeps a short note whole and an empty one as no chunk", () => {
		expect(noteChunks("check the tax mail")).toEqual(["check the tax mail"]);
		expect(noteChunks("")).toEqual([]);
	});

	it("cuts a long note in order and never inside a surrogate pair", () => {
		const note = `${"a".repeat(NOTE_CHUNK_CHARS - 1)}😀${"b".repeat(10)}`;
		const chunks = noteChunks(note);
		expect(chunks.join("")).toBe(note);
		expect(chunks).toHaveLength(2);
		expect(chunks.every(chunk => chunk.length <= NOTE_CHUNK_CHARS)).toBe(true);
		expect(chunks[1]?.startsWith("😀")).toBe(true);
	});
});
