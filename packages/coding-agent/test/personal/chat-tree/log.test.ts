import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatLockedError, ChatLog, type ChatLogOptions } from "../../../src/personal/chat-tree/log";
import { utf8Size } from "../../../src/personal/chat-tree/text";

let root: string;
let dir: string;
let clock: Date;
const opened: ChatLog[] = [];

function options(extra: ChatLogOptions = {}): ChatLogOptions {
	// No real `ps` lookups unless a test asks for one: lock pids in these tests are made up.
	return { now: () => clock, processStartMs: () => undefined, ...extra };
}

async function open(extra: ChatLogOptions = {}, where: string = dir): Promise<ChatLog> {
	const log = await ChatLog.open(where, options(extra));
	opened.push(log);
	return log;
}

const mainFile = (day: string) => path.join(dir, "main", `${day}.jsonl`);
const treeFile = (day: string) => path.join(dir, "tree", `${day}.jsonl`);

async function lines(file: string): Promise<string[]> {
	const text = await fs.readFile(file, "utf8");
	return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-log-"));
	dir = path.join(root, "personal-chat");
	clock = new Date("2026-03-01T10:00:00.000Z");
});

afterEach(async () => {
	await Promise.all(opened.splice(0).map(log => log.close()));
	await fs.rm(root, { recursive: true, force: true });
});

