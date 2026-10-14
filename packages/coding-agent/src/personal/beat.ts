/**
 * The Personal session's heartbeat: `<run dir>/beat.json` (`PersonalBeat`), refreshed every `PERSONAL_BEAT_MS`
 * and when the session's state changes. The companion reads it to tell a live session from the stale claim of a
 * dead one, to know whether the session waits for the owner, and whether a spend limit stopped it. The file is
 * replaced atomically (temp file and rename) so a reader never sees half of it; a session that exits cleanly
 * removes its own beat.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { PERSONAL_BEAT_MS, type PersonalBeat } from "@oh-my-pi/pi-wire/personal-ipc";

export const BEAT_FILE = "beat.json";

export interface BeatSource {
	sessionId(): string;
	busy(): boolean;
	inputRequired(): boolean;
	capped(): "day" | "month" | undefined;
}

export class PersonalBeatWriter {
	readonly #file: string;
	readonly #source: BeatSource;
	readonly #now: () => number;
	#timer: ReturnType<typeof setInterval> | undefined;
	#writing: Promise<void> = Promise.resolve();
	#stopped = false;
	/** Session id of the last beat written: a beat only ever removes itself. */
	#lastSessionId: string | undefined;

	constructor(runDir: string, source: BeatSource, now: () => number = Date.now) {
		this.#file = path.join(runDir, BEAT_FILE);
		this.#source = source;
		this.#now = now;
	}

	/** Write the first beat now and keep beating. */
	start(): void {
		this.beat();
		this.#timer = setInterval(() => this.beat(), PERSONAL_BEAT_MS);
		this.#timer.unref();
	}

	/** Write a beat now (queued behind one in flight, so beats land in order). */
	beat(): void {
		if (this.#stopped) return;
		const capped = this.#source.capped();
		const beat: PersonalBeat = {
			sessionId: this.#source.sessionId(),
			pid: process.pid,
			at: this.#now(),
			busy: this.#source.busy(),
			inputRequired: this.#source.inputRequired(),
			...(capped ? { capped } : {}),
		};
		this.#lastSessionId = beat.sessionId;
		this.#writing = this.#writing.then(() => this.#write(beat)).catch(() => {});
	}

	async #write(beat: PersonalBeat): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
			const temp = `${this.#file}.${process.pid}.tmp`;
			await Bun.write(temp, `${JSON.stringify(beat)}\n`);
			await fs.rename(temp, this.#file);
		} catch (error) {
			logger.warn("personal heartbeat failed", { error: String(error) });
		}
	}

	/** Stop beating and remove this session's beat (another session's is left alone). */
	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#timer);
		this.#timer = undefined;
		await this.#writing;
		const ours = this.#lastSessionId;
		if (ours === undefined) return;
		try {
			const current: unknown = JSON.parse(await Bun.file(this.#file).text());
			if (typeof current === "object" && current !== null && "sessionId" in current && current.sessionId === ours) {
				await fs.rm(this.#file, { force: true });
			}
		} catch {
			// Already gone, or not ours to read.
		}
	}
}
