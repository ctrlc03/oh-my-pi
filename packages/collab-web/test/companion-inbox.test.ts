import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildInbox, DONE_MAX_AGE_MS } from "../scripts/companion-inbox";
import { pendingAsk, readSessionTail } from "../scripts/companion-sessions";
import type { CompanionHost } from "../src/lib/companion";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const ask = (id: string, agoMs: number, questions: object[]) => ({
	type: "message",
	timestamp: iso(agoMs),
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ask", arguments: { questions } }],
	},
});
const reply = (agoMs: number, text: string) => ({
	type: "message",
	timestamp: iso(agoMs),
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const user = (agoMs: number) => ({ type: "message", timestamp: iso(agoMs), message: { role: "user", content: "go" } });

function host(id: string, patch: Partial<CompanionHost>): CompanionHost {
	return {
		instanceId: `inst-${id}`,
		sessionId: `sess-${id}`,
		sessionName: `Session ${id}`,
		cwd: `/work/${id}`,
		model: null,
		startedAt: 0,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...patch,
	};
}

describe("pendingAsk", () => {
	it("extracts single-choice options and when the question was asked", () => {
		const entries = [
			user(9_000),
			ask("a", 5_000, [
				{ question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres", description: "x" }] },
			]),
		];
		expect(pendingAsk(entries)).toEqual({
			text: "Which database?",
			options: ["SQLite", "Postgres"],
			at: NOW - 5_000,
		});
	});

	it("offers no chips for a multi-select question", () => {
		const entries = [
			ask("a", 1_000, [{ question: "Which?", multi: true, options: [{ label: "A" }, { label: "B" }] }]),
		];
		expect(pendingAsk(entries)?.options).toEqual([]);
	});
});

describe("buildInbox", () => {
	let sessions: string;
	const fixtures: Record<string, object[]> = {
		waiting: [
			user(60_000),
			ask("q", 30_000, [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }]),
		],
		newer: [user(20_000), reply(10_000, "Refactor finished.")],
		older: [user(200_000), reply(100_000, "Tests pass.")],
		stale: [user(DONE_MAX_AGE_MS + 5_000), reply(DONE_MAX_AGE_MS + 1_000, "Long ago.")],
		working: [user(5_000), reply(4_000, "Still going.")],
	};

	beforeAll(async () => {
		sessions = await fs.mkdtemp(path.join(os.tmpdir(), "companion-inbox-"));
		await fs.mkdir(path.join(sessions, "proj"));
		for (const [id, lines] of Object.entries(fixtures)) {
			const file = path.join(sessions, "proj", `2026-10-09T00-00-00-000Z_sess-${id}.jsonl`);
			await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		}
	});

	afterAll(async () => {
		await fs.rm(sessions, { recursive: true, force: true });
	});

	it("lists waiting and recently finished sessions newest first, with the question's options", async () => {
		const hosts = [
			host("older", {}),
			host("stale", {}),
			host("working", { busy: true }),
			host("waiting", { inputRequired: true }),
			host("newer", {}),
		];
		const items = await buildInbox(hosts, id => readSessionTail(sessions, id), NOW);
		expect(items).toEqual([
			{
				instanceId: "inst-newer",
				title: "Session newer",
				cwd: "/work/newer",
				kind: "done",
				text: "Refactor finished.",
				at: NOW - 10_000,
			},
			{
				instanceId: "inst-waiting",
				title: "Session waiting",
				cwd: "/work/waiting",
				kind: "input",
				text: "Ship it?",
				options: ["Yes", "No"],
				at: NOW - 30_000,
			},
			{
				instanceId: "inst-older",
				title: "Session older",
				cwd: "/work/older",
				kind: "done",
				text: "Tests pass.",
				at: NOW - 100_000,
			},
		]);
	});

	it("still lists a session that needs input when its file is unreadable", async () => {
		const items = await buildInbox(
			[host("ghost", { inputRequired: true, sessionName: null })],
			id => readSessionTail(sessions, id),
			NOW,
		);
		expect(items).toEqual([
			{
				instanceId: "inst-ghost",
				title: "ghost",
				cwd: "/work/ghost",
				kind: "input",
				text: null,
				options: undefined,
				at: NOW,
			},
		]);
	});
});
