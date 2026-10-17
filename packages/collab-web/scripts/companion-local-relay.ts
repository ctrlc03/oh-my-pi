/**
 * The relay the companion runs on this computer's loopback interface so that omp sessions it
 * starts are also reachable at `ws://127.0.0.1:<port>`: the app on this same computer joins
 * them there instead of through the public relay (see `collab.localRelayUrl` in omp, and
 * `src/lib/relay-route.ts` for the app side). The relay is content-blind like the public one. It also serves
 * the web app itself on the same port (`./local-app`), so the page and its websockets share an origin.
 */
import { normalizeLocalRelayUrl } from "../src/lib/link";
import { readLocalEndpoint } from "./companion-local-endpoint";
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

/**
 * The port the companion served on before: the one in its endpoint file (left by a crashed companion), else the one
 * its own overlay names (`collab.localRelayUrl` of `collab-companion-overlay.yml`, which sessions already running were
 * launched with and cannot be told to change; a clean exit removes the endpoint file but not the overlay). Null when
 * neither says, or the overlay's address is not a loopback one.
 */
export async function previousRelayPort(endpointFile: string, overlayFile: string): Promise<number | null> {
	const endpoint = await readLocalEndpoint(endpointFile);
	if (endpoint !== null) return endpoint.port;
	try {
		const overlay: unknown = Bun.YAML.parse(await Bun.file(overlayFile).text());
		if (typeof overlay !== "object" || overlay === null || !("collab" in overlay)) return null;
		const { collab } = overlay;
		if (typeof collab !== "object" || collab === null || !("localRelayUrl" in collab)) return null;
		const url = collab.localRelayUrl;
		const normalized = typeof url === "string" ? normalizeLocalRelayUrl(url) : null;
		return normalized === null ? null : Number(new URL(normalized).port);
	} catch {
		return null;
	}
}

/**
 * The port to try first, so sessions that remember the relay's address find it again: the port of the user's own
 * `collab.localRelayUrl` (hand-started sessions land on this relay), else `previous` (see {@link previousRelayPort}),
 * else the default.
 */
export function preferredRelayPort(configured: string, previous?: number | null): number {
	const normalized = normalizeLocalRelayUrl(configured);
	if (normalized !== null) return Number(new URL(normalized).port);
	return previous !== undefined && previous !== null && previous >= 1 && previous <= 65_535
		? previous
		: COMPANION_RELAY_PORT;
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
