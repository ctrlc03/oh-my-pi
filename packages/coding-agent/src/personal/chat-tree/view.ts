/**
 * The chat view of the chat-tree memory mode (docs/personal-chat-tree.md, spec §3): a list of tree nodes covering
 * the whole chat, oldest first, kept as a sawtooth. Every new message appends its leaf line; once the view passes
 * `high` bytes one batch merges the most due sibling pairs down to `low` bytes. Pure and synchronous: the tree is
 * reached only through `ViewHost`.
 */
import { NOT_SUMMARIZED_TEXT, VIEW_BLOCK_LINES } from "./constants";
import type { NodeRef } from "./types";
import { nodeId } from "./types";

/** What the view needs to know about the tree, synchronously. */
export interface ViewHost {
	/** Whether node (l,i) is built (its text exists). A leaf that is not built is shown as a placeholder line. */
	isBuilt(l: number, i: number): boolean;
	/** UTF-8 bytes of a built node's text. Only called when isBuilt is true. */
	nodeSize(l: number, i: number): number;
}

export interface ViewLimits {
	high: number;
	low: number;
}

const PLACEHOLDER_BYTES = Buffer.byteLength(NOT_SUMMARIZED_TEXT);

function linePrefix(ref: NodeRef): string {
	const { id, n } = nodeId(ref);
	return `${id}+${n}|`;
}

/**
 * One line of the view as text: `${id}+${n}|${text}` with every \r and \n of `text` replaced by one space each
 * (the byte size is unchanged). `text` undefined is the placeholder `NOT_SUMMARIZED_TEXT`. No trailing newline.
 */
export function renderViewLine(ref: NodeRef, text: string | undefined): string {
	return linePrefix(ref) + (text === undefined ? NOT_SUMMARIZED_TEXT : text.replace(/[\r\n]/g, " "));
}

/**
 * Bytes the line takes in the view, including its trailing newline: the `id+n|` head, then the node's text size
 * (`size`) or, for an unbuilt leaf (`size` undefined), the placeholder's, then 1 for the newline.
 */
export function viewLineBytes(ref: NodeRef, size: number | undefined): number {
	return linePrefix(ref).length + (size === undefined ? PLACEHOLDER_BYTES : size) + 1;
}

function parseError(message: string): Error {
	return new Error(`Invalid chat view: ${message}`);
}

export class ChatView {
	readonly #host: ViewHost;
	readonly #limits: ViewLimits;
	#entries: [number, number][];
	/** `viewLineBytes` of each entry, as last measured; `#bytes` is their sum. */
	#lineBytes: number[];
	#bytes = 0;
	#merging = false;

