/**
 * The Personal agent in the companion room: what the app asks the collab companion on the computer that hosts
 * the Personal agent ("the home computer"), and what it answers. Companion ↔ app only; the companion ↔
 * session channel is `personal-ipc.ts`. Spec: docs/personal-agent.md.
 *
 * Opt-in. A companion advertises `canPersonal` in its `hosts` frame when it can serve these requests, and
 * only the computer the owner set it up on has `PersonalStatus.enabled`. Every field this file adds to an
 * existing frame is optional, so an old app or an old companion ignores it (protocol version unchanged).
 *
 * Request/answer pairs share one `t`; the answer carries the request's `reqId`. A failure is the companion's
 * ordinary `{ t: "error", reqId, message }`. Requests that change something also cause a `personal-changed` push.
 */

import type {
	NotifyKind,
	PersonalEventKind,
	PersonalEventTrust,
	PersonalOrigin,
	PersonalProposalDraft,
} from "./personal-ipc";

// ── constants the app and the companion agree on ─────────────────────────────

/** Defaults the companion writes at setup and the app shows. `limits` of 0 mean "no limit". */
export const PERSONAL_DEFAULTS = {
	/** Calendar day (local midnight to midnight) and calendar month (local) spend limits, USD. */
	limits: { dayUsd: 5, monthUsd: 50 },
	/** Nightly learning review: local time, spend cap of one review run, USD. */
	review: { enabled: true, time: "03:30", budgetUsd: 0.5 },
	/** Daily rollover to a fresh session (the app shows one thread): local time, taken when the session is idle. */
	rollover: { time: "04:00" },
	/** Backups: a daily run at `time` (local, not configurable), DB snapshots kept; the session-JSONL mirror is never pruned. */
	backup: { time: "03:00", keepDaily: 30, keepMonthly: 12 },
	/** About you is kept short on purpose: it is loaded into every session. */
	aboutMaxTokens: 1_500,
	/** A `warning` level is reported from this share of a limit; `capped` at 100%. */
	spendWarnShare: 0.8,
} as const;

/** The command the owner runs once, in a terminal on the home computer, to give the Personal agent its own login. */
export const PERSONAL_LOGIN_COMMAND = "omp --profile personal login";

export const MAX_ABOUT_BYTES = 16 * 1024;
export const MAX_MEMORY_PAGE = 100;
/** One `personal-memory-export` chunk is at most this many characters of text. */
export const MAX_EXPORT_CHUNK_CHARS = 1_000_000;

// ── status ───────────────────────────────────────────────────────────────────

/**
 * `off`: not set up or switched off. `stopped`: on, but no session is running (not started, or the owner
 * stopped it). `starting`/`idle`/`working`: a session is up. `waiting`: it asked the owner something and is
 * blocked on the answer. `failed`: the last start failed, or it keeps dying (`error` says why).
 */
export type PersonalRunState = "off" | "stopped" | "starting" | "idle" | "working" | "waiting" | "failed";

/** `missing`: the profile holds no usable credential: the owner has to run {@link PERSONAL_LOGIN_COMMAND}. */
export interface PersonalLogin {
	state: "missing" | "ready";
	/** Providers with a usable credential (or a keyed provider in the profile's `models.yml`). */
	providers: string[];
	command: string;
	checkedAt: number;
}

export type PersonalSpendLevel = "off" | "ok" | "warning" | "capped";

export interface PersonalSpendWindow {
	usd: number;
	/** null = no limit. */
	limitUsd: number | null;
	level: PersonalSpendLevel;
	/** Start of the window, ms (local midnight / first of the month). */
	since: number;
}

export interface PersonalSpend {
	day: PersonalSpendWindow;
	month: PersonalSpendWindow;
}

export interface PersonalBackupStatus {
	/** Absolute folder on the home computer. */
	folder: string;
	/** The default folder, which is on the same disk as the memory: worth a warning. */
	sameDisk: boolean;
	lastAt: number | null;
	lastOk: boolean | null;
	lastError?: string;
	dailyKept: number;
	monthlyKept: number;
	nextAt: number | null;
}

export interface PersonalReviewStatus {
	lastAt: number | null;
	ok: boolean | null;
	costUsd: number | null;
	/** Proposals the last review made. */
	proposals: number;
	digestId?: string;
	error?: string;
	/** Why the last due review did not run, when it did not. */
	skipped?: "disabled" | "no-login" | "spend-limit" | "nothing-new" | "agent-busy";
	nextAt: number | null;
}

