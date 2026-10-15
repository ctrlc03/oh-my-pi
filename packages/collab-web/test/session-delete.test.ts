import { describe, expect, it } from "bun:test";
import type { CompanionHost, SessionDeleteResult, SessionOverview } from "../src/lib/companion";
import { INITIAL_SNAPSHOT } from "../src/lib/companion";
import type { ComputerHandle } from "../src/lib/computers";
import {
	closesOpen,
	type DeleteTarget,
	deletableOverview,
	deleteHeading,
	deleteLabel,
	deleteOffered,
	deleteSettledLabel,
	deleteSummarized,
	isDeletableSession,
	restoreDeleted,
	sessionsMessage,
	summarizePlan,
	summarizeResults,
	tombstoneDeleted,
	type TrashEntry,
} from "../src/lib/session-delete";
import { applyOrg, emptyOrg } from "../src/lib/session-org";

const NOW = 1_800_000_000_000;

const target = (sessionId: string, title = sessionId): DeleteTarget => ({ sessionId, title });

function overview(over: Partial<SessionOverview> = {}): SessionOverview {
	return {
		sessionId: "s-1",
		title: "docs-pass",
		folder: "/work/docs",
		startedAt: NOW,
		endedAt: null,
		requests: 1,
		toolCalls: 1,
		subagents: 0,
		tokens: 1,
		cost: 0,
		models: [],
		...over,
	};
}

function computer(over: Partial<typeof INITIAL_SNAPSHOT> = {}): Pick<ComputerHandle, "snap"> {
	return { snap: { ...INITIAL_SNAPSHOT, phase: "live", canDeleteSessions: true, ...over } };
}

describe("which sessions offer Delete", () => {
	it("needs a live computer that can delete sessions: older companions never offer it", () => {
		expect(deleteOffered({ phase: "live", canDeleteSessions: true })).toBe(true);
		expect(deleteOffered({ phase: "live", canDeleteSessions: false })).toBe(false);
		expect(deleteOffered({ phase: "offline", canDeleteSessions: true })).toBe(false);
		expect(deleteOffered(INITIAL_SNAPSHOT)).toBe(false);
	});

	it("is for omp sessions only: not a vendor agent's, not the Personal agent's", () => {
		expect(isDeletableSession({})).toBe(true);
		expect(isDeletableSession({ agent: { id: "claude", name: "Claude Code" } })).toBe(false);
		expect(isDeletableSession({ personal: true })).toBe(false);
	});

	it("is offered on an all-sessions row only for an omp session that is not the Personal agent's live one", () => {
		const personal: CompanionHost = {
			instanceId: "p",
			sessionId: "personal-session",
			sessionName: "Personal",
			cwd: "/home",
			model: null,
			startedAt: NOW,
			participants: 1,
			busy: false,
			inputRequired: false,
			relayConnected: true,
			personal: true,
		};
		const here = computer({ hosts: [personal] });
		expect(deletableOverview(here, overview())).toBe(true);
		expect(deletableOverview(here, overview({ agent: { id: "codex", name: "Codex" } }))).toBe(false);
		expect(deletableOverview(here, overview({ sessionId: "personal-session" }))).toBe(false);
		expect(deletableOverview(computer({ canDeleteSessions: false }), overview())).toBe(false);
		expect(deletableOverview(computer({ phase: "offline" }), overview())).toBe(false);
	});
});

