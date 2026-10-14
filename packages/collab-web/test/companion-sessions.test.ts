import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	costOfSessionText,
	findSessionFile,
	foreignTranscriptsDir,
	lastAssistantSummary,
	pendingQuestion,
	recentFolders,
	sessionFileCost,
} from "../scripts/companion-sessions";

const ask = (id: string, ...questions: string[]) => ({
	type: "message",
	message: {
		role: "assistant",
		content: [
			{ type: "text", text: "Let me ask." },
			{ type: "toolCall", id, name: "ask", arguments: { questions: questions.map(question => ({ question })) } },
		],
	},
});
const result = (id: string) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "ask" } });
const user = { type: "message", message: { role: "user", content: "go" } };
const reply = (text: string) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolOnly = {
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash" }] },
};

describe("pendingQuestion", () => {
	it("returns the question of an ask call that has no result yet", () => {
		expect(pendingQuestion([user, ask("a", "Which database?")])).toBe("Which database?");
		expect(pendingQuestion([ask("a", "First?", "Second?")])).toBe("First? (+1 more)");
	});

	it("ignores an ask that was answered, even when an older one was not", () => {
		expect(pendingQuestion([ask("old", "Stale?"), ask("a", "Which?"), result("a")])).toBeNull();
	});

	it("is null without an ask call", () => {
		expect(pendingQuestion([user, reply("hi")])).toBeNull();
	});
});

describe("lastAssistantSummary", () => {
	it("takes the start of the last reply, skipping tool-only messages", () => {
		const long = "x".repeat(300);
		const summary = lastAssistantSummary([user, reply(long), toolOnly]) ?? "";
		expect(summary.length).toBe(140);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("does not reach back past the last user message", () => {
		expect(lastAssistantSummary([reply("old answer"), user, toolOnly])).toBeNull();
	});
});

describe("recentFolders", () => {
	let tmp: string;
	const stamp = (offsetMs: number) => new Date(Date.now() - offsetMs);

	async function session(dir: string, id: string, cwd: string, ageMs: number, lines: object[]): Promise<void> {
		await fs.mkdir(path.join(tmp, "sessions", dir), { recursive: true });
		const file = path.join(tmp, "sessions", dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		const header = { type: "session", version: 3, id, cwd, title: "header title" };
		await fs.writeFile(file, [...lines, header].map(l => JSON.stringify(l)).join("\n") + "\n");
		await fs.utimes(file, stamp(ageMs), stamp(ageMs));
	}

	beforeAll(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-sessions-")));
		const alive = path.join(tmp, "alive");
		await fs.mkdir(alive);
		await session("a", "id-old", alive, 5_000, []);
		// The title slot is the current name; the header keeps the first one.
		await session("a", "id-new", alive, 1_000, [{ type: "title", v: 1, title: "Renamed", updatedAt: "x", pad: "" }]);
		await session("gone", "id-gone", path.join(tmp, "deleted"), 500, []);
	});

	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it("lists existing folders newest first with the current session titles", async () => {
		const folders = await recentFolders(path.join(tmp, "sessions"));
		expect(folders.map(f => f.cwd)).toEqual([path.join(tmp, "alive")]);
		expect(folders[0]!.sessions.map(s => [s.id, s.title])).toEqual([
			["id-new", "Renamed"],
			["id-old", "header title"],
		]);
	});
});

describe("vendor agent transcripts", () => {
	it("are found by session id beside omp's sessions, and never under them", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-foreign-files-")));
		try {
			const sessionsDir = path.join(root, "agent", "sessions");
			await fs.mkdir(sessionsDir, { recursive: true });
			const flat = path.join(foreignTranscriptsDir(sessionsDir), "codex-fedcba9876543210.jsonl");
			await Bun.write(flat, `${JSON.stringify({ type: "session", id: "codex-fedcba9876543210" })}\n`);
			expect(foreignTranscriptsDir(sessionsDir)).toBe(path.join(root, "agent", "collab-foreign", "sessions"));
			expect(await findSessionFile(sessionsDir, "codex-fedcba9876543210")).toBe(flat);
			expect(await findSessionFile(sessionsDir, "codex-0000000000000000")).toBeNull();
			expect(await findSessionFile(sessionsDir, "../../codex-fedcba9876543210")).toBeNull();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("session cost from the file", () => {
	const costed = (total: number) => ({
		type: "message",
		message: { role: "assistant", content: [], usage: { input: 1, cost: { input: total, total } } },
	});
	const lines = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join("\n");

	it("adds up what the assistant messages report", () => {
		expect(costOfSessionText(lines(user, costed(0.09), reply("hi"), costed(0.04)))).toBeCloseTo(0.13, 6);
	});

	it("is undefined without any cost, and skips garbled lines and non-finite totals", () => {
		expect(costOfSessionText(lines(user, reply("hi")))).toBeUndefined();
		expect(costOfSessionText(`{"cost": broken\n${lines(costed(Number.NaN), costed(0.5))}`)).toBe(0.5);
	});

	it("reads a session the stats database has not seen yet", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cost-"));
		try {
			const dir = path.join(root, "-work-x");
			await fs.mkdir(dir, { recursive: true });
			await Bun.write(
				path.join(dir, "2026-10-14T11-30-07-271Z_cost-session-1.jsonl"),
				lines(user, costed(0.09), costed(0.04)),
			);
			expect(await sessionFileCost(root, "cost-session-1")).toBeCloseTo(0.13, 6);
			expect(await sessionFileCost(root, "missing-session")).toBeUndefined();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
