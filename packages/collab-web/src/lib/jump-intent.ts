/**
 * "Open this session and scroll to this entry", handed from where a message was found (the
 * all-sessions search) to the session screen. It lives outside React state because opening
 * another session remounts the screen that would hold it. It applies once, to the session it
 * names, and only soon after it was asked for: a join that never finished must not scroll some
 * later visit to that session.
 */

export interface JumpIntent {
	sessionId: string;
	entryId: string;
}

/** Resuming a session waits up to 45 s for it to appear; the join follows. */
const INTENT_TTL_MS = 2 * 60 * 1000;

let pending: (JumpIntent & { at: number }) | null = null;
const listeners: (() => void)[] = [];

/** Record where to jump (or cancel with null, when opening the session failed) and tell a session screen already showing it. */
export function setJumpIntent(intent: JumpIntent | null): void {
	pending = intent === null ? null : { ...intent, at: Date.now() };
	// A copy: a listener may unsubscribe while being told.
	for (const listener of listeners.slice()) listener();
}

/** The entry to jump to in `sessionId`, if one is waiting for it; taking it clears it. */
export function takeJumpIntent(sessionId: string): string | null {
	if (pending?.sessionId !== sessionId) return null;
	const { entryId, at } = pending;
	pending = null;
	return Date.now() - at <= INTENT_TTL_MS ? entryId : null;
}

/** Call `listener` whenever an intent is set; returns the unsubscribe. */
export function onJumpIntent(listener: () => void): () => void {
	listeners.push(listener);
	return () => {
		const at = listeners.indexOf(listener);
		if (at >= 0) listeners.splice(at, 1);
	};
}
