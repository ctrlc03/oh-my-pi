import { isRecord } from "./type-guards";

/**
 * The Personal agent's session channel: what omp's Personal session (`omp --profile personal`) and the
 * collab companion on the same computer say to each other, and the vocabulary both use for where a piece
 * of input came from. Shared by `packages/coding-agent` (the session side) and
 * `packages/collab-web/scripts` (the companion side); the app never sees these types. Spec: docs/personal-agent.md.
 *
 * Three channels, by direction:
 *
 * - **Session → companion** (`notify_owner`, hello, receipts): `POST /personal` on the companion's loopback
 *   server, authorized by the bearer token in `<profile agent dir>/collab-companion-personal-ipc.json`.
 * - **Anything local → companion** (`POST /event`): same server and token file, for scripts and shortcuts.
 *   Whatever the caller says, such an event is `external`.
 * - **Companion → live session** (events): files under `<config root>/run/personal/` that the session
 *   drains when idle (the shape PR watch uses), so an event survives the session being down or restarting.
 *   Events of `trust: "owner"` carry an HMAC the session verifies; nothing the agent can write forges one.
 *
 * Pure: no I/O and no crypto here. Both sides compute the HMAC (SHA-256, hex) over {@link personalEventCanonical}.
 */

// ── names ────────────────────────────────────────────────────────────────────

/** The CLI profile the Personal agent runs under: `omp --profile personal`. */
export const PERSONAL_PROFILE = "personal";

/**
 * Written by the companion into the Personal profile's agent dir (mode 0600): where it listens and the bearer
 * token that authorizes `/personal` and `/event`. The `collab-companion` prefix keeps it unreadable inside
 * omp's shell sandbox, like the schedule endpoint file. The token is not the schedule token.
 */
export const PERSONAL_IPC_FILE = "collab-companion-personal-ipc.json";
/** Same folder, mode 0600: the 32-byte (base64url) key the companion signs owner-trust events with. */
export const PERSONAL_OWNER_KEY_FILE = "collab-companion-personal-owner.key";
/** Folder of the event channel under `<config root>/run/` (the config root is profile-independent, like `run/pr-watch`). */
export const PERSONAL_RUN_DIR = "personal";

/** What the personal IPC file holds; the same shape as the schedule endpoint. */
export interface PersonalIpcEndpoint {
	port: number;
	token: string;
	pid: number;
}

// ── where input came from ────────────────────────────────────────────────────

/**
 * Who wrote a memory or an input, as stored in Mnemopi's `author_type`:
 * `owner` (`trust_tier` `TRUSTED`), `agent` (`DERIVED`), `external` (`UNTRUSTED`).
 */
export type PersonalOrigin = "owner" | "agent" | "external";
/** The origin of a turn's trigger. `guest` is never stored: a guest turn is not retained at all. */
export type PersonalTurnOrigin = PersonalOrigin | "guest";

/** Mnemopi `trust_tier` per origin. */
export const PERSONAL_TRUST_TIER: Readonly<Record<PersonalOrigin, string>> = {
	owner: "TRUSTED",
	agent: "DERIVED",
	external: "UNTRUSTED",
};

/** Mnemopi `author_id` per origin; `external` rows append `:<source>` (e.g. `external:github`). */
export const PERSONAL_AUTHOR_ID: Readonly<Record<PersonalOrigin, string>> = {
	owner: "owner",
	agent: "agent:personal",
	external: "external",
};

/** `customType` of the hidden follow-up an event becomes in the session (`display: false`, `attribution: "agent"`). */
export const PERSONAL_EVENT_MESSAGE_TYPE = "personal-event";

/** `details` of a `custom_message` with `customType === "personal-event"`. */
export interface PersonalEventDetails {
	id: string;
	source: string;
	kind: PersonalEventKind;
	trust: PersonalEventTrust;
}

/**
 * The origin of the turn an entry starts, or undefined when the entry starts none (assistant text, tool
 * results, notices, compaction). Plain user messages are the owner (typed in the terminal, or the companion's
 * launch prompt); collab prompts are `details.origin` (the host stamps `owner` for every writer of a Personal
 * session: see `CollabPromptDetails.origin`), `guest` when it says so; events are `owner` or `external`.
 * Shape-only, so a journal entry and a wire entry both fit.
 */
export function personalEntryOrigin(entry: {
	type: string;
	customType?: string;
	details?: unknown;
	message?: { role?: string };
}): PersonalTurnOrigin | undefined {
	if (entry.type === "message") return entry.message?.role === "user" ? "owner" : undefined;
	if (entry.type !== "custom_message") return undefined;
	const details = isRecord(entry.details) ? entry.details : {};
	if (entry.customType === "collab-prompt") return details.origin === "guest" ? "guest" : "owner";
	if (entry.customType === PERSONAL_EVENT_MESSAGE_TYPE) return details.trust === "owner" ? "owner" : "external";
	return undefined;
}

// ── events (companion → live session) ────────────────────────────────────────

/** `owner`: the companion itself (an answer from the app, an owner-made schedule): signed. `external`: everything else. */
export type PersonalEventTrust = "owner" | "external";