describe("ChatLog files", () => {
	it("creates the directory tree and writes rows in the documented shape", async () => {
		const log = await open();
		expect((await fs.readdir(dir)).sort()).toEqual(["lock", "main", "tree"]);
		const first = await log.appendMessage("user", "héllo €");
		const node = await log.appendNode(0, 0, "user: héllo €");
		expect(first).toEqual({
			i: 0,
			kind: "user",
			text: "héllo €",
			size: utf8Size("héllo €"),
			date: "2026-03-01T10:00:00.000Z",
		});
		expect(node).toEqual({ l: 0, i: 0, text: "user: héllo €", size: utf8Size("user: héllo €") });
		expect(await fs.readFile(mainFile("2026-03-01"), "utf8")).toBe(
			`{"i":0,"kind":"user","text":"héllo €","size":10,"date":"2026-03-01T10:00:00.000Z"}\n`,
		);
		expect(await fs.readFile(treeFile("2026-03-01"), "utf8")).toBe(
			`{"l":0,"i":0,"text":"user: héllo €","size":16}\n`,
		);
		const lock = JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8"));
		expect(lock).toEqual({ pid: process.pid, startedAt: "2026-03-01T10:00:00.000Z" });
	});

	it("only appends: earlier bytes never change across appends and reopen", async () => {
		const file = mainFile("2026-03-01");
		const treePath = treeFile("2026-03-01");
		let log = await open();
		await log.appendMessage("user", "one");
		await log.appendNode(0, 0, "user: one");
		let mainBytes = await fs.readFile(file);
		let treeBytes = await fs.readFile(treePath);
		for (let round = 0; round < 3; round++) {
			await log.appendMessage("unii", `reply ${round}`);
			await log.appendNode(0, round + 1, `unii: reply ${round}`);
			const mainNow = await fs.readFile(file);
			const treeNow = await fs.readFile(treePath);
			expect(mainNow.subarray(0, mainBytes.length).equals(mainBytes)).toBe(true);
			expect(treeNow.subarray(0, treeBytes.length).equals(treeBytes)).toBe(true);
			expect(mainNow.length).toBeGreaterThan(mainBytes.length);
			expect(treeNow.length).toBeGreaterThan(treeBytes.length);
			mainBytes = mainNow;
			treeBytes = treeNow;
			await log.close();
			// Reopening alone leaves the files as they were.
			log = await open();
			expect((await fs.readFile(file)).equals(mainBytes)).toBe(true);
			expect((await fs.readFile(treePath)).equals(treeBytes)).toBe(true);
		}
	});

	it("flushes every append: the row is on disk when the promise resolves", async () => {
		const log = await open();
		for (let k = 0; k < 5; k++) {
			await log.appendMessage("tool", `call ${k}`);
			// A separate read, not through the log.
			const rows = (await lines(mainFile("2026-03-01"))).map(line => JSON.parse(line));
			expect(rows).toHaveLength(k + 1);
			expect(rows[k]).toMatchObject({ i: k, kind: "tool", text: `call ${k}` });
			await log.appendNode(0, k, `tool: call ${k}`);
			const nodes = (await lines(treeFile("2026-03-01"))).map(line => JSON.parse(line));
			expect(nodes).toHaveLength(k + 1);
			expect(nodes[k]).toMatchObject({ l: 0, i: k, text: `tool: call ${k}` });
		}
	});

	it("splits files by the UTC day of the clock and keeps ids going", async () => {
		const log = await open();
		clock = new Date("2026-03-01T23:59:59.000Z");
		const before = await log.appendMessage("user", "before midnight");
		await log.appendNode(0, 0, "user: before midnight");
		clock = new Date("2026-03-02T00:00:01.000Z");
		const after = await log.appendMessage("unii", "after midnight");
		await log.appendNode(0, 1, "unii: after midnight");
		expect([before.i, after.i]).toEqual([0, 1]);
		expect((await fs.readdir(path.join(dir, "main"))).sort()).toEqual(["2026-03-01.jsonl", "2026-03-02.jsonl"]);
		expect((await fs.readdir(path.join(dir, "tree"))).sort()).toEqual(["2026-03-01.jsonl", "2026-03-02.jsonl"]);
		expect(await lines(mainFile("2026-03-01"))).toHaveLength(1);
		expect(JSON.parse((await lines(mainFile("2026-03-02")))[0])).toMatchObject({ i: 1, text: "after midnight" });
		await log.close();
		const again = await open();
		expect(again.messageCount).toBe(2);
		expect((await again.readMessage(0))?.text).toBe("before midnight");
		expect((await again.readMessage(1))?.text).toBe("after midnight");
		expect((await again.readNode(0, 1))?.text).toBe("unii: after midnight");
		clock = new Date("2026-03-02T09:00:00.000Z");
		expect((await again.appendMessage("user", "third")).i).toBe(2);
		expect(await lines(mainFile("2026-03-02"))).toHaveLength(2);
	});

	it("keeps appending to the newest day file when the clock steps back", async () => {
		const log = await open();
		clock = new Date("2026-03-05T10:00:00.000Z");
		await log.appendMessage("user", "a");
		clock = new Date("2026-03-03T10:00:00.000Z");
		const row = await log.appendMessage("user", "b");
		expect(row.date).toBe("2026-03-03T10:00:00.000Z");
		expect(await fs.readdir(path.join(dir, "main"))).toEqual(["2026-03-05.jsonl"]);
		await log.close();
		expect((await open()).messageCount).toBe(2);
	});

	it("round-trips a 1 MB message through readMessage", async () => {
		const log = await open();
		const text = `${"héllo wörld 😀\n".repeat(75_000)}end`;
		expect(utf8Size(text)).toBeGreaterThan(1_000_000);
		const row = await log.appendMessage("echo", text);
		expect(row.size).toBe(utf8Size(text));
		expect((await log.readMessage(0))?.text).toBe(text);
		await log.close();
		const again = await open();
		const back = await again.readMessage(0);
		expect(back?.text).toBe(text);
		expect(again.messageMeta(0)?.size).toBe(utf8Size(text));
	});
});

