import { describe, expect, it } from "bun:test";
import { NOT_SUMMARIZED_TEXT } from "../../../src/personal/chat-tree/constants";
import type { NodeRef } from "../../../src/personal/chat-tree/types";
import {
	ChatView,
	renderViewBlocks,
	renderViewLine,
	type ViewHost,
	type ViewLimits,
	viewLineBytes,
} from "../../../src/personal/chat-tree/view";

/** A host where the leaves in `leaves` (default: all) and the parents in `parents` (default: all) are built. */
class FakeHost implements ViewHost {
	size = 100;
	sizes = new Map<string, number>();
	/** Leaves not built yet; every other leaf is built. */
	unbuiltLeaves = new Set<number>();
	/** When set, only these (l>0) nodes are built; otherwise every l>0 node is. */
	builtParents: Set<string> | undefined;

	isBuilt(l: number, i: number): boolean {
		if (l === 0) return !this.unbuiltLeaves.has(i);
		return this.builtParents === undefined || this.builtParents.has(`${l}:${i}`);
	}

	nodeSize(l: number, i: number): number {
		return this.sizes.get(`${l}:${i}`) ?? this.size;
	}
}

function recomputeBytes(view: ChatView, host: ViewHost): number {
	let total = 0;
	for (const ref of view.entries) {
		const unbuilt = ref[0] === 0 && !host.isBuilt(0, ref[1]);
		total += viewLineBytes(ref, unbuilt ? undefined : host.nodeSize(ref[0], ref[1]));
	}
	return total;
}

function snapshot(view: ChatView): string {
	return JSON.stringify(view.entries);
}

// ---- Taelin's rollback push (spec §3.1), ported to TypeScript ----

interface PushList {
	keep: number;
	life: number;
	state: number;
	older: PushList | null;
}

function push(newState: number, states: PushList | null): PushList {
	if (states === null) return { keep: 0, life: 0, state: newState, older: null };
	const { keep, life, state, older } = states;
	if (keep === 0) return { keep: 1, life, state, older };
	if (life > 0) return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
	return { keep: 0, life, state: newState, older: push(state, older) };
}

/** The push list (newest first, states = start ticks) as view refs, oldest first, with `now` messages covered. */
function pushRefs(list: PushList, now: number): [number, number][] {
	const starts: number[] = [];
	for (let node: PushList | null = list; node !== null; node = node.older) starts.push(node.state);
	const refs: [number, number][] = [];
	for (let k = 0; k < starts.length; k++) {
		const end = k === 0 ? now : starts[k - 1];
		const n = end - starts[k];
		const l = Math.log2(n);
		if (!Number.isInteger(l) || starts[k] % n !== 0) throw new Error(`push line ${starts[k]}+${n} is not a node`);
		refs.push([l, starts[k] / n]);
	}
	return refs.reverse();
}

/** A due as a fraction `num / den`, `den` a power of two. */
type Due = (l: number, i: number, total: number) => { num: number; den: number };

/** Test-local list simulation: after each push, merge the most due adjacent pair until the list is as long as push's. */
function simulate(
	due: Due,
	steps: number,
	onStep: (t: number, entries: [number, number][], expected: [number, number][]) => void,
) {
	let list: PushList | null = null;
	let entries: [number, number][] = [];
	for (let t = 0; t < steps; t++) {
		list = push(t, list);
		const expected = pushRefs(list, t + 1);
		entries.push([0, t]);
		while (entries.length > expected.length) {
			let best = -1;
			let bestDue = { num: 0, den: 1 };
			for (let k = 0; k + 1 < entries.length; k++) {
				const [l, i] = entries[k];
				if (entries[k + 1][0] !== l || i % 2 !== 0 || entries[k + 1][1] !== i + 1) continue;
				const d = due(l, i, t + 1);
				if (best < 0 || d.num * bestDue.den > bestDue.num * d.den) {
					best = k;
					bestDue = d;
				}
			}
			if (best < 0) throw new Error(`no pair to merge at t=${t}`);
			const [l, i] = entries[best];
			entries = [...entries.slice(0, best), [l + 1, i / 2], ...entries.slice(best + 2)];
		}
		onStep(t, entries, expected);
	}
}

const LIMITS: ViewLimits = { high: 1 << 30, low: 1 << 29 };

