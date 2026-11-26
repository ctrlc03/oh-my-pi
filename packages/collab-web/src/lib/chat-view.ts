/**
 * The transcript view a session opens in, kept per device: chat (prompts and replies, tool runs folded) or the
 * full transcript. Without a choice, every screen starts in chat view.
 * A session's own toggle (⋯ → View, the `v` key) changes only that session until it is left.
 */

import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

const CHAT_KEY = "omp.collab.chat";

let stored: boolean | null | undefined;
const listeners = new Set<() => void>();

/** Whether new sessions open in chat view. */
export function defaultChat(): boolean {
	if (stored === undefined) {
		const raw = readJson(CHAT_KEY);
		stored = typeof raw === "boolean" ? raw : null;
	}
	return stored ?? true;
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
		() => true,
	);
}

const AGENT_MESSAGES_KEY = "omp.collab.chat-agent-messages";

let agentMessagesStored: boolean | undefined;
const agentMessagesListeners = new Set<() => void>();

/**
 * Whether the chat view shows messages between agents (subagents reporting, peers, work pools) as one-line cards.
 * Kept per device; shown unless turned off. The full view always shows them.
 */
export function agentMessagesInChat(): boolean {
	if (agentMessagesStored === undefined) {
		const raw = readJson(AGENT_MESSAGES_KEY);
		agentMessagesStored = typeof raw === "boolean" ? raw : true;
	}
	return agentMessagesStored;
}

export function setAgentMessagesInChat(show: boolean): void {
	agentMessagesStored = show;
	writeJson(AGENT_MESSAGES_KEY, show);
	for (const listener of agentMessagesListeners) listener();
}

/** {@link agentMessagesInChat}; re-renders when it changes. */
export function useAgentMessagesInChat(): boolean {
	return useSyncExternalStore(
		listener => {
			agentMessagesListeners.add(listener);
			return () => agentMessagesListeners.delete(listener);
		},
		agentMessagesInChat,
		() => true,
	);
}
