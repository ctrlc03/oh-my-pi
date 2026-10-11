/**
 * The session's end of the files it shares with the collab companion (layout in `PrWatchFile`'s doc
 * in the wire package): it publishes its watches there, reads what the companion polled for it, and
 * tells whether a companion is polling at all.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import {
	PR_COMPANION_FRESH_MS,
	type PrInboxEntry,
	type PrWatchFile,
	parsePrInboxEntry,
} from "@oh-my-pi/pi-wire/pr-watch";

/** Directory the files live in; the companion derives the same path from its config directory. */
export function defaultPrWatchDir(): string {
	return path.join(getBaseConfigRoot(), "run", "pr-watch");
}

/** Session ids are file names here; anything else is refused. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await Bun.file(file).text());
	} catch (error) {
		if (isEnoent(error) || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export class PrWatchStore {
	readonly dir: string;

	constructor(dir: string = defaultPrWatchDir()) {
		this.dir = dir;
	}

	#watchFile(sessionId: string): string {
		if (!SAFE_NAME.test(sessionId)) throw new Error("invalid session id");
		return path.join(this.dir, "watches", `${sessionId}.json`);
	}

	#inboxDir(sessionId: string): string {
		if (!SAFE_NAME.test(sessionId)) throw new Error("invalid session id");
		return path.join(this.dir, "inbox", sessionId);
	}

	/** Publish the session's watches for the companion; an empty list removes the file. */
	async publish(file: PrWatchFile): Promise<void> {
		const target = this.#watchFile(file.sessionId);
		if (file.prs.length === 0) {
			await this.retire(file.sessionId);
			return;
		}
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		const temp = `${target}.${process.pid}.tmp`;
		await Bun.write(temp, `${JSON.stringify(file)}\n`);
		await fs.rename(temp, target);
	}

	/** Tell the companion the session is alive: it ignores watch files nobody refreshes. */
	async touch(sessionId: string): Promise<void> {
		const now = new Date();
		await fs.utimes(this.#watchFile(sessionId), now, now).catch(error => {
			if (!isEnoent(error)) throw error;
		});
	}

	/** Remove the session's watches and anything the companion left for it. */
	async retire(sessionId: string): Promise<void> {
		await fs.rm(this.#watchFile(sessionId), { force: true });
		await fs.rm(this.#inboxDir(sessionId), { recursive: true, force: true });
	}

	/** What the companion polled for the session since the last call; each reading is consumed. */
	async drain(sessionId: string): Promise<PrInboxEntry[]> {
		const dir = this.#inboxDir(sessionId);
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const entries: PrInboxEntry[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(dir, name);
			const entry = parsePrInboxEntry(await readJson(file));
			await fs.rm(file, { force: true });
			if (entry) entries.push(entry);
		}
		return entries.sort((a, b) => a.at - b.at);
	}

	/** Whether a companion has polled recently. */
	async companionActive(now: number): Promise<boolean> {
		const beat = await readJson(path.join(this.dir, "companion.json"));
		if (typeof beat !== "object" || beat === null || !("at" in beat) || typeof beat.at !== "number") return false;
		return now - beat.at < PR_COMPANION_FRESH_MS;
	}
}
