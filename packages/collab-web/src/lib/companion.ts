/**
 * Companion pairing: one long-lived encrypted room per computer, opened by
 * `scripts/companion.ts`, that lists every omp session hosting collab on that
 * machine and hands out their control links on request.
 *
 * The room rides the normal relay with the normal sealing, so the relay sees
 * ciphertext only. The room key alone gets a device nothing: it must
 * authenticate with the credentials the companion issued when it paired (a
 * one-time invite in the pairing link buys them). Those credentials are a
 * standing capability for every session on the machine: they live in this
 * origin's storage and nowhere else.
 *
 * Pairing link form: `pair:<collab link>&invite=<invite>`, inside a web URL
 * fragment (`https://web/#pair:<link>&invite=<invite>`) or as plain pasted text.
 */

import { CAN_INFLATE, importRoomKey } from "./codec";
import { recordEvent } from "./diag-log";
import { parseCollabLink } from "./link";
import { CollabSocket } from "./socket";
import { readJson, writeJson } from "./storage";

export const PAIR_PREFIX = "pair:";
const PAIRING_KEY = "omp.collab.companion";
/** Separates the room link from the one-time invite in a pairing link. */
const INVITE_MARK = "&invite=";
const INVITE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** A companion that predates authentication never answers `auth`; the client then asks for the host list anyway. */
const LEGACY_PROBE_MS = 4_000;
/** How long a request waits for the companion's answer. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Starting a session waits for omp to boot and publish its room. */
const START_TIMEOUT_MS = 60_000;
/** A worktree start also waits for the checkout (up to 60s) before omp boots. */
const WORKTREE_START_TIMEOUT_MS = 120_000;
/** Usage and session listings may wait on a stats sync of every session file. */
const USAGE_TIMEOUT_MS = 60_000;
/** Commits wait on hooks and checkout. */
const GIT_WRITE_TIMEOUT_MS = 60_000;
/** Pushes and pull requests talk to the remote. */
const GIT_REMOTE_TIMEOUT_MS = 120_000;
/** The first code map request indexes the whole repository (later ones only re-parse changed files). */
const CODEMAP_TIMEOUT_MS = 180_000;
/** Installing an omp update downloads and replaces the install: the companion allows it five minutes. */
const UPDATE_TIMEOUT_MS = 330_000;
/** A preview capture waits for the page (the companion allows its Chrome 20s) and for the queue of captures before it. */
const PREVIEW_TIMEOUT_MS = 45_000;
/** Transcribing loads the speech model on first use, then decodes the recording on the computer's CPU. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Setting up voice input downloads the speech model (hundreds of MB) and its runtime. */
const TRANSCRIBE_SETUP_TIMEOUT_MS = 30 * 60_000;
/** Pings sent per round-trip measurement; the median is reported. */
const PING_SAMPLES = 3;

/** One collab-hosting omp process, as `omp collab list --json` reports it. */
export interface CompanionHost {
	instanceId: string;
	/** Session id of the hosted conversation; matches the guest's `SessionHeader.id`. */
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	/** `provider/id`, or null before a model is selected. */
	model: string | null;
	startedAt: number;
	/** Includes the host itself. */
	participants: number;
	/** null when the host omp predates the field: unknown, not idle. */
	busy: boolean | null;
	inputRequired: boolean;
	relayConnected: boolean;
	/** Started sandboxed: file tools only, writes confined to `cwd`. Absent from companions that predate it. */
	sandboxed?: boolean;
}

/** An interactive omp process on the computer that is not hosting collab; `share` starts it hosting. */
export interface CompanionIdleSession {
	instanceId: string;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	/** `provider/id`, or null before a model is selected. */
	model: string | null;
	startedAt: number;
	busy: boolean | null;
	/** See {@link CompanionHost.sandboxed}. */
	sandboxed?: boolean;
}

/** On battery at or below this charge the computer counts as low: the app warns, the companion pushes once per discharge. */
export const LOW_BATTERY_PCT = 20;

/** What keeps the computer, and so every session on it, reachable. */
export interface CompanionPower {
	/** Mains or stored energy (battery, UPS); null when `pmset` does not say. */
	source: "ac" | "battery" | null;
	/** Internal battery charge, 0–100; null on a Mac without one. */
	battery: number | null;
	/** The companion holds a sleep assertion: no idle sleep while it runs. Closing the lid still sleeps the Mac. */
	awake: boolean;
}

/** One changed path in a session's working tree. */
export interface GitFileChange {
	/** Repo-relative path (the new path of a rename). */
	path: string;
	/** `git status --porcelain=v1` XY code, e.g. ` M`, `A `, `??`. */
	status: string;
	/** Line counts against HEAD; null for binary files. */
	added: number | null;
	removed: number | null;
}

export interface GitCommit {
	hash: string;
	subject: string;
	author: string;
	/** Unix ms. */
	time: number;
}

/** Working tree of the repository containing a session's cwd. */
export interface GitSnapshot {
	/** Absolute repository root. */
	root: string;
	/** null on a detached HEAD. */
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	files: GitFileChange[];
	/** Most recent commits on HEAD, newest first. */
	commits: GitCommit[];
}

/** The session's branch against its base branch, for reviewing before a pull request. */
export interface GitReview {
	/** Absolute root of the checkout. */
	root: string;
	/** null on a detached HEAD. */
	branch: string | null;
	/** Branch a pull request targets (`origin/main`), or null when none was found. */
	base: string | null;
	mergeBase: string | null;
	/** On the base branch itself: committing, pushing and pull requests are refused. */
	isDefaultBranch: boolean;
	/** Uncommitted changes (including untracked files). */
	dirty: boolean;
	/** Changed paths from the merge-base to the working tree, untracked ones included. */
	files: GitFileChange[];
	/** Commits from the merge-base to HEAD, newest first. */
	commits: GitCommit[];
	/** Origin's URL without credentials. */
	remote: string | null;
	/** The branch has an upstream and HEAD equals it. */
	pushed: boolean;
	pr: { number: number; url: string; state: string; title: string } | null;
	/** The checkout is a linked git worktree. */
	worktree: boolean;
}

