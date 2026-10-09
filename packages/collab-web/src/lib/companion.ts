/**
 * Companion pairing: one long-lived encrypted room per computer, opened by
 * `scripts/companion.ts`, that lists every omp session hosting collab on that
 * machine and hands out their control links on request.
 *
 * The room rides the normal relay with the normal sealing, so the relay sees
 * ciphertext only. The pairing link carries the room key and is therefore a
 * standing capability for every session on the machine: it lives in this
 * origin's storage and nowhere else.
 *
 * Pairing link form: `pair:<collab link>`, inside a web URL fragment
 * (`https://web/#pair:<link>`) or as plain pasted text.
 */

import { importRoomKey } from "./codec";
import { parseCollabLink } from "./link";
import { CollabSocket } from "./socket";
import { readJson, writeJson } from "./storage";

export const PAIR_PREFIX = "pair:";
const PAIRING_KEY = "omp.collab.companion";
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

/** `PushSubscription.toJSON()` as the browser hands it out. */
export interface PushSubscriptionJson {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export type CompanionRequest =
	| { t: "list" }
	| { t: "link"; reqId: number; instanceId: string }
	/** Add (`on`) or drop this device's Web Push subscription. */
	| { t: "push"; reqId: number; subscription: PushSubscriptionJson; on: boolean }
	/** The device is showing the app (`visible`): the companion holds pushes to `endpoint` meanwhile. */
	| { t: "presence"; endpoint: string | null; visible: boolean }
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
	 */
	| { t: "start"; reqId: number; cwd: string; resume?: string; sandboxed?: boolean; worktree?: { branch?: string } }
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
	/** Past and live sessions across projects, newest activity first; `q` filters by title or folder. */
	| { t: "sessions"; reqId: number; limit?: number; q?: string }
	/** Code map of the session's repository around `focus` (needs `canCodemap`); `flow` adds a walk for symbol foci. */
	| { t: "codemap"; reqId: number; instanceId: string; focus: CodemapFocus; flow?: CodemapFlowDirection }
	/** Files whose path matches `q`, then symbols matching its words. */
	| { t: "codemap-search"; reqId: number; instanceId: string; q: string };

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
			/** Power of the computer; absent off macOS and from companions that predate it. */
			power?: CompanionPower;
	  }
	| { t: "link"; reqId: number; url: string }
	| { t: "ok"; reqId: number }
	| { t: "error"; reqId: number; message: string }
	| { t: "git"; reqId: number; git: GitSnapshot }
	| { t: "diff"; reqId: number; diff: string; truncated: boolean }
	| { t: "file"; reqId: number; file: FileContent }
	| { t: "folders"; reqId: number; folders: RecentFolder[] }
	| { t: "review"; reqId: number; review: GitReview }
	/** The started session is hosting and listed under `instanceId`. */
	| { t: "started"; reqId: number; instanceId: string }
	| { t: "usage"; reqId: number; usage: UsageReport }
	| { t: "sessions"; reqId: number; sessions: SessionOverview[] }
	| { t: "codemap"; reqId: number; view: CodemapView }
	| { t: "codemap-search"; reqId: number; hits: CodemapNode[] };

/**
 * The companion room link inside a pasted message, scanned QR code, or URL
 * fragment, or null when the text holds no pairing link.
 */
export function extractPairing(text: string): string | null {
	for (const token of text.trim().split(/\s+/)) {
		const at = token.indexOf(PAIR_PREFIX);
		if (at < 0) continue;
		const candidate = token.slice(at + PAIR_PREFIX.length).replace(/[>)"'`.,;]+$/, "");
		if (!("error" in parseCollabLink(candidate))) return candidate;
	}
	return null;
}

export function loadPairing(): string | null {
	const raw = readJson(PAIRING_KEY);
	return typeof raw === "string" ? raw : null;
}

export function savePairing(link: string | null): void {
	writeJson(PAIRING_KEY, link);
}

export type CompanionPhase = "connecting" | "live" | "offline";

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
	/** Power of the computer, while the companion reports it. */
	power: CompanionPower | null;
	/** Web Push application server key, once the companion has listed hosts. */
	vapidKey: string | null;
	/** Why the room is unreachable while `offline`. */
	error: string | null;
}

/** A reply that answers one request (everything but the `hosts` broadcast). */
type CompanionAnswer = Exclude<CompanionReply, { t: "hosts" }>;
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
	#snapshot: CompanionSnapshot = {
		phase: "connecting",
		machine: null,
		hosts: [],
		idle: [],
		canStart: false,
		canSandbox: false,
		canPr: false,
		canCodemap: false,
		power: null,
		vapidKey: null,
		error: null,
	};

	/** @throws Error when the link does not parse. */
	constructor(link: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => {
			this.#socket.send({ t: "list" });
			if (this.#presence) this.#socket.send(this.#presence);
		};
		this.#socket.onFrame = frame => this.#apply(frame);
		this.#socket.onClose = (reason, willReconnect) => {
			this.#rejectPending(new Error(`companion disconnected: ${reason}`));
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
		if (this.#snapshot.phase === "offline") this.#update({ phase: "connecting", error: null });
		this.#socket.connect();
	}

	/** Foreground / online: retry now. An offline room (companion stopped) is retried too. */
	resume(): void {
		if (this.#snapshot.phase === "offline") this.connect();
		else this.#socket.resume();
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

	/**
	 * Start omp in `cwd` (resuming session `resume`); resolves with its host `instanceId` once it is listed.
	 * `worktree` (new sessions only): work on a new branch in its own git worktree instead of `cwd`.
	 */
	async startSession(
		cwd: string,
		options: { resume?: string; sandboxed?: boolean; worktree?: { branch?: string } } = {},
	): Promise<string> {
		const timeout = options.worktree ? WORKTREE_START_TIMEOUT_MS : START_TIMEOUT_MS;
		return (await this.#call({ t: "start", cwd, ...options }, "started", timeout)).instanceId;
	}

	/** Make an idle session host collab; resolves with its control link. */
	async shareSession(instanceId: string): Promise<string> {
		return (await this.#call({ t: "share", instanceId }, "link", START_TIMEOUT_MS)).url;
	}

	/** Tell the companion whether this device shows the app now; re-sent after reconnects. */
	setPresence(endpoint: string | null, visible: boolean): void {
		this.#presence = { t: "presence", endpoint, visible };
		if (this.#snapshot.phase === "live") this.#socket.send(this.#presence);
	}

	#call<T extends CompanionAnswer["t"]>(
		call: CompanionCall,
		expect: T,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<Extract<CompanionAnswer, { t: T }>> {
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
		this.#socket.send({ ...call, reqId } as CompanionRequest);
		return promise;
	}

	#apply(frame: CompanionReply): void {
		if (frame.t === "hosts") {
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
		if (frame.t === "error") pending.reject(new Error(frame.message));
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