export interface PersonalSessionInfo {
	/** omp session id of the live session. */
	sessionId: string;
	/** The collab host instance (`CompanionHost.instanceId`) the app opens as the one Personal thread. */
	instanceId: string | null;
	startedAt: number;
	/** The daily rollover moves to a new session; the thread in the app continues. */
	generation: number;
}

export interface PersonalStatus {
	/** The profile layout exists (setup ran). */
	setUp: boolean;
	/** On: keep-alive, events, sources, review and backups run. Only one computer has this true. */
	enabled: boolean;
	/** The computer this status is about. The app shows it as the home computer. */
	homeComputer: { computerId: string; machine: string };
	login: PersonalLogin;
	run: PersonalRunState;
	session: PersonalSessionInfo | null;
	spend: PersonalSpend;
	backups: PersonalBackupStatus;
	review: PersonalReviewStatus;
	nextRolloverAt: number | null;
	/** Open things for the owner: unanswered questions, pending proposals, unread digests. */
	counts: { questions: number; proposals: number; digests: number };
	/** Bumped on every change; mirrors `hosts.personalRev`. */
	rev: number;
	error?: string;
}

// ── settings ─────────────────────────────────────────────────────────────────

/**
 * An email, calendar or other inbox the Personal agent checks. The check is a scheduled headless turn of the
 * Personal agent that uses the MCP server named here (configured by the owner in the profile's `mcp.json`);
 * its answer is an `external` event. Nothing is polled until the owner adds one.
 */
export interface PersonalSource {
	id: string;
	label: string;
	kind: "mcp-poll";
	/** A server name in the profile's `mcp.json`. */
	mcpServer: string;
	everyMinutes: number;
	/** What to check and report, in the owner's words ("any unread mail from my landlord"). */
	prompt: string;
	enabled: boolean;
	lastPollAt?: number;
	lastError?: string;
}

export interface PersonalSettings {
	/** Calendar day / month spend limits, USD; 0 = none. Enforced by the session; the companion mirrors them into the profile's config. */
	limits: { dayUsd: number; monthUsd: number };
	review: { enabled: boolean; /** `HH:MM`, local. */ time: string; budgetUsd: number };
	rollover: { /** `HH:MM`, local. */ time: string };
	/** null = the default folder inside the profile. */
	backup: { folder: string | null };
	sources: PersonalSource[];
}

/** Sections merge; `sources` replaces the list. */
export interface PersonalSettingsPatch {
	limits?: Partial<PersonalSettings["limits"]>;
	review?: Partial<PersonalSettings["review"]>;
	rollover?: Partial<PersonalSettings["rollover"]>;
	backup?: Partial<PersonalSettings["backup"]>;
	sources?: PersonalSource[];
}

// ── memory ───────────────────────────────────────────────────────────────────

export type PersonalMemoryStore = "working" | "episodic";

/** One memory, as the Memory screen shows it. Invalidated memories are kept (never deleted) and shown struck through. */
export interface PersonalMemory {
	/** Mnemopi row id; unique across `store` (the companion prefixes `w:` / `e:`). */
	id: string;
	store: PersonalMemoryStore;
	content: string;
	/** ISO 8601. */
	createdAt: string;
	/** ISO 8601; the day the memory is about, when the extraction found one. */
	eventDate?: string;
	origin: PersonalOrigin;
	/** Writer id: `owner`, `agent:personal`, `external:<source>`. */
	authorId: string;
	trustTier: string;
	importance: number;
	/** Pinned: injected every turn; the agent cannot invalidate it. */
	pinned: boolean;
	/** Not true any more: retracted by the owner, or superseded by `replacedBy`. */
	invalid: boolean;
	/** ISO 8601. */
	invalidAt?: string;
	/** Who invalidated it: the owner (a retraction the agent cannot undo) or the agent (a correction). */
	invalidBy?: "owner" | "agent";
	/** The memory that replaced it. */
	replacedBy?: string;
	/** How many memories this one replaced; absent when none, so the app offers "Earlier versions" only where there are some. */
	replacesCount?: number;
	/** The session it was learned in, so the app can open that conversation. */
	sessionId?: string;
	recallCount: number;
}

export interface PersonalMemoryQuery {
	/** Keywords (full-text); omitted = newest first. */
	q?: string;
	origin?: PersonalOrigin[];
	pinnedOnly?: boolean;
	/** Include invalidated memories (default false). */
	includeInvalid?: boolean;
	/** ISO 8601 bounds on `createdAt`. */
	since?: string;
	until?: string;
	limit?: number;
	offset?: number;
}