describe("ChatLog index", () => {
	it("survives a reopen: counts, meta, messages, nodes and the view", async () => {
		let log = await open();
		const kinds = ["user", "unii", "tool", "echo", "work", "note"] as const;
		for (let k = 0; k < 12; k++) {
			clock = new Date(clock.getTime() + 1000);
			await log.appendMessage(kinds[k % kinds.length], `message ${k} é`);
		}
		await log.appendNode(0, 0, "n00");
		await log.appendNode(0, 1, "n01 €");
		await log.appendNode(1, 0, "n10");
		await log.writeView([
			[1, 0],
			[0, 2],
		]);
		const metaBefore = Array.from({ length: 12 }, (_, k) => log.messageMeta(k));
		await log.close();

		log = await open();
		expect(log.messageCount).toBe(12);
		expect(log.nodeCount).toBe(3);
		expect(Array.from({ length: 12 }, (_, k) => log.messageMeta(k))).toEqual(metaBefore);
		expect(log.messageMeta(12)).toBeUndefined();
		expect(log.messageMeta(3)).toEqual({
			i: 3,
			kind: "echo",
			size: utf8Size("message 3 é"),
			date: "2026-03-01T10:00:04.000Z",
		});
		for (let k = 0; k < 12; k++) {
			expect(await log.readMessage(k)).toEqual({
				i: k,
				kind: kinds[k % kinds.length],
				text: `message ${k} é`,
				size: utf8Size(`message ${k} é`),
				date: new Date(Date.parse("2026-03-01T10:00:00.000Z") + (k + 1) * 1000).toISOString(),
			});
		}
		expect(await log.readMessage(12)).toBeUndefined();
		expect(await log.readMessage(-1)).toBeUndefined();
		expect(await log.readNode(0, 1)).toEqual({ l: 0, i: 1, text: "n01 €", size: utf8Size("n01 €") });
		expect(await log.readNode(1, 0)).toEqual({ l: 1, i: 0, text: "n10", size: 3 });
		expect(await log.readNode(5, 5)).toBeUndefined();
		expect(log.hasNode(0, 0)).toBe(true);
		expect(log.hasNode(0, 2)).toBe(false);
		expect(log.nodeSize(0, 1)).toBe(utf8Size("n01 €"));
		expect(log.nodeSize(7, 7)).toBeUndefined();
		const seen: [number, number, number][] = [];
		log.forEachNode((l, i, size) => seen.push([l, i, size]));
		expect(seen.sort()).toEqual([
			[0, 0, 3],
			[0, 1, utf8Size("n01 €")],
			[1, 0, 3],
		]);
		expect(await log.readView()).toEqual([
			[1, 0],
			[0, 2],
		]);
		expect((await log.appendMessage("user", "next")).i).toBe(12);
	});

	it("reads many nodes back through the cache cap", async () => {
		const log = await open();
		for (let k = 0; k < 4200; k++) await log.appendNode(0, k, `node ${k}`);
		await log.close();
		const again = await open();
		expect(again.nodeCount).toBe(4200);
		for (const k of [0, 1, 4199, 2000, 0, 4199]) expect((await again.readNode(0, k))?.text).toBe(`node ${k}`);
	});

	it("gives contiguous distinct ids in call order to concurrent appends", async () => {
		const log = await open();
		const rows = await Promise.all(Array.from({ length: 50 }, (_, k) => log.appendMessage("user", `m${k}`)));
		expect(rows.map(row => row.i)).toEqual(Array.from({ length: 50 }, (_, k) => k));
		expect(rows.map(row => row.text)).toEqual(Array.from({ length: 50 }, (_, k) => `m${k}`));
		const onDisk = (await lines(mainFile("2026-03-01"))).map(line => JSON.parse(line).text);
		expect(onDisk).toEqual(rows.map(row => row.text));
		expect(log.messageCount).toBe(50);
		await log.close();
		expect((await open()).messageCount).toBe(50);
	});

	it("builds a node once", async () => {
		const log = await open();
		await log.appendNode(2, 3, "first");
		await expect(log.appendNode(2, 3, "second")).rejects.toThrow(/already built/);
		expect(log.nodeCount).toBe(1);
		expect((await log.readNode(2, 3))?.text).toBe("first");
		expect(await lines(treeFile("2026-03-01"))).toHaveLength(1);
		const twice = await Promise.allSettled([log.appendNode(0, 0, "a"), log.appendNode(0, 0, "b")]);
		expect(twice.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
	});

	it("throws on a duplicate node found on open", async () => {
		await fs.mkdir(path.join(dir, "tree"), { recursive: true });
		const row = `{"l":0,"i":0,"text":"x","size":1}\n`;
		await fs.writeFile(treeFile("2026-03-01"), row);
		await fs.writeFile(treeFile("2026-03-02"), row);
		await expect(ChatLog.open(dir, options())).rejects.toThrow(/logged twice/);
		await expect(fs.stat(path.join(dir, "lock"))).rejects.toThrow();
	});
});

describe("ChatLog recovery", () => {
	const row = (i: number, text = `m${i}`) =>
		`${JSON.stringify({ i, kind: "user", text, size: utf8Size(text), date: "2026-03-01T10:00:00.000Z" })}\n`;

	it("ignores a torn last line, cuts it off and keeps the file parseable", async () => {
		const file = mainFile("2026-03-01");
		let log = await open();
		await log.appendMessage("user", "one");
		await log.appendMessage("user", "two");
		await log.close();
		const intact = await fs.readFile(file);
		await fs.appendFile(file, `{"i":2,"kind":"us`);

		log = await open();
		expect(log.messageCount).toBe(2);
		expect(log.messageMeta(2)).toBeUndefined();
		expect((await fs.readFile(file)).equals(intact)).toBe(true);
		const next = await log.appendMessage("user", "three");
		expect(next.i).toBe(2);
		const rows = (await lines(file)).map(line => JSON.parse(line));
		expect(rows.map(r => r.text)).toEqual(["one", "two", "three"]);
		expect((await fs.readFile(file)).subarray(0, intact.length).equals(intact)).toBe(true);
		await log.close();
		expect((await open()).messageCount).toBe(3);
	});

	it("ignores a torn last node line the same way", async () => {
		const file = treeFile("2026-03-01");
		let log = await open();
		await log.appendNode(0, 0, "n0");
		await log.close();
		await fs.appendFile(file, `{"l":0,"i":1,"te`);
		log = await open();
		expect(log.nodeCount).toBe(1);
		expect(log.hasNode(0, 1)).toBe(false);
		await log.appendNode(0, 1, "n1");
		expect((await lines(file)).map(line => JSON.parse(line).text)).toEqual(["n0", "n1"]);
	});

	it("ignores a corrupt last line that has its newline", async () => {
		const file = mainFile("2026-03-01");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `${row(0)}not json at all\n`);
		const log = await open();
		expect(log.messageCount).toBe(1);
		await log.appendMessage("user", "after");
		expect((await lines(file)).map(line => JSON.parse(line).i)).toEqual([0, 1]);
	});

	it("keeps a whole last row that only lost its newline", async () => {
		const file = mainFile("2026-03-01");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `${row(0)}${row(1)}`.slice(0, -1));
		const log = await open();
		expect(log.messageCount).toBe(2);
		expect((await log.readMessage(1))?.text).toBe("m1");
		await log.appendMessage("user", "m2");
		expect((await lines(file)).map(line => JSON.parse(line).i)).toEqual([0, 1, 2]);
	});

	it("throws on a corrupt line that is not the last, naming the file and line", async () => {
		const file = mainFile("2026-03-01");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `${row(0)}garbage\n${row(1)}`);
		await expect(ChatLog.open(dir, options())).rejects.toThrow(`${file}:2`);
		// The failed open must not keep the lock.
		await fs.writeFile(file, `${row(0)}${row(1)}`);
		expect((await open()).messageCount).toBe(2);
	});

	it("throws when a row's size does not match its text", async () => {
		const file = mainFile("2026-03-01");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, `{"i":0,"kind":"user","text":"abc","size":99,"date":"d"}\n${row(1)}`);
		await expect(ChatLog.open(dir, options())).rejects.toThrow(`${file}:1`);
	});

	it("throws on a gap in the ids, within a file and across files", async () => {
		const first = mainFile("2026-03-01");
		await fs.mkdir(path.dirname(first), { recursive: true });
		await fs.writeFile(first, `${row(0)}${row(2)}`);
		await expect(ChatLog.open(dir, options())).rejects.toThrow(/contiguous/);
		await fs.writeFile(first, `${row(0)}${row(1)}`);
		await fs.writeFile(mainFile("2026-03-02"), row(3));
		await expect(ChatLog.open(dir, options())).rejects.toThrow(/message id 3 where 2/);
		await fs.writeFile(mainFile("2026-03-02"), row(2));
		expect((await open()).messageCount).toBe(3);
	});
});

