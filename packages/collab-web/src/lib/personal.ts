/**
 * The Personal agent as the app sees it: which paired computer is its home, what its sidebar entry shows, and the
 * small pure helpers its screens share (routes, proposal diffs, spend bars, export assembly). No I/O and no React:
 * the hooks are in ./use-personal.ts. Spec: docs/personal-agent.md.
 *
 * Personal lives on ONE computer (the owner picks it in the setup flow). Memory is never synced, so every other
 * computer only reaches the agent through the app, and says "open the home computer" where it would act.
 */

import type { PersonalOrigin } from "@oh-my-pi/pi-wire/personal-ipc";
import {
	PERSONAL_ROUTES,
	type PersonalDiffLine,
	type PersonalExportChunk,
	type PersonalInboxItem,
	type PersonalMemory,
	type PersonalRunState,
	type PersonalSpendLevel,
	type PersonalSpendWindow,
	type PersonalStatus,
} from "@oh-my-pi/pi-wire/personal";
import type { CompanionHost } from "./companion";
import type { ComputerHandle } from "./computers";
import { readJson, writeJson } from "./storage";

// ── the home computer ────────────────────────────────────────────────────────

/** What this device last learned of the home computer, kept so an unreachable one is still shown as Personal's home. */
export interface RememberedHome {
	computerId: string;
	/** Personal was on when last seen. */
	enabled: boolean;
}

const HOME_KEY = "omp.collab.personal-home";

export function loadRememberedHome(): RememberedHome | null {
	const raw = readJson(HOME_KEY);
	if (typeof raw !== "object" || raw === null) return null;
	const { computerId, enabled } = raw as Record<string, unknown>;
	return typeof computerId === "string" && typeof enabled === "boolean" ? { computerId, enabled } : null;
}

export function saveRememberedHome(home: RememberedHome | null): void {
	writeJson(HOME_KEY, home);
}

/** Computers that can host Personal right now: reachable, and serving the `personal-*` requests. */
export function hostableComputers(computers: readonly ComputerHandle[]): ComputerHandle[] {
	return computers.filter(
		computer => computer.client !== null && computer.snap.phase === "live" && computer.snap.canPersonal,
	);
}

export interface HomeChoice {
	/** The home computer; null when Personal is not set up anywhere this device knows of. */
	computer: ComputerHandle | null;
	/** Its status as last answered (null before the first answer, or when it was never reachable this launch). */
	status: PersonalStatus | null;
	/** The home computer is not reachable now: the app says so calmly, it is never an error. */
	offline: boolean;
	/** Other computers that are set up too: only the first is used and the settings warn about the rest. */
	duplicates: ComputerHandle[];
}

/**
 * The home computer. Computers whose status says set up are candidates (in pairing order): the enabled one wins; with none
 * enabled, the first set-up one (turning it back on happens there). When no computer has answered as set up, the one this
 * device remembers as home stands in while it is not reachable. `statuses` holds the last answer of each computer asked.
 */
export function chooseHome(
	computers: readonly ComputerHandle[],
	statuses: Readonly<Record<string, PersonalStatus>>,
	remembered: RememberedHome | null,
): HomeChoice {
	const known = (computer: ComputerHandle): PersonalStatus | null =>
		Object.hasOwn(statuses, computer.id) ? statuses[computer.id]! : null;
	const setUp = computers.filter(computer => known(computer)?.setUp === true);
	const enabled = setUp.filter(computer => known(computer)?.enabled === true);
	const chosen = enabled[0] ?? setUp[0] ?? null;
	if (chosen !== null) {
		return {
			computer: chosen,
			status: known(chosen),
			offline: chosen.snap.phase !== "live",
			duplicates: setUp.filter(computer => computer !== chosen),
		};
	}
	// Nothing answered as set up: a remembered, enabled home that is not live (or not asked yet) stands in for it.
	const stand =
		remembered?.enabled === true ? computers.find(computer => computer.id === remembered.computerId) : undefined;
	if (stand !== undefined && stand.snap.phase !== "live") {
		return { computer: stand, status: known(stand), offline: true, duplicates: [] };
	}
	return { computer: null, status: null, offline: false, duplicates: [] };
}

/**
 * Why Personal cannot be set up on `computer` right now, or null when it can: it is the home computer's job, so another
 * computer that is already set up refuses (the app owns this rule; the companions do not know of each other).
 */
export function setupBlockedReason(home: HomeChoice, computer: ComputerHandle): string | null {
	if (home.computer !== null && home.computer.id !== computer.id) {
		return `Personal already lives on ${home.computer.name}. Turn it off there and keep its memory, or keep using that computer.`;
	}
	return null;
}

// ── the host row ─────────────────────────────────────────────────────────────

