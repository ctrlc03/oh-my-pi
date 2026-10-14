import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type DigestTurn, extractTurns, renderDigest, sessionDigest } from "../scripts/companion-quiz-digest";
import { findSessionFile } from "../scripts/companion-sessions";

const FIXTURE = new URL("./fixtures/quiz/session.jsonl", import.meta.url).pathname;
const SESSION_ID = "01a12fa5-758e-7595-b768-bb9462d6e44e";
const NOISE = [
	"SECRET-TOOL-OUTPUT",
	"hunter2",
	"ghp_SECRET_EDIT_RESULT",
	"THINKING-SECRET",
	"NUDGE-NOISE",
	"ASYNC-NOISE",
	"LSP-NOISE",
	"TTSR-NOISE",
	"DEVELOPER-NOISE",
	"REMINDER-NOISE",
	"SUMMARY-OF-EARLIER-HISTORY",
	"todo_write",
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "quiz-digest-"));
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

async function fixtureEntries(): Promise<unknown[]> {
	const entries: unknown[] = [];
	for (const line of (await Bun.file(FIXTURE).text()).split("\n")) {
		try {
			entries.push(JSON.parse(line));
		} catch {
			// the fixture holds one broken line on purpose
		}
	}
	return entries;
}

function turn(role: DigestTurn["role"], text: string): DigestTurn {
	return { role, text };
}

describe("extractTurns", () => {
	it("keeps user prompts and assistant text, joined per turn, and nothing else", async () => {
		const turns = extractTurns(await fixtureEntries());
		expect(turns.map(item => item.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
		expect(turns[0]?.text).toBe(
			"Let's split the ciphernode builder into phases so the startup order is checked by the compiler.",
		);
		expect(turns[1]?.text).toBe(
			"I'll read the builder first.\n\nbuild_inner does four things in one 300 line function.\n\nI propose one struct per phase so that the next phase takes the previous phase's struct: the compiler then checks the startup order.",
		);
		// A block list is read, the injected reminder is stripped.
		expect(turns[2]?.text).toBe("Why a struct per phase and not a builder trait?");
		expect(turns[3]?.text).toContain("makes the wrong order a compile error.\n\nNow I will write the phases.");
		expect(turns[5]?.text).toBe("Renamed the paired setters to with_shared_stores and with_startup_buffer_limits.");
		const all = JSON.stringify(turns);
		for (const noise of NOISE) expect(all).not.toContain(noise);
	});

	it("reads plain user messages and skips empty ones and images", () => {
		const turns = extractTurns([
			{ type: "message", message: { role: "user", content: "plain prompt" } },
			{ type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
			{ type: "message", message: { role: "user", content: "<system-reminder>only a reminder</system-reminder>" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "  reply  " }] } },
		]);
		expect(turns).toEqual([turn("user", "plain prompt"), turn("assistant", "reply")]);
	});

	it("ignores custom messages that are not user prompts", () => {
		const turns = extractTurns([
			{ type: "custom_message", customType: "collab-prompt", attribution: "agent", content: "not from the user" },
			{ type: "custom_message", customType: "other", attribution: "user", content: "other kind" },
			"junk",
			null,
		]);
		expect(turns).toEqual([]);
	});

	it("includes a compaction summary only when the history it replaced is gone", () => {
		const entries = [
			{ type: "session", id: "s" },
			{ type: "compaction", summary: "## Goal\nOlder work", firstKeptEntryId: "x" },
			{ type: "message", message: { role: "user", content: "next ask" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "next answer" }] } },
		];
		const turns = extractTurns(entries);
		expect(turns).toHaveLength(3);
		expect(turns[0]).toEqual(turn("assistant", "Earlier in the session (summary): ## Goal\nOlder work"));
		expect(extractTurns([entries[0], entries[2], entries[1], entries[3]])).toHaveLength(2);
	});
});

