/**
 * Session organisation on the computer: the pin / snooze / settle document
 * every paired device syncs through (see ../src/lib/session-org), the auto-settle
 * rules that only the always-on companion can apply (idle days, pull request
 * merged or closed), and the file it persists to. Pure over an injected clock
 * and readers so the rules are testable without GitHub or a session listing.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyOrg,
	autoSettleIdle,
	autoSettlePr,
	DAY_MS,
	emptyOrg,
	mergeOrg,
	type OrgDoc,
	type OrgEntry,
	parseOrg,
	pruneOrg,
	sameOrg,
} from "../src/lib/session-org";
import { git } from "./companion-git";
import { gh } from "./companion-gitflow";

/** Pull requests are only polled this often, and only while the rule is on. */
export const ORG_PR_CHECK_MS = 5 * 60 * 1000;
/** Activity stamps are persisted at most this often when nothing else changed. */
const ACTIVITY_SAVE_MS = 10 * 60 * 1000;
/** Activity of sessions no longer listed is forgotten after this. */
const ACTIVITY_KEEP_MS = 90 * DAY_MS;
/** Repositories read per round: every session cwd of a long-lived companion would otherwise cost one `gh` each. */
const MAX_PR_READS = 20;
const GH_TIMEOUT_MS = 30_000;
const KEY_RE = /^[\w-]{1,64}$/;

export interface OrgFile {
	doc: OrgDoc;
	/** Counts changes to `doc`; devices fetch it again when the number moves. */
	rev: number;
	/** session id → last time the session was seen working or asking (ms). */
	activity: Record<string, number>;
	/** session id → `at` of the settled entry the settle cleanup has been offered for; see {@link settleTransitions}. */
	settled: Record<string, number>;
	/**
	 * session id → `at` of the settled entry whose session is to be ended (and its cleanup run) once it is idle: sessions that
	 * settled while "End sessions when they settle" was on and are not resolved yet. Kept so a restart neither forgets nor repeats them.
	 */
	ending: Record<string, number>;
}

/**
 * Sessions that went into settled since `handled`: a settled entry whose time is not the one handled.
 * Settling again after an un-settle is a new entry, so it is reported again; the same entry arriving
 * once more (a device syncing the document it already sent, a restart) is not. `handled` of the result
 * holds exactly the settled entries of `doc`. Room entries (`room:…`) are not sessions of this computer.
 */
export function settleTransitions(
	doc: OrgDoc,
	handled: Readonly<Record<string, number>>,
): { handled: Record<string, number>; events: SettledSession[] } {
	const next: Record<string, number> = {};
	const events: SettledSession[] = [];
	for (const [sessionId, entry] of Object.entries(doc.entries)) {
		if (entry.status !== "settled" || !KEY_RE.test(sessionId)) continue;
		next[sessionId] = entry.at;
		if (!Object.hasOwn(handled, sessionId) || handled[sessionId] !== entry.at)
			events.push({ sessionId, at: entry.at });
	}
	return { handled: next, events };
}

/** A record of session id → time from untrusted JSON; damaged ids and times are dropped. */
function parseTimes(raw: unknown): Record<string, number> {
	const times: Record<string, number> = {};
	if (typeof raw === "object" && raw !== null)
		for (const [id, at] of Object.entries(raw))
			if (KEY_RE.test(id) && typeof at === "number" && Number.isFinite(at)) times[id] = at;
	return times;
}

export function parseOrgFile(raw: unknown): OrgFile {
	const file = raw as { doc?: unknown; rev?: unknown; activity?: unknown; settled?: unknown; ending?: unknown } | null;
	const activity = parseTimes(file?.activity);
	const ending = parseTimes(file?.ending);
	const rev = typeof file?.rev === "number" && Number.isInteger(file.rev) && file.rev >= 0 ? file.rev : 0;
	const doc = parseOrg(file?.doc);
	// A file from before settle cleanup existed: what is settled already is not news, or the first start would run it for every old session.
	if (typeof file?.settled !== "object" || file.settled === null)
		return { doc, rev, activity, settled: settleTransitions(doc, {}).handled, ending };
	return { doc, rev, activity, settled: parseTimes(file.settled), ending };
}

export async function loadOrgFile(file: string): Promise<OrgFile> {
	try {
		return parseOrgFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { doc: emptyOrg(), rev: 0, activity: {}, settled: {}, ending: {} };
	}
}

