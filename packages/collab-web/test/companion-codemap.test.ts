import { describe, expect, it } from "bun:test";
import type { FlowEdge, FlowNode, GraphEdge, GraphFile } from "@oh-my-pi/pi-coding-agent/codemap/index";
import {
	buildGraphIndex,
	checkFocus,
	dirView,
	fileView,
	flowWalk,
	resolveSymbol,
	searchHits,
} from "../scripts/companion-codemap";

function file(rel: string, lang = "rust", symbols = 1): GraphFile {
	return { rel, lang, symbols };
}

function edge(from: string, to: string, weight = 1, label = "references"): GraphEdge {
	return { from, to, weight, label, bridge: label !== "references" };
}

function sym(id: number, name: string, over: Partial<FlowNode> = {}): FlowNode {
	return {
		id,
		path: "src/a.rs",
		rel: "src/a.rs",
		lang: "rust",
		kind: "function",
		name,
		signature: `fn ${name}()`,
		startLine: id * 10,
		endLine: id * 10 + 5,
		...over,
	};
}

function hop(to: FlowNode, label: string, rank = 2): FlowEdge {
	return { to, label, rank };
}

const files = [
	file("core/a.rs", "rust", 5),
	file("core/sub/b.rs", "rust", 2),
	file("core/sub/c.rs", "rust", 1),
	file("core/other/x/y.rs", "rust", 1),
	file("contracts/E.sol", "sol", 4),
	file("contracts/deep/F.sol", "sol", 1),
	file("app/main.ts", "ts", 2),
	file("top.rs", "rust", 1),
];
const edges = [
	edge("core/a.rs", "contracts/E.sol", 2, "calls contract"),
	edge("core/sub/b.rs", "contracts/deep/F.sol", 1, "calls contract"),
	edge("app/main.ts", "core/a.rs", 3),
	edge("core/a.rs", "core/sub/b.rs", 4),
	edge("core/a.rs", "core/sub/c.rs", 3),
	edge("core/sub/b.rs", "core/sub/c.rs", 9),
	edge("core/sub/c.rs", "core/a.rs", 2),
	edge("core/sub/b.rs", "top.rs", 5),
	edge("top.rs", "core/sub/c.rs", 1),
	edge("core/sub/b.rs", "core/other/x/y.rs", 1, "decodes"),
	edge("core/sub/c.rs", "core/other/x/y.rs", 1),
];
const graph = buildGraphIndex(files, edges);
const noSymbols = { fileSymbols: () => [] };

describe("dirView links", () => {
	const view = dirView(graph, "repo", "core/sub", 0);

	it("rolls an outside file up to the folder branching off the shared ancestor, or keeps it a file", () => {
		const down = [...new Set(view.downstream.map(l => `${l.node.kind}:${l.node.path}`))].sort();
		// contracts/deep/F.sol is deeper in another branch of "" → folder "contracts"; top.rs sits in the
		// shared root → stays a file; core/a.rs sits in the shared "core" → stays a file; core/other/x/y.rs
		// is deeper under "core" → folder "core/other".
		expect(down).toEqual(["dir:contracts", "dir:core/other", "file:core/a.rs", "file:top.rs"]);
	});

	it("leaves out edges between files inside the folder", () => {
		const paths = [...view.upstream, ...view.downstream].map(l => l.node.path);
		expect(paths.some(p => p.startsWith("core/sub/"))).toBe(false);
	});

	it("reads upstream links with the inverse label and downstream with the edge's own", () => {
		const byPath = (links: typeof view.upstream, p: string) => links.find(l => l.node.path === p);
		expect(byPath(view.downstream, "contracts")).toMatchObject({
			label: "calls contract",
			weight: 1,
			bridge: true,
		});
		expect(byPath(view.downstream, "core/a.rs")).toMatchObject({ label: "references", weight: 2, bridge: false });
		expect(byPath(view.upstream, "core/a.rs")).toMatchObject({ label: "referenced by", weight: 7, bridge: false });
		expect(byPath(view.upstream, "top.rs")).toMatchObject({ label: "referenced by", weight: 1 });
	});

	it("sums edges sharing a rolled-up node and label, and keeps bridge links apart from plain ones", () => {
		const other = view.downstream.filter(l => l.node.path === "core/other");
		expect(other.map(l => [l.label, l.weight, l.bridge]).sort()).toEqual([
			["decodes", 1, true],
			["references", 1, false],
		]);
	});

	it("gives the root no links", () => {
		const root = dirView(graph, "repo", "", 0);
		expect(root.upstream).toEqual([]);
		expect(root.downstream).toEqual([]);
		expect(root.crumbs).toEqual([]);
	});

	it("crumbs run from the root to the parent and the folder summarises its files", () => {
		expect(view.crumbs.map(c => [c.path, c.label])).toEqual([
			["", "repo"],
			["core", "core"],
		]);
		expect(view.focus).toMatchObject({ path: "core/sub", files: 2, symbols: 3, lang: "rust" });
	});
});