/** The Personal agent's live session among `hosts`, if the home computer lists one. */
export function personalHostOf(hosts: readonly CompanionHost[]): CompanionHost | null {
	return hosts.find(host => host.personal === true) ?? null;
}

/** `hosts` without the Personal row (it is pinned above the sessions, not listed twice); the same array when it holds none. */
export function withoutPersonal<T extends { personal?: true }>(hosts: readonly T[]): readonly T[] {
	return hosts.some(host => host.personal === true) ? hosts.filter(host => host.personal !== true) : hosts;
}

/** The sidebar entry's one-line state. */
export interface EntryState {
	label: string;
	/** `ok`: idle; `busy`: working or starting; `warn`: waiting on the owner; `off`: not running; `bad`: failed. */
	tone: "ok" | "busy" | "warn" | "off" | "bad";
	/** The live session can be opened as the one thread. */
	thread: boolean;
	/** A Start button instead of the thread: the session is stopped or between rollovers. */
	startable: boolean;
}

const RUN_LABELS: Record<PersonalRunState, string> = {
	off: "Off",
	stopped: "Stopped",
	starting: "Starting…",
	idle: "Ready",
	working: "Working",
	waiting: "Waiting for you",
	failed: "Failed to start",
};

const RUN_TONES: Record<PersonalRunState, EntryState["tone"]> = {
	off: "off",
	stopped: "off",
	starting: "busy",
	idle: "ok",
	working: "busy",
	waiting: "warn",
	failed: "bad",
};

/** A spend window's limit is reached: the session takes no new prompts and events wait. */
export function spendCapped(status: PersonalStatus): boolean {
	return status.spend.day.level === "capped" || status.spend.month.level === "capped";
}

/** A capped run is not "Ready" or "Waiting for you": nothing it is sent is processed until the window passes. */
function cappedRun(status: PersonalStatus): boolean {
	return (status.run === "idle" || status.run === "waiting") && spendCapped(status);
}

/** The run state in words and tone, where the spend limit shows through. */
export function runSummary(status: PersonalStatus): Pick<EntryState, "label" | "tone"> {
	if (cappedRun(status)) return { label: "Spend limit reached", tone: "warn" };
	return { label: RUN_LABELS[status.run], tone: RUN_TONES[status.run] };
}

/** What the pinned entry shows for the home computer (`host`: its live Personal row, when listed). */
export function entryState(
	status: PersonalStatus | null,
	offline: boolean,
	host: CompanionHost | null,
	canStart: boolean,
): EntryState {
	if (offline) return { label: "Home computer is offline", tone: "off", thread: false, startable: false };
	if (status === null) return { label: "Checking…", tone: "busy", thread: false, startable: false };
	const run = status.run;
	const alive = run === "starting" || run === "idle" || run === "working" || run === "waiting";
	const thread = alive && host !== null;
	// Between rollovers the session is briefly not listed: show the state instead of a dead thread.
	const startable = canStart && !thread && (run === "stopped" || run === "failed");
	if (status.login.state === "missing" && !alive) {
		return { label: "Needs a login", tone: "warn", thread: false, startable: false };
	}
	return { ...runSummary(status), thread, startable };
}

/** Open things for the owner: unanswered questions, pending proposals and unread digests. */
export function openCount(status: PersonalStatus | null): number {
	if (status === null) return 0;
	const { questions, proposals, digests } = status.counts;
	return questions + proposals + digests;
}

// ── routes ───────────────────────────────────────────────────────────────────

export type PersonalRoute = keyof typeof PERSONAL_ROUTES;

/**
 * The Personal route a notification or hash names (`personal`, `personal/inbox`, …), or null. A `&computer=<id>`
 * suffix is not part of it: notify-route splits that off first.
 */
export function parsePersonalRoute(route: string): PersonalRoute | null {
	for (const name of Object.keys(PERSONAL_ROUTES) as PersonalRoute[]) {
		if (PERSONAL_ROUTES[name] === route) return name;
	}
	return null;
}

// ── proposals ────────────────────────────────────────────────────────────────

export interface DiffRow {
	op: PersonalDiffLine["op"];
	/** `+`, `−` or a space: not colour alone says what changed. */
	marker: "+" | "\u2212" | " ";
	/** For assistive tech. */
	word: "Added" | "Removed" | "Unchanged";
	text: string;
}

const DIFF_ROWS: Record<PersonalDiffLine["op"], Pick<DiffRow, "marker" | "word">> = {
	keep: { marker: " ", word: "Unchanged" },
	add: { marker: "+", word: "Added" },
	del: { marker: "\u2212", word: "Removed" },
};

