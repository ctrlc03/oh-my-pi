/**
 * Client-side WebSocket wrapper for collab live-session sharing.
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff on transient drops. Guests also survive the relay's
 * host-drop room teardown while the host recreates the room, and a host whose
 * connection dropped outlasts the relay still holding that connection; other
 * fatal relay close codes (host conflict, room full) and guest decryption
 * failures never reconnect. Hosts discard undecryptable guest frames without
 * closing the room.
 */
import { getProxyForUrl } from "@oh-my-pi/pi-ai/utils/proxy";
import { logger } from "@oh-my-pi/pi-utils";
import { open, sealSerialized } from "./crypto";
import type { CollabFrame, EncodedFrame, RelayControlMessage } from "./protocol";
import { packEnvelope, unpackEnvelope } from "./protocol";

const RELAY_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/**
 * How long after a transient drop a host keeps retrying the relay's duplicate-host
 * close (4009). The client can see its connection end before the relay does, and
 * the relay refuses the reconnect until its liveness check retires the old socket:
 * the public relay took about 40 s for a connection that went silent, and Bun's
 * default WebSocket idle timeout, which the reference relay inherits, is 120 s. A
 * refusal after this window, or on a first connect, is a real second host.
 */
export const HOST_RECLAIM_WINDOW_MS = 150_000;
/**
 * Backoff cap for those reclaim retries. Each one is a single upgrade the relay
 * refuses at once, so a short cap costs little and lands the reclaim within a few
 * seconds of the relay retiring the old socket instead of up to 30 s later.
 */
export const HOST_RECLAIM_BACKOFF_MAX_MS = 5_000;
/**
 * How long a reclaim-time open stays provisional. The relay refuses a duplicate
 * host from its open handler, so the 4009 close frame follows the upgrade
 * response directly; an open that outlives this (or delivers any relay message
 * first) is accepted. Until then the room reset, `onOpen` and the send queue stay
 * untouched, so a refusal cannot drop the guest roster or drain the backlog into
 * a doomed socket.
 */
export const HOST_RECLAIM_CONFIRM_MS = 1_000;
/**
 * How often an open relay socket is pinged. A network that drops without a
 * reset (Wi-Fi lost, a laptop sleeping) leaves the socket reading as open, and
 * nothing reveals the loss until the next write: an idle host would stay
 * unreachable, its room long since retired by the relay, until someone typed.
 */
export const RELAY_PING_INTERVAL_MS = 15_000;
/** A socket that has heard nothing, not even a pong, for this long is dropped and retried. */
export const RELAY_SILENCE_LIMIT_MS = 40_000;
const MAX_PENDING_SENDS = 256;
/**
 * Ceiling on the queue's summed charge: a frame's serialized length, or the bytes a
 * lazy batch's iterator keeps reachable. The head's charge is waived (see
 * {@link CollabSocket.#fits}), so the true ceiling is this plus one entry.
 */
const MAX_PENDING_SEND_BYTES = 16 * 1024 * 1024;
/** Entries one guest may hold. A peer at its share is shed, not the room. */
const MAX_PEER_PENDING_SENDS = 32;
/**
 * Settled retirement records kept, as a memory backstop only. Correctness is an
 * *ordering* obligation, not a count: a record must outlive the frames that were
 * already on {@link CollabSocket.#recvChain} when the departure arrived, so only
 * settled records are evicted. Needed because relay ids climb for the room's
 * lifetime, so a view-link client could add one entry per connect/disconnect cycle.
 */
const MAX_RETIRED_PEERS = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;
/**
 * Most bytes a host lets the relay hold unread. The public relay reads a host's socket only as
 * fast as it delivers to the room's guests (measured at 25-250 KB/s toward one guest), so the
 * local socket buffer drains at once and `bufferedAmount` never shows the backlog. Behind
 * several MB the relay's own ping (every 30 s) waits too: the relay dropped the host about
 * 10 s later, closing the room on every guest mid-welcome. A ping carrying a sequence number
 * follows the written bytes; its pong means the relay has read everything before it.
 */
export const RELAY_IN_FLIGHT_BYTES = 64 * 1024;
/** Bytes written between two pacing pings. */
const RELAY_PACING_PING_BYTES = 16 * 1024;
/**
 * Most bytes of acknowledged batch frames (`welcome`, `snapshot-chunk`) a host keeps unacknowledged toward
 * one guest that acks them (`hello.ackSnapshot`). The relay reads ahead of what a guest has received and
 * buffers the rest; its ping to the guest waits behind that buffer, and at 25-40 KB/s a buffer of
 * about 1.5 MB had the relay drop the guest (close 1006) mid-welcome. With this window the buffer stays
 * under this plus one chunk, a few seconds at the slow end.
 */
export const PEER_IN_FLIGHT_BYTES = 64 * 1024;
/**
 * A guest that stops acknowledging (hung, or an ack lost with its connection) holds the shared queue
 * no longer than this: its batch then continues unpaced, as toward a guest that never acked.
 */
export const PEER_ACK_TIMEOUT_MS = 20_000;