/** A read-only file read inside a session's repository (or cwd outside a repository). */
export interface FileContent {
	/** Path relative to the repository root (or cwd). */
	path: string;
	/** Bytes on disk. */
	size: number;
	/** UTF-8 text, or null for a binary file. */
	text: string | null;
	truncated: boolean;
}

/** A folder omp sessions ran in, from the local session store, newest first. */
export interface RecentFolder {
	cwd: string;
	lastActive: number;
	/** Most recent sessions there, newest first. */
	sessions: { id: string; title: string | null; lastActive: number }[];
}

export type UsageRange = "24h" | "7d" | "30d" | "90d" | "all";

/** Token and spend totals from the omp stats database, for every session on the computer. */
export interface UsageReport {
	range: UsageRange;
	/** When the stats database was last synced from the session files (Unix ms). */
	syncedAt: number;
	overall: {
		requests: number;
		cost: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		/** input + output + cacheRead + cacheWrite. */
		totalTokens: number;
		/** Share of prompt input tokens served from cache (0-1). */
		cacheRate: number;
		/** Requests with token usage but no known price. */
		unpricedRequests: number;
	};
	/** Oldest first; hourly buckets for `24h`, daily otherwise. `t` is the bucket start (Unix ms). */
	series: { t: number; cost: number; tokens: number; requests: number }[];
	/** Highest spend first. */
	byModel: { model: string; provider: string; cost: number; requests: number; tokens: number }[];
	/** Highest spend first. */
	byProject: { folder: string; cost: number; requests: number; tokens: number }[];
}

/** One omp session from the session store, with its totals (subagents folded in). */
export interface SessionOverview {
	sessionId: string;
	title: string | null;
	folder: string;
	startedAt: number;
	endedAt: number | null;
	requests: number;
	toolCalls: number;
	subagents: number;
	tokens: number;
	cost: number;
	models: string[];
	/** Present when the session is hosting collab or listed as idle right now. */
	instanceId?: string;
	live?: "host" | "idle";
	/** The folder is a git worktree the companion created and it still exists: it can be removed once no omp runs in it. */
	worktree?: boolean;
}

/** A session's tmux pane as the terminal showed it, with ANSI escape sequences kept. */
export interface PaneCapture {
	/** `session:window.pane`; null when the session does not run inside tmux (then `text` says why). */
	target: string | null;
	text: string;
	cols: number;
	rows: number;
	/** When the screen was captured (Unix ms). */
	at: number;
}

/** Screen sizes a preview renders at, in CSS pixels. */
export type PreviewViewport = "phone" | "tablet" | "desktop";

/** Device pixels per CSS pixel in a preview image. */
export const PREVIEW_SCALE = 2;

/** A screenshot of a local page taken on the paired computer. */
export interface PreviewShot {
	/** Base64 of the image bytes. */
	data: string;
	mimeType: string;
	/** Image size in device pixels. */
	width: number;
	height: number;
	/** The page that was captured. */
	url: string;
	/** When it was captured (Unix ms). */
	at: number;
}

/** A dev server listening on the computer that runs from a session's repository. */
export interface PreviewTarget {
	url: string;
	port: number;
	/** Name of the listening process, e.g. `node` or `bun`. */
	command: string;
}

/** Voice input on the computer: the local speech model it transcribes with. */
export interface TranscribeInfo {
	/** Model name, e.g. "Parakeet TDT v3". */
	model: string;
	/** Approximate download size, e.g. "~680 MB". */
	size: string;
	/** The model is downloaded: recordings transcribe without a setup step. */
	ready: boolean;
}

/** A session in the inbox: waiting on an answer (`input`) or finished a turn recently (`done`). */
export interface InboxItem {
	instanceId: string;
	title: string;
	cwd: string;
	kind: "input" | "done";
	/** The pending question (`input`) or the start of the last reply (`done`); null when the session file cannot be read. */
	text: string | null;
	/** Option labels when the question is a single-choice select. */
	options?: string[];
	/** When the question was asked or the reply finished (Unix ms). */
	at: number;
}

/** Spend (USD) at which the companion pushes an alert; null disables that limit. */
export interface SpendLimits {
	/** Spend since local midnight across every session. */
	dailyUsd: number | null;
	/** Total spend of one session. */
	sessionUsd: number | null;
}

/** What a code map view centres on. Paths are repository-relative; `""` is the repository root. */
export type CodemapFocus =
	| { kind: "dir"; path: string }
	| { kind: "file"; path: string }
	/** A symbol by its defining file, name as shown (`Owner::name` for members) and first line. */
	| { kind: "symbol"; path: string; name: string; line: number };

/** A folder, source file, or symbol of the indexed repository (test and fixture files are left out). */
export interface CodemapNode {
	kind: "dir" | "file" | "symbol";
	/** Repository-relative folder or file; a symbol's defining file. */
	path: string;
	/** Base name for folders and files; the qualified name for symbols. */
	label: string;
	/** `rust`, `sol`, `noir`, `ts`, `js`, `py`, `go` or `other`; a folder's most common language by file count. */
	lang: string;
	/** Folders: source files below it. */
	files?: number;
	/** Folders and files: symbols defined below or in it. */
	symbols?: number;
	/** Symbols: `function`, `struct`, `event`, … */
	symbolKind?: string;
	/** Symbols: line span in `path`. */
	line?: number;
	endLine?: number;
	/** Symbols: signature (at most ~140 chars) and the first sentence of the doc comment. */
	signature?: string;
	doc?: string;
}

/**
 * A neighbour of the focus. `label` reads from the focus (`calls`, `decoded by`, `references`);
 * `weight` counts the references behind a folder or file link (1 for symbol links);
 * `bridge` marks cross-language and event links.
 */
