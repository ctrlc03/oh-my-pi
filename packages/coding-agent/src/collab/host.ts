/**
 * Host side of a collab live session.
 *
 * Taps the host session's event stream and SessionManager append chokepoint,
 * broadcasting entries/events/state to guests through the relay. Guests prompt
 * and abort through us; the host machine runs the agent and tools. The host's
 * subagent ecosystem is mirrored too: task EventBus traffic (observer HUD),
 * agent-registry snapshots (Agent Hub table), hub chat/kill/revive commands,
 * and incremental subagent-transcript reads.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import type {
	BusChannel,
	CollabCommand,
	CollabCommandChoice,
	CollabFeature,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	SessionCommand,
	SessionSpend,
	AgentEvent as WireAgentEvent,
	WireModel,
	WireProfile,
	WirePrWatch,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import { buildSkillCommandPrompt } from "../modes/skill-command";
import { cfgPersonalAllowShareLinks, cfgPersonalEnabled } from "../personal/settings";
import type { InteractiveModeContext } from "../modes/types";
import { cfgPlanEnabled } from "../plan-mode/settings";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { SPEND_CAP_NOTICE_SOURCE } from "../session/spend-cap";
import type { AgentSessionEvent, PromptModelOverride } from "../session/agent-session";
import { parseCompactArgs } from "../session/compact-modes";
import { stripImagesFromMessage, USER_INTERRUPT_LABEL } from "../session/messages";
import { describeFileRestore } from "../session/file-snapshots";
import type { SessionEntry as StoredSessionEntry } from "../session/session-entries";
import { executeBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import {
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../task/types";
import { generateRoomKey, generateWriteToken, importRoomKey } from "./crypto";
import { collabDisplayName } from "./display-name";
import {
	buildGuestCommands,
	COLLAB_RUNNABLE_BUILTINS,
	type GuestCommandRoute,
	type GuestCommandSource,
	routeGuestCommand,
} from "./guest-commands";
import { hostKeepsGuestsAcrossSwitch, recentSessionChoices, replaceSessionForGuest } from "./guest-session-commands";
import { buildMentionContext, withMentionContext } from "./mentions";
import { type PromptModelRequest, type PromptModelResolution, resolvePromptModel } from "./prompt-model";
import { queueEditRefusal, rewriteQueuedPrompt } from "./queue-edit";
import {
	type AgentSnapshot,
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabPromptDetails,
	type CollabSessionState,
	encodeBranchFrame,
	encodeEntryFrame,
	encodeEventFrame,
	encodeSnapshotChunk,
	type EncodedFrame,
	formatCollabLink,
	formatCollabWebLink,
	generateRoomId,
	parseCollabLink,
} from "./protocol";
import {
	type CollabAccess,
	type CollabHostPublication,
	type CollabHostRegistrySource,
	type CollabHostSnapshot,
	publishCollabHost,
} from "./registry";
import { FanoutSocket } from "./relay-fanout";
import {
	announceRestoredFiles,
	previewRewindFiles,
	redoRestoredFiles,
	type RewindFilesChannel,
	restoreFilesForRewind,
	rollBackRestoredFiles,
} from "./rewind-files";
import { runGuestTurnUndo } from "./turn-undo";
import { replyReceipts, replyTurnDiff } from "./turn-diff";
import { replyContextItems, runGuestContextPrune } from "./context-items";
import { replyInspect, replyRequestPreview } from "./inspect";
import { HostUsageLimits, RESUME_AUTHOR, RESUME_PROMPT } from "./usage-limits";
import {
	COLLAB_ENTRY_OMITTED_CUSTOM_TYPE,
	copyForReplication,
	MAX_REPLICATED_PAYLOAD_BYTES,
	oversizedEntryNotice,
	type ReplicatedEntry,
	serializeReplicatedEntry,
	serializeReplicatedEvent,
} from "./replication-shrink";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	advisor_cost_changed: true,
	auto_compaction_end: true,
	queue_update: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
/** Gathers streaming updates and subagent ticks that land together into one flush. */
const SUPERSEDING_GATHER_MS = 16;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
	reset_boundary: true,
};
const COLLAB_BUS_CHANNELS = [
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
] as const satisfies readonly BusChannel[];

/** Optional capabilities this host advertises in `welcome`. */
const COLLAB_FEATURES: CollabFeature[] = [
	"follow-up",
	"queue-edit",
	"mentions",
	"rewind",
	"commands",
	"prompt-model",
	"undo",
	"spend-cap",
	"context-items",
	"inspect",
	"profiles",
	"cache-stats",
	"approval-grants",
	"pr-watch",
];

/** A prompt's message content: the text, plus any images the guest attached. */
function withImages(text: string, images: ImageContent[] | undefined): string | (TextContent | ImageContent)[] {
	return images && images.length > 0 ? [{ type: "text", text }, ...images] : text;
}

/** What a `session-cmd` frame carries besides its command and `arg`. */
interface SessionCmdOptions {
	restoreFiles?: boolean;
	/** `queue-*`: the queued follow-up (`state.followUpIds`). */
	id?: string;
	/** `queue-move`: the position it takes. */
	index?: number;
	/** `queue-edit`: references in the new text. */
	mentions?: unknown;
}

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: StoredSessionEntry): entry is StoredSessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}

/**
 * Models listed in a writer's welcome: a backstop against a catalog of thousands, not a shortlist. One
 * provider with a large catalog (Bedrock lists over 200) must not push every other provider out of the picker.
 */
const MAX_WELCOME_MODELS = 1000;
/** A hello reloads the `/resume` suggestions at most this often. */
const RESUME_CHOICES_TTL_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame. The first MB of a snapshot takes
 * ~3s through the default relay, so a 512 KB chunk lands well under the
 * guest's 30 s per-chunk progress timeout; oversized single entries still
 * ship in a chunk of their own. Measured in UTF-8 bytes — the unit the relay
 * and the seal step care about — not UTF-16 code units (#11433).
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
const MAX_PENDING_UI_REQUESTS = 64;
/**
 * Outcome of {@link CollabHost.requestGuestUi}. `answered` carries the guest's
 * response (an `undefined` value is a genuine guest cancel); `unavailable`
 * means the collab channel went away (teardown, relay drop) or the request was
 * aborted before any guest answered — callers MUST NOT treat it as a cancel.
 */
export type CollabGuestUiResult = { kind: "answered"; value: CollabUiResponseValue } | { kind: "unavailable" };

interface PendingCollabUiRequest {
	request: CollabUiRequest;
	promise: Promise<CollabGuestUiResult>;
	settle(result: CollabGuestUiResult): void;
	responsePending?: boolean;
}

/**
 * Identity a host publishes to the local registry. The controller that owns
 * hosting supplies a process-lifetime `instanceId` and bumps `generation` for
 * every room it starts; `access` caps what the registry hands out for this
 * room (the room itself always carries a write token for its own links).
 */
export interface CollabHostOptions {
	instanceId?: string;
	generation?: number;
	access?: CollabAccess;
	/**
	 * Whether guests may drive the session yet: prompts, interrupts, and agent
	 * commands are refused with an error frame while this returns false. Joins,
	 * transcript fetches, and dialog answers are always accepted, so a writer
	 * can still answer a question raised while the session is starting up.
	 * Defaults to always ready.
	 */
	guestActionsReady?: () => boolean;
	/**
	 * Called once when the relay ends the room for good after it opened —
	 * a non-retryable close or fatal socket failure (e.g. send backlog), not
	 * `stop()`. Teardown has already begun; the owner may start a successor.
	 */
	onEnded?: () => void;
}

/**
 * `start()` rejects with this when `stop()` deliberately ends the room while it
 * is still connecting (session switch, access upgrade, `/collab stop`,
 * shutdown), as opposed to a relay failure.
 */
export class CollabHostStoppedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CollabHostStoppedError";
	}
}

/**
 * `start()` rejects with this when the relay never opened the room: the first
 * connection closed or timed out. The room was never joinable or published, so
 * an owner may retry it without guests or the registry having seen it.
 */
export class CollabRelayUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CollabRelayUnavailableError";
	}
}

export class CollabHost {
	#ctx: InteractiveModeContext;
	#socket: FanoutSocket | null = null;
	#link = "";
	#webLink = "";
	#viewLink = "";
	#webViewLink = "";
	/** {@link webLink} / {@link webViewLink} plus the local relay; empty without one. Registry consumers only: the printed link stays shareable beyond this machine. */
	#localWebLink = "";
	#localWebViewLink = "";
	#writeToken: Uint8Array | null = null;
	#sessionId: string;
	/** `/resume` suggestions for writers' welcomes; see {@link #refreshResumeChoices}. */
	#resumeChoices: CollabCommandChoice[] = [];
	#resumeChoicesAt = 0;
	#startedAt = 0;
	readonly #instanceId: string;
	readonly #generation: number;
	readonly #guestActionsReady: () => boolean;
	readonly #onEnded: (() => void) | undefined;
	readonly #access: CollabAccess;
	#relayConnected = false;
	#registryPublication: CollabHostPublication | null = null;
	/** Publication still being created; teardown awaits and withdraws it. */
	#pendingPublication: Promise<CollabHostPublication | null> | null = null;
	/** Set by the first teardown (explicit stop or fatal relay close); every later stop() awaits it. */
	#teardownDone: Promise<void> | null = null;
	/** Rejects the in-flight first-open wait when `stop()` overtakes `start()`. */
	#abortStart: ((reason: Error) => void) | null = null;
	#unsubscribe?: () => void;
	/**
	 * Guest identity and permission, keyed by relay peer id. Drives the
	 * participant list, notices, the status segment and the writable-peer fan-out.
	 * Deliverability is not its job: {@link FanoutSocket.isServing} owns that, and
	 * the two disagree on purpose while a peer is connected but has not said hello
	 * yet, and after a shed, when the peer leaves the participant list but is
	 * still owed a resync error.
	 */
	#peers = new Map<number, { name: string; canWrite: boolean; zip: boolean }>();
	/**
	 * Never reset, including across a room recreation: ids must not be reissued, or
	 * a late `ui-response` carrying an old id would settle an unrelated new request.
	 * An old id that maps to nothing is harmless.
	 */
	#uiReqSeq = 0;
	#pendingUi = new Map<number, PendingCollabUiRequest>();
	#lastStateJson = "";
	/** Ids of the wire-visible path (root → leaf) guests currently replicate; the baseline for `branch` frames. */
	#sentPath: string[] = [];
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#busUnsubscribers: (() => void)[] = [];
	/**
	 * Unsent broadcasts that each carry a whole current view, keyed by what they
	 * describe: `message_update` the reply so far, `tool_execution_update` the
	 * tool's partial result so far, a subagent progress tick the agent's state.
	 * A newer one supersedes an unsent older one. Forwarded one frame per token
	 * or tick, a long reply, a large tool call, or a busy task run outran a slow
	 * relay link and tripped the send backlog limit, which ends the room. Built
	 * lazily, so only the survivor is serialized.
	 */
	#superseding = new Map<string, () => CollabFrame | EncodedFrame>();
	#supersedingTimer: Timer | null = null;
	/** A flush is still queued in the socket; the next waits for it to drain. */
	#supersedingDraining = false;
	#registryUnsubscribe?: () => void;
	#profileUnsubscribe?: () => void;
	#prWatchUnsubscribe?: () => void;
	/** Subscription limit windows, the limited stage and the resume-at-reset timer (feature `usage-limits`). */
	#usageLimits?: HostUsageLimits;
	/** Set the moment `stop()` begins; `#stopped` follows once teardown has run. */
	#stopping = false;
	/** The in-flight or finished `stop()`; concurrent callers share it. */
	#stopDone: Promise<void> | undefined;
	#stopped = false;

