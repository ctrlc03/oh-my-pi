/**
 * Where the hidden messages (see ./hidden-messages) are kept on this device: one document per session, all in one
 * key, the sessions changed most recently kept. With a paired computer that keeps them too, the document is also
 * synced through it; without one this is the only copy.
 */

import { type HiddenDoc, type HiddenStore, limitStore, mergeHidden, parseStore, pruneHidden } from "./hidden-messages";
import { readJson, writeJson } from "./storage";

const HIDDEN_KEY = "omp.collab.hidden";

function loadStore(): HiddenStore {
	return parseStore(readJson(HIDDEN_KEY));
}

export function loadHidden(sessionId: string): HiddenDoc {
	const store = loadStore();
	return Object.hasOwn(store, sessionId) ? store[sessionId]! : { entries: {} };
}

/**
 * Keep `doc` for the session, merged with what is stored (another tab may have changed it); resolves to what is kept.
 * An empty document removes the session.
 */
export function saveHidden(sessionId: string, doc: HiddenDoc, now: number): HiddenDoc {
	const store = loadStore();
	const stored = Object.hasOwn(store, sessionId) ? store[sessionId]! : { entries: {} };
	const merged = pruneHidden(mergeHidden(stored, doc), now);
	const { [sessionId]: _dropped, ...rest } = store;
	writeJson(HIDDEN_KEY, {
		v: 1,
		sessions: Object.keys(merged.entries).length === 0 ? rest : limitStore({ ...rest, [sessionId]: merged }),
	});
	return merged;
}
