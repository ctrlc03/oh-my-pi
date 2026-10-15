/**
 * The messages the user hid from the chat, kept on the computer so every paired device shows the same ones (see
 * ../src/lib/hidden-messages). One document per session id, merged entry by entry with what a device sends, the
 * later action winning. Nothing here reaches a session: hiding changes what the app shows, never what the agent
 * remembers or what the session file holds. Persisted to a file private to the user (mode 0600).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	emptyHidden,
	type HiddenDoc,
	type HiddenStore,
	isHiddenKey,
	limitStore,
	mergeHidden,
	parseStore,
	pruneHidden,
	sameHidden,
} from "../src/lib/hidden-messages";

export interface HiddenFile {
	/** Counts changes to any document; devices fetch the open session's again when the number moves. */
	rev: number;
	sessions: HiddenStore;
}

export function parseHiddenFile(raw: unknown): HiddenFile {
	const rev = (raw as { rev?: unknown } | null)?.rev;
	return {
		rev: typeof rev === "number" && Number.isInteger(rev) && rev >= 0 ? rev : 0,
		sessions: parseStore(raw),
	};
}

export async function loadHiddenFile(file: string): Promise<HiddenFile> {
	try {
		return parseHiddenFile(JSON.parse(await Bun.file(file).text()));
	} catch {
		return { rev: 0, sessions: {} };
	}
}

export async function saveHiddenFile(file: string, contents: HiddenFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, `${JSON.stringify({ v: 1, ...contents }, null, "\t")}\n`, { mode: 0o600 });
	await fs.chmod(file, 0o600);
}

export interface HiddenMessagesOptions {
	now(): number;
	initial: HiddenFile;
	save(file: HiddenFile): Promise<void>;
	/** A device changed a document: tell the other devices (the revision moved). */
	onChange(): void;
}

export interface HiddenMessages {
	file(): HiddenFile;
	/** Merge a device's document of one session into the computer's; resolves with the result and the revision. */
	sync(sessionId: unknown, remote: HiddenDoc): Promise<{ doc: HiddenDoc; rev: number }>;
}

export function createHiddenMessages(options: HiddenMessagesOptions): HiddenMessages {
	let file = options.initial;
	let saving: Promise<void> = Promise.resolve();
	return {
		file: () => file,
		async sync(sessionId, remote) {
			if (!isHiddenKey(sessionId)) throw new Error("invalid session id");
			const current = Object.hasOwn(file.sessions, sessionId) ? file.sessions[sessionId]! : emptyHidden();
			const merged = pruneHidden(mergeHidden(current, remote), options.now());
			if (sameHidden(merged, current)) return { doc: current, rev: file.rev };
			const { [sessionId]: _old, ...rest } = file.sessions;
			const sessions =
				Object.keys(merged.entries).length === 0 ? rest : limitStore({ ...rest, [sessionId]: merged });
			file = { rev: file.rev + 1, sessions };
			const snapshot = file;
			saving = saving.catch(() => {}).then(() => options.save(snapshot));
			await saving;
			options.onChange();
			return { doc: merged, rev: snapshot.rev };
		},
	};
}
