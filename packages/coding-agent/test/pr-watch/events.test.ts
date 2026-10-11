/**
 * PR watching, pure parts: what successive readings of a pull request mean (`diffPr`), and when
 * the agent may be woken for them (`PrWakeQueue`).
 */
import { describe, expect, it } from "bun:test";
import {
	diffPr,
	type PrCheck,
	type PrEvent,
	type PrFeedback,
	type PrSeen,
	type PrSnapshot,
	PrWakeQueue,
	parseGhApiResponse,
	parsePrRef,
	reviewVerdict,
} from "@oh-my-pi/pi-wire/pr-watch";

const check = (name: string, state: PrCheck["state"], required = true): PrCheck => ({ name, state, url: "", required });

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
	return {
		repo: "acme/app",
		number: 7,
		url: "https://github.com/acme/app/pull/7",
		title: "Add widgets",
		state: "open",
		draft: false,
		headSha: "aaa",
		baseRef: "main",
		mergeable: "mergeable",
		checks: [check("build", "passing")],
		feedback: [],
		...over,
	};
}

function feedback(id: string, author: string, over: Partial<PrFeedback> = {}): PrFeedback {
	return { id, kind: "comment", author, body: "please fix", url: "", at: "2026-01-01T00:00:00Z", ...over };
}

/** Feed readings through `diffPr` the way a poller does; the events of each. */
function replay(readings: PrSnapshot[], self = "me"): PrEvent[][] {
	let seen: PrSeen | undefined;
	return readings.map(reading => {
		const result = diffPr(seen, reading, self);
		seen = result.seen;
		return result.events;
	});
}

const kinds = (events: PrEvent[]): string[] => events.map(event => event.kind);

describe("diffPr", () => {
	it("reads the first sighting as a baseline, even when checks already failed", () => {
		const [first] = replay([
			snapshot({
				checks: [check("test", "failing")],
				mergeable: "conflicting",
				feedback: [feedback("comment:1", "bob")],
			}),
		]);
		expect(first).toEqual([]);
	});

	it("reports a required check that fails once the gating checks settle, naming it", () => {
		const events = replay([
			snapshot({ checks: [check("build", "passing"), check("test", "pending")] }),
			snapshot({ checks: [check("build", "passing"), check("test", "pending")] }),
			snapshot({ checks: [check("build", "passing"), check("test", "failing")] }),
			snapshot({ checks: [check("build", "passing"), check("test", "failing")] }),
		]);
		expect(events.map(kinds)).toEqual([[], [], ["checks-failed"], []]);
		const failed = events[2]?.[0];
		expect(failed?.kind === "checks-failed" && failed.failed.map(item => item.name)).toEqual(["test"]);
	});

	it("waits for pending required checks before reporting a failure among them", () => {
		const events = replay([
			snapshot({ checks: [check("build", "pending"), check("test", "pending")] }),
			snapshot({ checks: [check("build", "pending"), check("test", "failing")] }),
			snapshot({ checks: [check("build", "failing"), check("test", "failing")] }),
		]);
		expect(events.map(kinds)).toEqual([[], [], ["checks-failed"]]);
	});

	it("ignores failing checks that are not required when the base branch names its required ones", () => {
		const events = replay([
			snapshot({ checks: [check("build", "pending"), check("lint", "pending", false)] }),
			snapshot({ checks: [check("build", "passing"), check("lint", "failing", false)] }),
		]);
		expect(events.map(kinds)).toEqual([[], ["checks-green"]]);
	});

	it("reports a failure again after a push, and green once they pass", () => {
		const events = replay([
			snapshot({ checks: [check("test", "pending")] }),
			snapshot({ checks: [check("test", "failing")] }),
			snapshot({ headSha: "bbb", checks: [check("test", "pending")] }),
			snapshot({ headSha: "bbb", checks: [check("test", "failing")] }),
			snapshot({ headSha: "ccc", checks: [check("test", "pending")] }),
			snapshot({ headSha: "ccc", checks: [check("test", "passing")] }),
			snapshot({ headSha: "ccc", checks: [check("test", "passing")] }),
		]);
		expect(events.map(kinds)).toEqual([[], ["checks-failed"], [], ["checks-failed"], [], ["checks-green"], []]);
	});

	it("reports feedback from others once, never one's own", () => {
		const mine = feedback("comment:1", "me");
		const theirs = feedback("comment:2", "bob");
		const review = feedback("review:3", "carol", { kind: "review", reviewState: "CHANGES_REQUESTED" });
		const events = replay([
			snapshot(),
			snapshot({ feedback: [mine, theirs] }),
			snapshot({ feedback: [mine, theirs, review] }),
			snapshot({ feedback: [mine, theirs, review] }),
		]);
		expect(events.map(kinds)).toEqual([[], ["feedback"], ["feedback"], []]);
		const first = events[1]?.[0];
		expect(first?.kind === "feedback" && first.items.map(item => item.id)).toEqual(["comment:2"]);
		const second = events[2]?.[0];
		expect(second?.kind === "feedback" && second.items.map(item => item.id)).toEqual(["review:3"]);
	});

	it("reports a merge conflict when it appears and again when it returns", () => {
		const events = replay([
			snapshot(),
			snapshot({ mergeable: "conflicting" }),
			snapshot({ mergeable: "conflicting" }),
			snapshot({ mergeable: "unknown" }),
			snapshot({ mergeable: "mergeable" }),
			snapshot({ mergeable: "conflicting" }),
		]);
		expect(events.map(kinds)).toEqual([[], ["conflict"], [], [], [], ["conflict"]]);
	});

	it("reports merged and closed once and nothing else once the pull request is finished", () => {
		expect(replay([snapshot(), snapshot({ state: "merged" }), snapshot({ state: "merged" })]).map(kinds)).toEqual([
			[],
			["merged"],
			[],
		]);
		expect(
			replay([snapshot(), snapshot({ state: "closed", checks: [check("test", "failing")] })]).map(kinds),
		).toEqual([[], ["closed"]]);
		expect(replay([snapshot({ state: "merged" })]).map(kinds)).toEqual([["merged"]]);
	});
});

