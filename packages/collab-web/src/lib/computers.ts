/**
 * The computers this device is paired with. Each runs its own companion, in its own relay room, and this app
 * talks to all of them at once: a laptop, a desktop, a server that keeps working when the laptop closes.
 *
 * A computer's id is the room id of its pairing link: the companion keeps one room for the life of its state
 * file, so the id is the same on every device that pairs with it. (`omp companion --rotate` makes a new room and
 * so a new computer: the old entry then reads "not running" until it is removed.)
 *
 * Everything here is pure data over `localStorage` and the lists the runtime hook ({@link useComputers}) shows.
 * Anything that has an instance id must also carry a computer id: two computers can each run an omp process that
 * the other lists under the same instance id.
 */

import type { CompanionClient, CompanionSnapshot, Pairing, PairingLink } from "./companion";
import { parseCollabLink } from "./link";
import { claimLegacyDismissed } from "./inbox";
import { claimLegacyRooms } from "./rooms";
import { claimLegacyOrg } from "./org-storage";
import { readJson, writeJson } from "./storage";

const COMPUTERS_KEY = "omp.collab.computers";
/** Where the one paired computer was kept before there could be several. */
const LEGACY_PAIRING_KEY = "omp.collab.companion";
const LAST_COMPUTER_KEY = "omp.collab.last-computer";
/** A computer whose companion has not reported a machine name yet. */
const UNNAMED = "Computer";

/** A paired computer as stored: the pairing, under the id of its room. */
export interface Computer extends Pairing {
	id: string;
}

/** One computer as the app sees it live: its connection, and what it last reported. */
export interface ComputerHandle {
	id: string;
	/** The machine name the companion reports, made unique among the computers ({@link computerNames}). */
	name: string;
	/** null when the stored link does not parse (`error`). */
	client: CompanionClient | null;
	snap: CompanionSnapshot;
	error: string | null;
}

/** The room id of a pairing link, which names its computer; null when the link does not parse. */
export function computerIdOf(link: string): string | null {
	const parsed = parseCollabLink(link);
	return "error" in parsed ? null : parsed.roomId;
}

function parseComputer(raw: unknown): Computer | null {
	if (typeof raw === "string") return parseComputer({ link: raw });
	if (typeof raw !== "object" || raw === null) return null;
	const { link, invite, device, machine } = raw as Record<string, unknown>;
	if (typeof link !== "string") return null;
	const id = computerIdOf(link);
	if (id === null) return null;
	const computer: Computer = { id, link };
	if (typeof invite === "string") computer.invite = invite;
	const creds = device as Partial<Computer["device"]> | undefined;
	if (typeof creds?.id === "string" && typeof creds.token === "string") {
		computer.device = { id: creds.id, token: creds.token };
	}
	if (typeof machine === "string") computer.machine = machine;
	return computer;
}

/** The computers in a stored list, each once, in the order they were paired; entries that are not pairings are dropped. */
export function parseComputers(raw: unknown): Computer[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: Computer[] = [];
	for (const item of raw) {
		const computer = parseComputer(item);
		if (computer === null || seen.has(computer.id)) continue;
		seen.add(computer.id);
		out.push(computer);
	}
	return out;
}

/**
 * The paired computers. A device that paired before there could be several holds one pairing under another
 * key: it moves into the list (with the data kept per computer: the rooms it opened) and the old key goes.
 */
export function loadComputers(): Computer[] {
	const list = parseComputers(readJson(COMPUTERS_KEY));
	const legacy = readJson(LEGACY_PAIRING_KEY);
	if (legacy === null) return list;
	writeJson(LEGACY_PAIRING_KEY, null);
	const moved = parseComputer(legacy);
	if (moved === null) return list;
	claimLegacyRooms(moved.id);
	claimLegacyDismissed(moved.id);
	claimLegacyOrg(moved.id);
	const next = list.some(computer => computer.id === moved.id) ? list : [...list, moved];
	writeJson(COMPUTERS_KEY, next);
	return next;
}

export function saveComputers(list: readonly Computer[]): void {
	writeJson(COMPUTERS_KEY, list.length === 0 ? null : list);
}

/**
 * `link` added to the list, or, when its computer is already there, updating that entry. A link with an invite
 * buys new credentials, so the old ones go; a link without one (the room link alone) keeps them.
 */
