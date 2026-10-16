/**
 * Contract: TreeBuilder builds `node(0, i)` from message `i` and `node(l, i)` from its two halves, each node once.
 * Short lines are built at once without a model call (a merge of two short lines is the two lines joined by a
 * newline); the rest wait in queues that are filled when work becomes ready: leaves before merges, lower levels
 * before higher, never more model calls than the concurrency, only the 8 oldest unbuilt messages started. A failed
 * node is tried again by `retryFailed`; `recover` queues only what is missing. The host is a stub.
 */
import { describe, expect, it } from "bun:test";
import { LEAF_LOOKAHEAD, NODE_MAX_BYTES } from "../../../src/personal/chat-tree/constants";
import { utf8Size } from "../../../src/personal/chat-tree/text";
import {
	expectedNodes,
	leafLine,
	type NodeJob,
	TreeBuilder,
	type TreeBuilderHost,
} from "../../../src/personal/chat-tree/tree";
import { type ChatKind, type MessageRow, nodeKey, type TreeRow } from "../../../src/personal/chat-tree/types";

/** A model answer long enough that a merge of two of them can never be joined without a call. */
const LONG_NODE = "n".repeat(300);

function messageRow(i: number, text: string, kind: ChatKind = "user"): MessageRow {
	return { i, kind, text, size: utf8Size(text), date: "2026-03-01T10:00:00.000Z" };
}

/** A message whose line is over the limit: its node needs a model call. */
const longRow = (i: number) => messageRow(i, "w".repeat(NODE_MAX_BYTES + 100));

const jobKey = (job: NodeJob) => (job.kind === "leaf" ? nodeKey(0, job.i) : nodeKey(job.l, job.i));

/** Lets every promise chain of the builder run to its next wait. */
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

interface PendingCall {
	job: NodeJob;
	resolve(text: string): void;
	reject(error: unknown): void;
}

interface StubHost {
	host: TreeBuilderHost;
	nodes: Map<string, TreeRow>;
	appended: string[];
	started: string[];
	built: string[];
	failed: { job: NodeJob; error: unknown }[];
	pendingCalls: PendingCall[];
	failNext: Set<string>;
	failAppend: Set<string>;
	readonly running: number;
	readonly maxRunning: number;
	/** Answers the oldest open call. */
	answerOne(text?: string): Promise<void>;
	/** Answers every call, including the ones the answers set going, until none is open. */
	answerAll(text?: string): Promise<void>;
}

/** A host whose model calls stay open until the test answers them; it records everything the builder does. */
function makeHost(): StubHost {
	const nodes = new Map<string, TreeRow>();
	const appended: string[] = [];
	const started: string[] = [];
	const built: string[] = [];
	const failed: { job: NodeJob; error: unknown }[] = [];
	const pendingCalls: PendingCall[] = [];
	const failNext = new Set<string>();
	const failAppend = new Set<string>();
	let running = 0;
	let maxRunning = 0;

	const host: TreeBuilderHost = {
		hasNode: (l, i) => nodes.has(nodeKey(l, i)),
		nodeSize: (l, i) => nodes.get(nodeKey(l, i))?.size,
		readNode: async (l, i) => nodes.get(nodeKey(l, i)),
		appendNode: async (l, i, text) => {
			const key = nodeKey(l, i);
			if (failAppend.delete(key)) throw new Error(`disk refused ${key}`);
			if (nodes.has(key)) throw new Error(`node ${key} is already built`);
			const row: TreeRow = { l, i, text, size: utf8Size(text) };
			nodes.set(key, row);
			appended.push(key);
			return row;
		},
		compact: job => {
			const key = jobKey(job);
			started.push(key);
			if (failNext.delete(key)) return Promise.reject(new Error(`model failed on ${key}`));
			running++;
			maxRunning = Math.max(maxRunning, running);
			const { promise, resolve, reject } = Promise.withResolvers<string>();
			pendingCalls.push({
				job,
				resolve: text => {
					running--;
					resolve(text);
				},
				reject: error => {
					running--;
					reject(error);
				},
			});
			return promise;
		},
		onBuilt: row => {
			built.push(nodeKey(row.l, row.i));
		},
		onFailed: (job, error) => {
			failed.push({ job, error });
		},
	};

	return {
		host,
		nodes,
		appended,
		started,
		built,
		failed,
		pendingCalls,
		failNext,
		failAppend,
		get running() {
			return running;
		},
		get maxRunning() {
			return maxRunning;
		},
		async answerOne(text = LONG_NODE): Promise<void> {
			const call = pendingCalls.shift();
			if (!call) throw new Error("no model call is open");
			call.resolve(text);
			await tick();
		},
		async answerAll(text = LONG_NODE): Promise<void> {
			await tick();
			while (pendingCalls.length > 0) {
				for (const call of pendingCalls.splice(0)) call.resolve(text);
				await tick();
			}
		},
	};
}