export async function saveOrgFile(file: string, contents: OrgFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

// ── pull request state of a session ──────────────────────────────────────────

/** `gh pr list --json state,mergedAt,closedAt` of one branch: when its newest pull request finished, null while it is open or none exists. */
export function parsePrDone(raw: unknown): number | null {
	if (!Array.isArray(raw)) return null;
	const pr = raw[0] as { state?: unknown; mergedAt?: unknown; closedAt?: unknown } | undefined;
	if (pr?.state !== "MERGED" && pr?.state !== "CLOSED") return null;
	const at = Date.parse(String(pr.state === "MERGED" ? (pr.mergedAt ?? pr.closedAt) : pr.closedAt));
	return Number.isNaN(at) ? null : at;
}

/** When the pull request of the branch checked out in `cwd` merged or closed; null otherwise (or on the default branch). */
export async function ghSessionPrDone(cwd: string): Promise<number | null> {
	const head = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = new TextDecoder().decode(head.out).trim();
	if (head.code !== 0 || branch === "" || branch === "HEAD") return null;
	const origin = await git(cwd, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
	const base = new TextDecoder()
		.decode(origin.out)
		.trim()
		.replace(/^origin\//, "");
	if (branch === "main" || branch === "master" || branch === base) return null;
	const result = await gh(
		cwd,
		["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "state,mergedAt,closedAt"],
		GH_TIMEOUT_MS,
	);
	if (result.code !== 0) throw new Error((result.err || result.out).split("\n")[0] || "gh pr list failed");
	return parsePrDone(JSON.parse(result.out));
}

// ── the organiser ────────────────────────────────────────────────────────────

/** What the organiser needs to know of a listed session. */
export interface OrgSession {
	/** The omp process, which {@link SessionOrgOptions.endSession} ends. */
	instanceId: string;
	sessionId: string;
	cwd: string;
	startedAt: number;
	busy: boolean | null;
	inputRequired: boolean;
}

export interface SessionOrgOptions {
	now(): number;
	initial: OrgFile;
	save(file: OrgFile): Promise<void>;
	/** When the session's pull request finished; null when it has none or is open. */
	readPrDone(cwd: string): Promise<number | null>;
	/** `gh` can read: without it the pull request rule is skipped. */
	prAvailable(): boolean | Promise<boolean>;
	/** The document changed on the computer (not through `sync`): tell the devices. */
	onChange(): void;
	/**
	 * Sessions that just went into settled, from a device's document or an auto-settle rule; each transition is
	 * reported once, after it was persisted (so a restart does not report it again). Not awaited. While
	 * `settings.endOnSettle` is on, a session is reported once it has been ended (or turned out not to be one
	 * to end), so the cleanup it triggers never races a live agent; one un-settled before that is not reported.
	 */
	onSettled?(sessions: SettledSession[]): void;
	/**
	 * End a listed session that settled with the option on and went idle. The caller leaves sessions the companion did
	 * not start alone. It resolves `true` when nothing is left to wait for (the session is gone, or is not one to end),
	 * and `false` when it did not end it: `stillWanted` reports false once the settle was undone, replaced or the option
	 * turned off, and the caller asks it (and re-reads whether the session is idle) after its last await, right before
	 * the kill, so an un-settle or a new prompt that lands meanwhile still wins. A `false` is retried on a later listing,
	 * which drops the session silently when it was un-settled. A rejection is reported to {@link onError} and the session is not retried.
	 */
	endSession(session: OrgSession, stillWanted: () => boolean): Promise<boolean>;
	onError(err: unknown): void;
	/**
	 * Sessions the organiser leaves alone: never auto-settled, settled from a device, ended on settle, or tracked. The
	 * Personal agent's live session (the companion ends it only through its own control). Absent: none.
	 */
	exempt?(sessionId: string): boolean;
}

/** A session that went into settled: `at` is the time of the settled entry. */
export interface SettledSession {
	sessionId: string;
	at: number;
}

/** What the organiser holds of one session: the sidebar entry and its bookkeeping. */
export interface OrgRecord {
	/** The entry in the document; null when the session had none (it was shown as active). */
	entry: OrgEntry | null;
	activity?: number;
	settled?: number;
	ending?: number;
}

export interface SessionOrg {
	file(): OrgFile;
	/** Merge a device's document into the computer's; resolves with the result and its revision. */
	sync(remote: OrgDoc): Promise<{ doc: OrgDoc; rev: number }>;
	/** Observe the listing, then apply the auto-settle rules. */
	tick(sessions: readonly OrgSession[]): Promise<void>;
	/** What the organiser holds of `sessionId` now. */
	record(sessionId: string): OrgRecord;
	/**
	 * Take deleted sessions out of the organisation: their entries go back to default (a tombstone every device merges
	 * in, so the row is gone everywhere), and the activity, settle and end-on-settle bookkeeping is dropped. Persisted,
	 * and the devices are told (the revision moves).
	 */
	forget(sessionIds: readonly string[]): Promise<void>;
	/** Put records taken by {@link SessionOrg.forget} back (an undone deletion), their entries newer than the tombstones. A settle that was already handled is not reported again. */
	unforget(records: Readonly<Record<string, OrgRecord>>): Promise<void>;
}

export function createSessionOrg(options: SessionOrgOptions): SessionOrg {
	let file = options.initial;
	let lastPrCheck = Number.NEGATIVE_INFINITY;
	let lastSave = options.now();
	let prRunning = false;
	let resolving = false;
	let saving: Promise<void> = Promise.resolve();

	const persist = (): Promise<void> => {
		lastSave = options.now();
		const snapshot = file;
		saving = saving.catch(() => {}).then(() => options.save(snapshot));
		return saving;
	};

	/** `doc` without the entries of exempt sessions: the Personal agent's session is never pinned, snoozed or settled. */
	const withoutExempt = (doc: OrgDoc): OrgDoc => {
		const skip = options.exempt;
		if (skip === undefined) return doc;
		const kept = Object.entries(doc.entries).filter(([sessionId]) => !skip(sessionId));
		return kept.length === Object.keys(doc.entries).length ? doc : { ...doc, entries: Object.fromEntries(kept) };
	};

	/** Replace the document; a real change bumps the revision and is persisted, then new settles are reported (or, with the option on, queued to be ended first). */
	const adopt = async (incoming: OrgDoc): Promise<boolean> => {
		const doc = withoutExempt(incoming);
		if (sameOrg(doc, file.doc)) return false;
		const { handled, events } = settleTransitions(doc, file.settled);
		const queue = doc.settings.endOnSettle === true;
		const ending = queue
			? { ...file.ending, ...Object.fromEntries(events.map(e => [e.sessionId, e.at])) }
			: file.ending;
		file = { ...file, doc, rev: file.rev + 1, settled: handled, ending };
		await persist();
		if (!queue && events.length > 0) options.onSettled?.(events);
		return true;
	};

	/** Take a session out of `ending` while it still holds this settled entry. */
	const release = async (sessionId: string, at: number): Promise<void> => {
		if (file.ending[sessionId] !== at) return;
		const ending = { ...file.ending };
		delete ending[sessionId];
		file = { ...file, ending };
		await persist();
	};

	/**
	 * End the settled sessions waiting in `ending` that are listed and idle, then report them (and those that are
	 * not listed, or whose option was turned off meanwhile) for cleanup. A session working or asking waits for a later
	 * listing; one the user un-settled meanwhile is forgotten.
	 */
	const resolveEnding = async (sessions: readonly OrgSession[]): Promise<void> => {
		if (resolving || Object.keys(file.ending).length === 0) return;
		resolving = true;
		try {
			const reported: SettledSession[] = [];
			for (const [sessionId, at] of Object.entries(file.ending)) {
				if (options.exempt?.(sessionId) === true) {
					await release(sessionId, at);
					continue;
				}
				const entry = Object.hasOwn(file.doc.entries, sessionId) ? file.doc.entries[sessionId] : undefined;
				if (entry?.status !== "settled" || entry.at !== at) {
					await release(sessionId, at);
					continue;
				}
				const live = sessions.find(s => s.sessionId === sessionId);
				if (live !== undefined && file.doc.settings.endOnSettle === true) {
					if (live.busy !== false || live.inputRequired) continue;
					try {
						const wanted = (): boolean => {
							const now = Object.hasOwn(file.doc.entries, sessionId) ? file.doc.entries[sessionId] : undefined;
							return now?.status === "settled" && now.at === at && file.doc.settings.endOnSettle === true;
						};
						if (!(await options.endSession(live, wanted))) continue;
					} catch (err) {
						options.onError(err);
					}
				}
				await release(sessionId, at);
				reported.push({ sessionId, at });
			}
			if (reported.length > 0) options.onSettled?.(reported);
		} finally {
			resolving = false;
		}
	};

	const observe = (sessions: readonly OrgSession[], now: number): boolean => {
		let changed = false;
		const activity = { ...file.activity };
		const listed = new Set<string>();
		for (const s of sessions) {
			listed.add(s.sessionId);
			// First sight counts as activity: the companion cannot know how long a session sat idle before it looked.
			if (s.busy === true || s.inputRequired || !Object.hasOwn(activity, s.sessionId)) {
				activity[s.sessionId] = now;
				changed = true;
			}
		}
		for (const [id, at] of Object.entries(activity))
			if (!listed.has(id) && now - at > ACTIVITY_KEEP_MS) {
				delete activity[id];
				changed = true;
			}
		if (changed) file = { ...file, activity };
		return changed;
	};

	const settleOnPrs = async (sessions: readonly OrgSession[], now: number): Promise<void> => {
		if (prRunning || !file.doc.settings.settleOnPr || now - lastPrCheck < ORG_PR_CHECK_MS) return;
		prRunning = true;
		lastPrCheck = now;
		try {
			if (!(await options.prAvailable())) return;
			const candidates = sessions
				.filter(s => s.busy !== true && !s.inputRequired)
				.filter((s, i, all) => all.findIndex(o => o.cwd === s.cwd) === i)
				.slice(0, MAX_PR_READS);
			const done = new Map<string, number>();
			for (const s of candidates) {
				try {
					const at = await options.readPrDone(s.cwd);
					if (at !== null) done.set(s.cwd, at);
				} catch (err) {
					options.onError(err);
				}
			}
			const hits = sessions
				.filter(s => done.has(s.cwd))
				.map(s => ({
					key: s.sessionId,
					doneAt: done.get(s.cwd) as number,
					startedAt: s.startedAt,
					working: s.busy === true || s.inputRequired,
				}));
			if (await adopt(autoSettlePr(file.doc, hits, options.now()))) options.onChange();
		} finally {
			prRunning = false;
		}
	};

	const recordOf = (sessionId: string): OrgRecord => ({
		entry: Object.hasOwn(file.doc.entries, sessionId) ? file.doc.entries[sessionId] : null,
		activity: Object.hasOwn(file.activity, sessionId) ? file.activity[sessionId] : undefined,
		settled: Object.hasOwn(file.settled, sessionId) ? file.settled[sessionId] : undefined,
		ending: Object.hasOwn(file.ending, sessionId) ? file.ending[sessionId] : undefined,
	});

	const without = (times: Readonly<Record<string, number>>, ids: readonly string[]): Record<string, number> => {
		const kept = { ...times };
		for (const id of ids) delete kept[id];
		return kept;
	};

	return {
		file: () => file,
		record: recordOf,
		async forget(sessionIds) {
			let doc = file.doc;
			// Only a session that has an entry needs a tombstone; one shown as active has nothing to merge away.
			for (const id of sessionIds)
				if (Object.hasOwn(doc.entries, id))
					doc = applyOrg(doc, id, { type: "restore", entry: null }, options.now());
			file = {
				doc,
				rev: file.rev + 1,
				activity: without(file.activity, sessionIds),
				settled: without(file.settled, sessionIds),
				ending: without(file.ending, sessionIds),
			};
			await persist();
			options.onChange();
		},
		async unforget(records) {
			let doc = file.doc;
			const settled = { ...file.settled };
			const ending = { ...file.ending };
			const activity = { ...file.activity };
			const now = options.now();
			for (const [id, record] of Object.entries(records)) {
				if (record.entry !== null) {
					doc = applyOrg(doc, id, { type: "restore", entry: record.entry }, now);
					const at = doc.entries[id].at;
					if (record.settled !== undefined) settled[id] = at;
					if (record.ending !== undefined) ending[id] = at;
				}
				if (record.activity !== undefined) activity[id] = record.activity;
			}
			file = { doc, rev: file.rev + 1, activity, settled, ending };
			await persist();
			options.onChange();
		},
		async sync(remote) {
			const now = options.now();
			await adopt(pruneOrg(mergeOrg(file.doc, remote), now));
			return { doc: file.doc, rev: file.rev };
		},
		async tick(listed) {
			const sessions = listed.filter(s => options.exempt?.(s.sessionId) !== true);
			const now = options.now();
			const activityChanged = observe(sessions, now);
			const idle = sessions.map(s => ({
				key: s.sessionId,
				lastActive: file.activity[s.sessionId] ?? now,
				working: s.busy === true || s.inputRequired,
			}));
			const changed = await adopt(pruneOrg(autoSettleIdle(file.doc, idle, now), now));
			if (!changed && activityChanged && now - lastSave >= ACTIVITY_SAVE_MS) await persist();
			if (changed) options.onChange();
			await resolveEnding(sessions);
			await settleOnPrs(sessions, now);
		},
	};
}
