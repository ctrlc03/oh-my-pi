/**
 * What the shell knows about sessions, which is only what the web app reports: validated on arrival (the page is
 * not trusted with more than data), turned into the menu-bar icon's state, and diffed into notification events.
 */
import type { ReportedSession, SessionActivity, SessionReport } from "../shared/bridge";
import { isRecord } from "./guards";

const MAX_SESSIONS = 500;
const MAX_TEXT = 200;
const MAX_COMPUTERS = 100;
const ACTIVITIES: Record<SessionActivity, true> = { input: true, working: true, idle: true };

function isActivity(value: unknown): value is SessionActivity {
	return typeof value === "string" && Object.hasOwn(ACTIVITIES, value);
}

function text(value: unknown, fallback: string | null): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, MAX_TEXT) : fallback;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000 ? value : 0;
}

/** The report the page sent, cleaned up; null when it is not a report at all. Sessions that are malformed are dropped. */
export function parseReport(raw: unknown): SessionReport | null {
	if (!isRecord(raw) || !Array.isArray(raw.sessions)) return null;
	const out: ReportedSession[] = [];
	for (const row of raw.sessions.slice(0, MAX_SESSIONS)) {
		if (!isRecord(row)) continue;
		const computerId = text(row.computerId, null);
		const instanceId = text(row.instanceId, null);
		if (computerId === null || instanceId === null || !isActivity(row.activity)) continue;
		out.push({
			computerId,
			instanceId,
			title: text(row.title, "session") ?? "session",
			computerName: text(row.computerName, null),
			activity: row.activity,
		});
	}
	const report: SessionReport = {
		sessions: out,
		computersLive: count(raw.computersLive),
		computersTotal: count(raw.computersTotal),
	};
	if (Array.isArray(raw.liveComputerIds)) {
		report.liveComputerIds = raw.liveComputerIds.slice(0, MAX_COMPUTERS).flatMap(id => text(id, null) ?? []);
	}
	return report;
}

export function sessionKey(session: Pick<ReportedSession, "computerId" | "instanceId">): string {
	return `${session.computerId}|${session.instanceId}`;
}

/** What the menu-bar icon shows. `offline`: computers are paired and none can be reached, so nothing is known. */
export type TrayState = "idle" | "working" | "input" | "offline";

export interface TrayView {
	state: TrayState;
	/** Sessions waiting on an answer. */
	waiting: ReportedSession[];
	working: number;
	tooltip: string;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The menu-bar icon's state for a report (null before the page has reported anything). */
export function trayView(report: SessionReport | null): TrayView {
	if (report === null) return { state: "idle", waiting: [], working: 0, tooltip: "omp collab" };
	const waiting = report.sessions.filter(session => session.activity === "input");
	const working = report.sessions.filter(session => session.activity === "working").length;
	if (waiting.length > 0) {
		return {
			state: "input",
			waiting,
			working,
			tooltip: `omp collab: ${plural(waiting.length, "session needs", "sessions need")} your input`,
		};
	}
	if (report.computersTotal > 0 && report.computersLive === 0) {
		return { state: "offline", waiting, working: 0, tooltip: "omp collab: no computer reachable" };
	}
	if (working > 0) {
		return {
			state: "working",
			waiting,
			working,
			tooltip: `omp collab: ${plural(working, "session", "sessions")} working`,
		};
	}
	return { state: "idle", waiting, working, tooltip: "omp collab: nothing needs you" };
}

export interface SessionEvent {
	kind: "input" | "finished";
	session: ReportedSession;
}

/**
 * What changed between two reports that is worth telling the user about: a session that started waiting on an
 * answer, and one that finished a turn (was working, now idle). The first report is a baseline, and so is a
 * computer that was not in the previous report (it just connected; what it lists is not news; a report that names its
 * live computers, `liveComputerIds`, lets a computer that had no sessions yet count as already connected).
 */
export function diffReports(previous: SessionReport | null, next: SessionReport): SessionEvent[] {
	if (previous === null) return [];
	const before = new Map(previous.sessions.map(session => [sessionKey(session), session]));
	const knownComputers = new Set([
		...(previous.liveComputerIds ?? []),
		...previous.sessions.map(session => session.computerId),
	]);
	const events: SessionEvent[] = [];
	for (const session of next.sessions) {
		const was = before.get(sessionKey(session));
		if (was === undefined) {
			if (session.activity === "input" && knownComputers.has(session.computerId))
				events.push({ kind: "input", session });
			continue;
		}
		if (session.activity === "input" && was.activity !== "input") events.push({ kind: "input", session });
		else if (session.activity === "idle" && was.activity === "working") events.push({ kind: "finished", session });
	}
	return events;
}

export interface NotificationPrefs {
	input: boolean;
	finished: boolean;
}

export interface NotificationText {
	title: string;
	body: string;
	/** Present when one notification stands for one session, so a click can open it. */
	open?: { computerId: string; instanceId: string };
}

function where(session: ReportedSession, computersTotal: number): string {
	return computersTotal > 1 && session.computerName !== null ? ` on ${session.computerName}` : "";
}

/**
 * The notifications for `events`, at most `limit`: one each, or, past the limit, one that counts the rest. Nothing
 * for a kind the user turned off. A session that needs input is not also announced as finished.
 */
export function notificationsFor(
	events: readonly SessionEvent[],
	prefs: NotificationPrefs,
	computersTotal: number,
	limit = 3,
): NotificationText[] {
	const wanted = events.filter(event => (event.kind === "input" ? prefs.input : prefs.finished));
	const shown = wanted.slice(0, limit).map((event): NotificationText => ({
		title: event.session.title,
		body:
			event.kind === "input"
				? `Needs your input${where(event.session, computersTotal)}`
				: `Finished a turn${where(event.session, computersTotal)}`,
		open: { computerId: event.session.computerId, instanceId: event.session.instanceId },
	}));
	const rest = wanted.length - shown.length;
	if (rest > 0)
		shown.push({
			title: "omp collab",
			body: `${plural(rest, "more session needs", "more sessions need")} your attention`,
		});
	return shown;
}
