/**
 * Session hibernation on the computer (see `@oh-my-pi/pi-wire/hibernate`): the omp process of a session the companion
 * started is stopped once the session has finished its work and sat idle with nobody looking at it, and started again
 * (`omp -r <session id>`, same folder) when the session is opened. Three parts:
 *
 * - the decisions, pure functions of the listing and a few facts the companion reads ({@link hibernateRefusal},
 *   {@link idleLongEnough}); conservative by construction: a signal that is unknown counts as work in progress;
 * - the record of which sessions are hibernated, and the settings, in a file private to the user (mode 0600) so a
 *   restart of the companion keeps both;
 * - the actions (`hibernate`, `wake`, the periodic `tick`), over injected seams so they can be tested without tmux or omp.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DEFAULT_HIBERNATE_SETTINGS,
	HIBERNATE_MINUTE_MS,
	type HibernatedSession,
	type HibernateRefusal,
	type HibernateSettings,
	hibernateRefusalText,
	isHibernateAfter,
	parseHibernateSettings,
} from "@oh-my-pi/pi-wire/hibernate";
import { parsePrWatchFile } from "@oh-my-pi/pi-wire/pr-watch";
import type { CompanionHost } from "../src/lib/companion";
import { PR_WAKE_SESSION_STALE_MS } from "./companion-prwake";
import { SAFE_ID_RE } from "./companion-sessions";

/** A listed host with what the collab registry says of the work it has besides the turn. */
export interface HibernateHost extends CompanionHost {
	/** `null`: the host does not report it (an older omp), so it is unknown. */
	background: boolean | null;
}

/**
 * How the companion launched a session, kept by session id from the start: what a resume has to repeat (omp does not
 * keep the sandbox or the spend limit in the session) and what rules hibernation out. Read from the process listing
 * instead, the sandbox would fail open (`ps` can fail, and a restricted launch looks unsandboxed).
 */
export interface HibernateLaunch {
	/** omp ran under the sandbox: it resumes under it. */
	sandboxed: boolean;
	/** A read-only run of the app's own (an architecture map, a quiz, a sparring partner): its feature ends it, and a resume would lack the restriction. */
	restricted: boolean;
	/** `omp --max-cost` (USD), which a resume repeats. */
	maxCostUsd?: number;
}

export interface HibernateLaunchRecord extends HibernateLaunch {
	sessionId: string;
}

/** What the companion knows of a host beyond the listing. */
export interface HibernateFacts {
	/** The omp runs in a tmux session the companion made, so the companion can resume it the same way. */
	startedHere: boolean;
	/** The Personal agent's session, which has its own lifecycle. */
	personal: boolean;
	/** How it was launched; null when nothing was recorded (a session from before that was kept): never hibernated, because a resume would have to guess. */
	launch: HibernateLaunch | null;
	/** The session published a fresh pull request watch: it wakes itself on the pull request's events. */
	watchingPr: boolean;
	/** A terminal on the computer is attached to its tmux session; true as well when that cannot be told. */
	attached: boolean;
}

/** The facts the companion reads from the system; the launch is the organiser's own record. */
export type HibernateHostFacts = Omit<HibernateFacts, "launch">;

/**
 * Why the listing alone rules a session out: what it is, or what it is doing. Idle time only counts while this is
 * null. A host that does not report `busy` or `background` is unknown, never idle.
 */
export function stateRefusal(host: HibernateHost): HibernateRefusal | null {
	if (host.agent !== undefined) return "vendor-agent";
	if (host.busy === true) return "working";
	if (host.busy === null || host.background === null) return "unknown-state";
	if (host.inputRequired) return "needs-input";
	if (host.background) return "background-work";
	// The host counts itself: anyone else is a device (or guest) with the session open.
	if (host.participants > 1) return "open-elsewhere";
	return null;
}

