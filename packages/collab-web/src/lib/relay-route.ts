/**
 * Which relay a guest tries first. A link may name a second relay on the host's machine
 * (`?local=127.0.0.1:<port>`, see `link.ts`); the app on that same machine reaches it over
 * loopback and skips the public relay's round trip. Everyone else must pay nothing for it:
 *
 * - touch devices (phones, tablets) never try: they are not the host's machine;
 * - a refused or silent attempt is abandoned after {@link LOCAL_CONNECT_TIMEOUT_MS} (a loopback
 *   connection that works opens in milliseconds), and the public relay is used at once;
 * - a relay that failed is left alone for {@link LOCAL_RELAY_COOLDOWN_MS}, so a computer that is
 *   not the host's pays one failed attempt a minute rather than one per reconnect.
 *
 * Browser limits (mixed content: an https page opening `ws://127.0.0.1`) surface as a failed
 * attempt and take the same path: Chromium and Firefox allow loopback, Safari refuses it.
 *
 * A page the companion itself serves (`http://127.0.0.1:<port>`, see `scripts/local-app.ts`) knows more: it came
 * from that computer's loopback relay, so every room is tried there first, whether or not its link names a local
 * relay, and being a touch device does not matter. It is `http`, so Safari opens the same loopback sockets too; a
 * room the relay does not hold, or a relay that is gone, falls back to the public relay as above.
 */

/** A local attempt that has not opened by then yields to the public relay. */
export const LOCAL_CONNECT_TIMEOUT_MS = 1_200;
/** How long a failed local relay (or room) is not tried again. */
export const LOCAL_RELAY_COOLDOWN_MS = 60_000;

/** `relay`: nothing usable answered at that address. `room`: the relay answered but does not hold this room. */
export type LocalFailure = "relay" | "room";

export class LocalRelayHealth {
	/** Cooldown end per relay host (`relay:<host:port>`) and per room URL (`room:<url>`). */
	readonly #downUntil: Record<string, number> = {};

	markDown(localWsUrl: string, failure: LocalFailure, now: number): void {
		this.#downUntil[keyFor(localWsUrl, failure)] = now + LOCAL_RELAY_COOLDOWN_MS;
	}

	isDown(localWsUrl: string, now: number): boolean {
		return this.#isDown(keyFor(localWsUrl, "relay"), now) || this.#isDown(keyFor(localWsUrl, "room"), now);
	}

	#isDown(key: string, now: number): boolean {
		return Object.hasOwn(this.#downUntil, key) && now < this.#downUntil[key]!;
	}
}

function keyFor(localWsUrl: string, failure: LocalFailure): string {
	return failure === "relay" ? `relay:${new URL(localWsUrl).host}` : `room:${localWsUrl}`;
}

/** Shared by every socket in the page: what one session learns about the local relay, the next one uses. */
export const localRelayHealth = new LocalRelayHealth();

/**
 * The local relay URL to try before the public one, or null to go straight to the public relay.
 * `touch` is true on a device that cannot be the host's machine.
 */
export function localRelayToTry(
	localWsUrl: string | undefined,
	touch: boolean,
	health: LocalRelayHealth,
	now: number,
): string | null {
	if (localWsUrl === undefined || touch || health.isDown(localWsUrl, now)) return null;
	return localWsUrl;
}

/**
 * The relay a page was served from, `ws://<host:port>`, when that is this computer's loopback relay: an `http` page on
 * `127.0.0.1` or `localhost`. Null for every other page (Pages, a LAN address, `https`).
 */
export function servedRelay(page: { protocol: string; hostname: string; host: string }): string | null {
	if (page.protocol !== "http:" || (page.hostname !== "127.0.0.1" && page.hostname !== "localhost")) return null;
	return `ws://${page.host}`;
}

/**
 * {@link servedRelay} of this page; null outside a browser and in development, where `localhost` is the dev server
 * (which holds no rooms) and the page only needs the relays its links name.
 */
export function pageRelay(): string | null {
	return typeof location === "undefined" || process.env.NODE_ENV !== "production" ? null : servedRelay(location);
}

/**
 * The room `wsUrl` (`wss://relay/r/<roomId>`) on the relay this page was served from, or undefined when the page was not
 * served by one.
 */
export function servedRoomUrl(wsUrl: string, relay: string | null = pageRelay()): string | undefined {
	return relay === null ? undefined : `${relay}${new URL(wsUrl).pathname}`;
}

/** Who serves this page, for the About screen: this computer (the companion's loopback relay), GitHub Pages, or the host name. */
export function servedByLabel(page: { protocol: string; hostname: string; host: string }): string {
	if (servedRelay(page) !== null) return "This computer";
	return page.hostname.endsWith(".github.io") ? "GitHub Pages" : page.host;
}