describe("fileView links", () => {
	it("lists exact files with orientation from the focus", () => {
		const view = fileView(graph, "repo", "core/a.rs", noSymbols, 0);
		expect(view.downstream.map(l => [l.node.path, l.label, l.weight, l.bridge]).sort()).toEqual([
			["contracts/E.sol", "calls contract", 2, true],
			["core/sub/b.rs", "references", 4, false],
			["core/sub/c.rs", "references", 3, false],
		]);
		expect(view.upstream.map(l => [l.node.path, l.label]).sort()).toEqual([
			["app/main.ts", "referenced by"],
			["core/sub/c.rs", "referenced by"],
		]);
		const sol = fileView(graph, "repo", "contracts/E.sol", noSymbols, 0);
		expect(sol.upstream[0]).toMatchObject({ label: "called from Rust", bridge: true });
	});

	it("rejects a file the graph does not hold", () => {
		expect(() => fileView(graph, "repo", "core/missing.rs", noSymbols, 0)).toThrow("file not found");
	});
});

describe("dirView map", () => {
	const view = dirView(graph, "repo", "core", 0);
	const at = (p: string) => view.map!.nodes.findIndex(n => n.path === p);

	it("lists subfolders then files, and aggregates edges between children without intra-child edges", () => {
		expect(view.children.map(c => c.path)).toEqual(["core/other", "core/sub", "core/a.rs"]);
		const found = view.map!.edges.map(e => [e.from, e.to, e.weight, e.bridge]).sort();
		expect(found).toEqual(
			[
				// a.rs → sub: 4 (b.rs) + 3 (c.rs)
				[at("core/a.rs"), at("core/sub"), 7, false],
				// sub → a.rs: 2 (c.rs); b.rs → c.rs (inside sub) is left out
				[at("core/sub"), at("core/a.rs"), 2, false],
				// sub → other: a decodes bridge (1) plus a plain reference (1)
				[at("core/sub"), at("core/other"), 2, true],
			].sort(),
		);
		expect(view.map!.omitted).toBe(0);
	});
});