export function addComputer(list: readonly Computer[], link: PairingLink): { list: Computer[]; id: string } | null {
	const id = computerIdOf(link.link);
	if (id === null) return null;
	const at = list.findIndex(computer => computer.id === id);
	if (at < 0) {
		const added: Computer = { id, link: link.link };
		if (link.invite !== undefined) added.invite = link.invite;
		return { list: [...list, added], id };
	}
	const known = list[at]!;
	const updated: Computer = { id, link: link.link };
	if (link.invite !== undefined) updated.invite = link.invite;
	else if (known.invite !== undefined) updated.invite = known.invite;
	if (link.invite === undefined && known.device !== undefined) updated.device = known.device;
	if (known.machine !== undefined) updated.machine = known.machine;
	return { list: list.map((computer, i) => (i === at ? updated : computer)), id };
}

export function removeComputer(list: readonly Computer[], id: string): Computer[] {
	return list.filter(computer => computer.id !== id);
}

/** Pair with the computer `link` names (reading the list fresh: a connection may have stored credentials since the app read it). */
export function pairComputer(link: PairingLink): { list: Computer[]; id: string } | null {
	const added = addComputer(loadComputers(), link);
	if (added !== null) saveComputers(added.list);
	return added;
}

/** Drop a computer from this device. */
export function unpairComputer(id: string): Computer[] {
	const next = removeComputer(loadComputers(), id);
	saveComputers(next);
	return next;
}

/** A connection learned something to keep about its computer (credentials after pairing, the machine name). */
export function rememberPairing(id: string, pairing: Pairing): void {
	const list = loadComputers();
	if (!list.some(computer => computer.id === id)) return;
	saveComputers(list.map(computer => (computer.id === id ? { ...pairing, id } : computer)));
}

/** The computer a session last started on, which the next start offers first. */
export function loadLastComputer(): string | null {
	const raw = readJson(LAST_COMPUTER_KEY);
	return typeof raw === "string" ? raw : null;
}

export function saveLastComputer(id: string | null): void {
	writeJson(LAST_COMPUTER_KEY, id);
}

/**
 * The name each computer is shown under: its machine name, and `name (2)`, `name (3)` for the later ones when
 * machines share a name (two laptops both called `MacBook-Pro`). Order is the pairing order, so a name does not
 * change when another computer is paired.
 */
export function computerNames(entries: readonly { id: string; machine: string | null }[]): Record<string, string> {
	const seen: Record<string, number> = {};
	const names: Record<string, string> = {};
	for (const { id, machine } of entries) {
		const base = machine?.trim() || UNNAMED;
		const count = (Object.hasOwn(seen, base) ? seen[base]! : 0) + 1;
		seen[base] = count;
		names[id] = count === 1 ? base : `${base} (${count})`;
	}
	return names;
}

export function computerById<T extends { id: string }>(
	computers: readonly T[],
	id: string | null | undefined,
): T | null {
	if (id === null || id === undefined) return null;
	return computers.find(computer => computer.id === id) ?? null;
}

/**
 * Which computer lists omp process `instanceId`. Two computers can each have a process under the same id, so an id
 * alone settles it only when one computer lists it: `ambiguous` otherwise.
 */
export type HostLookup = { found: "host"; computer: ComputerHandle } | { found: "none" } | { found: "ambiguous" };

export function findHost(computers: readonly ComputerHandle[], instanceId: string): HostLookup {
	const listing = computers.filter(computer => computer.snap.hosts.some(host => host.instanceId === instanceId));
	if (listing.length === 0) return { found: "none" };
	if (listing.length > 1) return { found: "ambiguous" };
	return { found: "host", computer: listing[0]! };
}

/** What a notification tap (or any request to open a session by instance id) does now. */
export type OpenPlan =
	| { kind: "open"; computer: ComputerHandle }
	| { kind: "wait" }
	| { kind: "error"; message: string };

/**
 * Where to open session `instanceId`, named by a notification tap. `computerId` is the computer the notification came from
 * (absent from companions that predate it): with it only that computer is asked, and the tap waits for it to answer;
 * without it every computer is, and a session two of them list is refused rather than guessed.
 */
export function planOpen(
	computers: readonly ComputerHandle[],
	instanceId: string,
	computerId: string | null,
): OpenPlan {
	const gone: OpenPlan = { kind: "error", message: "That session is no longer sharing." };
	if (computerId !== null) {
		const computer = computerById(computers, computerId);
		if (computer === null) return { kind: "error", message: "That computer is no longer paired with this device." };
		if (computer.snap.phase === "connecting") return { kind: "wait" };
		if (computer.snap.phase !== "live") return { kind: "error", message: `${computer.name} is not reachable.` };
		return computer.snap.hosts.some(host => host.instanceId === instanceId) ? { kind: "open", computer } : gone;
	}
	const lookup = findHost(computers, instanceId);
	if (lookup.found === "host") return { kind: "open", computer: lookup.computer };
	if (lookup.found === "ambiguous") {
		return { kind: "error", message: "More than one computer lists that session. Open it from the sessions list." };
	}
	return computers.some(computer => computer.snap.phase === "connecting") ? { kind: "wait" } : gone;
}

