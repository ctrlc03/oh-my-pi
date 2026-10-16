import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { STATUS_MIN_INTERVAL_MS } from "../../../src/personal/chat-tree/constants";
import { CHAT_STATUS_FILE, ChatStatusWriter, readChatStatus } from "../../../src/personal/chat-tree/status";

let dir: string;
let clock: Date;
const writers: ChatStatusWriter[] = [];

const numbers = (messages: number, extra: Partial<Record<string, number>> = {}) => ({
	messages,
	nodesBuilt: messages * 2,
	nodesPending: 3,
	viewBytes: 1000 + messages,
	compactionsFailed: 0,
	...extra,
});

function writer(minIntervalMs: number): ChatStatusWriter {
	const created = new ChatStatusWriter(dir, { minIntervalMs, now: () => clock });
	writers.push(created);
	return created;
}

const file = () => path.join(dir, CHAT_STATUS_FILE);
const onDisk = async () => JSON.parse(await fs.readFile(file(), "utf8")) as Record<string, unknown>;

/** Resolves once `ready` holds, polling the disk: the writer's timer is real, so there is no event to await. */
async function until(ready: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await ready())) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await Bun.sleep(5);
	}
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-status-"));
	clock = new Date("2026-03-01T10:00:00.000Z");
});

afterEach(async () => {
	await Promise.all(writers.splice(0).map(created => created.close()));
	await fs.rm(dir, { recursive: true, force: true });
});

describe("ChatStatusWriter", () => {
	it("writes exactly the six keys, atomically, at the first update", async () => {
		const status = writer(STATUS_MIN_INTERVAL_MS);
		status.update(numbers(7));
		await status.flush();
		expect(await onDisk()).toEqual({
			messages: 7,
			nodesBuilt: 14,
			nodesPending: 3,
			viewBytes: 1007,
			compactionsFailed: 0,
			updatedAt: "2026-03-01T10:00:00.000Z",
		});
		expect(Object.keys(await onDisk()).sort()).toEqual(
			["compactionsFailed", "messages", "nodesBuilt", "nodesPending", "updatedAt", "viewBytes"].sort(),
		);
		expect(await fs.readdir(dir)).toEqual([CHAT_STATUS_FILE]);
	});

	it("writes nothing extra into the file for extra properties on the numbers", async () => {
		const status = writer(STATUS_MIN_INTERVAL_MS);
		status.update(Object.assign(numbers(1), { stray: 9 }));
		await status.flush();
		expect(Object.keys(await onDisk())).toHaveLength(6);
	});

	it("creates the directory when it is missing", async () => {
		const nested = path.join(dir, "a", "b");
		const status = new ChatStatusWriter(nested, { now: () => clock });
		writers.push(status);
		status.update(numbers(1));
		await status.flush();
		expect((await readChatStatus(nested))?.messages).toBe(1);
	});

	it("rate limits: updates inside the interval are not written, the latest wins at flush", async () => {
		const rename = spyOn(fs, "rename");
		try {
			const status = writer(60_000);
			status.update(numbers(1));
			await status.flush();
			expect(rename).toHaveBeenCalledTimes(1);
			for (let k = 2; k <= 101; k++) status.update(numbers(k));
			await status.flush();
			expect(rename).toHaveBeenCalledTimes(2);
			expect((await onDisk()).messages).toBe(101);
			expect(await fs.readdir(dir)).toEqual([CHAT_STATUS_FILE]);
		} finally {
			rename.mockRestore();
		}
	});

	it("keeps the old numbers on disk while an update waits for the interval", async () => {
		const status = writer(60_000);
		status.update(numbers(1));
		await status.flush();
		for (let k = 2; k <= 50; k++) status.update(numbers(k));
		// The first write is done and nothing newer may have been written: the interval has not passed.
		expect((await onDisk()).messages).toBe(1);
		await status.flush();
		expect((await onDisk()).messages).toBe(50);
	});

	it("writes at once when the injected clock is past the interval", async () => {
		const status = writer(60_000);
		status.update(numbers(1));
		await status.flush();
		clock = new Date(clock.getTime() + 60_000);
		status.update(numbers(2));
		// update took the write itself (the interval has passed); flush only waits for it.
		await status.flush();
		expect(await onDisk()).toMatchObject({ messages: 2, updatedAt: "2026-03-01T10:01:00.000Z" });
	});

	it("writes the latest numbers by itself once the interval has passed", async () => {
		// A real timer: the writer schedules its own deferred write, so there is nothing to await but the file.
		const status = writer(30);
		status.update(numbers(1));
		for (let k = 2; k <= 20; k++) status.update(numbers(k));
		await until(async () => (await readChatStatus(dir))?.messages === 20);
		expect((await onDisk()).messages).toBe(20);
	});

	it("flush writes a pending update now, ignoring the interval, and stamps it at write time", async () => {
		const status = writer(60_000);
		status.update(numbers(1));
		await status.flush();
		clock = new Date("2026-03-01T10:00:05.000Z");
		status.update(numbers(2, { viewBytes: 5 }));
		expect((await onDisk()).messages).toBe(1);
		await status.flush();
		expect(await onDisk()).toMatchObject({ messages: 2, viewBytes: 5, updatedAt: "2026-03-01T10:00:05.000Z" });
	});

	it("flush with nothing pending is a no-op", async () => {
		const status = writer(60_000);
		await status.flush();
		await expect(fs.stat(file())).rejects.toThrow();
	});

	it("does not rewrite identical numbers, nor numbers that went back to what is on disk", async () => {
		const rename = spyOn(fs, "rename");
		try {
			const status = writer(60_000);
			status.update(numbers(1));
			await status.flush();
			status.update(numbers(1));
			await status.flush();
			expect(rename).toHaveBeenCalledTimes(1);
			status.update(numbers(2));
			status.update(numbers(1));
			await status.flush();
			expect(rename).toHaveBeenCalledTimes(1);
			expect((await onDisk()).messages).toBe(1);
		} finally {
			rename.mockRestore();
		}
	});

	it("compares all five numbers", async () => {
		const status = writer(60_000);
		const base = numbers(4);
		status.update(base);
		await status.flush();
		const keys = ["messages", "nodesBuilt", "nodesPending", "viewBytes", "compactionsFailed"] as const;
		for (const key of keys) {
			clock = new Date(clock.getTime() + 1000);
			const changed = { ...base, [key]: base[key] + 1 };
			status.update(changed);
			await status.flush();
			expect(await onDisk()).toMatchObject({ ...changed, updatedAt: clock.toISOString() });
			status.update(base);
			await status.flush();
		}
	});

	it("close flushes the pending update and ignores later ones", async () => {
		const status = writer(60_000);
		status.update(numbers(1));
		status.update(numbers(2));
		await status.close();
		expect((await onDisk()).messages).toBe(2);
		status.update(numbers(3));
		await status.flush();
		expect((await onDisk()).messages).toBe(2);
		await status.close();
	});
});