describe("ChatView order versus Taelin's push", () => {
	it("reproduces push at every t = 0..20000 (T = messages after the push)", () => {
		const host = new FakeHost();
		host.size = 1;
		const view = new ChatView(host, LIMITS);
		let list: PushList | null = null;
		for (let t = 0; t <= 20_000; t++) {
			list = push(t, list);
			const expected = pushRefs(list, t + 1);
			view.append(t);
			// Every merge shrinks the bytes (a parent line is shorter than its two children), so each call does one.
			while (view.entries.length > expected.length) {
				expect(view.mergeDown(view.bytes - 1)).toBe(1);
			}
			if (snapshot(view) !== JSON.stringify(expected)) {
				throw new Error(`first mismatch at t=${t}: view ${snapshot(view)} but push ${JSON.stringify(expected)}`);
			}
			expect(view.messages).toBe(t + 1);
		}
		expect(view.bytes).toBe(recomputeBytes(view, host));
	});

	it("measuring from the first message does not reproduce push", () => {
		const host = new FakeHost();
		const view = ChatView.parse(host, LIMITS, [
			[2, 0],
			[2, 1],
			[0, 8],
			[0, 9],
		]);
		expect(view.messages).toBe(10);
		// The real order merges 8+1 and 9+1.
		expect(view.mergeDown(view.bytes - 1)).toBe(1);
		expect(snapshot(view)).toBe(
			JSON.stringify([
				[2, 0],
				[2, 1],
				[1, 4],
			]),
		);

		// The first-based variant picks 0+4 and 4+4.
		const dueFirst: Due = (l, i, total) => ({ num: total - i * 2 ** l, den: 2 ** (l + 2) });
		const old = dueFirst(2, 0, 10);
		const recent = dueFirst(0, 8, 10);
		expect(old.num * recent.den).toBeGreaterThan(recent.num * old.den);

		let matches = 0;
		simulate(dueFirst, 20_001, (_t, entries, expected) => {
			if (JSON.stringify(entries) === JSON.stringify(expected)) matches++;
		});
		expect(matches, `first-based order matches push at ${matches} of 20001 steps`).toBeLessThan(20_001);

		// The same simulation with the real due matches at every step.
		let realMatches = 0;
		const dueLast: Due = (l, i, total) => ({ num: total - ((i + 2) * 2 ** l - 1), den: 2 ** l });
		simulate(dueLast, 20_001, (_t, entries, expected) => {
			if (JSON.stringify(entries) === JSON.stringify(expected)) realMatches++;
		});
		expect(realMatches).toBe(20_001);
	});
});

