/**
 * Contract: compactNode asks the transport for one line of at most 512 bytes. The first call carries the task (with
 * its 512-dash ruler); while the reply is over the limit a "Too long" follow-up goes in the same conversation, with
 * the replies so far, up to 5 calls; the shortest reply wins. A failure or an empty reply after a reply returns the
 * best one; on the first call it throws. CacheGate makes a call whose cache key another call is writing wait until
 * that call's response starts; a key written within the TTL needs no waiting, a failed write leaves no trace.
 */
import { describe, expect, it } from "bun:test";
import {
	CacheGate,
	type CompactionCall,
	type CompactionHooks,
	type CompactionTransport,
	compactNode,
	type RenderedView,
} from "../../../src/personal/chat-tree/compactor";
import { NODE_MAX_BYTES, NODE_TRIES } from "../../../src/personal/chat-tree/constants";
import { leafTask, RULER, tooLongMessage } from "../../../src/personal/chat-tree/prompt";
import { utf8Size } from "../../../src/personal/chat-tree/text";

const VIEW: RenderedView = { blocks: ["<chat>\n0+1|user: a\n"], tail: "</chat>" };
const TASK = leafTask(3, "user", "a long message");

/** A reply of exactly `bytes` bytes. */
const reply = (bytes: number, char = "r") => char.repeat(bytes);

/** The text-line of a call as the transport saw it: the arrays are copied because compactNode goes on filling them. */
interface SeenCall {
	view: RenderedView;
	prefixKey: string;
	turns: string[];
	replies: string[];
	signal: AbortSignal | undefined;
}

/** A transport that answers with the given outcomes in turn: a string is a reply, an Error is a failure. */
function scripted(outcomes: (string | Error)[]): { transport: CompactionTransport; seen: SeenCall[] } {
	const seen: SeenCall[] = [];
	const transport: CompactionTransport = async (call: CompactionCall, hooks: CompactionHooks) => {
		seen.push({
			view: call.view,
			prefixKey: call.prefixKey,
			turns: [...call.turns],
			replies: [...call.replies],
			signal: hooks.signal,
		});
		const outcome = outcomes[seen.length - 1];
		if (outcome === undefined) throw new Error("the script has no more outcomes");
		if (outcome instanceof Error) throw outcome;
		return outcome;
	};
	return { transport, seen };
}

