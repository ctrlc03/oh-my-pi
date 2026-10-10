/**
 * "Screens" for the session: every image the agent's tools produced (browser
 * screenshots, generated images, image files it read), pulled from the tool
 * results in the transcript. Images the user attached to prompts are not
 * screens. Built from the transcript alone, like `collectChanges`.
 */

import type { SessionEntry, ToolCallContent } from "@oh-my-pi/pi-wire";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { executeXdevDispatch } from "../tool-render/ToolView";
import type { ToolResultImage } from "../tool-render/types";
import { isRecord, normalizeWs, resultImagesOf, str, truncate, withDetailImages } from "../tool-render/util";

export interface Screen {
	/** `<tool call id>:<index>`: stable while the transcript grows. */
	id: string;
	image: ToolResultImage;
	/** The tool that produced it; a `write xd://<tool>` device call is named by the device. */
	tool: string;
	/** What the agent said the call was for, else the call's main argument (URL, selector, path…). */
	label: string | null;
	/** Epoch milliseconds the result landed; null when the entry carries no valid time. */
	at: number | null;
	/** The entry holding the tool call: the transcript row to jump to. */
	entryId: string;
}

/** Arguments that say what a call acted on, most telling first. */
const MAIN_ARGS = ["url", "selector", "path", "file_path", "subject", "query", "prompt", "command"] as const;
const LABEL_MAX = 90;

function labelOf(call: ToolCallContent, args: Record<string, unknown>): string | null {
	const raw = isRecord(call.arguments) ? call.arguments : {};
	const intent = call.intent?.trim() || str(raw[INTENT_FIELD])?.trim();
	if (intent) return truncate(normalizeWs(intent), LABEL_MAX);
	for (const key of MAIN_ARGS) {
		const value = str(args[key])?.trim();
		if (value) return truncate(normalizeWs(value), LABEL_MAX);
	}
	return null;
}

/**
 * Screens of one tool result entry. Entries are immutable snapshots and a result
 * always follows its call, so the answer never changes: a rescan after a new
 * entry reuses it, and the `Screen` objects stay referentially stable.
 */
const perResult = new WeakMap<SessionEntry, Screen[]>();

function screensOf(entry: SessionEntry, owner: { call: ToolCallContent; entryId: string } | undefined): Screen[] {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
	const message = entry.message;
	const xdev = executeXdevDispatch(message.toolName, message);
	const result = xdev ? { content: message.content, details: xdev.inner, isError: message.isError } : message;
	const images = resultImagesOf(withDetailImages(result));
	if (images.length === 0) return [];
	const callArgs = owner?.call.arguments;
	const args = xdev?.args ?? (isRecord(callArgs) ? callArgs : {});
	const at = Date.parse(entry.timestamp);
	return images.map((image, i) => ({
		id: `${message.toolCallId}:${i}`,
		image,
		tool: xdev?.tool ?? message.toolName,
		label: owner ? labelOf(owner.call, args) : null,
		at: Number.isNaN(at) ? null : at,
		entryId: owner?.entryId ?? entry.id,
	}));
}

/** Every agent-produced image, oldest first. */
export function collectScreens(entries: readonly SessionEntry[]): Screen[] {
	const calls = new Map<string, { call: ToolCallContent; entryId: string }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall") calls.set(block.id, { call: block, entryId: entry.id });
		}
	}

	const screens: Screen[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		let found = perResult.get(entry);
		if (found === undefined) {
			found = screensOf(entry, calls.get(entry.message.toolCallId));
			perResult.set(entry, found);
		}
		screens.push(...found);
	}
	return screens;
}