/** Why a session is not hibernated now, or null when it may be. The first applicable reason wins. */
export function hibernateRefusal(host: HibernateHost, facts: HibernateFacts): HibernateRefusal | null {
	if (!facts.startedHere) return "not-started-here";
	if (facts.personal) return "personal";
	if (facts.launch === null) return "unknown-launch";
	if (facts.launch.restricted) return "system";
	const state = stateRefusal(host);
	if (state !== null) return state;
	if (facts.watchingPr) return "watching-pr";
	if (facts.attached) return "terminal-attached";
	return null;
}

/**
 * When each session became quiet (see {@link stateRefusal}), by instance id: kept while it stays so, dropped the moment
 * any signal of work, a question or a viewer shows, and started afresh the first time a session is seen.
 */
export function trackQuiet(
	previous: ReadonlyMap<string, number>,
	hosts: readonly HibernateHost[],
	now: number,
): Map<string, number> {
	const next = new Map<string, number>();
	for (const host of hosts) {
		if (stateRefusal(host) === null) next.set(host.instanceId, previous.get(host.instanceId) ?? now);
	}
	return next;
}

/**
 * Whether a quiet session has been idle long enough. `quietSince` is when the companion last saw it start being quiet;
 * `touchedAt` is when its session file was last written, which the companion's own memory (reset by a restart) cannot
 * undercut: the later of the two counts.
 */
export function idleLongEnough(
	afterMinutes: number,
	quietSince: number | undefined,
	touchedAt: number | null,
	now: number,
): boolean {
	if (afterMinutes <= 0 || quietSince === undefined) return false;
	return now - Math.max(quietSince, touchedAt ?? 0) >= afterMinutes * HIBERNATE_MINUTE_MS;
}

// ── the file ─────────────────────────────────────────────────────────────────

export interface HibernateFile {
	settings: HibernateSettings;
	sessions: HibernatedSession[];
	launches: HibernateLaunchRecord[];
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** One record from untrusted JSON; null when any field is damaged (ids are checked like every id the companion passes to omp). */
export function parseHibernated(raw: unknown): HibernatedSession | null {
	if (typeof raw !== "object" || raw === null) return null;
	// Untrusted JSON: every field is read as unknown and checked below.
	const fields: Record<string, unknown> = { ...raw };
	const { sessionId, instanceId, sessionName, cwd, model, startedAt, hibernatedAt, sandboxed, maxCostUsd } = fields;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId)) return null;
	if (typeof instanceId !== "string" || !SAFE_ID_RE.test(instanceId)) return null;
	if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) return null;
	if (sessionName !== null && typeof sessionName !== "string") return null;
	if (model !== null && typeof model !== "string") return null;
	if (!isTime(startedAt) || !isTime(hibernatedAt)) return null;
	// A damaged spend limit is not read as "none": the record is dropped like any other damaged one.
	if (maxCostUsd !== undefined && !isCost(maxCostUsd)) return null;
	return {
		sessionId,
		instanceId,
		sessionName,
		cwd,
		model,
		startedAt,
		hibernatedAt,
		...(sandboxed === true ? { sandboxed: true } : {}),
		...(isCost(maxCostUsd) ? { maxCostUsd } : {}),
	};
}

/** One launch record from untrusted JSON; null when damaged, which reads as "not recorded" and so is never hibernated. */
export function parseLaunch(raw: unknown): HibernateLaunchRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	// Untrusted JSON: every field is read as unknown and checked below.
	const fields: Record<string, unknown> = { ...raw };
	const { sessionId, sandboxed, restricted, maxCostUsd } = fields;
	if (typeof sessionId !== "string" || !SAFE_ID_RE.test(sessionId)) return null;
	if (typeof sandboxed !== "boolean" || typeof restricted !== "boolean") return null;
	if (maxCostUsd !== undefined && !isCost(maxCostUsd)) return null;
	return { sessionId, sandboxed, restricted, ...(isCost(maxCostUsd) ? { maxCostUsd } : {}) };
}