const input = (task = TASK) => ({ view: VIEW, prefixKey: "pk", task, gateKeys: ["head:m", "view:m:pk"] });

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe("compactNode", () => {
	it("sends the task, with its 512-dash ruler, as the first user turn", async () => {
		const { transport, seen } = scripted(["a short line"]);
		const out = await compactNode(transport, new CacheGate(), input());
		expect(out).toBe("a short line");
		expect(seen.length).toBe(1);
		expect(seen[0]?.turns).toEqual([TASK]);
		expect(seen[0]?.replies).toEqual([]);
		expect(seen[0]?.turns[0]).toContain(RULER);
		expect(seen[0]?.turns[0]).toContain("-".repeat(NODE_MAX_BYTES));
		expect(seen[0]?.view).toBe(VIEW);
		expect(seen[0]?.prefixKey).toBe("pk");
	});

	it("trims the reply and returns a reply of exactly the limit", async () => {
		const exact = reply(NODE_MAX_BYTES);
		const { transport, seen } = scripted([`  \n${exact}\n `]);
		expect(await compactNode(transport, new CacheGate(), input())).toBe(exact);
		expect(seen.length).toBe(1);
	});

	it("drops view-line heads the model copied, so they neither render twice nor count toward the limit", async () => {
		const { transport } = scripted(["4+1|2+2| user: renamed the repo; unii: done"]);
		expect(await compactNode(transport, new CacheGate(), input())).toBe("user: renamed the repo; unii: done");
		const { transport: plain } = scripted(["user: budget 4+1|5 euros"]);
		expect(await compactNode(plain, new CacheGate(), input())).toBe("user: budget 4+1|5 euros");
	});

	it("passes the abort signal to the transport", async () => {
		const controller = new AbortController();
		const { transport, seen } = scripted(["ok"]);
		await compactNode(transport, new CacheGate(), input(), controller.signal);
		expect(seen[0]?.signal).toBe(controller.signal);
	});

	it("follows a reply over the limit with 'Too long' in the same conversation, with the replies so far", async () => {
		const first = reply(NODE_MAX_BYTES + 40, "a");
		const second = reply(NODE_MAX_BYTES + 10, "b");
		const { transport, seen } = scripted([first, second, "fits"]);
		const out = await compactNode(transport, new CacheGate(), input());
		expect(out).toBe("fits");
		expect(seen.map(call => call.turns.length)).toEqual([1, 2, 3]);
		expect(seen[1]?.replies).toEqual([first]);
		expect(seen[1]?.turns).toEqual([TASK, tooLongMessage(first, utf8Size(first))]);
		expect(seen[2]?.replies).toEqual([first, second]);
		expect(seen[2]?.turns).toEqual([
			TASK,
			tooLongMessage(first, utf8Size(first)),
			tooLongMessage(second, utf8Size(second)),
		]);
		expect(seen[1]?.turns[1]).toContain(`${NODE_MAX_BYTES + 40} bytes`);
		// Every call is made on the same view.
		expect(seen.every(call => call.view === VIEW && call.prefixKey === "pk")).toBe(true);
	});

	it("measures bytes, not characters", async () => {
		// 200 characters of 3 bytes each: 600 bytes.
		const wide = "あ".repeat(200);
		const { transport, seen } = scripted([wide, "ok"]);
		expect(await compactNode(transport, new CacheGate(), input())).toBe("ok");
		expect(seen.length).toBe(2);
		expect(seen[1]?.turns[1]).toContain("600 bytes");
	});

	it("makes at most five calls and keeps the shortest reply", async () => {
		expect(NODE_TRIES).toBe(5);
		const sizes = [700, 650, 600, 620, 640];
		const replies = sizes.map((size, k) => reply(size, String.fromCharCode(97 + k)));
		const { transport, seen } = scripted([...replies, reply(NODE_MAX_BYTES, "z")]);
		const out = await compactNode(transport, new CacheGate(), input());
		expect(seen.length).toBe(5);
		expect(out).toBe(replies[2] as string);
		expect(utf8Size(out)).toBe(600);
	});

	it("keeps the first reply when no later one is shorter", async () => {
		const replies = [600, 700, 800, 900, 1000].map((size, k) => reply(size, String.fromCharCode(97 + k)));
		const { transport, seen } = scripted(replies);
		expect(await compactNode(transport, new CacheGate(), input())).toBe(replies[0] as string);
		expect(seen.length).toBe(5);
	});

	it("returns the best reply when a later call fails", async () => {
		const first = reply(NODE_MAX_BYTES + 30);
		const { transport, seen } = scripted([first, new Error("provider down")]);
		expect(await compactNode(transport, new CacheGate(), input())).toBe(first);
		expect(seen.length).toBe(2);
	});

	it("returns the best reply when a later call answers with nothing", async () => {
		const first = reply(NODE_MAX_BYTES + 30);
		const { transport } = scripted([first, "  \n "]);
		expect(await compactNode(transport, new CacheGate(), input())).toBe(first);
	});

	it("throws when the first call fails", async () => {
		const failure = new Error("no network");
		const { transport, seen } = scripted([failure]);
		await expect(compactNode(transport, new CacheGate(), input())).rejects.toBe(failure);
		expect(seen.length).toBe(1);
	});

	it("throws when the first reply is empty", async () => {
		const { transport, seen } = scripted(["   "]);
		await expect(compactNode(transport, new CacheGate(), input())).rejects.toThrow("empty");
		expect(seen.length).toBe(1);
	});

	it("makes a compaction wait for another that is writing the same cache prefix", async () => {
		const gate = new CacheGate();
		const events: string[] = [];
		const firstStarts = Promise.withResolvers<void>();
		const firstEnds = Promise.withResolvers<void>();
		const first: CompactionTransport = async (_call, hooks) => {
			events.push("first:call");
			await firstStarts.promise;
			hooks.onResponseStart();
			events.push("first:response");
			await firstEnds.promise;
			return "one";
		};
		const second: CompactionTransport = async () => {
			events.push("second:call");
			return "two";
		};
		const a = compactNode(first, gate, input());
		const b = compactNode(second, gate, input());
		await tick();
		expect(events).toEqual(["first:call"]);
		firstStarts.resolve();
		await tick();
		expect(events).toEqual(["first:call", "first:response", "second:call"]);
		expect(await b).toBe("two");
		firstEnds.resolve();
		expect(await a).toBe("one");
	});
});

