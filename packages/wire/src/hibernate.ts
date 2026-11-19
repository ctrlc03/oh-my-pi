/**
 * Session hibernation: the companion stops the omp process of a session that was started from the app, finished its
 * work and has sat idle with nobody looking at it, so the memory it holds is freed. The session file is complete
 * (the process shuts down through omp's own teardown), so opening the session — or sending it a message — starts omp
 * again in the same folder with `omp -r <session id>`, and the conversation continues where it stopped. Shared by the
 * companion (which decides and acts) and the web app (which lists hibernated sessions and sets the delay).
 *
 * A hibernated session keeps the `instanceId` of the process it ran as: every request that names a session by
 * instance id (`link` above all) wakes it first, so opening it from the list, a notification or a deep link needs no
 * separate step. Every field added to an older frame is optional, so a companion or an app that predates hibernation
 * ignores it; a companion advertises `canHibernate` when it answers the `hibernate*` requests.
 */

/** The delays the user can pick, in minutes; `0` turns automatic hibernation off. */
export const HIBERNATE_AFTER_CHOICES = [0, 15, 30, 60, 240] as const;
export const HIBERNATE_DEFAULT_AFTER_MINUTES = 30;
export const HIBERNATE_MINUTE_MS = 60_000;

export interface HibernateSettings {
	/** Hibernate a session once it has been idle this many minutes; `0`: never automatically (*Hibernate now* still works). One of {@link HIBERNATE_AFTER_CHOICES}. */
	afterMinutes: number;
}

export const DEFAULT_HIBERNATE_SETTINGS: HibernateSettings = { afterMinutes: HIBERNATE_DEFAULT_AFTER_MINUTES };

export function isHibernateAfter(value: unknown): value is (typeof HIBERNATE_AFTER_CHOICES)[number] {
	return typeof value === "number" && (HIBERNATE_AFTER_CHOICES as readonly number[]).includes(value);
}

/** Settings from untrusted JSON (the companion's file, a request); anything but a listed delay reads as the default. */
export function parseHibernateSettings(raw: unknown): HibernateSettings {
	if (typeof raw === "object" && raw !== null && "afterMinutes" in raw && isHibernateAfter(raw.afterMinutes))
		return { afterMinutes: raw.afterMinutes };
	return { ...DEFAULT_HIBERNATE_SETTINGS };
}

/** `Off`, `15 min`, `30 min`, `1 h`, `4 h`. */
export function hibernateAfterLabel(minutes: number): string {
	if (minutes === 0) return "Off";
	return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** A session whose omp process was stopped to free memory and that resumes when it is opened. */
export interface HibernatedSession {
	/** The conversation: what `omp -r` resumes. */
	sessionId: string;
	/** The `instanceId` of the process it ran as, kept as the session's handle: a request that names it wakes the session (see the file comment). */
	instanceId: string;
	sessionName: string | null;
	/** Where it ran (the git worktree's path for a worktree session): it resumes in the same folder. */
	cwd: string;
	/** `provider/id` it was using, for display; omp restores the session's own model when it resumes. */
	model: string | null;
	/** When the process it ran as started, ms since epoch. */
	startedAt: number;
	/** When it was hibernated, ms since epoch. */
	hibernatedAt: number;
	/** It ran sandboxed: it resumes sandboxed, whatever the resume request says. */
	sandboxed?: boolean;
	/** The `--max-cost` (USD) it was launched with, which omp does not keep in the session: it resumes with the same limit. */
	maxCostUsd?: number;
}

/** Why a session is not hibernated; see {@link hibernateRefusalText}. */
export type HibernateRefusal =
	| "not-started-here"
	| "personal"
	| "unknown-launch"
	| "system"
	| "vendor-agent"
	| "unknown-state"
	| "working"
	| "needs-input"
	| "background-work"
	| "watching-pr"
	| "open-elsewhere"
	| "terminal-attached";

const REFUSALS: Record<HibernateRefusal, string> = {
	"not-started-here":
		"Only sessions started from the app can be hibernated: this one was started outside it, and it could not be resumed the same way.",
	personal: "The Personal agent's session is managed from Settings → Personal agent.",
	system: "This session is run by the app itself (a quiz, map or sparring partner) and ends on its own.",
	"unknown-launch":
		"The app did not record how this session was started (it began before the app kept that), so it could not be resumed the same way.",
	"vendor-agent": "Sessions of other agents are not hibernated: they do not report whether background work is running.",
	"unknown-state": "This omp does not report what it is doing; update omp on the computer to hibernate its sessions.",
	working: "The agent is working; hibernate it once it is idle.",
	"needs-input": "The session is waiting for an answer or an approval.",
	"background-work":
		"A background job, service or subagent is still running in this session, and hibernating would stop it.",
	"watching-pr": "The session is watching a pull request and would miss its events while hibernated.",
	"open-elsewhere": "Someone has this session open. Close it on every device first.",
	"terminal-attached": "A terminal on the computer is attached to this session.",
};

/** The sentence that tells the user why *Hibernate now* was refused. */
export function hibernateRefusalText(reason: HibernateRefusal): string {
	return REFUSALS[reason];
}

/** `hibernate-settings`: read the settings, or replace them first. `hibernate`: hibernate one session now (answered with an `error` carrying the {@link hibernateRefusalText} when it is not eligible). */
export type HibernateRequest =
	| { t: "hibernate-settings"; reqId: number; settings?: HibernateSettings }
	| { t: "hibernate"; reqId: number; instanceId: string };

export type HibernateReply =
	| { t: "hibernate-settings"; reqId: number; settings: HibernateSettings }
	| { t: "hibernate"; reqId: number; session: HibernatedSession };
