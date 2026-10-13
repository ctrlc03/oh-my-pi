/**
 * The relay the companion runs on this computer's loopback interface so that omp sessions it
 * starts are also reachable at `ws://127.0.0.1:<port>`: the app on this same computer joins
 * them there instead of through the public relay (see `collab.localRelayUrl` in omp, and
 * `src/lib/relay-route.ts` for the app side). The relay is content-blind like the public one. It also serves
 * the web app itself on the same port (`./local-app`), so the page and its websockets share an origin.
 */
import { normalizeLocalRelayUrl } from "../src/lib/link";
import { type LocalRelay, type LocalRelayOptions, startLocalRelay } from "./local-relay";

/** Port tried first. Hand-started sessions point `collab.localRelayUrl` here. */
export const COMPANION_RELAY_PORT = 7467;
/** Consecutive ports tried from the preferred one before the operating system picks. */
const PORT_ATTEMPTS = 10;

export interface CompanionRelay {
	relay: LocalRelay;
	/** `ws://127.0.0.1:<port>`: the value for `collab.localRelayUrl`. */
	url: string;
}

/** The port of the user's own `collab.localRelayUrl`, so hand-started sessions land on this relay; the default otherwise. */
export function preferredRelayPort(configured: string): number {
	const normalized = normalizeLocalRelayUrl(configured);
	return normalized === null ? COMPANION_RELAY_PORT : Number(new URL(normalized).port);
}

/**
 * Start the relay on `preferredPort`, the next free port after it when that one is taken (another
 * companion, the mock relay), or a port the operating system picks. Throws for any failure that is
 * not a port being in use.
 */
export function startCompanionRelay(options: {
	preferredPort?: number;
	allowedOrigins?: readonly string[];
	/** Serves the web app on the relay's port; see `LocalRelayOptions.app`. */
	app?: LocalRelayOptions["app"];
}): CompanionRelay {
	const first = options.preferredPort ?? COMPANION_RELAY_PORT;
	const ports = Array.from({ length: PORT_ATTEMPTS }, (_, i) => first + i).filter(port => port <= 65_535);
	for (const port of [...ports, 0]) {
		try {
			const relay = startLocalRelay(port, {
				allowedOrigins: options.allowedOrigins,
				refuseMissingRooms: true,
				app: options.app,
			});
			return { relay, url: relay.url };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
		}
	}
	throw new Error("no free port for the companion's local relay");
}
