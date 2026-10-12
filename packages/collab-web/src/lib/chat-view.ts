/**
 * The transcript view a session opens in, kept per device: chat (prompts and replies, tool runs folded) or the
 * full transcript. Without a choice, phones (≤640px) start in chat view and larger screens in the full transcript.
 * A session's own toggle (⋯ → View, the `v` key) changes only that session until it is left.
 */

import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

const CHAT_KEY = "omp.collab.chat";
const PHONE_QUERY = "(max-width: 640px)";

let stored: boolean | null | undefined;
const listeners = new Set<() => void>();

/** Whether new sessions open in chat view. */
export function defaultChat(): boolean {
	if (stored === undefined) {
		const raw = readJson(CHAT_KEY);
		stored = typeof raw === "boolean" ? raw : null;
	}
	return stored ?? matchMedia(PHONE_QUERY).matches;
}

export function setDefaultChat(chat: boolean): void {
	stored = chat;
	writeJson(CHAT_KEY, chat);
	for (const listener of listeners) listener();
}

/** The default; re-renders when it changes. */
export function useDefaultChat(): boolean {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		defaultChat,
		() => false,
	);
}