	constructor(ctx: InteractiveModeContext, options: CollabHostOptions = {}) {
		this.#ctx = ctx;
		this.#instanceId = options.instanceId ?? randomBytes(8).toString("hex");
		this.#generation = options.generation ?? 1;
		this.#access = options.access ?? "control";
		this.#guestActionsReady = options.guestActionsReady ?? (() => true);
		this.#onEnded = options.onEnded;
		// The room mirrors the session that is active when it is created; the
		// frame guard and the registry snapshot compare against this from then on.
		this.#sessionId = ctx.sessionManager.getSessionId();
	}

	/** Registry identity shared by every room this process hosts. */
	get instanceId(): string {
		return this.#instanceId;
	}

	/** Registry generation of this room; a later room in the same process has a higher one. */
	get generation(): number {
		return this.#generation;
	}

	/** Highest access the registry hands out for this room. */
	get access(): CollabAccess {
		return this.#access;
	}

	/** Session this room mirrors; fixed at `start()`. */
	get sessionId(): string {
		return this.#sessionId;
	}

	get stopped(): boolean {
		return this.#stopped;
	}

	/**
	 * The room is ending or gone. Checked before any guest action or mirrored
	 * frame: `stop()` drains the goodbye and awaits registry withdrawal before
	 * the socket closes, and no guest prompt, abort, answer, or join may reach
	 * the session — nor may any frame reach guests — once it has begun. The
	 * controller treats an ending room as absent, so `/collab` starts a new
	 * room instead of re-printing one that is about to close.
	 */
	get ending(): boolean {
		return this.#stopping || this.#stopped;
	}

	/** True while a host-side question is retained for (or shown to) a writable guest. */
	get inputRequired(): boolean {
		return this.#pendingUi.size > 0;
	}

	get relayConnected(): boolean {
		return this.#relayConnected;
	}

	get link(): string {
		return this.#link;
	}

	/** Browser deep link for the configured collab web UI. */
	get webLink(): string {
		return this.#webLink;
	}

	/** Read-only variant of {@link link}: bare room key, no write token. */
	get viewLink(): string {
		return this.#viewLink;
	}

	/** Read-only variant of {@link webLink}. */
	get webViewLink(): string {
		return this.#webViewLink;
	}

	/**
	 * Browser link for tools on this machine (the registry, the companion): the same room with the
	 * local relay appended when one is configured, so a viewer on this computer can skip the public relay.
	 */
	registryLink(access: CollabAccess): string {
		// A Personal session is reachable by the owner's paired devices (control links) and nobody else.
		if (access === "view" && this.#personalSession && !cfgPersonalAllowShareLinks.get(this.#ctx.settings)) return "";
		if (access === "view") return this.#localWebViewLink || this.#webViewLink;
		return this.#localWebLink || this.#webLink;
	}

	/** The session is a Personal agent: its write peers are the owner's devices, and the prompts they send are stamped so. */
	get #personalSession(): boolean {
		return cfgPersonalEnabled.get(this.#ctx.settings);
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: collabDisplayName(this.#ctx), role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	/**
	 * Mirror a host-side question to writable guests. Accepted from
	 * construction until teardown — including while the relay connection is
	 * still being established — so a dialog raised by an extension's
	 * `session_start` hook is retained for the first writer that joins.
	 *
	 * Refused, and the room ended, once the active session is no longer the
	 * one this room mirrors: `/resume` runs the new session's `session_switch`
	 * hooks before the session-change callbacks fire, so a dialog raised there
	 * must stay local rather than reach the previous session's guests.
	 */
	requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (!this.#guestTrafficAllowed() || signal?.aborted || this.#pendingUi.size >= MAX_PENDING_UI_REQUESTS)
			return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, promise, settle });
		this.#sendWritablePeers({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) this.#send(frame, peerId);
		}
	}

