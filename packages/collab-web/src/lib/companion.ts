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

import type { AgentRef } from "@oh-my-pi/pi-wire";
import type { Schedule, ScheduleInput } from "@oh-my-pi/pi-wire/schedule";
import { CAN_INFLATE, importRoomKey } from "./codec";
import { recordEvent } from "./diag-log";
import { parseCollabLink } from "./link";
import type {
	FanoutCompare,
	FanoutGroup,
	FanoutKeepRequest,
	FanoutKeepResult,
	FanoutModel,
	FanoutRequest,
	HostFanout,
} from "./fanout";
import type { OrgDoc } from "./session-org";
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
/** A worktree start also waits for the checkout (up to 60s), its setup script (up to 5 minutes) and omp's boot. */
const WORKTREE_START_TIMEOUT_MS = 420_000;
/** Writing commit text runs a headless omp; the companion allows it 90 seconds. */
const GIT_MESSAGE_TIMEOUT_MS = 120_000;
const GIT_SETTINGS_TIMEOUT_MS = 60_000;
/** `omp models` loads the model catalog, which may refresh over the network. */
const FANOUT_MODELS_TIMEOUT_MS = 45_000;
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
/** GitHub listings go through `gh` to the GitHub API (the companion allows it 20s). */
const GITHUB_TIMEOUT_MS = 30_000;
/** A pull request's diff is fetched whole by `gh pr diff` (up to 60s), and a review or merge is one slow API write. */
const PR_REVIEW_TIMEOUT_MS = 90_000;
/** Failing-check logs: one `gh pr view`, then the log reads (each up to 25s on the computer). */
const CI_LOG_TIMEOUT_MS = 60_000;
/** Listing a huge repository can take git a while. */
const TREE_TIMEOUT_MS = 60_000;
/** An attachment is one frame of up to ~13 MB, sent over a phone connection. */
const UPLOAD_TIMEOUT_MS = 120_000;
/** One download chunk is up to ~5.3 MB of base64, read from disk and sent over a phone connection. */
const DOWNLOAD_CHUNK_TIMEOUT_MS = 120_000;
/** Pings sent per round-trip measurement; the median is reported. */
const PING_SAMPLES = 3;
/** Probing the vendor agents again starts each one's ACP adapter to read what it supports. */
const AGENTS_REFRESH_TIMEOUT_MS = 60_000;
/** Installing an ACP adapter runs `npm install` on the computer. */
const AGENT_INSTALL_TIMEOUT_MS = 330_000;

export type { AgentRef };

/** A model a foreign agent offers, by its vendor id; what `start`'s `model` takes. */
export interface AgentModel {
	id: string;
	name: string;
}

/** How a foreign agent session answers its agent's tool-permission requests; `full` approves every call. */
export type ForeignPermission = "supervised" | "full";

/** A vendor agent the computer can run beside omp: Claude Code, Codex, Cursor, Grok, OpenCode, or a custom ACP command. */
export interface CompanionAgent {
	/** `claude`, `codex`, `cursor`, `grok`, `opencode`, or `custom:<slug>`. */
	id: string;
	name: string;
	kind: "builtin" | "custom";
	installed: boolean;
	version: string | null;
	/** `needed`: run {@link CompanionAgent.loginCommand} on the computer; `unknown`: the agent has no side-effect-free check. */
	auth: "ok" | "needed" | "unknown";
	/** The companion can install or update this agent's ACP adapter (`agent-install`). */
	installable: boolean;
	/** Command that signs in on the computer's terminal; null when none is needed. */
	loginCommand: string | null;
	/** A command to run on the computer to install the agent's CLI, for ones the companion cannot install itself; null when there is none. */
	installCommand: string | null;
	/** Custom agents: the argv and extra environment as saved, to edit them. */
	command?: string[];
	env?: Record<string, string>;
	/** Models to pick from; absent or empty: the agent's default. */
	models?: AgentModel[];
	/** Why it cannot run (probe failure). */
	error?: string;
}

/** A custom ACP agent as saved: `command` is the argv (no shell), `env` extra variables for it. */
export interface CustomAgentInput {
	/** Absent: a new agent (the companion derives the id `custom:<slug>` from the name). */
	id?: string;
	name: string;
	command: string[];
	env?: Record<string, string>;
}

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
	/** Started by a best-of-N fan-out: the group it belongs to and the model it runs on. */
	fanout?: HostFanout;
	/** The vendor agent behind a foreign session; absent for an omp session. */
	agent?: AgentRef;
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
	/** The vendor agent behind a foreign session; absent for an omp session. */
	agent?: AgentRef;
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

/** Text for the confirm dialog of "commit, push and open PR". */
export interface GitText {
	/** Commit message; empty unless asked for. */
	commit: string;
	/** Pull request title; empty unless asked for. */
	prTitle: string;
	prBody: string;
	/** `model`: written by a model. `fallback`: built from the session and the changes, because of `note`. */
	source: "model" | "fallback";
	note?: string;
}

/** How new git worktrees are made and cleaned up, and which model writes commit and pull request text. */
export interface GitFlowSettings {
	/** Prepended to generated worktree branch names (`omp/`); may be empty. */
	branchPrefix: string;
	/** Absolute folder new worktrees go under; null: the companion's default. */
	worktreesDir: string | null;
	/** Shell command run once in each new worktree; a repository's own `.omp/worktree-setup` runs instead only once approved. Empty: none. */
	setupScript: string;
	/** Shell command run in a worktree the companion created when its session settles; a repository's own `.omp/worktree-settle` runs instead only once approved. Empty: none. Companions that predate it omit it (and `GitFlowSettingsReply.settleCleanup`). */
	settleScript: string;
	/** `merged`: remove a worktree once its pull request merged; `inactive`: once untouched for `days`. Never one with uncommitted changes or a running omp. */
	cleanup: { mode: "off" | "merged" | "inactive"; days: number };
	/** Model id or role (`@smol`) for the text. */
	messageModel: string;
}

