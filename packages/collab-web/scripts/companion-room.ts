/**
 * The companion's room, hosted on every relay it is reachable through: the public relay (phones, and any browser
 * that cannot reach this computer's loopback) and, when it runs one, the loopback relay (the app on this computer,
 * see ./companion-local-relay). It is one room: the same id and key, the same requests and replies.
 *
 * Each relay numbers its own guests from 1, so two guests on different relays would share a peer id. The rest of the
 * companion addresses peers by one number; this class gives loopback guests ids above {@link LOCAL_PEER_BASE}, maps
 * them back when sending, and says which relay each connection and close belongs to.
 */
import type { RelayControlMessage } from "@oh-my-pi/pi-wire";
import { CollabSocket, type CollabSocketOptions } from "../src/lib/socket";

/** Loopback guests are numbered `LOCAL_PEER_BASE + <their id on the loopback relay>`; public relay ids stay far below. */
export const LOCAL_PEER_BASE = 0x4000_0000;

export type RoomRoute = "public" | "local";

export interface RoomHostOptions {
	key: CollabSocketOptions["key"];
	/** `wss://relay/r/<roomId>`. */
	publicUrl: string;
	/** `ws://127.0.0.1:<port>/r/<roomId>`; absent when the companion runs no loopback relay. */
	localUrl?: string;
	/** HTTP proxy for the public relay; see {@link relayProxy}. */
	proxy?: string;
}

/**
 * The proxy the standard variables name for `wsUrl` (`HTTPS_PROXY` for `wss:`, `HTTP_PROXY` for `ws:`, then
 * `ALL_PROXY`; lower-case forms too), unless `NO_PROXY` lists its host (exact, a `.suffix`/`suffix` domain, or `*`).
 * Bun's WebSocket ignores them, and in a VM whose egress goes through the host's proxy the relay is unreachable without.
 */
export function relayProxy(wsUrl: string, env: Record<string, string | undefined> = process.env): string | undefined {
	let url: URL;
	try {
		url = new URL(wsUrl);
	} catch {
		return undefined;
	}
	const host = url.hostname.toLowerCase();
	const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "")
		.split(",")
		.map(entry => entry.trim().toLowerCase().replace(/:\d+$/, ""))
		.filter(Boolean);
	for (const entry of noProxy) {
		if (entry === "*") return undefined;
		const domain = entry.replace(/^\*?\./, "");
		if (host === domain || host.endsWith(`.${domain}`)) return undefined;
	}
	const secure = url.protocol === "wss:" || url.protocol === "https:";
	const proxy = secure ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
	return proxy || env.ALL_PROXY || env.all_proxy || undefined;
}

export class RoomHost<Out extends object, In> {
	/** A relay accepted this host. */
	onOpen?: (route: RoomRoute) => void;
	/** A guest of the room came or went (`peer-joined` / `peer-left`); the peer id is already the companion-wide one. */
	onControl?: (message: RelayControlMessage, route: RoomRoute) => void;
	onFrame?: (frame: In, fromPeer: number) => void;
	/** A relay closed this host; `willReconnect` is false when the socket gave up. */
	onClose?: (route: RoomRoute, reason: string, willReconnect: boolean) => void;

	readonly #public: CollabSocket<Out, In>;
	readonly #local: CollabSocket<Out, In> | null;

	constructor(options: RoomHostOptions) {
		this.#public = this.#attach(
			new CollabSocket<Out, In>({
				wsUrl: options.publicUrl,
				role: "host",
				key: options.key,
				...(options.proxy ? { proxy: options.proxy } : {}),
			}),
			"public",
		);
		this.#local =
			options.localUrl === undefined
				? null
				: this.#attach(
						new CollabSocket<Out, In>({ wsUrl: options.localUrl, role: "host", key: options.key }),
						"local",
					);
	}

	#attach(socket: CollabSocket<Out, In>, route: RoomRoute): CollabSocket<Out, In> {
		const offset = route === "local" ? LOCAL_PEER_BASE : 0;
		socket.onOpen = () => this.onOpen?.(route);
		socket.onFrame = (frame, fromPeer) => this.onFrame?.(frame, fromPeer + offset);
		socket.onControl = message => {
			this.onControl?.("peer" in message ? { ...message, peer: message.peer + offset } : message, route);
		};
		socket.onClose = (reason, willReconnect) => this.onClose?.(route, reason, willReconnect);
		return socket;
	}

	/** Which relay a peer id belongs to. */
	static routeOf(peer: number): RoomRoute {
		return peer >= LOCAL_PEER_BASE ? "local" : "public";
	}

	connect(route?: RoomRoute): void {
		if (route !== "local") this.#public.connect();
		if (route !== "public") this.#local?.connect();
	}

	/** To `targetPeer`, or to every guest on every relay when 0. `compress` only where that peer said it opens compressed frames. */
	send(frame: Out, targetPeer = 0, compress = false): void {
		if (targetPeer === 0) {
			this.#public.send(frame, 0, compress);
			this.#local?.send(frame, 0, compress);
		} else if (targetPeer >= LOCAL_PEER_BASE) {
			this.#local?.send(frame, targetPeer - LOCAL_PEER_BASE, compress);
		} else {
			this.#public.send(frame, targetPeer, compress);
		}
	}

	close(): void {
		this.#public.close();
		this.#local?.close();
	}
}
