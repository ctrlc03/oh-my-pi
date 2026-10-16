import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PersonalAnswer, PersonalCall, PersonalChanged, PersonalRequest } from "@oh-my-pi/pi-wire/personal";
import { MAX_ABOUT_BYTES, PERSONAL_LOGIN_COMMAND } from "@oh-my-pi/pi-wire/personal";
import type { CompanionHost } from "../src/lib/companion";
import { type MockPersonal, type MockPersonalOptions, createMockPersonal } from "../scripts/mock-personal";

interface Harness {
	mock: MockPersonal;
	hosts: CompanionHost[];
	pushes: PersonalChanged[];
	hostChanges: () => number;
	ask<T extends PersonalRequest["t"]>(call: Extract<PersonalCall, { t: T }>): PersonalAnswer<T>;
	/** Runs the callbacks the mock scheduled, shortest delay first. */
	flush(): void;
}

const made: MockPersonal[] = [];

afterEach(() => {
	for (const mock of made.splice(0)) mock.dispose();
});

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function harness(over: Partial<MockPersonalOptions> = {}): Harness {
	const hosts: CompanionHost[] = [];
	const pushes: PersonalChanged[] = [];
	const timers: { fn: () => void; ms: number }[] = [];
	let hostChanges = 0;
	let reqId = 100;
	const mock = createMockPersonal({
		hosts,
		machine: "laptop",
		computerId: "computer-1",
		login: "ready",
		setUp: true,
		broadcastFrame: frame => pushes.push(frame),
		onHostsChanged: () => {
			hostChanges++;
		},
		after: (fn, ms) => timers.push({ fn, ms }),
		now: () => NOW,
		...over,
	});
	made.push(mock);
	return {
		mock,
		hosts,
		pushes,
		hostChanges: () => hostChanges,
		ask: <T extends PersonalRequest["t"]>(call: Extract<PersonalCall, { t: T }>): PersonalAnswer<T> => {
			// The spread of one member of the union loses the pairing of `t` with its fields.
			const request = { ...call, reqId: ++reqId } as PersonalRequest;
			const reply = mock.answer(request);
			expect(reply.t).toBe(call.t);
			expect("reqId" in reply && reply.reqId).toBe(reqId);
			// `answer` returns the reply of the request's type.
			return reply as PersonalAnswer<T>;
		},
		flush() {
			const due = timers.splice(0).sort((a, b) => a.ms - b.ms);
			for (const timer of due) timer.fn();
		},
	};
}

/** One valid request per type: adding a request type to the wire breaks this table at compile time. */
const SAMPLES = {
	"personal-status": { t: "personal-status", reqId: 1 },
	"personal-setup": { t: "personal-setup", reqId: 2 },
	"personal-control": { t: "personal-control", reqId: 5, action: "restart" },
	"personal-backup-now": { t: "personal-backup-now", reqId: 40 },
	"personal-settings-get": { t: "personal-settings-get", reqId: 6 },
	"personal-settings-set": { t: "personal-settings-set", reqId: 7, patch: { limits: { dayUsd: 6 } } },
	"personal-memory-search": { t: "personal-memory-search", reqId: 8, query: { q: "landlord" } },
	"personal-memory-get": { t: "personal-memory-get", reqId: 9, id: "e:1" },
	"personal-memory-retract": { t: "personal-memory-retract", reqId: 10, id: "e:8" },
	"personal-memory-pin": { t: "personal-memory-pin", reqId: 11, id: "w:9" },
	"personal-memory-unpin": { t: "personal-memory-unpin", reqId: 12, id: "w:1" },
	"personal-memory-export": { t: "personal-memory-export", reqId: 13, format: "markdown" },
	"personal-about-get": { t: "personal-about-get", reqId: 14 },
	"personal-about-set": { t: "personal-about-set", reqId: 15, text: "# About you\n\n- Hello\n", baseRev: 3 },
	"personal-about-history": { t: "personal-about-history", reqId: 16, limit: 2 },
	"personal-proposals": { t: "personal-proposals", reqId: 17, status: "pending" },
	"personal-proposal-edit": { t: "personal-proposal-edit", reqId: 18, id: "prop-2", text: "A new line." },
	"personal-proposal-accept": { t: "personal-proposal-accept", reqId: 19, id: "prop-1" },
	"personal-proposal-reject": { t: "personal-proposal-reject", reqId: 20, id: "prop-4" },
	"personal-digests": { t: "personal-digests", reqId: 21, limit: 2 },
	"personal-digest-read": { t: "personal-digest-read", reqId: 22, id: "digest-2" },
	"personal-inbox": { t: "personal-inbox", reqId: 23, includeDone: true },
	"personal-inbox-ack": { t: "personal-inbox-ack", reqId: 24, ids: ["inbox-5"] },
	"personal-answer": { t: "personal-answer", reqId: 25, itemId: "inbox-1", option: "Not now" },
	"personal-events": { t: "personal-events", reqId: 26, limit: 3 },
	"personal-disable": { t: "personal-disable", reqId: 4 },
	"personal-enable": { t: "personal-enable", reqId: 3 },
} satisfies Record<PersonalRequest["t"], PersonalRequest>;

describe("every request type", () => {
	it("is answered with its own type and reqId", () => {
		const { mock } = harness();
		for (const [key, sample] of Object.entries(SAMPLES)) {
			expect(sample.t).toBe(key as keyof typeof SAMPLES);
			expect(mock.handles(sample)).toBe(true);
			const reply = mock.answer(sample);
			expect(reply.t).toBe(sample.t);
			expect("reqId" in reply && reply.reqId).toBe(sample.reqId);
		}
	});

	it("is not given other requests", () => {
		const { mock } = harness();
		expect(mock.handles({ t: "ping", reqId: 1 })).toBe(false);
	});

	it("answers reads on a mock that is not set up and refuses its writes", () => {
		const { ask, mock, hosts } = harness({ setUp: false });
		expect(mock.capabilities()).toEqual({ canPersonal: true, canPersonalChatTree: true });
		expect(ask({ t: "personal-status" }).status).toMatchObject({ setUp: false, enabled: false, run: "off" });
		expect(ask({ t: "personal-inbox" }).items).toEqual([]);
		expect(ask({ t: "personal-memory-search", query: {} })).toMatchObject({ items: [], total: 0 });
		expect(ask({ t: "personal-about-get" }).about).toMatchObject({ text: "", rev: 0 });
		expect(() => ask({ t: "personal-enable" })).toThrow("Set up the Personal agent first.");
		expect(() => ask({ t: "personal-about-set", text: "x", baseRev: 0 })).toThrow("Set up the Personal agent first.");
		expect(hosts).toEqual([]);
	});
});