describe("CacheGate", () => {
	/** A call that stays open until `start()` (its response begins) and `end()` (it finishes, or fails with `end(error)`). */
	function openCall(gate: CacheGate, keys: string[], events: string[], name: string) {
		const started = Promise.withResolvers<void>();
		const ended = Promise.withResolvers<void>();
		const done = gate.run(keys, async hooks => {
			events.push(`${name}:call`);
			await started.promise;
			hooks.onResponseStart();
			events.push(`${name}:response`);
			await ended.promise;
			events.push(`${name}:end`);
			return name;
		});
		return { done, start: () => started.resolve(), end: () => ended.resolve() };
	}

	it("runs a call at once when nobody writes its keys", async () => {
		const gate = new CacheGate();
		expect(await gate.run(["a", "b"], async () => 42)).toBe(42);
	});

	it("holds a call whose key another call is writing until that call's onResponseStart", async () => {
		const gate = new CacheGate();
		const events: string[] = [];
		const first = openCall(gate, ["k"], events, "first");
		const second = openCall(gate, ["k"], events, "second");
		await tick();
		expect(events).toEqual(["first:call"]);
		first.start();
		await tick();
		// The second call goes while the first is still running: its response began, the prefix is written.
		expect(events).toEqual(["first:call", "first:response", "second:call"]);
		second.start();
		first.end();
		second.end();
		expect(await first.done).toBe("first");
		expect(await second.done).toBe("second");
	});

	it("does not hold a call whose keys nobody writes", async () => {
		const gate = new CacheGate();
		const events: string[] = [];
		const first = openCall(gate, ["k1"], events, "first");
		const second = openCall(gate, ["k2"], events, "second");
		await tick();
		expect(events).toEqual(["first:call", "second:call"]);
		for (const call of [first, second]) {
			call.start();
			call.end();
		}
		await Promise.all([first.done, second.done]);
	});

	it("holds a call that shares any one key with a writer", async () => {
		const gate = new CacheGate();
		const events: string[] = [];
		const first = openCall(gate, ["head", "view1"], events, "first");
		const second = openCall(gate, ["head", "view2"], events, "second");
		await tick();
		expect(events).toEqual(["first:call"]);
		first.start();
		await tick();
		expect(events).toContain("second:call");
		second.start();
		first.end();
		second.end();
		await Promise.all([first.done, second.done]);
	});

	it("releases the waiting calls when the writer ends without a response start", async () => {
		const gate = new CacheGate();
		const events: string[] = [];
		const writer = Promise.withResolvers<void>();
		const first = gate.run(["k"], async () => {
			events.push("writer:call");
			await writer.promise;
			return "w";
		});
		const second = gate.run(["k"], async () => {
			events.push("second:call");
		});
		await tick();
		expect(events).toEqual(["writer:call"]);
		writer.resolve();
		await first;
		await second;
		expect(events).toEqual(["writer:call", "second:call"]);
	});

	it("releases the waiting calls when the writer fails", async () => {
		const gate = new CacheGate();
		const events: string[] = [];
		const fail = Promise.withResolvers<void>();
		const writer = gate.run(["k"], async () => {
			events.push("writer:call");
			await fail.promise;
			throw new Error("write failed");
		});
		const writerFailure = writer.catch((error: Error) => error.message);
		const waiting = gate.run(["k"], async () => {
			events.push("waiting:call");
		});
		await tick();
		expect(events).toEqual(["writer:call"]);
		fail.resolve();
		expect(await writerFailure).toBe("write failed");
		await waiting;
		expect(events).toEqual(["writer:call", "waiting:call"]);
	});

	it("does not remember a failed write as cached: the next call writes and holds the one after", async () => {
		const gate = new CacheGate();
		await expect(
			gate.run(["k"], async () => {
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");
		const events: string[] = [];
		const first = openCall(gate, ["k"], events, "first");
		const second = openCall(gate, ["k"], events, "second");
		await tick();
		expect(events).toEqual(["first:call"]);
		first.start();
		second.start();
		first.end();
		second.end();
		await Promise.all([first.done, second.done]);
	});

	it("remembers a written key for the TTL: a call within it does not hold the next one back", async () => {
		let now = 1_000_000;
		const gate = new CacheGate({ now: () => now, ttlMs: 60_000 });
		await gate.run(["k"], async hooks => {
			hooks.onResponseStart();
		});

		now += 59_000;
		const events: string[] = [];
		const first = openCall(gate, ["k"], events, "first");
		const second = openCall(gate, ["k"], events, "second");
		await tick();
		expect(events).toEqual(["first:call", "second:call"]);
		for (const call of [first, second]) {
			call.start();
			call.end();
		}
		await Promise.all([first.done, second.done]);
	});

	it("refreshes the lifetime of a key each time it is used", async () => {
		let now = 0;
		const gate = new CacheGate({ now: () => now, ttlMs: 60_000 });
		await gate.run(["k"], async () => {});
		// Used every 40 s: still cached after 120 s in all.
		for (let round = 0; round < 3; round++) {
			now += 40_000;
			await gate.run(["k"], async () => {});
		}
		const events: string[] = [];
		const first = openCall(gate, ["k"], events, "first");
		const second = openCall(gate, ["k"], events, "second");
		await tick();
		expect(events).toEqual(["first:call", "second:call"]);
		for (const call of [first, second]) {
			call.start();
			call.end();
		}
		await Promise.all([first.done, second.done]);
	});

	it("writes again, and holds the next call back, once the TTL has passed", async () => {
		let now = 1_000_000;
		const gate = new CacheGate({ now: () => now, ttlMs: 60_000 });
		await gate.run(["k"], async hooks => {
			hooks.onResponseStart();
		});

		now += 60_000;
		const events: string[] = [];
		const first = openCall(gate, ["k"], events, "first");
		const second = openCall(gate, ["k"], events, "second");
		await tick();
		expect(events).toEqual(["first:call"]);
		first.start();
		await tick();
		expect(events).toEqual(["first:call", "first:response", "second:call"]);
		second.start();
		first.end();
		second.end();
		await Promise.all([first.done, second.done]);
	});

	it("lets a call end without onResponseStart: it counts as written", async () => {
		const gate = new CacheGate();
		await gate.run(["k"], async () => "no start signal");
		const events: string[] = [];
		const first = openCall(gate, ["k"], events, "first");
		const second = openCall(gate, ["k"], events, "second");
		await tick();
		expect(events).toEqual(["first:call", "second:call"]);
		for (const call of [first, second]) {
			call.start();
			call.end();
		}
		await Promise.all([first.done, second.done]);
	});

	it("takes a second onResponseStart as a no-op", async () => {
		const gate = new CacheGate();
		const result = await gate.run(["k"], async hooks => {
			hooks.onResponseStart();
			hooks.onResponseStart();
			return "ok";
		});
		expect(result).toBe("ok");
	});
});
