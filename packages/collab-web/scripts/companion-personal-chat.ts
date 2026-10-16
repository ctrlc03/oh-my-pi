/**
 * The companion's side of the Personal agent's chat-tree memory mode (docs/personal-chat-tree.md). The session owns
 * the chat under `<profile agent dir>/personal-chat/`; the companion only reads two things from it, the numbers in
 * `status.json` and whether the log holds a message yet, and hands the stored handoff note over once.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonalChatTreeStatus } from "@oh-my-pi/pi-wire/personal";
import { MAX_EVENT_BODY_CHARS } from "@oh-my-pi/pi-wire/personal-ipc";
import type { PersonalPaths } from "./companion-personal-store";

/** The `control` body that makes the session log the rest of the body as `note` messages (no turn). */
export const NOTE_CONTROL_PREFIX = "note\n";
/** One event carries at most this many characters of the note: the event body limit less the prefix. */
export const NOTE_CHUNK_CHARS = MAX_EVENT_BODY_CHARS - NOTE_CONTROL_PREFIX.length;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The chat's numbers as the session last wrote them (`status.json`); null when the file is missing or damaged. */
export async function readChatTreeStatus(
	paths: Pick<PersonalPaths, "chatStatusFile">,
): Promise<PersonalChatTreeStatus | null> {
	let raw: unknown;
	try {
		raw = JSON.parse(await Bun.file(paths.chatStatusFile).text());
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { messages, nodesPending, viewBytes, compactionsFailed } = raw as Record<string, unknown>;
	if (!isCount(messages) || !isCount(nodesPending) || !isCount(viewBytes) || !isCount(compactionsFailed)) return null;
	return { messages, nodesPending, viewBytes, compactionsFailed };
}

/** The chat already holds a message: a first start has nothing to import. */
export async function chatHasMessages(paths: Pick<PersonalPaths, "chatDir">): Promise<boolean> {
	const dir = path.join(paths.chatDir, "main");
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return false;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		try {
			if ((await fs.stat(path.join(dir, name))).size > 0) return true;
		} catch {
			// removed between the listing and the stat
		}
	}
	return false;
}

/** `note` cut into pieces of at most {@link NOTE_CHUNK_CHARS} characters, in order, never inside a surrogate pair. */
export function noteChunks(note: string): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < note.length) {
		let end = Math.min(start + NOTE_CHUNK_CHARS, note.length);
		if (end < note.length) {
			const last = note.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		}
		chunks.push(note.slice(start, end));
		start = end;
	}
	return chunks;
}