describe("readChatStatus", () => {
	it("returns undefined when the file is absent or the directory does not exist", async () => {
		expect(await readChatStatus(dir)).toBeUndefined();
		expect(await readChatStatus(path.join(dir, "nope"))).toBeUndefined();
	});

	it("returns undefined for garbage and for incomplete or mistyped content", async () => {
		for (const content of [
			"",
			"not json",
			"[]",
			"null",
			"42",
			`{"messages":1}`,
			`{"messages":"1","nodesBuilt":1,"nodesPending":1,"viewBytes":1,"compactionsFailed":0,"updatedAt":"x"}`,
			`{"messages":1,"nodesBuilt":1,"nodesPending":1,"viewBytes":1,"compactionsFailed":0}`,
			`{"messages":1,"nodesBuilt":1,"nodesPending":1,"viewBytes":1,"compactionsFailed":0,"updatedAt":5}`,
		]) {
			await Bun.write(file(), content);
			expect(await readChatStatus(dir)).toBeUndefined();
		}
	});

	it("reads back what the writer wrote", async () => {
		const status = writer(STATUS_MIN_INTERVAL_MS);
		status.update(numbers(9, { compactionsFailed: 2 }));
		await status.flush();
		expect(await readChatStatus(dir)).toEqual({
			messages: 9,
			nodesBuilt: 18,
			nodesPending: 3,
			viewBytes: 1009,
			compactionsFailed: 2,
			updatedAt: "2026-03-01T10:00:00.000Z",
		});
	});
});