export type PersonalExportFormat = "json" | "markdown";

export interface PersonalExportChunk {
	/** Suggested file name, e.g. `personal-memory-2027-01-31.json`. */
	name: string;
	mime: string;
	/** UTF-8 text of this part; concatenating the parts in order gives the whole file. */
	text: string;
	/** Pass back as `offset` for the next part; null = this was the last part. */
	next: number | null;
}

// ── About you ────────────────────────────────────────────────────────────────

export interface PersonalAbout {
	/** The whole file (`AGENTS.md` in the profile's agent dir). */
	text: string;
	/** Counts every accepted change, from 1 (the template at setup). */
	rev: number;
	updatedAt: number;
	/** Rough token count (4 characters ≈ 1 token); the app warns past {@link PERSONAL_DEFAULTS}.aboutMaxTokens. */
	tokens: number;
}

export interface PersonalAboutVersion {
	rev: number;
	at: number;
	by: "setup" | "owner" | "proposal";
	proposalId?: string;
	text: string;
}

export interface PersonalDiffLine {
	op: "keep" | "add" | "del";
	text: string;
}

export type PersonalProposalStatus = "pending" | "accepted" | "rejected" | "superseded";

/** A change to About you the agent proposed; nothing in About you changes until the owner accepts. */
export interface PersonalProposal extends Omit<PersonalProposalDraft, "text"> {
	id: string;
	at: number;
	status: PersonalProposalStatus;
	/** The line to add or its replacement; the owner's edit lands here. */
	text: string;
	/** True when the owner changed `text` before accepting. */
	edited: boolean;
	/** The About-you revision the proposal was made against. */
	baseRev: number;
	/** The agent made it in a turn that read outside content: the app shows a warning. */
	fromExternal: boolean;
	/** The inbox item that announced it. */
	itemId: string;
	/** Lines of About you around the change, with the change marked, against the current revision. */
	diff: PersonalDiffLine[];
	decidedAt?: number;
}

// ── inbox, digests, events ───────────────────────────────────────────────────

/**
 * What the agent or the companion has for the owner, kept until acted on (the push notification is only the
 * nudge). `alert` is the companion's own: a spend limit reached, a backup that failed, the login lost, the
 * session failing to start.
 */
export type PersonalInboxKind = NotifyKind | "alert";

export interface PersonalInboxItem {
	id: string;
	kind: PersonalInboxKind;
	title: string;
	body: string;
	at: number;
	/** `question`: quick replies. */
	options?: string[];
	proposalId?: string;
	digestId?: string;
	/** Who caused it: an item made in a turn that read outside content says `external`. */
	origin: PersonalOrigin;
	/** `open`: waiting for the owner. `done`: answered / accepted / rejected / read (see `answer`). */
	state: "open" | "done";
	answer?: { option?: string; text?: string; at: number };
	/** Another computer's companion never sees this; the app marks it read on every device. */
	readAt?: number;
}

/** The nightly "What I learned today". */
export interface PersonalDigest {
	id: string;
	at: number;
	/** `YYYY-MM-DD` it covers. */
	day: string;
	title: string;
	/** Markdown. */
	body: string;
	/** Memories the review stored or changed. */
	learned: string[];
	proposals: string[];
	costUsd: number;
	read: boolean;
}

export type PersonalEventStatus = "queued" | "delivered" | "rate-limited" | "refused" | "expired" | "failed" | "capped";

export interface PersonalEventRecord {
	id: string;
	source: string;
	kind: PersonalEventKind;
	trust: PersonalEventTrust;
	at: number;
	title: string;
	url?: string;
	status: PersonalEventStatus;
	detail?: string;
	deliveredAt?: number;
}

// ── requests ─────────────────────────────────────────────────────────────────