function builderOf(stub: StubHost, concurrency: number): TreeBuilder {
	return new TreeBuilder(stub.host, { concurrency });
}

describe("TreeBuilder short nodes", () => {
	it("builds a short message's node at once, with no model call, as `kind: text`", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		builder.messageLogged(messageRow(0, "hello", "user"));
		await tick();
		expect(stub.started).toEqual([]);
		expect(stub.nodes.get(nodeKey(0, 0))?.text).toBe("user: hello");
		expect(stub.nodes.get(nodeKey(0, 0))?.text).toBe(leafLine("user", "hello"));
		expect(stub.built).toEqual([nodeKey(0, 0)]);
	});

	it("joins two short lines with a newline, with no model call", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		builder.messageLogged(messageRow(0, "hello", "user"));
		builder.messageLogged(messageRow(1, "hi there", "unii"));
		await tick();
		expect(stub.started).toEqual([]);
		expect(stub.nodes.get(nodeKey(1, 0))?.text).toBe("user: hello\nunii: hi there");
	});

	it("merges whole levels of short lines without a model call", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		for (let i = 0; i < 4; i++) builder.messageLogged(messageRow(i, `m${i}`));
		await tick();
		expect(stub.started).toEqual([]);
		expect(stub.nodes.get(nodeKey(2, 0))?.text).toBe("user: m0\nuser: m1\nuser: m2\nuser: m3");
		expect(stub.nodes.size).toBe(expectedNodes(4));
	});

	it("calls the model for a merge whose joined halves would pass the limit", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		// 250 + 1 + 250 = 501 fits; 260 + 1 + 260 = 521 does not.
		const fits = (i: number) => messageRow(i, "a".repeat(250 - "user: ".length));
		const over = (i: number) => messageRow(i, "b".repeat(260 - "user: ".length));
		builder.messageLogged(fits(0));
		builder.messageLogged(fits(1));
		builder.messageLogged(over(2));
		builder.messageLogged(over(3));
		await tick();
		expect(stub.nodes.get(nodeKey(1, 0))?.size).toBe(250 + 1 + 250);
		expect(stub.started).toEqual([nodeKey(1, 1)]);
	});

	it("starts a long message's node only with a model call", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		builder.messageLogged(longRow(0));
		await tick();
		expect(stub.started).toEqual([nodeKey(0, 0)]);
		expect(stub.nodes.has(nodeKey(0, 0))).toBe(false);
		await stub.answerOne("summary");
		expect(stub.nodes.get(nodeKey(0, 0))?.text).toBe("summary");
	});
});

