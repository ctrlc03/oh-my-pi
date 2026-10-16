/**
 * Builds the tree of the chat-tree mode (the spec's §2 and §4 "The order"): `node(0, i)` from message `i`,
 * `node(l, i)` from `node(l-1, 2i)` and `node(l-1, 2i+1)`, each at most 512 bytes and each built once.
 *
 * No part of this file scans the tree for work. Work enters a queue at the moment it becomes ready:
 * - a message's node, when the message is logged (a short one is built at once, without a model call);
 * - a merge, when the later of its two halves is built.
 * The one pass over what exists is {@link TreeBuilder.recover}, at the start of a process.
 */
import { LEAF_LOOKAHEAD, NODE_MAX_BYTES } from "./constants";
import { type ChatKind, type MessageRow, nodeKey, type TreeRow } from "./types";
import { utf8Size } from "./text";

/** A node that needs a model call. */
export type NodeJob = { kind: "leaf"; i: number } | { kind: "merge"; l: number; i: number };

/** What the builder needs of the log and of the compactor. */
export interface TreeBuilderHost {
	hasNode(l: number, i: number): boolean;
	nodeSize(l: number, i: number): number | undefined;
	readNode(l: number, i: number): Promise<TreeRow | undefined>;
	appendNode(l: number, i: number, text: string): Promise<TreeRow>;
	/** The model call(s) for one node: the node's text, however many tries it took. Rejects when the node could not be built now. */
	compact(job: NodeJob): Promise<string>;
	/** A node was built and logged. */
	onBuilt(row: TreeRow): void;
	/** A call failed (the node is tried again at the next message). */
	onFailed(job: NodeJob, error: unknown): void;
}

/** The line a short message is its own node as: `kind: text`, word for word. */
export function leafLine(kind: ChatKind, text: string): string {
	return `${kind}: ${text}`;
}

/** How many nodes a chat of `messages` messages has once it is fully built: `Σ floor(messages / 2^l)`. */
export function expectedNodes(messages: number): number {
	let total = 0;
	for (let level = messages; level > 0; level = Math.floor(level / 2)) total += level;
	return total;
}

export class TreeBuilder {
	readonly #host: TreeBuilderHost;
	#concurrency: number;
	/** Every message whose node is not built yet, ascending: a node still being appended counts as unbuilt. */
	readonly #unbuilt: number[] = [];
	/** What each unbuilt message is: a short one is built without a model call. */
	readonly #leaves = new Map<number, { kind: ChatKind; text: string; line: string; short: boolean }>();
	/** Merges ready for a model call, by level (the parent's level), ascending within a level. */
	readonly #merges = new Map<number, number[]>();
	#mergeLevels: number[] = [];
	/** Nodes whose call is running or whose direct build is in flight. */
	readonly #active = new Set<string>();
	/** Jobs that failed and wait for the next message. */
	readonly #failed = new Map<string, NodeJob>();
	#running = 0;
	#direct = 0;
	#messages = 0;
	#stopped = false;
	#leafWaiters: { count: number; resolve: () => void }[] = [];
	#idleWaiters: (() => void)[] = [];

	constructor(host: TreeBuilderHost, options: { concurrency: number }) {
		this.#host = host;
		this.#concurrency = Math.max(1, Math.floor(options.concurrency));
	}

	/** Model calls running now. */
	get running(): number {
		return this.#running;
	}

	/** Nodes whose last call failed and that wait for the next message. */
	get failed(): number {
		return this.#failed.size;
	}

