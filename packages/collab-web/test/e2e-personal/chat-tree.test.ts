import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonalChatTreeStatus } from "@oh-my-pi/pi-wire/personal";
import type { GuestClient } from "../../src/lib/client";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { isCompaction, type StubReply, type StubRequest } from "../../scripts/e2e-personal-stub";
import { describeE2e, realTime, SCENARIO_TIMEOUT_MS } from "./support";

interface MainRow {
	i: number;
	kind: string;
	text: string;
	size: number;
	date: string;
}

interface TreeRow {
	l: number;
	i: number;
	text: string;
	size: number;
}

interface ChatStatusFile extends PersonalChatTreeStatus {
	nodesBuilt: number;
	updatedAt: string;
}

const NOTE = "HANDOFF-NOTE-CT: we were drafting the bakery's tax summary.";
const LONG_MARKER = "CT-LONG-PROMPT";
const LONG_PROMPT =
	`${LONG_MARKER} ${"The flour supplier changes its prices every Monday and the oven needs service in spring. ".repeat(9)}`.trimEnd();

/** The reply the scripted model gives to a leaf compaction: long enough that a merge of two lines needs a model call too. */
const LEAF_SUMMARY_BYTES = 480;

/** `head` followed by varied words up to `bytes` bytes: a reply that repeats itself is taken for a stalled stream. */
function summaryOf(head: string, bytes: number): string {
	let text = head;
	for (let i = 0; text.length < bytes; i++) text += ` ${Bun.hash(`${head}${i}`).toString(36)}`;
	return text.slice(0, bytes);
}