describe("what a plan says", () => {
	it("splits the sessions into those Delete takes and those it refuses, plainly", () => {
		const summary = summarizePlan(
			[target("a", "alpha"), target("b", "beta"), target("c", "gamma")],
			[
				{ sessionId: "a" },
				{ sessionId: "b", refused: "It is running in a terminal. End it there first." },
				{ sessionId: "c", running: true, worktree: "/work/.wt/gamma" },
			],
		);
		expect(summary.deletable.map(t => t.sessionId)).toEqual(["a", "c"]);
		expect(summary.refused).toEqual([
			{ target: target("b", "beta"), reason: "It is running in a terminal. End it there first." },
		]);
		expect(summary.running.map(t => t.sessionId)).toEqual(["c"]);
		expect(summary.worktrees).toEqual([{ target: target("c", "gamma"), folder: "/work/.wt/gamma" }]);
	});

	it("never offers a worktree of a session that is refused, and refuses one the computer said nothing of", () => {
		const summary = summarizePlan(
			[target("a"), target("b")],
			[{ sessionId: "a", refused: "No.", worktree: "/work/.wt/a" }],
		);
		expect(summary.deletable).toEqual([]);
		expect(summary.worktrees).toEqual([]);
		expect(summary.refused.map(r => r.target.sessionId)).toEqual(["a", "b"]);
		expect(summary.refused[0]?.reason).toBe("No.");
	});

	it("words the heading and the button for one session and for several", () => {
		expect(deleteHeading([target("a", "alpha")])).toBe("Delete alpha?");
		expect(deleteHeading([target("a"), target("b"), target("c")])).toBe("Delete 3 sessions?");
		expect(deleteLabel(1)).toBe("Delete");
		expect(deleteLabel(0)).toBe("Delete");
		expect(deleteLabel(4)).toBe("Delete 4 sessions");
		expect(deleteSettledLabel(3)).toBe("Delete 3 settled sessions…");
		expect(deleteSettledLabel(1)).toBe("Delete 1 settled session…");
	});
});

describe("what the person is told of the answer", () => {
	const deleted = (sessionId: string, trashId: string): SessionDeleteResult => ({
		sessionId,
		status: "deleted",
		trashId,
	});

	it("names one deleted session, and counts several", () => {
		expect(summarizeResults([target("a", "alpha")], [deleted("a", "t1")])).toEqual({
			deleted: [{ sessionId: "a", title: "alpha", trashId: "t1" }],
			message: "Deleted alpha",
			notes: [],
		});
		const several = summarizeResults(
			[target("a"), target("b"), target("c")],
			[deleted("a", "t1"), deleted("b", "t2"), deleted("c", "t3")],
		);
		expect(several.message).toBe("Deleted 3 sessions");
		expect(several.deleted.map(entry => entry.trashId)).toEqual(["t1", "t2", "t3"]);
	});

	it("says why a worktree that was asked to go was kept, and that the session is deleted", () => {
		const one = summarizeResults(
			[target("a", "alpha")],
			[{ sessionId: "a", status: "worktreeKept", trashId: "t1", reason: "the worktree has uncommitted changes" }],
		);
		expect(one.message).toBe("Deleted alpha");
		expect(one.notes).toEqual(["Its worktree was kept: the worktree has uncommitted changes"]);
		const many = summarizeResults(
			[target("a", "alpha"), target("b", "beta")],
			[
				{ sessionId: "a", status: "worktreeKept", trashId: "t1", reason: "another session works there" },
				deleted("b", "t2"),
			],
		);
		expect(many.notes).toEqual(["alpha: its worktree was kept: another session works there"]);
	});

	it("says a worktree was removed, since that is not undoable", () => {
		const one = summarizeResults(
			[target("a", "alpha")],
			[{ sessionId: "a", status: "deleted", trashId: "t1", worktree: "removed" }],
		);
		expect(one.notes).toEqual(["Its worktree was removed."]);
		const two = summarizeResults(
			[target("a"), target("b")],
			[
				{ sessionId: "a", status: "deleted", trashId: "t1", worktree: "removed" },
				{ sessionId: "b", status: "deleted", trashId: "t2", worktree: "removed" },
			],
		);
		expect(two.notes).toEqual(["2 worktrees were removed."]);
	});

	it("shows each refusal as 'title: reason' and deletes nothing for it", () => {
		const outcome = summarizeResults(
			[target("a", "alpha"), target("b", "beta")],
			[
				{ sessionId: "a", status: "refused", reason: "It is running in a terminal. End it there first." },
				deleted("b", "t2"),
			],
		);
		expect(outcome.deleted.map(entry => entry.sessionId)).toEqual(["b"]);
		expect(outcome.message).toBe("Deleted beta");
		expect(outcome.notes).toEqual(["alpha: It is running in a terminal. End it there first."]);
		expect(summarizeResults([target("a", "alpha")], []).notes).toEqual([
			"alpha: The computer did not answer for it.",
		]);
		expect(sessionsMessage("Restored", [])).toBe("");
	});

	it("closes the open session only when it was among those deleted", () => {
		const entries: TrashEntry[] = [{ sessionId: "open", title: "open", trashId: "t1" }];
		expect(closesOpen({ openSessionId: "open" }, entries)).toBe(true);
		expect(closesOpen({ openSessionId: "other" }, entries)).toBe(false);
		expect(closesOpen({ openSessionId: null }, entries)).toBe(false);
		expect(closesOpen({ openSessionId: "open" }, [])).toBe(false);
	});
});

