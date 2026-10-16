/**
 * One compaction (the spec's §4): the model call for a node, the 512-byte ruler, the "Too long" follow-ups and the
 * cache gate that keeps concurrent calls from all paying to write the same cached prefix (§3.3).
 *
 * The transport is the seam to the model: the session provides one that builds the very request a turn would send
 * (same system prompt and tools), a test provides a stub.
 */
import { NODE_MAX_BYTES, NODE_TRIES } from "./constants";
import { tooLongMessage } from "./prompt";
import { utf8Size } from "./text";

/** The view as the cache layout renders it: whole 4-line blocks, then the rest of the lines and `</chat>`. */
export interface RenderedView {
	blocks: readonly string[];
	tail: string;
}

/** One call of a compaction: its view, the user turns so far (the task, then the follow-ups) and the replies given to all but the last. */
export interface CompactionCall {
	view: RenderedView;
	/** Identifies the marked prefix of the call: calls with the same key read or write the same cache entry. */
	prefixKey: string;
	turns: readonly string[];
	replies: readonly string[];
}

export interface CompactionHooks {
	/** The provider's response began: the prefix of the call is written to the cache from here on. */
	onResponseStart(): void;
	signal?: AbortSignal;
}

export type CompactionTransport = (call: CompactionCall, hooks: CompactionHooks) => Promise<string>;

/** A view line's `id+n|` head, which the model sometimes copies into its line (once or several times) despite the prompt. */
const LINE_HEAD = /^(?:\d+\+\d+\|\s*)+/;

/** The model's reply as a line: trimmed, without copied `id+n|` heads (they would render as `22+1|2+2|…` and cost bytes). */
export function cleanLine(reply: string): string {
	return reply.trim().replace(LINE_HEAD, "").trim();
}

/**
 * The calls of one node: the first with the task, then, while the line is over the limit, a "Too long" follow-up
 * in the same conversation, at most {@link NODE_TRIES} calls in all. Returns the shortest line it got (a few
 * bytes over the limit is fine: the view measures real sizes). Rejects when no call gave a line.
 */
export async function compactNode(
	transport: CompactionTransport,
	gate: CacheGate,
	input: { view: RenderedView; prefixKey: string; task: string; gateKeys: readonly string[] },
	signal?: AbortSignal,
): Promise<string> {
	const turns = [input.task];
	const replies: string[] = [];
	let best: string | undefined;
	let bestBytes = Number.POSITIVE_INFINITY;
	for (let attempt = 0; attempt < NODE_TRIES; attempt++) {
		let reply: string;
		try {
			reply = cleanLine(
				await gate.run(input.gateKeys, hooks =>
					transport({ view: input.view, prefixKey: input.prefixKey, turns, replies }, { ...hooks, signal }),
				),
			);
		} catch (error) {
			if (best !== undefined) return best;
			throw error;
		}
		const bytes = utf8Size(reply);
		if (reply === "") {
			if (best !== undefined) return best;
			throw new Error("The compaction model answered with an empty line");
		}
		if (bytes < bestBytes) {
			best = reply;
			bestBytes = bytes;
		}
		if (bytes <= NODE_MAX_BYTES) return reply;
		replies.push(reply);
		turns.push(tooLongMessage(reply, bytes));
	}
	return best as string;
}

/**
 * Calls whose marked prefix another call is writing wait until that call's response starts; otherwise both would
 * pay to write it (§3.3). A key is a prefix of the request: the tools and system prompt of a model, a view's last
 * whole block. A prefix written or read within the cache lifetime needs no waiting.
 */
export class CacheGate {
	readonly #writing = new Map<string, Promise<void>>();
	readonly #seen = new Map<string, number>();
	readonly #now: () => number;
	readonly #ttlMs: number;

	/** The API's cache entries live five minutes from their last read. */
	constructor(options?: { now?: () => number; ttlMs?: number }) {
		this.#now = options?.now ?? Date.now;
		this.#ttlMs = options?.ttlMs ?? 5 * 60_000;
	}

	/**
	 * Runs `call` under the gate for `keys`: it first waits for every writer of those keys, then writes what is not
	 * cached. `call` gets `onResponseStart`, which lets the waiting calls go; the end of the call lets them go too.
	 */
	async run<T>(keys: readonly string[], call: (hooks: { onResponseStart(): void }) => Promise<T>): Promise<T> {
		const claims = await this.#enter(keys);
		let released = false;
		const release = (written: boolean): void => {
			if (released) return;
			released = true;
			const at = this.#now();
			for (const claim of claims) {
				this.#writing.delete(claim.key);
				if (written) this.#seen.set(claim.key, at);
				claim.resolve();
			}
		};
		try {
			const result = await call({ onResponseStart: () => release(true) });
			release(true);
			return result;
		} finally {
			release(false);
		}
	}

	async #enter(keys: readonly string[]): Promise<{ key: string; resolve: () => void }[]> {
		for (;;) {
			let waited = false;
			for (const key of keys) {
				const writer = this.#writing.get(key);
				if (writer) {
					await writer;
					waited = true;
				}
			}
			if (!waited) break;
		}
		const at = this.#now();
		for (const [key, seenAt] of this.#seen) if (at - seenAt >= this.#ttlMs) this.#seen.delete(key);
		const claims: { key: string; resolve: () => void }[] = [];
		for (const key of keys) {
			if (this.#seen.has(key)) {
				this.#seen.set(key, at);
				continue;
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#writing.set(key, promise);
			claims.push({ key, resolve });
		}
		return claims;
	}
}
