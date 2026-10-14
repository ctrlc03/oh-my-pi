/**
 * Where a notification tap sends the app. The service worker (scripts/build-sw.ts) either posts
 * a message to an open window or launches a new one with the route in the URL hash:
 *
 * - `open:<instanceId>` opens that session; `open:<instanceId>&reply=<urlencoded text>` also sends
 *   the text once it is live (the inline reply typed in the notification).
 * - any other `<name>:<rest>` (such as `fix:<owner/repo>/<number>`) is handed to whichever
 *   component subscribed to it through {@link subscribeRoute}; the app ignores routes nobody owns.
 *
 * Instance ids are only unique per computer, so a route names its computer when it knows it: the companion
 * puts its room id in every push, and the worker appends `&computer=<id>` (before any `&reply=`). A route
 * without one (a push from a companion that predates the field) opens on whichever computer lists the session.
 */
import { parseCollabLink } from "./link";

export const OPEN_PREFIX = "open:";
const REPLY_MARK = "&reply=";
const COMPUTER_MARK = "&computer=";
/** `name:` followed by something (the name is lowercase words, as in the routes above), or a Personal route (`personal`, `personal/inbox`; see PERSONAL_ROUTES), which has no colon. */
const ROUTE_RE = /^(?:[a-z][a-z0-9-]*:.|personal(?:\/[a-z]+)?(?:&|$))/;

export type NotifyRoute =
	| { kind: "open"; instanceId: string; computerId: string | null; reply: string | null }
	| { kind: "route"; route: string; computerId: string | null };

/** `text` without a trailing `&computer=<id>`, and that id. */
function splitComputer(text: string): { rest: string; computerId: string | null } {
	const at = text.lastIndexOf(COMPUTER_MARK);
	if (at < 0) return { rest: text, computerId: null };
	const computerId = text.slice(at + COMPUTER_MARK.length);
	return { rest: text.slice(0, at), computerId: computerId === "" ? null : computerId };
}

/** The route a URL hash (without its `#`) names, or null when it is a collab link or empty. */
export function parseRoute(hash: string): NotifyRoute | null {
	if (hash.startsWith(OPEN_PREFIX)) {
		const rest = hash.slice(OPEN_PREFIX.length);
		const mark = rest.indexOf(REPLY_MARK);
		const { rest: instanceId, computerId } = splitComputer(mark < 0 ? rest : rest.slice(0, mark));
		if (!instanceId) return null;
		let reply: string | null = null;
		if (mark >= 0) {
			try {
				reply = decodeURIComponent(rest.slice(mark + REPLY_MARK.length));
			} catch {
				reply = null;
			}
		}
		return { kind: "open", instanceId, computerId, reply: reply?.trim() ? reply : null };
	}
	if (!ROUTE_RE.test(hash) || !("error" in parseCollabLink(hash))) return null;
	const { rest, computerId } = splitComputer(hash);
	return { kind: "route", route: rest, computerId };
}

type Listener = (route: string, computerId: string | null) => void;
const listeners: Listener[] = [];
/** A route emitted before anyone subscribed (a cold launch): replayed to the first subscriber. */
let pending: { route: string; computerId: string | null } | null = null;

/** Deliver `route` (and the computer it belongs to, when known) to subscribers; with none yet, hold it for the first one. */
export function emitRoute(route: string, computerId: string | null = null): void {
	if (listeners.length === 0) {
		pending = { route, computerId };
		return;
	}
	// A copy: a listener may unsubscribe while being told.
	for (const listener of listeners.slice()) listener(route, computerId);
}

/** Receive routes (replaying one that arrived early); returns the unsubscribe function. */
export function subscribeRoute(listener: Listener): () => void {
	listeners.push(listener);
	if (pending !== null) {
		const early = pending;
		pending = null;
		listener(early.route, early.computerId);
	}
	return () => {
		const at = listeners.indexOf(listener);
		if (at >= 0) listeners.splice(at, 1);
	};
}
