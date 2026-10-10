/**
 * The host's connection to its room: the public relay, and optionally a second relay on
 * the host's own machine that serves the same room (same id, key and write token).
 *
 * Guests on either relay see one session. Outgoing broadcasts go to both relays and a
 * targeted frame goes to the relay its peer is on; guests from both are accepted. The host
 * works against one peer-id space: public peers keep the id their relay issued, local peers
 * are shifted by {@link LOCAL_PEER_BASE}, so two relays that both count from 1 never collide.
 *
 * The public relay owns the room. Everything about the local relay is best effort and
 * isolated: its sockets keep their own send backlog and reconnect on their own, a fatal
 * local close is retried on a timer and never reaches the host's `onClose`, a local relay
 * that is down costs the public session nothing (no frame is queued for it while no local
 * guest is present, and a flush never waits on it for more than {@link LOCAL_FLUSH_WAIT_MS}).
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { CollabFrame, EncodedFrame, RelayControlMessage } from "./protocol";
import { serializeFrame } from "./protocol";
import { CollabSocket } from "./relay-client";

/** Local peer ids are offset by this much; relays count from 1, so the ranges never meet. */
export const LOCAL_PEER_BASE = 0x4000_0000;
/** A local relay that ended the room fatally (not a retryable drop) is tried again after this long. */
export const LOCAL_RESTART_MS = 30_000;
/** How long {@link FanoutSocket.flush} waits for the local relay's queue after the public one settled. */
export const LOCAL_FLUSH_WAIT_MS = 500;

export interface FanoutSocketOptions {
	/** wss://host[:port]/r/<roomId> on the public relay. */
	wsUrl: string;
	/** ws://127.0.0.1:<port>/r/<roomId> on the host's own relay; absent when no local relay is configured. */
	localWsUrl?: string;
	key: CryptoKey;
}

/** Whether a host-side peer id belongs to the local relay. */
export function isLocalPeer(peerId: number): boolean {
	return peerId >= LOCAL_PEER_BASE;
}

export class FanoutSocket {
	/** Fires after every successful (re)connect of the public relay. */
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	/** `peer-joined` / `peer-left` with host-side peer ids; a local relay going away reports its guests as left. */
	onControl?: (msg: RelayControlMessage) => void;
	/** The public relay's closes only; the local relay never ends or interrupts the room. */
	onClose?: (reason: string, willReconnect: boolean) => void;
	/**
	 * A relay recreated its room and reissues peer ids: `owns` selects the host-side ids that
	 * belonged to it. Peers on the other relay are unaffected.
	 */
	onRoomRecreated?: (owns: (peerId: number) => boolean) => void;

