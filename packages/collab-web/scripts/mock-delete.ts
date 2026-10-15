/**
 * The `session-delete-plan`, `session-delete` and `session-restore` requests for scripts/mock-companion.ts, so deleting
 * sessions can be tried in a browser without omp or tmux. Everything is in memory: deleted sessions leave the live list
 * and the all-sessions list, their sidebar entry is tombstoned and their hidden-message marks dropped through the mock's own
 * organiser and hidden-message store (so `sessionOrgRev` moves and every device refetches), and a trash keeps them for a
 * restore, which is refused when a session with the same id is back.
 *
 * The samples (`samples: true`) cover each answer the app has to show: a plain ended session, a running one the companion
 * started (ended first), a live one started in a terminal (refused), two running ones in worktrees (one clean, which goes with
 * its worktree; one with uncommitted changes, which stays), and five settled ones for *Delete settled sessions…*. The
 * Personal agent's session and vendor agents' are refused too. Any other live session counts as started by the companion.
 */

import type { HiddenDoc } from "../src/lib/hidden-messages";
import type {
	CompanionHost,
	CompanionIdleSession,
	CompanionReply,
	CompanionRequest,
	SessionDeletePlan,
	SessionDeleteResult,
	SessionOverview,
} from "../src/lib/companion";
import { applyMany, emptyOrg, type OrgDoc } from "../src/lib/session-org";
import type { HiddenMessages } from "./companion-hidden";
import type { OrgRecord, SessionOrg } from "./companion-sessionorg";

const HOUR = 60 * 60 * 1000;

/** A listed session of the all-sessions list that is not running, with the prompts message search finds. */
export interface MockHistorySession {
	overview: SessionOverview;
	messages: { role: "user" | "assistant"; text: string }[];
}

interface Worktree {
	folder: string;
	dirty: boolean;
	removed: boolean;
}

/** What the trash keeps of a deleted session. */
interface Trashed {
	sessionId: string;
	/** The row it is listed as once back (a session that was running comes back ended). */
	history: MockHistorySession;
	record: OrgRecord;
	hidden: HiddenDoc | null;
}

export interface MockDelete {
	/** Fields the mock companion's `hosts` frame needs for the app to offer Delete. */
	capabilities: { canDeleteSessions: true };
	/** The sessions the all-sessions list shows besides the live ones: the sample history and the restored ones. */
	listed(): MockHistorySession[];
	/** The sidebar entries the samples start with: five settled sessions. */
	sampleOrg(now: number): OrgDoc;
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
}

/** Ids of the sample sessions, with the prefix the mock's `--machine` gives its sessions. */
export function deleteSampleIds(
	prefix: string,
): Record<"plain" | "running" | "terminal" | "wtClean" | "wtDirty" | "settled", string[]> {
	const id = (name: string): string => `${prefix}session-del-${name}`;
	return {
		plain: [id("plain")],
		running: [id("running")],
		terminal: [id("terminal")],
		wtClean: [id("wt-clean")],
		wtDirty: [id("wt-dirty")],
		settled: [id("settled-a"), id("settled-b"), id("settled-c"), id("settled-d"), id("settled-e")],
	};
}

const NOT_FOUND = "That session wasn't found. It may be deleted already.";
const IN_TERMINAL = "It is running in a terminal. End it there first.";
const PERSONAL = "The Personal agent's session can't be deleted here.";
const VENDOR = "Only omp sessions can be deleted here.";