/** A repository's own `.omp/worktree-setup` and whether the user approved its current content: only then does it run in new worktrees. */
export interface WorktreeSetupStatus {
	root: string;
	/** The script now; null when the repository no longer has a readable one. */
	script: string | null;
	hash: string | null;
	/** The stored approval is of exactly this content. */
	trusted: boolean;
	/** Some approval is stored, whether or not it still matches. */
	approved: boolean;
}

export interface GitSettingsOptions {
	settings?: GitFlowSettings;
	/** `kind` picks the script: the repository's `.omp/worktree-setup` (default) or `.omp/worktree-settle`. */
	trust?: { root: string; hash: string | null; kind?: "setup" | "settle" };
	sweep?: boolean;
}

/** What the settle command last did in one worktree. */
export interface SettleCleanupResult {
	/** The worktree folder. */
	path: string;
	branch: string;
	/** The session whose settling ran it. */
	sessionId: string;
	/** The companion's command, or the repository's approved `.omp/worktree-settle`. */
	source: "settings" | "project";
	/** `skipped`: nothing ran, because a sandboxed session worked in the folder (see `output`). */
	status: "ok" | "failed" | "timeout" | "skipped";
	/** Exit code; null when it timed out, was skipped or never started. */
	code: number | null;
	/** ms since epoch. */
	startedAt: number;
	durationMs: number;
	/** The end of what it printed (stdout and stderr), bounded. */
	output: string;
}

export interface GitFlowSettingsReply {
	settings: GitFlowSettings;
	/** The folder new worktrees go under now. */
	worktreesDir: string;
	/** Worktrees the requested sweep removed. */
	swept?: string[];
	/** Repository setup scripts the companion has met: approved ones, and ones a start did not run for lack of approval. */
	projects: WorktreeSetupStatus[];
	/** Present on companions that run `settleScript`: the repository `.omp/worktree-settle` scripts they have met (approved the same way as setup scripts), and the latest result per worktree, newest first. */
	settleCleanup?: { projects: WorktreeSetupStatus[]; results: SettleCleanupResult[] };
}

export type GithubKind = "issue" | "pr";
/** `open`: every open item. `mine`: issues assigned to me, pull requests I opened. `review`: pull requests waiting on my review. */
export type GithubFilter = "open" | "mine" | "review";

/** An issue or pull request of the session's GitHub repository, as listed. */
export interface GithubItem {
	kind: GithubKind;
	number: number;
	title: string;
	/** `merged` only for pull requests. */
	state: "open" | "closed" | "merged";
	/** Pull requests only; false for issues. */
	draft: boolean;
	author: string;
	labels: string[];
	/** ms since epoch. */
	updatedAt: number;
	url: string;
	/** Pull requests: the review decision; null for issues and when no review is required. */
	review: "approved" | "changes" | "required" | null;
	/** Pull requests: all checks combined; null for issues and when there are none. */
	checks: GithubCheckState | null;
}

export type GithubCheckState = "pass" | "fail" | "pending";

/** One check of a pull request's head commit: a check run (GitHub Actions, apps) or a commit status. */
export interface GithubCheck {
	/** `workflow / job` for Actions runs. */
	name: string;
	state: GithubCheckState;
	/** Page with the check's details; empty when GitHub gives none. */
	url: string;
}

export interface GithubComment {
	author: string;
	body: string;
	/** ms since epoch. */
	createdAt: number;
}

/** The pull request a `ci-log` answer is about. */
export interface CiLogPr {
	title: string;
	url: string;
	/** Head branch. */
	branch: string;
}

/** One failing check. */
export interface CiLogFailure {
	/** `workflow / job` for Actions runs. */
	check: string;
	/** The check's details page; empty when GitHub gives none. */
	url: string;
	/** Tail of the GitHub Actions log of what failed, trimmed (a first line says how much was cut); empty for other checks. */
	log: string;
}

/** A session on the computer in the pull request's repository. */
export interface CiLogSession {
	instanceId: string;
	title: string;
	cwd: string;
	/** Checked-out branch; null when detached. */
	branch: string | null;
	/** Hosting collab: opens at once. Otherwise it must be shared first. */
	host: boolean;
	busy: boolean;
	/** Started sandboxed: cannot run the tests the Fix-it prompt asks for. */
	sandboxed: boolean;
}

/** A recent folder of the pull request's repository without a running session. */
export interface CiLogFolder {
	cwd: string;
	branch: string | null;
}

/** What the Fix-it flow shows: the pull request, its failing checks, and where to work on them. */
export interface CiLogReport {
	pr: CiLogPr;
	failures: CiLogFailure[];
	/** Failing checks left out after the first few. */
	moreFailures: number;
	/** Sessions of the repository, best match first. */
	sessions: CiLogSession[];
	/** Folders to start a session in when there is no session. */
	folders: CiLogFolder[];
}

/** One item opened: its description, checks and latest comments, plus a pull request's branch and size. */
export interface GithubItemDetail extends GithubItem {
	body: string;
	/** Pull requests: every check, failing first; empty for issues. */
	checkList: GithubCheck[];
	/** The latest comments, oldest first. */
	comments: GithubComment[];
	/** Comments left out before the first one shown. */
	olderComments: number;
	/** Pull requests: `head` merges into `base`; null for issues. */
	branch: { head: string; base: string } | null;
	/** Pull requests: the head commit this detail was read at (absent from companions that predate it). */
	head?: string;
	/** Pull requests: lines and files changed; null for issues. */
	size: { additions: number; deletions: number; files: number } | null;
}

export type PrFileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed";

/** One file of a pull request's diff. */
export interface PrFile {
	path: string;
	status: PrFileStatus;
	additions: number;
	deletions: number;
	/** Renamed and copied files: the path they came from. */
	from?: string;
}

/** The changed files of a pull request and the head commit they were read at. */
export interface PrFiles {
	head: string;
	files: PrFile[];
}

export type PrReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** An inline review comment: `line` (and `startLine` for a range) of `path` on the old (`LEFT`) or new (`RIGHT`) side of the diff. */
export interface PrReviewComment {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	startLine?: number;
	body: string;
}