/** A proposal's diff lines as rows to render. Unchanged lines far from a change are not shown: `context` keeps that many either side. */
export function diffRows(lines: readonly PersonalDiffLine[], context = 2): DiffRow[] {
	const changed = lines.map(line => line.op !== "keep");
	const near = lines.map((_, i) => {
		for (let at = Math.max(0, i - context); at <= Math.min(lines.length - 1, i + context); at++)
			if (changed[at]) return true;
		return false;
	});
	const rows: DiffRow[] = [];
	for (const [i, line] of lines.entries()) {
		if (near[i] || changed.every(c => !c)) rows.push({ op: line.op, ...DIFF_ROWS[line.op], text: line.text });
	}
	return rows;
}

// ── spend ────────────────────────────────────────────────────────────────────

export interface SpendBar {
	/** Fill, 0 to 1 (a window over its limit shows full). 0 when there is no limit. */
	share: number;
	level: PersonalSpendLevel;
	/** "$4.30 of $5.00", or "$4.30 so far" without a limit. */
	text: string;
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

export function spendBar(window: PersonalSpendWindow): SpendBar {
	if (window.limitUsd === null || window.limitUsd <= 0) {
		return { share: 0, level: "off", text: `${money(window.usd)} so far` };
	}
	return {
		share: Math.min(1, Math.max(0, window.usd / window.limitUsd)),
		level: window.level,
		text: `${money(window.usd)} of ${money(window.limitUsd)}`,
	};
}

// ── memory ───────────────────────────────────────────────────────────────────

export interface OriginLabel {
	/** Short: "You", "Agent", "External". */
	label: string;
	/** Where it came from: `github` of `external:github`; null when the writer id says nothing more. */
	source: string | null;
	/** What the origin means for recall. */
	hint: string;
}

const ORIGINS: Record<PersonalOrigin, Omit<OriginLabel, "source">> = {
	owner: { label: "You", hint: "Said by you. Recalled by default." },
	agent: { label: "Agent", hint: "The agent's own conclusion. Recalled, labelled as derived." },
	external: {
		label: "External",
		hint: "From outside (web, GitHub, email, events). Only used when you ask for it, and always fenced.",
	},
};

export function originLabel(memory: Pick<PersonalMemory, "origin" | "authorId">): OriginLabel {
	const colon = memory.authorId.indexOf(":");
	const source = memory.origin === "external" && colon > 0 ? memory.authorId.slice(colon + 1) : null;
	return { ...ORIGINS[memory.origin], source };
}

/** Where a memory sits in its life, in words (the struck-through ones are kept, never deleted). */
export function memoryState(memory: Pick<PersonalMemory, "invalid" | "invalidBy" | "pinned" | "replacedBy">): string {
	if (memory.invalid) {
		if (memory.invalidBy === "owner") return "Retracted by you";
		return memory.replacedBy === undefined ? "Hidden by the agent" : "Replaced";
	}
	return memory.pinned ? "Pinned" : "Active";
}

/** An export as one text: the chunks' parts joined in order. `fetch` is asked for `offset`s until a chunk says it is the last. */
export async function assembleExport(
	fetch: (offset: number | undefined) => Promise<PersonalExportChunk>,
): Promise<{ name: string; mime: string; text: string }> {
	const parts: string[] = [];
	let offset: number | undefined;
	let first: PersonalExportChunk | null = null;
	for (let guard = 0; guard < 10_000; guard++) {
		const chunk = await fetch(offset);
		first ??= chunk;
		parts.push(chunk.text);
		if (chunk.next === null) return { name: first.name, mime: first.mime, text: parts.join("") };
		if (offset !== undefined && chunk.next <= offset) throw new Error("the computer sent the export out of order");
		offset = chunk.next;
	}
	throw new Error("the export has too many parts");
}
// ── inbox ────────────────────────────────────────────────────────────────────

/** One thing in the merged inbox: a session waiting on the owner, or something from the Personal agent. */
export type MergedInboxItem<S extends { at: number }> =
	| { source: "session"; at: number; item: S; computerId: string }
	| { source: "personal"; at: number; item: PersonalInboxItem };

/**
 * Session items and Personal items in one list, newest first. Open Personal items (a question, a pending proposal)
 * come before finished ones of any age: they stay until acted on.
 */
export function mergeInbox<S extends { at: number }>(
	sessions: readonly { computerId: string; item: S }[],
	personal: readonly PersonalInboxItem[],
): MergedInboxItem<S>[] {
	const merged: MergedInboxItem<S>[] = [
		...sessions.map(({ computerId, item }): MergedInboxItem<S> => ({
			source: "session",
			at: item.at,
			item,
			computerId,
		})),
		...personal.map((item): MergedInboxItem<S> => ({ source: "personal", at: item.at, item })),
	];
	const pinned = (entry: MergedInboxItem<S>): number =>
		entry.source === "personal" && entry.item.state === "open" ? 1 : 0;
	return merged.sort((a, b) => pinned(b) - pinned(a) || b.at - a.at);
}