describe("ChatLog lock", () => {
	it("rejects a second open of the same directory with the holder's pid", async () => {
		await open();
		const error = await ChatLog.open(dir, options()).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChatLockedError);
		expect((error as ChatLockedError).pid).toBe(process.pid);
		expect((error as ChatLockedError).message).toContain(dir);
	});

	it("reports the pid written in the lock", async () => {
		await open({ pid: 4242 });
		const error = await ChatLog.open(dir, options({ isAlive: () => true })).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ChatLockedError);
		expect((error as ChatLockedError).pid).toBe(4242);
	});

	it("lets a closed log be opened again, and close is idempotent", async () => {
		const log = await open();
		await log.close();
		await log.close();
		await expect(fs.stat(path.join(dir, "lock"))).rejects.toThrow();
		const again = await open();
		expect(again.dir).toBe(dir);
	});

	it("steals a lock held by a dead pid", async () => {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "lock"),
			JSON.stringify({ pid: 99_999, startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		const probed: number[] = [];
		const log = await open({
			pid: 5151,
			isAlive: pid => {
				probed.push(pid);
				return false;
			},
		});
		expect(probed).toEqual([99_999]);
		expect(JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8")).pid).toBe(5151);
		await log.close();
		await expect(fs.stat(path.join(dir, "lock"))).rejects.toThrow();
	});

	it("does not steal a lock held by a live pid", async () => {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "lock"),
			JSON.stringify({ pid: 99_999, startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		await expect(ChatLog.open(dir, options({ isAlive: pid => pid === 99_999 }))).rejects.toBeInstanceOf(
			ChatLockedError,
		);
		expect(JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8")).pid).toBe(99_999);
	});

	it("steals a corrupt or empty lock file", async () => {
		await fs.mkdir(dir, { recursive: true });
		for (const content of ["{not json", "", "[]", `{"pid":"abc"}`, `{"pid":-3}`]) {
			await fs.writeFile(path.join(dir, "lock"), content);
			const log = await open({ isAlive: () => true });
			expect(JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8")).pid).toBe(process.pid);
			await log.close();
		}
	});

	it("takes over a lock that names our own pid when no chat of this process holds it", async () => {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "lock"),
			JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }),
		);
		const log = await open();
		expect(JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8")).startedAt).toBe("2026-03-01T10:00:00.000Z");
		await log.close();
		// While a chat of this process holds the directory, a second open is still refused.
		const again = await open();
		await expect(ChatLog.open(dir, options())).rejects.toBeInstanceOf(ChatLockedError);
		await again.close();
	});

	it("takes over a lock whose live pid started after the lock was written, not one that started before", async () => {
		await fs.mkdir(dir, { recursive: true });
		const lock = JSON.stringify({ pid: 4242, startedAt: "2026-03-01T09:00:00.000Z" });
		await fs.writeFile(path.join(dir, "lock"), lock);
		const probed: number[] = [];
		const startedAt = (at: string | undefined) => (pid: number) => {
			probed.push(pid);
			return at === undefined ? undefined : Date.parse(at);
		};
		for (const at of ["2026-03-01T08:00:00.000Z", "2026-03-01T09:00:04.000Z", undefined]) {
			const error = await ChatLog.open(
				dir,
				options({ pid: 5151, isAlive: () => true, processStartMs: startedAt(at) }),
			).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(ChatLockedError);
		}
		expect(probed).toEqual([4242, 4242, 4242]);
		expect(await fs.readFile(path.join(dir, "lock"), "utf8")).toBe(lock);
		const log = await open({
			pid: 5151,
			isAlive: () => true,
			processStartMs: startedAt("2026-03-01T09:30:00.000Z"),
		});
		expect(JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8")).pid).toBe(5151);
		await log.close();
	});

	it.skipIf(process.platform === "win32")("reads the holder's real start time with ps", async () => {
		await fs.mkdir(dir, { recursive: true });
		// The parent of this test process is alive and cannot have started before 2000.
		await fs.writeFile(
			path.join(dir, "lock"),
			JSON.stringify({ pid: process.ppid, startedAt: "2000-01-01T00:00:00.000Z" }),
		);
		const log = await open({ pid: 5151, processStartMs: undefined });
		expect(JSON.parse(await fs.readFile(path.join(dir, "lock"), "utf8")).pid).toBe(5151);
		await log.close();
	});

	it("never deletes a lock another process linked while it was taking over a stale one", async () => {
		await fs.mkdir(dir, { recursive: true });
		const lockFile = path.join(dir, "lock");
		await fs.writeFile(lockFile, JSON.stringify({ pid: 99_999, startedAt: "2020-01-01T00:00:00.000Z" }));
		const fresh = JSON.stringify({ pid: 7777, startedAt: "2026-03-01T09:59:00.000Z" });
		// Between reading the stale lock and removing it, another process replaces it with a live one.
		const isAlive = (pid: number) => {
			if (pid === 99_999) {
				fsSync.writeFileSync(lockFile, fresh);
				return false;
			}
			return pid === 7777;
		};
		await expect(ChatLog.open(dir, options({ pid: 5151, isAlive }))).rejects.toBeInstanceOf(ChatLockedError);
		expect(await fs.readFile(lockFile, "utf8")).toBe(fresh);
		expect((await fs.readdir(dir)).sort()).toEqual(["lock", "main", "tree"]);
	});

	it("lets exactly one of two opens take over the same stale lock", async () => {
		const isAlive = (pid: number) => pid !== 99_999;
		for (let round = 0; round < 20; round++) {
			const where = path.join(root, `race-${round}`);
			await fs.mkdir(where, { recursive: true });
			await fs.writeFile(
				path.join(where, "lock"),
				JSON.stringify({ pid: 99_999, startedAt: "2020-01-01T00:00:00.000Z" }),
			);
			const results = await Promise.allSettled([
				ChatLog.open(where, options({ pid: 1001, isAlive })),
				ChatLog.open(where, options({ pid: 1002, isAlive })),
			]);
			const won = results.filter(r => r.status === "fulfilled");
			for (const result of won) opened.push(result.value);
			expect(won).toHaveLength(1);
			const lost = results.find(r => r.status === "rejected");
			if (!lost) throw new Error("one open should have lost");
			expect(lost.reason).toBeInstanceOf(ChatLockedError);
			const holder = JSON.parse(await fs.readFile(path.join(where, "lock"), "utf8")).pid;
			expect(lost.reason.pid).toBe(holder);
		}
	});

	it("does not remove a lock that is no longer its own on close", async () => {
		const log = await open();
		const stolen = JSON.stringify({ pid: 777, startedAt: "x" });
		await fs.writeFile(path.join(dir, "lock"), stolen);
		await log.close();
		expect(await fs.readFile(path.join(dir, "lock"), "utf8")).toBe(stolen);
	});

	it("retries a lock held by a live process until it is released", async () => {
		const first = await open();
		// Real time on purpose: open() polls the lock on a real 250 ms timer, so the release must come from outside it.
		setTimeout(() => void first.close(), 300);
		const started = Date.now();
		const second = await open({ waitForLockMs: 5000 });
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(250);
		expect(waited).toBeLessThan(4000);
		expect(second.messageCount).toBe(0);
	});

	it("gives up after waitForLockMs", async () => {
		await open();
		const started = Date.now();
		await expect(ChatLog.open(dir, options({ waitForLockMs: 400 }))).rejects.toBeInstanceOf(ChatLockedError);
		const waited = Date.now() - started;
		expect(waited).toBeGreaterThanOrEqual(350);
		expect(waited).toBeLessThan(3000);
	});

	it("rejects appends and view writes after close, and waits for appends in flight", async () => {
		const log = await open();
		const pending = log.appendMessage("user", "in flight");
		const closing = log.close();
		await expect(log.appendMessage("user", "late")).rejects.toThrow(/closed/);
		await expect(log.appendNode(0, 0, "late")).rejects.toThrow(/closed/);
		await expect(log.writeView([[0, 0]])).rejects.toThrow(/closed/);
		await closing;
		expect((await pending).i).toBe(0);
		const again = await open();
		expect(again.messageCount).toBe(1);
	});
});

describe("ChatLog view", () => {
	it("returns undefined when there is no view.json", async () => {
		expect(await (await open()).readView()).toBeUndefined();
	});

	it("replaces view.json atomically and leaves no temp file", async () => {
		const log = await open();
		await log.writeView([[0, 0]]);
		await Promise.all(Array.from({ length: 10 }, (_, k) => log.writeView([[k, 0]])));
		expect(await log.readView()).toEqual([[9, 0]]);
		expect(await fs.readFile(path.join(dir, "view.json"), "utf8")).toBe("[[9,0]]");
		expect((await fs.readdir(dir)).sort()).toEqual(["lock", "main", "tree", "view.json"]);
	});

	it("rejects with the path when view.json is corrupt", async () => {
		const log = await open();
		await fs.writeFile(path.join(dir, "view.json"), "[[0,0],");
		await expect(log.readView()).rejects.toThrow(path.join(dir, "view.json"));
	});
});