/**
 * - `personal-status` → `{ status }`
 * - `personal-setup` `{ about? }`: create or repair the profile layout (idempotent) and enable. `about` = the initial About-you text (else the template). → `{ status }`. Needs a write (paired) device.
 * - `personal-enable` / `personal-disable` → `{ status }`. Disable stops the session and every background job and keeps all memory, history and settings.
 * - `personal-control` `{ action }`: `start`, `stop` (graceful: retain + consolidate), `restart` (rollover now, with a handoff). → `{ status }`
 * - `personal-backup-now` → `{ ok, error?, status }`. Makes a backup now, even when nothing changed since the last. Answers when it is done; a backup that fails is `ok: false` with its `error` (and `status.backups` has it too). Refused while a backup is already running. Optional: a companion that predates it answers an error.
 * - `personal-settings-get` → `{ settings, mcpServers }` (`mcpServers` = server names in the profile's `mcp.json`, for the source picker)
 * - `personal-settings-set` `{ patch }` → `{ settings, mcpServers }`
 * - `personal-memory-search` `{ query }` → `{ items, total }`
 * - `personal-memory-get` `{ id }` → `{ memory, replaces }` (`replaces`: memories this one replaced; `memory` null = unknown id)
 * - `personal-memory-retract` `{ id }` → `{ memory }`. Invalidates it (kept, struck through, the agent cannot undo it) and records `invalidBy: "owner"`.
 * - `personal-memory-pin` / `personal-memory-unpin` `{ id }` → `{ memory }`
 * - `personal-memory-export` `{ format, offset? }` → `PersonalExportChunk`. Includes invalidated memories.
 * - `personal-about-get` → `{ about }`; `personal-about-set` `{ text, baseRev }` → `{ about, saved }` (`saved: false` = `baseRev` was stale; `about` is the current one)
 * - `personal-about-history` `{ limit? }` → `{ versions }` (newest first)
 * - `personal-proposals` `{ status? }` → `{ proposals }` (default `pending`; newest first)
 * - `personal-proposal-edit` `{ id, text }` → `{ proposal }` (changes the proposed line, stays pending)
 * - `personal-proposal-accept` `{ id }` → `{ proposal, about, applied }` (`applied: false`: the target line is gone or it was already decided; `about` is current)
 * - `personal-proposal-reject` `{ id }` → `{ proposal }` (remembered, so the same proposal is not made again)
 * - `personal-digests` `{ limit?, before? }` → `{ digests }`; `personal-digest-read` `{ id }` → `{ digest }`
 * - `personal-inbox` `{ includeDone?, limit? }` → `{ items }`; `personal-inbox-ack` `{ ids }` → `{ items }` (marks read)
 * - `personal-answer` `{ itemId, option?, text? }` → `{ item }`. Becomes an owner-signed `answer` event for the agent.
 * - `personal-events` `{ limit?, before? }` → `{ events }` (newest first)
 */
export type PersonalRequest =
	| { t: "personal-status"; reqId: number }
	| { t: "personal-setup"; reqId: number; about?: string }
	| { t: "personal-enable"; reqId: number }
	| { t: "personal-disable"; reqId: number }
	| { t: "personal-control"; reqId: number; action: "start" | "stop" | "restart" }
	| { t: "personal-backup-now"; reqId: number }
	| { t: "personal-settings-get"; reqId: number }
	| { t: "personal-settings-set"; reqId: number; patch: PersonalSettingsPatch }
	| { t: "personal-memory-search"; reqId: number; query: PersonalMemoryQuery }
	| { t: "personal-memory-get"; reqId: number; id: string }
	| { t: "personal-memory-retract"; reqId: number; id: string }
	| { t: "personal-memory-pin"; reqId: number; id: string }
	| { t: "personal-memory-unpin"; reqId: number; id: string }
	| { t: "personal-memory-export"; reqId: number; format: PersonalExportFormat; offset?: number }
	| { t: "personal-about-get"; reqId: number }
	| { t: "personal-about-set"; reqId: number; text: string; baseRev: number }
	| { t: "personal-about-history"; reqId: number; limit?: number }
	| { t: "personal-proposals"; reqId: number; status?: PersonalProposalStatus }
	| { t: "personal-proposal-edit"; reqId: number; id: string; text: string }
	| { t: "personal-proposal-accept"; reqId: number; id: string }
	| { t: "personal-proposal-reject"; reqId: number; id: string }
	| { t: "personal-digests"; reqId: number; limit?: number; before?: number }
	| { t: "personal-digest-read"; reqId: number; id: string }
	| { t: "personal-inbox"; reqId: number; includeDone?: boolean; limit?: number }
	| { t: "personal-inbox-ack"; reqId: number; ids: string[] }
	| { t: "personal-answer"; reqId: number; itemId: string; option?: string; text?: string }
	| { t: "personal-events"; reqId: number; limit?: number; before?: number };