describe("reviewVerdict", () => {
	it("takes each reviewer's latest verdict, changes requested beating approved", () => {
		expect(
			reviewVerdict([
				{ author: "a", state: "CHANGES_REQUESTED" },
				{ author: "a", state: "APPROVED" },
			]),
		).toBe("approved");
		expect(
			reviewVerdict([
				{ author: "a", state: "APPROVED" },
				{ author: "b", state: "CHANGES_REQUESTED" },
			]),
		).toBe("changes-requested");
		expect(reviewVerdict([{ author: "a", state: "COMMENTED" }])).toBeUndefined();
	});
});

describe("parsePrRef", () => {
	it("reads URLs and owner/repo#N, and nothing else", () => {
		expect(parsePrRef("https://github.com/acme/app/pull/7/files")).toEqual({ repo: "acme/app", number: 7 });
		expect(parsePrRef("acme/app#7")).toEqual({ repo: "acme/app", number: 7 });
		expect(parsePrRef("#7")).toBeUndefined();
		expect(parsePrRef("https://github.com/acme/app/issues/7")).toBeUndefined();
	});
});

describe("parseGhApiResponse", () => {
	it("reads the status, the ETag and the body of `gh api --include`", () => {
		const out = 'HTTP/2.0 200 OK\nEtag: W/"abc"\nContent-Type: application/json\n\n{"number":7}';
		expect(parseGhApiResponse(out)).toEqual({ status: 200, etag: 'W/"abc"', body: { number: 7 } });
		expect(parseGhApiResponse('HTTP/2.0 304 Not Modified\nEtag: W/"abc"\n\n')).toEqual({
			status: 304,
			etag: 'W/"abc"',
			body: undefined,
		});
		expect(parseGhApiResponse("gh: not logged in")).toBeUndefined();
	});
});

describe("PrWakeQueue", () => {
	const failed: PrEvent = { kind: "checks-failed", failed: [check("test", "failing")], headSha: "aaa" };
	const comment: PrEvent = { kind: "feedback", items: [feedback("comment:1", "bob")] };
	const HOUR = 60 * 60 * 1000;

	it("never wakes while the agent is busy, and wakes once it is idle", () => {
		const queue = new PrWakeQueue(
			() => 3,
			() => 0,
		);
		queue.push("a/b#1", [failed]);
		expect(queue.take(true)).toEqual([]);
		expect(queue.pending).toBe(1);
		const due = queue.take(false);
		expect(due.map(wake => wake.key)).toEqual(["a/b#1"]);
		expect(queue.pending).toBe(0);
	});

	it("does not queue events that only notify", () => {
		const queue = new PrWakeQueue(
			() => 3,
			() => 0,
		);
		queue.push("a/b#1", [{ kind: "checks-green", headSha: "aaa" }, { kind: "merged" }]);
		expect(queue.pending).toBe(0);
	});

	it("limits wakes per pull request per hour and releases the rest when the hour passes", () => {
		let now = 0;
		const queue = new PrWakeQueue(
			() => 2,
			() => now,
		);
		const wake = (): string[] => queue.take(false).map(item => item.key);
		for (let round = 0; round < 2; round++) {
			queue.push("a/b#1", [failed]);
			expect(wake()).toEqual(["a/b#1"]);
			now += 60_000;
		}
		queue.push("a/b#1", [failed]);
		queue.push("a/b#2", [failed]);
		expect(wake()).toEqual(["a/b#2"]);
		expect(queue.has("a/b#1")).toBe(true);
		now += 60_000;
		expect(wake()).toEqual([]);
		now = HOUR + 1;
		expect(wake()).toEqual(["a/b#1"]);
	});

	it("delivers the events of one pull request together as one wake", () => {
		const queue = new PrWakeQueue(
			() => 1,
			() => 0,
		);
		queue.push("a/b#1", [failed]);
		queue.push("a/b#1", [comment]);
		queue.push("a/b#1", [{ kind: "feedback", items: [feedback("comment:2", "carol")] }]);
		const due = queue.take(false);
		expect(due).toHaveLength(1);
		expect(kinds(due[0]!.events)).toEqual(["checks-failed", "feedback"]);
		const merged = due[0]!.events[1];
		expect(merged?.kind === "feedback" && merged.items.map(item => item.id)).toEqual(["comment:1", "comment:2"]);
	});

	it("drops what a push, a green run, a merge or a close made moot", () => {
		const queue = new PrWakeQueue(
			() => 3,
			() => 0,
		);
		queue.push("a/b#1", [failed, { kind: "conflict" }]);
		queue.supersede("a/b#1", "bbb");
		expect(queue.has("a/b#1")).toBe(false);
		queue.push("a/b#1", [failed, comment]);
		queue.push("a/b#1", [{ kind: "checks-green", headSha: "bbb" }]);
		expect(kinds(queue.take(false)[0]!.events)).toEqual(["feedback"]);
		queue.push("a/b#1", [failed, comment]);
		queue.push("a/b#1", [{ kind: "merged" }]);
		expect(queue.has("a/b#1")).toBe(false);
	});
});
