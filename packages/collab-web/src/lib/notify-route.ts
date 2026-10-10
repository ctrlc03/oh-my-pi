/**
 * Where a notification tap sends the app. The service worker (scripts/build-sw.ts) either posts
 * a message to an open window or launches a new one with the route in the URL hash:
 *
 * - `open:<instanceId>` opens that session; `open:<instanceId>&reply=<urlencoded text>` also sends
 *   the text once it is live (the inline reply typed in the notification).
 * - any other `<name>:<rest>` (such as `fix:<owner/repo>/<number>`) is handed to whichever
 *   component subscribed to it through {@link subscribeRoute}; the app ignores routes nobody owns.
 */
import { parseCollabLink } from "./link";

export const OPEN_PREFIX = "open:";
const REPLY_MARK = "&reply=";
/** `name:` followed by something; the name is lowercase words, as in the routes above. */
const ROUTE_RE = /^[a-z][a-z0-9-]*:./;

export type NotifyRoute = { kind: "open"; instanceId: string; reply: string | null } | { kind: "route"; route: string };

/** The route a URL hash (without its `#`) names, or null when it is a collab link or empty. */
export function parseRoute(hash: string): NotifyRoute | null {
	if (hash.startsWith(OPEN_PREFIX)) {
		const rest = hash.slice(OPEN_PREFIX.length);
		const mark = rest.indexOf(REPLY_MARK);
		const instanceId = mark < 0 ? rest : rest.slice(0, mark);
		if (!instanceId) return null;
		let reply: string | null = null;
		if (mark >= 0) {
			try {
				reply = decodeURIComponent(rest.slice(mark + REPLY_MARK.length));
			} catch {
				reply = null;
			}
		}
		return { kind: "open", instanceId, reply: reply?.trim() ? reply : null };
	}
	if (!ROUTE_RE.test(hash) || !("error" in parseCollabLink(hash))) return null;
	return { kind: "route", route: hash };
}

type Listener = (route: string) => void;
const listeners: Listener[] = [];
/** A route emitted before anyone subscribed (a cold launch): replayed to the first subscriber. */
let pending: string | null = null;

/** Deliver `route` to subscribers; with none yet, hold it for the first one. */
export function emitRoute(route: string): void {
	if (listeners.length === 0) {
		pending = route;
		return;
	}
	// A copy: a listener may unsubscribe while being told.
	for (const listener of listeners.slice()) listener(route);
}

/** Receive routes (replaying one that arrived early); returns the unsubscribe function. */
export function subscribeRoute(listener: Listener): () => void {
	listeners.push(listener);
	if (pending !== null) {
		const route = pending;
		pending = null;
		listener(route);
	}
	return () => {
		const at = listeners.indexOf(listener);
		if (at >= 0) listeners.splice(at, 1);
	};
}