describe("setup, login and the host row", () => {
	it("goes from fresh to a login that is missing to a running session", () => {
		const { ask, mock, hosts, pushes, flush, hostChanges } = harness({ setUp: false, login: "missing" });
		const status = ask({ t: "personal-setup" }).status;
		expect(status).toMatchObject({
			setUp: true,
			enabled: true,
			run: "stopped",
			session: null,
			homeComputer: { computerId: "computer-1", machine: "laptop" },
			login: { state: "missing", providers: [], command: PERSONAL_LOGIN_COMMAND },
			review: { skipped: "no-login" },
		});
		expect(status.error).toBeUndefined();
		expect(hosts).toEqual([]);
		expect(mock.capabilities()).toEqual({ canPersonal: true, canPersonalChatTree: true, personalRev: status.rev });
		const about = ask({ t: "personal-about-get" }).about;
		expect(about.rev).toBe(1);
		expect(about.text).toContain("## How I like to work");
		expect(ask({ t: "personal-about-history" }).versions).toMatchObject([{ rev: 1, by: "setup" }]);
		expect(pushes.at(-1)).toEqual({ t: "personal-changed", what: ["status", "about", "settings"], rev: status.rev });
		expect(hostChanges()).toBe(1);

		expect(() => ask({ t: "personal-control", action: "start" })).toThrow(PERSONAL_LOGIN_COMMAND);

		mock.completeLogin();
		expect(ask({ t: "personal-status" }).status.run).toBe("starting");
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({
			instanceId: "inst-personal",
			sessionName: "Personal",
			cwd: "/home/.omp/profiles/personal/workspace",
			personal: true,
		});
		flush();
		const running = ask({ t: "personal-status" }).status;
		expect(running).toMatchObject({
			run: "idle",
			login: { state: "ready", providers: ["anthropic"] },
			session: { sessionId: "personal-session-1", instanceId: "inst-personal", generation: 1 },
		});
		expect(running.review.skipped).toBeUndefined();
		mock.completeLogin();
		expect(ask({ t: "personal-status" }).status.rev).toBe(running.rev);
	});

	it("keeps personal: true across a restart, a stop and a disable, and removes the row", () => {
		const { ask, hosts, flush } = harness();
		expect(hosts).toHaveLength(1);
		expect(hosts[0]?.personal).toBe(true);
		const restarted = ask({ t: "personal-control", action: "restart" }).status;
		expect(restarted).toMatchObject({ run: "starting", session: { generation: 2, instanceId: "inst-personal-2" } });
		expect(hosts).toHaveLength(1);
		expect(hosts[0]).toMatchObject({
			instanceId: "inst-personal-2",
			sessionId: "personal-session-2",
			personal: true,
		});
		flush();
		expect(ask({ t: "personal-status" }).status.run).toBe("idle");
		expect(ask({ t: "personal-control", action: "stop" }).status).toMatchObject({ run: "stopped", session: null });
		expect(hosts).toEqual([]);
		expect(ask({ t: "personal-control", action: "start" }).status.run).toBe("starting");
		expect(hosts[0]).toMatchObject({ instanceId: "inst-personal-2", personal: true });
		flush();
		const off = ask({ t: "personal-disable" }).status;
		expect(off).toMatchObject({ enabled: false, run: "off", session: null, setUp: true });
		expect(hosts).toEqual([]);
		expect(() => ask({ t: "personal-control", action: "start" })).toThrow("The Personal agent is turned off.");
		expect(ask({ t: "personal-memory-search", query: {} }).total).toBe(22);
		expect(ask({ t: "personal-enable" }).status.run).toBe("starting");
		expect(hosts).toHaveLength(1);
	});

	it("ignores a second setup", () => {
		const { ask, pushes } = harness();
		const before = ask({ t: "personal-status" }).status;
		const count = pushes.length;
		const again = ask({ t: "personal-setup", about: "# Changed" }).status;
		expect(again.rev).toBe(before.rev);
		expect(pushes).toHaveLength(count);
		expect(ask({ t: "personal-about-get" }).about.rev).toBe(3);
	});

	it("takes the About text given at setup and refuses one that is too long", () => {
		const { ask } = harness({ setUp: false });
		expect(() => ask({ t: "personal-setup", about: "x".repeat(MAX_ABOUT_BYTES + 1) })).toThrow(
			"About you is too long.",
		);
		expect(ask({ t: "personal-status" }).status.setUp).toBe(false);
		ask({ t: "personal-setup", about: "# Me\n\n- Hello\n" });
		expect(ask({ t: "personal-about-get" }).about).toMatchObject({ text: "# Me\n\n- Hello\n", rev: 1, tokens: 4 });
	});

	it("starts the session by itself when the login file appears", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mock-personal-"));
		vi.useFakeTimers();
		try {
			const file = path.join(dir, "personal-login-ready");
			const { mock, hosts, flush } = harness({ login: "missing", loginFile: file });
			vi.advanceTimersByTime(4_000);
			expect(mock.state().run).toBe("stopped");
			await Bun.write(file, "");
			vi.advanceTimersByTime(2_000);
			expect(mock.state().login).toBe("ready");
			expect(hosts).toHaveLength(1);
			flush();
			expect(mock.state().run).toBe("idle");
		} finally {
			vi.useRealTimers();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("memory", () => {
	it("searches by words, origin, pins, validity and dates, newest first, with paging", () => {
		const { ask } = harness();
		const landlord = ask({ t: "personal-memory-search", query: { q: "LANDLORD" } });
		expect(landlord.items.map(m => m.id)).toEqual(["w:2", "w:7"]);
		expect(landlord.total).toBe(2);
		expect(ask({ t: "personal-memory-search", query: { q: "lease  landlord renewal" } }).total).toBe(2);
		expect(ask({ t: "personal-memory-search", query: { q: "lease gym" } }).total).toBe(0);

		const all = ask({ t: "personal-memory-search", query: { limit: 5 } });
		expect(all.total).toBe(22);
		expect(all.items).toHaveLength(5);
		const times = all.items.map(m => Date.parse(m.createdAt));
		expect(times).toEqual([...times].sort((a, b) => b - a));
		const page = ask({ t: "personal-memory-search", query: { limit: 5, offset: 5 } });
		expect(page.total).toBe(22);
		expect(page.items[0]?.id).not.toBe(all.items[0]?.id);

		const external = ask({ t: "personal-memory-search", query: { origin: ["external"] } });
		expect(external.items.length).toBeGreaterThan(0);
		expect(external.items.every(m => m.origin === "external" && m.trustTier === "UNTRUSTED")).toBe(true);
		expect(external.items.some(m => m.authorId === "external:github")).toBe(true);
		const owner = ask({ t: "personal-memory-search", query: { origin: ["owner", "agent"] } });
		expect(owner.items.some(m => m.origin === "external")).toBe(false);

		const pinned = ask({ t: "personal-memory-search", query: { pinnedOnly: true } });
		expect(pinned.items.map(m => m.id).sort()).toEqual(["e:4", "w:1"]);

		expect(ask({ t: "personal-memory-search", query: { q: "lisbon" } }).items.map(m => m.id)).toEqual(["w:8"]);
		const withInvalid = ask({ t: "personal-memory-search", query: { q: "lisbon", includeInvalid: true } });
		expect(withInvalid.items.map(m => m.id).sort()).toEqual(["e:10", "w:8"]);
		expect(ask({ t: "personal-memory-search", query: { includeInvalid: true } }).total).toBe(24);

		const first = all.items[0];
		expect(first).toBeDefined();
		const since = ask({ t: "personal-memory-search", query: { since: first?.createdAt } });
		expect(since.items.map(m => m.id)).toEqual([first?.id]);
		const until = ask({ t: "personal-memory-search", query: { until: first?.createdAt } });
		expect(until.total).toBe(22);
		expect(() => ask({ t: "personal-memory-search", query: { since: "last week" } })).toThrow("ISO 8601");
	});

	it("covers every origin and store, with the invalid and replaced ones", () => {
		const { mock } = harness();
		const rows = mock.state().memories;
		expect(rows).toHaveLength(24);
		expect(new Set(rows.map(m => m.origin))).toEqual(new Set(["owner", "agent", "external"]));
		expect(new Set(rows.map(m => m.store))).toEqual(new Set(["working", "episodic"]));
		expect(rows.find(m => m.id === "e:9")).toMatchObject({ invalid: true, invalidBy: "owner" });
		expect(rows.find(m => m.id === "e:10")).toMatchObject({ invalid: true, invalidBy: "agent", replacedBy: "e:1" });
		expect(rows.filter(m => m.pinned).map(m => m.id)).toEqual(["w:1", "e:4"]);
		expect(rows.every(m => m.id.startsWith("w:") === (m.store === "working"))).toBe(true);
	});

	it("gets a memory with the ones it replaced, and null for an unknown id", () => {
		const { ask } = harness();
		const got = ask({ t: "personal-memory-get", id: "e:1" });
		expect(got.memory?.id).toBe("e:1");
		expect(got.replaces.map(m => m.id)).toEqual(["e:10"]);
		expect(got.memory?.replacesCount).toBe(1);
		expect(ask({ t: "personal-memory-get", id: "e:nope" })).toMatchObject({ memory: null, replaces: [] });
	});

	it("retracts once, pins and unpins", () => {
		const { ask, pushes } = harness();
		const before = pushes.length;
		const retracted = ask({ t: "personal-memory-retract", id: "w:9" }).memory;
		expect(retracted).toMatchObject({ invalid: true, invalidBy: "owner" });
		expect(retracted.invalidAt).toBeDefined();
		expect(pushes).toHaveLength(before + 1);
		expect(pushes.at(-1)?.what).toEqual(["memory"]);
		const again = ask({ t: "personal-memory-retract", id: "w:9" }).memory;
		expect(again).toEqual(retracted);
		expect(pushes).toHaveLength(before + 1);
		expect(() => ask({ t: "personal-memory-retract", id: "w:99" })).toThrow("There is no such memory.");
		expect(() => ask({ t: "personal-memory-pin", id: "w:9" })).toThrow("A retracted memory cannot be pinned.");

		const pinned = ask({ t: "personal-memory-pin", id: "w:6" }).memory;
		expect(pinned).toMatchObject({ pinned: true, importance: 1 });
		const count = pushes.length;
		expect(ask({ t: "personal-memory-pin", id: "w:6" }).memory).toEqual(pinned);
		expect(pushes).toHaveLength(count);
		expect(ask({ t: "personal-memory-unpin", id: "w:6" }).memory).toMatchObject({ pinned: false, importance: 0.5 });
		expect(ask({ t: "personal-memory-unpin", id: "w:1" }).memory).toMatchObject({ pinned: false, importance: 0.8 });
	});

	it("exports every row, including invalid ones, in chunks that join back to the whole", () => {
		const { ask } = harness({ chunkChars: 97 });
		const parts: string[] = [];
		let offset: number | undefined;
		let guard = 0;
		for (;;) {
			const chunk = ask({
				t: "personal-memory-export",
				format: "json",
				...(offset === undefined ? {} : { offset }),
			});
			expect(chunk.name).toMatch(/^personal-memory-\d{4}-\d{2}-\d{2}\.json$/);
			expect(chunk.mime).toBe("application/json");
			expect(chunk.text.length).toBeLessThanOrEqual(97);
			parts.push(chunk.text);
			if (chunk.next === null) break;
			expect(chunk.next).toBe((offset ?? 0) + chunk.text.length);
			offset = chunk.next;
			expect(++guard).toBeLessThan(500);
		}
		expect(parts.length).toBeGreaterThan(10);
		const rows = JSON.parse(parts.join("")) as { id: string; invalid: boolean }[];
		expect(rows).toHaveLength(24);
		expect(
			rows
				.filter(m => m.invalid)
				.map(m => m.id)
				.sort(),
		).toEqual(["e:10", "e:9"]);
		expect(() => ask({ t: "personal-memory-export", format: "json", offset: 10_000_000 })).toThrow("out of range");

		const whole = harness();
		const json = whole.ask({ t: "personal-memory-export", format: "json" });
		expect(json.next).toBeNull();
		expect(json.text).toBe(parts.join(""));
		const markdown = whole.ask({ t: "personal-memory-export", format: "markdown" });
		expect(markdown).toMatchObject({ mime: "text/markdown", next: null });
		expect(markdown.name).toMatch(/\.md$/);
		expect(markdown.text).toContain("## w:1 (working, owner, pinned)");
	});

	it("never ends a chunk inside a surrogate pair", () => {
		const { ask, mock } = harness({ chunkChars: 1 });
		ask({ t: "personal-memory-retract", id: "w:9" });
		expect(mock.state().memories).toHaveLength(24);
		const chunk = ask({ t: "personal-memory-export", format: "markdown", offset: 0 });
		expect(chunk.text.length).toBe(1);
	});
});

describe("About you and proposals", () => {
	it("refuses a stale baseRev, saves a current one and keeps the history", () => {
		const { ask, pushes } = harness();
		const stale = ask({ t: "personal-about-set", text: "# Mine\n", baseRev: 2 });
		expect(stale.saved).toBe(false);
		expect(stale.about.rev).toBe(3);
		expect(stale.about.text).toContain("Squash-merge pull requests.");
		const count = pushes.length;
		const saved = ask({ t: "personal-about-set", text: "# Mine\n\n- Hello\n", baseRev: 3 });
		expect(saved).toMatchObject({ saved: true, about: { rev: 4, text: "# Mine\n\n- Hello\n", tokens: 4 } });
		expect(pushes).toHaveLength(count + 1);
		expect(pushes.at(-1)?.what).toEqual(["about"]);
		const history = ask({ t: "personal-about-history" }).versions;
		expect(history.map(v => [v.rev, v.by])).toEqual([
			[4, "owner"],
			[3, "proposal"],
			[2, "owner"],
			[1, "setup"],
		]);
		expect(history[1]?.proposalId).toBe("prop-5");
		expect(ask({ t: "personal-about-history", limit: 2 }).versions).toHaveLength(2);
		expect(() => ask({ t: "personal-about-set", text: "x".repeat(MAX_ABOUT_BYTES + 1), baseRev: 4 })).toThrow(
			"About you is too long.",
		);
		expect(ask({ t: "personal-about-get" }).about.rev).toBe(4);
	});

	it("lists pending proposals newest first with a diff against the current text", () => {
		const { ask } = harness();
		const pending = ask({ t: "personal-proposals" }).proposals;
		expect(pending.map(p => p.id)).toEqual(["prop-1", "prop-4", "prop-2"]);
		expect(pending.find(p => p.id === "prop-4")).toMatchObject({ fromExternal: true, op: "add" });
		expect(pending.find(p => p.id === "prop-4")?.rationale).toContain("<<<UNTRUSTED");
		const add = pending[0]?.diff ?? [];
		expect(add.filter(l => l.op === "add")).toEqual([
			{ op: "add", text: "- Review pull requests in the morning, before standup." },
		]);
		expect(add.filter(l => l.op === "del")).toEqual([]);
		expect(add.some(l => l.op === "keep" && l.text === "- Squash-merge pull requests.")).toBe(true);
		expect(add.filter(l => l.op === "keep").length).toBeLessThanOrEqual(6);
		const replace = pending.find(p => p.id === "prop-2")?.diff ?? [];
		expect(replace.filter(l => l.op === "del")).toEqual([
			{ op: "del", text: "- Migrating the billing service to the new invoice schema." },
		]);
		expect(replace.filter(l => l.op === "add")).toHaveLength(1);
		expect(ask({ t: "personal-proposals", status: "rejected" }).proposals.map(p => p.id)).toEqual(["prop-3"]);
		expect(ask({ t: "personal-proposals", status: "accepted" }).proposals.map(p => p.id)).toEqual(["prop-5"]);
		expect(ask({ t: "personal-proposals", status: "superseded" }).proposals).toEqual([]);
	});

	it("accepts an add under a section, a replace and a remove, and closes their inbox items", () => {
		const { ask, mock, pushes } = harness();
		expect(ask({ t: "personal-status" }).status.counts).toEqual({ questions: 1, proposals: 3, digests: 2 });

		const added = ask({ t: "personal-proposal-accept", id: "prop-1" });
		expect(added).toMatchObject({ applied: true, proposal: { status: "accepted" }, about: { rev: 4 } });
		const lines = added.about.text.split("\n");
		const squash = lines.indexOf("- Squash-merge pull requests.");
		expect(lines[squash + 1]).toBe("- Review pull requests in the morning, before standup.");
		expect(pushes.at(-1)).toMatchObject({ what: ["status", "inbox", "about", "proposals", "events"] });
		expect(mock.state().inbox.find(i => i.id === "inbox-2")).toMatchObject({ state: "done" });
		expect(ask({ t: "personal-about-history", limit: 1 }).versions[0]).toMatchObject({
			rev: 4,
			by: "proposal",
			proposalId: "prop-1",
		});

		ask({ t: "personal-proposal-edit", id: "prop-2", text: "  Migrating billing; backfill done in November.  " });
		const replaced = ask({ t: "personal-proposal-accept", id: "prop-2" });
		expect(replaced.applied).toBe(true);
		expect(replaced.proposal).toMatchObject({
			edited: true,
			status: "accepted",
			text: "Migrating billing; backfill done in November.",
		});
		expect(replaced.about.text).toContain("- Migrating billing; backfill done in November.");
		expect(replaced.about.text).not.toContain("new invoice schema.");

		const drafted = mock.agentPropose({
			op: "remove",
			target: "Never send an email or accept an invitation without asking me first.",
			rationale: "You said I may accept invitations from Ana.",
		});
		expect(drafted.diff.filter(l => l.op === "del")).toHaveLength(1);
		const removed = ask({ t: "personal-proposal-accept", id: drafted.id });
		expect(removed.applied).toBe(true);
		expect(removed.about.text).not.toContain("Never send an email");
		expect(removed.about.rev).toBe(6);
		expect(ask({ t: "personal-status" }).status.counts.proposals).toBe(1);
	});

	it("creates a missing section for an add and fills the empty bullet of an existing one", () => {
		const { ask, mock } = harness();
		const health = mock.agentPropose({
			op: "add",
			section: "Health",
			text: "Allergic to penicillin.",
			rationale: "Said so twice.",
		});
		expect(health.diff.filter(l => l.op === "add")).toEqual([
			{ op: "add", text: "" },
			{ op: "add", text: "## Health" },
			{ op: "add", text: "" },
			{ op: "add", text: "- Allergic to penicillin." },
		]);
		const accepted = ask({ t: "personal-proposal-accept", id: health.id });
		expect(accepted.about.text.endsWith("## Health\n\n- Allergic to penicillin.\n")).toBe(true);

		const fresh = harness({ setUp: false });
		fresh.ask({ t: "personal-setup" });
		const draft = fresh.mock.agentPropose({
			op: "add",
			section: "Hard rules",
			text: "Never book on Sundays.",
			rationale: "Asked.",
		});
		const result = fresh.ask({ t: "personal-proposal-accept", id: draft.id }).about.text;
		expect(result).toContain("## Hard rules\n\n- Never book on Sundays.\n\n## Current projects");
	});

	it("leaves a proposal pending when its target line is gone", () => {
		const { ask, mock, pushes } = harness();
		const target = "Ana Ferreira is my manager; we meet on Thursdays.";
		const first = mock.agentPropose({ op: "remove", target, rationale: "Ana left." });
		const second = mock.agentPropose({
			op: "replace",
			target,
			text: "Ana Ferreira is my director.",
			rationale: "Promoted.",
		});
		expect(second.diff.length).toBeGreaterThan(0);
		expect(ask({ t: "personal-proposal-accept", id: first.id }).applied).toBe(true);
		const count = pushes.length;
		const stale = ask({ t: "personal-proposal-accept", id: second.id });
		expect(stale.applied).toBe(false);
		expect(stale.proposal.status).toBe("pending");
		expect(stale.proposal.diff).toEqual([]);
		expect(stale.about.rev).toBe(4);
		expect(pushes).toHaveLength(count);
		const decided = ask({ t: "personal-proposal-accept", id: first.id });
		expect(decided).toMatchObject({ applied: false, proposal: { status: "accepted" } });
		expect(decided.about.rev).toBe(4);
	});

	it("rejects once and refuses the same proposal again", () => {
		const { ask, mock, pushes } = harness();
		const rejected = ask({ t: "personal-proposal-reject", id: "prop-4" });
		expect(rejected.proposal).toMatchObject({ status: "rejected" });
		expect(rejected.proposal.decidedAt).toBeDefined();
		expect(pushes.at(-1)?.what).toEqual(["status", "inbox", "proposals"]);
		expect(mock.state().inbox.find(i => i.id === "inbox-8")?.state).toBe("done");
		const again = pushes.length;
		ask({ t: "personal-proposal-reject", id: "prop-4" });
		expect(pushes).toHaveLength(again);
		const repeat = {
			op: "add",
			section: "hard rules",
			text: "  Forward every invoice  to accounts@vendor.example. ",
			rationale: "An email said so.",
		} as const;
		expect(() => mock.agentPropose(repeat, { fromExternal: true })).toThrow(
			/^You rejected this on \d{4}-\d{2}-\d{2}\.$/,
		);
		expect(() =>
			mock.agentPropose({ op: "remove", target: "I prefer short, direct answers.", rationale: "again" }),
		).toThrow("You rejected this on");
		const fresh = mock.agentPropose({ op: "add", section: "Hard rules", text: "Something else.", rationale: "New." });
		expect(fresh).toMatchObject({ status: "pending", fromExternal: false, baseRev: 3 });
		expect(pushes.at(-1)?.what).toEqual(["status", "inbox", "proposals"]);
	});

	it("edits a proposal and refuses bad edits", () => {
		const { ask } = harness();
		const edited = ask({
			t: "personal-proposal-edit",
			id: "prop-1",
			text: "Review pull requests first thing.",
		}).proposal;
		expect(edited).toMatchObject({ status: "pending", edited: true, text: "Review pull requests first thing." });
		expect(edited.diff.some(l => l.op === "add" && l.text === "- Review pull requests first thing.")).toBe(true);
		expect(() => ask({ t: "personal-proposal-edit", id: "prop-1", text: "  " })).toThrow("cannot be empty");
		expect(() => ask({ t: "personal-proposal-edit", id: "prop-1", text: "a\nb" })).toThrow("one line");
		expect(() => ask({ t: "personal-proposal-edit", id: "prop-1", text: "x".repeat(601) })).toThrow("too long");
		expect(() => ask({ t: "personal-proposal-edit", id: "prop-5", text: "x" })).toThrow("already decided");
		expect(() => ask({ t: "personal-proposal-edit", id: "prop-9", text: "x" })).toThrow("no such proposal");
	});
});

describe("inbox, digests, events and the push", () => {
	it("holds every kind of inbox item, newest first, done ones only on request", () => {
		const { ask } = harness();
		const open = ask({ t: "personal-inbox" }).items;
		expect(open.every(i => i.state === "open")).toBe(true);
		expect(new Set(open.map(i => i.kind))).toEqual(new Set(["question", "proposal", "digest", "alert", "info"]));
		expect(open.map(i => i.at)).toEqual(open.map(i => i.at).sort((a, b) => b - a));
		const question = open.find(i => i.id === "inbox-1");
		expect(question?.options).toEqual(["Yes, go ahead", "Not now", "Ask me tomorrow"]);
		expect(open.find(i => i.kind === "proposal")?.proposalId).toBeDefined();
		expect(open.find(i => i.kind === "digest")?.digestId).toBeDefined();
		const everything = ask({ t: "personal-inbox", includeDone: true }).items;
		expect(everything).toHaveLength(11);
		expect(everything.find(i => i.id === "inbox-6")).toMatchObject({ state: "done", answer: { option: "Yes" } });
		expect(ask({ t: "personal-inbox", includeDone: true, limit: 3 }).items).toHaveLength(3);
	});

	it("answers a question: working, then idle, then a reply that arrives as a push", () => {
		const { ask, hosts, pushes, flush, mock } = harness();
		const before = pushes.length;
		const item = ask({ t: "personal-answer", itemId: "inbox-1", option: "Yes, go ahead" }).item;
		expect(item).toMatchObject({ state: "done", answer: { option: "Yes, go ahead" } });
		expect(item.readAt).toBeDefined();
		const status = ask({ t: "personal-status" }).status;
		expect(status).toMatchObject({ run: "working", counts: { questions: 0 } });
		expect(hosts[0]?.busy).toBe(true);
		expect(pushes.slice(before).map(p => p.what)).toEqual([["status", "inbox", "events"]]);
		expect(mock.state().events.at(-1)).toMatchObject({
			source: "owner-answer",
			kind: "answer",
			trust: "owner",
			status: "delivered",
		});

		flush();
		expect(ask({ t: "personal-status" }).status.run).toBe("idle");
		expect(hosts[0]?.busy).toBe(false);
		const reply = ask({ t: "personal-inbox" }).items[0];
		expect(reply).toMatchObject({ kind: "info", title: "Got it", state: "open" });
		expect(pushes.slice(before).map(p => p.what)).toEqual([
			["status", "inbox", "events"],
			["status", "inbox"],
			["status"],
		]);
		for (const [at, push] of pushes.entries()) if (at > 0) expect(push.rev).toBe((pushes[at - 1]?.rev ?? 0) + 1);
		expect(pushes.at(-1)?.rev).toBe(ask({ t: "personal-status" }).status.rev);
	});

	it("does not wake the agent when it is not running, and refuses what is not a question", () => {
		const { ask, flush, mock } = harness();
		ask({ t: "personal-control", action: "stop" });
		ask({ t: "personal-answer", itemId: "inbox-1", text: "  later, please " });
		expect(ask({ t: "personal-status" }).status.run).toBe("stopped");
		flush();
		expect(mock.state().inbox.find(i => i.title === "Got it")).toBeUndefined();
		expect(mock.state().inbox.find(i => i.id === "inbox-1")?.answer).toMatchObject({ text: "later, please" });
		expect(mock.state().events.at(-1)?.status).toBe("queued");
		expect(() => ask({ t: "personal-answer", itemId: "inbox-5", option: "Yes" })).toThrow(
			"That item is not a question.",
		);
		expect(() => ask({ t: "personal-answer", itemId: "inbox-1", option: "Yes, go ahead" })).toThrow(
			"You already answered this.",
		);
		expect(() => ask({ t: "personal-answer", itemId: "inbox-nope", option: "Yes" })).toThrow("no such inbox item");
		expect(() => ask({ t: "personal-answer", itemId: "inbox-6" })).toThrow();
	});

	it("checks an answer against the options and demands one", () => {
		const { ask } = harness();
		expect(() => ask({ t: "personal-answer", itemId: "inbox-1" })).toThrow("Choose an answer or write one.");
		expect(() => ask({ t: "personal-answer", itemId: "inbox-1", option: "Maybe" })).toThrow(
			"not one of the answers offered",
		);
	});

	it("acknowledges items, closing info, alert and digest items and marking the digest read", () => {
		const { ask, pushes } = harness();
		const count = pushes.length;
		const acked = ask({ t: "personal-inbox-ack", ids: ["inbox-3", "inbox-5", "inbox-1", "inbox-unknown"] }).items;
		expect(acked.map(i => i.id)).toEqual(["inbox-1", "inbox-3", "inbox-5"]);
		expect(acked.every(i => i.readAt !== undefined)).toBe(true);
		expect(acked.find(i => i.id === "inbox-1")?.state).toBe("open");
		expect(acked.find(i => i.id === "inbox-3")?.state).toBe("done");
		expect(pushes).toHaveLength(count + 1);
		expect(pushes.at(-1)?.what).toEqual(["status", "inbox", "digests"]);
		expect(ask({ t: "personal-status" }).status.counts.digests).toBe(1);
		ask({ t: "personal-inbox-ack", ids: ["inbox-3", "inbox-5", "inbox-1"] });
		expect(pushes).toHaveLength(count + 1);
	});

	it("lists digests newest first and marks one read", () => {
		const { ask, pushes } = harness();
		const digests = ask({ t: "personal-digests" }).digests;
		expect(digests.map(d => d.id)).toEqual(["digest-3", "digest-2", "digest-1"]);
		expect(digests[0]).toMatchObject({ read: false, proposals: ["prop-1", "prop-2"], costUsd: 0.21 });
		expect(digests[0]?.learned.length).toBeGreaterThan(0);
		expect(digests[0]?.body).toContain("## Learned");
		expect(ask({ t: "personal-digests", limit: 1 }).digests.map(d => d.id)).toEqual(["digest-3"]);
		expect(ask({ t: "personal-digests", before: digests[0]?.at }).digests.map(d => d.id)).toEqual([
			"digest-2",
			"digest-1",
		]);
		const read = ask({ t: "personal-digest-read", id: "digest-3" }).digest;
		expect(read.read).toBe(true);
		expect(pushes.at(-1)?.what).toEqual(["status", "inbox", "digests"]);
		expect(ask({ t: "personal-status" }).status.counts.digests).toBe(1);
		const count = pushes.length;
		ask({ t: "personal-digest-read", id: "digest-3" });
		expect(pushes).toHaveLength(count);
		expect(() => ask({ t: "personal-digest-read", id: "digest-9" })).toThrow("no such digest");
	});

	it("lists events of every status newest first and pages by time", () => {
		const { ask } = harness();
		const events = ask({ t: "personal-events", limit: 100 }).events;
		expect(events.length).toBeGreaterThanOrEqual(8);
		expect(events.map(e => e.at)).toEqual(events.map(e => e.at).sort((a, b) => b - a));
		expect(new Set(events.map(e => e.status))).toEqual(
			new Set(["queued", "delivered", "rate-limited", "refused", "expired", "failed", "capped"]),
		);
		expect(new Set(events.map(e => e.source))).toEqual(
			new Set([
				"script:backup",
				"github",
				"schedule:morning-brief",
				"source:email",
				"owner-answer",
				"companion",
				"script:deploy",
			]),
		);
		expect(new Set(events.map(e => e.trust))).toEqual(new Set(["owner", "external"]));
		const older = ask({ t: "personal-events", before: events[2]?.at }).events;
		expect(older.map(e => e.id)).toEqual(events.slice(3).map(e => e.id));
		expect(ask({ t: "personal-events", limit: 2 }).events).toHaveLength(2);
	});

	it("pushes through onHostsChanged too, so the hosts frame carries the new rev", () => {
		const { ask, hostChanges, mock } = harness();
		const before = hostChanges();
		const rev = mock.capabilities().personalRev ?? 0;
		ask({ t: "personal-memory-pin", id: "w:6" });
		expect(hostChanges()).toBe(before + 1);
		expect(mock.capabilities().personalRev).toBe(rev + 1);
	});
});

describe("settings", () => {
	it("starts with the defaults, a spend near the day limit and the sample sources", () => {
		const { ask } = harness();
		const { settings, mcpServers } = ask({ t: "personal-settings-get" });
		expect(mcpServers).toEqual(["gmail", "calendar", "github"]);
		expect(settings).toMatchObject({
			limits: { dayUsd: 5, monthUsd: 50 },
			review: { enabled: true, time: "03:30", budgetUsd: 0.5 },
			rollover: { time: "04:00" },
			backup: { folder: null },
		});
		expect(settings.sources.map(s => [s.id, s.mcpServer, s.enabled])).toEqual([
			["src-email", "gmail", true],
			["src-calendar", "calendar", false],
		]);
		expect(settings.sources[0]?.everyMinutes).toBe(15);
		expect(settings.sources[0]?.lastPollAt).toBeDefined();
		expect(settings.sources[1]?.lastError).toBeDefined();

		const status = ask({ t: "personal-status" }).status;
		expect(status.spend.day).toMatchObject({ usd: 4.3, limitUsd: 5, level: "warning" });
		expect(status.spend.month).toMatchObject({ usd: 12.4, limitUsd: 50, level: "ok" });
		expect(status.backups).toMatchObject({
			folder: "/home/.omp/profiles/personal/backups",
			sameDisk: true,
			dailyKept: 12,
			monthlyKept: 3,
			lastOk: true,
		});
		expect(status.backups.nextAt).toBeGreaterThan(NOW);
		expect(status.review).toMatchObject({ ok: true, costUsd: 0.21, proposals: 2, digestId: "digest-3" });
		expect(status.review.nextAt).toBeGreaterThan(NOW);
		expect(status.nextRolloverAt).toBeGreaterThan(NOW);
	});

	it("recomputes the spend level from the limits", () => {
		const { ask, pushes } = harness();
		const capped = ask({ t: "personal-settings-set", patch: { limits: { dayUsd: 4 } } });
		expect(capped.settings.limits).toEqual({ dayUsd: 4, monthUsd: 50 });
		const status = ask({ t: "personal-status" }).status;
		expect(status.spend.day.level).toBe("capped");
		expect(pushes.at(-1)?.what).toEqual(["status", "settings"]);
		ask({ t: "personal-settings-set", patch: { limits: { dayUsd: 0, monthUsd: 0 } } });
		const off = ask({ t: "personal-status" }).status.spend;
		expect(off.day).toMatchObject({ limitUsd: null, level: "off" });
		expect(off.month).toMatchObject({ limitUsd: null, level: "off" });
		ask({ t: "personal-settings-set", patch: { limits: { dayUsd: 100 } } });
		expect(ask({ t: "personal-status" }).status.spend.day.level).toBe("ok");
	});

	it("keeps the memory mode: recall by default; chat-tree adds a fake chat's numbers, takes away the rollover time and restarts the session", () => {
		const { ask, hosts, pushes } = harness();
		expect(ask({ t: "personal-settings-get" }).settings.memoryMode).toBe("recall");
		const recall = ask({ t: "personal-status" }).status;
		expect(recall.chatTree).toBeUndefined();
		expect(recall.nextRolloverAt).toBeGreaterThan(NOW);
		const generation = recall.session?.generation;

		const set = ask({ t: "personal-settings-set", patch: { memoryMode: "chat-tree" } });
		expect(set.settings.memoryMode).toBe("chat-tree");
		expect(pushes.at(-1)?.what).toContain("settings");
		const status = ask({ t: "personal-status" }).status;
		expect(status.nextRolloverAt).toBeNull();
		expect(status.chatTree).toMatchObject({ messages: 1204, nodesPending: 3, compactionsFailed: 1 });
		expect(status.chatTree?.viewBytes).toBeGreaterThanOrEqual(64_000);
		expect(status.chatTree?.viewBytes).toBeLessThanOrEqual(128_000);
		expect(status.session?.generation).toBe((generation ?? 0) + 1);
		expect(hosts).toHaveLength(1);

		expect(() => ask({ t: "personal-settings-set", patch: { memoryMode: "endless" as never } })).toThrow(
			"memory mode",
		);
		ask({ t: "personal-settings-set", patch: { memoryMode: "recall" } });
		expect(ask({ t: "personal-status" }).status.chatTree).toBeUndefined();
	});

	it("advertises chat-tree mode unless told it is an older companion", () => {
		expect(harness().mock.capabilities().canPersonalChatTree).toBe(true);
		expect(harness({ chatTree: false }).mock.capabilities().canPersonalChatTree).toBeUndefined();
	});

	it("backs up on request: the time moves, and a missing folder fails with its reason", () => {
		const { ask } = harness();
		const done = ask({ t: "personal-backup-now" });
		expect(done.ok).toBe(true);
		expect(done.error).toBeUndefined();
		expect(done.status.backups).toMatchObject({ lastAt: NOW, lastOk: true });
		ask({ t: "personal-settings-set", patch: { backup: { folder: "/Volumes/gone/missing" } } });
		const failed = ask({ t: "personal-backup-now" });
		expect(failed).toMatchObject({ ok: false, error: "backup folder is missing" });
		expect(failed.status.backups).toMatchObject({ lastOk: false, lastError: "backup folder is missing" });
	});

	it("merges sections, moves the backup folder off the default disk and keeps what the companion owns on sources", () => {
		const { ask, pushes } = harness();
		const set = ask({
			t: "personal-settings-set",
			patch: {
				review: { time: "05:15", enabled: false },
				rollover: { time: "00:00" },
				backup: { folder: "/Volumes/backup/omp" },
			},
		});
		expect(set.settings).toMatchObject({
			limits: { dayUsd: 5, monthUsd: 50 },
			review: { enabled: false, time: "05:15", budgetUsd: 0.5 },
			rollover: { time: "00:00" },
			backup: { folder: "/Volumes/backup/omp" },
		});
		const status = ask({ t: "personal-status" }).status;
		expect(status.backups).toMatchObject({ folder: "/Volumes/backup/omp", sameDisk: false });
		expect(status.review).toMatchObject({ nextAt: null, skipped: "disabled" });
		const count = pushes.length;
		ask({ t: "personal-settings-set", patch: { rollover: { time: "00:00" } } });
		expect(pushes).toHaveLength(count);
		ask({ t: "personal-settings-set", patch: { backup: { folder: null } } });
		expect(ask({ t: "personal-status" }).status.backups).toMatchObject({ sameDisk: true });

		const email = set.settings.sources[0];
		expect(email).toBeDefined();
		const sources = ask({
			t: "personal-settings-set",
			patch: {
				sources: [
					{
						id: "src-email",
						label: "Mail",
						kind: "mcp-poll",
						mcpServer: "gmail",
						everyMinutes: 5,
						prompt: "Anything from Ana",
						enabled: true,
						lastPollAt: 1,
						lastError: "forged",
					},
					{
						id: "src-gh",
						label: "GitHub",
						kind: "mcp-poll",
						mcpServer: "github",
						everyMinutes: 60,
						prompt: "Review requests",
						enabled: true,
					},
				],
			},
		}).settings.sources;
		expect(sources.map(s => s.id)).toEqual(["src-email", "src-gh"]);
		expect(sources[0]?.lastPollAt).toBe(email?.lastPollAt);
		expect(sources[0]?.lastError).toBeUndefined();
		expect(sources[1]?.lastPollAt).toBeUndefined();
	});

	it("refuses invalid values and changes nothing", () => {
		const { ask, pushes, mock } = harness();
		const before = JSON.stringify(mock.state().settings);
		const count = pushes.length;
		const bad = (
			patch: Parameters<typeof ask<"personal-settings-set">>[0]["patch"],
			message: string | RegExp,
		): void => {
			expect(() => ask({ t: "personal-settings-set", patch })).toThrow(message);
		};
		bad({ backup: { folder: "relative/folder" } }, "The backup folder must be an absolute path.");
		bad({ backup: { folder: "" } }, "The backup folder must be an absolute path.");
		bad({ review: { time: "25:00" } }, /HH:MM/);
		bad({ review: { time: "3:30" } }, /HH:MM/);
		bad({ rollover: { time: "04:60" } }, /HH:MM/);
		bad({ limits: { dayUsd: -1 } }, /0 or more/);
		bad({ limits: { monthUsd: Number.NaN } }, /0 or more/);
		bad({ review: { budgetUsd: -0.01 } }, /0 or more/);
		const source = {
			id: "s",
			label: "S",
			kind: "mcp-poll",
			mcpServer: "gmail",
			everyMinutes: 10,
			prompt: "check",
			enabled: true,
		} as const;
		bad({ sources: [{ ...source, everyMinutes: 4 }] }, "at most every 5 minutes");
		bad({ sources: [{ ...source, mcpServer: "slack" }] }, /No MCP server called "slack"/);
		bad({ sources: [source, source] }, "its own id");
		bad({ sources: [{ ...source, prompt: " " }] }, "what the source should check");
		bad({ limits: { dayUsd: 9 }, review: { time: "99:99" } }, /HH:MM/);
		expect(JSON.stringify(mock.state().settings)).toBe(before);
		expect(pushes).toHaveLength(count);
	});
});
