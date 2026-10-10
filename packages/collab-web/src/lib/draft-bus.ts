/**
 * Putting text into a room's message box from outside its composer (the Fix-it flow). A mounted
 * session shows the text at once through its subscription; for a room not on screen the text joins
 * the saved draft, which the composer loads when that room opens. Nothing is ever sent from here.
 */

import { loadDraft, saveDraft } from "./rooms";

/** Shows `text` in the room's composer; false when no composer is there to take it. */
type Listener = (text: string) => boolean;

/** The composer of each mounted room that listens, by room id. */
const listeners: Record<string, Listener> = {};

/** Route drafts for `roomId` to `listener` while it is mounted; returns the unsubscribe function. */
export function subscribeDraft(roomId: string, listener: Listener): () => void {
	listeners[roomId] = listener;
	return () => {
		if (listeners[roomId] === listener) delete listeners[roomId];
	};
}

/** Add `text` to the draft of `roomId` after a blank line when there already is one, as the composer's own insert does. */
export function deliverDraft(roomId: string, text: string): void {
	if (Object.hasOwn(listeners, roomId) && listeners[roomId]!(text)) return;
	const existing = loadDraft(roomId);
	saveDraft(roomId, existing.trim() ? `${existing.replace(/\s+$/, "")}\n\n${text}` : text);
}
