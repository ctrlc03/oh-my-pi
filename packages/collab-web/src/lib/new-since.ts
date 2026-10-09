/**
 * "New since you left": remembers, per room, the newest transcript entry the
 * reader saw, and on the next join marks what arrived after it.
 */

import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GuestClient } from "./client";
import { loadSeen, saveSeen } from "./rooms";

export interface NewSince {
	/** Ids of every entry after the last one the reader saw. */
	ids: ReadonlySet<string>;
	/** Entries worth announcing: prompts, replies, and displayed custom messages. */
	count: number;
}

/**
 * Entries after `seenId`, or null when nothing newer exists, the entry is gone
 * (compaction, a rewritten branch), or none of the newer entries is readable.
 */
export function newSinceLeft(entries: readonly SessionEntry[], seenId: string | null): NewSince | null {
	if (seenId === null) return null;
	const at = entries.findLastIndex(entry => entry.id === seenId);
	if (at < 0) return null;
	const ids = new Set<string>();
	let count = 0;
	for (const entry of entries.slice(at + 1)) {
		ids.add(entry.id);
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) count++;
		else if (entry.type === "custom_message" && (entry.customType === "collab-prompt" || entry.display)) count++;
	}
	return count > 0 ? { ids, count } : null;
}

export interface NewSinceControl {
	/** Set once per join, when the snapshot first goes live; null when nothing is new. */
	newSince: NewSince | null;
	/** The reader reached the divider: the "N new" pill goes away, the divider stays. */
	seen: boolean;
	markSeen(): void;
	/** The reader is at the tail: `entryId` is the newest entry they have seen. */
	markTail(entryId: string): void;
}

/**
 * The divider is computed once per join (per `client`) from the entry the reader
 * last saw. The seen pointer advances only through `markTail`, and is written to
 * storage when the page is hidden or the session is left.
 */
export function useNewSince(
	client: GuestClient,
	roomId: string | null,
	entries: readonly SessionEntry[],
	live: boolean,
): NewSinceControl {
	const seenRef = useRef<string | null>(roomId === null ? null : loadSeen(roomId));
	const [join, setJoin] = useState<{ client: GuestClient; newSince: NewSince | null; seen: boolean } | null>(null);

	// Derived during render (before any child effect advances the pointer to the tail).
	if (live && join?.client !== client) {
		setJoin({ client, newSince: newSinceLeft(entries, seenRef.current), seen: false });
	}

	const markTail = useCallback((entryId: string): void => {
		seenRef.current = entryId;
	}, []);
	const markSeen = useCallback((): void => setJoin(prev => (prev === null ? prev : { ...prev, seen: true })), []);

	useEffect(() => {
		if (roomId === null) return;
		const persist = (): void => {
			if (seenRef.current !== null) saveSeen(roomId, seenRef.current);
		};
		const onVisibility = (): void => {
			if (document.visibilityState === "hidden") persist();
		};
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("pagehide", persist);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", persist);
			persist();
		};
	}, [roomId]);

	return { newSince: join?.newSince ?? null, seen: join?.seen ?? false, markSeen, markTail };
}