describe("ChatView sawtooth", () => {
	it("grows by one line between batches and each batch reaches low", () => {
		const host = new FakeHost();
		const limits = { high: 10_000, low: 5_000 };
		const view = new ChatView(host, limits);
		let crossings = 0;
		for (let t = 0; t < 3000; t++) {
			const before = view.entries.map((ref): NodeRef => [ref[0], ref[1]]);
			view.append(t);
			const overHigh = view.bytes > limits.high;
			const merges = view.settle();
			expect(view.bytes).toBeLessThanOrEqual(limits.high);
			expect(view.bytes).toBe(recomputeBytes(view, host));
			if (overHigh) {
				crossings++;
				expect(merges).toBeGreaterThan(0);
				expect(view.bytes).toBeLessThanOrEqual(limits.low);
				expect(view.merging).toBe(false);
			} else {
				expect(merges).toBe(0);
				expect(view.entries.slice(0, before.length)).toEqual(before);
				expect(view.entries.length).toBe(before.length + 1);
			}
		}
		expect(crossings).toBeGreaterThan(3);
		expect(view.messages).toBe(3000);
	});

	it("merges only pairs whose parent is built, stays merging, and continues later", () => {
		const host = new FakeHost();
		host.builtParents = new Set();
		const limits = { high: 6_000, low: 2_000 };
		const view = new ChatView(host, limits);
		let t = 0;
		while (view.bytes <= limits.high) view.append(t++);
		expect(view.merging).toBe(false);

		// No parent is built: nothing to merge, the view stays in the merging state.
		expect(view.settle()).toBe(0);
		expect(view.merging).toBe(true);
		const stuck = snapshot(view);
		expect(view.settle()).toBe(0);
		expect(snapshot(view)).toBe(stuck);
		expect(view.merging).toBe(true);

		// Only a few level-1 parents are built: those merge, and the view is still over low.
		for (let j = 0; j < 5; j++) host.builtParents.add(`1:${j}`);
		expect(view.settle()).toBe(5);
		expect(view.merging).toBe(true);
		expect(view.bytes).toBeGreaterThan(limits.low);
		expect(view.bytes).toBe(recomputeBytes(view, host));
		for (let j = 0; j < 5; j++) expect(view.entries[j]).toEqual([1, j]);

		// A new message while merging appends, then settle goes on (nothing eligible yet).
		view.append(t++);
		expect(view.settle()).toBe(0);
		expect(view.merging).toBe(true);

		// Everything becomes built: one settle reaches low and ends the merging state.
		host.builtParents = undefined;
		expect(view.settle()).toBeGreaterThan(0);
		expect(view.bytes).toBeLessThanOrEqual(limits.low);
		expect(view.merging).toBe(false);
		expect(view.bytes).toBe(recomputeBytes(view, host));
		expect(view.settle()).toBe(0);
	});

	it("mergeDown does not touch the merging state and stops when nothing is eligible", () => {
		const host = new FakeHost();
		host.builtParents = new Set(["1:0"]);
		const view = new ChatView(host, { high: 1 << 30, low: 1 << 29 });
		for (let t = 0; t < 8; t++) view.append(t);
		expect(view.mergeDown(0)).toBe(1);
		expect(view.merging).toBe(false);
		expect(view.entries[0]).toEqual([1, 0]);
		expect(view.entries.length).toBe(7);
	});

	it("merges the most due pair, and the oldest of equal ones", () => {
		const host = new FakeHost();
		const view = ChatView.parse(host, LIMITS, [
			[1, 0],
			[1, 1],
			[0, 4],
			[0, 5],
			[0, 6],
			[0, 7],
		]);
		// T=8: [1,0]+[1,1]: last=3, due (8-3)/2=2.5; [0,4]+[0,5]: last=5, due 3; [0,6]+[0,7]: last=7, due 1.
		expect(view.mergeDown(view.bytes - 1)).toBe(1);
		expect(snapshot(view)).toBe(
			JSON.stringify([
				[1, 0],
				[1, 1],
				[1, 2],
				[0, 6],
				[0, 7],
			]),
		);
		const tie = ChatView.parse(host, LIMITS, [
			[2, 0],
			[2, 1],
			[1, 4],
			[1, 5],
			[0, 12],
			[0, 13],
			[0, 14],
		]);
		// T=15. [2,0]+[2,1]: last=7, due 8/4=2. [1,4]+[1,5]: last=11, due 4/2=2. [0,12]+[0,13]: last=13, due 2.
		// All three tie at 2: the oldest, 0+4 and 4+4, merges.
		expect(tie.messages).toBe(15);
		expect(tie.mergeDown(tie.bytes - 1)).toBe(1);
		expect(tie.entries[0]).toEqual([3, 0]);
	});
});