describe("TreeBuilder order", () => {
	it("builds leaves first, then merges lowest level first", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		for (let i = 0; i < 4; i++) builder.messageLogged(longRow(i));
		await stub.answerAll();
		expect(stub.started).toEqual([
			nodeKey(0, 0),
			nodeKey(0, 1),
			nodeKey(0, 2),
			nodeKey(0, 3),
			nodeKey(1, 0),
			nodeKey(1, 1),
			nodeKey(2, 0),
		]);
	});

	it("starts a leaf before a merge that is ready at the same time", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		builder.messageLogged(longRow(0));
		builder.messageLogged(longRow(1));
		builder.messageLogged(longRow(2));
		await stub.answerOne(); // leaf 0
		await stub.answerOne(); // leaf 1: merge (1, 0) is ready now, leaf 2 still waits
		expect(stub.started.slice(0, 3)).toEqual([nodeKey(0, 0), nodeKey(0, 1), nodeKey(0, 2)]);
		await stub.answerAll();
		expect(stub.started[3]).toBe(nodeKey(1, 0));
	});

	it("recovers merges lowest level first, ascending within a level", async () => {
		const stub = makeHost();
		for (let i = 0; i < 8; i++) stub.nodes.set(nodeKey(0, i), { l: 0, i, text: LONG_NODE, size: 300 });
		for (const i of [0, 1]) stub.nodes.set(nodeKey(1, i), { l: 1, i, text: LONG_NODE, size: 300 });
		const builder = builderOf(stub, 1);
		// The higher level is visited first: the queues, not the visit order, decide.
		const visit = (callback: (l: number, i: number) => void) => {
			callback(1, 0);
			callback(1, 1);
			for (let i = 0; i < 8; i++) callback(0, i);
		};
		await builder.recover(8, visit, async () => undefined);
		await stub.answerAll();
		expect(stub.started).toEqual([nodeKey(1, 2), nodeKey(1, 3), nodeKey(2, 0), nodeKey(2, 1), nodeKey(3, 0)]);
	});
});

describe("TreeBuilder concurrency", () => {
	it.each([2, 8])("never has more than %d model calls at once and builds every node once", async limit => {
		const stub = makeHost();
		const builder = builderOf(stub, limit);
		const messages = 20;
		for (let i = 0; i < messages; i++) builder.messageLogged(longRow(i));
		await tick();
		expect(builder.running).toBe(limit);
		expect(stub.running).toBe(limit);
		// One answer at a time: each frees a slot that the next ready node takes at once.
		while (stub.pendingCalls.length > 0) {
			expect(stub.running).toBeLessThanOrEqual(limit);
			await stub.answerOne();
		}
		await builder.idle();
		expect(stub.maxRunning).toBe(limit);
		expect(stub.started.length).toBe(expectedNodes(messages));
		expect(stub.appended.length).toBe(expectedNodes(messages));
		expect(new Set(stub.appended).size).toBe(stub.appended.length);
		expect(builder.pending(stub.nodes.size)).toBe(0);
	});

	it("takes a raised concurrency at once", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		for (let i = 0; i < 6; i++) builder.messageLogged(longRow(i));
		await tick();
		expect(stub.running).toBe(1);
		builder.setConcurrency(4);
		await tick();
		expect(stub.running).toBe(4);
	});
});

describe("TreeBuilder leaf lookahead", () => {
	it("starts only the 8 oldest unbuilt messages, one more as each is built", async () => {
		expect(LEAF_LOOKAHEAD).toBe(8);
		const stub = makeHost();
		const builder = builderOf(stub, 32);
		for (let i = 0; i < 12; i++) builder.messageLogged(longRow(i));
		await tick();
		const leaves = () => stub.started.filter(key => key.startsWith("0:"));
		expect(leaves()).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(i => nodeKey(0, i)));
		// Answer the call for leaf 0 only.
		const first = stub.pendingCalls.findIndex(call => call.job.kind === "leaf" && call.job.i === 0);
		stub.pendingCalls.splice(first, 1)[0]?.resolve(LONG_NODE);
		await tick();
		expect(leaves()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => nodeKey(0, i)));
	});
});