/** Scenarios of the chat-tree memory mode (docs/personal-chat-tree.md) from the app's settings request to the endless chat on disk. One computer, in this order. */
describeE2e("the Personal agent's chat-tree memory mode", () => {
	let h: PersonalHarness;
	let P: string;
	let chatDir: string;
	let guest: GuestClient;
	/** The `personal-changed` frames the device received. */
	let pushes = 0;
	let pushesAtChatStart = 0;
	let stopPushes: () => void;
	let handoffRequest: StubRequest;
	let recallInstance: string;
	let recallSession: string;
	/** What the stub saw of the first request of each prompt. */
	const firstRequests: Record<string, StubRequest> = {};
	let kindsAfterThree: string[] = [];
	let viewAfterThree: [number, number][] = [];
	let statusAfterOne: ChatStatusFile;
	let chatSession: { sessionId: string; instanceId: string; generation: number };

	beforeAll(async () => {
		h = await PersonalHarness.start();
		P = h.profile;
		chatDir = path.join(P, "agent", "personal-chat");
		stopPushes = h.client.onPersonalChanged(() => {
			pushes += 1;
		});
		// A rollover that is due at any time of the day once the day is a new one: in recall mode the clock would end the session.
		await h.setUp("# About you\n\n## Who I am\n\n- Sam, a baker.\n", { rollover: { time: "00:00" } });
		await h.waitIdle();
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		stopPushes?.();
		await h?.stop();
	});

	// ── helpers ──────────────────────────────────────────────────────────────

	const jsonl = async <T>(file: string): Promise<T[]> =>
		(await Bun.file(file).text())
			.split("\n")
			.filter(line => line.startsWith("{"))
			.map(line => JSON.parse(line) as T);

	const dayFiles = async (dir: string): Promise<string[]> =>
		(await fs.readdir(path.join(chatDir, dir)).catch(() => [] as string[]))
			.filter(name => name.endsWith(".jsonl"))
			.sort()
			.map(name => path.join(chatDir, dir, name));

	const mainRows = async (): Promise<MainRow[]> => {
		const rows: MainRow[] = [];
		for (const file of await dayFiles("main")) rows.push(...(await jsonl<MainRow>(file)));
		return rows;
	};

	const treeRows = async (): Promise<TreeRow[]> => {
		const rows: TreeRow[] = [];
		for (const file of await dayFiles("tree")) rows.push(...(await jsonl<TreeRow>(file)));
		return rows;
	};

	const viewJson = async (): Promise<[number, number][]> =>
		JSON.parse(await Bun.file(path.join(chatDir, "view.json")).text());

	const statusFile = async (): Promise<ChatStatusFile> =>
		JSON.parse(await Bun.file(path.join(chatDir, "status.json")).text());

	/** Every file under the chat directory with its content, relative path as key. */
	const snapshot = async (skip: readonly string[] = []): Promise<Record<string, string>> => {
		const out: Record<string, string> = {};
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
				const full = path.join(dir, entry.name);
				const rel = path.relative(chatDir, full);
				if (entry.isDirectory()) await walk(full);
				else if (!skip.includes(rel)) out[rel] = await Bun.file(full).text();
			}
		};
		await walk(chatDir);
		return out;
	};

	/** The chat is quiet: every message is on disk and every line is built. */
	const chatSettled = async (messages: number): Promise<ChatStatusFile> =>
		await until(
			`the chat to hold ${messages} messages, all summarized`,
			async () => {
				const status = await statusFile().catch(() => undefined);
				return status !== undefined && status.messages === messages && status.nodesPending === 0
					? status
					: undefined;
			},
			{ timeoutMs: 60_000, everyMs: 500 },
		);

	/** The first request a turn made for the prompt that contains `marker`: a turn call starts with one message. */
	const turnStart = (marker: string, after: number): Promise<StubRequest> =>
		h.stub.waitForRequest(
			r => !isCompaction(r) && r.conversation.length === 1 && (r.lastUserBlocks.at(-1) ?? "").includes(marker),
			{ after, timeoutMs: 120_000 },
		);

	const sessionName = async (): Promise<string[]> => {
		const listed = await h.tmux("list-sessions", "-F", "#{session_name}");
		return listed.code === 0 ? listed.out.split("\n").filter(Boolean) : [];
	};

	/** The Personal session is idle, a new one (not `notInstance`), and its room can be opened. */
	const newSessionIdle = async (notInstance: string, timeoutMs = 240_000) => {
		await until(
			"the new Personal session to be idle",
			async () => {
				const now = await h.status();
				return (
					now.run === "idle" &&
					now.session !== null &&
					now.session.instanceId !== notInstance &&
					h.personalHost()?.instanceId === now.session.instanceId
				);
			},
			{ timeoutMs, everyMs: 500 },
		);
		return (await h.status()).session!;
	};

	// ── 1: recall, then the owner switches ───────────────────────────────────

	it(
		"runs in recall mode first, then the owner's switch restarts the session and the handoff note becomes a note in the chat, with no turn",
		async () => {
			guest = await h.openSession();
			await h.turn(guest, "Hello, I am Sam and I run a bakery. RECALL-TURN");
			const before = await h.status();
			recallInstance = before.session!.instanceId!;
			recallSession = before.session!.sessionId;
			expect(before.chatTree).toBeUndefined();
			expect(h.client.getSnapshot().canPersonalChatTree).toBe(true);
			expect(await Bun.file(path.join(P, "agent", "personal-chat", "main")).exists()).toBe(false);
			// The recall session's request: more than one message is not required, but the chat-tree tools are not there.
			const recallRequest = h.stub.agentRequests().find(r => r.lastUser.includes("RECALL-TURN"))!;
			expect(recallRequest.toolNames).not.toContain("zoom");

			h.stub.enqueue({ text: NOTE }, r => r.lastUser.includes("handoff note for your next session"));
			const pushesBefore = pushes;
			const answer = await h.call({ t: "personal-settings-set", patch: { memoryMode: "chat-tree" } });
			expect(answer.settings.memoryMode).toBe("chat-tree");
			const config = Bun.YAML.parse(await Bun.file(path.join(P, "agent", "config.yml")).text()) as Record<
				string,
				any
			>;
			expect(config.personal.memoryMode).toBe("chat-tree");
			expect(pushes).toBeGreaterThanOrEqual(pushesBefore);

			handoffRequest = await h.stub.waitForRequest(r => r.lastUser.includes("handoff note for your next session"), {
				timeoutMs: 120_000,
			});
			chatSession = (await newSessionIdle(recallInstance)) as typeof chatSession;
			expect(chatSession.sessionId).not.toBe(recallSession);
			expect(chatSession.generation).toBe(before.session!.generation + 1);
			expect((await sessionName()).length).toBe(1);

			// The note is in the chat, once, and the model was never asked anything for it.
			const rows = await until(
				"the handoff note in the chat",
				async () => {
					const found = await mainRows().catch(() => [] as MainRow[]);
					return found.some(row => row.kind === "note") ? found : undefined;
				},
				{ timeoutMs: 60_000, everyMs: 500 },
			);
			expect(rows.map(row => row.kind)).toEqual(["note"]);
			expect(rows[0]!.i).toBe(0);
			expect(rows[0]!.text).toContain(NOTE);
			expect(rows[0]!.size).toBe(Buffer.byteLength(rows[0]!.text));
			await realTime(6_000);
			expect(h.stub.agentRequests().filter(r => r.n > handoffRequest.n)).toEqual([]);
			expect((await mainRows()).filter(row => row.kind === "note")).toHaveLength(1);
			expect(Object.keys(await snapshot())).toEqual(
				expect.arrayContaining(["view.json", "status.json", "lock", expect.stringMatching(/^main\/.*\.jsonl$/)]),
			);
		},
		SCENARIO_TIMEOUT_MS,
	);

	// ── 2 and 3: three prompts, the tree, zoom ───────────────────────────────

	it(
		"answers each prompt with a fresh call of tools + system + one message of view, state and prompt",
		async () => {
			guest = await h.openSession();
			h.stub.setCompaction(task => {
				const leaf = /^Compaction: compress message (\d+)/.exec(task);
				if (leaf) return { text: summaryOf(`SUMMARY-${leaf[1]}:`, LEAF_SUMMARY_BYTES) };
				const merge = /^Compaction: merge lines (\d+\+\d+) and (\d+\+\d+)/.exec(task);
				return { text: `MERGED ${merge?.[1]} ${merge?.[2]}` };
			});

			const after = h.stub.requests.at(-1)?.n ?? 0;
			pushesAtChatStart = pushes;
			h.stub.setIdle({ text: "Hello Sam, noted." });
			await h.turn(guest, "Hi, I'm Sam and I bake bread. CT-ONE");
			const one = await turnStart("CT-ONE", after);
			firstRequests.one = one;
			await chatSettled(3);
			statusAfterOne = await statusFile();

			// Tools + system + exactly one user message.
			expect(one.conversation).toHaveLength(1);
			expect(one.conversation[0]!.role).toBe("user");
			expect(one.toolNames).toEqual(expect.arrayContaining(["zoom", "date"]));
			expect(one.toolNames).not.toContain("recall");
			expect(one.toolNames).not.toContain("reflect");
			expect(one.system).toContain("single chat that never");
			expect(one.system).toContain("Sam, a baker");
			// View (ending `</chat>`), state, then the message, as separate blocks.
			const blocks = one.lastUserBlocks;
			const state = blocks.findIndex(block => block.startsWith("<state>"));
			expect(state).toBeGreaterThan(0);
			expect(blocks[state]!.trimEnd().endsWith("</state>")).toBe(true);
			expect(blocks[state - 1]!.endsWith("</chat>")).toBe(true);
			expect(blocks[0]!.startsWith("<chat>\n")).toBe(true);
			expect(blocks.slice(0, state).join("")).toContain(`0+1|note: ${NOTE}`);
			expect(blocks.slice(state + 1).join("")).toContain("CT-ONE");
			expect(blocks.at(-1)!.endsWith("Hi, I'm Sam and I bake bread. CT-ONE")).toBe(true);
			expect(blocks.slice(0, state).join("")).not.toContain("CT-ONE");

			// What the chat holds: the note, the prompt, the reply.
			const rows = await mainRows();
			expect(rows.map(row => row.kind)).toEqual(["note", "user", "unii"]);
			expect(rows[1]!.text).toContain("CT-ONE");
			expect(rows[2]!.text).toBe("Hello Sam, noted.");
			expect(statusAfterOne.nodesBuilt).toBeGreaterThanOrEqual(3);
			expect(statusAfterOne.viewBytes).toBeGreaterThan(0);
			expect(statusAfterOne.compactionsFailed).toBe(0);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"summarizes a long prompt with a side request (the scripted model answers it), and a merge that does not fit",
		async () => {
			const after = h.stub.requests.at(-1)?.n ?? 0;
			const results = await h.toolsOnPrompt(guest, LONG_PROMPT, [{ name: "date", args: { id: 1 } }]);
			const start = await turnStart(LONG_MARKER, after);
			firstRequests.two = start;
			// The turn's own call: one message, the same tools and system prompt as the first turn, a longer view.
			expect(start.conversation).toHaveLength(1);
			expect(start.toolNames).toEqual(firstRequests.one!.toolNames);
			expect(start.system).toBe(firstRequests.one!.system);
			expect(start.lastUserBlocks.at(-1)!.endsWith(LONG_PROMPT)).toBe(true);
			expect(start.lastUserBlocks.join("")).toContain("2+1|unii: Hello Sam, noted.");
			// Its second call, after the tool: the same first message, then the assistant's call and its result.
			const second = h.stub
				.agentRequests()
				.find(
					r => !isCompaction(r) && r.conversation.length === 3 && r.conversation[0]!.text.includes(LONG_MARKER),
				)!;
			expect(second.conversation[0]!.blocks).toEqual(start.conversation[0]!.blocks);
			expect(second.conversation.map(m => m.role)).toEqual(["user", "assistant", "tool"]);
			expect(second.conversation[1]!.toolCalls).toEqual([{ name: "date", args: { id: 1 } }]);
			expect(results[0]).toMatch(
				/^message 1: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \w+day, UTC[+-]\d\d:\d\d \(\d{4}-\d\d-\d\dT/,
			);

			const rows = await mainRows();
			expect(rows.map(row => row.kind)).toEqual(["note", "user", "unii", "user", "tool", "echo", "unii"]);
			expect(rows[3]!.text).toBe(LONG_PROMPT);
			expect(rows[3]!.size).toBeGreaterThan(512);
			expect(rows[4]!.text).toBe('date {"id":1}');
			expect(rows[5]!.text).toBe(results[0]!);
			expect(rows[6]!.text).toBe("Done.");
			await chatSettled(7);

			// The leaf compaction: a side request with the turn's tools and system prompt, one user message, a 512-dash ruler.
			const leaf = h.stub
				.agentRequests()
				.find(r => isCompaction(r) && r.lastUserBlocks.at(-1)!.startsWith("Compaction: compress message 3"))!;
			expect(leaf).toBeDefined();
			expect(leaf.conversation).toHaveLength(1);
			expect(leaf.toolNames).toEqual(start.toolNames);
			expect(leaf.system).toBe(start.system);
			expect(leaf.lastUserBlocks.at(-1)).toContain("-".repeat(512));
			expect(leaf.lastUserBlocks.at(-1)).toContain(`user: ${LONG_PROMPT}`);
			expect(leaf.lastUserBlocks.at(-2)!.endsWith("</chat>")).toBe(true);
			// Short messages are kept as they are, with no model call.
			expect(
				h.stub.requests.filter(r => isCompaction(r) && r.lastUserBlocks.at(-1)!.includes("compress message 1")),
			).toEqual([]);
			const merge = h.stub.requests.find(
				r => isCompaction(r) && r.lastUserBlocks.at(-1)!.startsWith("Compaction: merge lines 0+2 and 2+2"),
			);
			expect(merge).toBeDefined();

			const tree = await treeRows();
			const node = (l: number, i: number) => tree.find(row => row.l === l && row.i === i);
			expect(node(0, 0)!.text).toBe(`note: ${NOTE}`);
			expect(node(0, 3)!.text.startsWith("SUMMARY-3: ")).toBe(true);
			expect(node(0, 3)!.size).toBe(LEAF_SUMMARY_BYTES);
			expect(node(0, 3)!.size).toBeLessThanOrEqual(512);
			expect(node(2, 0)!.text).toBe("MERGED 0+2 2+2");
			expect(node(1, 0)!.text).toBe(`${node(0, 0)!.text}\n${node(0, 1)!.text}`);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"zooms into the tree: the children of a line, and the whole message at n = 1",
		async () => {
			const after = h.stub.requests.at(-1)?.n ?? 0;
			const results = await h.toolsOnPrompt(guest, "CT-THREE zoom please", [
				{ name: "zoom", args: { id: 2, n: 2 } },
				{ name: "zoom", args: { id: 0, n: 4 } },
				{ name: "zoom", args: { id: 0, n: 8 } },
				{ name: "zoom", args: { id: 3, n: 1 } },
				{ name: "zoom", args: { id: 40, n: 1 } },
			]);
			const start = await turnStart("CT-THREE", after);
			firstRequests.three = start;
			expect(start.conversation).toHaveLength(1);
			// The view the turn read holds the earlier lines, the summary of the long prompt among them.
			const view = start.lastUserBlocks
				.slice(
					0,
					start.lastUserBlocks.findIndex(b => b.startsWith("<state>")),
				)
				.join("");
			expect(view.startsWith("<chat>\n")).toBe(true);
			expect(view.endsWith("</chat>")).toBe(true);
			expect(view).toContain("3+1|SUMMARY-3: ");
			expect(view.split("\n").filter(line => /^\d+\+\d+\|/.test(line))).toHaveLength(7);
			// More than four lines: the view is sent in whole blocks of four lines and a tail.
			expect(start.lastUserBlocks.findIndex(b => b.startsWith("<state>"))).toBeGreaterThanOrEqual(2);

			// zoom(2, 2): the two lines under 2+2 are the messages 2 and 3, as the view names them.
			const lines = results[0]!.split("\n");
			expect(lines).toHaveLength(2);
			expect(lines[0]).toBe("2+1|unii: Hello Sam, noted.");
			expect(lines[1]!.startsWith("3+1|SUMMARY-3: ")).toBe(true);
			// zoom(0, 4): lines 0+2 and 2+2, each two short lines joined (the second holds the summary).
			const upper = results[1]!.split("\n");
			expect(upper[0]!.startsWith(`0+2|note: ${NOTE}`)).toBe(true);
			expect(upper[1]!.startsWith("2+2|unii: Hello Sam, noted. SUMMARY-3: ")).toBe(true);
			// zoom(0, 8): the line 0+4 is the one the model wrote for the merge that did not fit.
			expect(results[2]!.split("\n")[0]).toBe("0+4|MERGED 0+2 2+2");
			// zoom(3, 1): the whole message, not the summary.
			expect(results[3]).toBe(`message 3, user, ${Buffer.byteLength(LONG_PROMPT)} bytes\n${LONG_PROMPT}`);
			// A message that is not there is an error the model reads.
			expect(results[4]).toContain("There is no message 40");

			const rows = await mainRows();
			kindsAfterThree = rows.map(row => row.kind);
			expect(kindsAfterThree).toEqual([
				"note",
				"user",
				"unii",
				"user",
				"tool",
				"echo",
				"unii",
				"user",
				"tool",
				"echo",
				"tool",
				"echo",
				"tool",
				"echo",
				"tool",
				"echo",
				"tool",
				"echo",
				"unii",
			]);
			expect(rows[8]!.text).toBe('zoom {"id":2,"n":2}');
			expect(rows[9]!.text).toBe(results[0]!);
			expect(rows[15]!.text).toBe(results[3]!);
			expect(rows[16]!.text).toBe('zoom {"id":40,"n":1}');
			expect(rows[17]!.text.startsWith("error: ")).toBe(true);
			expect(rows.map(row => row.i)).toEqual(rows.map((_, index) => index));
			// The long echo of the whole message is a message of its own: more than the 512 bytes of a line, so it was summarized too.
			expect(rows[15]!.size).toBeGreaterThan(512);
			await chatSettled(rows.length);
			const viewFile = await viewJson();
			viewAfterThree = viewFile;
			expect(viewFile).toEqual(rows.map((_, index) => [0, index]));
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"shows the chat's numbers in the companion's status, and they move as the chat grows",
		async () => {
			const status = await statusFile();
			expect(status.messages).toBe(kindsAfterThree.length);
			expect(status.messages).toBeGreaterThan(statusAfterOne.messages);
			expect(status.nodesBuilt).toBeGreaterThan(statusAfterOne.nodesBuilt);
			expect(status.viewBytes).toBeGreaterThan(statusAfterOne.viewBytes);
			expect(status.nodesPending).toBe(0);
			expect(status.compactionsFailed).toBe(0);
			expect(Date.parse(status.updatedAt)).toBeGreaterThan(Date.parse(statusAfterOne.updatedAt));

			const frame = (await h.status()).chatTree;
			expect(frame).toEqual({
				messages: status.messages,
				nodesPending: 0,
				viewBytes: status.viewBytes,
				compactionsFailed: 0,
			});
			// The companion pushes it to the devices too (at most every few seconds).
			await until("a push after the chat started", () => pushes > pushesAtChatStart || undefined, {
				timeoutMs: 20_000,
				everyMs: 500,
			});
			expect((await h.status()).nextRolloverAt).toBeNull();
		},
		SCENARIO_TIMEOUT_MS,
	);

	// ── 4: no rollover, keep-alive continues the chat ────────────────────────

	let continued: { before: ChatStatusFile; view: [number, number][]; rows: MainRow[] };

	it(
		"does not roll the session over when the daily rollover time passes",
		async () => {
			const before = await h.status();
			const requests = h.stub.requests.length;
			const names = await sessionName();
			await h.advanceToNextDay();
			// Past the rollover time (00:00) of a new day: in recall mode the next keep-alive tick would roll over. Give it several.
			await realTime(45_000);
			const after = await h.status();
			expect(after.run).toBe("idle");
			expect(after.session).toEqual(before.session);
			expect(after.nextRolloverAt).toBeNull();
			expect(h.personalHost()?.instanceId).toBe(before.session!.instanceId ?? undefined);
			expect(await sessionName()).toEqual(names);
			expect(h.stub.requests.length).toBe(requests);
			expect(await h.companionLog()).not.toMatch(/\bkill-session\b/);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"brings a killed session back through the keep-alive and the next prompt continues the same chat",
		async () => {
			const rowsBefore = await mainRows();
			const viewBefore = await viewJson();
			continued = { before: await statusFile(), view: viewBefore, rows: rowsBefore };
			const before = await h.status();
			const [name] = await sessionName();
			expect((await h.tmux("kill-session", "-t", name!)).code).toBe(0);
			await until("the session to be gone", async () => (await sessionName()).length === 0, { timeoutMs: 10_000 });
			await until(
				"the keep-alive to restart it",
				async () => {
					const now = await h.status();
					return now.run === "idle" && h.personalHost() !== undefined && (await sessionName()).length === 1;
				},
				{ timeoutMs: 180_000, everyMs: 500 },
			);
			const after = await h.status();
			// The recorded session resumes: same session, and the chat is not given a second note.
			expect(after.session!.sessionId).toBe(before.session!.sessionId);
			expect((await mainRows()).filter(row => row.kind === "note")).toHaveLength(1);

			guest = await h.openSession();
			const mark = h.stub.requests.at(-1)?.n ?? 0;
			h.stub.setIdle({ text: "Welcome back." });
			await h.turn(guest, "Do you still remember me? CT-FOUR");
			const start = await turnStart("CT-FOUR", mark);
			expect(start.conversation).toHaveLength(1);
			// The earlier lines are in the view the new process read: the chat did not start over.
			const stateAt = start.lastUserBlocks.findIndex(b => b.startsWith("<state>"));
			const view = start.lastUserBlocks.slice(0, stateAt).join("");
			expect(view).toContain(`0+1|note: ${NOTE}`);
			expect(view).toContain("3+1|SUMMARY-3: ");
			// The first whole block of four lines is byte for byte what the third prompt sent: the cache holds across the restart.
			expect(start.lastUserBlocks[0]).toBe(firstRequests.three!.lastUserBlocks[0]);
			expect(start.toolNames).toEqual(firstRequests.three!.toolNames);
			expect(start.system).toBe(firstRequests.three!.system);
			const rows = await mainRows();
			expect(rows.map(row => row.i)).toEqual(rows.map((_, index) => index));
			expect(rows.slice(0, rowsBefore.length)).toEqual(rowsBefore);
			expect(rows.slice(rowsBefore.length).map(row => row.kind)).toEqual(["user", "unii"]);
			expect(rows[rowsBefore.length]!.i).toBe(rowsBefore.length);
			// The day moved on: the new messages are dated by the shifted clock, in a day file of their own.
			expect(Date.parse(rows.at(-1)!.date)).toBeGreaterThan(Date.parse(rowsBefore.at(-1)!.date) + 3_600_000);
			await chatSettled(rows.length);
			// view.json was reused as saved: the earlier lines are still there, unchanged, in order.
			const viewAfter = await viewJson();
			expect(viewAfter.slice(0, viewAfterThree.length)).toEqual(viewAfterThree);
			expect(viewAfter).toEqual(rows.map((_, index) => [0, index]));
			expect(viewAfterThree).toEqual(continued.view);
			const tree = await treeRows();
			// Built nodes were not built again: no node twice.
			expect(new Set(tree.map(row => `${row.l}+${row.i}`)).size).toBe(tree.length);
			expect(h.stub.requests.filter(r => isCompaction(r) && r.n > mark)).toEqual([]);
		},
		SCENARIO_TIMEOUT_MS,
	);

	// ── 5: back to recall ─────────────────────────────────────────────────────

	it(
		"switching back to recall starts a fresh omp session and leaves personal-chat untouched",
		async () => {
			const before = await h.status();
			const chatBefore = await snapshot();
			const reply: StubReply = { text: "Back in recall." };
			h.stub.setIdle(reply);
			const mark = h.stub.requests.at(-1)?.n ?? 0;
			const answer = await h.call({ t: "personal-settings-set", patch: { memoryMode: "recall" } });
			expect(answer.settings.memoryMode).toBe("recall");
			const next = await newSessionIdle(before.session!.instanceId!);
			// A fresh session (the chat-tree one is not resumed), and no handoff was asked of the chat-tree session.
			expect(next.sessionId).not.toBe(before.session!.sessionId);
			expect(
				h.stub.agentRequests().filter(r => r.n > mark && r.lastUser.includes("handoff note for your next session")),
			).toEqual([]);
			const config = Bun.YAML.parse(await Bun.file(path.join(P, "agent", "config.yml")).text()) as Record<
				string,
				any
			>;
			expect(config.personal.memoryMode).toBe("recall");
			expect((await sessionName()).length).toBe(1);
			expect((await h.status()).chatTree).toBeUndefined();

			// The old process closed the chat on its way out: the log, the tree and the view are what they were.
			const closed = await snapshot();
			const content = (files: Record<string, string>) =>
				Object.fromEntries(Object.entries(files).filter(([name]) => name !== "status.json" && name !== "lock"));
			expect(content(closed)).toEqual(content(chatBefore));
			expect(JSON.parse(closed["status.json"]!).messages).toBe(JSON.parse(chatBefore["status.json"]!).messages);

			guest = await h.openSession();
			const at = h.stub.requests.at(-1)?.n ?? 0;
			await h.turn(guest, "Plain recall again, please. RECALL-AGAIN");
			const recall = await h.stub.waitForRequest(r => !isCompaction(r) && r.lastUser.includes("RECALL-AGAIN"), {
				after: at,
			});
			expect(recall.toolNames).not.toContain("zoom");
			expect(recall.toolNames).not.toContain("date");
			expect(recall.system).not.toContain("single chat that never");
			expect(recall.transcript).not.toContain("<chat>");
			await realTime(8_000);

			// Nothing of that turn went into the chat, and no file in the directory was touched (status.json and lock included).
			expect(await snapshot()).toEqual(closed);
			expect(h.stub.requests.filter(r => isCompaction(r) && r.n > mark)).toEqual([]);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