interface PendingSend {
	frames: Iterator<CollabFrame | string>;
	targetPeer: number;
	/** Deflate frames over the size floor; set only for a peer that advertised support. */
	compress: boolean;
	/** Charge against {@link MAX_PENDING_SEND_BYTES}, waived while this entry is the head. */
	bytes: number;
	/** Materializes frames as the transport drains; the welcome-plus-snapshot batch. */
	lazy: boolean;
	/** Carries no replica state (notice mirrors, `state`, `agents`), so it is dropped under pressure. */
	advisory: boolean;
	cancelled: boolean;
	eager: boolean;
	onPrepared?: () => void;
	preparedEnvelope?: Uint8Array;
	/** Next batch frame, pulled right after a write so an exhausted batch leaves the head at once. */
	head?: CollabFrame | string;
	/** Supersession key from {@link CollabSocket.sendLatest}; a newer send under it cancels this one while queued. */
	key?: string;
	/** Frames of a lazy batch the target peer acknowledges; each waits for room under {@link PEER_IN_FLIGHT_BYTES}. */
	acked?: (frame: CollabFrame | string) => boolean;
}

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	key: CryptoKey;
}

export class CollabSocket {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires on each close; `willReconnect` distinguishes retries from terminal shutdown. */
	onClose?: (reason: string, willReconnect: boolean) => void;
	/** A targeted backlog was discarded to keep the room alive; the peer must resync. Always deferred to a microtask. */
	onPeerOverload?: (peerId: number) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#backpressureDrainTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Allows a previously joined guest to outlive room recreation races. */
	#retryMissingRoom = false;
	/** Set while a transient drop is being retried; the next open is a new room. */
	#rejoining = false;
	/**
	 * Until when a host takes the relay's duplicate-host close to be its own dropped connection.
	 * Left set after a reclaim holds: only a reconnect can draw a 4009, and every reconnect
	 * starts from the transient-drop path, which re-arms the window from that drop.
	 */
	#hostReclaimUntil: number | undefined;
	/** Backoff for those retries: the relay completes each upgrade before refusing it, so `onopen` cannot reset it. */
	#reclaimAttempt = 0;
	/** A reclaim-time open not yet confirmed by the relay: not writable, not reported open. */
	#provisional: WebSocket | undefined;
	#confirmTimer: NodeJS.Timeout | undefined;
	#heartbeatTimer: NodeJS.Timeout | undefined;
	/** When the current socket last received anything, pongs included. */
	#lastHeard = 0;
	/** Bytes written to the current socket; host pacing (see {@link RELAY_IN_FLIGHT_BYTES}). */
	#relayWritten = 0;
	/** Of {@link #relayWritten}, the bytes a returned pong proves the relay has read. */
	#relayConfirmed = 0;
	/** {@link #relayWritten} when the newest ping went out. */
	#relayPinged = 0;
	#pingSeq = 0;
	/** Pings awaiting their pong, oldest first, with the bytes written before each. */
	#unansweredPings: Array<{ seq: number; written: number }> = [];
	#sending = false;
	#sendGeneration = 0;
	#wakeSender: (() => void) | undefined;
	/**
	 * Admitted regular sends not yet sealed or discarded; {@link flush} awaits a
	 * snapshot of it. A set, not a chain: refused and discarded sends leave no
	 * trace, so a backed-up head cannot accumulate history behind it.
	 */
	#preparing = new Set<Promise<void>>();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: PendingSend[] = [];
	/**
	 * Peers the relay has retired. Sole authority for the queue invariant: **every
	 * entry in {@link #pendingSends} with a non-zero `targetPeer` is work for a
	 * peer absent from here** (and from {@link #shedPeers}).
	 *
	 * Entered synchronously in {@link #handleMessage}, before any owner callback
	 * runs, so it changes atomically with respect to anything that can enqueue.
	 * Kept past the departure because decryption reorders dispatch: a frame that
	 * finishes opening after its sender's `peer-left` must still be recognised as
	 * stale. The value is whether that obligation is met — whether the frames
	 * received before the departure have been dispatched; only settled records
	 * are evicted.
	 */
	#retiredPeers = new Map<number, boolean>();
	/** Peers whose backlog was just shed; cleared when {@link onPeerOverload} reports them. */
	#shedPeers = new Set<number>();
	/**
	 * Bumped when the relay recreates the room. Ids are reissued, so work deferred
	 * from the old room must not act on the new occupant of the same id.
	 */
	#roomGeneration = 0;
	/**
	 * Guests that acknowledge batch frames ({@link expectAcks}): sizes of the frames sent and not yet
	 * acknowledged, oldest first, their sum, and how many were acknowledged on their connection.
	 */
	#peerAcks = new Map<number, { unacked: number[]; inFlight: number; acked: number }>();

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#isWritable(this.#ws);
	}

	/**
	 * False once the relay has retired this peer. Owners read this instead of
	 * keeping their own departure bookkeeping: a frame that finishes decrypting
	 * after its sender's `peer-left` sees `false` here, because reception order is
	 * exact even though dispatch order is not.
	 */
	isServing(peerId: number): boolean {
		return !this.#retiredPeers.has(peerId);
	}

	/**
	 * False while targeted work for the peer is refused outright: it left, or it was
	 * shed and its overload report is pending. A targeted send refused while this
	 * holds was refused for capacity alone.
	 */
	isAdmitting(peerId: number): boolean {
		return !this.#retiredPeers.has(peerId) && !this.#shedPeers.has(peerId);
	}

	/** Fires on every reconnect: the relay recreated the room and reissues peer ids from 1. */
	onRoomRecreated?: () => void;

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#retryMissingRoom = false;
		this.#hostReclaimUntil = undefined;
		this.#attempt = 0;
		this.#openSocket();
	}

	/**
	 * Queue one frame. An {@link EncodedFrame} is sealed as-is, so a caller that
	 * already serialized the payload (to measure or bound it) does not pay for a
	 * second `JSON.stringify`.
	 *
	 * `compress` deflates the frame when its JSON exceeds the size floor; set it
	 * only toward a peer whose hello advertised `zip` (see {@link sealSerialized}).
	 *
	 * @returns whether the frame was admitted to the queue; a caller awaiting a reply to it has to settle when it was not.
	 */
	send(frame: CollabFrame | EncodedFrame, targetPeer = 0, compress = false): boolean {
		if (this.#closed) return false;
		return this.#sendOne(frame, targetPeer, undefined, false, compress);
	}

	/**
	 * Queue a broadcast frame that supersedes every frame still waiting under the
	 * same `key`, for cumulative snapshots where only the newest matters — the
	 * host's streaming `message_update` carries the whole message so far. Bounds
	 * the queue by live keys instead of by emitted frames, so a stream that
	 * outpaces the uplink does not hit the admission cap and end the room (#16956).
	 *
	 * The queue head is never superseded: it may already be sealing or waiting on
	 * backpressure, and cancelling it on every newer frame would starve the guest
	 * of updates for as long as the stream outpaces the drain. Survivors keep
	 * emission order: the newest frame is appended, never moved ahead of frames
	 * queued before it.
	 *
	 * @returns whether the newest frame was admitted.
	 */
	sendLatest(key: string, frame: CollabFrame | EncodedFrame): boolean {
		const head = this.#pendingSends[0];
		this.#discardWhere(pending => pending !== head && pending.key === key);
		return this.#sendOne(frame, 0, key);
	}

	#sendOne(
		frame: CollabFrame | EncodedFrame,
		targetPeer: number,
		key?: string,
		advisory = false,
		compress = false,
	): boolean {
		if (this.#closed) return false;
		let serialized: string;
		try {
			serialized = typeof frame === "string" ? frame : JSON.stringify(frame);
		} catch (err) {
			this.#failFatal(`could not serialize collab frame: ${String(err)}; rejoin to resync`);
			return false;
		}
		const prepared = Promise.withResolvers<void>();
		let done = false;
		const onPrepared = (): void => {
			done = true;
			this.#preparing.delete(prepared.promise);
			prepared.resolve();
		};
		const admitted = this.#enqueueSend({
			frames: [serialized].values(),
			targetPeer,
			compress,
			bytes: Buffer.byteLength(serialized),
			lazy: false,
			advisory,
			cancelled: false,
			eager: true,
			onPrepared,
			key,
		});
		if (admitted && !done) this.#preparing.add(prepared.promise);
		return admitted;
	}

	/**
	 * Queue a welcome-plus-snapshot as one entry, so welcome and chunks are admitted
	 * together and nothing interleaves with them. A newer batch for the same peer
	 * supersedes a queued one.
	 *
	 * `compress` applies to every frame of the batch, as in {@link send}.
	 *
	 * @param retainedBytes bytes {@link frames} keeps reachable until it drains; the batch's charge.
	 * @param acked frames the peer acknowledges, when it does ({@link expectAcks}): each is sent only while
	 *   less than {@link PEER_IN_FLIGHT_BYTES} of them are unacknowledged.
	 * @returns whether the batch was admitted.
	 */
	sendBatch(
		frames: Iterable<CollabFrame | EncodedFrame>,
		targetPeer: number,
		retainedBytes: number,
		compress = false,
		acked?: (frame: CollabFrame | string) => boolean,
	): boolean {
		if (this.#closed) return false;
		return this.#enqueueSend({
			frames: frames[Symbol.iterator](),
			targetPeer,
			compress,
			bytes: retainedBytes,
			lazy: true,
			advisory: false,
			cancelled: false,
			eager: false,
			acked,
		});
	}

	/**
	 * `peerId` acknowledges the batch frames {@link sendBatch} marks (`hello.ackSnapshot`). Counting starts
	 * with its connection; a repeated hello on the same connection keeps the count, as the guest does.
	 */
	expectAcks(peerId: number): void {
		if (peerId === 0 || this.#peerAcks.has(peerId)) return;
		this.#peerAcks.set(peerId, { unacked: [], inFlight: 0, acked: 0 });
	}

	/** `peerId` has received `frames` acknowledged frames so far (cumulative). */
	ackFrames(peerId: number, frames: number): void {
		const acks = this.#peerAcks.get(peerId);
		if (!acks || !Number.isSafeInteger(frames)) return;
		while (acks.acked < frames && acks.unacked.length > 0) {
			acks.inFlight -= acks.unacked.shift()!;
			acks.acked++;
		}
		this.#wakeSender?.();
	}

	/** Broadcast carrying no replica state; dropped rather than shedding a peer or ending the room. */
	broadcastAdvisory(frame: CollabFrame | EncodedFrame): boolean {
		return this.#sendOne(frame, 0, undefined, true);
	}

	/**
	 * Discard everything still queued for a peer that left. The queue is shared
	 * and strictly FIFO, so a half-delivered snapshot would otherwise hold its
	 * head and stall every later frame — including the next guest's welcome —
	 * behind a retransmission the relay drops on arrival.
	 *
	 * @returns how many queued entries were discarded.
	 */
	dropPeer(peerId: number): number {
		if (peerId === 0) return 0;
		this.#peerAcks.delete(peerId);
		const discarded = this.#discardWhere(pending => pending.targetPeer === peerId);
		// A batch waiting on this peer's acks resumes to find itself cancelled.
		this.#wakeSender?.();
		return discarded;
	}

	/** Single eviction path: cancels an in-flight head cleanly and refunds its accounting. */
	#discardWhere(match: (pending: PendingSend) => boolean): number {
		if (this.#pendingSends.length === 0) return 0;
		const keep: PendingSend[] = [];
		for (const pending of this.#pendingSends) {
			if (!match(pending)) {
				keep.push(pending);
				continue;
			}
			pending.cancelled = true;
			pending.onPrepared?.();
			pending.onPrepared = undefined;
			pending.frames.return?.(undefined);
		}
		const discarded = this.#pendingSends.length - keep.length;
		this.#pendingSends = keep;
		return discarded;
	}

	/**
	 * A reconnect lands in a room the relay recreated: `local-relay.ts` deletes the
	 * room when the host socket closes, closes every guest with 4001, and hands
	 * out peer ids from 1 again. No `peer-left` announces any of it, so every id
	 * this socket knew is meaningless and may already have been reissued.
	 *
	 * Targeted work is therefore undeliverable and must go. A lazy batch is the
	 * pressing case: nothing else stops it iterating a whole session at a retired
	 * id while every new guest's welcome waits behind it. Retirement records go too —
	 * keeping them would permanently refuse a reissued id, and so does the owner's
	 * view of who is in the room — see {@link onRoomRecreated}, because an id is
	 * also what the owner keys write permission off. Broadcast work is addressed to
	 * whoever is in the room and survives, which is the reconnect backlog contract
	 * the drain tests pin.
	 */
	#resetForRecreatedRoom(): void {
		this.#roomGeneration++;
		this.#retiredPeers.clear();
		this.#shedPeers.clear();
		this.#peerAcks.clear();
		const discarded = this.#discardWhere(pending => pending.targetPeer !== 0);
		if (discarded > 0) logger.debug("collab: discarded targeted sends across a reconnect", { discarded });
	}

	/**
	 * The single admission point. One FIFO serves every peer, so pressure is kept
	 * attributable to the peer that causes it:
	 *
	 * - Targeted work for a retired or just-shed peer is refused.
	 * - An admitted batch supersedes the same peer's queued batch: only the newest welcome is consistent.
	 * - A peer at its {@link MAX_PEER_PENDING_SENDS} share is shed, not the room.
	 * - Over capacity, advisories and targeted work never evict another peer: an
	 *   advisory is refused, targeted work may only displace queued advisories.
	 *   A replica-bearing broadcast displaces advisories, then sheds the peer
	 *   holding most of the exhausted resource; a queue of nothing but replica
	 *   broadcasts is the host's own overload and ends the room.
	 * - The head's charge is waived, so a session larger than the whole budget is
	 *   shareable and live traffic queues behind it instead of shedding its peer.
	 *
	 * @returns whether the entry was queued; a refused entry's `onPrepared` has run.
	 */
	#enqueueSend(entry: PendingSend): boolean {
		const peer = entry.targetPeer;
		if (peer !== 0) {
			if (this.#retiredPeers.has(peer) || this.#shedPeers.has(peer)) return this.#refuse(entry);
			const superseded = entry.lazy
				? (pending: PendingSend) => pending.targetPeer === peer && pending.lazy
				: undefined;
			if (this.#pendingForPeer(peer, superseded) >= MAX_PEER_PENDING_SENDS) {
				this.#shedPeer(peer);
				return this.#refuse(entry);
			}
			// Decided against the queue the supersede would leave, so a refused batch
			// keeps the peer's queued one instead of leaving it with neither.
			if (!this.#fits(entry.bytes, false, superseded)) return this.#refuse(entry);
			if (superseded) this.#discardWhere(superseded);
		}
		if (!this.#fits(entry.bytes, true)) {
			if (entry.advisory) return this.#refuse(entry);
			this.#discardWhere(pending => pending.advisory);
			while (!this.#fits(entry.bytes, true)) {
				if (this.#shedHeaviestPeer()) continue;
				this.#failOverload();
				return this.#refuse(entry);
			}
		}
		this.#pendingSends.push(entry);
		this.#pumpSends();
		return true;
	}

	#refuse(entry: PendingSend): false {
		logger.debug("collab: send refused", { targetPeer: entry.targetPeer, advisory: entry.advisory });
		entry.onPrepared?.();
		return false;
	}

	/**
	 * Whether {@link bytes} more fits the queue, optionally as if its advisories, or the
	 * entries {@link without} matches, were gone. The head is not charged: it is the one
	 * entry draining, and an entry larger than the budget must still be able to.
	 */
	#fits(bytes: number, withAdvisories: boolean, without?: (pending: PendingSend) => boolean): boolean {
		let count = 0;
		let charged = 0;
		for (const pending of this.#pendingSends) {
			if ((!withAdvisories && pending.advisory) || without?.(pending)) continue;
			count++;
			if (pending !== this.#pendingSends[0]) charged += pending.bytes;
		}
		return count === 0 || (count < MAX_PENDING_SENDS && charged + bytes <= MAX_PENDING_SEND_BYTES);
	}

	#pendingForPeer(peerId: number, without?: (pending: PendingSend) => boolean): number {
		let count = 0;
		for (const pending of this.#pendingSends) {
			if (pending.targetPeer === peerId && !without?.(pending)) count++;
		}
		return count;
	}

	/**
	 * Shed the peer holding most of whichever resource is exhausted: entries when the
	 * queue is at its entry cap, bytes otherwise. A head's waived bytes still count: its
	 * drain is what holds every later entry. False when no peer holds any.
	 */
	#shedHeaviestPeer(): boolean {
		const byCount = this.#pendingSends.length >= MAX_PENDING_SENDS;
		const load = new Map<number, number>();
		for (const pending of this.#pendingSends) {
			if (pending.targetPeer === 0) continue;
			load.set(pending.targetPeer, (load.get(pending.targetPeer) ?? 0) + (byCount ? 1 : pending.bytes));
		}
		let heaviest = 0;
		let most = 0;
		for (const [peerId, amount] of load) {
			if (amount > most) {
				heaviest = peerId;
				most = amount;
			}
		}
		if (heaviest === 0) return false;
		this.#shedPeer(heaviest);
		return true;
	}

	/**
	 * Drop a peer's backlog and report it. The report is deferred so the owner's
	 * reaction (a resync error, a notice) cannot re-enter the admission that shed it;
	 * until then the peer is refused, so it is shed and reported once.
	 */
	#shedPeer(peerId: number): void {
		this.dropPeer(peerId);
		if (this.#shedPeers.has(peerId)) return;
		this.#shedPeers.add(peerId);
		const generation = this.#roomGeneration;
		queueMicrotask(() => {
			if (generation !== this.#roomGeneration || !this.#shedPeers.delete(peerId)) return;
			if (this.isServing(peerId)) this.onPeerOverload?.(peerId);
		});
	}

	#failOverload(): void {
		const recovery = this.#opts.role === "host" ? "restart sharing and rejoin" : "rejoin";
		this.#failFatal(
			`collab send backlog exceeded its limit; ${recovery} to resync and check whether pending commands ran before retrying`,
		);
	}

	#pumpSends(): void {
		if (this.#sending || this.#closed) return;
		this.#sending = true;
		const generation = this.#sendGeneration;
		void this.#sendPending(generation)
			.catch((err: unknown) => {
				if (generation === this.#sendGeneration) {
					this.#failFatal(`collab send failed: ${String(err)}; rejoin to resync`);
				}
			})
			.finally(() => {
				if (generation !== this.#sendGeneration) return;
				this.#sending = false;
				if (this.#pendingSends.length > 0) this.#pumpSends();
			});
	}

	async #sendPending(generation: number): Promise<void> {
		while (!this.#closed && generation === this.#sendGeneration) {
			const pending = this.#pendingSends[0];
			if (!pending) return;
			if (pending.lazy) {
				// Advance before the writability gate: resuming past the last frame
				// releases the snapshot, which must not wait on the socket buffer.
				const next = pending.frames.next();
				if (next.done) {
					this.#pendingSends.shift();
					continue;
				}
				const acked = pending.acked?.(next.value) === true;
				if (acked) await this.#waitForPeerRoom(pending, generation);
				if (!(await this.#waitForWritable(generation))) return;
				if (this.#closed || generation !== this.#sendGeneration) return;
				if (pending.cancelled) continue;
				const serialized = typeof next.value === "string" ? next.value : JSON.stringify(next.value);
				const sealed = await sealSerialized(this.#opts.key, serialized, pending.compress);
				if (this.#closed || generation !== this.#sendGeneration) return;
				if (pending.cancelled) continue;
				const envelope = packEnvelope(pending.targetPeer, sealed);
				const outcome = await this.#sendEnvelope(pending, envelope, generation);
				if (outcome === "stop") return;
				const acks = acked && outcome === "sent" ? this.#peerAcks.get(pending.targetPeer) : undefined;
				if (acks) {
					acks.unacked.push(envelope.byteLength);
					acks.inFlight += envelope.byteLength;
				}
				continue;
			}
			// Regular sends are prepared eagerly so flush() can settle before close()
			// hands their envelope to the open socket.
			if (!pending.eager && !(await this.#waitForWritable(generation))) return;
			if (this.#closed || generation !== this.#sendGeneration) return;
			if (pending.cancelled) continue;
			let value = pending.head;
			pending.head = undefined;
			if (value === undefined) {
				const next = pending.frames.next();
				if (next.done) {
					pending.onPrepared?.();
					pending.onPrepared = undefined;
					this.#pendingSends.shift();
					continue;
				}
				value = next.value;
			}
			const serialized = typeof value === "string" ? value : JSON.stringify(value);
			const sealed = await sealSerialized(this.#opts.key, serialized, pending.compress);
			if (this.#closed || generation !== this.#sendGeneration) return;
			if (pending.cancelled) continue;
			const envelope = packEnvelope(pending.targetPeer, sealed);
			pending.preparedEnvelope = envelope;
			pending.onPrepared?.();
			pending.onPrepared = undefined;
			const outcome = await this.#sendEnvelope(pending, envelope, generation);
			if (outcome === "stop") return;
			if (outcome === "sent") {
				pending.preparedEnvelope = undefined;
				if (pending.eager) {
					this.#pendingSends.shift();
				} else {
					const next = pending.frames.next();
					if (next.done) this.#pendingSends.shift();
					else pending.head = next.value;
				}
			}
		}
	}

	/**
	 * Until less than {@link PEER_IN_FLIGHT_BYTES} of `pending`'s peer's acknowledged frames are unacknowledged.
	 * A peer silent for {@link PEER_ACK_TIMEOUT_MS} is no longer paced; one that left cancels `pending`.
	 */
	async #waitForPeerRoom(pending: PendingSend, generation: number): Promise<void> {
		const deadline = Date.now() + PEER_ACK_TIMEOUT_MS;
		while (!this.#closed && generation === this.#sendGeneration && !pending.cancelled) {
			const acks = this.#peerAcks.get(pending.targetPeer);
			if (!acks || acks.inFlight < PEER_IN_FLIGHT_BYTES) return;
			const left = deadline - Date.now();
			if (left <= 0) {
				logger.debug("collab: guest stopped acknowledging its snapshot; sending the rest unpaced", {
					peer: pending.targetPeer,
				});
				this.#peerAcks.delete(pending.targetPeer);
				return;
			}
			const wake = Promise.withResolvers<void>();
			this.#wakeSender = wake.resolve;
			const timer = setTimeout(wake.resolve, left);
			await wake.promise;
			clearTimeout(timer);
			if (this.#wakeSender === wake.resolve) this.#wakeSender = undefined;
		}
	}

	async #sendEnvelope(
		pending: PendingSend,
		envelope: Uint8Array,
		generation: number,
	): Promise<"sent" | "cancelled" | "stop"> {
		while (!this.#closed && generation === this.#sendGeneration) {
			if (pending.cancelled) return "cancelled";
			const ws = await this.#waitForWritable(generation);
			if (!ws || this.#closed || generation !== this.#sendGeneration) return "stop";
			if (pending.cancelled) return "cancelled";
			if (ws !== this.#ws || !this.#isWritable(ws) || ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) continue;
			ws.send(envelope);
			this.#noteWritten(ws, envelope.byteLength);
			return "sent";
		}
		return "stop";
	}

	async #waitForWritable(generation: number): Promise<WebSocket | undefined> {
		let threshold = WS_BACKPRESSURE_THRESHOLD;
		while (!this.#closed && generation === this.#sendGeneration) {
			const ws = this.#ws;
			const buffered = this.#isWritable(ws) && ws.bufferedAmount >= threshold;
			if (this.#isWritable(ws) && !buffered && this.#relayHasRoom(ws)) return ws;
			const wake = Promise.withResolvers<void>();
			this.#wakeSender = wake.resolve;
			let timer: NodeJS.Timeout | undefined;
			if (buffered) {
				threshold = WS_BACKPRESSURE_DRAIN_THRESHOLD;
				timer = setTimeout(wake.resolve, WS_BACKPRESSURE_DRAIN_RETRY_MS);
				this.#backpressureDrainTimer = timer;
			}
			await wake.promise;
			if (this.#backpressureDrainTimer === timer) this.#clearBackpressureDrain();
			if (this.#wakeSender === wake.resolve) this.#wakeSender = undefined;
		}
		return undefined;
	}

	/**
	 * Whether a host may write more before the relay reads what it holds (see {@link RELAY_IN_FLIGHT_BYTES}).
	 * When not, bytes no ping follows yet get one, so the pong that wakes the sender is on its way.
	 */
	#relayHasRoom(ws: WebSocket): boolean {
		if (this.#opts.role !== "host" || this.#relayWritten - this.#relayConfirmed < RELAY_IN_FLIGHT_BYTES) return true;
		if (this.#relayPinged < this.#relayWritten) this.#ping(ws);
		return false;
	}

	#noteWritten(ws: WebSocket, bytes: number): void {
		this.#relayWritten += bytes;
		if (this.#opts.role === "host" && this.#relayWritten - this.#relayPinged >= RELAY_PACING_PING_BYTES)
			this.#ping(ws);
	}

	/** Pings `ws` with a sequence number its pong echoes, recording the bytes written before it. */
	#ping(ws: WebSocket): void {
		const seq = ++this.#pingSeq >>> 0;
		const payload = new Uint8Array(4);
		new DataView(payload.buffer).setUint32(0, seq);
		try {
			ws.ping(payload);
		} catch {
			// A failed write surfaces as the socket's own close event.
			return;
		}
		this.#relayPinged = this.#relayWritten;
		this.#unansweredPings.push({ seq, written: this.#relayWritten });
	}

	/**
	 * A pong proves the relay read everything written before its ping. One without the echoed
	 * sequence number (a relay that drops ping payloads) answers the oldest ping: pongs come in order.
	 */
	#handlePong(event: unknown): void {
		const data = (event as { data?: unknown } | undefined)?.data;
		let answered = 0;
		if (data instanceof Uint8Array && data.byteLength === 4) {
			const seq = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
			const index = this.#unansweredPings.findIndex(ping => ping.seq === seq);
			answered = index + 1;
		} else if (this.#unansweredPings.length > 0) {
			answered = 1;
		}
		if (answered === 0) return;
		this.#relayConfirmed = Math.max(this.#relayConfirmed, this.#unansweredPings[answered - 1]!.written);
		this.#unansweredPings.splice(0, answered);
		this.#wakeSender?.();
	}

	#resetRelayPacing(): void {
		this.#relayWritten = 0;
		this.#relayConfirmed = 0;
		this.#relayPinged = 0;
		this.#unansweredPings = [];
	}

	/**
	 * Resolves once regular sends queued before this call have been sealed and are
	 * either written to the transport or retained as a prepared envelope.
	 */
	flush(): Promise<void> {
		if (this.#preparing.size === 0) return Promise.resolve();
		return Promise.all(this.#preparing).then(() => {});
	}

	/** Revoke unsent frames, including sealing work, before admitting a final frame. */
	discardPendingSends(): void {
		this.#sendGeneration++;
		for (const pending of this.#pendingSends) {
			pending.cancelled = true;
			pending.onPrepared?.();
			pending.frames.return?.(undefined);
		}
		this.#pendingSends.length = 0;
		this.#sending = false;
		this.#preparing.clear();
		this.#clearBackpressureDrain();
		this.#wakeSender?.();
	}

	/** Terminal-only: every caller is closing for good, so no peer is served any more. */
	#discardPendingSends(): void {
		this.discardPendingSends();
		// The room ends here as surely as it does on a reconnect, and `connect()` may
		// reopen this same socket onto a new one — a documented, tested reuse. Advance
		// the generation with the records it clears, or bookkeeping deferred from the
		// closed room applies to the reopened one, which is the reconnect hole with a
		// synchronous trigger instead of a timer.
		this.#roomGeneration++;
		this.#retiredPeers.clear();
		this.#shedPeers.clear();
		this.#peerAcks.clear();
	}

	#clearBackpressureDrain(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearProvisional();
		this.#stopHeartbeat();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#retryMissingRoom = false;
		const ws = this.#ws;
		this.#ws = null;
		const prepared = this.#pendingSends.flatMap(pending =>
			pending.preparedEnvelope ? [pending.preparedEnvelope] : [],
		);
		this.#discardPendingSends();
		if (ws) {
			try {
				// Closing is terminal, so backpressure no longer matters: every
				// prepared envelope (typically a final `bye`) enters the socket buffer
				// ahead of the close frame.
				if (ws.readyState === WebSocket.OPEN) {
					for (const envelope of prepared) ws.send(envelope);
				}
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		this.#clearBackpressureDrain();
		const url = `${this.#opts.wsUrl}?role=${this.#opts.role}`;
		const options = {
			proxy: getProxyForUrl("collab", new URL(url)),
		} satisfies Bun.WebSocketOptions;
		const ws: WebSocket = Reflect.construct(WebSocket, [url, options]);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		this.#resetRelayPacing();
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#startHeartbeat(ws);
			if (this.#rejoining && this.#hostReclaimUntil !== undefined && Date.now() < this.#hostReclaimUntil) {
				// The relay may still refuse this socket as a duplicate host; commit only
				// once it has had the chance to.
				this.#provisional = ws;
				this.#confirmTimer = setTimeout(() => this.#commitOpen(ws), HOST_RECLAIM_CONFIRM_MS);
				return;
			}
			this.#commitOpen(ws);
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			// The relay only talks to a host it accepted; commit before dispatching so
			// the room reset still precedes every frame.
			if (this.#provisional === ws) this.#commitOpen(ws);
			this.#handleMessage(ws, event.data);
		};
		ws.addEventListener("pong", (event: Event) => {
			if (this.#ws !== ws) return;
			this.#lastHeard = Date.now();
			this.#handlePong(event);
		});
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#clearBackpressureDrain();
			this.#clearProvisional();
			this.#stopHeartbeat();
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	/**
	 * Pings `ws` every {@link RELAY_PING_INTERVAL_MS} and treats it as a transient
	 * drop once it has heard nothing for {@link RELAY_SILENCE_LIMIT_MS}. No close
	 * handshake can finish over a dead network, so the socket is terminated and the
	 * drop handled here rather than waiting for a close event that may never come.
	 */
	#startHeartbeat(ws: WebSocket): void {
		this.#stopHeartbeat();
		this.#lastHeard = Date.now();
		this.#heartbeatTimer = setInterval(() => {
			if (this.#ws !== ws) {
				this.#stopHeartbeat();
				return;
			}
			if (Date.now() - this.#lastHeard <= RELAY_SILENCE_LIMIT_MS) {
				this.#ping(ws);
				return;
			}
			logger.debug("collab: relay connection went silent; reconnecting", { role: this.#opts.role });
			this.#clearBackpressureDrain();
			this.#clearProvisional();
			this.#stopHeartbeat();
			this.#ws = null;
			try {
				ws.terminate();
			} catch {
				// already gone
			}
			this.#handleClose(1006, "relay stopped responding");
		}, RELAY_PING_INTERVAL_MS);
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer !== undefined) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = undefined;
		}
	}

	#commitOpen(ws: WebSocket): void {
		if (this.#ws !== ws) return;
		this.#clearProvisional();
		if (!this.#retryMissingRoom) this.#attempt = 0;
		// Before waking the sender, or it resumes a stale targeted iterator.
		if (this.#rejoining) {
			this.#rejoining = false;
			this.#resetForRecreatedRoom();
			// Before onOpen, and before onmessage can dispatch anything: the owner
			// keys permissions off peer ids the relay is about to reissue.
			this.onRoomRecreated?.();
		}
		this.#wakeSender?.();
		this.onOpen?.();
	}

	#isWritable(ws: WebSocket | null | undefined): ws is WebSocket {
		return ws?.readyState === WebSocket.OPEN && ws !== this.#provisional;
	}

	#clearProvisional(): void {
		if (this.#confirmTimer !== undefined) {
			clearTimeout(this.#confirmTimer);
			this.#confirmTimer = undefined;
		}
		this.#provisional = undefined;
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			let msg: RelayControlMessage;
			try {
				msg = JSON.parse(data) as RelayControlMessage;
			} catch {
				logger.debug("collab: ignoring malformed control message");
				return;
			}
			this.#applyPeerLifecycle(msg);
			this.onControl?.(msg);
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) return;
		const envelope = unpackEnvelope(bytes);
		if (!envelope) return;
		// A frame received on the live socket belongs to this room even if the
		// socket closes while it is still decrypting — a host's goodbye lands just
		// before the relay tears the room down. Only a terminal close or a room
		// recreation makes it stale; a mere disconnect ahead of a retry does not.
		const generation = this.#roomGeneration;
		const stale = (): boolean => this.#closed || generation !== this.#roomGeneration;
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (stale()) return;
				let frame: CollabFrame;
				try {
					frame = await open(this.#opts.key, envelope.payload);
				} catch {
					if (stale()) return;
					if (this.#opts.role === "host") {
						logger.debug("collab: ignoring undecryptable guest frame", { peer: envelope.peerId });
					} else {
						this.#failFatal("bad key or corrupted frame");
					}
					return;
				}
				if (stale()) return;
				if (this.#ws === ws) {
					this.#retryMissingRoom = false;
					this.#attempt = 0;
				}
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch((err: unknown) => {
				logger.debug("collab: frame handler failed", { error: String(err) });
			});
	}

	/**
	 * Peer lifetime, applied synchronously so no owner callback can enqueue for a
	 * peer whose departure this socket has already seen. Dropping the backlog here
	 * rather than in the owner keeps the invariant with the set that defines it.
	 */
	#applyPeerLifecycle(msg: RelayControlMessage): void {
		if (msg.t !== "peer-left") return;
		const peer = msg.peer;
		const generation = this.#roomGeneration;
		this.#retiredPeers.set(peer, false);
		this.dropPeer(peer);
		// The obligation is discharged once everything received before this control
		// message has been dispatched; nothing can arrive from the id afterwards.
		//
		// In this room only. The chain outlives a reconnect, so a settlement queued
		// behind a held decryption can run after the room was recreated — and by
		// then the id has been reissued and the records cleared, so marking "peer"
		// settled marks the *new* occupant's record instead. That record is then
		// evictable before the frames received ahead of its departure have been
		// dispatched, and once it is gone the id reads as served again: a departed
		// peer's frame reaches the owner with authority the relay already withdrew.
		void this.#recvChain.then(() => {
			if (generation !== this.#roomGeneration) return;
			if (this.#retiredPeers.has(peer)) this.#retiredPeers.set(peer, true);
			this.#trimRetired();
		});
	}

	/** Forget the oldest *settled* retirements past the cap; insertion order is Map order. */
	#trimRetired(): void {
		if (this.#retiredPeers.size <= MAX_RETIRED_PEERS) return;
		for (const [peer, settled] of this.#retiredPeers) {
			if (this.#retiredPeers.size <= MAX_RETIRED_PEERS) return;
			if (settled) this.#retiredPeers.delete(peer);
		}
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		if (code === 4009 && this.#hostReclaimUntil !== undefined && Date.now() < this.#hostReclaimUntil) {
			logger.debug("collab: relay still holds this host's dropped connection; retrying", {
				attempt: this.#reclaimAttempt,
			});
			this.#rejoining = true;
			this.onClose?.("the relay still holds this host's previous connection", true);
			this.#scheduleRetry(this.#reclaimAttempt++, HOST_RECLAIM_BACKOFF_MAX_MS);
			return;
		}
		const fatalReason = RELAY_CLOSE_REASONS[code];
		const closeReason = fatalReason ?? (reason || `connection lost (code ${code})`);
		const retryRoom = this.#opts.role === "guest" && (code === 4001 || (code === 4004 && this.#retryMissingRoom));
		if (retryRoom) {
			this.#retryMissingRoom = true;
			this.#rejoining = true;
			this.onClose?.(closeReason, true);
			this.#scheduleRetry(this.#attempt++);
			return;
		}
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#discardPendingSends();
			this.onClose?.(fatalReason, false);
			return;
		}
		this.#clearBackpressureDrain();
		this.#rejoining = true;
		if (this.#opts.role === "host") {
			this.#hostReclaimUntil = Date.now() + HOST_RECLAIM_WINDOW_MS;
			this.#reclaimAttempt = 0;
		}
		this.onClose?.(closeReason, true);
		this.#scheduleRetry(this.#attempt++);
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#clearProvisional();
		this.#stopHeartbeat();
		this.#discardPendingSends();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(attempt: number, maxMs = BACKOFF_MAX_MS): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, maxMs);
		const delay = base * (0.75 + Math.random() * 0.5);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