/** A review as posted: its verdict, summary, inline comments, and the commit they were written against. */
export interface PrReviewInput {
	event: PrReviewEvent;
	body: string;
	comments: PrReviewComment[];
	commit?: string;
}

export type PrMergeMethod = "squash" | "merge" | "rebase";

/** A file inside a session's repository (or cwd outside a repository); read-only unless `writable`. */
export interface FileContent {
	/** Path relative to the repository root (or cwd). */
	path: string;
	/** Bytes on disk. */
	size: number;
	/** UTF-8 text, or null for a binary file. */
	text: string | null;
	truncated: boolean;
	/**
	 * Identifies the content on disk: a hash of the bytes plus the size for files the companion reads whole,
	 * the size plus modification time for larger ones. `file-write` is refused unless its `base` equals it.
	 */
	version: string;
	/** The app may save it: text, not truncated, writable by the companion, outside `.git`, and the session is not sandboxed. */
	writable: boolean;
}

/** The files of a session's repository (or cwd outside a repository), for the editor's file picker. */
export interface FileTree {
	/** Absolute repository root, or the session's real cwd outside a repository. */
	root: string;
	/** Files under `root`, root-relative with "/" separators, sorted. */
	files: string[];
	/** The listing stopped at the cap. */
	truncated: boolean;
}

/** A folder omp sessions ran in, from the local session store, newest first. */
export interface RecentFolder {
	cwd: string;
	lastActive: number;
	/** Most recent sessions there, newest first. */
	sessions: { id: string; title: string | null; lastActive: number; agent?: AgentRef }[];
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
	/** The vendor agent behind a foreign session; absent for an omp session. */
	agent?: AgentRef;
}

/** One prompt or reply of a session that matches a message search. */
export interface SessionSearchHit {
	sessionId: string;
	title: string | null;
	cwd: string;
	/** The session entry (the id the transcript rows carry) holding the text. */
	entryId: string;
	role: "user" | "assistant";
	/** About 160 characters around the first match. */
	snippet: string;
	/** Unix ms. */
	time: number;
	/** Present when the session is hosting collab or listed as idle right now. */
	instanceId?: string;
	live?: "host" | "idle";
	/** The vendor agent behind a foreign session; absent for an omp session. */
	agent?: AgentRef;
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

/** Where a runnable target comes from; the app groups its list by it. */
export type RunSource = "package" | "make" | "just" | "cargo";

/** A command the companion can run in a session's repository root; the app cannot name any other. */
export interface RunTarget {
	/** `<source>:<name>`; what `run-start` names. */
	id: string;
	source: RunSource;
	name: string;
	/** The exact command line that runs, e.g. `bun run test`. */
	command: string;
	/**
	 * What the command executes, read from the repository's files: the script body, the recipe lines (about the
	 * first 20). Absent for Cargo, whose commands are fixed. Shown in the confirmation, since a name says little.
	 */
	detail?: string;
}

/** `stopped`: ended after a Stop; `failed`: the command could not start. */
export type RunState = "running" | "exited" | "stopped" | "failed";

export interface RunInfo {
	runId: string;
	instanceId: string;
	targetId: string;
	command: string;
	/** Unix ms. */
	startedAt: number;
	/** Unix ms; null while running. */
	endedAt: number | null;
	state: RunState;
	/** Null while running, after a signal, and when the command could not start. */
	exitCode: number | null;
	/** Signal that ended it, e.g. `SIGTERM`. */
	signal: string | null;
}

/** A slice of a run's output (ANSI colors kept). Positions count characters since the run began. */
export interface RunOutput {
	run: RunInfo;
	text: string;
	/** Where `text` starts: later than asked when the oldest output was already dropped (`truncated`). */
	from: number;
	/** Ask from here next; less than the output's end while more is waiting. */
	next: number;
	truncated: boolean;
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
	/** The vendor agent behind a foreign session; absent for an omp session. */
	agent?: AgentRef;
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

/** Which GitHub events on the user's own open pull requests the companion pushes a notification for. */
export interface PrAlertSettings {
	/** Checks finished (passed or failed). */
	checks: boolean;
	/** New reviews and comments from others. */
	reviews: boolean;
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
	/** `launchd` (macOS) or `systemd` (Linux) restarts the companion on demand; a manually started one cannot be restarted from the app. */
	managed: "launchd" | "systemd" | "manual";
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

/** A `file-write` was refused because the file changed on disk since the edit started. */
export class FileChangedError extends Error {
	/** The file's version now; null when it was deleted. */
	readonly version: string | null;

