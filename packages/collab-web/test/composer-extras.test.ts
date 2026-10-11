import { describe, expect, it, vi } from "bun:test";
import type { GuestFrame, HostFrame, PromptMention, SessionEntry, SessionState } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { LARGE_PASTE_BYTES, isLargePaste, pastedTextFile } from "../src/lib/large-paste";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import {
	activeMention,
	applyMention,
	matchPrs,
	matchSessions,
	prsInTexts,
	resolveMentions,
	stripMentionContext,
} from "../src/lib/mentions";
import { MAX_STASHED, pushStash, type StashedDraft } from "../src/lib/draft-stash";
import { NOT_RECALLING, promptHistory, recallStep } from "../src/lib/recall";
import { CollabSocket } from "../src/lib/socket";

const WRITE_LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(48))}`;
const STATE: SessionState = {
	isStreaming: true,
	queuedMessageCount: 2,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};

function prompt(id: string, text: string, synthetic = false): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-12T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1, synthetic },
	} as SessionEntry;
}

const PR: PromptMention = { kind: "pr", number: 123, title: "Fix the thing", url: "https://github.com/o/r/pull/123" };
const SESSION: PromptMention = { kind: "session", id: "abcd1234-5678", title: "Refactor auth" };

describe("queue edit frames", () => {
	it("reads the ids of the queued follow-ups from state and sends edit, move and steer by id", () => {
		const sent: GuestFrame[] = [];
		const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame: GuestFrame) => {
			sent.push(frame);
		});
		try {
			const client = new GuestClient(WRITE_LINK, "tester");
			client.applyFrameForTest({
				t: "welcome",
				proto: COLLAB_PROTO,
				header: { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" },
				state: STATE,
				agents: [],
				entryCount: 0,
				features: ["follow-up", "queue-edit"],
			} satisfies HostFrame);
			expect(client.getSnapshot().followUpIds).toEqual([]);
			client.applyFrameForTest({
				t: "state",
				state: { ...STATE, followUps: ["one", "two"], followUpIds: ["qa", "qb"] },
			});
			expect(client.getSnapshot().followUpIds).toEqual(["qa", "qb"]);

			sent.length = 0;
			client.editQueuedFollowUp("qa", "one, edited", [PR]);
			client.moveQueuedFollowUp("qb", 0);
			client.steerQueuedFollowUp("qa");
			expect(sent).toEqual([
				{ t: "session-cmd", cmd: "queue-edit", id: "qa", arg: "one, edited", mentions: [PR] },
				{ t: "session-cmd", cmd: "queue-move", id: "qb", index: 0 },
				{ t: "session-cmd", cmd: "queue-steer", id: "qa" },
			]);
		} finally {
			sendSpy.mockRestore();
		}
	});
});

describe("mentions", () => {
	it("offers # for pull requests and @ for sessions only where a word starts, never for a path or address", () => {
		expect(activeMention("fix #1", 6)).toMatchObject({ kind: "pr", query: "1", start: 4, end: 6 });
		expect(activeMention("see @auth", 9)).toMatchObject({ kind: "session", query: "auth" });
		expect(activeMention("see @src/app.ts", 15)).toBeNull();
		expect(activeMention("a#1", 3)).toBeNull();
		expect(activeMention("me@host", 7)).toBeNull();
	});

	it("replaces the typed query with the token and lands the caret after it", () => {
		const at = activeMention("fix #1 now", 6);
		expect(at).not.toBeNull();
		if (at === null) return;
		expect(applyMention("fix #1 now", at, PR)).toEqual({ text: "fix #123 now", caret: 9 });
		const typed = activeMention("ask @ref", 8);
		if (typed === null) return;
		expect(applyMention("ask @ref", typed, SESSION).text).toBe("ask @session:abcd1234 ");
	});

	it("resolves the tokens a draft still carries, once each, and ignores unknown ones", () => {
		const text = "review #123 and #123, see @session:abcd1234 and #9";
		expect(resolveMentions(text, [PR, SESSION])).toEqual([PR, SESSION]);
		expect(resolveMentions("no tokens", [PR, SESSION])).toEqual([]);
		expect(resolveMentions("deleted #123", [])).toEqual([]);
	});

	it("ranks an exact number first and filters by title", () => {
		const prs = [
			{ number: 12, title: "Docs", url: "" },
			{ number: 1, title: "Cache", url: "" },
			{ number: 120, title: "Other", url: "" },
		];
		expect(matchPrs(prs, "12").map(pr => pr.number)).toEqual([12, 120]);
		expect(matchPrs(prs, "cache").map(pr => pr.number)).toEqual([1]);
		expect(matchSessions([{ id: "abcd1234", title: "Auth", folder: "/w/api" }], "api")).toHaveLength(1);
	});

	it("finds pull request links in the conversation, newest first", () => {
		const found = prsInTexts(["opened https://github.com/o/r/pull/5", "and https://github.com/o/r/pull/9/files"]);
		expect(found.map(pr => pr.number)).toEqual([9, 5]);
	});

	it("removes the context block the host appended and nothing else", () => {
		const sent = "look at #123\n\n<referenced-context>\n- PR #123\n</referenced-context>";
		expect(stripMentionContext(sent)).toBe("look at #123");
		expect(stripMentionContext("a <referenced-context> mid-text b")).toBe("a <referenced-context> mid-text b");
	});
});

describe("prompt recall", () => {
	const history = ["first", "second", "third"];

	it("walks back from an empty box and forward again to the draft that was there", () => {
		const caret = { start: 0, end: 0 };
		let step = recallStep(history, NOT_RECALLING, "older", "", caret);
		expect(step?.text).toBe("third");
		step = recallStep(history, step?.state ?? NOT_RECALLING, "older", "third", caret);
		expect(step?.text).toBe("second");
		step = recallStep(history, step?.state ?? NOT_RECALLING, "newer", "second", caret);
		expect(step?.text).toBe("third");
		step = recallStep(history, step?.state ?? NOT_RECALLING, "newer", "third", caret);
		expect(step).toEqual({ text: "", state: NOT_RECALLING });
	});

	it("starts only on an empty box, stops at the oldest, and gives up once the text was edited", () => {
		expect(recallStep(history, NOT_RECALLING, "older", "draft", { start: 0, end: 0 })).toBeNull();
		expect(recallStep([], NOT_RECALLING, "older", "", { start: 0, end: 0 })).toBeNull();
		expect(recallStep(history, { index: 0, draft: "" }, "older", "first", { start: 0, end: 0 })).toBeNull();
		expect(recallStep(history, { index: 1, draft: "" }, "older", "second, changed", { start: 0, end: 0 })).toBeNull();
	});

	it("leaves ↑/↓ to the caret inside a multi-line recalled prompt", () => {
		const multi = ["a\nb"];
		const state = { index: 0, draft: "" };
		expect(recallStep(multi, state, "older", "a\nb", { start: 2, end: 2 })).toBeNull();
		expect(recallStep(multi, state, "newer", "a\nb", { start: 0, end: 0 })).toBeNull();
		expect(recallStep(multi, state, "newer", "a\nb", { start: 3, end: 3 })?.text).toBe("");
	});

	it("lists what was typed: not injected prompts, repeats in a row, or the mention context", () => {
		const entries = [
			prompt("1", "build it"),
			prompt("2", "build it"),
			prompt("3", "[auto] nudge", true),
			prompt("4", "see #123\n\n<referenced-context>\n- x\n</referenced-context>"),
		];
		expect(promptHistory(entries)).toEqual(["build it", "see #123"]);
	});
});

describe("large paste", () => {
	it("turns only text over 32 KiB of UTF-8 into an attachment", () => {
		expect(LARGE_PASTE_BYTES).toBe(32768);
		expect(isLargePaste("a".repeat(LARGE_PASTE_BYTES))).toBe(false);
		expect(isLargePaste("a".repeat(LARGE_PASTE_BYTES + 1))).toBe(true);
		// 16385 two-byte characters are 32770 bytes in 16385 UTF-16 units.
		expect(isLargePaste("é".repeat(LARGE_PASTE_BYTES / 2 + 1))).toBe(true);
		expect(isLargePaste("é".repeat(LARGE_PASTE_BYTES / 2))).toBe(false);
	});

	it("names pasted files apart", async () => {
		expect(pastedTextFile("x", 1).name).not.toBe(pastedTextFile("x", 2).name);
		expect(await pastedTextFile("hello", 1).text()).toBe("hello");
	});
});

describe("draft stash", () => {
	const draft = (id: string, text: string): StashedDraft => ({ id, text, at: 1 });

	it("puts the newest first, moves a repeated draft to the top and ignores blanks", () => {
		let drafts = pushStash([], "one", "a", 1);
		drafts = pushStash(drafts, "two", "b", 2);
		drafts = pushStash(drafts, "one", "c", 3);
		expect(drafts.map(d => d.text)).toEqual(["one", "two"]);
		expect(pushStash(drafts, "  \n", "d", 4)).toEqual(drafts);
	});

	it("keeps the most recent drafts up to the cap", () => {
		let drafts: StashedDraft[] = Array.from({ length: MAX_STASHED }, (_, i) => draft(`id${i}`, `text ${i}`));
		drafts = pushStash(drafts, "newest", "n", 9);
		expect(drafts).toHaveLength(MAX_STASHED);
		expect(drafts[0]?.text).toBe("newest");
		expect(drafts.at(-1)?.text).toBe(`text ${MAX_STASHED - 2}`);
	});
});
