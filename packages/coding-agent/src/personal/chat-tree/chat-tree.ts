/**
 * The chat of the chat-tree memory mode (docs/personal-chat-tree.md): the log, the tree that is built from it in
 * the background and the views that are rendered from the tree. One owner process per chat.
 *
 * Nothing here knows about omp sessions or providers; the session feeds it messages and gives it the transport
 * for the compaction calls.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { type CacheGate, type CompactionTransport, compactNode, type RenderedView } from "./compactor";
import {
	CHAT_VIEW_HIGH_BYTES,
	CHAT_VIEW_LOW_BYTES,
	COMPACTION_VIEW_HIGH_BYTES,
	COMPACTION_VIEW_LOW_BYTES,
	TURN_WAIT_MS,
} from "./constants";
import { ChatLog } from "./log";
import { leafTask, mergeTask } from "./prompt";
import { ChatStatusWriter } from "./status";
import { clipToolOutput, splitLongText } from "./text";
import { type NodeJob, TreeBuilder } from "./tree";
import { CHAT_KINDS, type ChatKind, type MessageRow, type NodeRef, nodeKey } from "./types";
import { ChatView, renderViewBlocks, type ViewHost, type ViewLimits } from "./view";

export const CHAT_VIEW_LIMITS: ViewLimits = { high: CHAT_VIEW_HIGH_BYTES, low: CHAT_VIEW_LOW_BYTES };
export const COMPACTION_VIEW_LIMITS: ViewLimits = { high: COMPACTION_VIEW_HIGH_BYTES, low: COMPACTION_VIEW_LOW_BYTES };

export interface ChatTreeOptions {
	/** `<agentDir>/personal-chat`. */
	dir: string;
	/** Compaction calls at once. */
	concurrency: number;
	transport: CompactionTransport;
	/** Names the model the compactions run on: cache prefixes are per model. */
	modelKey: string;
	gate: CacheGate;
	now?: () => Date;
	/** How long opening retries a lock a live process holds (a replaced session's predecessor may still be leaving). */
	waitForLockMs?: number;
	/** How long a turn waits for the messages before it to be summarized. */
	turnWaitMs?: number;
	statusIntervalMs?: number;
}

export class ChatTree {
	readonly log: ChatLog;
	readonly #options: ChatTreeOptions;
	readonly #tree: TreeBuilder;
	readonly #status: ChatStatusWriter;
	#view: ChatView;
	#compactionView: ChatView;
	/** Logging is one writer at a time: ids and view lines come out in order. */
	#queue: Promise<unknown> = Promise.resolve();
	#saving: Promise<void> | undefined;
	#saveAgain = false;
	#closed = false;
	readonly #abort = new AbortController();

	private constructor(options: ChatTreeOptions, log: ChatLog, view: ChatView) {
		this.#options = options;
		this.log = log;
		this.#view = view;
		this.#compactionView = this.#deriveCompactionView();
		this.#status = new ChatStatusWriter(options.dir, { minIntervalMs: options.statusIntervalMs, now: options.now });
		this.#tree = new TreeBuilder(
			{
				hasNode: (l, i) => log.hasNode(l, i),
				nodeSize: (l, i) => log.nodeSize(l, i),
				readNode: (l, i) => log.readNode(l, i),
				appendNode: (l, i, text) => log.appendNode(l, i, text),
				compact: job => this.#compact(job),
				onBuilt: row => {
					if (row.l === 0) {
						this.#view.leafBuilt(row.i);
						this.#compactionView.leafBuilt(row.i);
					}
					this.#updateStatus();
				},
				onFailed: (job, error) => {
					if (this.#closed) return;
					logger.warn("chat-tree compaction failed", { job: jobName(job), error: String(error) });
					this.#updateStatus();
				},
			},
			{ concurrency: options.concurrency },
		);
	}