describe("ChatView persistence", () => {
	it("round-trips through toJSON and parse and then continues identically", () => {
		const host = new FakeHost();
		const limits = { high: 8_000, low: 4_000 };
		const live = new ChatView(host, limits);
		let t = 0;
		for (; t < 700; t++) {
			live.append(t);
			live.settle();
		}
		while (live.merging) {
			live.append(t++);
			live.settle();
		}
		const loaded = ChatView.parse(host, limits, JSON.parse(JSON.stringify(live.toJSON())));
		expect(loaded.entries).toEqual(live.entries);
		expect(loaded.bytes).toBe(live.bytes);
		expect(loaded.messages).toBe(live.messages);
		expect(loaded.bytes).toBe(recomputeBytes(loaded, host));

		for (let k = 0; k < 600; k++, t++) {
			live.append(t);
			loaded.append(t);
			expect(loaded.settle()).toBe(live.settle());
			expect(snapshot(loaded)).toBe(snapshot(live));
			expect(loaded.bytes).toBe(live.bytes);
		}
	});

	it("rejects invalid view.json", () => {
		const host = new FakeHost();
		const parse = (json: unknown) => () => ChatView.parse(host, LIMITS, json);
		expect(
			parse([
				[0, 0],
				[0, 2],
			]),
		).toThrow(/gap/);
		expect(parse([[0, 1]])).toThrow(/gap/);
		expect(
			parse([
				[1, 0],
				[0, 1],
			]),
		).toThrow(/overlap/);
		expect(
			parse([
				[0, 0],
				[0, 0],
			]),
		).toThrow(/overlap/);
		expect(
			parse([
				[0, 0],
				[1, 0.5],
			]),
		).toThrow(/aligned/);
		expect(parse([[0, -1]])).toThrow(/aligned/);
		expect(parse([[-1, 0]])).toThrow();
		expect(parse("x")).toThrow();
		expect(parse(null)).toThrow();
		expect(parse({ 0: [0, 0] })).toThrow();
		expect(parse(5)).toThrow();
		expect(parse([[0]])).toThrow();
		expect(parse([[0, 0, 1]])).toThrow();
		expect(parse([["0", 0]])).toThrow();
		expect(parse([0])).toThrow();
	});

	it("accepts the empty view and covers messages from 0", () => {
		const host = new FakeHost();
		const empty = ChatView.parse(host, LIMITS, []);
		expect(empty.messages).toBe(0);
		expect(empty.bytes).toBe(0);
		expect(() => empty.append(1)).toThrow();
		empty.append(0);
		expect(empty.messages).toBe(1);
		const view = ChatView.parse(host, LIMITS, [
			[3, 0],
			[2, 2],
			[0, 12],
		]);
		expect(view.messages).toBe(13);
		expect(() => view.append(12)).toThrow();
		expect(() => view.append(14)).toThrow();
		view.append(13);
		expect(view.toJSON()).toEqual([
			[3, 0],
			[2, 2],
			[0, 12],
			[0, 13],
		]);
	});

	it("copy gives an independent view with other limits and merging reset", () => {
		const host = new FakeHost();
		host.builtParents = new Set();
		const view = new ChatView(host, { high: 1_000, low: 500 });
		for (let t = 0; t < 20; t++) view.append(t);
		view.settle();
		expect(view.merging).toBe(true);
		const copy = view.copy({ high: 10_000, low: 5_000 });
		expect(copy.merging).toBe(false);
		expect(copy.entries).toEqual(view.entries);
		expect(copy.bytes).toBe(view.bytes);
		copy.append(20);
		expect(view.messages).toBe(20);
		expect(copy.messages).toBe(21);
	});
});

describe("ChatView.builtPrefix", () => {
	it("stops at the first unbuilt leaf and never includes an entry ending after endExclusive", () => {
		const host = new FakeHost();
		const view = ChatView.parse(host, LIMITS, [
			[2, 0],
			[1, 2],
			[0, 6],
			[0, 7],
			[0, 8],
		]);
		host.unbuiltLeaves.add(7);
		expect(view.builtPrefix(9)).toEqual([
			[2, 0],
			[1, 2],
			[0, 6],
		]);
		expect(view.builtPrefix(100)).toEqual([
			[2, 0],
			[1, 2],
			[0, 6],
		]);
		expect(view.builtPrefix(7)).toEqual([
			[2, 0],
			[1, 2],
			[0, 6],
		]);
		expect(view.builtPrefix(6)).toEqual([
			[2, 0],
			[1, 2],
		]);
		expect(view.builtPrefix(5)).toEqual([[2, 0]]);
		expect(view.builtPrefix(4)).toEqual([[2, 0]]);
		expect(view.builtPrefix(3)).toEqual([]);
		expect(view.builtPrefix(0)).toEqual([]);

		host.unbuiltLeaves.delete(7);
		expect(view.builtPrefix(8)).toEqual([
			[2, 0],
			[1, 2],
			[0, 6],
			[0, 7],
		]);
		expect(view.builtPrefix(100)).toEqual([...view.entries]);

		host.unbuiltLeaves.add(6);
		expect(view.builtPrefix(100)).toEqual([
			[2, 0],
			[1, 2],
		]);
		for (let end = 0; end <= 12; end++) {
			for (const ref of view.builtPrefix(end)) expect((ref[1] + 1) * 2 ** ref[0]).toBeLessThanOrEqual(end);
		}
	});
});

