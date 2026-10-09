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
	/** Start omp in `cwd` (resuming session `resume` when given), hosting with control access. */
	| { t: "start"; reqId: number; cwd: string; resume?: string }
	/** Make an idle session host collab; answered with a `link`. */
	| { t: "share"; reqId: number; instanceId: string };

export type CompanionReply =
	/**
	 * `vapidKey`: the companion's Web Push application server key (base64url).
	 * `idle`: sessions that could `share` (empty when the omp CLI cannot list them).
	 * `canStart`: the companion can `start` sessions (tmux available).
	 */
	| {
			t: "hosts";
			machine: string;
			hosts: CompanionHost[];
			vapidKey: string;
			/** Absent from companions that predate it. */
			idle?: CompanionIdleSession[];
			canStart?: boolean;
	  }
	| { t: "link"; reqId: number; url: string }
	| { t: "ok"; reqId: number }
	| { t: "error"; reqId: number; message: string }
	| { t: "git"; reqId: number; git: GitSnapshot }
	| { t: "diff"; reqId: number; diff: string; truncated: boolean }
	| { t: "file"; reqId: number; file: FileContent }
	| { t: "folders"; reqId: number; folders: RecentFolder[] }
	/** The started session is hosting and listed under `instanceId`. */
	| { t: "started"; reqId: number; instanceId: string };

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

	/** Start omp in `cwd` (resuming session `resume`); resolves with its host `instanceId` once it is listed. */
	async startSession(cwd: string, resume?: string): Promise<string> {
		return (await this.#call({ t: "start", cwd, resume }, "started", START_TIMEOUT_MS)).instanceId;
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