export function parseHibernateFile(raw: unknown): HibernateFile {
	// Untrusted JSON: every field is read as unknown and checked below.
	const file: Record<string, unknown> = typeof raw === "object" && raw !== null ? { ...raw } : {};
	const seen = new Set<string>();
	const sessions: HibernatedSession[] = [];
	for (const entry of Array.isArray(file.sessions) ? file.sessions : []) {
		const session = parseHibernated(entry);
		if (session === null || seen.has(session.sessionId)) continue;
		seen.add(session.sessionId);
		sessions.push(session);
	}
	const launched = new Set<string>();
	const launches: HibernateLaunchRecord[] = [];
	for (const entry of Array.isArray(file.launches) ? file.launches : []) {
		const launch = parseLaunch(entry);
		if (launch === null || launched.has(launch.sessionId)) continue;
		launched.add(launch.sessionId);
		launches.push(launch);
	}
	return { settings: parseHibernateSettings(file.settings), sessions, launches };
}

export async function loadHibernateFile(file: string): Promise<HibernateFile> {
	try {
		return parseHibernateFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { settings: { ...DEFAULT_HIBERNATE_SETTINGS }, sessions: [], launches: [] };
	}
}

export async function saveHibernateFile(file: string, contents: HibernateFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify(contents, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

/** Settings from a request: only a listed delay is accepted (the file reader, by contrast, falls back to the default). */
export function requireHibernateSettings(raw: unknown): HibernateSettings {
	if (typeof raw !== "object" || raw === null || !("afterMinutes" in raw) || !isHibernateAfter(raw.afterMinutes))
		throw new Error("invalid hibernation settings");
	return { afterMinutes: raw.afterMinutes };
}

/**
 * Whether the session publishes a fresh pull request watch (`<dir>/watches/<session id>.json`, see ./companion-prwake):
 * the companion wakes such a session on the pull request's events, so a hibernated one would sleep through them. A file
 * nobody has refreshed lately belongs to an omp that is gone.
 */
export async function watchesPullRequest(dir: string, sessionId: string, now: number): Promise<boolean> {
	if (!SAFE_ID_RE.test(sessionId)) return false;
	const file = path.join(dir, "watches", `${sessionId}.json`);
	try {
		const { mtimeMs } = await fs.stat(file);
		if (now - mtimeMs > PR_WAKE_SESSION_STALE_MS) return false;
		const watch = parsePrWatchFile(JSON.parse(await Bun.file(file).text()));
		return watch !== undefined && watch.prs.length > 0;
	} catch {
		return false;
	}
}

// ── stopping omp ─────────────────────────────────────────────────────────────

function hasErrorCode(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists but is not ours to signal.
		return !hasErrorCode(err, "ESRCH");
	}
}

/**
 * Ask omp to shut down through its own teardown (SIGTERM takes the same path as quitting from the keyboard: the draft is
 * saved, the session is disposed and its file closed) and wait until the process is gone. Resolves false when it still
 * runs after `timeoutMs`; it is never killed harder, which could leave the session file half written. Rejects when
 * the process cannot be signalled at all, in which case nothing was sent to it.
 */
export async function shutDownProcess(pid: number, timeoutMs: number, pollMs = 250): Promise<boolean> {
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		if (hasErrorCode(err, "ESRCH")) return true;
		throw err;
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await Bun.sleep(pollMs);
		if (!alive(pid)) return true;
	}
	return !alive(pid);
}

// ── the organiser ────────────────────────────────────────────────────────────

export interface HibernationOptions {
	now(): number;
	initial: HibernateFile;
	save(file: HibernateFile): Promise<void>;
	/** A fresh listing: the hosts (with their background state) and the running omp processes that do not host. */
	list(): Promise<{ hosts: HibernateHost[]; idle: readonly { sessionId: string; instanceId: string }[] }>;
	facts(host: HibernateHost): Promise<HibernateHostFacts>;
	/** When the session's file was last written (ms); null when it cannot be read. */
	touchedAt(sessionId: string): Promise<number | null>;
	/** Whether the session still has its file; a deleted session's record is dropped. */
	exists(sessionId: string): Promise<boolean>;
	/** Whether the folder a hibernated session ran in is still there. */
	folderExists(cwd: string): Promise<boolean>;
	/**
	 * Shut the host's process down gracefully. Resolves false when it was told to and did not exit in time (see
	 * {@link shutDownProcess}); rejects only when nothing was sent to it, so the session is untouched.
	 */
	stop(host: HibernateHost): Promise<boolean>;
	/** Start omp again on the session; resolves with the new host's instance id. */
	resume(session: HibernatedSession): Promise<string>;
	/** Runs the work of one session one at a time, with its settle cleanup, ending it and deleting it. */
	lock<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
	/** The hibernated list or the settings changed by an action (not by a listing): tell the devices. */
	onChange(): void;
	onError(err: unknown): void;
}

