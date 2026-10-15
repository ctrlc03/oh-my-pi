/**
 * Keeps a session's transcript honest about its high-stakes mode. The companion publishes one state file per
 * checkout; this watch reads it every couple of seconds and when the session goes idle, and when the mode differs from
 * the one the session last recorded it writes a visible marker ("High-stakes mode was turned off by <device>…") and
 * records the new mode as a session entry. The recorded mode starts as the latest entry of the branch (off when none),
 * so a session resumed after the mode changed while it was not running writes the marker once, and an unchanged mode
 * writes nothing. The marker is the audit trail of turning the mode off; the gate itself reads the file on every call.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { STAKES_ENTRY_TYPE, STAKES_MARKER_TYPE, type StakesState } from "@oh-my-pi/pi-wire/stakes";
import type { SessionEntry } from "../session/session-entries";
import { StakesFileReader } from "./state";

export { STAKES_ENTRY_TYPE, STAKES_MARKER_TYPE };

const POLL_MS = 2_000;

/** What the marker message carries in `details`. */
export interface StakesMarkerDetails {
	on: boolean;
	/** Who changed the mode (a device name); empty when unknown. */
	by: string;
	/** The state file's revision that was read. */
	rev: number;
}

/** What the watch needs of the session it serves. */
export interface HighStakesWatchHost {
	/** The session's working folder (the checkout whose state file is read). */
	cwd(): string;
	/** The agent directory the companion publishes into. */
	agentDir(): string;
	/** The session may append a message now: it is not disposed or switching sessions. */
	canWrite(): boolean;
	/** The mode the latest {@link STAKES_ENTRY_TYPE} entry of the branch recorded; false when there is none. */
	recorded(): boolean;
	/** Append the visible marker to the transcript; it must not start a turn. */
	announce(text: string, details: StakesMarkerDetails): Promise<void>;
	/** Persist the mode as a session entry. */
	record(on: boolean): void;
}

export interface HighStakesWatchTimers {
	setInterval(handler: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface HighStakesWatchOptions {
	host: HighStakesWatchHost;
	pollMs?: number;
	/** Timer seam, for tests; the real timer is `unref`ed so it never keeps the process alive. */
	timers?: HighStakesWatchTimers;
	/** The state of the session's checkout; null when there is none. Defaults to a cached file reader. */
	read?: (cwd: string, agentDir: string) => StakesState | null;
}

/** The mode recorded by the latest {@link STAKES_ENTRY_TYPE} entry in `entries` (a branch, root first); off when none. */
export function readRecordedStakesMode(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== STAKES_ENTRY_TYPE || !isRecord(entry.data)) continue;
		return entry.data.on === true;
	}
	return false;
}

/** The marker's text for a mode change. */
export function stakesMarkerText(on: boolean, by: string): string {
	if (on) {
		return "High-stakes mode is on. Pushing and pull requests are blocked until the user passes a quiz on this session's changes; ask the user to take it in the collab app.";
	}
	return `High-stakes mode was turned off${by === "" ? "" : ` by ${by}`}. Pushes and pull requests are no longer blocked.`;
}

const realTimers: HighStakesWatchTimers = {
	setInterval: (handler, ms) => {
		const timer = setInterval(handler, ms);
		timer.unref();
		return timer;
	},
	clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
};

export class HighStakesWatch {
	readonly #host: HighStakesWatchHost;
	readonly #pollMs: number;
	readonly #timers: HighStakesWatchTimers;
	readonly #read: (cwd: string, agentDir: string) => StakesState | null;
	#timer: unknown;
	/** The mode this session last recorded; undefined until first needed (a session change forgets it). */
	#last: boolean | undefined;
	#busy = false;
	#disposed = false;

	constructor(options: HighStakesWatchOptions) {
		this.#host = options.host;
		this.#pollMs = options.pollMs ?? POLL_MS;
		this.#timers = options.timers ?? realTimers;
		const reader = new StakesFileReader();
		this.#read = options.read ?? ((cwd, agentDir) => reader.read(cwd, agentDir));
	}

	start(): void {
		if (this.#disposed || this.#timer !== undefined) return;
		this.#timer = this.#timers.setInterval(() => void this.check(), this.#pollMs);
	}

	/** The session switched to another one (new, resumed, branched): read the recorded mode again. */
	sessionChanged(): void {
		this.#last = undefined;
	}

	/** Read the state file once; write the marker and the entry when the mode changed. */
	async check(): Promise<void> {
		if (this.#disposed || this.#busy || !this.#host.canWrite()) return;
		const state = this.#read(this.#host.cwd(), this.#host.agentDir());
		const on = state?.on === true;
		this.#last ??= this.#host.recorded();
		if (on === this.#last) return;
		this.#busy = true;
		try {
			await this.#host.announce(stakesMarkerText(on, state?.by ?? ""), {
				on,
				by: state?.by ?? "",
				rev: state?.rev ?? 0,
			});
			this.#host.record(on);
			this.#last = on;
		} catch (error) {
			// Tried again on the next tick.
			logger.debug("High-stakes marker not written", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.#busy = false;
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== undefined) this.#timers.clearInterval(this.#timer);
		this.#timer = undefined;
	}
}
