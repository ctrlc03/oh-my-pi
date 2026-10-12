/**
 * The name other participants see, kept per device. Stored as the bare string (not JSON) so names saved by earlier
 * versions keep working; a session reads it when this device joins.
 */

import { useSyncExternalStore } from "react";

const NAME_KEY = "omp.collab.name";
export const DEFAULT_NAME = "guest";
export const MAX_NAME_CHARS = 32;

let name: string | undefined;
const listeners = new Set<() => void>();

export function displayName(): string {
	if (name === undefined) {
		try {
			name = localStorage.getItem(NAME_KEY) ?? DEFAULT_NAME;
		} catch {
			name = DEFAULT_NAME;
		}
	}
	return name;
}

/** Saves `next` trimmed; an empty name goes back to the default. */
export function setDisplayName(next: string): void {
	name = next.trim().slice(0, MAX_NAME_CHARS) || DEFAULT_NAME;
	try {
		if (name === DEFAULT_NAME) localStorage.removeItem(NAME_KEY);
		else localStorage.setItem(NAME_KEY, name);
	} catch {
		// storage unavailable (private mode): the name still holds for this launch
	}
	for (const listener of listeners) listener();
}

/** The name; re-renders when it changes. */
export function useDisplayName(): string {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		displayName,
		() => DEFAULT_NAME,
	);
}