/** What the companion answers; each carries the request's `reqId`, except the push. */
export type PersonalReply =
	| { t: "personal-status"; reqId: number; status: PersonalStatus }
	| { t: "personal-setup"; reqId: number; status: PersonalStatus }
	| { t: "personal-enable"; reqId: number; status: PersonalStatus }
	| { t: "personal-disable"; reqId: number; status: PersonalStatus }
	| { t: "personal-control"; reqId: number; status: PersonalStatus }
	| { t: "personal-backup-now"; reqId: number; ok: boolean; error?: string; status: PersonalStatus }
	| { t: "personal-settings-get"; reqId: number; settings: PersonalSettings; mcpServers: string[] }
	| { t: "personal-settings-set"; reqId: number; settings: PersonalSettings; mcpServers: string[] }
	| { t: "personal-memory-search"; reqId: number; items: PersonalMemory[]; total: number }
	| { t: "personal-memory-get"; reqId: number; memory: PersonalMemory | null; replaces: PersonalMemory[] }
	| { t: "personal-memory-retract"; reqId: number; memory: PersonalMemory }
	| { t: "personal-memory-pin"; reqId: number; memory: PersonalMemory }
	| { t: "personal-memory-unpin"; reqId: number; memory: PersonalMemory }
	| ({ t: "personal-memory-export"; reqId: number } & PersonalExportChunk)
	| { t: "personal-about-get"; reqId: number; about: PersonalAbout }
	| { t: "personal-about-set"; reqId: number; about: PersonalAbout; saved: boolean }
	| { t: "personal-about-history"; reqId: number; versions: PersonalAboutVersion[] }
	| { t: "personal-proposals"; reqId: number; proposals: PersonalProposal[] }
	| { t: "personal-proposal-edit"; reqId: number; proposal: PersonalProposal }
	| {
			t: "personal-proposal-accept";
			reqId: number;
			proposal: PersonalProposal;
			about: PersonalAbout;
			applied: boolean;
	  }
	| { t: "personal-proposal-reject"; reqId: number; proposal: PersonalProposal }
	| { t: "personal-digests"; reqId: number; digests: PersonalDigest[] }
	| { t: "personal-digest-read"; reqId: number; digest: PersonalDigest }
	| { t: "personal-inbox"; reqId: number; items: PersonalInboxItem[] }
	| { t: "personal-inbox-ack"; reqId: number; items: PersonalInboxItem[] }
	| { t: "personal-answer"; reqId: number; item: PersonalInboxItem }
	| { t: "personal-events"; reqId: number; events: PersonalEventRecord[] }
	| PersonalChanged;

/** What a `personal-changed` push says moved, so a client refetches only that. */
export type PersonalChangeKind =
	| "status"
	| "inbox"
	| "about"
	| "proposals"
	| "digests"
	| "memory"
	| "events"
	| "settings";

/** Pushed to every authenticated device (no `reqId`) when something changes; the same news also arrives as a Web Push when the owner's attention is needed. */
export interface PersonalChanged {
	t: "personal-changed";
	what: PersonalChangeKind[];
	/** The new `PersonalStatus.rev`. */
	rev: number;
}

/** Any `personal-*` request without its `reqId`. */
export type PersonalCall = PersonalRequest extends infer R ? (R extends unknown ? Omit<R, "reqId"> : never) : never;
/** The reply to the `personal-*` request of type `T`. */
export type PersonalAnswer<T extends PersonalRequest["t"]> = Extract<PersonalReply, { t: T }>;

// ── additions to existing frames ─────────────────────────────────────────────

/** Optional fields the companion adds to its `hosts` frame. */
export interface PersonalHostsFields {
	/** The companion serves the `personal-*` requests. */
	canPersonal?: boolean;
	/** `PersonalStatus.rev`, so a client refetches only when it moved. Present while the agent is enabled. */
	personalRev?: number;
}

/** Optional field on a `CompanionHost` row: this host is the Personal agent's live session. */
export interface PersonalHostMark {
	personal?: true;
}

/**
 * Hash routes the app opens for the Personal agent (`#personal`, `#personal/inbox` …). The companion's Web Push
 * payloads name one in `open` (the service worker passes it to the app, as for other notices) with `tag` set
 * to `personal-<kind>`, so a newer notice replaces one still on screen. The app parses them.
 */
export const PERSONAL_ROUTES = {
	thread: "personal",
	inbox: "personal/inbox",
	memory: "personal/memory",
	about: "personal/about",
	settings: "personal/settings",
} as const;