export function createMockDelete(options: {
	/** The mock companion's live sessions: samples are added, deleted ones removed. */
	hosts: CompanionHost[];
	/** Interactive omp processes that are not hosting: started in a terminal, so never deletable. */
	idle: readonly CompanionIdleSession[];
	/** Sessions the mock ended when they settled; they are history rows. */
	ended: CompanionHost[];
	sessionOrg: Pick<SessionOrg, "forget" | "unforget" | "record">;
	hidden: Pick<HiddenMessages, "doc" | "forget" | "restore">;
	/** Prefix of the sample sessions' ids (`--machine`), empty for none. */
	prefix: string;
	/** Add the sample sessions. */
	samples: boolean;
	now?: () => number;
}): MockDelete {
	const clock = options.now ?? Date.now;
	const ids = deleteSampleIds(options.prefix);
	const history: MockHistorySession[] = [];
	const handStarted = new Set<string>();
	const worktrees = new Map<string, Worktree>();
	const trash = new Map<string, Trashed>();
	let trashed = 0;

	const overview = (sessionId: string, title: string, folder: string, ageHours: number): SessionOverview => ({
		sessionId,
		title,
		folder,
		startedAt: clock() - (ageHours + 2) * HOUR,
		endedAt: clock() - ageHours * HOUR,
		requests: 14,
		toolCalls: 52,
		subagents: 1,
		tokens: 180_000,
		cost: 0.78,
		models: ["anthropic/claude-sonnet-5-5"],
	});
	const sample = (sessionId: string, title: string, folder: string, ageHours: number): MockHistorySession => ({
		overview: overview(sessionId, title, folder, ageHours),
		messages: [{ role: "user", text: `Pick up where ${title} left off.` }],
	});
	const liveSample = (n: number, sessionId: string, name: string, cwd: string, ageHours: number): CompanionHost => ({
		instanceId: `inst-${n}`,
		sessionId,
		sessionName: name,
		cwd,
		model: "anthropic/claude-sonnet-5-5",
		startedAt: clock() - ageHours * HOUR,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
	});

	if (options.samples) {
		history.push(sample(ids.plain[0]!, "scratch-notes", "/work/scratch", 20));
		const running = liveSample(31, ids.running[0]!, "bench-harness", "/work/bench-harness", 3);
		const terminal = liveSample(32, ids.terminal[0]!, "terminal-fix", "/work/terminal-fix", 4);
		const clean = liveSample(33, ids.wtClean[0]!, "wt-clean-feature", "/work/.worktrees/wt-clean-feature", 5);
		const dirty = liveSample(34, ids.wtDirty[0]!, "wt-dirty-feature", "/work/.worktrees/wt-dirty-feature", 6);
		options.hosts.push(
			running,
			terminal,
			clean,
			dirty,
			liveSample(35, ids.settled[0]!, "old-spike", "/work/old-spike", 40),
			liveSample(36, ids.settled[1]!, "retro-notes", "/work/retro-notes", 44),
		);
		handStarted.add(terminal.instanceId);
		worktrees.set(clean.sessionId, { folder: clean.cwd, dirty: false, removed: false });
		worktrees.set(dirty.sessionId, { folder: dirty.cwd, dirty: true, removed: false });
		history.push(
			sample(ids.settled[2]!, "billing-spike", "/work/billing", 60),
			sample(ids.settled[3]!, "migration-notes", "/work/migrations", 70),
			sample(ids.settled[4]!, "design-review", "/work/design", 80),
		);
	}

	/** Where a session id is listed now. */
	const find = (
		sessionId: string,
	):
		| { kind: "host"; host: CompanionHost }
		| { kind: "ended"; host: CompanionHost }
		| { kind: "idle" }
		| { kind: "history"; entry: MockHistorySession }
		| null => {
		const host = options.hosts.find(candidate => candidate.sessionId === sessionId);
		if (host !== undefined) return { kind: "host", host };
		if (options.idle.some(candidate => candidate.sessionId === sessionId)) return { kind: "idle" };
		const stopped = options.ended.find(candidate => candidate.sessionId === sessionId);
		if (stopped !== undefined) return { kind: "ended", host: stopped };
		const entry = history.find(candidate => candidate.overview.sessionId === sessionId);
		return entry === undefined ? null : { kind: "history", entry };
	};

	const planOf = (sessionId: string): SessionDeletePlan => {
		const found = find(sessionId);
		if (found === null) return { sessionId, refused: NOT_FOUND };
		if (found.kind === "idle") return { sessionId, refused: IN_TERMINAL };
		if (found.kind === "host") {
			if (found.host.personal !== undefined) return { sessionId, refused: PERSONAL };
			if (found.host.agent !== undefined) return { sessionId, refused: VENDOR };
			if (handStarted.has(found.host.instanceId)) return { sessionId, refused: IN_TERMINAL };
		}
		const tree = worktrees.get(sessionId);
		const plan: SessionDeletePlan = { sessionId };
		if (found.kind === "host") plan.running = true;
		if (tree !== undefined && !tree.removed) plan.worktree = tree.folder;
		return plan;
	};

	const asHistory = (host: CompanionHost): MockHistorySession => ({
		overview: {
			...overview(host.sessionId, host.sessionName ?? host.cwd, host.cwd, 0),
			startedAt: host.startedAt,
		},
		messages: [],
	});

	/** Take the session out of every list and into the trash; its sidebar entry and marks go afterwards. */
	const trashSession = (sessionId: string): string => {
		const found = find(sessionId);
		if (found === null || found.kind === "idle") throw new Error(NOT_FOUND);
		let entry: MockHistorySession;
		if (found.kind === "history") {
			entry = found.entry;
			history.splice(history.indexOf(found.entry), 1);
		} else {
			entry = asHistory(found.host);
			const list = found.kind === "host" ? options.hosts : options.ended;
			list.splice(list.indexOf(found.host), 1);
		}
		const trashId = `trash-${++trashed}`;
		trash.set(trashId, {
			sessionId,
			history: entry,
			record: options.sessionOrg.record(sessionId),
			hidden: options.hidden.doc(sessionId),
		});
		return trashId;
	};

	return {
		capabilities: { canDeleteSessions: true },
		listed: () => history,
		sampleOrg: now => applyMany(emptyOrg(), ids.settled, { type: "settle" }, now),
		handles: request =>
			request.t === "session-delete-plan" || request.t === "session-delete" || request.t === "session-restore",
		async answer(request) {
			if (request.t === "session-delete-plan")
				return { t: "session-delete-plan", reqId: request.reqId, plans: request.sessionIds.map(planOf) };
			if (request.t === "session-delete") {
				const results: SessionDeleteResult[] = [];
				const gone: string[] = [];
				for (const sessionId of request.sessionIds) {
					const plan = planOf(sessionId);
					if (plan.refused !== undefined) {
						results.push({ sessionId, status: "refused", reason: plan.refused });
						continue;
					}
					const tree = worktrees.get(sessionId);
					const trashId = trashSession(sessionId);
					gone.push(sessionId);
					if (request.removeWorktree !== true || plan.worktree === undefined || tree === undefined) {
						results.push({ sessionId, status: "deleted", trashId });
					} else if (tree.dirty) {
						results.push({
							sessionId,
							status: "worktreeKept",
							trashId,
							reason: "the worktree has uncommitted changes",
						});
					} else {
						tree.removed = true;
						results.push({ sessionId, status: "deleted", trashId, worktree: "removed" });
					}
				}
				await options.sessionOrg.forget(gone);
				for (const sessionId of gone) await options.hidden.forget(sessionId);
				return { t: "session-delete", reqId: request.reqId, results };
			}
			if (request.t !== "session-restore") throw new Error(`the mock companion does not answer ${request.t}`);
			const kept = trash.get(request.trashId);
			if (kept === undefined) throw new Error("That session is not in the trash any more.");
			if (find(kept.sessionId) !== null)
				throw new Error("A session with the same id is back, so the deleted one cannot be put back.");
			trash.delete(request.trashId);
			history.push(kept.history);
			await options.sessionOrg.unforget({ [kept.sessionId]: kept.record });
			if (kept.hidden !== null) await options.hidden.restore(kept.sessionId, kept.hidden);
			return { t: "session-restore", reqId: request.reqId, sessionId: kept.sessionId };
		},
	};
}