export interface Hibernation {
	settings(): HibernateSettings;
	setSettings(settings: HibernateSettings): Promise<void>;
	/** The hibernated sessions, newest first. */
	list(): HibernatedSession[];
	/** The record of a hibernated session; undefined when it is not hibernated. */
	record(sessionId: string): HibernatedSession | undefined;
	/** Remember how the companion launched a session (see {@link HibernateLaunch}); a session without one is never hibernated. */
	noteLaunch(sessionId: string, launch: HibernateLaunch): void;
	/** Take in a listing: track who is quiet, and forget a hibernated session that runs again (resumed from a terminal, a schedule). */
	observe(hosts: readonly HibernateHost[], idle: readonly { sessionId: string; instanceId: string }[]): void;
	/** Hibernate the quiet sessions that have been idle for the configured time. */
	tick(): Promise<void>;
	/** Hibernate a session now; rejects with the reason (a sentence for the user) when it is not eligible. */
	hibernate(instanceId: string): Promise<HibernatedSession>;
	/** The new instance id of the session whose last process was `instanceId`, resumed first; null when no session is hibernated under that id. */
	wake(instanceId: string): Promise<string | null>;
	/** Drop the record and the launch of a session that no longer exists or was ended. */
	forget(sessionId: string): void;
}

/** Records of sessions without a file are looked for every this many ticks: files rarely vanish, and each look is a disk read. */
const SWEEP_EVERY_TICKS = 10;

/** Reasons that stay true for as long as the process lives: a session refused for one is not asked about again. */
const PERMANENT_REFUSALS: Partial<Record<HibernateRefusal, true>> = {
	"not-started-here": true,
	personal: true,
	"unknown-launch": true,
	system: true,
};

