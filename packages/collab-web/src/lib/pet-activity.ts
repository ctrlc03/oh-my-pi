/**
 * What the pet should be doing, as a pure function of what the app already knows: the session's live
 * status, its transcript, its pending question and its task list, or on the home screen the paired
 * computer's session list.
 *
 * Precedence, like Hermes' pets: failed (transient), jumping (transient), waving (transient), waiting
 * (blocked on you), running (a tool executes, or the turn is in flight), review (thinking, or only
 * reading tools run), idle. Transients are raised only by a change observed while live, so a reconnect
 * or a snapshot load never replays them.
 */

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { CompanionHost } from "./companion";
import type { PetState } from "./pet-state";

/** How long each transient state holds before the pet falls back to what the session is doing. */
export const PET_PULSE_MS = { failed: 2500, jumping: 2000, waving: 2000 } as const;

export type PetPulseKind = keyof typeof PET_PULSE_MS;

export interface PetPulse {
	kind: PetPulseKind;
	/** Epoch ms after which the pulse is over. */
	until: number;
}

/** What one snapshot of a session says about the pet; compare two to find a live transition. */
export interface PetSignals {
	/** Connected and not loading a snapshot: only then is a change a real transition rather than catching up. */
	live: boolean;
	/** A question or approval waits for the user. */
	blocked: boolean;
	/** A turn is in flight. */
	working: boolean;
	/** Names of the tools executing now. */
	tools: readonly string[];
	/** The model is streaming a thinking block. */
	thinking: boolean;
	/** Monotonic count of failed tool results, failed turns and error notices seen so far. */
	failures: number;
	/** The task list has tasks and every one of them is done. */
	planDone: boolean;
}

export const IDLE_SIGNALS: PetSignals = {
	live: false,
	blocked: false,
	working: false,
	tools: [],
	thinking: false,
	failures: 0,
	planDone: false,
};

/** Tools that only look: while nothing but these runs, the pet reviews instead of running. */
const READING_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	search: true,
	find: true,
	glob: true,
	ast_grep: true,
	lsp: true,
	web_search: true,
	fetch: true,
	recall: true,
	reflect: true,
};

/** Tools whose run is the agent waiting for the user. */
const ASKING_TOOLS: Readonly<Record<string, true>> = { ask: true };

/** The state a snapshot shows once no transient is playing. */
export function steadyPetState(signals: PetSignals): PetState {
	if (!signals.live) return "idle";
	if (signals.blocked || signals.tools.some(name => Object.hasOwn(ASKING_TOOLS, name))) return "waiting";
	if (!signals.working) return "idle";
	if (signals.tools.some(name => !Object.hasOwn(READING_TOOLS, name))) return "running";
	if (signals.tools.length > 0 || signals.thinking) return "review";
	return "running";
}

/** The pet's state: a playing transient wins over what the session is doing. */
export function derivePetState(signals: PetSignals, pulse: PetPulse | null, now: number): PetState {
	if (pulse !== null && pulse.until > now) return pulse.kind;
	return steadyPetState(signals);
}

const PULSE_RANK: Record<PetPulseKind, number> = { failed: 3, jumping: 2, waving: 1 };

/**
 * The transient after `next` replaced `prev`. Raised only when both snapshots are live, so the first
 * snapshot, a reconnect and a snapshot load play nothing. A new transient replaces one of lower or equal
 * rank; a turn starting retires a lingering wave.
 */
export function stepPulse(
	prev: PetSignals | null,
	next: PetSignals,
	now: number,
	current: PetPulse | null,
): PetPulse | null {
	if (prev === null || !prev.live || !next.live) return null;
	let pulse = current !== null && current.until > now ? current : null;
	if (pulse?.kind === "waving" && next.working && !prev.working) pulse = null;
	const raised: PetPulseKind[] = [];
	if (next.failures > prev.failures) raised.push("failed");
	if (!prev.planDone && next.planDone) raised.push("jumping");
	if (prev.working && !next.working) raised.push("waving");
	for (const kind of raised) {
		if (pulse === null || PULSE_RANK[kind] >= PULSE_RANK[pulse.kind]) {
			pulse = { kind, until: now + PET_PULSE_MS[kind] };
		}
	}
	return pulse;
}

function isFailure(entry: SessionEntry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "toolResult") return message.isError === true;
	return message.role === "assistant" && message.stopReason === "error";
}

/** Failures counted so far over one entry list, so the next snapshot only reads what was appended. */
export interface FailureTally {
	entries: readonly SessionEntry[];
	count: number;
}

/** The tally for `entries`, continuing from `previous` while `entries` is the same list grown at its end. */
export function tallyFailures(entries: readonly SessionEntry[], previous: FailureTally | null): FailureTally {
	let from = 0;
	let count = 0;
	if (
		previous !== null &&
		previous.entries.length <= entries.length &&
		(previous.entries.length === 0 || entries[previous.entries.length - 1] === previous.entries.at(-1))
	) {
		from = previous.entries.length;
		count = previous.count;
	}
	for (let i = from; i < entries.length; i++) if (isFailure(entries[i])) count++;
	return { entries, count };
}

/** The home screen's state from the paired computer's sessions: waiting if any needs you, else running if any works. */
export function homePetState(hosts: readonly Pick<CompanionHost, "busy" | "inputRequired">[], live: boolean): PetState {
	if (!live) return "idle";
	if (hosts.some(host => host.inputRequired)) return "waiting";
	if (hosts.some(host => host.busy === true)) return "running";
	return "idle";
}

/** One word for what the pet is doing: the accessible name, and the speech bubble's text. */
const STATUS_WORD: Record<PetState, string> = {
	idle: "idle",
	"running-right": "idle",
	"running-left": "idle",
	waving: "done",
	jumping: "plan done",
	failed: "failed",
	waiting: "your turn",
	running: "working",
	review: "thinking",
};

export function petStatusWord(state: PetState): string {
	return STATUS_WORD[state];
}

/** The speech bubble's text: "working…", "thinking…", "your turn", "done", "failed". */
export function petBubbleText(state: PetState): string {
	return state === "running" || state === "review" ? `${STATUS_WORD[state]}…` : STATUS_WORD[state];
}