export interface CodemapLink {
	node: CodemapNode;
	label: string;
	weight: number;
	bridge: boolean;
}

/** A link between two nodes of {@link CodemapMap}, by index into its `nodes`. */
export interface CodemapEdge {
	from: number;
	to: number;
	weight: number;
	bridge: boolean;
}

/** A folder's contents and the links among them. */
export interface CodemapMap {
	nodes: CodemapNode[];
	edges: CodemapEdge[];
	/** Children left out by the node cap (the least connected go first). */
	omitted: number;
}

/** One step of a walk from the focus symbol; `from` indexes the step it was reached from (null for the focus). */
export interface CodemapFlowStep {
	node: CodemapNode;
	hop: number;
	from: number | null;
	label: string | null;
	bridge: boolean;
}

export type CodemapFlowDirection = "down" | "up";

/**
 * The neighbourhood of one focus. Upstream is what uses or feeds the focus (callers, emitters,
 * folders and files referencing it), downstream what it uses or leads to. Folder views roll
 * outside paths up to the folder that branches off the focus's ancestry; file views list files.
 */
export interface CodemapView {
	/** Repository folder name. */
	repo: string;
	focus: CodemapNode;
	/** Folders from the root (`""`, labelled with the repo name) down to the focus's parent. */
	crumbs: CodemapNode[];
	upstream: CodemapLink[];
	downstream: CodemapLink[];
	/** Links beyond the caps. */
	moreUpstream: number;
	moreDownstream: number;
	/** Folder: subfolders then files; file: its symbols in line order; symbol: its members. */
	children: CodemapNode[];
	/** Folder views only. */
	map?: CodemapMap;
	/** Symbol views requested with a flow direction only: the walk, the focus first. */
	flow?: CodemapFlowStep[];
	/** Index totals and how long refreshing it took for this answer. */
	index: { files: number; symbols: number; refreshMs: number };
}

/** One change of the companion's own relay connection, on the computer's clock. */
export interface CompanionRelayEvent {
	at: number;
	kind: "open" | "close";
	detail: string;
}

/** A request the companion failed to answer, as the app saw the error text too. */
export interface CompanionRequestError {
	at: number;
	/** The request type (`git`, `start`, …). */
	type: string;
	message: string;
}

/** How the companion is doing, for the diagnostics screen. */
export interface CompanionDiag {
	/** The computer's clock when it answered: `events` and `errors` times are on that clock. */
	now: number;
	/** Short git sha of the checkout the companion runs from; null outside a git checkout. */
	version: string | null;
	/** That checkout had uncommitted changes when the companion started. */
	dirty: boolean;
	/** `omp --version`; null when omp does not answer. */
	omp: string | null;
	startedAt: number;
	uptimeMs: number;
	/** How sessions are listed (the registry, or `omp collab list`) and how long the last listing took. */
	listing: { method: "registry" | "cli"; lastMs: number | null };
	/** The companion holds the sleep assertion. */
	keepAwake: boolean;
	power: CompanionPower | null;
	/** `launchd` restarts the companion on demand; a manually started one cannot be restarted from the app. */
	managed: "launchd" | "manual";
	/** Devices connected to the room, this one included. */
	devices: number;
	/** Oldest first, at most 20. */
	events: CompanionRelayEvent[];
	/** Oldest first, at most 10. */
	errors: CompanionRequestError[];
}

export type MaintainAction = "restart-companion" | "update-omp";

/** `PushSubscription.toJSON()` as the browser hands it out. */
export interface PushSubscriptionJson {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

/** An omp process on the computer that has a session open. */
export interface SessionHolder {
	pid: number;
	/** Terminal it runs in, e.g. `ttys014`; null when it has none. */
	tty: string | null;
	/** App the process runs under (a terminal emulator, or `tmux`); null when unknown. */
	app: string | null;
}

/** `start` refused to resume a session another omp on the computer has open; `force` resumes it anyway. */
export class SessionOpenElsewhereError extends Error {
	readonly holders: SessionHolder[];

