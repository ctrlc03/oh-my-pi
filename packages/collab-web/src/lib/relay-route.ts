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
