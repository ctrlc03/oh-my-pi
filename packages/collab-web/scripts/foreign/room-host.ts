/**
 * The room plumbing of a collab host that is not omp: the encrypted relay socket(s), the guest roster and
 * its write bit, targeted and broadcast sends, the `hello` handshake and the snapshot that follows the
 * `welcome`. `scripts/mock-host.ts` (a scripted host) and `./foreign-host.ts` (a vendor agent behind ACP)
 * both build on it; what a session says (its welcome, entries, state, commands) stays with them.
 *
 * It mirrors `coding-agent/src/collab/host.ts` and `relay-client.ts` where a guest can tell: the same
 * protocol check and write-token rule, the same delta resume (`hello.resume` → `welcome.resumed`), the same
 * byte-bounded `snapshot-chunk` train, compression only toward peers that said `zip`, and a relay
 * connection that comes back with backoff (the relay recreates the room, guests rejoin) instead of ending
 * the session. A second, loopback relay may serve the room too; its peer ids are shifted by
 * {@link LOCAL_PEER_BASE} so both relays share one id space.
 */

import { timingSafeEqual } from "node:crypto";
import {
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	type GuestFrame,
	type HostFrame,
	normalizeLocalRelayUrl,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-wire";
import { CAN_INFLATE, generateRoomKey, importRoomKey, open, seal } from "../../src/lib/codec";
import {
	decodeBase64Url,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	unpackEnvelope,
} from "../../src/lib/link";

/** Local relay peer ids are shifted so both relays share one id space, as omp's host does. */
export const LOCAL_PEER_BASE = 0x4000_0000;
/** Soft byte cap of one `snapshot-chunk` frame (omp's host uses the same), so a long session never forms a frame the relay stalls on. */
export const SNAPSHOT_CHUNK_BYTES = 512 * 1024;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** After a drop, a refused reconnect (4009: "a host is already connected") is the relay still holding our old socket for this long. */
const RECLAIM_WINDOW_MS = 150_000;
const RECLAIM_BACKOFF_MAX_MS = 5_000;
/** How long {@link RoomHost.close} keeps the sockets open after the goodbye so guests can read it. */
const GOODBYE_LINGER_MS = 150;
const FATAL_CLOSE_REASONS: Record<number, string> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

const TEXT_ENCODER = new TextEncoder();

/** A guest that said `hello`. */
export interface RoomPeer {
	id: number;
	name: string;
	/** Joined through the full link: it may prompt and run session controls. */
	writer: boolean;
	/** It can open compressed frames. */
	zip: boolean;
}

export type HelloFrame = Extract<GuestFrame, { t: "hello" }>;

/** The fields of a `welcome` a host fills in; the room adds the protocol, entry count, read-only flag and resume marker. */
export type WelcomeBody = Omit<
	Extract<HostFrame, { t: "welcome" }>,
	"t" | "proto" | "entryCount" | "readOnly" | "resumed"
>;

export interface RoomHandlers {
	/** A guest said hello and is on the roster: send its welcome and snapshot (see {@link RoomHost.sendWelcome}). */
	onHello(peer: RoomPeer, hello: HelloFrame): void;
	/** Any other frame from a guest on the roster. */
	onFrame(frame: Exclude<GuestFrame, HelloFrame>, peer: RoomPeer): void;
	/** A guest left (relay `peer-left`, or its relay went away). `peer` is undefined when it never said hello. */
	onPeerLeft(peer: RoomPeer | undefined, id: number): void;
	/** The relay recreated the room after a reconnect: every peer id from before is void. */
	onReset?(): void;
	/**
	 * The main relay connection ended. `willReconnect` false is terminal: the host should shut down
	 * (a refused duplicate host, a full room) or, when reconnecting is off, simply ended.
	 */
	onClosed?(reason: string, willReconnect: boolean): void;
	/** The main relay connection is open (again). */
	onOpen?(): void;
	/** The local relay connection opened or closed. */
	onLocalRelay?(up: boolean): void;
	/** A frame could not be opened (wrong key, corrupt); it is dropped. */
	onUndecryptable?(err: unknown): void;
}

export interface RoomHostOptions {
	/** Public relay base (`wss://my.omp.sh`, or `ws://127.0.0.1:<port>` for a local one). Defaults to omp's public relay. */
	relayUrl?: string;
	/** A loopback relay (`ws://127.0.0.1:<port>`) that serves the room as well; reconnected whenever it is down. */
	localRelayUrl?: string;
	/** Base of the web app for browser links; derived from the relay when absent. */
	webUrl?: string;
	/** Retry the main relay with backoff after a drop. Default true; off, a drop is terminal. */
	reconnect?: boolean;
	/** Reuse a room (a restarted process keeps its links); a fresh one is made when absent. */
	room?: { roomId: string; key: Uint8Array; writeToken: Uint8Array };
	handlers: RoomHandlers;
	/** Prefix of log lines. */
	label?: string;
}

/** The base URL of the web app for `relayUrl`, as omp derives it (`collab.webUrl` wins when set). */
export function webBaseUrl(relayUrl: string, webUrl?: string): string {
	const explicit = webUrl?.trim();
	if (explicit) {
		const url = new URL(explicit);
		if (url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("the web URL must start with http:// or https://");
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	}
	const url = new URL(relayUrl);
	const scheme = url.protocol === "wss:" || url.protocol === "https:" ? "https:" : "http:";
	return `${scheme}//${url.host}`;
}

/** What a snapshot sends a peer that asked for a delta: the entries after its last one, when this host still holds it. */
export function resumeSlice(
	entries: readonly SessionEntry[],
	header: SessionHeader,
	resume: HelloFrame["resume"],
): { entries: readonly SessionEntry[]; resumed: boolean } {
	if (resume === undefined || resume.sessionId !== header.id) return { entries, resumed: false };
	const at = entries.findLastIndex(entry => entry.id === resume.entryId);
	return at < 0 ? { entries, resumed: false } : { entries: entries.slice(at + 1), resumed: true };
}

export class RoomHost {
	readonly roomId: string;
	readonly rawKey: Uint8Array;
	readonly relayUrl: string;
	readonly localRelayUrl: string | undefined;
	/** Full link (control) and view link, in the form the connect screen pastes. */
	readonly link: string;
	readonly viewLink: string;
	/** The same links as browser URLs of the web app. */
	readonly webLink: string;
	readonly webViewLink: string;
	/** Resolves when the main relay connection first opens. */
	readonly opened: Promise<void>;

	readonly #handlers: RoomHandlers;
	readonly #label: string;
	readonly #reconnect: boolean;
	readonly #writeToken: Uint8Array;
	readonly #peers = new Map<number, RoomPeer>();
	#key!: CryptoKey;
	#ws: WebSocket | null = null;
	#localWs: WebSocket | null = null;
	#localRetry: Timer | undefined;
	#localAttempt = 0;
	#retry: Timer | undefined;
	#attempt = 0;
	#reclaimUntil: number | undefined;
	#everOpened = false;
	#rejoining = false;
	#closed = false;
	#sendChain: Promise<void> = Promise.resolve();
	#recvChain: Promise<void> = Promise.resolve();
	readonly #openedResolve: () => void;

	constructor(options: RoomHostOptions) {
		this.relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;
		this.localRelayUrl = options.localRelayUrl;
		if (this.localRelayUrl !== undefined && normalizeLocalRelayUrl(this.localRelayUrl) === null) {
			throw new Error(`invalid local relay URL: ${this.localRelayUrl} (use ws://127.0.0.1:<port>)`);
		}
		this.#handlers = options.handlers;
		this.#label = options.label ?? "room";
		this.#reconnect = options.reconnect ?? true;
		this.roomId = options.room?.roomId ?? generateRoomId();
		this.rawKey = options.room?.key ?? generateRoomKey();
		this.#writeToken = options.room?.writeToken ?? crypto.getRandomValues(new Uint8Array(16));
		this.link = formatCollabLink(this.relayUrl, this.roomId, this.rawKey, this.#writeToken, this.localRelayUrl);
		this.viewLink = formatCollabLink(this.relayUrl, this.roomId, this.rawKey, undefined, this.localRelayUrl);
		const base = webBaseUrl(this.relayUrl, options.webUrl);
		this.webLink = `${base}/#${this.link}`;
		this.webViewLink = `${base}/#${this.viewLink}`;
		const opened = Promise.withResolvers<void>();
		this.opened = opened.promise;
		this.#openedResolve = opened.resolve;
	}

	/** The room's secrets, for a process that must reopen the same room. */
	get room(): { roomId: string; key: Uint8Array; writeToken: Uint8Array } {
		return { roomId: this.roomId, key: this.rawKey, writeToken: this.#writeToken };
	}

	get writeTokenText(): string {
		return encodeBase64Url(this.#writeToken);
	}

	/** Whether the main relay connection is open now. */
	get connected(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	/** Whether the local relay connection is open now. */
	get localConnected(): boolean {
		return this.#localWs?.readyState === WebSocket.OPEN;
	}

	/** Guests that said hello, by peer id. */
	get peers(): ReadonlyMap<number, RoomPeer> {
		return this.#peers;
	}

	/** Open the connections. The relay's room exists once the main connection opens (see {@link opened}). */
	async start(): Promise<void> {
		this.#key = await importRoomKey(this.rawKey);
		this.#connectMain();
		this.#connectLocal();
	}

	/** Seal and send a frame; peer 0 broadcasts on both relays, N targets that guest on its relay. */
	send(frame: HostFrame, toPeer = 0): void {
		if (this.#closed) return;
		const compress = toPeer !== 0 && this.#peers.get(toPeer)?.zip === true;
		this.#sendChain = this.#sendChain
			.then(async () => {
				const sealed = await seal(this.#key, frame, compress);
				this.#deliver(sealed, toPeer);
			})
			.catch((err: unknown) => {
				console.error(`${this.#label}: send failed:`, err);
			});
	}

	/** Send `frame` to every guest that may write. */
	sendWriters(frame: HostFrame): void {
		for (const peer of this.#peers.values()) if (peer.writer) this.send(frame, peer.id);
	}

	/** Resolves once everything sent so far has left the process. */
	flush(): Promise<void> {
		return this.#sendChain;
	}

	/** Connect to the local relay now instead of at the next backoff (it was just restarted). */
	reconnectLocal(): void {
		if (this.#localWs?.readyState === WebSocket.OPEN) return;
		clearTimeout(this.#localRetry);
		this.#localAttempt = 0;
		this.#connectLocal();
	}

	/** Refuse a read-only guest's mutating frame with an `error`, as omp's host does. True when refused. */
	refuseReadOnly(peer: RoomPeer, action = "this action"): boolean {
		if (peer.writer) return false;
		this.send({ t: "error", message: `${action} is disabled on a read-only link` }, peer.id);
		return true;
	}

	/**
	 * Send `peer` its `welcome` and the snapshot after it: the whole path, or only what follows the entry its
	 * `hello.resume` names when this host still holds it. Models, commands and profiles go to writers only.
	 */
	sendWelcome(peer: RoomPeer, hello: HelloFrame, body: WelcomeBody, entries: readonly SessionEntry[]): void {
		const slice = resumeSlice(entries, body.header, hello.resume);
		this.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				...body,
				models: peer.writer ? body.models : undefined,
				profiles: peer.writer ? body.profiles : undefined,
				commands: peer.writer ? body.commands : undefined,
				entryCount: slice.entries.length,
				readOnly: peer.writer ? undefined : true,
				resumed: slice.resumed ? true : undefined,
			},
			peer.id,
		);
		this.#sendSnapshot(slice.entries, peer.id);
	}

	/** Tell every guest the room ends, then close both connections. */
	async close(reason: string): Promise<void> {
		if (this.#closed) return;
		this.send({ t: "bye", reason });
		await this.#sendChain;
		// A guest decrypts the goodbye asynchronously; closing at once lets the relay's "room closed" reach it first.
		await Bun.sleep(GOODBYE_LINGER_MS);
		this.#closed = true;
		clearTimeout(this.#retry);
		clearTimeout(this.#localRetry);
		for (const socket of [this.#ws, this.#localWs]) {
			try {
				socket?.close(1000);
			} catch {
				// already closing
			}
		}
		this.#ws = null;
		this.#localWs = null;
		this.#peers.clear();
	}

	#sendSnapshot(entries: readonly SessionEntry[], toPeer: number): void {
		let batch: SessionEntry[] = [];
		let bytes = 0;
		const chunks: SessionEntry[][] = [];
		for (const entry of entries) {
			const size = TEXT_ENCODER.encode(JSON.stringify(entry)).byteLength;
			if (batch.length > 0 && bytes + size > SNAPSHOT_CHUNK_BYTES) {
				chunks.push(batch);
				batch = [];
				bytes = 0;
			}
			batch.push(entry);
			bytes += size;
		}
		chunks.push(batch);
		chunks.forEach((chunk, i) => {
			this.send({ t: "snapshot-chunk", entries: chunk, final: i === chunks.length - 1 }, toPeer);
		});
	}

	#deliver(sealed: Uint8Array, toPeer: number): void {
		if (toPeer === 0) {
			for (const socket of [this.#ws, this.#localWs]) {
				if (socket?.readyState === WebSocket.OPEN) socket.send(packEnvelope(0, sealed));
			}
			return;
		}
		const local = toPeer >= LOCAL_PEER_BASE;
		const socket = local ? this.#localWs : this.#ws;
		if (socket?.readyState !== WebSocket.OPEN) return;
		socket.send(packEnvelope(local ? toPeer - LOCAL_PEER_BASE : toPeer, sealed));
	}

	// ── relay connections ────────────────────────────────────────────────────

	#connectMain(): void {
		if (this.#closed) return;
		const socket = new WebSocket(`${this.relayUrl}/r/${this.roomId}?role=host`);
		socket.binaryType = "arraybuffer";
		this.#ws = socket;
		this.#attach(socket, 0);
		socket.onopen = () => {
			if (this.#ws !== socket) return;
			this.#attempt = 0;
			if (this.#rejoining) {
				// The relay recreated the room: peer ids restart, so none from before still names a guest.
				this.#peers.clear();
				this.#handlers.onReset?.();
			}
			this.#rejoining = false;
			this.#everOpened = true;
			this.#openedResolve();
			this.#handlers.onOpen?.();
		};
		socket.onclose = event => {
			if (this.#ws !== socket || this.#closed) return;
			const reason = FATAL_CLOSE_REASONS[event.code] ?? (event.reason || `relay connection closed (${event.code})`);
			const reclaiming = event.code === 4009 && this.#reclaimUntil !== undefined && Date.now() < this.#reclaimUntil;
			if (!this.#reconnect || (Object.hasOwn(FATAL_CLOSE_REASONS, event.code) && !reclaiming)) {
				this.#handlers.onClosed?.(reason, false);
				return;
			}
			if (this.#everOpened && !this.#rejoining) {
				this.#rejoining = true;
				this.#reclaimUntil = Date.now() + RECLAIM_WINDOW_MS;
			}
			this.#handlers.onClosed?.(reason, true);
			const max = reclaiming ? RECLAIM_BACKOFF_MAX_MS : BACKOFF_MAX_MS;
			const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt++, max);
			this.#retry = setTimeout(() => this.#connectMain(), delay);
		};
	}

	#connectLocal(): void {
		if (this.#closed || this.localRelayUrl === undefined) return;
		const socket = new WebSocket(`${this.localRelayUrl}/r/${this.roomId}?role=host`);
		socket.binaryType = "arraybuffer";
		this.#localWs = socket;
		this.#attach(socket, LOCAL_PEER_BASE);
		socket.onopen = () => {
			if (this.#localWs !== socket) return;
			this.#localAttempt = 0;
			this.#handlers.onLocalRelay?.(true);
		};
		socket.onclose = () => {
			if (this.#localWs !== socket || this.#closed) return;
			this.#localWs = null;
			// Guests on it fall back to the main relay; their peer ids are void.
			for (const id of this.#peers.keys()) if (id >= LOCAL_PEER_BASE) this.#release(id);
			this.#handlers.onLocalRelay?.(false);
			const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#localAttempt++, BACKOFF_MAX_MS);
			this.#localRetry = setTimeout(() => this.#connectLocal(), delay);
		};
	}

	/** Both relays feed one handler; `base` shifts the local relay's peer ids out of the main relay's range. */
	#attach(socket: WebSocket, base: number): void {
		socket.onmessage = event => {
			const data: unknown = event.data;
			if (typeof data === "string") {
				this.#control(data, base);
				return;
			}
			if (!(data instanceof ArrayBuffer)) return;
			const envelope = unpackEnvelope(new Uint8Array(data));
			if (!envelope) return;
			this.#recvChain = this.#recvChain
				.then(async () => {
					const frame = await open<GuestFrame>(this.#key, envelope.payload);
					this.#frame(frame, envelope.peerId + base);
				})
				.catch((err: unknown) => {
					if (this.#handlers.onUndecryptable) this.#handlers.onUndecryptable(err);
					else console.error(`${this.#label}: dropping undecryptable frame:`, err);
				});
		};
	}

	#control(text: string, base: number): void {
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null) return;
		const control = msg as { t?: unknown; peer?: unknown };
		if (control.t === "peer-left" && typeof control.peer === "number") this.#release(control.peer + base);
	}

	#release(id: number): void {
		const peer = this.#peers.get(id);
		this.#peers.delete(id);
		this.#handlers.onPeerLeft(peer, id);
	}

	#frame(frame: GuestFrame, fromPeer: number): void {
		if (frame.t === "hello") {
			this.#hello(frame, fromPeer);
			return;
		}
		const peer = this.#peers.get(fromPeer);
		if (peer === undefined) return;
		this.#handlers.onFrame(frame, peer);
	}

	#hello(hello: HelloFrame, fromPeer: number): void {
		if (hello.proto !== COLLAB_PROTO) {
			this.send(
				{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${hello.proto}` },
				fromPeer,
			);
			return;
		}
		const peer: RoomPeer = {
			id: fromPeer,
			name: hello.name.trim().slice(0, 64) || `guest-${fromPeer}`,
			writer: this.#verifyWriteToken(hello.writeToken),
			zip: hello.zip === true && CAN_INFLATE,
		};
		this.#peers.set(fromPeer, peer);
		this.#handlers.onHello(peer, hello);
	}

	/** Timing-safe write-token check; a guest without a valid token is read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		if (!token) return false;
		const bytes = decodeBase64Url(token);
		return (
			bytes !== null && bytes.byteLength === this.#writeToken.byteLength && timingSafeEqual(bytes, this.#writeToken)
		);
	}
}