describe("TreeBuilder failures", () => {
	it("keeps a failed leaf out of the queue until retryFailed, then calls again", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		stub.failNext.add(nodeKey(0, 0));
		builder.messageLogged(longRow(0));
		await tick();
		expect(builder.failed).toBe(1);
		expect(stub.failed.map(entry => entry.job)).toEqual([{ kind: "leaf", i: 0 }]);
		expect(stub.started).toEqual([nodeKey(0, 0)]);
		await builder.idle(); // a failed node is not eligible: idle
		expect(stub.nodes.has(nodeKey(0, 0))).toBe(false);

		builder.retryFailed();
		await tick();
		expect(builder.failed).toBe(0);
		expect(stub.started).toEqual([nodeKey(0, 0), nodeKey(0, 0)]);
		await stub.answerOne("second try");
		expect(stub.nodes.get(nodeKey(0, 0))?.text).toBe("second try");
	});

	it("does not let a failed node stop the others", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		stub.failNext.add(nodeKey(0, 1));
		for (let i = 0; i < 3; i++) builder.messageLogged(longRow(i));
		await stub.answerAll();
		expect(stub.nodes.has(nodeKey(0, 0))).toBe(true);
		expect(stub.nodes.has(nodeKey(0, 1))).toBe(false);
		expect(stub.nodes.has(nodeKey(0, 2))).toBe(true);
		expect(builder.failed).toBe(1);
		builder.retryFailed();
		await stub.answerAll();
		expect(stub.nodes.has(nodeKey(0, 1))).toBe(true);
		expect(builder.failed).toBe(0);
		expect(new Set(stub.appended).size).toBe(stub.appended.length);
	});

	it("retries a failed merge once, and builds the parent after it", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		stub.failNext.add(nodeKey(1, 0));
		for (let i = 0; i < 2; i++) builder.messageLogged(longRow(i));
		await stub.answerAll();
		expect(stub.started).toEqual([nodeKey(0, 0), nodeKey(0, 1), nodeKey(1, 0)]);
		expect(stub.failed.map(entry => entry.job)).toEqual([{ kind: "merge", l: 1, i: 0 }]);
		expect(builder.failed).toBe(1);
		builder.retryFailed();
		await stub.answerAll();
		expect(stub.started.filter(key => key === nodeKey(1, 0)).length).toBe(2);
		expect(stub.nodes.has(nodeKey(1, 0))).toBe(true);
		expect(builder.failed).toBe(0);
	});

	it("retries a short leaf whose append failed", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		stub.failAppend.add(nodeKey(0, 0));
		builder.messageLogged(messageRow(0, "short"));
		await tick();
		expect(stub.failed.length).toBe(1);
		expect(builder.failed).toBe(1);
		expect(stub.nodes.has(nodeKey(0, 0))).toBe(false);
		builder.retryFailed();
		await tick();
		expect(stub.nodes.get(nodeKey(0, 0))?.text).toBe("user: short");
		expect(builder.failed).toBe(0);
		expect(stub.started).toEqual([]);
	});

	it("retryFailed with nothing failed starts nothing", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 4);
		builder.retryFailed();
		await tick();
		expect(stub.started).toEqual([]);
	});
});

describe("TreeBuilder recover", () => {
	it("builds only the nodes that are missing", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 8);
		// Messages 0 to 3 and their level-1 node (1, 0) exist; messages 4 to 7 have nothing.
		for (let i = 0; i < 4; i++) stub.nodes.set(nodeKey(0, i), { l: 0, i, text: LONG_NODE, size: 300 });
		stub.nodes.set(nodeKey(1, 0), { l: 1, i: 0, text: LONG_NODE, size: 300 });
		const visit = (callback: (l: number, i: number) => void) => {
			for (const key of stub.nodes.keys()) {
				const [l, i] = key.split(":").map(Number);
				callback(l as number, i as number);
			}
		};
		const read: number[] = [];
		await builder.recover(8, visit, async i => {
			read.push(i);
			return longRow(i);
		});
		expect(read).toEqual([4, 5, 6, 7]);
		await stub.answerAll();
		expect(new Set(stub.started)).toEqual(
			new Set([
				nodeKey(0, 4),
				nodeKey(0, 5),
				nodeKey(0, 6),
				nodeKey(0, 7),
				nodeKey(1, 1),
				nodeKey(1, 2),
				nodeKey(1, 3),
				nodeKey(2, 0),
				nodeKey(2, 1),
				nodeKey(3, 0),
			]),
		);
		expect(stub.started.length).toBe(10);
		expect(stub.appended.length).toBe(10);
		expect(builder.pending(stub.nodes.size)).toBe(0);
	});

	it("builds nothing for a chat that is fully built", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 8);
		for (let i = 0; i < 2; i++) stub.nodes.set(nodeKey(0, i), { l: 0, i, text: LONG_NODE, size: 300 });
		stub.nodes.set(nodeKey(1, 0), { l: 1, i: 0, text: LONG_NODE, size: 300 });
		const visit = (callback: (l: number, i: number) => void) => {
			callback(0, 0);
			callback(0, 1);
			callback(1, 0);
		};
		await builder.recover(2, visit, async () => {
			throw new Error("no message is missing its node");
		});
		await builder.idle();
		expect(stub.started).toEqual([]);
		expect(builder.pending(3)).toBe(0);
	});

	it("builds the short missing leaves at once", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 8);
		await builder.recover(
			2,
			() => {},
			async i => messageRow(i, `s${i}`),
		);
		await tick();
		expect(stub.started).toEqual([]);
		expect(stub.nodes.get(nodeKey(1, 0))?.text).toBe("user: s0\nuser: s1");
	});
});

