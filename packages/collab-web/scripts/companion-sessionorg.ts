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
	autoSettleIdle,
	autoSettlePr,
	DAY_MS,
	emptyOrg,
	mergeOrg,
	type OrgDoc,
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
}

export function parseOrgFile(raw: unknown): OrgFile {
	const file = raw as { doc?: unknown; rev?: unknown; activity?: unknown } | null;
	const activity: Record<string, number> = {};
	if (typeof file?.activity === "object" && file.activity !== null)
		for (const [id, at] of Object.entries(file.activity))
			if (KEY_RE.test(id) && typeof at === "number" && Number.isFinite(at)) activity[id] = at;
	const rev = typeof file?.rev === "number" && Number.isInteger(file.rev) && file.rev >= 0 ? file.rev : 0;
	return { doc: parseOrg(file?.doc), rev, activity };
}

export async function loadOrgFile(file: string): Promise<OrgFile> {
	try {
		return parseOrgFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { doc: emptyOrg(), rev: 0, activity: {} };
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
	onError(err: unknown): void;
}

export interface SessionOrg {
	file(): OrgFile;
	/** Merge a device's document into the computer's; resolves with the result and its revision. */
	sync(remote: OrgDoc): Promise<{ doc: OrgDoc; rev: number }>;
	/** Observe the listing, then apply the auto-settle rules. */
	tick(sessions: readonly OrgSession[]): Promise<void>;
}

export function createSessionOrg(options: SessionOrgOptions): SessionOrg {
	let file = options.initial;
	let lastPrCheck = Number.NEGATIVE_INFINITY;
	let lastSave = options.now();
	let prRunning = false;
	let saving: Promise<void> = Promise.resolve();

	const persist = (): Promise<void> => {
		lastSave = options.now();
		const snapshot = file;
		saving = saving.catch(() => {}).then(() => options.save(snapshot));
		return saving;
	};

	/** Replace the document; a real change bumps the revision and is persisted. */
	const adopt = async (doc: OrgDoc): Promise<boolean> => {
		if (sameOrg(doc, file.doc)) return false;
		file = { ...file, doc, rev: file.rev + 1 };
		await persist();
		return true;
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

	return {
		file: () => file,
		async sync(remote) {
			const now = options.now();
			await adopt(pruneOrg(mergeOrg(file.doc, remote), now));
			return { doc: file.doc, rev: file.rev };
		},
		async tick(sessions) {
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
			await settleOnPrs(sessions, now);
		},
	};
}
