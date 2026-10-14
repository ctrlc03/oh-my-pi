import { describe, expect, it } from "bun:test";
import type { ReportedSession, SessionReport } from "../src/shared/bridge";
import { diffReports, notificationsFor, parseReport, trayView } from "../src/main/session-state";

const session = (
	instanceId: string,
	activity: ReportedSession["activity"],
	patch: Partial<ReportedSession> = {},
): ReportedSession => ({
	computerId: "c1",
	instanceId,
	title: `session ${instanceId}`,
	computerName: "laptop",
	activity,
	...patch,
});

const report = (sessions: ReportedSession[], live = 1, total = 1): SessionReport => ({
	sessions,
	computersLive: live,
	computersTotal: total,
});

describe("parseReport", () => {
	it("keeps well-formed sessions and drops the rest", () => {
		const parsed = parseReport({
			sessions: [
				{ computerId: "c", instanceId: "1", title: "  a  ", computerName: "m", activity: "input" },
				{ computerId: "c", instanceId: "2", activity: "sleeping" },
				{ computerId: "", instanceId: "3", activity: "idle" },
				"nope",
				{ computerId: "c", instanceId: "4", activity: "idle" },
			],
			computersLive: 1,
			computersTotal: 2,
		});
		expect(parsed?.sessions.map(s => [s.instanceId, s.title, s.computerName])).toEqual([
			["1", "a", "m"],
			["4", "session", null],
		]);
		expect(parsed).toMatchObject({ computersLive: 1, computersTotal: 2 });
	});

	it("refuses what is not a report and bounds what it keeps", () => {
		expect(parseReport(null)).toBeNull();
		expect(parseReport({ sessions: "x" })).toBeNull();
		const many = Array.from({ length: 900 }, (_, i) => ({
			computerId: "c",
			instanceId: String(i),
			activity: "idle",
		}));
		expect(parseReport({ sessions: many })?.sessions.length).toBe(500);
		expect(
			parseReport({
				sessions: [{ computerId: "c", instanceId: "1", title: "x".repeat(900), activity: "idle" }],
				computersLive: -3,
			}),
		).toMatchObject({
			computersLive: 0,
		});
		expect(
			parseReport({ sessions: [{ computerId: "c", instanceId: "1", title: "x".repeat(900), activity: "idle" }] })
				?.sessions[0]?.title.length,
		).toBe(200);
	});
});

describe("trayView", () => {
	it("is idle before anything is reported", () => {
		expect(trayView(null).state).toBe("idle");
	});

	it("needs input over everything else, and counts the waiting sessions", () => {
		const view = trayView(report([session("1", "input"), session("2", "working"), session("3", "input")]));
		expect(view.state).toBe("input");
		expect(view.waiting.map(s => s.instanceId)).toEqual(["1", "3"]);
		expect(view.tooltip).toContain("2 sessions need");
		expect(trayView(report([session("1", "input")])).tooltip).toContain("1 session needs");
	});

	it("shows working, idle, and offline when computers are paired but none is reachable", () => {
		expect(trayView(report([session("1", "working")])).state).toBe("working");
		expect(trayView(report([session("1", "idle")])).state).toBe("idle");
		expect(trayView(report([], 0, 2)).state).toBe("offline");
		expect(trayView(report([], 0, 0)).state).toBe("idle");
	});
});

describe("diffReports", () => {
	it("treats the first report as a baseline", () => {
		expect(diffReports(null, report([session("1", "input")]))).toEqual([]);
	});

	it("reports a session that starts waiting and one that finishes a turn", () => {
		const before = report([session("1", "working"), session("2", "working"), session("3", "idle")]);
		const after = report([session("1", "input"), session("2", "idle"), session("3", "idle")]);
		expect(diffReports(before, after).map(e => [e.kind, e.session.instanceId])).toEqual([
			["input", "1"],
			["finished", "2"],
		]);
	});

	it("does not repeat a session that was already waiting", () => {
		const waiting = report([session("1", "input")]);
		expect(diffReports(waiting, waiting)).toEqual([]);
	});

	it("announces a new session that asks at once, but not a computer that just connected", () => {
		const before = report([session("1", "idle")]);
		const newSession = report([session("1", "idle"), session("2", "input")]);
		expect(diffReports(before, newSession).map(e => e.session.instanceId)).toEqual(["2"]);
		const newComputer = report([session("1", "idle"), session("9", "input", { computerId: "c2" })]);
		expect(diffReports(before, newComputer)).toEqual([]);
	});

	it("counts a computer the report names as live even when it had no sessions", () => {
		const before: SessionReport = { sessions: [], computersLive: 1, computersTotal: 1, liveComputerIds: ["c1"] };
		expect(diffReports(before, report([session("1", "input")])).map(e => e.session.instanceId)).toEqual(["1"]);
		expect(diffReports({ ...before, liveComputerIds: [] }, report([session("1", "input")]))).toEqual([]);
	});

	it("keeps the live computer ids a report carries, bounded and cleaned", () => {
		const parsed = parseReport({ sessions: [], liveComputerIds: ["a", "", 3, " b "] });
		expect(parsed?.liveComputerIds).toEqual(["a", "b"]);
		expect(parseReport({ sessions: [] })?.liveComputerIds).toBeUndefined();
	});

	it("does not call a session that went from working to waiting finished", () => {
		const events = diffReports(report([session("1", "working")]), report([session("1", "input")]));
		expect(events.map(e => e.kind)).toEqual(["input"]);
	});
});

describe("notificationsFor", () => {
	const events = (n: number) =>
		Array.from({ length: n }, (_, i) => ({ kind: "input" as const, session: session(String(i), "input") }));

	it("names the computer only when several are paired", () => {
		const one = notificationsFor(events(1), { input: true, finished: true }, 1);
		expect(one[0]).toMatchObject({
			title: "session 0",
			body: "Needs your input",
			open: { computerId: "c1", instanceId: "0" },
		});
		expect(notificationsFor(events(1), { input: true, finished: true }, 2)[0]?.body).toBe(
			"Needs your input on laptop",
		);
	});

	it("respects the preferences", () => {
		const finished = [{ kind: "finished" as const, session: session("1", "idle") }];
		expect(notificationsFor(finished, { input: true, finished: false }, 1)).toEqual([]);
		expect(notificationsFor(finished, { input: false, finished: true }, 1)[0]?.body).toBe("Finished a turn");
		expect(notificationsFor(events(2), { input: false, finished: true }, 1)).toEqual([]);
	});

	it("summarises a burst instead of flooding", () => {
		const out = notificationsFor(events(7), { input: true, finished: true }, 1);
		expect(out.length).toBe(4);
		expect(out[3]).toEqual({ title: "omp collab", body: "4 more sessions need your attention" });
	});
});