describe("TreeBuilder pending and waiting", () => {
	it("expectedNodes is the sum of floor(messages / 2^l)", () => {
		expect(expectedNodes(0)).toBe(0);
		expect(expectedNodes(1)).toBe(1);
		expect(expectedNodes(2)).toBe(3);
		expect(expectedNodes(3)).toBe(4);
		expect(expectedNodes(4)).toBe(7);
		expect(expectedNodes(20)).toBe(38);
	});

	it("counts the nodes a full tree has, less the ones built", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 2);
		expect(builder.pending(0)).toBe(0);
		for (let i = 0; i < 5; i++) builder.messageLogged(longRow(i));
		expect(builder.pending(0)).toBe(expectedNodes(5));
		await stub.answerOne();
		expect(builder.pending(stub.nodes.size)).toBe(expectedNodes(5) - 1);
		await stub.answerAll();
		expect(builder.pending(stub.nodes.size)).toBe(0);
		// Never negative.
		expect(builder.pending(100)).toBe(0);
	});

	it("whenLeavesBuilt resolves once every message before the count has its node", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		for (let i = 0; i < 3; i++) builder.messageLogged(longRow(i));
		let done = false;
		void builder.whenLeavesBuilt(2).then(() => {
			done = true;
		});
		await tick();
		expect(done).toBe(false);
		await stub.answerOne();
		expect(done).toBe(false);
		await stub.answerOne();
		expect(done).toBe(true);
	});

	it("whenLeavesBuilt is released by stop, and idle resolves when nothing waits", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		builder.messageLogged(longRow(0));
		let released = false;
		void builder.whenLeavesBuilt(1).then(() => {
			released = true;
		});
		await tick();
		expect(released).toBe(false);
		builder.stop();
		await tick();
		expect(released).toBe(true);
		await stub.answerAll();
		await builder.idle();
		expect(builder.running).toBe(0);
	});

	it("releases a waiter when the only unbuilt message before the count failed, and one that comes later", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		stub.failNext.add(nodeKey(0, 0));
		builder.messageLogged(longRow(0));
		let released = false;
		void builder.whenLeavesBuilt(1).then(() => {
			released = true;
		});
		await tick();
		expect(builder.failed).toBe(1);
		expect(released).toBe(true);
		// The failure is already on record: a turn that starts now does not wait for it either.
		await builder.whenLeavesBuilt(1);
	});

	it("keeps a waiter while an unbuilt message before the count is still being built", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 2);
		stub.failNext.add(nodeKey(0, 0));
		builder.messageLogged(longRow(0));
		builder.messageLogged(longRow(1));
		let released = false;
		void builder.whenLeavesBuilt(2).then(() => {
			released = true;
		});
		await tick();
		expect(builder.failed).toBe(1);
		expect(stub.pendingCalls.length).toBe(1);
		expect(released).toBe(false);
		await stub.answerOne();
		expect(released).toBe(true);
	});

	it("keeps a waiter for a message that is not started yet behind a failed one", async () => {
		const stub = makeHost();
		const builder = builderOf(stub, 1);
		stub.failNext.add(nodeKey(0, 0));
		builder.messageLogged(longRow(0));
		builder.messageLogged(longRow(1));
		let released = false;
		void builder.whenLeavesBuilt(2).then(() => {
			released = true;
		});
		await tick();
		expect(released).toBe(false);
		await stub.answerAll();
		expect(released).toBe(true);
		expect(builder.failed).toBe(1);
	});
});
