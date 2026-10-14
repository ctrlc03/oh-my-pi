import { describe, expect, it } from "bun:test";
import type { PersonalEventStatus, PersonalInboxItem, PersonalProposal } from "@oh-my-pi/pi-wire/personal";
import {
	alertTone,
	answerText,
	DECIDED_STATUSES,
	decisionText,
	digestMeta,
	EVENT_KIND,
	EVENT_STATUS,
	EVENT_TRUST,
	eventKind,
	eventStatus,
	evidenceLabel,
	INBOX_KIND_LABEL,
	inboxDimmed,
	inboxNeeds,
	mergeNewest,
	PROPOSAL_STATUS,
	proposalRows,
	proposalTitle,
	proposalWhen,
	webUrl,
} from "../src/lib/personal-activity";

const item = (over: Partial<PersonalInboxItem>): PersonalInboxItem => ({
	id: "in-1",
	kind: "info",
	title: "t",
	body: "",
	at: 1,
	origin: "agent",
	state: "open",
	...over,
});

describe("proposalTitle", () => {
	it("says what the proposal does in words", () => {
		expect(proposalTitle({ op: "add", section: "How I like to work" })).toBe("Add to How I like to work");
		expect(proposalTitle({ op: "replace", section: "Hard rules" })).toBe("Replace a line in Hard rules");
		expect(proposalTitle({ op: "remove", section: "Hard rules" })).toBe("Remove a line from Hard rules");
	});

	it("names About you when the section is not known", () => {
		expect(proposalTitle({ op: "replace" })).toBe("Replace a line in About you");
		expect(proposalTitle({ op: "add", section: "  " })).toBe("Add to About you");
	});
});

describe("proposal statuses", () => {
	it("words every status, and the decided ones are exactly the non-pending", () => {
		expect(Object.keys(PROPOSAL_STATUS).sort()).toEqual(["accepted", "pending", "rejected", "superseded"]);
		expect([...DECIDED_STATUSES].sort()).toEqual(["accepted", "rejected", "superseded"]);
		expect(PROPOSAL_STATUS.accepted.label).toBe("Accepted");
	});

	it("dates a decided proposal by its decision", () => {
		expect(proposalWhen({ at: 10, decidedAt: 50 })).toBe(50);
		expect(proposalWhen({ at: 10 })).toBe(10);
	});
});

describe("evidenceLabel", () => {
	it("counts the memories a proposal rests on", () => {
		expect(evidenceLabel(0)).toBeNull();
		expect(evidenceLabel(1)).toBe("based on 1 memory");
		expect(evidenceLabel(3)).toBe("based on 3 memories");
	});
});

describe("proposalRows", () => {
	const base: Pick<PersonalProposal, "op" | "target" | "text" | "diff"> = {
		op: "replace",
		target: "old line",
		text: "new line",
		diff: [],
	};

	it("uses the companion's diff, collapsing far-away unchanged lines", () => {
		const keeps = Array.from({ length: 8 }, (_, i) => ({ op: "keep" as const, text: `k${i}` }));
		const rows = proposalRows({ ...base, diff: [...keeps, { op: "add", text: "new line" }, ...keeps] });
		expect(rows.map(r => r.marker).join("")).toBe("  +  ");
		expect(rows[2]?.word).toBe("Added");
	});

	it("shows what a proposal said when the companion could not place it", () => {
		expect(proposalRows(base).map(r => `${r.marker}${r.text}`)).toEqual(["\u2212old line", "+new line"]);
		expect(proposalRows({ op: "add", text: "a", diff: [] }).map(r => r.marker)).toEqual(["+"]);
		expect(proposalRows({ op: "remove", target: "gone", text: "", diff: [] }).map(r => r.word)).toEqual(["Removed"]);
	});
});

describe("mergeNewest", () => {
	const row = (id: string, at: number, mark = "") => ({ id, at, mark });

	it("merges lists newest first and keeps the first copy of an id", () => {
		const merged = mergeNewest(
			r => r.at,
			[row("a", 5, "fresh"), row("b", 3)],
			[row("a", 5, "stale"), row("c", 9), row("d", 1)],
		);
		expect(merged.map(r => r.id)).toEqual(["c", "a", "b", "d"]);
		expect(merged.find(r => r.id === "a")?.mark).toBe("fresh");
	});

	it("orders decided proposals by their decision", () => {
		const decided = (id: string, at: number, decidedAt: number) => ({ id, at, decidedAt });
		const merged = mergeNewest(proposalWhen, [decided("x", 1, 30)], [decided("y", 20, 25)]);
		expect(merged.map(r => r.id)).toEqual(["x", "y"]);
	});
});