describe("caps", () => {
	it("keeps the 40 heaviest links and counts the rest", () => {
		const many = Array.from({ length: 45 }, (_, i) => file(`lib/f${String(i).padStart(2, "0")}.rs`));
		const g = buildGraphIndex(
			[file("main.rs"), ...many],
			many.map((f, i) => edge("main.rs", f.rel, i + 1)),
		);
		const view = fileView(g, "repo", "main.rs", noSymbols, 0);
		expect(view.downstream).toHaveLength(40);
		expect(view.moreDownstream).toBe(5);
		expect(Math.min(...view.downstream.map(l => l.weight))).toBe(6);
	});

	it("drops the least connected children from the map, keeping the rest in order", () => {
		const names = Array.from({ length: 260 }, (_, i) => `big/f${String(i).padStart(3, "0")}.rs`);
		const chain = names.slice(0, 250).flatMap((rel, i) => (i < 249 ? [edge(rel, names[i + 1])] : []));
		const view = dirView(
			buildGraphIndex(
				names.map(rel => file(rel)),
				chain,
			),
			"repo",
			"big",
			0,
		);
		expect(view.map!.nodes).toHaveLength(250);
		expect(view.map!.omitted).toBe(10);
		expect(view.map!.nodes.map(n => n.path)).toEqual(names.slice(0, 250));
		expect(view.map!.edges).toHaveLength(249);
		expect(Math.max(...view.map!.edges.flatMap(e => [e.from, e.to]))).toBe(249);
	});

	it("keeps the 1500 heaviest map edges", () => {
		const names = Array.from({ length: 60 }, (_, i) => `d/f${String(i).padStart(2, "0")}.rs`);
		const all: GraphEdge[] = [];
		for (let i = 0; i < 60; i++) for (let j = i + 1; j < 60; j++) all.push(edge(names[i], names[j], i + j + 1));
		const view = dirView(
			buildGraphIndex(
				names.map(rel => file(rel)),
				all,
			),
			"repo",
			"d",
			0,
		);
		const weights = all.map(e => e.weight).sort((a, b) => b - a);
		expect(view.map!.edges).toHaveLength(1500);
		expect(Math.min(...view.map!.edges.map(e => e.weight))).toBe(weights[1499]);
	});
});

describe("flowWalk", () => {
	const walk = (graphOf: Record<number, FlowEdge[]>, focus: FlowNode, dir: "down" | "up") =>
		flowWalk(node => graphOf[node.id] ?? [], focus, dir);

	it("reaches a node once, by its shortest path", () => {
		const [a, b, c] = [sym(1, "a"), sym(2, "b"), sym(3, "c")];
		const steps = walk(
			{
				1: [hop(b, "calls"), hop(c, "calls")],
				2: [hop(c, "calls"), hop(a, "calls")],
			},
			a,
			"down",
		);
		expect(steps.map(s => [s.node.label, s.hop, s.from, s.label])).toEqual([
			["a", 0, null, null],
			["b", 1, 0, "calls"],
			["c", 1, 0, "calls"],
		]);
	});

	it("follows only the labels of the asked direction and flags bridges", () => {
		const [a, down, up, bridge] = [sym(1, "a"), sym(2, "d"), sym(3, "u"), sym(4, "e")];
		const edgesOf = {
			1: [hop(down, "calls"), hop(up, "called by"), hop(bridge, "decoded by", 0)],
		};
		const downSteps = walk(edgesOf, a, "down");
		expect(downSteps.map(s => [s.node.label, s.label, s.bridge])).toEqual([
			["a", null, false],
			["e", "decoded by", true],
			["d", "calls", false],
		]);
		expect(walk(edgesOf, a, "up").map(s => s.node.label)).toEqual(["a", "u"]);
	});

	it("takes bridges and handlers before plain calls, at most 6 edges and 3 calls per node", () => {
		const a = sym(1, "a");
		const calls = [10, 11, 12, 13].map(id => hop(sym(id, `call${id}`), "calls"));
		const bridges = [20, 21].map(id => hop(sym(id, `bridge${id}`), "decodes", 0));
		const steps = walk({ 1: [...calls, ...bridges] }, a, "up");
		expect(steps.filter(s => s.label === "decodes")).toHaveLength(2);
		expect(walk({ 1: [...calls, ...bridges] }, a, "down").filter(s => s.label === "calls")).toHaveLength(3);
		const handlers = Array.from({ length: 8 }, (_, i) => hop(sym(30 + i, `h${i}`), "handled by", 1));
		const crowded = walk({ 1: [...calls, ...handlers] }, a, "down");
		expect(crowded).toHaveLength(1 + 6);
		expect(crowded.every(s => s.label !== "calls")).toBe(true);
	});

	it("stops at 5 hops", () => {
		const chain = Array.from({ length: 10 }, (_, i) => sym(i + 1, `n${i}`));
		const edgesOf: Record<number, FlowEdge[]> = {};
		for (let i = 0; i < 9; i++) edgesOf[chain[i].id] = [hop(chain[i + 1], "calls")];
		const steps = walk(edgesOf, chain[0], "down");
		expect(steps).toHaveLength(6);
		expect(steps.at(-1)!.hop).toBe(5);
	});

	it("stops at 40 steps", () => {
		let next = 2;
		const edgesOf: Record<number, FlowEdge[]> = {};
		const grow = (node: FlowNode) => {
			edgesOf[node.id] = Array.from({ length: 6 }, () => hop(sym(next++, "n"), "handled by", 1));
			return edgesOf[node.id];
		};
		const steps = flowWalk(grow, sym(1, "root"), "down");
		expect(steps).toHaveLength(40);
		expect(new Set(steps.map(s => s.from)).size).toBeGreaterThan(1);
	});
});