	/**
	 * @param localRelayUrl A loopback relay (`ws://127.0.0.1:<port>`) that serves this room as well;
	 * guests may join through either relay. It never ends or degrades the public session.
	 */
	async start(relayUrl: string, webUrl = "", localRelayUrl?: string): Promise<void> {
		if (this.ending) throw new CollabHostStoppedError("collab host already stopped");
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#webLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		this.#webViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl);
		if (localRelayUrl !== undefined) {
			this.#localWebLink = formatCollabWebLink(relayUrl, roomId, rawKey, writeToken, webUrl, localRelayUrl);
			this.#localWebViewLink = formatCollabWebLink(relayUrl, roomId, rawKey, undefined, webUrl, localRelayUrl);
		}
		const parsed = parseCollabLink(this.#localWebLink || this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const firstOpen = Promise.withResolvers<void>();
		// stop() may reject this before start() reaches its await (during key
		// import); mark the rejection handled so it can only surface at the await.
		firstOpen.promise.catch(() => {});
		this.#abortStart = firstOpen.reject;
		await this.#refreshResumeChoices();
		const key = await importRoomKey(rawKey);
		if (this.ending) throw new CollabHostStoppedError("collab host stopped before connecting");

		const socket = new FanoutSocket({ wsUrl: parsed.wsUrl, localWsUrl: parsed.localWsUrl, key });
		this.#socket = socket;

		let opened = false;
		socket.onOpen = () => {
			this.#relayConnected = true;
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onRoomRecreated = owns => this.#handleRoomRecreated(owns);
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = msg => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			this.#relayConnected = false;
			if (this.#stopping || this.#stopped) return;
			if (!opened) {
				// A close the socket would retry (unreachable relay, dropped handshake)
				// means the relay is unavailable; a fatal one means it refused the room.
				firstOpen.reject(willReconnect ? new CollabRelayUnavailableError(reason) : new Error(reason));
				return;
			}
			if (willReconnect) {
				this.#ctx.showStatus(`Collab relay connection lost (${reason}), reconnecting…`, { dim: true });
			} else {
				void this.#teardown();
				this.#ctx.session.emitNotice("warning", `Collab ended: ${reason}`, "collab");
				this.#onEnded?.();
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new CollabRelayUnavailableError("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			// A question retained while connecting has no room to reach anymore.
			for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
			this.#pendingUi.clear();
			throw err;
		} finally {
			clearTimeout(timeout);
			this.#abortStart = null;
		}

		this.#startedAt = Date.now();
		// Subscribe as soon as the relay is open. A guest can join as soon as the
		// link is visible (auto-start installs the room before this resolves).
		// Frames are mirrored only while #broadcastAllowed() holds (at least one
		// peer); a joining guest's welcome snapshot covers everything before that.
		// The local registry work below is independent of this.
		this.#unsubscribe = this.#ctx.session.subscribe(event => {
			if (isWireAgentEvent(event)) this.#broadcastEvent(event);
			this.#onEventForState(event);
			this.#usageLimits?.observe(event);
		});
		this.#usageLimits = this.#createUsageLimits();
		this.#usageLimits.start();
		// Subagent frames publish on the session tree's observability bus at
		// any spawn depth; mirroring from it is what lets nested agents reach
		// guests at all. Embedders on the previous constructor signature only
		// wire a session bus — fall back to it so depth-1 frames keep flowing.
		const observabilityBus = this.#ctx.subagentEventBus ?? this.#ctx.eventBus;
		if (observabilityBus) {
			for (const channel of COLLAB_BUS_CHANNELS) {
				this.#busUnsubscribers.push(
					observabilityBus.on(channel, data => {
						if (!this.#broadcastAllowed()) return;
						if (channel === TASK_SUBAGENT_PROGRESS_CHANNEL) {
							this.#supersede(`progress:${(data as SubagentProgressPayload).progress.id}`, () => ({
								t: "bus",
								channel,
								data,
							}));
							return;
						}
						this.#send({ t: "bus", channel, data });
					}),
				);
			}
		}
		this.#registryUnsubscribe = AgentRegistry.global().onChange(() => this.#scheduleAgentsBroadcast());
		this.#profileUnsubscribe = this.#ctx.session.profiles?.onChange(() => this.#scheduleStateBroadcast());
		this.#prWatchUnsubscribe = this.#ctx.session.prWatch?.onChange(() => this.#scheduleStateBroadcast());
		this.#sentPath = this.#activeWirePath().map(entry => entry.id);
		this.#ctx.sessionManager.onEntryAppended = entry => {
			if (isWireSessionEntry(entry)) this.#replicateAppended(entry);
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		};
		this.#ctx.sessionManager.onLeafMoved = () => {
			if (!this.#sessionStillCurrent()) return;
			this.#syncActivePath(this.#activeWirePath());
			this.#scheduleStateBroadcast();
		};
		this.#updateStatusSegment();

		// Publish to the local host registry only after the relay connection
		// succeeded. Publication failure warns but never breaks hosting (#6099).
		// The in-flight task is tracked so a stop() that overtakes it withdraws
		// the result before resolving: a successor room reuses this endpoint.
		const publishing = publishCollabHost(this.#registrySource(), { instanceId: this.#instanceId }).then(
			publication => publication,
			err => {
				logger.warn("Collab host registry publication failed", { error: String(err) });
				this.#ctx.showStatus("Collab host discovery unavailable (omp collab list will not show this session)", {
					dim: true,
				});
				return null;
			},
		);
		this.#pendingPublication = publishing;
		const publication = await publishing;
		this.#pendingPublication = null;
		if (this.ending) {
			// stop() began, or the relay closed fatally, while publication was in
			// flight: withdraw it here too (close is idempotent) and refuse to
			// finish startup instead of installing a dead host that stays discoverable.
			if (publication) {
				await publication
					.close()
					.catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
			}
			if (this.#stopping) throw new CollabHostStoppedError("collab host stopped during startup");
			throw new Error("relay connection closed during startup");
		}
		this.#registryPublication = publication;
	}

	/**
	 * Broadcast a goodbye, detach all taps, withdraw the registry entry, and
	 * close the socket. Resolves once the room is fully gone — including a
	 * teardown the room started on its own after a fatal relay close — so a
	 * successor can safely reuse this instance's registry endpoint.
	 */
	async stop(reason: string): Promise<void> {
		if (this.#teardownDone) return this.#teardownDone;
		if (this.#stopped) return;
		this.#stopDone ??= this.#runStop(reason);
		return this.#stopDone;
	}

	async #runStop(reason: string): Promise<void> {
		this.#stopping = true;
		// Leave the public slot at once: `/collab` must not re-print, and `/join`
		// must not see as hosting, a room that already refuses frames.
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		this.#abortStart?.(new CollabHostStoppedError(`collab host stopped: ${reason}`));
		const socket = this.#socket;
		if (socket) {
			// Revocation drops queued application data; only the goodbye may drain.
			socket.discardPendingSends();
			// Sealing is asynchronous; without the flush the goodbye would still be
			// in the send chain when #teardown closes the socket and drops it.
			socket.send({ t: "bye", reason });
			await socket.flush();
		}
		await this.#teardown();
	}

	#teardown(): Promise<void> {
		this.#teardownDone ??= this.#runTeardown();
		return this.#teardownDone;
	}

	async #runTeardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		// A room that ended on its own (fatal relay close) reaches here without
		// `#runStop`: leave the public slot before the first await as well.
		if (this.#ctx.collabHost === this) this.#ctx.collabHost = undefined;
		const publication = this.#registryPublication;
		this.#registryPublication = null;
		if (publication) {
			// close() removes discovery metadata synchronously before awaiting the
			// server shutdown, so a stopped room disappears from lists immediately;
			// awaiting it lets a successor room reuse the same instance endpoint.
			await publication
				.close()
				.catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
		}
		this.#ctx.sessionManager.onEntryAppended = undefined;
		this.#ctx.sessionManager.onLeafMoved = undefined;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		clearTimeout(this.#supersedingTimer ?? undefined);
		this.#supersedingTimer = null;
		this.#superseding.clear();
		this.#registryUnsubscribe?.();
		this.#registryUnsubscribe = undefined;
		this.#profileUnsubscribe?.();
		this.#profileUnsubscribe = undefined;
		this.#prWatchUnsubscribe?.();
		this.#prWatchUnsubscribe = undefined;
		this.#usageLimits?.dispose();
		this.#usageLimits = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#ctx.statusLine.setCollabStatus(null);
		this.#ctx.ui.requestRender();
		// A publication still being created when the room ended is withdrawn
		// before stop() resolves: a successor room reuses this instance
		// endpoint, and this room's late cleanup must never unlink the winner.
		const pending = this.#pendingPublication;
		this.#pendingPublication = null;
		const late = pending ? await pending : null;
		if (late) {
			await late.close().catch(err => logger.warn("Collab host registry withdrawal failed", { error: String(err) }));
		}
	}

	/**
	 * The session this room mirrors is still the active one. Every path that
	 * reads or mutates session state on a guest's behalf (broadcasts, joins,
	 * prompts, registry queries) checks this first and refuses on a mismatch:
	 * the room mirrors nothing, welcomes nobody, and is absent from discovery
	 * while another session is active. It is suspended rather than ended
	 * because `switchSession()` adopts the target id before it commits and a
	 * failed switch restores the previous id without notifying anyone; only
	 * the committed change, delivered to the controller through the
	 * session-change callback, stops the room. A rolled-back switch simply
	 * finds the room current again.
	 */
	#sessionStillCurrent(): boolean {
		return this.#ctx.sessionManager.getSessionId() === this.#sessionId;
	}

	/** Live metadata and capability lookups served over the registry IPC. */
	#registrySource(): CollabHostRegistrySource {
		return {
			snapshot: () => this.#registrySnapshot(),
			link: access => this.registryLink(access),
		};
	}

	/**
	 * Non-capability snapshot; URLs are only ever returned by `link`. A host
	 * that is ending, or whose session is not the active one, answers
	 * `snapshot_unavailable` to every registry op (the link op reads the
	 * snapshot first), so a listing omits it — without pruning — and no link
	 * is handed out for a room that already refuses joins.
	 */
	#registrySnapshot(): CollabHostSnapshot {
		if (!this.#guestTrafficAllowed()) throw new Error("collab room unavailable");
		if (this.#ctx.session.isSessionTransitioning) throw new Error("session transition in progress");
		const model = this.#ctx.session.model;
		return {
			instanceId: this.#instanceId,
			generation: this.#generation,
			pid: process.pid,
			sessionId: this.#sessionId,
			sessionName: this.#ctx.session.sessionName ?? null,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: model ? { provider: model.provider, id: model.id } : null,
			startedAt: this.#startedAt,
			participants: this.participants.length,
			relayConnected: this.#relayConnected,
			inputRequired: this.inputRequired,
			// Same source as the guest footer's `isStreaming`, read at query time:
			// true for the whole turn, including tool execution, and false once
			// the agent ends — so a poller sees the session stop while the room
			// is still published.
			busy: this.#ctx.session.isStreaming,
			access: this.#access,
		};
	}

	/** Shared liveness and session-identity gate for guest traffic and deferred actions. */
	#guestTrafficAllowed(): boolean {
		return !this.ending && this.#sessionStillCurrent();
	}

	/**
	 * Outbound path for frame objects; stop() deliberately bypasses it for the
	 * final goodbye. Pre-serialized broadcasts gate on {@link #broadcastAllowed},
	 * which applies the same liveness/session checks.
	 */
	#send(frame: CollabFrame, toPeer = 0): void {
		// Ending an existing dialog contains only its old-room request ID, never
		// current-session data. Do not strand guests if it settles during a
		// provisional /resume that later rolls back. All other traffic stays gated.
		if (this.ending || (!this.#sessionStillCurrent() && frame.t !== "ui-request-end")) return;
		this.#flushSuperseding();
		// Compression is per recipient: only a peer that said `zip` in its hello can open it.
		this.#socket?.send(frame, toPeer, toPeer !== 0 && this.#peers.get(toPeer)?.zip === true);
	}

	/**
	 * Whether a mirrored broadcast has anyone to reach. Checked before any
	 * bound/serialize/seal work: an auto-started room usually has no guest, and
	 * the relay would discard the frame anyway. Nothing is lost by skipping it —
	 * guests ignore traffic until their welcome, which carries fresh state,
	 * agents, and the full snapshot.
	 */
	#broadcastAllowed(): boolean {
		return this.#peers.size > 0 && this.#guestTrafficAllowed();
	}

	/** Broadcast one session event, bounded and serialized exactly once. */
	#broadcastEvent(event: AgentSessionEvent): void {
		if (!this.#broadcastAllowed()) return;
		const encode = () => encodeEventFrame(serializeReplicatedEvent(event).json);
		if (event.type === "message_update") {
			this.#supersede("message", encode);
		} else if (event.type === "tool_execution_update") {
			this.#supersede(`tool:${event.toolCallId}`, encode);
		} else {
			this.#flushSuperseding();
			this.#socket?.send(encode());
		}
	}

	/** The wire-visible entries of root → leaf: what a joining guest replicates. */
	#activeWirePath(): (StoredSessionEntry & WireSessionEntry)[] {
		return this.#ctx.sessionManager.snapshotForReplication().entries.filter(isWireSessionEntry);
	}

	/** Nearest wire-visible ancestor of `entry`, as guests see its parent. */
	#wireParentId(entry: StoredSessionEntry): string | null {
		const sessionManager = this.#ctx.sessionManager;
		let parent = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
		while (parent && !isWireSessionEntry(parent)) {
			parent = parent.parentId ? sessionManager.getEntry(parent.parentId) : undefined;
		}
		return parent?.id ?? null;
	}

	/**
	 * Mirror one appended entry. An entry that does not extend the path guests
	 * hold is announced as the path change it is — unless it is not the active
	 * leaf, as with work finishing on an abandoned branch: guests stay put.
	 */
	#replicateAppended(entry: StoredSessionEntry & WireSessionEntry): void {
		if (!this.#sessionStillCurrent()) return;
		const tail = this.#sentPath.at(-1) ?? null;
		if (entry.parentId !== tail && this.#wireParentId(entry) !== tail) {
			const path = this.#activeWirePath();
			if (path.at(-1)?.id === entry.id) this.#syncActivePath(path);
			return;
		}
		this.#sentPath.push(entry.id);
		if (!this.#broadcastAllowed()) return;
		const bounded = serializeReplicatedEntry(entry);
		const shrunk = bounded.value;
		if (shrunk.type === "custom_message" && shrunk.customType === COLLAB_ENTRY_OMITTED_CUSTOM_TYPE) {
			// The live path also emits a guest-visible notice: guests only
			// apply `message` entries to their agent context, so without
			// this the substitution would be silently invisible there
			// (PR #11999 review). Notices never enter agent state.
			this.#send({ t: "event", event: oversizedEntryNotice(entry.type) });
		}
		this.#flushSuperseding();
		this.#socket?.send(encodeEntryFrame(bounded.json));
	}

	/**
	 * Tell guests the active path is now `path`: they keep what it shares with
	 * the path they hold and replace the rest. The tail beyond one snapshot
	 * chunk follows as ordinary `entry` frames, so a navigation onto a long
	 * sibling branch never forms a frame the relay may stall on.
	 */
	#syncActivePath(path: readonly (StoredSessionEntry & WireSessionEntry)[]): void {
		const sent = this.#sentPath;
		let shared = 0;
		while (shared < path.length && shared < sent.length && path[shared]?.id === sent[shared]) shared++;
		if (shared === path.length && shared === sent.length) return;
		this.#sentPath = path.map(entry => entry.id);
		if (!this.#broadcastAllowed()) return;
		const keep = path[shared - 1]?.id ?? null;
		const fresh = this.#serializeSnapshotEntries(path.slice(shared));
		let inBranchFrame = 0;
		let bytes = 0;
		while (inBranchFrame < fresh.json.length && bytes + (fresh.bytes[inBranchFrame] ?? 0) <= SNAPSHOT_CHUNK_BYTES) {
			bytes += fresh.bytes[inBranchFrame] ?? 0;
			inBranchFrame++;
		}
		this.#flushSuperseding();
		this.#socket?.send(encodeBranchFrame(keep, fresh.json.slice(0, inBranchFrame)));
		for (const json of fresh.json.slice(inBranchFrame)) this.#socket?.send(encodeEntryFrame(json));
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		// Controls are dispatched synchronously while frames finish decrypting, so
		// a hello can land after its sender's `peer-left`. The socket settled the
		// peer's lifetime at reception; re-read it here rather than acting on a
		// sender that is already gone and registering a ghost participant.
		if (!this.#socket?.isServing(fromPeer)) {
			logger.debug("collab host ignoring frame from a peer it no longer serves", { type: frame.t, fromPeer });
			return;
		}
		// An old-room answer may wait for rollback, but cannot settle against
		// another session. The response handler owns that bounded deferral.
		if (frame.t === "ui-response") {
			this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
			return;
		}
		// Inbound frames act on the mirrored session (join snapshots, prompts,
		// aborts, agent control); none may reach a session this room never
		// shared, or one whose room is already ending.
		if (!this.#guestTrafficAllowed()) return;
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame, fromPeer);
				break;
			case "prompt":
				if (this.#rejectWhileStarting("prompting", fromPeer)) break;
				// Only the literal "follow-up" opts out of steering; anything else a guest sends steers.
				this.#handlePrompt(
					frame.text,
					frame.images,
					frame.deliver === "follow-up" ? "follow-up" : undefined,
					fromPeer,
					{ model: frame.model, thinking: frame.thinking },
					frame.mentions,
				);
				break;
			case "abort":
				if (this.#rejectWhileStarting("interrupting", fromPeer)) break;
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				if (this.#rejectWhileStarting("agent control", fromPeer)) break;
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "session-cmd":
				if (this.#rejectWhileStarting("session control", fromPeer)) break;
				void this.#handleSessionCmd(
					frame.cmd,
					typeof frame.arg === "string" ? frame.arg : undefined,
					fromPeer,
					undefined,
					{
						restoreFiles: frame.restoreFiles === true,
						id: frame.id,
						index: frame.index,
						mentions: frame.mentions,
					},
				);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				logger.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#send({ t: "error", message: `${action} is disabled on a read-only link` }, fromPeer);
	}

	/**
	 * Guests must not drive the session while it is still starting up (an
	 * auto-started room is live before the session's startup hooks finish):
	 * refuse with a targeted error instead of running an agent turn beside them.
	 */
	#rejectWhileStarting(action: string, fromPeer: number): boolean {
		if (this.#guestActionsReady()) return false;
		const ready = this.#ctx.session.isSessionTransitioning
			? "the session transition completes"
			: "the host finishes starting up";
		this.#send({ t: "error", message: `${action} is unavailable until ${ready}` }, fromPeer);
		return true;
	}

	#handleHello(hello: Extract<CollabFrame, { t: "hello" }>, fromPeer: number): void {
		const { name, proto, writeToken, resume } = hello;
		if (this.#ctx.session.isSessionTransitioning) {
			this.#send({ t: "error", message: "Session transition in progress; join again when it completes" }, fromPeer);
			return;
		}
		if (proto !== COLLAB_PROTO) {
			this.#send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		const firstPeer = this.#peers.size === 0;
		this.#peers.set(fromPeer, { name: cleanName, canWrite, zip: hello.zip === true });

		const socket = this.#socket;
		if (!socket) return;
		// Serialize the snapshot synchronously: live traffic queued after this
		// cannot overtake it, and host rewrites of an entry in place cannot leak
		// into it later, so the live entries are read without a defensive deep
		// copy. Chunk frames are assembled from these strings only as the
		// transport drains.
		const { header } = this.#ctx.sessionManager.snapshotForReplication();
		const entries = this.#activeWirePath();
		// Delta resume: a guest that still holds this session up to `resume.entryId`
		// gets only what follows it. A different session or an entry the host no
		// longer holds on the active path (rewritten history, abandoned branch) falls
		// back to the full snapshot. Ids are unique, so the last match is the match;
		// searching from the tail is O(1) for the common case of a guest that is
		// nearly current.
		const resumeAt = resume?.sessionId === header.id ? entries.findLastIndex(e => e.id === resume.entryId) : -1;
		const resumed = resumeAt >= 0;
		const snapshotEntries = this.#serializeSnapshotEntries(resumed ? entries.slice(resumeAt + 1) : entries);
		const state = this.#buildState();
		// State broadcasts pause while no guest is joined, so the dedupe baseline
		// may predate this welcome; with no other peer to keep current, the welcome
		// becomes the baseline.
		if (firstPeer) this.#lastStateJson = JSON.stringify(state);
		this.#send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header,
				state,
				agents: this.#snapshotAgents(),
				entryCount: snapshotEntries.json.length,
				resumed: resumed ? true : undefined,
				readOnly: canWrite ? undefined : true,
				models: canWrite ? this.#welcomeModels() : undefined,
				profiles: canWrite ? this.#welcomeProfiles() : undefined,
				commands: canWrite ? this.#welcomeCommands() : undefined,
				features: this.#welcomeFeatures(),
			},
			fromPeer,
		);
		socket.sendBatch(
			this.#snapshotChunks(snapshotEntries.json, snapshotEntries.bytes),
			fromPeer,
			this.#peers.get(fromPeer)?.zip === true,
		);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				this.#send({ t: "ui-request", request: pending.request }, fromPeer);
			}
		}
		this.#ctx.session.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
		// The welcome above used the last listing; the next writer's gets a fresher one.
		if (canWrite) void this.#refreshResumeChoices();
		if (canWrite) this.#sendUsageLimits(fromPeer);
	}

	/**
	 * Serialize every snapshot entry exactly once, bounded under
	 * {@link MAX_REPLICATED_PAYLOAD_BYTES}. Only an entry that throws or exceeds
	 * the ceiling pays for {@link serializeReplicatedEntry}'s shrink passes, so a
	 * single oversized tool-result entry cannot ship as an oversized chunk that
	 * trips the relay's per-frame `maxPayloadLength` (issue #3739), and an entry
	 * that cannot be shrunk at all ships as a bounded placeholder instead of
	 * stranding the guest without a terminator (issue #11433).
	 *
	 * When the snapshot exceeds {@link WELCOME_IMAGE_STRIP_THRESHOLD} — or holds
	 * an entry that does not serialize as-is (a non-JSON leaf such as `BigInt`,
	 * a throwing `toJSON`, nesting past the engine limit) — images are stripped
	 * from private copies of the message entries first, so the chunker falls
	 * back to clipping or placeholders only for what is still too large.
	 *
	 * A delta resume passes only the entries after the guest's last one, so the
	 * threshold is judged on that tail alone: a small tail keeps its images even
	 * when the full snapshot would have stripped them. This matches live `entry`
	 * frames, which are never image-stripped. The shrink passes above are
	 * per-entry and independent of the entries around them, and placeholders keep
	 * the original `id`, so a resumed tail is byte-identical to the same entries
	 * in a full snapshot except for that threshold decision.
	 */
	#serializeSnapshotEntries(entries: ReplicatedEntry[]): { json: string[]; bytes: number[] } {
		const raw: (string | null)[] = [];
		const bytes: number[] = [];
		let total = 0;
		let unserializable = false;
		for (const entry of entries) {
			let json: string | null = null;
			let entryBytes = 0;
			try {
				// `byteLength` throws on the `undefined` a top-level `toJSON` may yield.
				const text = JSON.stringify(entry);
				entryBytes = Buffer.byteLength(text, "utf8");
				json = text;
			} catch {
				unserializable = true;
			}
			raw.push(json);
			bytes.push(entryBytes);
			total += entryBytes;
		}
		const stripImages = unserializable || total > WELCOME_IMAGE_STRIP_THRESHOLD;
		let stripped = 0;
		const json: string[] = [];
		for (const [i, entry] of entries.entries()) {
			let text = raw[i] ?? null;
			let source = entry;
			// `"image` covers every image carrier the stripper handles: `image`
			// content blocks, `images` arrays, and file-mention `image` fields.
			if (stripImages && entry.type === "message" && (text === null || text.includes('"image'))) {
				// The JSON round-trip is exactly what a guest would receive; an entry
				// that does not serialize goes through the depth-bounded walk instead.
				const copy: ReplicatedEntry = text === null ? copyForReplication(entry) : JSON.parse(text);
				const removed = copy.type === "message" ? stripImagesFromMessage(copy.message) : 0;
				if (removed > 0) {
					stripped += removed;
					source = copy;
					text = null;
				}
			}
			if (text === null || (bytes[i] ?? 0) > MAX_REPLICATED_PAYLOAD_BYTES) {
				// Never throws, and always returns a bounded payload: a throw here
				// would end the train without its `final: true` terminator, and the
				// guest would time out its join while the host lists it as joined.
				text = serializeReplicatedEntry(source).json;
				bytes[i] = Buffer.byteLength(text, "utf8");
			}
			json.push(text);
		}
		if (stripImages) logger.info("collab welcome exceeded size threshold; stripped images", { stripped });
		return { json, bytes };
	}

	/**
	 * Slice pre-serialized entries into byte-bounded `snapshot-chunk` frames.
	 * Every batch carries at least one entry, and the last batch is tagged
	 * `final: true` so the guest can finalize the replica. An empty snapshot
	 * still emits one `final` chunk so the guest never blocks on a missing
	 * terminator. Each batch's strings are released once its frame is built.
	 */
	*#snapshotChunks(entries: string[], bytes: number[]): Generator<EncodedFrame> {
		if (entries.length === 0) {
			yield encodeSnapshotChunk([], true);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const start = i;
			let batchBytes = 0;
			while (i < entries.length) {
				const entryBytes = bytes[i] ?? 0;
				if (i > start && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batchBytes += entryBytes;
				i++;
			}
			const batch = entries.slice(start, i);
			entries.fill("", start, i);
			yield encodeSnapshotChunk(batch, i >= entries.length);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const suspended = !this.#guestTrafficAllowed();
		if (suspended && (this.ending || !this.#ctx.session.isSessionTransitioning)) return;
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		const pending = this.#pendingUi.get(reqId);
		if (pending) {
			if (pending.responsePending) return;
			if (suspended) {
				void this.#settleUiAfterTransition(pending, value, fromPeer);
				return;
			}
			pending.settle({ kind: "answered", value });
			return;
		}
		// The request already settled (or never existed for this peer). A writer that
		// reconnected after the broadcast `ui-request-end` resends its answer and would
		// otherwise wait forever, so acknowledge it directly.
		this.#send({ t: "ui-request-end", reqId }, fromPeer);
	}

	async #settleUiAfterTransition(
		pending: PendingCollabUiRequest,
		value: CollabUiResponseValue,
		fromPeer: number,
	): Promise<void> {
		// At most one answer per existing request; stop/local cancellation wakes
		// the wait even if a session hook never finishes.
		pending.responsePending = true;
		const { reqId } = pending.request;
		try {
			do {
				await Promise.race([this.#ctx.session.waitForSessionTransition(), pending.promise]);
			} while (
				this.#pendingUi.get(reqId) === pending &&
				!this.ending &&
				!this.#sessionStillCurrent() &&
				this.#ctx.session.isSessionTransitioning
			);
			if (this.#pendingUi.get(reqId) !== pending || !this.#guestTrafficAllowed()) return;
			if (this.#peers.get(fromPeer)?.canWrite) pending.settle({ kind: "answered", value });
			else this.#sendWritablePeers({ t: "ui-request", request: pending.request });
		} catch (error) {
			logger.warn("Collab UI response could not await session transition", { error: String(error) });
			pending.settle({ kind: "unavailable" });
		} finally {
			pending.responsePending = false;
		}
	}

	/** Tail of the prompts that needed async command routing; later prompts queue behind it to keep their order. */
	#promptTail: Promise<void> = Promise.resolve();
	/** Prompts queued on or running through {@link #promptTail}. */
	#promptsQueued = 0;

	#handlePrompt(
		text: string,
		images: ImageContent[] | undefined,
		deliver: "follow-up" | undefined,
		fromPeer: number,
		promptModel: PromptModelRequest = {},
		mentions?: unknown,
	): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		const resolved = this.#resolvePromptModel(promptModel);
		if ("error" in resolved) {
			this.#send({ t: "error", message: `prompt not sent: ${resolved.error}` }, fromPeer);
			return;
		}
		const modelOverride = resolved.override;
		const context = this.#mentionContext(mentions);
		if (!text.startsWith("/") && this.#promptsQueued === 0) {
			this.#submitPrompt(
				withMentionContext(withImages(text, images), context),
				text,
				deliver,
				fromPeer,
				peer.name,
				modelOverride,
			);
			return;
		}
		// A slash prompt may load a skill file or run a builtin first; whatever the guest
		// sends next must not overtake it.
		this.#promptsQueued++;
		this.#promptTail = this.#promptTail
			.then(() => this.#dispatchSlashAware(text, images, deliver, fromPeer, modelOverride, context))
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			})
			.finally(() => {
				this.#promptsQueued--;
			});
	}

	/** What the host knows about slash commands right now, in the shape routing and the welcome list read. */
	#commandSource(): GuestCommandSource {
		const { session, skillCommands } = this.#ctx;
		return {
			skills: skillCommands,
			fileCommands: session.slashCommands,
			promptTemplates: session.promptTemplates,
			hasHostOnlyCommand: name =>
				session.extensionRunner?.getCommand(name) !== undefined ||
				session.customCommands.some(loaded => loaded.command.name === name),
			createShell: () => session.createCommandShell(),
			resolveShell: (shell, text) => session.resolveCommandShell(shell, text),
			keepsGuestsAcrossSwitch: hostKeepsGuestsAcrossSwitch(this.#ctx),
			resumeChoices: this.#resumeChoices,
		};
	}

	/**
	 * Reload the `/resume` suggestions a writer's welcome carries. Welcomes are built
	 * synchronously, so they read the last result: a hello triggers a reload for the next one,
	 * at most every {@link RESUME_CHOICES_TTL_MS}. A room lives for one session, and a switch
	 * opens a successor, so this only goes stale for sessions other processes create meanwhile.
	 */
	async #refreshResumeChoices(): Promise<void> {
		const now = Date.now();
		if (now - this.#resumeChoicesAt < RESUME_CHOICES_TTL_MS) return;
		this.#resumeChoicesAt = now;
		const choices = await recentSessionChoices(this.#ctx);
		if (!this.ending) this.#resumeChoices = choices;
	}

	/** The command list a writer's welcome carries; absent when the catalog cannot be read. */
	#welcomeCommands(): CollabCommand[] | undefined {
		try {
			return buildGuestCommands(this.#commandSource());
		} catch (err) {
			logger.warn("collab welcome could not list slash commands", { error: String(err) });
			return undefined;
		}
	}

	/**
	 * Run a guest prompt that may name a slash command: allowed commands go through the
	 * TUI's own command machinery with the guest as author, host-only ones are refused, and
	 * anything else is an ordinary prompt.
	 */
	async #dispatchSlashAware(
		text: string,
		images: ImageContent[] | undefined,
		deliver: "follow-up" | undefined,
		fromPeer: number,
		modelOverride?: PromptModelOverride,
		context?: string,
	): Promise<void> {
		const peer = this.#peers.get(fromPeer);
		// The guest left or the room ended while this waited its turn.
		if (!peer?.canWrite || this.ending) return;
		let route: GuestCommandRoute = { kind: "literal" };
		if (text.startsWith("/")) {
			try {
				route = await routeGuestCommand(text, this.#commandSource());
			} catch (err) {
				logger.warn("collab slash command routing failed; sending the text as a prompt", { error: String(err) });
			}
		}
		switch (route.kind) {
			case "literal":
				this.#submitPrompt(
					withMentionContext(withImages(text, images), context),
					text,
					deliver,
					fromPeer,
					peer.name,
					modelOverride,
				);
				return;
			case "expanded":
				this.#submitPrompt(
					withMentionContext(withImages(route.text, images), context),
					text,
					deliver,
					fromPeer,
					peer.name,
					modelOverride,
				);
				return;
			case "refused":
				this.#send({ t: "error", message: route.message }, fromPeer);
				return;
			case "skill": {
				const built = await buildSkillCommandPrompt(
					this.#ctx,
					text,
					deliver === "follow-up" ? "followUp" : "steer",
					images,
				);
				if (!built) {
					this.#send({ t: "error", message: "that skill is no longer available" }, fromPeer);
					return;
				}
				if (!this.#peers.get(fromPeer)?.canWrite || this.ending) return;
				this.#submitPrompt(
					withMentionContext(built.message.content, context),
					text,
					deliver,
					fromPeer,
					peer.name,
					modelOverride,
				);
				return;
			}
			case "builtin":
				await this.#runBuiltinCommand(route, images, deliver, fromPeer, peer.name, modelOverride, context);
				return;
		}
	}

	/**
	 * Run an allowlisted builtin for a guest. The builtins never receive the guest's text:
	 * `/plan` runs without arguments (the TUI would submit them as the host's own input,
	 * which executes extension commands), and what followed it is dispatched afterwards as
	 * the guest's prompt. Preconditions are checked here because the builtin handlers only
	 * show a warning on the host terminal when they refuse. Failures go to the guest alone;
	 * the room is told only about a command that ran.
	 */
	async #runBuiltinCommand(
		route: Extract<GuestCommandRoute, { kind: "builtin" }>,
		images: ImageContent[] | undefined,
		deliver: "follow-up" | undefined,
		fromPeer: number,
		peerName: string,
		modelOverride?: PromptModelOverride,
		context?: string,
	): Promise<void> {
		const { name, args } = route;
		const refuse = (reason: string): void => this.#send({ t: "error", message: `/${name}: ${reason}` }, fromPeer);
		const ctx = this.#ctx;
		if (images && images.length > 0 && (name !== "plan" || !args)) {
			refuse("images cannot be sent with this command");
			return;
		}
		const runnable = Object.hasOwn(COLLAB_RUNNABLE_BUILTINS, name) ? COLLAB_RUNNABLE_BUILTINS[name] : undefined;
		if (runnable?.sessionCmd) {
			// The session sheet's controls: their path validates, refuses and announces.
			const arg = name === "effort" ? args.toLowerCase() : args;
			await this.#handleSessionCmd(runnable.sessionCmd, arg, fromPeer, name);
			return;
		}
		if (runnable?.switchesSession) {
			const outcome = await replaceSessionForGuest(ctx, name, args);
			if (!outcome.ok) {
				refuse(outcome.reason);
				return;
			}
			// The room that carried the command ends with the old session, so the guest may never
			// see this; the host terminal of the new session hears who asked.
			ctx.session.emitNotice("info", `${peerName} ran /${name}`, "collab");
			return;
		}
		if (name === "clear") {
			await this.#runClear(refuse, peerName);
			return;
		}
		if (name === "retry") {
			if (!(await ctx.session.retry())) {
				refuse("nothing to retry");
				return;
			}
		} else {
			if (ctx.planModeEnabled || ctx.planModePaused) {
				// Leaving or resuming plan mode can ask for confirmation on the host terminal.
				refuse("plan mode is already on or paused; change it from the host terminal");
				return;
			}
			if (ctx.goalModeEnabled || ctx.goalModePaused || ctx.vibeModeEnabled) {
				refuse("exit goal or vibe mode on the host first");
				return;
			}
			if (!cfgPlanEnabled.get(ctx.settings)) {
				refuse("plan mode is disabled in the host's settings");
				return;
			}
			await executeBuiltinSlashCommand("/plan", { ctx, draftDetached: true });
			if (!ctx.planModeEnabled) {
				refuse("plan mode could not be started");
				return;
			}
		}
		if (this.#guestTrafficAllowed()) ctx.session.emitNotice("info", `${peerName} ran /${name}`, "collab");
		if (name === "plan" && args)
			await this.#dispatchSlashAware(args, images, deliver, fromPeer, modelOverride, context);
	}

	/**
	 * `/clear` for a guest: the host's own handler, so its terminal drops the transcript as it does for
	 * `/clear` typed there. That handler aborts an in-flight compaction and only warns when a response
	 * is streaming; for a guest both are refused instead. The handler returns nothing, so success is
	 * the session's new `reset_boundary` leaf, which `replicateAppended` has already sent to the room.
	 */
	async #runClear(refuse: (reason: string) => void, peerName: string): Promise<void> {
		const { session, sessionManager } = this.#ctx;
		if (session.isBusyForSnapshot || session.isSessionTransitioning) {
			refuse("wait for the current response, compaction, or command to finish");
			return;
		}
		const before = sessionManager.getLeafId();
		await this.#ctx.handleResetContextCommand();
		const leaf = sessionManager.getLeafId();
		if (leaf === null || leaf === before || sessionManager.getEntry(leaf)?.type !== "reset_boundary") {
			refuse("the context could not be cleared");
			return;
		}
		if (this.#guestTrafficAllowed()) session.emitNotice("info", `${peerName} ran /clear`, "collab");
	}

	/** The context block for a prompt's `mentions` (see {@link buildMentionContext}); undefined when there are none. */
	#mentionContext(mentions: unknown): string | undefined {
		if (!Array.isArray(mentions) || mentions.length === 0) return undefined;
		const roots = new Set([getSessionsDir()]);
		const projectDir = this.#ctx.sessionManager.getSessionDir();
		if (projectDir) roots.add(path.dirname(projectDir));
		return buildMentionContext(mentions, [...roots]);
	}

	/**
	 * `queue-edit` / `queue-move` / `queue-steer`: change one queued follow-up, named by its id. Only the
	 * follow-up queue is touched; what the host queued to steer stays with the host.
	 */
	#runQueueCommand(
		cmd: "queue-edit" | "queue-move" | "queue-steer",
		arg: string | undefined,
		options: SessionCmdOptions,
		fail: (message: string) => void,
		announce: (what: string) => void,
	): void {
		const session = this.#ctx.session;
		const { id } = options;
		const gone = "that follow-up is no longer queued";
		if (typeof id !== "string" || id === "") {
			fail("no queued follow-up given");
			return;
		}
		if (cmd === "queue-edit") {
			const text = arg ?? "";
			if (text.trim() === "") {
				fail("a queued prompt cannot be empty");
				return;
			}
			const context = this.#mentionContext(options.mentions);
			let refusal: string | undefined;
			const outcome = session.editQueuedFollowUp(id, message => {
				refusal = queueEditRefusal(message, text);
				return refusal === undefined ? rewriteQueuedPrompt(message, text, context) : undefined;
			});
			if (outcome === "missing") {
				fail(gone);
				return;
			}
			if (outcome === "refused") {
				fail(refusal ?? "that follow-up cannot be edited");
				return;
			}
			announce("edited a queued follow-up");
		} else if (cmd === "queue-move") {
			const { index } = options;
			if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
				fail("no position given");
				return;
			}
			if (!session.moveQueuedFollowUp(id, index)) {
				fail(gone);
				return;
			}
			announce("reordered the queued follow-ups");
		} else {
			if (!session.promoteQueuedFollowUp(id)) {
				fail(gone);
				return;
			}
			announce("sent a queued follow-up into the running turn");
		}
		this.#ctx.updatePendingMessagesDisplay();
		this.#ctx.ui.requestRender();
	}

	/** Hand a guest prompt to the session as a collab-prompt message authored by `name`. */
	#submitPrompt(
		content: string | (TextContent | ImageContent)[],
		chipText: string,
		deliver: "follow-up" | undefined,
		fromPeer: number,
		name: string,
		modelOverride?: PromptModelOverride,
	): void {
		const details: CollabPromptDetails = this.#personalSession ? { from: name, origin: "owner" } : { from: name };
		if (this.#ctx.session.isStreaming) {
			this.#ctx.updatePendingMessagesDisplay();
			this.#ctx.ui.requestRender();
			this.#scheduleStateBroadcast();
		}
		this.#ctx.session
			.promptCustomMessage(
				{
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content,
					display: true,
					details,
					attribution: "user",
				},
				{
					streamingBehavior: deliver === "follow-up" ? "followUp" : "steer",
					queueChipText: chipText,
					modelOverride,
				},
			)
			.then(dispatched => {
				if (dispatched === false) return this.#notifyPromptDropped(fromPeer);
			})
			.catch(err => {
				logger.warn("collab guest prompt failed", { error: String(err) });
				this.#send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
			});
	}

	async #notifyPromptDropped(fromPeer: number): Promise<void> {
		while (!this.ending && this.#ctx.session.isSessionTransitioning) {
			await this.#ctx.session.waitForSessionTransition();
		}
		if (this.ending) return;
		if (!this.#sessionStillCurrent()) {
			await this.stop(
				"session changed before a guest prompt was submitted. Rejoin and resend any prompt not shown in the conversation",
			);
			return;
		}
		this.#send(
			{ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." },
			fromPeer,
		);
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#ctx.session
			.abort({ reason: USER_INTERRUPT_LABEL })
			.then(() => {
				if (!this.#guestTrafficAllowed()) return;
				this.#ctx.session.emitNotice("info", `${name} interrupted`, "collab");
			})
			.catch(err => logger.warn("collab guest abort failed", { error: String(err) }));
	}

	/**
	 * A relay recreated its room and will reissue peer ids from 1, so every id it issued in
	 * {@link #peers} (`owns` selects them; guests on the other relay are untouched) is
	 * meaningless — and `#peers` is the permission registry, not
	 * just the roster. Leaving it populated lets whoever takes a reissued id inherit
	 * the `canWrite` of the guest that held it, which a read-only link is enough to
	 * exploit: `#handleFrame` admits a frame before its sender has said hello, so a
	 * `prompt`, `abort`, `agent-cmd` or `ui-response` would be authorized against
	 * the stale entry. Runs before the socket reports the open, so no frame from the
	 * new room can be dispatched against the old identities.
	 */
	#handleRoomRecreated(owns: (peerId: number) => boolean): void {
		if (this.#stopped) return;
		const hadPending = this.#pendingUi.size > 0;
		let removed = 0;
		// Identities first: settle() fans `ui-request-end` out over #peers, and those
		// ids belong to the room that just went away.
		for (const peerId of this.#peers.keys()) {
			if (!owns(peerId)) continue;
			this.#peers.delete(peerId);
			removed++;
		}
		if (removed === 0 && !hadPending) return;
		// The relay closed everyone who could answer, so an outstanding ask has no
		// recipient — unless a writer on the other relay is still there to answer it.
		// Leaving it pending hangs callers that await it without racing a
		// local dialog, and #handleHello re-poses every pending request to the next
		// writable guest — a different occupant of a different room. Matches the
		// teardown path; settle() is guarded against a second resolve, so a teardown
		// after this is a no-op.
		if (!Array.from(this.#peers.values()).some(peer => peer.canWrite)) {
			for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
			this.#pendingUi.clear();
		}
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	/** Identity and UI only: the socket already retired the peer and dropped its backlog. */
	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		// Relay controls arrive outside the normal frame handler.
		if (!this.#guestTrafficAllowed()) return;
		if (name) this.#ctx.session.emitNotice("info", `${name} left the collab session`, "collab");
		this.#updateStatusSegment();
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		const session = this.#ctx.session;
		// Context numbers come from the status line's memoized breakdown so guests
		// render exactly the same anchored, provider-real count the host's own
		// status line shows.
		const breakdown = this.#ctx.statusLine.getCachedContextBreakdown();
		const tokens = breakdown.usedTokens ?? 0;
		return {
			isStreaming: session.isStreaming,
			isAborting: session.isAborting,
			queuedMessageCount: session.queuedMessageCount,
			// Chip texts, oldest first: what `session-cmd` `unqueue` removes.
			followUps: [...session.getQueuedMessages().followUp],
			// Collab test doubles implement only the session surface they exercise, so a missing queue listing reads as no ids.
			followUpIds: session.listQueuedFollowUps?.().map(queued => queued.id),
			// Turns `session-cmd` `redo` can bring back; 0 once the conversation has moved on.
			redoTurns: session.turnUndo?.redoDepth,
			spend: this.#spendState(),
			profile: session.profiles?.active.name,
			prWatch: this.#prWatchState(),
			limited: this.#usageLimits?.available ? this.#usageLimits.limited() : undefined,
			// Collab test doubles implement only the session surface they exercise, so a missing ledger reads as no stats.
			cache: session.requestLedger?.snapshot(),
			sessionName: session.sessionName,
			cwd: this.#ctx.sessionManager.getCwd(),
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			thinkingLevels: session.getAvailableEffortSelectors(),
			contextUsage: {
				tokens,
				contextWindow: breakdown.contextWindow,
				percent: breakdown.contextWindow > 0 ? (tokens / breakdown.contextWindow) * 100 : 0,
			},
			participants: this.participants,
		};
	}

	/** Spend against the session cap for the guests' banner; absent while no cap is set. */
	#spendState(): SessionSpend | undefined {
		// Collab test doubles implement only the session surface they exercise, so a missing accessor reads as no cap.
		const cap = this.#ctx.session.getSpendCap?.();
		if (cap === undefined || cap.level === "off") return undefined;
		return {
			costUsd: cap.costUsd,
			tokens: cap.tokens,
			maxCostUsd: cap.maxCostUsd > 0 ? cap.maxCostUsd : undefined,
			maxTokens: cap.maxTokens > 0 ? cap.maxTokens : undefined,
			capped: cap.level === "capped",
		};
	}

	/** The watched pull requests for the guests' session sheet; absent while none is watched. */
	#prWatchState(): WirePrWatch[] | undefined {
		// Collab test doubles implement only the session surface they exercise, so a missing watcher reads as none.
		const watched = this.#ctx.session.prWatch?.list();
		return watched && watched.length > 0 ? watched : undefined;
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type] && !(event.type === "notice" && event.source === SPEND_CAP_NOTICE_SOURCE)) {
			return;
		}
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(() => this.#scheduleStateBroadcast(), STREAMING_STATE_INTERVAL_MS);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return (
			AgentRegistry.global()
				.list()
				// Advisor transcripts are local observability only; never mirror them to
				// guests (the wire AgentSnapshot kind has no `advisor`, and guests must not
				// be able to chat/kill/revive them).
				.filter((ref): ref is AgentRef & { kind: "main" | "sub" } => ref.kind !== "advisor")
				.map(ref => ({
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					parentId: ref.parentId,
					status: ref.status,
					hasSessionFile: !!ref.sessionFile,
					createdAt: ref.createdAt,
					lastActivity: ref.lastActivity,
				}))
		);
	}

	#supersede(key: string, build: () => CollabFrame | EncodedFrame): void {
		// Re-inserted, not updated: the flush keeps the order the latest views arrived in.
		this.#superseding.delete(key);
		this.#superseding.set(key, build);
		if (this.#supersedingTimer || this.#supersedingDraining) return;
		this.#supersedingTimer = setTimeout(() => {
			this.#supersedingTimer = null;
			this.#flushSuperseding();
		}, SUPERSEDING_GATHER_MS);
	}

	/**
	 * Sends the latest view of everything pending, then holds further views until
	 * the socket has taken these: however slow the link, at most one frame per
	 * key is ever queued. Every other outbound frame flushes first, so an update
	 * never lands after the `message_end`, entry, or lifecycle frame it precedes.
	 */
	#flushSuperseding(): void {
		if (this.#superseding.size === 0) return;
		clearTimeout(this.#supersedingTimer ?? undefined);
		this.#supersedingTimer = null;
		const socket = this.#socket;
		const pending = [...this.#superseding.values()];
		this.#superseding.clear();
		// The last guest left while views waited: the next welcome carries fresh state.
		if (!socket || !this.#broadcastAllowed()) return;
		for (const build of pending) socket.send(build());
		this.#supersedingDraining = true;
		void socket.flush().finally(() => {
			this.#supersedingDraining = false;
			if (this.#socket !== socket || this.ending || this.#superseding.size === 0) return;
			this.#supersedingTimer = setTimeout(() => {
				this.#supersedingTimer = null;
				this.#flushSuperseding();
			}, SUPERSEDING_GATHER_MS);
		});
	}

	#scheduleAgentsBroadcast(): void {
		// No guest, nothing to refresh: a joining guest's welcome carries agents.
		if (this.ending || this.#agentsDebounce || this.#peers.size === 0) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#send({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text: string | undefined, fromPeer: number): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from snapshots, but reject control by id defensively:
		// a stale/malicious client must never chat/kill/revive a read-only advisor transcript.
		if (AgentRegistry.global().get(agentId)?.kind === "advisor") {
			this.#send({ t: "error", message: `agent ${agentId}: advisor transcripts are read-only` }, fromPeer);
			return;
		}
		const fail = (err: unknown) => {
			logger.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		};
		switch (cmd) {
			case "chat": {
				const trimmed = text?.trim();
				if (!trimmed) {
					this.#send({ t: "error", message: `agent ${agentId}: empty chat message` }, fromPeer);
					return;
				}
				// Mirrors the hub's #submitChatMessage: revive if parked, steer if mid-turn.
				AgentLifecycleManager.global()
					.ensureLive(agentId)
					.then(session => {
						if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
						return session.prompt(trimmed, { streamingBehavior: "steer" });
					})
					.catch(fail);
				break;
			}
			case "kill": {
				const kill = async () => {
					const ref = AgentRegistry.global().get(agentId);
					if (!ref || !this.#guestTrafficAllowed()) return;
					if (ref.status === "running" && ref.session) {
						await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
					}
					if (!this.#guestTrafficAllowed() || !this.#guestActionsReady()) return;
					await AgentLifecycleManager.global().release(agentId, ref, { tombstone: true });
				};
				kill().catch(fail);
				break;
			}
			case "revive":
				AgentLifecycleManager.global().ensureLive(agentId).catch(fail);
				break;
		}
	}

	/**
	 * The models the TUI session-model picker offers: the `--models` scope when set,
	 * else every model with usable credentials. Recently used models come first;
	 * then providers in order of their most recently used model (so the providers
	 * you work with lead, not the alphabetically first one), then by provider and
	 * id. Role ranking and the picker's version heuristics are deliberately not
	 * reproduced: they live in the overlay stack, which the host does not load.
	 */
	#selectableModels(): Model[] {
		const session = this.#ctx.session;
		const scoped = session.scopedModels.map(entry => entry.model);
		const models = scoped.length > 0 ? scoped : session.modelRegistry.getAvailable();
		const recent: Record<string, number> = {};
		for (const [index, selector] of (this.#ctx.settings.getStorage()?.getModelUsageOrder() ?? []).entries()) {
			recent[selector] = index;
		}
		const rank = (model: Model) => recent[`${model.provider}/${model.id}`] ?? Number.MAX_SAFE_INTEGER;
		const providerRank: Record<string, number> = {};
		for (const model of models) {
			const current = providerRank[model.provider] ?? Number.MAX_SAFE_INTEGER;
			providerRank[model.provider] = Math.min(current, rank(model));
		}
		return [...models].sort(
			(a, b) =>
				rank(a) - rank(b) ||
				(providerRank[a.provider] ?? 0) - (providerRank[b.provider] ?? 0) ||
				a.provider.localeCompare(b.provider) ||
				a.id.localeCompare(b.id),
		);
	}

	/** The usage windows a writer sees, from the host's cache while it is fresh; sent once read. */
	#sendUsageLimits(peerId: number): void {
		const limits = this.#usageLimits;
		if (!limits?.available) return;
		const pushes = limits.pushCount;
		void limits.refresh(false).then(snapshot => {
			// A read that changed the windows was pushed to every writer, this one included.
			if (limits.pushCount !== pushes) return;
			if (snapshot && this.#peers.get(peerId)?.canWrite) this.#send({ t: "usage-limits", ...snapshot }, peerId);
		});
	}

	#createUsageLimits(): HostUsageLimits {
		return new HostUsageLimits({
			session: this.#ctx.session,
			sendContinue: () => this.#sendResumeContinue(),
			onStateChange: () => this.#scheduleStateBroadcast(),
			onWindows: snapshot => this.#sendWritablePeers({ t: "usage-limits", ...snapshot }),
			hasWriters: () => Array.from(this.#peers.values()).some(peer => peer.canWrite),
			onError: (message, err) => logger.warn(message, { error: String(err) }),
		});
	}

	/** The `continue` a resume-at-reset timer sends once the usage limit has reset. */
	async #sendResumeContinue(): Promise<void> {
		if (this.ending || !this.#sessionStillCurrent()) return;
		const details: CollabPromptDetails = this.#personalSession
			? { from: RESUME_AUTHOR, origin: "owner" }
			: { from: RESUME_AUTHOR };
		const dispatched = await this.#ctx.session.promptCustomMessage(
			{
				customType: COLLAB_PROMPT_MESSAGE_TYPE,
				content: RESUME_PROMPT,
				display: true,
				details,
				attribution: "user",
			},
			{ streamingBehavior: "followUp", queueChipText: RESUME_PROMPT },
		);
		if (dispatched === false) logger.warn("collab resume at usage-limit reset was not submitted");
		else if (this.#guestTrafficAllowed()) {
			this.#ctx.session.emitNotice("info", "the usage limit reset: sent continue", "collab");
		}
	}

	/** The optional capabilities this host advertises; `rewind-files` only while the session can snapshot and restore files. */
	#welcomeFeatures(): CollabFeature[] {
		const features: CollabFeature[] =
			this.#ctx.session.canRestoreFiles === true ? [...COLLAB_FEATURES, "rewind-files"] : [...COLLAB_FEATURES];
		if (this.#usageLimits?.available) features.push("usage-limits");
		features.push("receipts");
		if (this.#ctx.session.canRestoreFiles === true) features.push("turn-diff");
		return features;
	}

	/** A prompt frame's model choice, checked against what the welcome offers; `error` names why it was refused. */
	#resolvePromptModel(request: PromptModelRequest): PromptModelResolution {
		const session = this.#ctx.session;
		return resolvePromptModel(
			request,
			() => this.#selectableModels(),
			model => session.getAvailableEffortSelectors(model),
		);
	}

	/** The profiles a writer's welcome offers for `session-cmd` `profile`. */
	#welcomeProfiles(): WireProfile[] | undefined {
		return this.#ctx.session.profiles?.catalog().profiles.map(({ name, description }) => ({ name, description }));
	}

	/** The model list a writer's welcome carries; its presence tells the guest `session-cmd` is supported. */
	#welcomeModels(): WireModel[] | undefined {
		try {
			return this.#selectableModels()
				.slice(0, MAX_WELCOME_MODELS)
				.map(model => ({
					id: model.id,
					name: model.name,
					provider: model.provider,
					contextWindow: model.contextWindow ?? null,
					thinkingLevels: this.#ctx.session.getAvailableEffortSelectors(model),
				}));
		} catch (err) {
			// A catalog failure must not block the join; the guest just gets no session controls.
			logger.warn("collab welcome could not list models", { error: String(err) });
			return undefined;
		}
	}

	/**
	 * Guest session controls. Each command runs the same session API the host's
	 * own TUI uses (`/model` session pick, thinking selector, `/compact`, `/rename`)
	 * but never opens a selector or dialog on the host terminal. Failures return a
	 * targeted `error`; success is announced to the room as a collab notice.
	 */
	async #handleSessionCmd(
		cmd: SessionCommand,
		arg: string | undefined,
		fromPeer: number,
		slash?: string,
		options: SessionCmdOptions = {},
	): Promise<boolean> {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("session control", fromPeer);
			return false;
		}
		// `slash` names the slash command that asked for this control: errors then read
		// `/<slash>: ...` and the room hears `<guest> ran /<slash>` once, on success,
		// instead of the control's own notice.
		let failed = false;
		const label = slash === undefined ? cmd : `/${slash}`;
		const fail = (message: string): void => {
			failed = true;
			this.#send({ t: "error", message: `${label}: ${message}` }, fromPeer);
		};
		const announce = (what: string): void => {
			if (slash === undefined && this.#guestTrafficAllowed()) {
				this.#ctx.session.emitNotice("info", `${peer.name} ${what}`, "collab");
			}
		};
		const files: RewindFilesChannel = {
			restoreFiles: options.restoreFiles === true,
			reply: frame => this.#send(frame, fromPeer),
		};
		await this.#performSessionCmd(cmd, arg, fail, announce, files, options);
		if (!failed && slash !== undefined && this.#guestTrafficAllowed()) {
			this.#ctx.session.emitNotice("info", `${peer.name} ran /${slash}`, "collab");
		}
		return !failed;
	}

	async #performSessionCmd(
		cmd: SessionCommand,
		arg: string | undefined,
		fail: (message: string) => void,
		announce: (what: string) => void,
		files: RewindFilesChannel,
		options: SessionCmdOptions = {},
	): Promise<void> {
		const session = this.#ctx.session;
		try {
			switch (cmd) {
				case "usage-limits": {
					const limits = this.#usageLimits;
					if (!limits?.available) {
						fail("this host cannot read usage limits");
						return;
					}
					const pushes = limits.pushCount;
					const snapshot = await limits.refresh(arg === "refresh");
					// A read that changed the windows was pushed to every writer, this one included.
					if (limits.pushCount !== pushes) return;
					files.reply({
						t: "usage-limits",
						windows: snapshot?.windows ?? [],
						fetchedAt: snapshot?.fetchedAt ?? Date.now(),
					});
					return;
				}
				case "resume-at-reset": {
					const armed = this.#usageLimits?.arm();
					if (armed === undefined || !armed.ok) {
						fail(armed?.error ?? "this host cannot read usage limits");
						return;
					}
					const at = new Date(armed.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
					announce(`will send continue when the usage limit resets (${at})`);
					return;
				}
				case "resume-cancel":
					if (this.#usageLimits?.cancel()) announce("cancelled the resume at the usage limit reset");
					else fail("no resume is scheduled");
					return;
				case "profile": {
					const profiles = session.profiles;
					const name = arg?.trim() ?? "";
					if (!profiles || !name) {
						fail(profiles ? "no profile name given" : "this host has no agent profiles");
						return;
					}
					// A guest may tighten the host's profile, never widen it: only the host's own TUI
					// can move to a looser one (wider tools, a looser approval mode, wider path rules).
					const loosening = profiles.looseningOf(name);
					if (loosening !== undefined) {
						fail(
							`refused: the ${name} profile is less strict than the active ${profiles.active.name} profile (${loosening}); the host can switch to it from their own session`,
						);
						return;
					}
					const result = await profiles.switch(name);
					if (!result.ok) {
						fail(result.reason);
						return;
					}
					if (result.status === "applied") announce(`switched to the ${result.profile.name} profile`);
					else if (result.status === "queued")
						announce(`queued the ${result.profile.name} profile for the next turn`);
					return;
				}
				case "model": {
					const model = this.#selectableModels().find(
						candidate => `${candidate.provider}/${candidate.id}` === arg,
					);
					if (!model) {
						fail(`unknown model ${arg === undefined ? "(none given)" : JSON.stringify(arg)}`);
						return;
					}
					if (session.model?.provider === model.provider && session.model.id === model.id) return;
					// A live switch resets the provider session, so the TUI defers it past a turn;
					// a guest cannot queue one, so it waits for the host to go idle instead.
					if (session.isStreaming || session.isCompacting) {
						fail("wait for the current response or compaction to finish");
						return;
					}
					// The TUI picker compacts first when the transcript outgrows the target; a guest
					// asking for a model switch must not trigger an implicit summarization.
					const contextTokens = session.getContextUsage()?.tokens ?? 0;
					const contextWindow = model.contextWindow ?? 0;
					if (contextWindow > 0 && contextTokens > contextWindow) {
						fail(
							`the conversation (${contextTokens} tokens) exceeds ${model.id}'s context window; compact first`,
						);
						return;
					}
					// Session-only, like the TUI picker: not persisted as the default model.
					await session.setModelTemporary(model, session.resolveTemporaryModelThinkingLevel(model));
					this.#ctx.statusLine.invalidate();
					this.#ctx.updateEditorBorderColor();
					announce(`switched model to ${model.provider}/${model.id}`);
					return;
				}
				case "thinking": {
					const level = session.getAvailableEffortSelectors().find(selector => selector === arg);
					if (!level) {
						fail(
							arg === undefined
								? "no thinking level given"
								: `the current model does not accept thinking level ${JSON.stringify(arg)}`,
						);
						return;
					}
					// Session-only, like the TUI thinking selector: `persist` stays off.
					session.setThinkingLevel(level);
					announce(`set thinking to ${level}`);
					return;
				}
				case "compact": {
					const parsed = parseCompactArgs(arg ?? "");
					if ("error" in parsed) {
						fail(parsed.error);
						return;
					}
					if (session.isCompacting) {
						fail("compaction is already in progress");
						return;
					}
					if (this.#ctx.sessionManager.getEntries().filter(entry => entry.type === "message").length < 2) {
						fail("nothing to compact (no messages yet)");
						return;
					}
					announce("started compaction");
					// The host's `/compact` path: its TUI shows the same progress loader and result.
					const outcome = await this.#ctx.handleCompactCommand(parsed.instructions, parsed.mode);
					if (outcome !== "ok" && this.#guestTrafficAllowed()) {
						fail(
							outcome === "cancelled" ? "compaction was cancelled" : "compaction failed; see the host terminal",
						);
					}
					return;
				}
				case "rename": {
					const name = arg?.trim() ?? "";
					if (!name) {
						fail("session name cannot be empty");
						return;
					}
					// The host's `/rename` path: a user-sourced title the auto-titler never overwrites.
					// The appended entry refreshes guest state, and the host terminal title follows.
					if (!(await this.#ctx.sessionManager.setSessionName(name, "user"))) {
						fail("session name cannot be empty");
						return;
					}
					announce(`renamed the session to "${this.#ctx.sessionManager.getSessionName() ?? name}"`);
					return;
				}
				case "queue-edit":
				case "queue-move":
				case "queue-steer": {
					this.#runQueueCommand(cmd, arg, options, fail, announce);
					return;
				}
				case "unqueue": {
					// `state.followUps` carries chip text, which `removeQueuedMessage` matches; steers stay
					// with the host, as in the TUI where only the follow-up queue is editable.
					if (arg === undefined || !session.removeQueuedMessage(arg, "followUp")) {
						fail("that follow-up is no longer queued");
						return;
					}
					this.#ctx.updatePendingMessagesDisplay();
					this.#ctx.ui.requestRender();
					announce("removed a queued follow-up");
					return;
				}
				case "rewind": {
					// The leaf move rewrites the agent's context, so nothing may be writing to it; a guest
					// cannot queue a rewind past a turn, so it waits for the host to go idle instead. A
					// `/tree` summary in flight sets no busy flag, only the transition.
					if (session.isBusyForSnapshot || session.isSessionTransitioning) {
						fail("wait for the current response, compaction, or command to finish");
						return;
					}
					const target = this.#ctx.sessionManager.getBranchView().find(entry => entry.id === arg);
					// A user's own prompt or a guest's, the two entries the web client offers to edit.
					const isPrompt =
						(target?.type === "message" && target.message.role === "user") ||
						(target?.type === "custom_message" && target.customType === COLLAB_PROMPT_MESSAGE_TYPE);
					if (!target || !isPrompt) {
						fail("not a prompt on the active conversation");
						return;
					}
					// Files first: a restore the host refuses leaves the conversation where it is, and a
					// rewind that then fails puts the files back.
					const restored = await restoreFilesForRewind(session, target.id, files, fail);
					if (restored === "failed") return;
					// The host's own rewind path: the leaf lands on the prompt's parent (null for a root
					// prompt). `onLeafMoved` tells guests; the draft the TUI would restore stays unused.
					const leafBefore = this.#ctx.sessionManager.getLeafId();
					const result = await session
						.navigateTree(target.id, { summarize: false })
						.catch(async (err: unknown) => {
							if (restored) await rollBackRestoredFiles(session);
							throw err;
						});
					if (result.cancelled) {
						if (restored) await rollBackRestoredFiles(session);
						fail("an extension cancelled the rewind");
						return;
					}
					// `navigateTree` treats some targets already at the leaf as a successful no-op.
					if (this.#ctx.sessionManager.getLeafId() === leafBefore) {
						if (restored) await rollBackRestoredFiles(session);
						fail("the conversation did not move");
						return;
					}
					if (restored) announceRestoredFiles(session, restored, files);
					if (!this.#guestTrafficAllowed()) return;
					await this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
					await this.#ctx.reloadTodos();
					announce(
						restored
							? `rewound the conversation and restored ${describeFileRestore(restored.plan)}`
							: "rewound the conversation",
					);
					return;
				}
				case "rewind-preview":
					await previewRewindFiles(session, arg, files, fail);
					return;
				case "turn-diff":
					if (arg === undefined) {
						fail("which turn? pass a prompt entry id");
						return;
					}
					await replyTurnDiff(session, arg, files.reply);
					return;
				case "session-diff":
					await replyTurnDiff(session, undefined, files.reply);
					return;
				case "receipts":
					replyReceipts(session, files.reply);
					return;
				case "undo":
				case "redo": {
					const done = await runGuestTurnUndo(session, cmd, files.reply, fail);
					if (done === undefined) return;
					// The leaf moved before the redo step existed; tell guests whether `redo` now applies.
					this.#scheduleStateBroadcast();
					if (!this.#guestTrafficAllowed()) return;
					await this.#ctx.renderInitialMessages({ clearTerminalHistory: true });
					await this.#ctx.reloadTodos();
					announce(done);
					return;
				}
				case "context-items":
					replyContextItems(session, this.#ctx.statusLine.getCachedContextBreakdown(), files.reply);
					return;
				case "inspect":
					replyInspect(session, files.reply);
					return;
				case "preview-request":
					await replyRequestPreview(session, files.reply, fail);
					return;
				case "context-prune": {
					if (session.isBusyForSnapshot || session.isSessionTransitioning) {
						fail("wait for the current response, compaction, or command to finish");
						return;
					}
					// The rewrite changes what the host's own chat and meter show; refresh them before
					// the reply reads the meter.
					const refreshMeter = () => {
						this.#ctx.rebuildChatFromMessages();
						this.#ctx.statusLine.invalidate();
						this.#ctx.ui.requestRender();
						return this.#ctx.statusLine.getCachedContextBreakdown();
					};
					const pruned = await runGuestContextPrune(session, arg, refreshMeter, files.reply, fail);
					if (pruned !== undefined) announce(pruned);
					return;
				}
				case "redo-files": {
					if (session.isBusyForSnapshot || session.isSessionTransitioning) {
						fail("wait for the current response, compaction, or command to finish");
						return;
					}
					const undone = await redoRestoredFiles(session, files, fail);
					if (undone !== undefined) announce(undone);
					return;
				}
				case "pr-watch": {
					const { pr, watching } = await session.prWatch.watch(arg);
					if (watching) announce(`started watching pull request ${pr.key}`);
					else fail(`${pr.key} is already ${pr.state}: nothing to watch`);
					return;
				}
				case "pr-unwatch": {
					const target = arg?.trim() ?? "";
					if (!session.prWatch.unwatch(target)) fail(`${target || "(none given)"} is not a watched pull request`);
					else announce(`stopped watching ${target}`);
					return;
				}
				default:
					fail("unknown session command");
			}
		} catch (err) {
			logger.warn("collab session-cmd failed", { cmd, error: String(err) });
			fail(err instanceof Error ? err.message : String(err));
		}
	}

	/** Incremental transcript read mirroring the hub's readFileIncremental contract. */
	async #handleFetchTranscript(reqId: number, agentId: string, fromByte: number, fromPeer: number): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const ref = AgentRegistry.global().get(agentId);
		if (!ref?.sessionFile || ref.kind === "advisor") {
			reply("", fromByte, "no transcript available");
			return;
		}
		const file = ref.sessionFile;
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			logger.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	#scheduleStateBroadcast(): void {
		// No guest, nothing to refresh: a joining guest's welcome carries state.
		if (this.ending || this.#stateDebounce || this.#peers.size === 0) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#send({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}

	#updateStatusSegment(): void {
		this.#ctx.statusLine.setCollabStatus({ role: "host", participantCount: this.#peers.size + 1 });
		this.#ctx.statusLine.invalidate();
		this.#ctx.ui.requestRender();
	}
}