describe("confirming and undoing", () => {
	function fake() {
		const calls: { ids: readonly string[]; opts: { removeWorktree?: boolean } | undefined }[] = [];
		const restored: string[] = [];
		return {
			calls,
			restored,
			client: {
				async deleteSessions(ids: readonly string[], opts?: { removeWorktree?: boolean }) {
					calls.push({ ids, opts });
					return ids.map((sessionId, at): SessionDeleteResult => ({
						sessionId,
						status: "deleted",
						trashId: `t${at}`,
					}));
				},
				async restoreSession(trashId: string) {
					restored.push(trashId);
					if (trashId === "taken") throw new Error("A session with the same id is back.");
					return trashId;
				},
			},
		};
	}

	it("deletes the sessions the plan allowed, with removeWorktree as the box says", async () => {
		const plan = summarizePlan(
			[target("a"), target("b"), target("c")],
			[{ sessionId: "a", worktree: "/work/.wt/a" }, { sessionId: "b", refused: "No." }, { sessionId: "c" }],
		);
		const ticked = fake();
		const outcome = await deleteSummarized(ticked.client, plan, true);
		expect(ticked.calls).toEqual([{ ids: ["a", "c"], opts: { removeWorktree: true } }]);
		expect(outcome.message).toBe("Deleted 2 sessions");
		const unticked = fake();
		await deleteSummarized(unticked.client, plan, false);
		expect(unticked.calls[0]?.opts).toEqual({ removeWorktree: false });
	});

	it("never asks for a worktree to go when no plan has one, even if the box is ticked", async () => {
		const plan = summarizePlan([target("a")], [{ sessionId: "a" }]);
		const { client, calls } = fake();
		await deleteSummarized(client, plan, true);
		expect(calls[0]?.opts).toEqual({ removeWorktree: false });
	});

	it("puts every session back by its trash id, and says why one stays deleted", async () => {
		const { client, restored } = fake();
		const trash: TrashEntry[] = [
			{ sessionId: "a", title: "alpha", trashId: "t1" },
			{ sessionId: "b", title: "beta", trashId: "taken" },
			{ sessionId: "c", title: "gamma", trashId: "t3" },
		];
		const outcome = await restoreDeleted(client, trash);
		expect(restored).toEqual(["t1", "taken", "t3"]);
		expect(outcome.restored.map(entry => entry.sessionId)).toEqual(["a", "c"]);
		expect(outcome.notes).toEqual(["beta: A session with the same id is back."]);
	});
});

describe("the sidebar entry of a deleted session", () => {
	it("goes back to default at once, so a settled row that is only history vanishes", () => {
		const doc = applyOrg(emptyOrg(), "a", { type: "settle" }, NOW);
		const next = tombstoneDeleted(doc, ["a"], NOW + 1);
		expect(next.entries.a?.status).toBe("active");
		expect(next.entries.a?.at).toBeGreaterThan(doc.entries.a!.at);
	});

	it("leaves a session that had no entry without one, as the computer does", () => {
		const doc = emptyOrg();
		expect(tombstoneDeleted(doc, ["a"], NOW)).toBe(doc);
	});
});
