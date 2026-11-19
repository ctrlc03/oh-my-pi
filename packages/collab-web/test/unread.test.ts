import { describe, expect, it } from "bun:test";
import type { CompanionHost, InboxItem } from "../src/lib/companion";
import { hostKey, inboxKey } from "../src/lib/inbox";
import { seenKeys, unreadLabel, unreadSessions, unreadTotal } from "../src/lib/unread";

function host(instanceId: string, over: Partial<CompanionHost> = {}): CompanionHost {
	return {
		instanceId,
		sessionId: `s-${instanceId}`,
		sessionName: instanceId,
		cwd: `/work/${instanceId}`,
		model: null,
		startedAt: 1,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

function done(instanceId: string, at: number): InboxItem {
	return { instanceId, title: instanceId, cwd: `/work/${instanceId}`, kind: "done", text: "Done.", at };
}

describe("unreadSessions", () => {
	it("counts a waiting session from the hosts frame and a finished one from the Inbox answer", () => {
		const unread = unreadSessions(
			[
				{
					computerId: "c",
					hosts: [host("a", { inputRequired: true }), host("b"), host("c")],
					asleep: [],
					done: [done("b", 10)],
				},
			],
			new Set(),
		);
		expect(unread.get(hostKey("c", "a"))).toEqual({ computerId: "c", instanceId: "a", count: 1, needsInput: true });
		expect(unread.get(hostKey("c", "b"))).toEqual({ computerId: "c", instanceId: "b", count: 1, needsInput: false });
		expect(unread.has(hostKey("c", "c"))).toBe(false);
	});

	it("drops a finished turn that was dismissed, and one a new turn made stale", () => {
		const item = done("b", 10);
		const sources = (hosts: CompanionHost[]) => [{ computerId: "c", hosts, asleep: [], done: [item, done("d", 5)] }];
		expect(unreadSessions(sources([host("b")]), new Set([inboxKey("c", item)])).has(hostKey("c", "b"))).toBe(false);
		expect(unreadSessions(sources([host("b", { busy: true })]), new Set()).has(hostKey("c", "b"))).toBe(false);
		expect(unreadSessions(sources([host("b", { busy: null })]), new Set()).has(hostKey("c", "b"))).toBe(false);
	});

	it("keeps the finished turn of a hibernated session unread until it is dismissed", () => {
		const item = done("h", 10);
		const sources = [{ computerId: "c", hosts: [host("a")], asleep: ["h", "quiet"], done: [item] }];
		expect(unreadSessions(sources, new Set()).get(hostKey("c", "h"))).toEqual({
			computerId: "c",
			instanceId: "h",
			count: 1,
			needsInput: false,
		});
		expect(unreadSessions(sources, new Set()).has(hostKey("c", "quiet"))).toBe(false);
		expect(unreadSessions(sources, new Set([inboxKey("c", item)])).has(hostKey("c", "h"))).toBe(false);
	});

	it("keeps a computer's items to its own sessions, and leaves the Personal session to its Personal items", () => {
		const unread = unreadSessions(
			[
				{ computerId: "one", hosts: [host("a")], asleep: [], done: [done("a", 10)] },
				{
					computerId: "two",
					hosts: [host("a"), host("p", { inputRequired: true, personal: true })],
					asleep: [],
					done: [],
				},
			],
			new Set(),
		);
		expect([...unread.keys()]).toEqual([hostKey("one", "a")]);
	});

	it("sums per computer, so the card and the sidebar agree with their own Inbox button", () => {
		const unread = unreadSessions(
			[
				{
					computerId: "one",
					hosts: [host("a", { inputRequired: true }), host("b")],
					asleep: [],
					done: [done("b", 1)],
				},
				{ computerId: "two", hosts: [host("a", { inputRequired: true })], asleep: [], done: [] },
			],
			new Set(),
		);
		expect(unreadTotal(unread, ["one"])).toBe(2);
		expect(unreadTotal(unread, ["one", "two"])).toBe(3);
		expect(unreadTotal(unread, [])).toBe(0);
	});
});

describe("seenKeys", () => {
	it("names the undismissed finished turns of the sessions on screen only", () => {
		const items = [done("a", 1), done("b", 2), done("c", 3)];
		const viewing = new Set([hostKey("c1", "a"), hostKey("c1", "c")]);
		const keys = seenKeys("c1", items, viewing, new Set([inboxKey("c1", items[2]!)]));
		expect(keys).toEqual([inboxKey("c1", items[0]!)]);
	});

	it("ignores a session on another computer with the same instance id", () => {
		expect(seenKeys("c1", [done("a", 1)], new Set([hostKey("c2", "a")]), new Set())).toEqual([]);
	});
});

describe("unreadLabel", () => {
	it("reads as a count, with the urgency when the session waits", () => {
		expect(unreadLabel({ count: 3, needsInput: false })).toBe("3 unread updates");
		expect(unreadLabel({ count: 1, needsInput: false })).toBe("1 unread update");
		expect(unreadLabel({ count: 1, needsInput: true })).toBe("1 unread update, needs input");
	});
});
