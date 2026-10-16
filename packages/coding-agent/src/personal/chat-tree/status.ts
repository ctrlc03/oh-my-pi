/**
 * `status.json` of the chat-tree memory mode: the numbers of `ChatTreeStatus`, rewritten atomically (temp file and
 * rename in the same directory) at most once per interval so a reader never sees half of it and a busy compactor
 * does not hammer the disk. Updates in between are coalesced: the latest numbers always win.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { STATUS_MIN_INTERVAL_MS } from "./constants";
import type { ChatTreeStatus } from "./types";

export const CHAT_STATUS_FILE = "status.json";

type StatusNumbers = Omit<ChatTreeStatus, "updatedAt">;

const NUMBER_KEYS = ["messages", "nodesBuilt", "nodesPending", "viewBytes", "compactionsFailed"] as const;

function sameNumbers(a: StatusNumbers, b: StatusNumbers | undefined): boolean {
	return b !== undefined && NUMBER_KEYS.every(key => a[key] === b[key]);
}

let tempCounter = 0;

/** Writes status.json atomically, at most once per `minIntervalMs`, coalescing updates: the latest numbers win. */
export class ChatStatusWriter {
	readonly #file: string;
	readonly #minIntervalMs: number;
	readonly #now: () => Date;
	/** Numbers recorded and not yet taken for a write. */
	#pending: StatusNumbers | undefined;
	/** Numbers of the last write taken (undefined until the first one, and after a failed one). */
	#written: StatusNumbers | undefined;
	#lastWriteAt: number | undefined;
	#timer: NodeJS.Timeout | undefined;
	#chain: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(dir: string, options: { minIntervalMs?: number; now?: () => Date } = {}) {
		this.#file = path.join(dir, CHAT_STATUS_FILE);
		this.#minIntervalMs = options.minIntervalMs ?? STATUS_MIN_INTERVAL_MS;
		this.#now = options.now ?? (() => new Date());
	}

	/**
	 * Records the new numbers; a write is scheduled when they differ from the last written or recorded ones (all
	 * five are compared; `updatedAt` is set at write time). The first update after construction writes at once; later
	 * ones wait until `minIntervalMs` has passed since the last write. Ignored after `close`.
	 */
	update(numbers: StatusNumbers): void {
		if (this.#closed) return;
		const next: StatusNumbers = {
			messages: numbers.messages,
			nodesBuilt: numbers.nodesBuilt,
			nodesPending: numbers.nodesPending,
			viewBytes: numbers.viewBytes,
			compactionsFailed: numbers.compactionsFailed,
		};
		if (sameNumbers(next, this.#written)) {
			// Back to what is on disk: nothing newer is worth writing.
			this.#pending = undefined;
			this.#stopTimer();
			return;
		}
		if (sameNumbers(next, this.#pending)) return;
		this.#pending = next;
		if (this.#timer !== undefined) return;
		const wait =
			this.#lastWriteAt === undefined
				? 0
				: Math.max(0, this.#lastWriteAt + this.#minIntervalMs - this.#now().getTime());
		if (wait === 0) {
			this.#take();
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#take();
		}, wait);
		this.#timer.unref();
	}

	#stopTimer(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	/** Moves the pending numbers into the write queue; resolves when that write has finished (it never rejects). */
	#take(): Promise<void> {
		const numbers = this.#pending;
		if (numbers === undefined) return this.#chain;
		this.#pending = undefined;
		const at = this.#now();
		this.#lastWriteAt = at.getTime();
		this.#written = numbers;
		const status: ChatTreeStatus = { ...numbers, updatedAt: at.toISOString() };
		this.#chain = this.#chain.then(() => this.#write(status, numbers));
		return this.#chain;
	}

	async #write(status: ChatTreeStatus, numbers: StatusNumbers): Promise<void> {
		const temp = `${this.#file}.${process.pid}.${tempCounter++}.tmp`;
		try {
			await fs.mkdir(path.dirname(this.#file), { recursive: true });
			await Bun.write(temp, `${JSON.stringify(status)}\n`);
			await fs.rename(temp, this.#file);
		} catch (error) {
			await fs.rm(temp, { force: true }).catch(() => {});
			// Not on disk: the same numbers must be written again by the next update.
			if (this.#written === numbers) this.#written = undefined;
			logger.warn("chat status write failed", { error: String(error) });
		}
	}

	/** Writes any pending update now (ignoring the interval) and resolves when it is on disk. */
	flush(): Promise<void> {
		this.#stopTimer();
		return this.#take();
	}

	/** flush + stop timers. Later updates are ignored. */
	async close(): Promise<void> {
		await this.flush();
		this.#closed = true;
		this.#stopTimer();
	}
}

/** Reads status.json; undefined when it is absent or not a valid status. */
export async function readChatStatus(dir: string): Promise<ChatTreeStatus | undefined> {
	let value: unknown;
	try {
		value = JSON.parse(await Bun.file(path.join(dir, CHAT_STATUS_FILE)).text());
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const status = value as Record<string, unknown>;
	for (const key of NUMBER_KEYS) {
		const number = status[key];
		if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
	}
	if (typeof status.updatedAt !== "string") return undefined;
	return {
		messages: status.messages as number,
		nodesBuilt: status.nodesBuilt as number,
		nodesPending: status.nodesPending as number,
		viewBytes: status.viewBytes as number,
		compactionsFailed: status.compactionsFailed as number,
		updatedAt: status.updatedAt,
	};
}