	constructor(version: string | null) {
		super("The file changed on disk since you opened it");
		this.name = "FileChangedError";
		this.version = version;
	}
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

/** One piece of a file served for download; `size` is the whole file's, `data` is at most 4 MB of it, base64. */
export interface FileChunk {
	/** Base name of the file. */
	name: string;
	size: number;
	/** Content type from the extension. */
	mime: string;
	/** Where in the file `data` starts. */
	offset: number;
	data: string;
	/** `data` reaches the end of the file. */
	done: boolean;
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
	/** Scheduled runs (needs `canSchedule`): the whole list. */
	| { t: "schedules"; reqId: number }
	/** Create (no `schedule.id`) or replace a scheduled run; answered with `schedule`. */
	| { t: "schedule-save"; reqId: number; schedule: ScheduleInput }
	| { t: "schedule-delete"; reqId: number; id: string }
	/** Start a scheduled run now, whatever its timetable says; answered with `schedule` once it hosts (an error when it did not start). */
	| { t: "schedule-run-now"; reqId: number; id: string }
	/**
	 * Start omp in `cwd` (resuming session `resume` when given), hosting with control access;
	 * `sandboxed`: file read/search/edit tools only, with writes confined to `cwd` (needs `canSandbox`);
	 * `worktree` (new sessions inside a git repository only): run on a new branch in its own git worktree.
	 * `scratch` (new sessions only, needs `canScratch`): run in a fresh folder under the computer's omp config dir instead of `cwd`
	 * (send an empty `cwd`); `hint`, the start of the first prompt, names it. `prompt` (needs `canBackgroundStart`) is the first
	 * message omp works on as soon as it is up, so the session need not be opened to begin.
	 * Resuming a session another omp has open is refused (an error with `openElsewhere`) unless `force`;
	 * a session that is already hosting is answered with its host.
	 * `agent` (needs `canForeign`; absent: omp) runs a vendor agent instead: `agents` lists the ids; `model` is one of its vendor model ids,
	 * `permission` how it answers tool-permission requests (default `supervised`). `resume` then names a foreign session id.
	 */
	| {
			t: "start";
			reqId: number;
			cwd: string;
			resume?: string;
			sandboxed?: boolean;
			worktree?: { branch?: string };
			scratch?: { hint?: string };
			prompt?: string;
			force?: boolean;
			agent?: string;
			model?: string;
			permission?: ForeignPermission;
	  }
	/** The vendor agents (needs `canForeign`); `refresh` probes them again instead of answering from the last probe. Answered with `agents`. */
	| { t: "agents"; reqId: number; refresh?: boolean }
	/** Install or update a built-in agent's ACP adapter on the computer (a pinned npm version); answered with `agents`. */
	| { t: "agent-install"; reqId: number; id: string }
	/** Add (no `agent.id`) or replace a custom ACP agent; answered with `agents`. */
	| { t: "agent-custom-save"; reqId: number; agent: CustomAgentInput }
	/** Remove a custom ACP agent; answered with `agents`. */
	| { t: "agent-custom-delete"; reqId: number; id: string }
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
	/** Commit message (`commit`) and / or pull request title and body (`pr`) written by a model from the changes, for the person to edit; answered with `git-message` (needs `canGitFlow`). */
	| { t: "git-message"; reqId: number; instanceId: string; commit: boolean; pr: boolean }
	/** Read (no `settings`) or replace the worktree and git flow settings; `trust` approves (`hash` of the script that was shown) or withdraws (`hash` null) a repository's `.omp/worktree-setup` (or, with `kind: "settle"`, `.omp/worktree-settle`); `sweep` also runs the worktree cleanup now; answered with `git-settings` (needs `canGitFlow`). */
	| ({ t: "git-settings"; reqId: number } & GitSettingsOptions)
	/** Models `omp` can run (needs `canFanout`). */
	| { t: "fanout-models"; reqId: number }
	/** One prompt on each of `request.models` in new worktrees of `request.cwd`'s repository; answered with `fanout-started` (needs `canFanout`). */
	| { t: "fanout-start"; reqId: number; request: FanoutRequest }
	/** Status, cost, changed files and verify result of every session in group `group`. */
	| { t: "fanout-compare"; reqId: number; group: string }
	/** Keep a session of a group; with `removeOthers`, end and remove the other worktrees (those with uncommitted changes only with `discardDirty`). */
	| { t: "fanout-keep"; reqId: number; request: FanoutKeepRequest }
	/** Spend and token totals across every omp session on the computer. */
	| { t: "usage"; reqId: number; range: UsageRange }
	/** Sessions that need input or finished a turn recently. */
	| { t: "inbox"; reqId: number }
	/** Read (no `limits`) or replace the spend alert limits. */
	| { t: "spend-limits"; reqId: number; limits?: SpendLimits }
	/** Read (no `settings`) or replace the GitHub alert settings. */
	| { t: "pr-alerts"; reqId: number; settings?: PrAlertSettings }
	/** Past and live sessions across projects, newest activity first; `q` filters by title or folder. */
	| { t: "sessions"; reqId: number; limit?: number; q?: string }
	/** Prompts and replies of every session containing all words of `query` (at least 2 characters), newest first; answered with `session-search` (needs `canSearch`). */
	| { t: "session-search"; reqId: number; query: string; limit?: number }
	/** Merge `doc` (the device's pin/snooze/settle document, when given) into the computer's, last writer winning per session; answered with the merged document (needs `sessionOrgRev`). */
	| { t: "session-org"; reqId: number; doc?: OrgDoc }
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
	| { t: "transcribe-setup"; reqId: number }
	/** Issues or pull requests of the session's GitHub repository, read through `gh` (needs `canGithub`). */
	| { t: "github"; reqId: number; instanceId: string; kind: GithubKind; filter: GithubFilter }
	/** One issue or pull request with its description, comments and checks (needs `canGithub`). */
	| { t: "github-item"; reqId: number; instanceId: string; kind: GithubKind; number: number }
	/** The changed files of a pull request, with the head commit they were read at (needs `canPrReview`). */
	| { t: "pr-files"; reqId: number; instanceId: string; number: number }
	/** One file's diff of a pull request at `head`, answered with a `diff` (needs `canPrReview`). */
	| { t: "pr-diff"; reqId: number; instanceId: string; number: number; head: string; path: string }
	/** Post a review with inline comments; answered with a `link` to it. Refused for sandboxed sessions (needs `canPrReview`). */
	| { t: "pr-review"; reqId: number; instanceId: string; number: number; review: PrReviewInput }
	/**
	 * Merge a pull request at `head`, the commit the user saw: refused if it has moved. Refused unless it is open,
	 * and while it is a draft or its checks fail or run unless `allowDraft` / `allowFailing` / `allowPending`
	 * (then a draft is marked ready first); sandboxed sessions are refused (needs `canPrReview`).
	 */
	| {
			t: "pr-merge";
			reqId: number;
			instanceId: string;
			number: number;
			method: PrMergeMethod;
			deleteBranch: boolean;
			head: string;
			allowDraft?: boolean;
			allowFailing?: boolean;
			allowPending?: boolean;
	  }
	/** The failing checks of a pull request with log tails, and the repository's sessions (needs `canFixIt`). */
	| { t: "ci-log"; reqId: number; repo: string; number: number }
	/** The files of the session's repository (needs `canEdit`). */
	| { t: "tree"; reqId: number; instanceId: string }
	/**
	 * Replace the text of an existing file; `path` is absolute or relative to the session's cwd. `base` is the
	 * `version` the edit started from: a file that changed since is refused (an error with `changed`).
	 */
	| { t: "file-write"; reqId: number; instanceId: string; path: string; text: string; base: string }
	/** Current versions of up to 20 files, to notice edits made behind an open editor. */
	| { t: "file-versions"; reqId: number; instanceId: string; paths: string[] }
	/** Save a prompt attachment on the computer (needs `canUpload`); `data` is the file's base64. */
	| { t: "upload"; reqId: number; instanceId: string; name: string; data: string }
	/** Targets the companion can run in the session's repository root (needs `canRun`). */
	| { t: "run-targets"; reqId: number; instanceId: string }
	/**
	 * Run one listed target (`RunTarget.id`) there; refused for repositories sandboxed sessions work in, past three runs
	 * at once, and when the target's `detail` no longer equals the `detail` sent (the one the person confirmed; omit it for
	 * a target without one). Answered with `run`.
	 */
	| { t: "run-start"; reqId: number; instanceId: string; target: string; detail?: string }
	/** Output of a run from position `from`; answered with `run-output`. */
	| { t: "run-output"; reqId: number; runId: string; from: number }
	/** SIGTERM the run's process group, SIGKILL after three seconds; answered with `run`. */
	| { t: "run-stop"; reqId: number; runId: string }
	/** The session's last ten runs, newest first. */
	| { t: "runs"; reqId: number; instanceId: string }
	/** One chunk of a file of the session's repository from `offset`, at most 4 MB raw (needs `canDownload`). */
	| { t: "file-download"; reqId: number; instanceId: string; path: string; offset: number };

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
			/** The companion can list and edit files of a session's repository. */
			canEdit?: boolean;
			/** The companion can screenshot local pages (it found Chrome or another Chromium browser). */
			canPreview?: boolean;
			/** The companion can list the session repository's issues and pull requests (`gh` signed in). */
			canGithub?: boolean;
			/** The companion answers `pr-files`, `pr-diff`, `pr-review` and `pr-merge`. */
			canPrReview?: boolean;
			/** The companion answers `ci-log` (the Fix-it flow). */
			canFixIt?: boolean;
			/** The companion can save prompt attachments on the computer. */
			canUpload?: boolean;
			/** The companion can run scheduled prompts. */
			canSchedule?: boolean;
			/** Schedules can use cron expressions, intervals and catch-up policies. */
			canScheduleCron?: boolean;
			/** The companion answers `git-message` and `git-settings`. */
			canGitFlow?: boolean;
			/** The companion can start one prompt on several models in separate worktrees (`fanout-*` requests). */
			canFanout?: boolean;
			/** The companion can serve files of a session's repository for download. */
			canDownload?: boolean;
			/** The companion can run listed scripts and build targets of a session's repository. */
			canRun?: boolean;
			/** The companion answers `session-search`. */
			canSearch?: boolean;
			/** `start` takes `scratch`: a session without a project, in a fresh folder under the omp config dir. */
			canScratch?: boolean;
			/** `start` takes `prompt` (delivered at launch) and tells simultaneous starts in one folder apart: sessions can be started in the background. */
			canBackgroundStart?: boolean;
			/** The companion can run vendor agents beside omp (`agents`, `start` with `agent`). */
			canForeign?: boolean;
			/** Revision of the computer's session organisation (pin, snooze, settle); present when it keeps one. A new number means fetch it again. */
			sessionOrgRev?: number;
			/** The companion's session organisation keeps the active order (`rank`) and the per-session auto-settle opt-out. */
			canOrderSessions?: boolean;
			/** The companion ends the sessions it started when they settle, if the organisation's `endOnSettle` setting is on. */
			canEndOnSettle?: boolean;
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
	/**
	 * `openElsewhere`: why a `start` that resumes a session was refused; see {@link SessionOpenElsewhereError}.
	 * `changed`: a `file-write` was refused because the file changed on disk; its current version, null when deleted.
	 */
	| { t: "error"; reqId: number; message: string; openElsewhere?: SessionHolder[]; changed?: string | null }
	| { t: "git"; reqId: number; git: GitSnapshot }
	| { t: "diff"; reqId: number; diff: string; truncated: boolean }
	| { t: "file"; reqId: number; file: FileContent }
	| { t: "tree"; reqId: number; tree: FileTree }
	/** The saved text's version. */
	| { t: "file-saved"; reqId: number; version: string }
	/** In the order of the request's paths; null for a file that is missing or unreadable. */
	| { t: "file-versions"; reqId: number; versions: (string | null)[] }
	| { t: "folders"; reqId: number; folders: RecentFolder[] }
	| { t: "schedules"; reqId: number; schedules: Schedule[] }
	/** One schedule as stored: answers `schedule-save` and `schedule-run-now`. */
	| { t: "schedule"; reqId: number; schedule: Schedule }
	| { t: "fanout-models"; reqId: number; models: FanoutModel[] }
	| { t: "agents"; reqId: number; agents: CompanionAgent[] }
	| { t: "fanout-started"; reqId: number; group: FanoutGroup }
	| { t: "fanout-compare"; reqId: number; compare: FanoutCompare }
	| { t: "fanout-kept"; reqId: number; result: FanoutKeepResult }
	| { t: "review"; reqId: number; review: GitReview }
	| { t: "git-message"; reqId: number; text: GitText }
	| ({ t: "git-settings"; reqId: number } & GitFlowSettingsReply)
	/** The started session is hosting and listed under `instanceId`. */
	| { t: "started"; reqId: number; instanceId: string }
	| { t: "usage"; reqId: number; usage: UsageReport }
	| { t: "inbox"; reqId: number; items: InboxItem[] }
	| { t: "spend-limits"; reqId: number; limits: SpendLimits }
	| { t: "pr-alerts"; reqId: number; settings: PrAlertSettings }
	| { t: "sessions"; reqId: number; sessions: SessionOverview[] }
	| { t: "session-search"; reqId: number; results: SessionSearchHit[]; truncated: boolean }
	| { t: "session-org"; reqId: number; doc: OrgDoc; rev: number }
	| { t: "pane"; reqId: number; pane: PaneCapture }
	| { t: "codemap"; reqId: number; view: CodemapView }
	| { t: "codemap-search"; reqId: number; hits: CodemapNode[] }
	| { t: "preview"; reqId: number; shot: PreviewShot }
	| { t: "preview-targets"; reqId: number; targets: PreviewTarget[] }
	| { t: "transcribe"; reqId: number; text: string }
	| { t: "transcribe-setup"; reqId: number }
	/** `repo`: `owner/name` of the listed repository. */
	| { t: "github"; reqId: number; repo: string; items: GithubItem[] }
	| { t: "github-item"; reqId: number; item: GithubItemDetail }
	| { t: "pr-files"; reqId: number; head: string; files: PrFile[] }
	| ({ t: "ci-log"; reqId: number } & CiLogReport)
	/** Where the uploaded file was saved: an absolute path on the computer. */
	| { t: "uploaded"; reqId: number; path: string }
	| { t: "run-targets"; reqId: number; targets: RunTarget[] }
	/** One run: answers `run-start` and `run-stop`. */
	| { t: "run"; reqId: number; run: RunInfo }
	| { t: "run-output"; reqId: number; output: RunOutput }
	| { t: "runs"; reqId: number; runs: RunInfo[] }
	/** The chunk of a `file-download` that starts at its `offset`. */
	| ({ t: "file-chunk"; reqId: number } & FileChunk);

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
	/** The companion can list and edit files of a session's repository. */
	canEdit: boolean;
	/** The companion can screenshot local pages. */
	canPreview: boolean;
	/** The companion can list the session repository's issues and pull requests. */
	canGithub: boolean;
	/** The companion can show a pull request's files and post reviews and merges. */
	canPrReview: boolean;
	/** The companion answers `ci-log` (the Fix-it flow). */
	canFixIt: boolean;
	/** The companion can save prompt attachments on the computer. */
	canUpload: boolean;
	/** The companion can run scheduled prompts. */
	canSchedule: boolean;
	/** Scheduled runs can repeat on a cron expression or an interval, and catch up after downtime. */
	canScheduleCron: boolean;
	/** The companion writes commit and pull request text, and keeps git worktree settings (`git-message`, `git-settings`). */
	canGitFlow: boolean;
	/** The companion can start one prompt on several models in separate worktrees. */
	canFanout: boolean;
	/** The companion can serve files of a session's repository for download. */
	canDownload: boolean;
	/** The companion can run the session repository's scripts and build targets. */
	canRun: boolean;
	/** The companion answers `session-search` (message search across sessions). */
	canSearch: boolean;
	/** The companion can start a session without a project (`start` with `scratch`). */
	canScratch: boolean;
	/** The companion can start sessions in the background (`start` with `prompt`). */
	canBackgroundStart: boolean;
	/** The companion can run vendor agents beside omp: `start` takes `agent`, and the `agents` requests work. */
	canForeign: boolean;
	/** Revision of the computer's session organisation document; null when the companion keeps none. */
	sessionOrgRev: number | null;
	/** The computer's session organisation keeps the active order and the per-session auto-settle opt-out; older ones drop both. */
	canOrderSessions: boolean;
	/** The computer can end the sessions it started when they settle (`endOnSettle`); older ones leave them running. */
	canEndOnSettle: boolean;
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
		canEdit: false,
		canPreview: false,
		canGithub: false,
		canPrReview: false,
		canFixIt: false,
		canUpload: false,
		canSchedule: false,
		canScheduleCron: false,
		canGitFlow: false,
		canFanout: false,
		canDownload: false,
		canRun: false,
		canSearch: false,
		canScratch: false,
		canBackgroundStart: false,
		canForeign: false,
		sessionOrgRev: null,
		canOrderSessions: false,
		canEndOnSettle: false,
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