describe("renderViewBlocks and lines", () => {
	const text = (ref: NodeRef) => `text of ${ref[0]}:${ref[1]}`;
	const refs = (count: number): NodeRef[] => Array.from({ length: count }, (_, i) => [0, i] as const);

	it("groups lines by 4 with the tail holding the rest", () => {
		for (const count of [0, 1, 3, 4, 5, 8, 10]) {
			const { blocks, tail } = renderViewBlocks(refs(count), text);
			expect(blocks.length).toBe(Math.floor(count / 4));
			for (const block of blocks) expect(block.split("\n").length - 1).toBe(4 + (block === blocks[0] ? 1 : 0));
			const all = refs(count).map(ref => `${renderViewLine(ref, text(ref))}\n`);
			expect(blocks.join("") + tail).toBe(`<chat>\n${all.join("")}</chat>`);
			expect(tail.endsWith("</chat>")).toBe(true);
			expect(tail.split("\n").length - 1).toBeLessThanOrEqual(3 + (count < 4 ? 1 : 0));
		}
		const four = renderViewBlocks(refs(4), text);
		expect(four.blocks.length).toBe(1);
		expect(four.blocks[0].startsWith("<chat>\n0+1|text of 0:0\n")).toBe(true);
		expect(four.tail).toBe("</chat>");
	});

	it("renders the empty view", () => {
		expect(renderViewBlocks([], text)).toEqual({ blocks: [], tail: "<chat>\n</chat>" });
	});

	it("keeps block k identical when more lines are appended", () => {
		const short = renderViewBlocks(refs(9), text);
		const long = renderViewBlocks(refs(30), text);
		expect(short.blocks.length).toBe(2);
		expect(long.blocks.slice(0, 2)).toEqual(short.blocks);
		expect(long.blocks.length).toBe(7);
	});

	it("turns newlines into single spaces and keeps the byte size", () => {
		const raw = "caf\u00e9 \u{1F600}\r\nline two\nthree\r";
		const line = renderViewLine([3, 5], raw);
		expect(line).toBe("40+8|caf\u00e9 \u{1F600}  line two three ");
		expect(line).not.toMatch(/[\r\n]/);
		expect(Buffer.byteLength(line) + 1).toBe(viewLineBytes([3, 5], Buffer.byteLength(raw)));
		expect(viewLineBytes([0, 0], Buffer.byteLength("\u00e9\u{1F600}"))).toBe("0+1|".length + 2 + 4 + 1);
		const { blocks, tail } = renderViewBlocks([[3, 5]], () => raw);
		expect(blocks).toEqual([]);
		expect(tail).toBe(`<chat>\n${line}\n</chat>`);
	});

	it("renders the placeholder line for an unbuilt leaf", () => {
		expect(renderViewLine([0, 12], undefined)).toBe(`12+1|${NOT_SUMMARIZED_TEXT}`);
		expect(viewLineBytes([0, 12], undefined)).toBe(Buffer.byteLength(renderViewLine([0, 12], undefined)) + 1);
		const { tail } = renderViewBlocks([[0, 0]], () => undefined);
		expect(tail).toBe(`<chat>\n0+1|${NOT_SUMMARIZED_TEXT}\n</chat>`);
	});
});

describe("ChatView.leafBuilt", () => {
	it("refreshes the byte size of a leaf that became built", () => {
		const host = new FakeHost();
		for (let i = 0; i < 10; i++) host.unbuiltLeaves.add(i);
		const view = new ChatView(host, LIMITS);
		for (let t = 0; t < 10; t++) view.append(t);
		expect(view.bytes).toBe(recomputeBytes(view, host));
		const placeholderBytes = view.bytes;

		host.unbuiltLeaves.delete(7);
		host.sizes.set("0:7", 300);
		view.leafBuilt(7);
		expect(view.bytes).toBe(recomputeBytes(view, host));
		expect(view.bytes).toBe(placeholderBytes + 300 - Buffer.byteLength(NOT_SUMMARIZED_TEXT));

		host.unbuiltLeaves.delete(0);
		host.sizes.set("0:0", 5);
		view.leafBuilt(0);
		expect(view.bytes).toBe(recomputeBytes(view, host));

		// Absent leaf (not yet appended, or merged away): no-op.
		const before = view.bytes;
		view.leafBuilt(99);
		expect(view.bytes).toBe(before);
		host.unbuiltLeaves.delete(1);
		view.leafBuilt(1);
		view.mergeDown(0);
		expect(view.entries.some(ref => ref[0] === 0 && ref[1] === 1)).toBe(false);
		const merged = view.bytes;
		view.leafBuilt(1);
		expect(view.bytes).toBe(merged);
		expect(view.bytes).toBe(recomputeBytes(view, host));
	});
});