describe("event tables", () => {
	const statuses: PersonalEventStatus[] = [
		"queued",
		"delivered",
		"rate-limited",
		"refused",
		"expired",
		"failed",
		"capped",
	];

	it("has words and a tone for every status", () => {
		expect(Object.keys(EVENT_STATUS).sort()).toEqual([...statuses].sort());
		expect(EVENT_STATUS.capped.label).toBe("Held: spend limit");
		expect(EVENT_STATUS["rate-limited"].label).toBe("Held back: too many");
		expect(EVENT_STATUS.refused.tone).toBe("bad");
		expect(EVENT_STATUS.delivered.tone).toBe("ok");
	});

	it("labels every kind and both trust levels", () => {
		expect(Object.keys(EVENT_KIND).sort()).toEqual([
			"about-updated",
			"answer",
			"control",
			"event",
			"poll",
			"rollover",
			"schedule",
		]);
		expect(EVENT_TRUST.owner.label).toBe("Owner");
		expect(EVENT_TRUST.external.label).toBe("External");
	});

	it("reads a status or kind from a newer companion as itself", () => {
		expect(eventStatus({ status: "capped" }).label).toBe("Held: spend limit");
		expect(eventStatus({ status: "paused" as PersonalEventStatus })).toEqual({ label: "paused", tone: "idle" });
		expect(eventKind({ kind: "poll" })).toBe("Source check");
		expect(eventKind({ kind: "mystery" as never })).toBe("mystery");
		expect(eventKind({ kind: "toString" as never })).toBe("toString");
	});
});

describe("webUrl", () => {
	it("links only web addresses", () => {
		expect(webUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
		expect(webUrl("http://example.com")).toBe("http://example.com/");
		expect(webUrl("javascript:alert(1)")).toBeNull();
		expect(webUrl("not a url")).toBeNull();
		expect(webUrl(undefined)).toBeNull();
	});
});

describe("digestMeta", () => {
	it("summarises the day, the cost and what it learned", () => {
		const digest = { day: "2027-01-31", costUsd: 0.1234, learned: ["a", "b", "c"], proposals: ["p"] };
		expect(digestMeta(digest)).toBe("2027-01-31 · $0.12 · learned 3 · proposed 1");
		expect(digestMeta({ ...digest, costUsd: 0.004 })).toContain("<$0.01");
		expect(digestMeta({ ...digest, costUsd: 0 })).toContain("$0.00");
	});
});

describe("inbox rows", () => {
	it("tags every kind", () => {
		expect(Object.keys(INBOX_KIND_LABEL).sort()).toEqual(["alert", "digest", "info", "proposal", "question"]);
	});

	it("colours an alert by what it says", () => {
		expect(alertTone("Personal agent: daily spend limit reached")).toBe("bad");
		expect(alertTone("Backup failed")).toBe("bad");
		expect(alertTone("Today's spend limit is at 86%")).toBe("warn");
	});

	it("words the owner's answer", () => {
		expect(answerText(item({ answer: { option: "Yes, go ahead", at: 1 } }))).toBe("You answered: Yes, go ahead");
		expect(answerText(item({ answer: { text: "Next week", at: 1 } }))).toBe("You answered: Next week");
		expect(answerText(item({}))).toBe("Answered");
	});

	it("reads a decided proposal item from the decision recorded on it", () => {
		expect(decisionText(item({ answer: { option: "Rejected", at: 1 } }))).toBe("Rejected");
		expect(decisionText(item({}))).toBe("Decided");
	});

	it("dims read items, but never one still waiting on an answer", () => {
		expect(inboxDimmed(item({ kind: "info", readAt: 5 }))).toBe(true);
		expect(inboxDimmed(item({ kind: "info" }))).toBe(false);
		expect(inboxDimmed(item({ kind: "question", state: "open", readAt: 5 }))).toBe(false);
		expect(inboxDimmed(item({ kind: "proposal", state: "open", readAt: 5 }))).toBe(false);
		expect(inboxDimmed(item({ kind: "question", state: "done", readAt: 5 }))).toBe(true);
	});

	it("asks for proposals and digests only when a row needs them", () => {
		expect(inboxNeeds([item({ kind: "info" }), item({ kind: "question" })])).toEqual({
			proposals: false,
			digests: false,
		});
		expect(inboxNeeds([item({ kind: "proposal", proposalId: "p1" })]).proposals).toBe(true);
		expect(inboxNeeds([item({ kind: "proposal", proposalId: "p1", state: "done" })]).proposals).toBe(false);
		expect(inboxNeeds([item({ kind: "digest", digestId: "d1", state: "done" })]).digests).toBe(true);
	});
});