	async requestTree(instanceId: string): Promise<FileTree> {
		return (await this.#call({ t: "tree", instanceId }, "tree", TREE_TIMEOUT_MS)).tree;
	}

	/**
	 * Save `text` over an existing file; resolves the new version.
	 * @throws {FileChangedError} the file's version is no longer `base`.
	 */
	async writeFile(instanceId: string, path: string, text: string, base: string): Promise<string> {
		return (await this.#call({ t: "file-write", instanceId, path, text, base }, "file-saved")).version;
	}

	/** Save `data` (the file's base64) on the computer as `name`; resolves with the absolute path it was saved under. */
	async uploadFile(instanceId: string, name: string, data: string): Promise<string> {
		return (await this.#call({ t: "upload", instanceId, name, data }, "uploaded", UPLOAD_TIMEOUT_MS)).path;
	}

	/** Scripts and build targets the companion can run in the session's repository root, grouped by source. */
	async requestRunTargets(instanceId: string): Promise<RunTarget[]> {
		return (await this.#call({ t: "run-targets", instanceId }, "run-targets")).targets;
	}

	/** Run one listed target, pinned to the `detail` the person confirmed; resolves once it has started (it keeps running on the computer). */
	async startRun(instanceId: string, target: RunTarget): Promise<RunInfo> {
		return (await this.#call({ t: "run-start", instanceId, target: target.id, detail: target.detail }, "run")).run;
	}

	/** A run's output from position `from` (the previous `next`; 0 for all that is kept). */
	async requestRunOutput(runId: string, from: number): Promise<RunOutput> {
		return (await this.#call({ t: "run-output", runId, from }, "run-output")).output;
	}

	/** Ask a run to stop: its process group gets SIGTERM, then SIGKILL after three seconds. */
	async stopRun(runId: string): Promise<RunInfo> {
		return (await this.#call({ t: "run-stop", runId }, "run")).run;
	}

	/** The session's last ten runs, newest first. */
	async requestRuns(instanceId: string): Promise<RunInfo[]> {
		return (await this.#call({ t: "runs", instanceId }, "runs")).runs;
	}

	/** The chunk of a file on the computer that starts at `offset`; `path` is absolute or relative to the session's cwd. */
	async requestFileChunk(instanceId: string, path: string, offset: number): Promise<FileChunk> {
		const reply = await this.#call(
			{ t: "file-download", instanceId, path, offset },
			"file-chunk",
			DOWNLOAD_CHUNK_TIMEOUT_MS,
		);
		return {
			name: reply.name,
			size: reply.size,
			mime: reply.mime,
			offset: reply.offset,
			data: reply.data,
			done: reply.done,
		};
	}

	async requestFileVersions(instanceId: string, paths: string[]): Promise<(string | null)[]> {
		return (await this.#call({ t: "file-versions", instanceId, paths }, "file-versions")).versions;
	}

	async requestFolders(): Promise<RecentFolder[]> {
		return (await this.#call({ t: "folders" }, "folders")).folders;
	}

	/** Scheduled runs on the computer (needs `canSchedule`). */
	async requestSchedules(): Promise<Schedule[]> {
		return (await this.#call({ t: "schedules" }, "schedules")).schedules;
	}

	/** Create (no `schedule.id`) or replace a scheduled run; resolves with it as stored. */
	async saveSchedule(schedule: ScheduleInput): Promise<Schedule> {
		return (await this.#call({ t: "schedule-save", schedule }, "schedule")).schedule;
	}

	async deleteSchedule(id: string): Promise<void> {
		await this.#call({ t: "schedule-delete", id }, "ok");
	}

	/** Start the run now; resolves once its session hosts (it may take a worktree checkout and omp's boot). */
	async runScheduleNow(id: string): Promise<Schedule> {
		return (await this.#call({ t: "schedule-run-now", id }, "schedule", WORKTREE_START_TIMEOUT_MS)).schedule;
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

	/** Commit message and / or pull request text written for the session's changes (needs `canGitFlow`); falls back to a template when the model fails. */
	async generateGitText(instanceId: string, want: { commit: boolean; pr: boolean }): Promise<GitText> {
		return (await this.#call({ t: "git-message", instanceId, ...want }, "git-message", GIT_MESSAGE_TIMEOUT_MS)).text;
	}

	/** The git flow settings; `settings` replaces them first, `trust` approves or withdraws a repository's setup script, `sweep` runs the worktree cleanup now (needs `canGitFlow`). */
	async gitSettings(options: GitSettingsOptions = {}): Promise<GitFlowSettingsReply> {
		const {
			t: _t,
			reqId: _reqId,
			...reply
		} = await this.#call({ t: "git-settings", ...options }, "git-settings", GIT_SETTINGS_TIMEOUT_MS);
		return reply;
	}

	/** Models the computer can run, for a fan-out (needs `canFanout`). */
	async requestFanoutModels(): Promise<FanoutModel[]> {
		return (await this.#call({ t: "fanout-models" }, "fanout-models", FANOUT_MODELS_TIMEOUT_MS)).models;
	}

	/** One prompt on each of 2–4 models in separate worktrees; resolves once every session that could start hosts (needs `canFanout`). */
	async startFanout(request: FanoutRequest): Promise<FanoutGroup> {
		return (await this.#call({ t: "fanout-start", request }, "fanout-started", WORKTREE_START_TIMEOUT_MS)).group;
	}

	/** The group's sessions with status, cost, changed files and verify result. */
	async requestFanoutCompare(group: string): Promise<FanoutCompare> {
		return (await this.#call({ t: "fanout-compare", group }, "fanout-compare", USAGE_TIMEOUT_MS)).compare;
	}

	/** Keep one session of a group; optionally remove the other worktrees (never ones with uncommitted changes unless `discardDirty`). */
	async keepFanoutRun(request: FanoutKeepRequest): Promise<FanoutKeepResult> {
		return (await this.#call({ t: "fanout-keep", request }, "fanout-kept", GIT_WRITE_TIMEOUT_MS * 2)).result;
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

	/** The GitHub alert settings the companion uses; `settings` replaces them first when given. */
	async prAlerts(settings?: PrAlertSettings): Promise<PrAlertSettings> {
		return (await this.#call({ t: "pr-alerts", settings }, "pr-alerts")).settings;
	}

	/** Sessions across every project, live and ended, newest activity first. */
	async requestSessions(opts: { limit?: number; q?: string } = {}): Promise<SessionOverview[]> {
		return (await this.#call({ t: "sessions", limit: opts.limit, q: opts.q }, "sessions", USAGE_TIMEOUT_MS)).sessions;
	}

	/** Prompts and replies across every session that contain all the words of `query` (needs `canSearch`), newest first. */
	async searchSessions(query: string, limit?: number): Promise<{ results: SessionSearchHit[]; truncated: boolean }> {
		const reply = await this.#call({ t: "session-search", query, limit }, "session-search", USAGE_TIMEOUT_MS);
		return { results: reply.results, truncated: reply.truncated };
	}

	/** Merge this device's session organisation into the computer's and read the result (needs `sessionOrgRev`). */
	async syncSessionOrg(doc?: OrgDoc): Promise<{ doc: OrgDoc; rev: number }> {
		const reply = await this.#call({ t: "session-org", doc }, "session-org");
		return { doc: reply.doc, rev: reply.rev };
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

	/** Issues or pull requests of the session's GitHub repository, most recently updated first. */
	async requestGithub(
		instanceId: string,
		kind: GithubKind,
		filter: GithubFilter,
	): Promise<{ repo: string; items: GithubItem[] }> {
		const { repo, items } = await this.#call({ t: "github", instanceId, kind, filter }, "github", GITHUB_TIMEOUT_MS);
		return { repo, items };
	}

	/** One issue or pull request with its description, latest comments and checks. */
	async requestGithubItem(instanceId: string, kind: GithubKind, number: number): Promise<GithubItemDetail> {
		return (await this.#call({ t: "github-item", instanceId, kind, number }, "github-item", GITHUB_TIMEOUT_MS)).item;
	}

	/** The changed files of a pull request and the head commit they were read at. */
	async requestPrFiles(instanceId: string, number: number): Promise<PrFiles> {
		const { head, files } = await this.#call({ t: "pr-files", instanceId, number }, "pr-files", PR_REVIEW_TIMEOUT_MS);
		return { head, files };
	}

	/** One file's diff of a pull request at `head` (the commit `requestPrFiles` returned). */
	async requestPrDiff(
		instanceId: string,
		number: number,
		head: string,
		path: string,
	): Promise<{ diff: string; truncated: boolean }> {
		const { diff, truncated } = await this.#call(
			{ t: "pr-diff", instanceId, number, head, path },
			"diff",
			PR_REVIEW_TIMEOUT_MS,
		);
		return { diff, truncated };
	}

	/** Post a review on GitHub; resolves with its URL. */
	async submitPrReview(instanceId: string, number: number, review: PrReviewInput): Promise<string> {
		return (await this.#call({ t: "pr-review", instanceId, number, review }, "link", PR_REVIEW_TIMEOUT_MS)).url;
	}

	/** Merge a pull request at `head`; `allowDraft` / `allowFailing` / `allowPending` are the user's explicit choice to merge anyway. */
	async mergePr(
		instanceId: string,
		number: number,
		options: {
			method: PrMergeMethod;
			deleteBranch: boolean;
			head: string;
			allowDraft?: boolean;
			allowFailing?: boolean;
			allowPending?: boolean;
		},
	): Promise<void> {
		await this.#call({ t: "pr-merge", instanceId, number, ...options }, "ok", PR_REVIEW_TIMEOUT_MS);
	}

	/** Failing checks of pull request `number` in `repo` (`owner/name`) with log tails, and where to work on them. */
	async requestCiLog(repo: string, number: number): Promise<CiLogReport> {
		const { pr, failures, moreFailures, sessions, folders } = await this.#call(
			{ t: "ci-log", repo, number },
			"ci-log",
			CI_LOG_TIMEOUT_MS,
		);
		return { pr, failures, moreFailures, sessions, folders };
	}

	/** Sessions that changed `path` in the session's repository, newest first; the scan is bounded to recent sessions. */
	async requestFileSessions(instanceId: string, path: string): Promise<SessionOverview[]> {
		return (await this.#call({ t: "file-sessions", instanceId, path }, "sessions", USAGE_TIMEOUT_MS)).sessions;
	}

	/** The vendor agents on the computer, with install and sign-in state (needs `canForeign`); `refresh` probes them again. */
	async requestAgents(refresh?: boolean): Promise<CompanionAgent[]> {
		const timeout = refresh ? AGENTS_REFRESH_TIMEOUT_MS : undefined;
		return (await this.#call({ t: "agents", refresh }, "agents", timeout)).agents;
	}

	/** Install or update a built-in agent's ACP adapter; resolves with the agents as they are afterwards. */
	async installAgent(id: string): Promise<CompanionAgent[]> {
		return (await this.#call({ t: "agent-install", id }, "agents", AGENT_INSTALL_TIMEOUT_MS)).agents;
	}

	/** Save a custom ACP agent (a new one without `agent.id`); resolves with the agents afterwards. */
	async saveCustomAgent(agent: CustomAgentInput): Promise<CompanionAgent[]> {
		return (await this.#call({ t: "agent-custom-save", agent }, "agents", AGENTS_REFRESH_TIMEOUT_MS)).agents;
	}

	/** Remove a custom ACP agent; resolves with the agents afterwards. */
	async deleteCustomAgent(id: string): Promise<CompanionAgent[]> {
		return (await this.#call({ t: "agent-custom-delete", id }, "agents")).agents;
	}

	/**
	 * Start omp, or with `agent` (needs `canForeign`) a vendor agent, in `cwd` (resuming session `resume`); resolves with its host `instanceId` once it is listed.
	 * `model`: a vendor model id of `agent`; `permission`: how a foreign session answers tool-permission requests (default `supervised`).
	 * `worktree` (new sessions only): work on a new branch in its own git worktree instead of `cwd`.
	 * `scratch` (needs `canScratch`): no project; `cwd` is ignored and the computer makes a folder named after `scratch.hint`.
	 * `prompt` (needs `canBackgroundStart`): the first message, sent as soon as omp is up.
	 */
	async startSession(
		cwd: string,
		options: {
			resume?: string;
			sandboxed?: boolean;
			worktree?: { branch?: string };
			scratch?: { hint?: string };
			prompt?: string;
			agent?: string;
			model?: string;
			permission?: ForeignPermission;
			force?: boolean;
		} = {},
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
				canEdit: frame.canEdit ?? false,
				canPreview: frame.canPreview ?? false,
				canGithub: frame.canGithub ?? false,
				canPrReview: frame.canPrReview ?? false,
				canFixIt: frame.canFixIt ?? false,
				canUpload: frame.canUpload ?? false,
				canSchedule: frame.canSchedule ?? false,
				canScheduleCron: frame.canScheduleCron ?? false,
				canFanout: frame.canFanout ?? false,
				canDownload: frame.canDownload ?? false,
				canRun: frame.canRun ?? false,
				canGitFlow: frame.canGitFlow ?? false,
				canSearch: frame.canSearch ?? false,
				canScratch: frame.canScratch ?? false,
				canBackgroundStart: frame.canBackgroundStart ?? false,
				canForeign: frame.canForeign ?? false,
				sessionOrgRev: frame.sessionOrgRev ?? null,
				canOrderSessions: frame.canOrderSessions ?? false,
				canEndOnSettle: frame.canEndOnSettle ?? false,
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
		if (frame.t === "error") {
			if (frame.openElsewhere) pending.reject(new SessionOpenElsewhereError(frame.openElsewhere));
			else if (frame.changed !== undefined) pending.reject(new FileChangedError(frame.changed));
			else pending.reject(new Error(frame.message));
		} else if (frame.t !== pending.expect) pending.reject(new Error(`unexpected companion reply: ${frame.t}`));
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