describe("resolveSymbol", () => {
	const at = [sym(1, "run", { startLine: 5 }), sym(2, "run", { startLine: 40 }), sym(3, "other", { startLine: 40 })];
	const source = (found: FlowNode[], defs: FlowNode[] = []) => ({
		flowOverlapping: () => found,
		flowDefinitions: () => defs,
	});
	const focus = (name: string, line: number) => ({ kind: "symbol" as const, path: "src/a.rs", name, line });

	it("prefers name and line, then name, then line, then a definition elsewhere", () => {
		expect(resolveSymbol(source(at), focus("run", 40)).id).toBe(2);
		expect(resolveSymbol(source(at), focus("run", 99)).id).toBe(1);
		expect(resolveSymbol(source(at), focus("gone", 40)).id).toBe(2);
		expect(resolveSymbol(source([], [sym(9, "run")]), focus("run", 1)).id).toBe(9);
		expect(() => resolveSymbol(source([]), focus("run", 1))).toThrow("symbol not found");
	});
});

describe("searchHits", () => {
	it("lists up to 8 matching files shortest path first, case-insensitively, then symbols", () => {
		const many = Array.from({ length: 12 }, (_, i) => file(`pkg/${"x".repeat(i + 1)}/Widget.ts`, "ts"));
		const g = buildGraphIndex([...many].reverse().concat(file("other.ts", "ts")), []);
		const hits = searchHits(g, { flowSearch: () => [sym(1, "widget")] }, "WIDGET");
		expect(hits.map(h => h.kind).join(" ")).toBe(`${"file ".repeat(8)}symbol`);
		expect(hits.slice(0, 8).map(h => h.path)).toEqual(many.slice(0, 8).map(f => f.rel));
	});
});

describe("checkFocus", () => {
	it("accepts root folders and repository-relative paths", () => {
		expect(checkFocus({ kind: "dir", path: "" })).toEqual({ kind: "dir", path: "" });
		expect(checkFocus({ kind: "symbol", path: "a/b.rs", name: "X::y", line: 3 })).toEqual({
			kind: "symbol",
			path: "a/b.rs",
			name: "X::y",
			line: 3,
		});
	});

	it("rejects escaping, absolute and malformed paths and symbols", () => {
		for (const bad of [
			{ kind: "file", path: "" },
			{ kind: "file", path: "/etc/passwd" },
			{ kind: "dir", path: "a/../../b" },
			{ kind: "file", path: "a\0b" },
			{ kind: "file", path: 7 },
			{ kind: "symbol", path: "a.rs", name: "", line: 1 },
			{ kind: "symbol", path: "a.rs", name: "x", line: 0 },
			{ kind: "symbol", path: "a.rs", name: "x", line: 1.5 },
			{ kind: "other", path: "a" },
			null,
		]) {
			expect(() => checkFocus(bad)).toThrow();
		}
	});
});