/**
 * What an event is for:
 * - `event`: something happened (a script, GitHub, a poll's result is not an event: it is the poll's turn);
 * - `answer`: the owner answered a question the agent asked (`ref` = the inbox item id; the answer is in `body`);
 * - `about-updated`: an About-you change was accepted; `body` carries the full new text, which the session adds to its context (a running session reads `AGENTS.md` only at start);
 * - `schedule`: a schedule aimed at the Personal agent fired (`deliverTo: "personal"`);
 * - `poll`: a source (an MCP-backed inbox or calendar check) is due; `body` is the owner-written instruction;
 * - `rollover`: the companion is about to end this session; `body` asks for a handoff note as the reply;
 * - `control`: not a turn. `body` is `exit`: finish the turn in progress, retain and consolidate memory, exit.
 */
export type PersonalEventKind = "event" | "answer" | "about-updated" | "schedule" | "poll" | "rollover" | "control";

/** Kinds that bypass the session's per-hour event limits: owner-driven or housekeeping, and rare. */
export const PERSONAL_UNMETERED_KINDS: readonly PersonalEventKind[] = [
	"answer",
	"about-updated",
	"rollover",
	"control",
];

/** An event as the companion normalises and stores it, and as the session receives it. */
export interface PersonalEvent {
	/** File-name-safe (`/^[A-Za-z0-9_-]{1,128}$/`); see {@link PERSONAL_EVENT_ID_RE}. */
	id: string;
	/** Who produced it: `script`, `github`, `schedule:<id>`, `source:<id>`, `owner-answer`, `companion` … One short token; the per-source rate limit keys on it. */
	source: string;
	kind: PersonalEventKind;
	/** Ms since epoch. */
	at: number;
	/** One line. */
	title: string;
	/** The text the agent reads. Fenced as untrusted when `trust` is `external`. */
	body: string;
	url?: string;
	trust: PersonalEventTrust;
	/** The inbox item or proposal an `answer`/`about-updated` event is about. */
	ref?: string;
	/** HMAC-SHA256 (hex) of {@link personalEventCanonical} under the owner key. Required when `trust` is `owner`; absent otherwise. */
	mac?: string;
}

export const PERSONAL_EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_EVENT_TITLE_CHARS = 200;
export const MAX_EVENT_BODY_CHARS = 8_000;
export const MAX_EVENT_URL_CHARS = 1_000;
export const MAX_EVENT_SOURCE_CHARS = 64;
/** `POST /event` and `POST /personal` bodies larger than this are refused (413). */
export const MAX_PERSONAL_BODY_BYTES = 64 * 1024;
/** The companion accepts at most this many `POST /event` per source per minute (429 beyond). */
export const EVENT_INGRESS_PER_MINUTE = 30;
/** Pending events kept per computer; the oldest external ones are dropped (status `expired`) beyond this. */
export const MAX_PENDING_EVENTS = 200;
/** An event not delivered within this long is `expired`: it would be stale news. Owner answers never expire. */
export const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
/** A claim (`claimed/<sessionId>/`) of a session that stopped beating this long ago goes back to `inbox/`. */
export const EVENT_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Files under `<config root>/run/personal/`:
 * - `inbox/<name>.json`: pending events, written by the companion (temp file + rename), `name` from {@link personalEventFileName};
 * - `claimed/<sessionId>/<name>.json`: the session renamed it here to take it; it is removed once the follow-up was queued;
 * - `beat.json` ({@link PersonalBeat}): the session's heartbeat, refreshed every {@link PERSONAL_BEAT_MS}.
 * Sorted by name, `inbox/` is oldest first.
 */
export function personalEventFileName(event: Pick<PersonalEvent, "id" | "at">): string {
	return `${String(event.at).padStart(13, "0")}-${event.id}.json`;
}

/** The Personal session's heartbeat: the companion reads it to tell a live session from a stale claim. */
export interface PersonalBeat {
	sessionId: string;
	pid: number;
	at: number;
	busy: boolean;
	/** Waiting on an answer from the owner (an ask or an approval). */
	inputRequired: boolean;
	/** A rolling spend limit stopped the session: it takes no event until the window passes. */
	capped?: "day" | "month";
}
export const PERSONAL_BEAT_MS = 15_000;
export const PERSONAL_BEAT_FRESH_MS = 3 * PERSONAL_BEAT_MS;

/** The text the HMAC covers: every field that decides what the agent reads or how it is trusted, in a fixed order. */
export function personalEventCanonical(event: PersonalEvent): string {
	return JSON.stringify([
		event.id,
		event.source,
		event.kind,
		event.at,
		event.title,
		event.body,
		event.url ?? "",
		event.trust,
		event.ref ?? "",
	]);
}

const EVENT_KINDS: Record<PersonalEventKind, true> = {
	event: true,
	answer: true,
	"about-updated": true,
	schedule: true,
	poll: true,
	rollover: true,
	control: true,
};