	constructor(host: ViewHost, limits: ViewLimits, entries: readonly NodeRef[] = []) {
		this.#host = host;
		this.#limits = limits;
		this.#entries = entries.map(([l, i]): [number, number] => [l, i]);
		this.#lineBytes = this.#entries.map(ref => this.#measure(ref));
		for (const size of this.#lineBytes) this.#bytes += size;
	}

	/** Entries, oldest first, as [l,i] pairs. Treat as read-only. */
	get entries(): readonly NodeRef[] {
		return this.#entries;
	}

	/** Sum of `viewLineBytes` over the entries (kept incrementally; equal to a fresh recomputation). */
	get bytes(): number {
		return this.#bytes;
	}

	/** T: the number of messages the view covers (the end of the last entry). */
	get messages(): number {
		const last = this.#entries[this.#entries.length - 1];
		return last === undefined ? 0 : (last[1] + 1) * 2 ** last[0];
	}

	/** Whether the sawtooth is in its merging state (bytes went over `high` and `low` was not reached yet). */
	get merging(): boolean {
		return this.#merging;
	}

	/** Message `i` (which must equal `messages`) is appended as the line [0,i]. Nothing else changes. */
	append(i: number): void {
		if (i !== this.messages) throw new Error(`Cannot append message ${i}: the view covers ${this.messages} messages`);
		const ref: [number, number] = [0, i];
		const size = this.#measure(ref);
		this.#entries.push(ref);
		this.#lineBytes.push(size);
		this.#bytes += size;
	}

	/** Leaf (0,i) just became built: refreshes that entry's byte size if it is in the view (no-op if absent). */
	leafBuilt(i: number): void {
		for (let k = this.#entries.length - 1; k >= 0; k--) {
			const ref = this.#entries[k];
			if (ref[0] === 0 && ref[1] === i) {
				const size = this.#measure(ref);
				this.#bytes += size - this.#lineBytes[k];
				this.#lineBytes[k] = size;
				return;
			}
			// Leaves are the only entries that can be unbuilt and ids only grow along the view.
			if (ref[1] * 2 ** ref[0] < i) return;
		}
	}

	/**
	 * The sawtooth step. If not merging and bytes > limits.high, starts merging. While merging: merges the most due
	 * eligible pairs until bytes <= limits.low (then stops merging); if no eligible pair is left before reaching
	 * low, stays merging (the next call continues with what became eligible). Returns the merges done in this call.
	 */
	settle(): number {
		if (!this.#merging) {
			if (this.#bytes <= this.#limits.high) return 0;
			this.#merging = true;
		}
		const merges = this.mergeDown(this.#limits.low);
		if (this.#bytes <= this.#limits.low) this.#merging = false;
		return merges;
	}

	/** Merges the most due eligible pairs until bytes <= target or none is eligible; returns the merges done. Does not touch `merging`. */
	mergeDown(target: number): number {
		let merges = 0;
		while (this.#bytes > target && this.#mergeMostDue()) merges++;
		return merges;
	}

	/**
	 * The entries to show to a compaction of a node: the longest prefix whose entries all end at or before message
	 * `endExclusive` (an entry ends at (i+1)*2^l) and are all built. An unbuilt leaf stops the prefix; merged
	 * entries are always built.
	 */
	builtPrefix(endExclusive: number): NodeRef[] {
		const prefix: NodeRef[] = [];
		for (const ref of this.#entries) {
			if ((ref[1] + 1) * 2 ** ref[0] > endExclusive) break;
			if (ref[0] === 0 && !this.#host.isBuilt(0, ref[1])) break;
			prefix.push(ref);
		}
		return prefix;
	}

	/** An independent copy with other limits: same host, same entries, not merging. */
	copy(limits: ViewLimits): ChatView {
		return new ChatView(this.#host, limits, this.#entries);
	}

	/** `[[l,i],...]` for view.json. */
	toJSON(): [number, number][] {
		return this.#entries.map(([l, i]): [number, number] => [l, i]);
	}

	/**
	 * Parses and validates view.json content: an array of [l,i] pairs of non-negative integers that cover the
	 * messages contiguously from 0, with no gap or overlap. Throws an Error naming the fault otherwise.
	 */
	static parse(host: ViewHost, limits: ViewLimits, json: unknown): ChatView {
		if (!Array.isArray(json)) throw parseError("expected an array of [l, i] pairs");
		const entries: NodeRef[] = [];
		let cursor = 0;
		for (let k = 0; k < json.length; k++) {
			const pair: unknown = json[k];
			if (!Array.isArray(pair) || pair.length !== 2) throw parseError(`entry ${k} is not an [l, i] pair`);
			const [l, i]: unknown[] = pair;
			if (typeof l !== "number" || !Number.isInteger(l) || l < 0 || l > 52) {
				throw parseError(`entry ${k}: l must be an integer from 0 to 52`);
			}
			if (typeof i !== "number" || !Number.isInteger(i) || i < 0) {
				throw parseError(`entry ${k}: [${l}, ${i}] is not aligned, i must be a non-negative integer`);
			}
			const n = 2 ** l;
			const start = i * n;
			if (!Number.isSafeInteger(start + n)) throw parseError(`entry ${k}: [${l}, ${i}] is out of range`);
			if (start > cursor)
				throw parseError(`gap before entry ${k} [${l}, ${i}]: messages ${cursor} to ${start - 1} are not covered`);
			if (start < cursor) throw parseError(`entry ${k} [${l}, ${i}] overlaps the messages before message ${cursor}`);
			entries.push([l, i]);
			cursor = start + n;
		}
		return new ChatView(host, limits, entries);
	}

	#measure(ref: NodeRef): number {
		const [l, i] = ref;
		return viewLineBytes(ref, l === 0 && !this.#host.isBuilt(0, i) ? undefined : this.#host.nodeSize(l, i));
	}

	/**
	 * Merges the most due eligible sibling pair: the largest `due = (T - last) / 2^l` (`last` = the pair's last
	 * message), the oldest on ties, among the pairs whose parent is built. Dues are compared by cross-multiplying
	 * with the powers of two, which is exact in floating point, so ties are exact. False when no pair is eligible.
	 */
	#mergeMostDue(): boolean {
		const entries = this.#entries;
		const total = this.messages;
		let best = -1;
		let bestNum = 0;
		let bestDen = 1;
		for (let k = 0; k + 1 < entries.length; k++) {
			const [l, i] = entries[k];
			const next = entries[k + 1];
			if (next[0] !== l || i % 2 !== 0 || next[1] !== i + 1) continue;
			const den = 2 ** l;
			const num = total - ((i + 2) * den - 1);
			if (best >= 0 && num * bestDen <= bestNum * den) continue;
			if (!this.#host.isBuilt(l + 1, i / 2)) continue;
			best = k;
			bestNum = num;
			bestDen = den;
		}
		if (best < 0) return false;
		const [l, i] = entries[best];
		const parent: [number, number] = [l + 1, i / 2];
		const size = this.#measure(parent);
		this.#bytes += size - this.#lineBytes[best] - this.#lineBytes[best + 1];
		entries.splice(best, 2, parent);
		this.#lineBytes.splice(best, 2, size);
		return true;
	}
}

/**
 * Renders the view as the content blocks of the cache layout (spec §3.3): the lines are grouped `VIEW_BLOCK_LINES`
 * at a time; block 0 starts with "<chat>\n"; every line ends with "\n". Returns the whole groups as `blocks` and,
 * as `tail`, the remaining 0 to 3 lines then "</chat>". The text of a block never depends on the lines after it.
 * `textOf(ref)` gives a built node's text, or undefined for an unbuilt leaf (the placeholder).
 */
export function renderViewBlocks(
	entries: readonly NodeRef[],
	textOf: (ref: NodeRef) => string | undefined,
): { blocks: string[]; tail: string } {
	const blocks: string[] = [];
	let current = "<chat>\n";
	let inBlock = 0;
	for (const ref of entries) {
		current += `${renderViewLine(ref, textOf(ref))}\n`;
		inBlock++;
		if (inBlock === VIEW_BLOCK_LINES) {
			blocks.push(current);
			current = "";
			inBlock = 0;
		}
	}
	return { blocks, tail: `${current}</chat>` };
}