/** What the app remembers of how a session on screen was reached, besides the session itself. */
export interface SessionHint {
	computerId?: string;
	instanceId?: string;
}

/** The computer and omp process that host the session on screen. */
export interface SessionHome {
	/** The computer the session runs on; null when none is known (a link pasted for a session no paired computer lists). */
	computer: ComputerHandle | null;
	/** The process the computer lists for this very session: working tree and file access go through it. */
	hostId: string | null;
	/** `hostId`, else the process the session was opened from or last seen as: the one that reopens its room. */
	instanceId: string | null;
}

/**
 * Where the session on screen runs. By session id first (the computer whose host list names it), and when
 * the session is not listed (not welcomed yet, the computer offline), by what recorded how it was opened:
 * `opened` (this launch), then `stored` (the recent room). A hint's instance id counts only for the computer
 * the hint names, or, with none named, for the one computer that lists it.
 */
export function resolveSessionHome(
	computers: readonly ComputerHandle[],
	sessionId: string | null,
	opened: SessionHint | null,
	stored: SessionHint | null,
): SessionHome {
	const hinted = opened?.computerId ?? stored?.computerId;
	if (sessionId !== null) {
		const listing = computers.filter(computer => computer.snap.hosts.some(host => host.sessionId === sessionId));
		const computer = listing.find(candidate => candidate.id === hinted) ?? listing[0];
		const host = computer?.snap.hosts.find(row => row.sessionId === sessionId);
		if (computer !== undefined && host !== undefined) {
			return { computer, hostId: host.instanceId, instanceId: host.instanceId };
		}
	}
	const instanceId = opened?.instanceId ?? stored?.instanceId ?? null;
	let computer = computerById(computers, hinted);
	if (computer === null && hinted === undefined) {
		const lookup = instanceId === null ? null : findHost(computers, instanceId);
		// With one computer paired, a session no computer lists is still its own (as it was before there could be several).
		computer = lookup?.found === "host" ? lookup.computer : computers.length === 1 ? computers[0]! : null;
	}
	return { computer, hostId: null, instanceId: computer === null ? null : instanceId };
}

/** The word that says why a computer is not answering, shown beside its name. */
export function stateWord(phase: CompanionSnapshot["phase"]): string | null {
	if (phase === "live") return null;
	if (phase === "connecting") return "Connecting…";
	if (phase === "unpaired") return "Needs pairing";
	return "Offline";
}

/** The capability a feature needs, and how a computer that lacks it is described. */
export const FEATURES = {
	start: { can: "canStart", lacks: "can't start sessions" },
	schedule: { can: "canSchedule", lacks: "doesn't run schedules" },
	fanout: { can: "canFanout", lacks: "can't compare models" },
	blueprint: { can: "canBlueprint", lacks: "can't build architecture maps" },
	foreign: { can: "canForeign", lacks: "can't run other agents" },
} as const;

export type Feature = keyof typeof FEATURES;

/** Why `computer` cannot be picked for `feature` right now, or null when it can. */
export function unavailableReason(computer: ComputerHandle, feature: Feature): string | null {
	const { snap } = computer;
	if (snap.phase === "connecting") return "Connecting…";
	if (snap.phase === "offline") return snap.error ?? "Not reachable";
	if (snap.phase === "unpaired") return snap.error ?? "Needs pairing again";
	const { can, lacks } = FEATURES[feature];
	return snap[can] ? null : `This computer ${lacks}. Update omp there.`;
}

/**
 * The computer a new piece of work starts on: the one on screen, else the one used last, else the first
 * that can take it. Null when none can.
 */
export function defaultComputer(
	computers: readonly ComputerHandle[],
	feature: Feature,
	current: string | null,
	last: string | null,
): ComputerHandle | null {
	const usable = (id: string | null): ComputerHandle | null => {
		const computer = computerById(computers, id);
		return computer !== null && unavailableReason(computer, feature) === null ? computer : null;
	};
	return (
		usable(current) ??
		usable(last) ??
		computers.find(computer => unavailableReason(computer, feature) === null) ??
		null
	);
}