export function createHibernation(options: HibernationOptions): Hibernation {
	let file: HibernateFile = {
		...options.initial,
		sessions: [...options.initial.sessions].sort((a, b) => b.hibernatedAt - a.hibernatedAt),
	};
	let quiet = new Map<string, number>();
	/** Instances ruled out for good (see {@link PERMANENT_REFUSALS}): the tick skips them without asking tmux or the disk. */
	let refused = new Set<string>();
	/** Sessions in the latest listing: their launch is kept even before their file exists (omp may write it with the first message). */
	let listedSessions = new Set<string>();
	let ticks = 0;
	/** Wakes in progress by session id: two devices opening the same session share one resume. */
	const waking = new Map<string, Promise<string>>();
	let saving: Promise<void> = Promise.resolve();
	let ticking = false;

	const persist = (): void => {
		const snapshot = file;
		saving = saving
			.catch(() => {})
			.then(() => options.save(snapshot))
			.catch(options.onError);
	};

	const commit = (sessions: HibernatedSession[], notify: boolean): void => {
		file = { ...file, sessions: sessions.sort((a, b) => b.hibernatedAt - a.hibernatedAt) };
		persist();
		if (notify) options.onChange();
	};

	const without = (sessionId: string): HibernatedSession[] => file.sessions.filter(s => s.sessionId !== sessionId);

	const launchOf = (sessionId: string): HibernateLaunchRecord | undefined =>
		file.launches.find(launch => launch.sessionId === sessionId);

	const observe: Hibernation["observe"] = (hosts, idle) => {
		quiet = trackQuiet(quiet, hosts, options.now());
		listedSessions = new Set([...hosts, ...idle].map(session => session.sessionId));
		// A process other than the one that was stopped: the stopped one may still be listed for a moment after it exits.
		const resumed = (session: HibernatedSession): boolean =>
			[...hosts, ...idle].some(
				running => running.sessionId === session.sessionId && running.instanceId !== session.instanceId,
			);
		const kept = file.sessions.filter(session => !resumed(session));
		if (kept.length !== file.sessions.length) commit(kept, false);
	};

	/** Why `host` is not hibernated now (null: it may be), from the listing, the facts the companion reads and the launch it recorded. */
	const refusalOf = async (host: HibernateHost): Promise<HibernateRefusal | null> =>
		hibernateRefusal(host, { ...(await options.facts(host)), launch: launchOf(host.sessionId) ?? null });

	const idleEnough = async (host: HibernateHost): Promise<boolean> =>
		idleLongEnough(
			file.settings.afterMinutes,
			quiet.get(host.instanceId),
			await options.touchedAt(host.sessionId),
			options.now(),
		);

	/** Hibernate `instanceId` under the session's lock; `auto` leaves a session that is not eligible or not idle long enough alone (null) instead of refusing. */
	const hibernateLocked = async (
		instanceId: string,
		sessionId: string,
		auto: boolean,
	): Promise<HibernatedSession | null> =>
		await options.lock(sessionId, async () => {
			// Looked at again once nothing else works on the session: a message sent while this waited wins.
			const listed = await options.list();
			observe(listed.hosts, listed.idle);
			const host = listed.hosts.find(candidate => candidate.instanceId === instanceId);
			if (host === undefined) throw new Error("unknown session");
			const refusal = await refusalOf(host);
			if (refusal !== null) {
				if (auto) return null;
				throw new Error(hibernateRefusalText(refusal));
			}
			if (auto && !(await idleEnough(host))) return null;
			const launch = launchOf(host.sessionId);
			const session: HibernatedSession = {
				sessionId: host.sessionId,
				instanceId: host.instanceId,
				sessionName: host.sessionName,
				cwd: host.cwd,
				model: host.model,
				startedAt: host.startedAt,
				hibernatedAt: options.now(),
				// The launch is the source; the listing can only add to it (a sandbox it sees that the record lacks).
				...(launch?.sandboxed === true || host.sandboxed === true ? { sandboxed: true } : {}),
				...(launch?.maxCostUsd !== undefined ? { maxCostUsd: launch.maxCostUsd } : {}),
			};
			// Recorded before the process is told to stop: a companion that dies mid-shutdown still lists the session.
			commit([...without(host.sessionId), session], false);
			let stopped: boolean;
			try {
				stopped = await options.stop(host);
			} catch (err) {
				// Nothing was sent to the process: it runs on as before.
				commit(without(host.sessionId), false);
				throw err;
			}
			// The process was told to stop and omp is still closing: the record stays, so the session is not lost between
			// running and hibernated. `wake` takes the live process when it has not exited by the time it is opened.
			if (!stopped)
				throw new Error("omp did not finish shutting down in time; it is still closing, so try again in a moment.");
			options.onChange();
			return session;
		});

	/** Drop the records of sessions whose file is gone (deleted elsewhere), and the launches of those that do not run. */
	const sweep = async (): Promise<void> => {
		const ids = new Set([...file.sessions.map(s => s.sessionId), ...file.launches.map(l => l.sessionId)]);
		const gone = new Set<string>();
		for (const id of ids) if (!(await options.exists(id))) gone.add(id);
		if (gone.size === 0) return;
		const sessions = file.sessions.filter(s => !gone.has(s.sessionId));
		// A listing that came back empty is more likely a glitch than every session gone: keep the launches then.
		const launches =
			listedSessions.size === 0
				? file.launches
				: file.launches.filter(l => !gone.has(l.sessionId) || listedSessions.has(l.sessionId));
		const recordsChanged = sessions.length !== file.sessions.length;
		if (!recordsChanged && launches.length === file.launches.length) return;
		file = { ...file, sessions, launches };
		persist();
		if (recordsChanged) options.onChange();
	};

	return {
		settings: () => file.settings,
		async setSettings(settings) {
			file = { ...file, settings };
			persist();
			await saving;
			options.onChange();
		},
		list: () => file.sessions,
		record: sessionId => file.sessions.find(s => s.sessionId === sessionId),
		noteLaunch(sessionId, launch) {
			const known = launchOf(sessionId);
			if (
				known?.sandboxed === launch.sandboxed &&
				known.restricted === launch.restricted &&
				known.maxCostUsd === launch.maxCostUsd
			)
				return;
			const next: HibernateLaunchRecord = {
				sessionId,
				sandboxed: launch.sandboxed,
				restricted: launch.restricted,
				...(launch.maxCostUsd !== undefined ? { maxCostUsd: launch.maxCostUsd } : {}),
			};
			file = { ...file, launches: [...file.launches.filter(l => l.sessionId !== sessionId), next] };
			persist();
		},
		observe,
		async tick() {
			if (ticking) return;
			ticking = true;
			try {
				if (ticks++ % SWEEP_EVERY_TICKS === 0) await sweep();
				// Nothing below hibernates with the setting off: not worth the listing (an IPC query per omp and a `ps`).
				if (file.settings.afterMinutes === 0) return;
				const afterMs = file.settings.afterMinutes * HIBERNATE_MINUTE_MS;
				const listed = await options.list();
				observe(listed.hosts, listed.idle);
				refused = new Set(listed.hosts.map(host => host.instanceId).filter(id => refused.has(id)));
				const now = options.now();
				for (const host of listed.hosts) {
					// Cheap checks first: no tmux or disk reads for a session that is working, was idle only briefly or never qualifies.
					const since = quiet.get(host.instanceId);
					if (since === undefined || now - since < afterMs || refused.has(host.instanceId)) continue;
					try {
						// Ruled out here, outside the session's lock and without another listing: only a session that qualifies pays for those.
						if (!(await idleEnough(host))) continue;
						const refusal = await refusalOf(host);
						if (refusal !== null) {
							if (PERMANENT_REFUSALS[refusal] === true) refused.add(host.instanceId);
							continue;
						}
						await hibernateLocked(host.instanceId, host.sessionId, true);
					} catch (err) {
						options.onError(err);
					}
				}
			} catch (err) {
				options.onError(err);
			} finally {
				ticking = false;
			}
		},
		async hibernate(instanceId) {
			const listed = await options.list();
			observe(listed.hosts, listed.idle);
			const first = listed.hosts.find(host => host.instanceId === instanceId);
			if (first === undefined) throw new Error("unknown session");
			const session = await hibernateLocked(instanceId, first.sessionId, false);
			if (session === null) throw new Error("unknown session");
			return session;
		},
		wake(instanceId) {
			const record = file.sessions.find(s => s.instanceId === instanceId);
			if (record === undefined) return Promise.resolve(null);
			const running = waking.get(record.sessionId);
			if (running !== undefined) return running;
			const resumed = options
				.lock(record.sessionId, async () => {
					// Resumed meanwhile (another device, a schedule, a terminal): that process is the answer.
					const live = (await options.list()).hosts.find(host => host.sessionId === record.sessionId);
					if (live === undefined && !(await options.folderExists(record.cwd))) {
						// The launch shell enters the folder first, so every resume would fail: the record leads nowhere.
						if (file.sessions.some(s => s.sessionId === record.sessionId)) commit(without(record.sessionId), true);
						throw new Error("The folder this session ran in is gone, so it cannot be resumed.");
					}
					const next = live?.instanceId ?? (await options.resume(record));
					if (file.sessions.some(s => s.sessionId === record.sessionId)) commit(without(record.sessionId), true);
					return next;
				})
				.finally(() => waking.delete(record.sessionId));
			waking.set(record.sessionId, resumed);
			return resumed;
		},
		forget(sessionId) {
			const hibernated = file.sessions.some(s => s.sessionId === sessionId);
			if (!hibernated && launchOf(sessionId) === undefined) return;
			file = { ...file, sessions: without(sessionId), launches: file.launches.filter(l => l.sessionId !== sessionId) };
			persist();
			if (hibernated) options.onChange();
		},
	};
}