	readonly #primary: CollabSocket;
	readonly #localWsUrl: string | undefined;
	readonly #key: CryptoKey;
	#local: CollabSocket | null = null;
	/** Local relay ids (unshifted) between their `peer-joined` and `peer-left`. */
	readonly #localPeers = new Set<number>();
	#localRestart: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(opts: FanoutSocketOptions) {
		this.#localWsUrl = opts.localWsUrl;
		this.#key = opts.key;
		const primary = new CollabSocket({ wsUrl: opts.wsUrl, role: "host", key: opts.key });
		primary.onOpen = () => this.onOpen?.();
		primary.onFrame = (frame, fromPeer) => {
			if (!isLocalPeer(fromPeer)) this.onFrame?.(frame, fromPeer);
		};
		primary.onControl = msg => {
			if ("peer" in msg && isLocalPeer(msg.peer)) return;
			this.onControl?.(msg);
		};
		primary.onClose = (reason, willReconnect) => this.onClose?.(reason, willReconnect);
		primary.onRoomRecreated = () => this.onRoomRecreated?.(peerId => !isLocalPeer(peerId));
		this.#primary = primary;
	}

	get isOpen(): boolean {
		return this.#primary.isOpen;
	}

	/** Whether the local relay is connected and holds the room. */
	get localOpen(): boolean {
		return this.#local?.isOpen === true;
	}

	/** Whether a frame from this peer may still be acted on. */
	isServing(peerId: number): boolean {
		if (!isLocalPeer(peerId)) return this.#primary.isServing(peerId);
		const local = peerId - LOCAL_PEER_BASE;
		// The set is what a local close empties, so a frame still decrypting after the
		// relay went away reads as stale even though the socket's own record is not retired.
		return this.#localPeers.has(local) && this.#local?.isServing(local) === true;
	}

	connect(): void {
		this.#primary.connect();
		this.#startLocal();
	}

	send(frame: CollabFrame | EncodedFrame, targetPeer = 0, compress = false): void {
		if (targetPeer === 0) {
			this.#broadcast(frame);
			return;
		}
		if (!isLocalPeer(targetPeer)) {
			this.#primary.send(frame, targetPeer, compress);
			return;
		}
		const local = targetPeer - LOCAL_PEER_BASE;
		if (this.#localPeers.has(local)) this.#local?.send(frame, local, compress);
	}

	/** Broadcast to the public relay, and to the local one only while a local guest is present. */
	#broadcast(frame: CollabFrame | EncodedFrame): void {
		const local = this.#local;
		if (local === null || this.#localPeers.size === 0) {
			this.#primary.send(frame);
			return;
		}
		let encoded: EncodedFrame;
		try {
			encoded = typeof frame === "string" ? frame : serializeFrame(frame);
		} catch {
			// The public socket reports an unserializable frame the way it always has.
			this.#primary.send(frame);
			return;
		}
		this.#primary.send(encoded);
		local.send(encoded);
	}

	sendBatch(frames: Iterable<CollabFrame | EncodedFrame>, targetPeer = 0, compress = false): void {
		if (targetPeer === 0) {
			const items = [...frames];
			this.#primary.sendBatch(items);
			if (this.#local !== null && this.#localPeers.size > 0) this.#local.sendBatch(items);
			return;
		}
		if (!isLocalPeer(targetPeer)) {
			this.#primary.sendBatch(frames, targetPeer, compress);
			return;
		}
		const local = targetPeer - LOCAL_PEER_BASE;
		if (this.#localPeers.has(local)) this.#local?.sendBatch(frames, local, compress);
	}

	/** Discard what is still queued for a peer that left; see {@link CollabSocket.dropPeer}. */
	dropPeer(peerId: number): number {
		if (!isLocalPeer(peerId)) return this.#primary.dropPeer(peerId);
		return this.#local?.dropPeer(peerId - LOCAL_PEER_BASE) ?? 0;
	}

	/**
	 * Resolves once the public relay's queued frames are sealed, and the local relay's too unless
	 * it is slow: a stalled local queue must not hold the public session's pacing or shutdown.
	 */
	async flush(): Promise<void> {
		const local = this.#local;
		const primary = this.#primary.flush();
		if (local === null || !local.isOpen) {
			await primary;
			return;
		}
		const timer = Promise.withResolvers<void>();
		const timeout = setTimeout(timer.resolve, LOCAL_FLUSH_WAIT_MS);
		try {
			await Promise.all([primary, Promise.race([local.flush(), timer.promise])]);
		} finally {
			clearTimeout(timeout);
		}
	}

	discardPendingSends(): void {
		this.#primary.discardPendingSends();
		this.#local?.discardPendingSends();
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#localRestart);
		this.#localRestart = undefined;
		this.#disposeLocal();
		this.#primary.close();
	}

	#startLocal(): void {
		if (this.#closed || this.#localWsUrl === undefined || this.#local !== null) return;
		const local = new CollabSocket({ wsUrl: this.#localWsUrl, role: "host", key: this.#key });
		this.#local = local;
		local.onOpen = () => logger.debug("collab: local relay connected");
		local.onFrame = (frame, fromPeer) => {
			if (fromPeer > 0 && fromPeer < LOCAL_PEER_BASE) this.onFrame?.(frame, fromPeer + LOCAL_PEER_BASE);
		};
		local.onControl = msg => {
			if (msg.t !== "peer-joined" && msg.t !== "peer-left") return;
			if (msg.peer <= 0 || msg.peer >= LOCAL_PEER_BASE) return;
			if (msg.t === "peer-joined") this.#localPeers.add(msg.peer);
			else this.#localPeers.delete(msg.peer);
			this.onControl?.({ t: msg.t, peer: msg.peer + LOCAL_PEER_BASE });
		};
		local.onRoomRecreated = () => {
			this.#localPeers.clear();
			this.onRoomRecreated?.(isLocalPeer);
		};
		local.onClose = (reason, willReconnect) => {
			logger.debug("collab: local relay closed", { reason, willReconnect });
			this.#releaseLocalPeers();
			if (willReconnect || this.#local !== local) return;
			// A socket that gave up (its own backlog overflowed, the relay refused the room) is
			// replaced by a fresh one later; the public session carries on meanwhile.
			this.#disposeLocal();
			this.#localRestart = setTimeout(() => {
				this.#localRestart = undefined;
				this.#startLocal();
			}, LOCAL_RESTART_MS);
		};
		local.connect();
	}

	/** The local relay's guests are gone with its connection: report them left so the host forgets them. */
	#releaseLocalPeers(): void {
		const gone = [...this.#localPeers];
		this.#localPeers.clear();
		for (const peer of gone) this.onControl?.({ t: "peer-left", peer: peer + LOCAL_PEER_BASE });
	}

	#disposeLocal(): void {
		const local = this.#local;
		if (local === null) return;
		this.#local = null;
		local.onOpen = undefined;
		local.onFrame = undefined;
		local.onControl = undefined;
		local.onClose = undefined;
		local.onRoomRecreated = undefined;
		local.close();
		this.#localPeers.clear();
	}
}