describe("renderDigest", () => {
	const turns = [
		turn("user", "first ask"),
		turn("assistant", "A".repeat(2_000)),
		turn("user", "second ask"),
		turn("assistant", "B".repeat(300)),
	];

	it("formats User and Assistant blocks in order when everything fits", () => {
		const digest = renderDigest([turn("user", "ask"), turn("assistant", "answer")], 1_000);
		expect(digest).toEqual({ text: "User: ask\n\nAssistant: answer", turns: 2, omitted: 0 });
	});

	it("clips the longest assistant turn first, keeping its head and tail", () => {
		const digest = renderDigest(
			[turn("user", "ask"), turn("assistant", `HEAD${"x".repeat(3_000)}TAIL`), turn("assistant", "short answer")],
			1_000,
		);
		expect(digest.text.length).toBeLessThanOrEqual(1_000);
		expect(digest.text).toContain("Assistant: HEAD");
		expect(digest.text).toMatch(/\[… \d+ characters cut\]\nxx*TAIL/);
		expect(digest.text).toContain("short answer");
		expect(digest.omitted).toBe(0);
	});

	it("keeps every prompt and drops the oldest assistant turns first when clipping is not enough", () => {
		const many = Array.from({ length: 6 }, (_, i) => [
			turn("user", `ask number ${i}`),
			turn("assistant", `answer ${i} ${"y".repeat(400)}`),
		]).flat();
		const digest = renderDigest(many, 700);
		expect(digest.text.length).toBeLessThanOrEqual(700);
		for (let i = 0; i < 6; i++) expect(digest.text).toContain(`User: ask number ${i}`);
		expect(digest.text).not.toContain("answer 0 ");
		expect(digest.text).toContain("answer 5 ");
		expect(digest.omitted).toBeGreaterThan(0);
		expect(digest.turns + digest.omitted).toBe(many.length);
	});

	it("clips a long prompt to about 700 characters", () => {
		const digest = renderDigest([turn("user", `START${"p".repeat(5_000)}END`)], 10_000);
		expect(digest.text.length).toBeLessThan(800);
		expect(digest.text).toContain("User: START");
		expect(digest.text).toContain("END");
		expect(digest.text).toMatch(/\[… \d+ characters cut\]/);
	});

	it("drops the oldest prompts only when the prompts alone exceed the budget", () => {
		const prompts = Array.from({ length: 5 }, (_, i) => turn("user", `prompt ${i} ${"z".repeat(100)}`));
		const digest = renderDigest([...prompts, turn("assistant", "answer")], 300);
		expect(digest.text.length).toBeLessThanOrEqual(300);
		expect(digest.text).not.toContain("prompt 0");
		expect(digest.text).toContain("prompt 4");
		expect(digest.text).not.toContain("prompt 2");
		expect(digest.omitted).toBe(3);
		expect(digest.turns).toBe(3);
	});

	it("never exceeds the budget and is deterministic", () => {
		for (const budget of [0, 10, 50, 120, 400, 900, 5_000]) {
			const first = renderDigest(turns, budget);
			expect(first.text.length).toBeLessThanOrEqual(budget);
			expect(renderDigest(turns, budget)).toEqual(first);
		}
	});

	it("renders nothing for no turns", () => {
		expect(renderDigest([], 100)).toEqual({ text: "", turns: 0, omitted: 0 });
	});
});

describe("sessionDigest", () => {
	it("digests the fixture session file", async () => {
		const digest = await sessionDigest(FIXTURE, 10_000);
		expect(digest).not.toBeNull();
		expect(digest?.turns).toBe(6);
		expect(digest?.omitted).toBe(0);
		expect(digest?.text).toContain("User: Let's split the ciphernode builder into phases");
		expect(digest?.text).toContain("Assistant: I'll read the builder first.");
		expect(digest?.text).toContain("User: Also rename the setters to with_shared_stores.");
		for (const noise of NOISE) expect(digest?.text).not.toContain(noise);
	});

	it("fits a small budget", async () => {
		const digest = await sessionDigest(FIXTURE, 600);
		expect(digest?.text.length).toBeLessThanOrEqual(600);
		expect(digest?.text).toContain("User: Why a struct per phase");
	});

	it("is null for a missing file and for a file without a conversation", async () => {
		expect(await sessionDigest(path.join(tmp, "missing.jsonl"), 1_000)).toBeNull();
		const empty = path.join(tmp, "empty.jsonl");
		await Bun.write(empty, `{"type":"session","id":"x"}\n{not json\n`);
		expect(await sessionDigest(empty, 1_000)).toBeNull();
	});

	it("reads a file whose last line has no newline", async () => {
		const file = path.join(tmp, "tail.jsonl");
		const line = JSON.stringify({ type: "message", message: { role: "user", content: "no trailing newline" } });
		await Bun.write(file, `{"type":"session","id":"x"}\n${line}`);
		expect((await sessionDigest(file, 1_000))?.text).toBe("User: no trailing newline");
	});

	it("handles a multi-megabyte file with huge tool results", async () => {
		const file = path.join(tmp, "big.jsonl");
		const huge = JSON.stringify({
			type: "message",
			message: { role: "toolResult", content: [{ type: "text", text: "BIG-TOOL-OUTPUT ".repeat(400_000) }] },
		});
		const prompt = JSON.stringify({ type: "message", message: { role: "user", content: "the ask" } });
		await Bun.write(file, `${prompt}\n${huge}\n${huge}\n${prompt.replace("the ask", "the second ask")}\n`);
		const digest = await sessionDigest(file, 1_000);
		expect(digest?.text).toBe("User: the ask\n\nUser: the second ask");
	});

	it("works with the file findSessionFile returns for the default sessions layout", async () => {
		const sessionsDir = path.join(tmp, "agent", "sessions");
		const dir = path.join(sessionsDir, "-some-cwd");
		await fs.mkdir(dir, { recursive: true });
		await fs.copyFile(FIXTURE, path.join(dir, `2026-10-12T10-25-35-118Z_${SESSION_ID}.jsonl`));
		const file = await findSessionFile(sessionsDir, SESSION_ID);
		expect(file).toBe(path.join(dir, `2026-10-12T10-25-35-118Z_${SESSION_ID}.jsonl`));
		const digest = await sessionDigest(file as string, 10_000);
		expect(digest?.turns).toBe(6);
		expect(digest?.text).toContain("Assistant: Renamed the paired setters");
	});
});