	constructor(holders: SessionHolder[]) {
		super("This session is open in another omp on the computer.");
		this.name = "SessionOpenElsewhereError";
		this.holders = holders;
	}
}

export type CompanionRequest =
	/** `zip`: this device opens compressed frames; the companion compresses larger replies to it. */
	| { t: "list"; zip?: boolean }
	/**
	 * First frame of every connection: the companion ignores a device it has not authenticated.
	 * `device` (issued when it paired) or a one-time `invite` (which pairs it under `name`).
	 */
	| { t: "auth"; name: string; device?: DeviceCreds; invite?: string }
	| { t: "devices"; reqId: number }
	| { t: "device-rename"; reqId: number; deviceId: string; name: string }
	/** Unpair a device: it is dropped with its push subscription and served nothing more. */
	| { t: "device-revoke"; reqId: number; deviceId: string }
	/** A one-time pairing link (valid 10 minutes) for another device. */
	| { t: "invite"; reqId: number }
	| { t: "link"; reqId: number; instanceId: string }
	/** Add (`on`) or drop this device's Web Push subscription. */
	| { t: "push"; reqId: number; subscription: PushSubscriptionJson; on: boolean }
	/** The device is showing the app (`visible`): the companion holds pushes to `endpoint` meanwhile. */
	| { t: "presence"; endpoint: string | null; visible: boolean }
	/** Companion health: versions, uptime, listing, relay events, recent request errors. */
	| { t: "diag"; reqId: number }
	/** Answered with `ok`; the app times the round trip. */
	| { t: "ping"; reqId: number }
	/** `restart-companion` (launchd-managed only) or `update-omp` (refused while a session works). */
	| { t: "maintain"; reqId: number; action: MaintainAction }
	| { t: "git"; reqId: number; instanceId: string }
	/** Unified diff of one path against HEAD; an untracked file diffs as wholly added. */
	| { t: "git-diff"; reqId: number; instanceId: string; path: string }
	/** `path` is absolute or relative to the session cwd; it must resolve inside the repository (or cwd). */
	| { t: "file"; reqId: number; instanceId: string; path: string }
	| { t: "folders"; reqId: number }
	/**
	 * Start omp in `cwd` (resuming session `resume` when given), hosting with control access;
	 * `sandboxed`: file read/search/edit tools only, with writes confined to `cwd` (needs `canSandbox`);
	 * `worktree` (new sessions inside a git repository only): run on a new branch in its own git worktree.
	 * Resuming a session another omp has open is refused (an error with `openElsewhere`) unless `force`;
	 * a session that is already hosting is answered with its host.
	 */
	| {
			t: "start";
			reqId: number;
			cwd: string;
			resume?: string;
			sandboxed?: boolean;
			worktree?: { branch?: string };
			force?: boolean;
	  }
	/** Make an idle session host collab; answered with a `link`. */
	| { t: "share"; reqId: number; instanceId: string }
	/** The branch against its base branch, with commit, push and pull request state. */
	| { t: "git-review"; reqId: number; instanceId: string }
	/** Diff of one path from the review's merge-base to the working tree. */
	| { t: "git-review-diff"; reqId: number; instanceId: string; path: string }
	/** `git add -A && git commit -m message`; refused while the agent works or on the base branch. */
	| { t: "git-commit"; reqId: number; instanceId: string; message: string }
	/** `git push -u origin HEAD`; same refusals as `git-commit`. */
	| { t: "git-push"; reqId: number; instanceId: string }
	/** `gh pr create` for the pushed branch; answered with a `link` to the pull request (needs `canPr`). */
	| { t: "pr-create"; reqId: number; instanceId: string; title: string; body: string; draft?: boolean }
	/** Remove the linked worktree at `path` when no omp runs in it and it is clean; the branch stays. */
	| { t: "worktree-remove"; reqId: number; path: string }
	/** Spend and token totals across every omp session on the computer. */
	| { t: "usage"; reqId: number; range: UsageRange }
	/** Sessions that need input or finished a turn recently. */
	| { t: "inbox"; reqId: number }
	/** Read (no `limits`) or replace the spend alert limits. */
	| { t: "spend-limits"; reqId: number; limits?: SpendLimits }
	/** Past and live sessions across projects, newest activity first; `q` filters by title or folder. */
	| { t: "sessions"; reqId: number; limit?: number; q?: string }
	/** The session's terminal: the screen of the tmux pane running it, plus recent scrollback. */
	| { t: "pane"; reqId: number; instanceId: string }
	/** Sessions that changed `path` (absolute, or relative to the repository root) in the session's repository; answered with `sessions`. */
	| { t: "file-sessions"; reqId: number; instanceId: string; path: string }
	/** Code map of the session's repository around `focus` (needs `canCodemap`); `flow` adds a walk for symbol foci. */
	| { t: "codemap"; reqId: number; instanceId: string; focus: CodemapFocus; flow?: CodemapFlowDirection }
	/** Files whose path matches `q`, then symbols matching its words. */
	| { t: "codemap-search"; reqId: number; instanceId: string; q: string }
	/** Screenshot `url` (a loopback http(s) page) in headless Chrome at `viewport`, the whole page when `fullPage` (needs `canPreview`). */
	| { t: "preview"; reqId: number; instanceId: string; url: string; viewport: PreviewViewport; fullPage?: boolean }
	/** Dev servers listening on the computer that run from the session's repository (needs `canPreview`). */
	| { t: "preview-targets"; reqId: number; instanceId: string }
	/** Text of a voice recording, transcribed on the computer (needs `transcribe`); `audio` is the base64 of the recording. */
	| { t: "transcribe"; reqId: number; audio: string; mimeType: string }
	/** Download the speech model and its runtime; answered once transcribing can run (needs `transcribe`). */
	| { t: "transcribe-setup"; reqId: number };

export type CompanionReply =
	/**
	 * `vapidKey`: the companion's Web Push application server key (base64url).
	 * `idle`: sessions that could `share` (empty when the omp CLI cannot list them).
	 * `canStart`: the companion can `start` sessions (tmux available); `canSandbox`: sandboxed ones too.
	 */
	| {
			t: "hosts";
			machine: string;
			hosts: CompanionHost[];
			vapidKey: string;
			/** Absent from companions that predate it. */
			idle?: CompanionIdleSession[];
			canStart?: boolean;
			canSandbox?: boolean;
			canPr?: boolean;
			/** The companion can build code maps (its omp checkout loads the codemap index). */
			canCodemap?: boolean;
			/** The companion can screenshot local pages (it found Chrome or another Chromium browser). */
			canPreview?: boolean;
			/** The companion can transcribe voice recordings, and with which model; absent when it cannot. */
			transcribe?: TranscribeInfo;
			/** Power of the computer; absent off macOS and from companions that predate it. */
			power?: CompanionPower;
	  }
	| { t: "link"; reqId: number; url: string }
	/** `token`: the credentials issued to a device that paired with an invite; absent when it authenticated with its own. */
	| { t: "authed"; deviceId: string; token?: string }
	/** The companion refuses this device and serves it nothing more. */
	| { t: "auth-failed"; message: string }
	| { t: "devices"; reqId: number; devices: CompanionDevice[]; self: string }
	/** A one-time pairing link for a new device; `expiresAt` in ms since epoch. */
	| { t: "invite"; reqId: number; url: string; expiresAt: number }
	| { t: "ok"; reqId: number }
	| { t: "diag"; reqId: number; diag: CompanionDiag }
	/** What the maintenance command printed (trimmed). */
	| { t: "maintain"; reqId: number; output: string }
	/** `openElsewhere`: why a `start` that resumes a session was refused; see {@link SessionOpenElsewhereError}. */
	| { t: "error"; reqId: number; message: string; openElsewhere?: SessionHolder[] }
	| { t: "git"; reqId: number; git: GitSnapshot }
	| { t: "diff"; reqId: number; diff: string; truncated: boolean }
	| { t: "file"; reqId: number; file: FileContent }
	| { t: "folders"; reqId: number; folders: RecentFolder[] }
	| { t: "review"; reqId: number; review: GitReview }
	/** The started session is hosting and listed under `instanceId`. */
	| { t: "started"; reqId: number; instanceId: string }
	| { t: "usage"; reqId: number; usage: UsageReport }
	| { t: "inbox"; reqId: number; items: InboxItem[] }
	| { t: "spend-limits"; reqId: number; limits: SpendLimits }
	| { t: "sessions"; reqId: number; sessions: SessionOverview[] }
	| { t: "pane"; reqId: number; pane: PaneCapture }
	| { t: "codemap"; reqId: number; view: CodemapView }
	| { t: "codemap-search"; reqId: number; hits: CodemapNode[] }
	| { t: "preview"; reqId: number; shot: PreviewShot }
	| { t: "preview-targets"; reqId: number; targets: PreviewTarget[] }
	| { t: "transcribe"; reqId: number; text: string }
	| { t: "transcribe-setup"; reqId: number };

/** Credentials the companion issued to a paired device. */
export interface DeviceCreds {
	id: string;
	token: string;
}

/** What a pairing link carries: the room link, and the one-time invite that lets this device pair. */
export interface PairingLink {
	link: string;
	invite?: string;
}

/** The stored pairing: the link, the invite until it is spent, then the device's credentials. */
export interface Pairing extends PairingLink {
	device?: DeviceCreds;
	/** The computer's name as last reported, for messages after the companion refuses this device. */
	machine?: string;
}

/** A paired device as the companion lists it. */
export interface CompanionDevice {
	id: string;
	name: string;
	pairedAt: number;
	/** Ms since epoch. */
	lastSeen: number;
	/** Connected to the companion right now. */
	online: boolean;
}

const OS_NAMES: [RegExp, string][] = [
	[/iPhone/, "iPhone"],
	[/iPad/, "iPad"],
	[/Android/, "Android"],
	[/Macintosh/, "Mac"],
	[/Windows/, "Windows"],
	[/Linux/, "Linux"],
];
/** Ordered: Edge and Chrome user agents also say Safari, Edge also says Chrome. */
const BROWSER_NAMES: [RegExp, string][] = [
	[/Edg\//, "Edge"],
	[/Firefox\/|FxiOS/, "Firefox"],
	[/Chrome\/|CriOS/, "Chrome"],
	[/Safari\//, "Safari"],
];

/** A readable default name for a device, such as `iPhone Safari`, from its user agent. */
export function defaultDeviceName(userAgent: string): string {
	const os = OS_NAMES.find(([re]) => re.test(userAgent))?.[1] ?? "Device";
	const browser = BROWSER_NAMES.find(([re]) => re.test(userAgent))?.[1];
	return browser ? `${os} ${browser}` : os;
}

/**
 * The pairing link inside a pasted message, scanned QR code, or URL fragment
 * (the room link and, when present, its one-time invite), or null when the text
 * holds none.
 */
export function extractPairing(text: string): PairingLink | null {
	for (const token of text.trim().split(/\s+/)) {
		const at = token.indexOf(PAIR_PREFIX);
		if (at < 0) continue;
		const rest = token.slice(at + PAIR_PREFIX.length).replace(/[>)"'`.,;]+$/, "");
		const markAt = rest.indexOf(INVITE_MARK);
		const link = markAt < 0 ? rest : rest.slice(0, markAt);
		if ("error" in parseCollabLink(link)) continue;
		if (markAt < 0) return { link };
		const invite = rest.slice(markAt + INVITE_MARK.length);
		if (INVITE_RE.test(invite)) return { link, invite };
	}
	return null;
}

/** The pairing URL the companion prints and shows as a QR code: `<web>#pair:<room link>&invite=<invite>`. */
export function formatPairingUrl(webUrl: string, link: string, invite: string): string {
	return `${webUrl.replace(/#.*$/, "")}#${PAIR_PREFIX}${link}${INVITE_MARK}${invite}`;
}

/** The stored pairing. A bare link string is what pairings looked like before devices authenticated: it has no credentials. */
export function loadPairing(): Pairing | null {
	const raw = readJson(PAIRING_KEY);
	if (typeof raw === "string") return { link: raw };
	if (typeof raw !== "object" || raw === null) return null;
	const { link, invite, device, machine } = raw as Record<string, unknown>;
	if (typeof link !== "string") return null;
	const pairing: Pairing = { link };
	if (typeof invite === "string") pairing.invite = invite;
	const creds = device as Partial<DeviceCreds> | undefined;
	if (typeof creds?.id === "string" && typeof creds.token === "string") {
		pairing.device = { id: creds.id, token: creds.token };
	}
	if (typeof machine === "string") pairing.machine = machine;
	return pairing;
}

export function savePairing(pairing: Pairing | null): void {
	writeJson(PAIRING_KEY, pairing);
}

/** `unpaired`: the companion refuses this device (not paired yet, or removed): scan a new pairing code. */
export type CompanionPhase = "connecting" | "live" | "offline" | "unpaired";

export interface CompanionSnapshot {
	phase: CompanionPhase;
	/** Machine name the companion reports. */
	machine: string | null;
	hosts: readonly CompanionHost[];
	/** Sessions on the computer that are not hosting collab yet. */
	idle: readonly CompanionIdleSession[];
	/** The companion can start new sessions. */
	canStart: boolean;
	/** The companion can start sandboxed sessions. */
	canSandbox: boolean;
	/** The companion can open pull requests (`gh` installed and signed in). */
	canPr: boolean;
	/** The companion can build code maps. */
	canCodemap: boolean;
	/** The companion can screenshot local pages. */
	canPreview: boolean;
	/** Voice input on the computer; null when the companion cannot transcribe. */
	transcribe: TranscribeInfo | null;
	/** Power of the computer, while the companion reports it. */
	power: CompanionPower | null;
	/** Web Push application server key, once the companion has listed hosts. */
	vapidKey: string | null;
	/** Why the room is unreachable while `offline`; why this device is refused while `unpaired`. */
	error: string | null;
	/** This device's id at the companion, once it is paired. */
	deviceId: string | null;
}

/** A reply that answers one request (everything but the `hosts` broadcast). */
type CompanionAnswer = Exclude<CompanionReply, { t: "hosts" | "authed" | "auth-failed" }>;
type AnsweredRequest = Extract<CompanionRequest, { reqId: number }>;
/** A request that expects an answer, before its `reqId` is assigned. */
type CompanionCall = {
	[K in AnsweredRequest["t"]]: Omit<Extract<AnsweredRequest, { t: K }>, "reqId">;
}[AnsweredRequest["t"]];

interface Pending {
	expect: CompanionAnswer["t"];
	resolve(answer: CompanionAnswer): void;
	reject(err: Error): void;
	timer: Timer;
}

/** Guest end of the companion room; `useSyncExternalStore`-compatible. */
export class CompanionClient {
	readonly #socket: CollabSocket<CompanionRequest, CompanionReply>;
	readonly #listeners = new Set<() => void>();
	readonly #pending = new Map<number, Pending>();
	#reqSeq = 0;
	#presence: Extract<CompanionRequest, { t: "presence" }> | null = null;
	#everOpened = false;
	#pairing: Pairing;
	/** The companion serves this device (or predates authentication): requests may flow. */
	#authed = false;
	/** Requests made before {@link #authed}; the companion would ignore them. */
	#held: CompanionRequest[] = [];
	#authTimer: Timer | undefined;
	#snapshot: CompanionSnapshot = {
		phase: "connecting",
		machine: null,
		deviceId: null,
		hosts: [],
		idle: [],
		canStart: false,
		canSandbox: false,
		canPr: false,
		canCodemap: false,
		canPreview: false,
		transcribe: null,
		power: null,
		vapidKey: null,
		error: null,
	};

	/** @throws Error when the pairing's room link does not parse. */
	constructor(pairing: Pairing) {
		const parsed = parseCollabLink(pairing.link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#pairing = pairing;
		this.#snapshot = { ...this.#snapshot, machine: pairing.machine ?? null, deviceId: pairing.device?.id ?? null };
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => {
			recordEvent("companion", this.#everOpened ? "reconnected" : "connected");
			this.#everOpened = true;
			const { device, invite } = this.#pairing;
			this.#socket.send({ t: "auth", name: defaultDeviceName(navigator.userAgent), device, invite });
			// A companion that predates authentication never answers `auth`, but answers `list` at once.
			this.#authTimer = setTimeout(() => this.#socket.send({ t: "list", zip: CAN_INFLATE }), LEGACY_PROBE_MS);
		};
		this.#socket.onFrame = frame => this.#apply(frame);
		this.#socket.onClose = (reason, willReconnect) => {
			recordEvent("companion", "closed", willReconnect ? `${reason}, retrying` : reason);
			clearTimeout(this.#authTimer);
			this.#authed = false;
			this.#held.length = 0;
			this.#rejectPending(new Error(`companion disconnected: ${reason}`));
			// After `auth-failed` the companion's verdict stands; the socket was closed on purpose.
			if (this.#snapshot.phase === "unpaired") return;
			this.#update({
				phase: willReconnect ? "connecting" : "offline",
				error: willReconnect
					? null
					: reason === "no such room"
						? "The companion is not running on your computer."
						: reason,
			});
		};
	}

	connect(): void {
		if (this.#snapshot.phase === "unpaired") return;
		if (this.#snapshot.phase === "offline") this.#update({ phase: "connecting", error: null });
		this.#socket.connect();
	}

	/** The page is hidden on a device that suspends hidden pages; see {@link CollabSocket.suspend}. */
	suspend(): void {
		this.#socket.suspend();
	}

	/**
	 * Back in the foreground or online again: replace a connection the background may have killed,
	 * so a fresh `hosts` list arrives within a round trip. An offline room (companion stopped) is retried too.
	 */
	resume(cause: "foreground" | "online" = "foreground"): void {
		if (this.#snapshot.phase === "offline") this.connect();
		else this.#socket.resume(cause);
	}

	close(): void {
		this.#rejectPending(new Error("companion closed"));
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): CompanionSnapshot {
		return this.#snapshot;
	}

	/** A fresh control link for one host, resolved by the companion via `omp collab link`. */
	async requestLink(instanceId: string): Promise<string> {
		return (await this.#call({ t: "link", instanceId }, "link")).url;
	}

	/** Register (`on`) or drop a Web Push subscription with the companion. */
	async setPush(subscription: PushSubscriptionJson, on: boolean): Promise<void> {
		await this.#call({ t: "push", subscription, on }, "ok");
	}

	async requestGit(instanceId: string): Promise<GitSnapshot> {
		return (await this.#call({ t: "git", instanceId }, "git")).git;
	}

	async requestDiff(instanceId: string, path: string): Promise<{ diff: string; truncated: boolean }> {
		const { diff, truncated } = await this.#call({ t: "git-diff", instanceId, path }, "diff");
		return { diff, truncated };
	}

	async requestFile(instanceId: string, path: string): Promise<FileContent> {
		return (await this.#call({ t: "file", instanceId, path }, "file")).file;
	}

	async requestFolders(): Promise<RecentFolder[]> {
		return (await this.#call({ t: "folders" }, "folders")).folders;
	}

	/** Branch of the session's repository against its base branch: files, commits, push and pull request state. */
	async requestReview(instanceId: string): Promise<GitReview> {
		return (await this.#call({ t: "git-review", instanceId }, "review")).review;
	}

	/** Diff of one path from the review's merge-base to the working tree. */
	async requestReviewDiff(instanceId: string, path: string): Promise<{ diff: string; truncated: boolean }> {
		const { diff, truncated } = await this.#call({ t: "git-review-diff", instanceId, path }, "diff");
		return { diff, truncated };
	}

	/** `git add -A && git commit -m message`. */
	async commitChanges(instanceId: string, message: string): Promise<void> {
		await this.#call({ t: "git-commit", instanceId, message }, "ok", GIT_WRITE_TIMEOUT_MS);
	}

	/** `git push -u origin HEAD`. */
	async pushBranch(instanceId: string): Promise<void> {
		await this.#call({ t: "git-push", instanceId }, "ok", GIT_REMOTE_TIMEOUT_MS);
	}

	/** `gh pr create`; resolves with the pull request URL. */
	async createPullRequest(instanceId: string, title: string, body: string, draft?: boolean): Promise<string> {
		return (await this.#call({ t: "pr-create", instanceId, title, body, draft }, "link", GIT_REMOTE_TIMEOUT_MS)).url;
	}

	/** Remove the linked worktree at `path` (under the companion's worktrees folder); its branch stays. */
	async removeWorktree(path: string): Promise<void> {
		await this.#call({ t: "worktree-remove", path }, "ok", GIT_WRITE_TIMEOUT_MS);
	}

	/** Spend and token totals; the companion may sync its stats database first, so allow it time. */
	async requestUsage(range: UsageRange): Promise<UsageReport> {
		return (await this.#call({ t: "usage", range }, "usage", USAGE_TIMEOUT_MS)).usage;
	}

	/** Sessions waiting on an answer and sessions that finished a turn recently, newest first. */
	async requestInbox(): Promise<InboxItem[]> {
		return (await this.#call({ t: "inbox" }, "inbox")).items;
	}

	/** The spend limits the companion alerts at; `limits` replaces them first when given. */
	async spendLimits(limits?: SpendLimits): Promise<SpendLimits> {
		return (await this.#call({ t: "spend-limits", limits }, "spend-limits")).limits;
	}

	/** Sessions across every project, live and ended, newest activity first. */
	async requestSessions(opts: { limit?: number; q?: string } = {}): Promise<SessionOverview[]> {
		return (await this.#call({ t: "sessions", limit: opts.limit, q: opts.q }, "sessions", USAGE_TIMEOUT_MS)).sessions;
	}

	/** Code map around `focus`; the first request for a repository indexes it, so allow it time. */
	async requestCodemap(instanceId: string, focus: CodemapFocus, flow?: CodemapFlowDirection): Promise<CodemapView> {
		return (await this.#call({ t: "codemap", instanceId, focus, flow }, "codemap", CODEMAP_TIMEOUT_MS)).view;
	}

	async searchCodemap(instanceId: string, q: string): Promise<CodemapNode[]> {
		return (await this.#call({ t: "codemap-search", instanceId, q }, "codemap-search", CODEMAP_TIMEOUT_MS)).hits;
	}

	/** The screen of the tmux pane running the session; `target` is null when it does not run in tmux. */
	async requestPane(instanceId: string): Promise<PaneCapture> {
		return (await this.#call({ t: "pane", instanceId }, "pane")).pane;
	}

	/** A screenshot of the loopback page `url` at `viewport` (the whole page when `fullPage`), taken on the computer. */
	async requestPreview(
		instanceId: string,
		url: string,
		viewport: PreviewViewport,
		fullPage: boolean,
	): Promise<PreviewShot> {
		return (await this.#call({ t: "preview", instanceId, url, viewport, fullPage }, "preview", PREVIEW_TIMEOUT_MS))
			.shot;
	}

	/** Dev servers listening on the computer that run from the session's repository, by port. */
	async requestPreviewTargets(instanceId: string): Promise<PreviewTarget[]> {
		return (await this.#call({ t: "preview-targets", instanceId }, "preview-targets")).targets;
	}

	/** Text of a voice recording (`audio`: base64 of the bytes, as recorded), transcribed on the computer. */
	async requestTranscribe(audio: string, mimeType: string): Promise<string> {
		return (await this.#call({ t: "transcribe", audio, mimeType }, "transcribe", TRANSCRIBE_TIMEOUT_MS)).text;
	}

	/** Download the speech model on the computer; resolves once voice input works. */
	async requestTranscribeSetup(): Promise<void> {
		await this.#call({ t: "transcribe-setup" }, "transcribe-setup", TRANSCRIBE_SETUP_TIMEOUT_MS);
	}

	/** Sessions that changed `path` in the session's repository, newest first; the scan is bounded to recent sessions. */
	async requestFileSessions(instanceId: string, path: string): Promise<SessionOverview[]> {
		return (await this.#call({ t: "file-sessions", instanceId, path }, "sessions", USAGE_TIMEOUT_MS)).sessions;
	}

	/**
	 * Start omp in `cwd` (resuming session `resume`); resolves with its host `instanceId` once it is listed.
	 * `worktree` (new sessions only): work on a new branch in its own git worktree instead of `cwd`.
	 */
	async startSession(
		cwd: string,
		options: { resume?: string; sandboxed?: boolean; worktree?: { branch?: string }; force?: boolean } = {},
	): Promise<string> {
		const timeout = options.worktree ? WORKTREE_START_TIMEOUT_MS : START_TIMEOUT_MS;
		return (await this.#call({ t: "start", cwd, ...options }, "started", timeout)).instanceId;
	}

	/** Make an idle session host collab; resolves with its control link. */
	async shareSession(instanceId: string): Promise<string> {
		return (await this.#call({ t: "share", instanceId }, "link", START_TIMEOUT_MS)).url;
	}

	/** Companion health snapshot. */
	async requestDiag(): Promise<CompanionDiag> {
		return (await this.#call({ t: "diag" }, "diag")).diag;
	}

	/** Round trip to the companion in ms: the median of a few pings. */
	async measureRtt(): Promise<number> {
		const samples: number[] = [];
		for (let i = 0; i < PING_SAMPLES; i++) {
			const sent = performance.now();
			await this.#call({ t: "ping" }, "ok");
			samples.push(performance.now() - sent);
		}
		samples.sort((a, b) => a - b);
		return samples[samples.length >> 1];
	}

	/** Run a maintenance action on the computer; resolves with its trimmed output. */
	async maintain(action: MaintainAction): Promise<string> {
		const timeout = action === "update-omp" ? UPDATE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
		return (await this.#call({ t: "maintain", action }, "maintain", timeout)).output;
	}

	/** Paired devices of the computer, and which of them is this one. */
	async requestDevices(): Promise<{ devices: CompanionDevice[]; self: string }> {
		const { devices, self } = await this.#call({ t: "devices" }, "devices");
		return { devices, self };
	}

	async renameDevice(deviceId: string, name: string): Promise<void> {
		await this.#call({ t: "device-rename", deviceId, name }, "ok");
	}

	/** Unpair a device: the companion stops serving it and drops its notifications. */
	async removeDevice(deviceId: string): Promise<void> {
		await this.#call({ t: "device-revoke", deviceId }, "ok");
	}

	/** A one-time pairing link for a new device, valid until `expiresAt` (ms since epoch). */
	async createInvite(): Promise<{ url: string; expiresAt: number }> {
		const { url, expiresAt } = await this.#call({ t: "invite" }, "invite");
		return { url, expiresAt };
	}

	/** Tell the companion whether this device shows the app now; re-sent after reconnects. */
	setPresence(endpoint: string | null, visible: boolean): void {
		this.#presence = { t: "presence", endpoint, visible };
		if (this.#authed) this.#socket.send(this.#presence);
	}

	/** Send now, or once the companion has accepted this device: it ignores a device it has not authenticated. */
	#send(request: CompanionRequest): void {
		if (this.#authed) this.#socket.send(request);
		else this.#held.push(request);
	}

	/** The companion serves this device: release held requests and ask for the host list (unless already asked). */
	#ready(listed: boolean): void {
		if (this.#authed) return;
		this.#authed = true;
		clearTimeout(this.#authTimer);
		if (!listed) this.#socket.send({ t: "list", zip: CAN_INFLATE });
		if (this.#presence) this.#socket.send(this.#presence);
		for (const request of this.#held) this.#socket.send(request);
		this.#held.length = 0;
	}

	#call<T extends CompanionAnswer["t"]>(
		call: CompanionCall,
		expect: T,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<Extract<CompanionAnswer, { t: T }>> {
		// The socket is closed once the companion refuses this device: nothing would ever answer.
		if (this.#snapshot.phase === "unpaired")
			return Promise.reject(new Error(this.#snapshot.error ?? "This device is not paired."));
		const reqId = ++this.#reqSeq;
		const { promise, resolve, reject } = Promise.withResolvers<Extract<CompanionAnswer, { t: T }>>();
		const timer = setTimeout(() => {
			this.#pending.delete(reqId);
			reject(new Error("the companion did not answer"));
		}, timeoutMs);
		this.#pending.set(reqId, {
			expect,
			resolve: resolve as (answer: CompanionAnswer) => void,
			reject,
			timer,
		});
		this.#send({ ...call, reqId } as CompanionRequest);
		return promise;
	}

	#apply(frame: CompanionReply): void {
		if (frame.t === "authed") {
			if (frame.token !== undefined) {
				// The invite is spent: from here on the device authenticates with its own credentials.
				this.#pairing = {
					link: this.#pairing.link,
					device: { id: frame.deviceId, token: frame.token },
					machine: this.#pairing.machine,
				};
				savePairing(this.#pairing);
			}
			this.#update({ deviceId: frame.deviceId });
			this.#ready(false);
			return;
		}
		if (frame.t === "auth-failed") {
			const { device, invite, machine: knownMachine } = this.#pairing;
			let message = "This device needs to be paired again.";
			if (invite !== undefined) message = frame.message;
			else if (device !== undefined) {
				message = `This device was removed from ${this.#snapshot.machine ?? knownMachine ?? "this computer"}.`;
			}
			this.#rejectPending(new Error(message));
			this.#update({ phase: "unpaired", error: message });
			this.#socket.close();
			return;
		}
		if (frame.t === "hosts") {
			// Only an accepted device is sent hosts; a companion that predates authentication sends them unasked.
			this.#ready(true);
			if (frame.machine !== this.#pairing.machine) {
				this.#pairing = { ...this.#pairing, machine: frame.machine };
				savePairing(this.#pairing);
			}
			this.#update({
				phase: "live",
				machine: frame.machine,
				hosts: frame.hosts,
				// Absent from companions that predate them.
				idle: frame.idle ?? [],
				canStart: frame.canStart ?? false,
				canSandbox: frame.canSandbox ?? false,
				canPr: frame.canPr ?? false,
				canCodemap: frame.canCodemap ?? false,
				canPreview: frame.canPreview ?? false,
				transcribe: frame.transcribe ?? null,
				power: frame.power ?? null,
				vapidKey: frame.vapidKey,
				error: null,
			});
			return;
		}
		const pending = this.#pending.get(frame.reqId);
		if (!pending) return;
		this.#pending.delete(frame.reqId);
		clearTimeout(pending.timer);
		if (frame.t === "error")
			pending.reject(
				frame.openElsewhere ? new SessionOpenElsewhereError(frame.openElsewhere) : new Error(frame.message),
			);
		else if (frame.t !== pending.expect) pending.reject(new Error(`unexpected companion reply: ${frame.t}`));
		else pending.resolve(frame);
	}

	#rejectPending(err: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(err);
		}
		this.#pending.clear();
	}

	#update(patch: Partial<CompanionSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}
}