	/** Nodes a fully built chat of this many messages has, less the ones built. */
	pending(builtNodes: number): number {
		return Math.max(0, expectedNodes(this.#messages) - builtNodes);
	}

	setConcurrency(concurrency: number): void {
		this.#concurrency = Math.max(1, Math.floor(concurrency));
		this.#pump();
	}

	/**
	 * Start of a process: derive the queues from what is already built, in one pass. `forEachNode` visits every
	 * built node; `readMessage` supplies the messages that have no node yet.
	 */
	async recover(
		messages: number,
		forEachNode: (callback: (l: number, i: number) => void) => void,
		readMessage: (i: number) => Promise<MessageRow | undefined>,
	): Promise<void> {
		this.#messages = messages;
		const readyParents: [number, number][] = [];
		forEachNode((l, i) => {
			if ((i & 1) === 0 && this.#host.hasNode(l, i + 1) && !this.#host.hasNode(l + 1, i >> 1)) {
				readyParents.push([l + 1, i >> 1]);
			}
		});
		for (let i = 0; i < messages; i++) {
			if (this.#host.hasNode(0, i)) continue;
			const row = await readMessage(i);
			if (row) this.#addLeaf(row);
		}
		for (const [l, i] of readyParents) this.#mergeReady(l, i);
		this.#pump();
		this.#checkWaiters();
	}

	/** Message `row` was logged (ids come in order). */
	messageLogged(row: MessageRow): void {
		this.#messages = row.i + 1;
		this.#addLeaf(row);
		this.#pump();
	}

	/** Puts the failed nodes back in the queues: the next message tries them again. */
	retryFailed(): void {
		if (this.#failed.size === 0) return;
		const jobs = [...this.#failed.values()];
		this.#failed.clear();
		for (const job of jobs) {
			if (job.kind === "merge") this.#mergeReady(job.l, job.i);
			else {
				const leaf = this.#leaves.get(job.i);
				if (leaf?.short) this.#buildLeafDirect(job.i);
			}
		}
		this.#pump();
	}

	/**
	 * Resolves once every message before `count` has its node built (a turn waits for this), or once nothing more
	 * will happen for it now: each unbuilt message before `count` has a failed call and no other is running. A
	 * failed node is tried again at the next message, so waiting on it would only hold the turn up.
	 */
	whenLeavesBuilt(count: number): Promise<void> {
		if (this.#stopped || this.#leavesSettled(count)) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#leafWaiters.push({ count, resolve });
		return promise;
	}

	/** Resolves when nothing runs and nothing eligible waits (a failed node is not eligible). */
	idle(): Promise<void> {
		if (this.#isIdle()) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#idleWaiters.push(resolve);
		return promise;
	}

	/** Stops starting calls; waiters are released. Calls in flight finish. */
	stop(): void {
		this.#stopped = true;
		for (const waiter of this.#leafWaiters.splice(0)) waiter.resolve();
		this.#notifyIdle();
	}

	#isIdle(): boolean {
		return this.#running === 0 && this.#direct === 0 && !this.#hasEligible();
	}

	#notifyIdle(): void {
		if (this.#idleWaiters.length === 0 || !this.#isIdle()) return;
		for (const resolve of this.#idleWaiters.splice(0)) resolve();
	}

	#addLeaf(row: MessageRow): void {
		const line = leafLine(row.kind, row.text);
		const short = utf8Size(line) <= NODE_MAX_BYTES;
		this.#leaves.set(row.i, { kind: row.kind, text: row.text, line, short });
		let at = this.#unbuilt.length;
		while (at > 0 && (this.#unbuilt[at - 1] as number) > row.i) at--;
		this.#unbuilt.splice(at, 0, row.i);
		if (short) this.#buildLeafDirect(row.i);
	}

	#buildLeafDirect(i: number): void {
		const leaf = this.#leaves.get(i);
		if (leaf) void this.#buildDirect(0, i, async () => leaf.line);
	}

	/** Every message before `count` is built, or every unbuilt one of them is failed (and so none is being built). */
	#leavesSettled(count: number): boolean {
		for (const i of this.#unbuilt) {
			if (i >= count) break;
			if (!this.#failed.has(nodeKey(0, i))) return false;
		}
		return true;
	}

	#checkWaiters(): void {
		if (this.#leafWaiters.length === 0) return;
		this.#leafWaiters = this.#leafWaiters.filter(waiter => {
			if (!this.#leavesSettled(waiter.count)) return true;
			waiter.resolve();
			return false;
		});
	}

	#hasEligible(): boolean {
		return this.#nextLeaf() !== undefined || this.#nextMerge() !== undefined;
	}

	/** The first of the {@link LEAF_LOOKAHEAD} oldest unbuilt messages that needs a call and is not running. */
	#nextLeaf(): number | undefined {
		if (this.#stopped) return undefined;
		const last = Math.min(this.#unbuilt.length, LEAF_LOOKAHEAD);
		for (let at = 0; at < last; at++) {
			const i = this.#unbuilt[at] as number;
			const leaf = this.#leaves.get(i);
			if (!leaf || leaf.short) continue;
			const key = nodeKey(0, i);
			if (!this.#active.has(key) && !this.#failed.has(key)) return i;
		}
		return undefined;
	}

	#nextMerge(): { l: number; i: number } | undefined {
		if (this.#stopped) return undefined;
		for (const level of this.#mergeLevels) {
			const queue = this.#merges.get(level);
			if (queue && queue.length > 0) return { l: level, i: queue[0] as number };
		}
		return undefined;
	}

	#enqueueMerge(l: number, i: number): void {
		let queue = this.#merges.get(l);
		if (!queue) {
			queue = [];
			this.#merges.set(l, queue);
			this.#mergeLevels.push(l);
			this.#mergeLevels.sort((a, b) => a - b);
		}
		if (queue.includes(i)) return;
		let at = queue.length;
		while (at > 0 && (queue[at - 1] as number) > i) at--;
		queue.splice(at, 0, i);
	}

	/** Both halves of node (l, i), l >= 1, are built: join the short ones directly, queue the rest for a model call. */
	#mergeReady(l: number, i: number): void {
		const sizeA = this.#host.nodeSize(l - 1, 2 * i);
		const sizeB = this.#host.nodeSize(l - 1, 2 * i + 1);
		if (sizeA !== undefined && sizeB !== undefined && sizeA + 1 + sizeB <= NODE_MAX_BYTES) {
			void this.#buildDirect(l, i, async () => {
				const [a, b] = await Promise.all([
					this.#host.readNode(l - 1, 2 * i),
					this.#host.readNode(l - 1, 2 * i + 1),
				]);
				if (!a || !b) throw new Error(`half of node ${l}+${i} is not readable`);
				return `${a.text}\n${b.text}`;
			});
			return;
		}
		this.#enqueueMerge(l, i);
	}

	async #buildDirect(l: number, i: number, text: () => Promise<string>): Promise<void> {
		const key = nodeKey(l, i);
		if (this.#active.has(key) || this.#host.hasNode(l, i)) return;
		this.#active.add(key);
		this.#direct++;
		try {
			await this.#append(l, i, await text());
		} catch (error) {
			const job: NodeJob = l === 0 ? { kind: "leaf", i } : { kind: "merge", l, i };
			this.#failed.set(key, job);
			this.#host.onFailed(job, error);
		} finally {
			this.#active.delete(key);
			this.#direct--;
			this.#pump();
			this.#checkWaiters();
			this.#notifyIdle();
		}
	}

	async #append(l: number, i: number, text: string): Promise<void> {
		const row = await this.#host.appendNode(l, i, text);
		if (l === 0) {
			const at = this.#unbuilt.indexOf(i);
			if (at >= 0) this.#unbuilt.splice(at, 1);
			this.#leaves.delete(i);
		}
		this.#host.onBuilt(row);
		// The parent is ready when the sibling exists too. A merge of two existing halves covers messages that exist.
		if (this.#host.hasNode(l, i ^ 1) && !this.#host.hasNode(l + 1, i >> 1)) this.#mergeReady(l + 1, i >> 1);
	}

	#pump(): void {
		while (this.#running < this.#concurrency) {
			const leaf = this.#nextLeaf();
			if (leaf !== undefined) {
				this.#start({ kind: "leaf", i: leaf });
				continue;
			}
			const merge = this.#nextMerge();
			if (merge === undefined) break;
			this.#merges.get(merge.l)?.shift();
			if (this.#host.hasNode(merge.l, merge.i) || this.#active.has(nodeKey(merge.l, merge.i))) continue;
			this.#start({ kind: "merge", l: merge.l, i: merge.i });
		}
		this.#notifyIdle();
	}

	#start(job: NodeJob): void {
		const l = job.kind === "leaf" ? 0 : job.l;
		const key = nodeKey(l, job.i);
		this.#active.add(key);
		this.#running++;
		void this.#host
			.compact(job)
			.then(text => this.#append(l, job.i, text))
			.catch(error => {
				this.#failed.set(key, job);
				this.#host.onFailed(job, error);
			})
			.finally(() => {
				this.#active.delete(key);
				this.#running--;
				this.#pump();
				this.#checkWaiters();
				this.#notifyIdle();
			});
	}
}