/** Read a stored {@link PersonalEvent}; undefined when `raw` is not one (size limits are the producer's job). */
export function parsePersonalEvent(raw: unknown): PersonalEvent | undefined {
	if (!isRecord(raw)) return undefined;
	const { id, source, kind, at, title, body, url, trust, ref, mac } = raw;
	if (typeof id !== "string" || !PERSONAL_EVENT_ID_RE.test(id)) return undefined;
	if (typeof source !== "string" || source === "" || source.length > MAX_EVENT_SOURCE_CHARS) return undefined;
	if (typeof kind !== "string" || !Object.hasOwn(EVENT_KINDS, kind)) return undefined;
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	if (typeof title !== "string" || typeof body !== "string") return undefined;
	if (trust !== "owner" && trust !== "external") return undefined;
	return {
		id,
		source,
		kind: kind as PersonalEventKind,
		at,
		title,
		body,
		...(typeof url === "string" ? { url } : {}),
		trust,
		...(typeof ref === "string" ? { ref } : {}),
		...(typeof mac === "string" ? { mac } : {}),
	};
}

/**
 * `POST /event` body. Everything but `title` and `body` is optional. The companion stores it as a
 * {@link PersonalEvent} of `kind: "event"` and `trust: "external"` whatever the caller sends (there is no way
 * to post as the owner): `source` is prefixed `script:` unless it already names a known producer, `id` makes
 * a repeated post a duplicate (answered `duplicate: true`, delivered once).
 */
export interface PersonalEventInput {
	/** Idempotency key, `/^[A-Za-z0-9_.:@-]{1,128}$/`; per `source`. Absent: every post is new. */
	id?: string;
	/** Producer, `/^[A-Za-z0-9_.:-]{1,64}$/` (default `script`). */
	source?: string;
	title: string;
	body: string;
	url?: string;
	/** Ms since epoch; default now. Clamped to the last 24 hours (older news is refused as stale). */
	at?: number;
}

export type PersonalEventPostReply = { ok: true; id: string; duplicate: boolean } | { ok: false; error: string };

// ── the agent talking to the owner (session → companion) ─────────────────────

/**
 * `info`: a message. `question`: needs an answer (`options` = quick replies; a free-text answer is always allowed).
 * `proposal`: a change to About you (`proposal` is required). `digest`: "What I learned today", only from a review run.
 * Info, question and proposal push to the owner's devices; a digest does not unless `quiet` is false.
 */
export type NotifyKind = "info" | "question" | "proposal" | "digest";

export const MAX_NOTIFY_TITLE_CHARS = 120;
export const MAX_NOTIFY_BODY_CHARS = 4_000;
export const MAX_NOTIFY_OPTIONS = 6;
export const MAX_NOTIFY_OPTION_CHARS = 80;
export const MAX_PROPOSAL_TEXT_CHARS = 600;
export const MAX_DIGEST_BODY_CHARS = 8_000;

/** A proposed change to About you, as the agent writes it: one bullet at a time, never a rewrite. */
export interface PersonalProposalDraft {
	/** `add` a line under `section`; `replace` the line `target` with `text`; `remove` the line `target`. */
	op: "add" | "replace" | "remove";
	/** A heading of the About-you file (`How I like to work`); `add` goes at the end of it, creating it when absent. */
	section?: string;
	/** An existing line of About you (compared trimmed, without the list marker); required for `replace` and `remove`. */
	target?: string;
	/** The line to add or the replacement (without a list marker); not used by `remove`. */
	text?: string;
	/** Why, in the agent's words: the evidence ("asked for squash merges 4 times this week"). */
	rationale: string;
	/** Memory ids the proposal rests on. */
	evidence?: string[];
}

/** The `notify_owner` tool's arguments. */
export interface NotifyOwnerInput {
	title: string;
	body: string;
	kind: NotifyKind;
	/** `question` only. */
	options?: string[];
	/** `proposal` only. */
	proposal?: PersonalProposalDraft;
	/** `digest` only: the day the digest covers (`YYYY-MM-DD`), and the memory ids it names as learned. */
	digest?: { day: string; learned?: string[] };
	/** Push or not. Default: true except for `digest`. */
	push?: boolean;
}

/** `POST /personal` body. */
export type PersonalIpcRequest =
	/** The session made `item` for the owner. `origin` is the trigger of the turn that called the tool; the companion records it, and marks a proposal made in an `external` turn. */
	| { op: "notify"; sessionId: string; runKind: "live" | "review"; origin: PersonalTurnOrigin; item: NotifyOwnerInput }
	/** The session is up: lets the companion learn its id and pid before the registry lists it. */
	| { op: "hello"; sessionId: string; pid: number; runKind: "live" | "review" }
	/** What became of an event: the companion shows it in the app's event list. */
	| { op: "receipt"; sessionId: string; eventId: string; outcome: PersonalReceiptOutcome; detail?: string };

export type PersonalReceiptOutcome = "delivered" | "rate-limited" | "refused" | "failed" | "capped";

export type PersonalIpcReply =
	| { ok: true; itemId: string; pushed: boolean }
	| { ok: true }
	| { ok: false; error: string };