	/**
	 * Opens the chat under `options.dir` and takes its lock. The saved view is loaded as it was; messages logged
	 * after it was saved are appended to it, nothing is rebuilt. A view that cannot be read is replaced by one
	 * made from the log (the one case where the view is rebuilt, and the model's cache for it is lost).
	 */
	static async open(options: ChatTreeOptions): Promise<ChatTree> {
		const log = await ChatLog.open(options.dir, { now: options.now, waitForLockMs: options.waitForLockMs });
		try {
			const host: ViewHost = { isBuilt: (l, i) => log.hasNode(l, i), nodeSize: (l, i) => log.nodeSize(l, i) ?? 0 };
			let view: ChatView | undefined;
			try {
				const json = await log.readView();
				if (json !== undefined) view = ChatView.parse(host, CHAT_VIEW_LIMITS, json);
				if (view && view.messages > log.messageCount) {
					throw new Error(`the view covers ${view.messages} messages, the log holds ${log.messageCount}`);
				}
			} catch (error) {
				logger.warn("chat-tree view.json is unusable: the view is made from the log", { error: String(error) });
				view = undefined;
			}
			view ??= new ChatView(host, CHAT_VIEW_LIMITS);
			for (let i = view.messages; i < log.messageCount; i++) view.append(i);
			while (view.settle() > 0) {
				// Catching up a long gap can pass the high mark more than once.
			}
			const chat = new ChatTree(options, log, view);
			await chat.#tree.recover(
				log.messageCount,
				callback => log.forEachNode((l, i) => callback(l, i)),
				i => log.readMessage(i),
			);
			chat.#scheduleSave();
			chat.#updateStatus();
			return chat;
		} catch (error) {
			await log.close();
			throw error;
		}
	}

	get messageCount(): number {
		return this.log.messageCount;
	}

	/** Bytes of the chat's view as it stands. */
	get viewBytes(): number {
		return this.#view.bytes;
	}

	/** Nodes whose last compaction call failed. */
	get compactionsFailed(): number {
		return this.#tree.failed;
	}

	get tree(): TreeBuilder {
		return this.#tree;
	}

	/** The chat's view as the cache layout renders it, placeholders for the messages not summarized yet. */
	renderView(): Promise<RenderedView> {
		return this.#render(this.#view.entries.slice());
	}

	/**
	 * The start of a turn (the spec's §6): waits until every message before the new one is summarized (a failed
	 * compaction is tried again first), renders the view, and only then logs the new messages. When the wait runs
	 * out the view carries "(not summarized yet: zoom it)" lines and the turn goes on. Aborting `signal` ends the
	 * wait and rejects before anything is logged.
	 */
	async beginTurn(messages: readonly { kind: ChatKind; text: string }[], signal?: AbortSignal): Promise<RenderedView> {
		signal?.throwIfAborted();
		this.#tree.retryFailed();
		const wait = this.#options.turnWaitMs ?? TURN_WAIT_MS;
		const { promise: timeout, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, wait);
		const onAbort = () => resolve();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([this.#tree.whenLeavesBuilt(await this.#settledCount()), timeout]);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		signal?.throwIfAborted();
		const view = await this.renderView();
		for (const message of messages) await this.logMessage(message.kind, message.text);
		return view;
	}

	/** Messages logged so far, once every logging in flight is on disk. */
	async #settledCount(): Promise<number> {
		await this.#queue;
		return this.log.messageCount;
	}

	/**
	 * Logs a message: a tool's output is clipped to its head and tail, any other long text is split into several
	 * messages in a row (§1). Returns the ids it got.
	 */
	logMessage(kind: ChatKind, text: string): Promise<number[]> {
		if (!CHAT_KINDS.includes(kind)) throw new Error(`Unknown chat kind ${kind}`);
		const pieces = this.#pieces(kind, text);
		const run = this.#queue.then(async () => {
			const ids: number[] = [];
			for (const piece of pieces) ids.push((await this.#append(kind, piece)).i);
			return ids;
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/** The rows `logMessage(kind, text)` writes: a tool's output clipped, any other long text split. */
	#pieces(kind: ChatKind, text: string): string[] {
		return kind === "echo" ? [clipToolOutput(text)] : splitLongText(text);
	}

	/**
	 * How many of `rows`, from the first, are already the last rows of the log, row for row (kind and text as
	 * `logMessage` would write them). A row whose `at` (when the message was made, ms) is after its logged twin's
	 * date is a different message that says the same, and stops the count.
	 *
	 * This is how a turn start that a crash cut off is not logged twice: the process that logged it is gone, so
	 * nothing in memory says so, but the group it opened is the tail of the log.
	 */
	async loggedTail(rows: readonly { kind: ChatKind; text: string; at?: number }[]): Promise<number> {
		await this.#queue;
		const pieces = rows.map(row => this.#pieces(row.kind, row.text));
		for (let count = rows.length; count > 0; count--) {
			const total = pieces.slice(0, count).reduce((sum, rowPieces) => sum + rowPieces.length, 0);
			let start = this.log.messageCount - total;
			if (start < 0) continue;
			let matches = true;
			for (let r = 0; r < count && matches; r++) {
				const row = rows[r] as { kind: ChatKind; at?: number };
				const rowPieces = pieces[r] as string[];
				for (let p = 0; p < rowPieces.length && matches; p++) {
					const logged = await this.log.readMessage(start + p);
					matches =
						logged !== undefined &&
						logged.kind === row.kind &&
						logged.text === rowPieces[p] &&
						(p > 0 || row.at === undefined || Date.parse(logged.date) >= row.at);
				}
				start += rowPieces.length;
			}
			if (matches) return count;
		}
		return 0;
	}

	async #append(kind: ChatKind, text: string): Promise<MessageRow> {
		if (this.#closed) throw new Error("The chat is closed");
		const row = await this.log.appendMessage(kind, text);
		this.#view.append(row.i);
		this.#compactionView.append(row.i);
		// A failed compaction is tried again at the next message.
		this.#tree.retryFailed();
		this.#tree.messageLogged(row);
		this.#settleViews();
		this.#updateStatus();
		return row;
	}

	/** One sawtooth step of both views (§3.2, §4): a merge of the chat's view makes the compaction view merge again too. */
	#settleViews(): void {
		const merged = this.#view.settle();
		if (merged > 0) {
			this.#compactionView = this.#deriveCompactionView();
			this.#scheduleSave();
			return;
		}
		this.#compactionView.settle();
		this.#scheduleSave();
	}

	#deriveCompactionView(): ChatView {
		const view = this.#view.copy(COMPACTION_VIEW_LIMITS);
		view.mergeDown(COMPACTION_VIEW_LIMITS.low);
		return view;
	}

	/** Saves the view; calls that come while a save runs fold into one more save after it. */
	#scheduleSave(): void {
		if (this.#saving) {
			this.#saveAgain = true;
			return;
		}
		this.#saving = (async () => {
			do {
				this.#saveAgain = false;
				try {
					await this.log.writeView(this.#view.toJSON());
				} catch (error) {
					if (!this.#closed) logger.warn("chat-tree view.json not saved", { error: String(error) });
				}
			} while (this.#saveAgain && !this.#closed);
		})().finally(() => {
			this.#saving = undefined;
		});
	}

	#updateStatus(): void {
		this.#status.update({
			messages: this.log.messageCount,
			nodesBuilt: this.log.nodeCount,
			nodesPending: this.#tree.pending(this.log.nodeCount),
			viewBytes: this.#view.bytes,
			compactionsFailed: this.#tree.failed,
		});
	}

	async #render(entries: readonly NodeRef[]): Promise<RenderedView> {
		const texts = new Map<string, string>();
		await Promise.all(
			entries.map(async ref => {
				if (!this.log.hasNode(ref[0], ref[1])) return;
				const row = await this.log.readNode(ref[0], ref[1]);
				if (row) texts.set(nodeKey(ref[0], ref[1]), row.text);
			}),
		);
		return renderViewBlocks(entries, ref => texts.get(nodeKey(ref[0], ref[1])));
	}

	/** The model call(s) for one node: its compaction view ends at the node and holds only built lines (§4). */
	async #compact(job: NodeJob): Promise<string> {
		let task: string;
		let entries: NodeRef[];
		if (job.kind === "leaf") {
			const row = await this.log.readMessage(job.i);
			if (!row) throw new Error(`message ${job.i} is not in the log`);
			task = leafTask(job.i, row.kind, row.text);
			entries = this.#compactionView.builtPrefix(job.i);
		} else {
			const half = 2 ** (job.l - 1);
			const first = job.i * 2 * half;
			const [a, b] = await Promise.all([
				this.log.readNode(job.l - 1, 2 * job.i),
				this.log.readNode(job.l - 1, 2 * job.i + 1),
			]);
			if (!a || !b) throw new Error(`half of node ${job.l}+${job.i} is not readable`);
			task = mergeTask(
				{ name: `${first}+${half}`, text: a.text },
				{ name: `${first + half}+${half}`, text: b.text },
				first,
				first + 2 * half - 1,
			);
			entries = this.#compactionView.builtPrefix(first + 2 * half);
		}
		const view = await this.#render(entries);
		const viewKey = view.blocks.length > 0 ? String(Bun.hash(view.blocks.join("\0"))) : "";
		const model = this.#options.modelKey;
		return await compactNode(
			this.#options.transport,
			this.#options.gate,
			{
				view,
				prefixKey: viewKey,
				task,
				gateKeys: viewKey === "" ? [`head:${model}`] : [`head:${model}`, `view:${model}:${viewKey}`],
			},
			this.#abort.signal,
		);
	}

	/** Stops the builder, saves the view and the status, and releases the lock. Compactions in flight are abandoned: they are tried again by the next process. */
	async close(): Promise<void> {
		if (this.#closed) return;
		await this.#queue;
		this.#closed = true;
		this.#abort.abort();
		this.#tree.stop();
		await this.#saving;
		try {
			await this.log.writeView(this.#view.toJSON());
		} catch (error) {
			logger.warn("chat-tree view.json not saved", { error: String(error) });
		}
		await this.#status.close();
		await this.log.close();
	}
}

function jobName(job: NodeJob): string {
	return job.kind === "leaf" ? `message ${job.i}` : `node ${job.l}+${job.i}`;
}
