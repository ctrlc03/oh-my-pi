import { describe, expect, it } from "bun:test";
import type {
	Blueprint,
	BlueprintDiagram,
	BlueprintEdge,
	BlueprintNode,
	BlueprintRef,
} from "@oh-my-pi/pi-wire/blueprint";
import {
	buildHtml,
	collectPayload,
	coverRefs,
	fileKey,
	PAYLOAD_ELEMENT_ID,
	exportFilename,
	parsePayload,
	planExports,
	sourceFromPayload,
	splitHighlighted,
} from "../src/components/architecture/blueprint-export";
import { layoutDiagram } from "../src/components/architecture/blueprint-layout";
import {
	allRefs,
	ancestry,
	createSearch,
	diagramsWithChanges,
	formatLocationHash,
	onlyChanges,
	parseLocationHash,
	refKey as refKeyOf,
	summarizeChanges,
} from "../src/components/architecture/blueprint-model";
import type { MapSource } from "../src/components/architecture/DetailPanel";
import { changesMap, createMockBlueprint, fullMap, MOCK_REPO_ROOT } from "../scripts/mock-blueprint";

function node(id: string, extra: Partial<BlueprintNode> = {}): BlueprintNode {
	return { id, label: id, kind: "module", ...extra };
}

function edge(from: string, to: string, extra: Partial<BlueprintEdge> = {}): BlueprintEdge {
	return { id: `${from}>${to}`, from, to, label: `${from} to ${to}`, refs: [], ...extra };
}

function diagram(nodes: BlueprintNode[], edges: BlueprintEdge[]): BlueprintDiagram {
	return { id: "d", title: "D", origin: "agent", nodes, edges };
}

describe("layoutDiagram", () => {
	it("gives the same layout for the same diagram", () => {
		for (const item of Object.values(fullMap().diagrams)) {
			expect(JSON.stringify(layoutDiagram(item))).toBe(JSON.stringify(layoutDiagram(item)));
		}
	});

	it("never overlaps two nodes or leaves the canvas", () => {
		for (const map of [fullMap(), changesMap()]) {
			for (const item of Object.values(map.diagrams)) {
				const layout = layoutDiagram(item);
				const placed = layout.nodes;
				for (const a of placed) {
					expect(a.x).toBeGreaterThanOrEqual(0);
					expect(a.y).toBeGreaterThanOrEqual(0);
					expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
					expect(a.y + a.height).toBeLessThanOrEqual(layout.height);
					for (const b of placed) {
						if (a === b) continue;
						const apart =
							a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
						expect(apart).toBe(true);
					}
				}
			}
		}
	});

	it("runs every edge of an acyclic diagram from left to right", () => {
		const layout = layoutDiagram(
			diagram(
				[node("a"), node("b"), node("c"), node("d")],
				[edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("a", "d")],
			),
		);
		const x = (id: string): number => layout.nodes.find(placed => placed.node.id === id)!.x;
		expect(x("a")).toBeLessThan(x("b"));
		expect(x("b")).toBeLessThan(x("c"));
		expect(x("c")).toBeLessThan(x("d"));
	});

	it("lays out cycles, self-loops, parallel edges, strangers and the empty diagram without failing", () => {
		const empty = layoutDiagram(diagram([], []));
		expect(empty.nodes).toHaveLength(0);
		const odd = layoutDiagram(
			diagram(
				[node("a"), node("b"), node("c"), node("lonely"), node("loop")],
				[
					edge("a", "b"),
					edge("b", "c"),
					edge("c", "a"),
					edge("a", "b", { id: "second" }),
					edge("loop", "loop"),
					edge("a", "missing"),
				],
			),
		);
		expect(odd.nodes).toHaveLength(5);
		expect(odd.edges.length).toBeGreaterThanOrEqual(5);
		for (const placed of odd.edges) expect(placed.d).not.toContain("NaN");
	});
});

describe("diff views", () => {
	const map = changesMap();

	it("counts what changed across every diagram", () => {
		const summary = summarizeChanges(map);
		expect(summary.nodes.added).toBeGreaterThan(0);
		expect(summary.nodes.modified).toBeGreaterThan(0);
		expect(summary.nodes.removed).toBe(1);
		expect(summary.edges.removed).toBe(1);
		expect(summary.total).toBe(
			summary.nodes.added +
				summary.nodes.modified +
				summary.nodes.removed +
				summary.edges.added +
				summary.edges.modified +
				summary.edges.removed,
		);
	});

	it("marks a diagram as holding changes when only a child does, and none of a map without any", () => {
		const holders = diagramsWithChanges(map);
		expect(holders.has("system")).toBe(true);
		expect(diagramsWithChanges(fullMap()).size).toBe(0);
	});

	it("keeps changed nodes and edges plus the unchanged ends of changed edges as context", () => {
		const system = map.diagrams.system!;
		const kept = onlyChanges(system, diagramsWithChanges(map))!;
		expect(kept.diagram.edges.every(link => link.change !== undefined)).toBe(true);
		// The API server is unchanged and has no changed edge: it is dropped.
		expect(kept.diagram.nodes.some(item => item.id === "api")).toBe(false);
		// Stripe is unchanged but is the end of a modified edge: kept, as context.
		expect(kept.diagram.nodes.some(item => item.id === "stripe")).toBe(true);
		expect(kept.context.has("stripe")).toBe(true);
		expect(onlyChanges(diagram([node("x")], []), new Set())).toBeNull();
	});
});

describe("map navigation", () => {
	const map = fullMap();

	it("lists the ancestors of a diagram from the root down", () => {
		const path = ancestry(map, "index:file:src/orders/service.ts").map(item => item.id);
		expect(path[0]).toBe("system");
		expect(path.at(-1)).toBe("index:file:src/orders/service.ts");
		expect(path).toContain("orders");
	});

	it("finds nodes, edges and diagrams across the map, best first", () => {
		const search = createSearch(map);
		expect(search("refund order")).toHaveLength(0);
		const stripe = search("stripe");
		expect(stripe.some(hit => hit.kind === "node")).toBe(true);
		expect(stripe.some(hit => hit.kind === "diagram" && hit.diagram === "payments")).toBe(true);
		expect(search("payment intents").some(hit => hit.kind === "edge")).toBe(true);
		expect(search("   ")).toEqual([]);
	});

	it("round-trips a location through the URL fragment, ids with odd characters included", () => {
		const location = { diagram: "index:dir:src/a b&c", node: "f:src/x=y.ts" };
		expect(parseLocationHash(formatLocationHash(location))).toEqual(location);
		expect(parseLocationHash(formatLocationHash({ diagram: "system", edge: "a>b" }))).toEqual({
			diagram: "system",
			edge: "a>b",
		});
		expect(parseLocationHash("")).toBeNull();
		expect(parseLocationHash("#n=only-a-node")).toBeNull();
	});
});

function mockSource(map: Blueprint, batches: number[] = []): MapSource {
	const mock = createMockBlueprint({ onChanged: () => {}, instanceId: "inst-test" });
	return {
		excerpts: async refs => {
			batches.push(refs.length);
			const out = mock.answer({ t: "blueprint-excerpt", reqId: 1, id: map.id, refs });
			if (out.t !== "blueprint-excerpt") throw new Error("unexpected reply");
			return out.excerpts;
		},
		highlight: async excerpt => excerpt.lines.map(line => `<span class="hljs-x">${line}</span>`).join("\n"),
	};
}

describe("export", () => {
	it("carries the code of the agent's diagrams only by default, and reads it back exactly", async () => {
		const map = fullMap();
		const source = mockSource(map);
		const payload = await collectPayload(map, source, "diagrams");
		const agent = allRefs(map, "agent");
		expect(agent.length).toBeLessThan(allRefs(map).length);
		const page = sourceFromPayload(payload);
		const direct = await source.excerpts(agent);
		const exported = await page.excerpts(agent);
		agent.forEach((_, i) => {
			expect(exported[i]?.lines).toEqual(direct[i]?.lines);
			expect(exported[i]?.start).toBe(direct[i]!.start);
			expect(exported[i]?.html).toBeDefined();
		});
		// A citation of an index diagram far from any the agent made has no code in the page.
		const far: Blueprint = {
			...map,
			diagrams: {
				...map.diagrams,
				"index:file:far": {
					...diagram([node("far", { refs: [{ path: "src/orders/service.ts", line: 300, token: "x" }] })], []),
					id: "index:file:far",
					origin: "index",
				},
			},
		};
		const farPayload = await collectPayload(far, source, "diagrams");
		const [missing] = await sourceFromPayload(farPayload).excerpts([
			{ path: "src/orders/service.ts", line: 300, token: "x" },
		]);
		expect(missing).toBeNull();
	});

	it("carries every citation's code with 'all', through reads of at most 200 refs", async () => {
		const map = fullMap();
		const batches: number[] = [];
		const payload = await collectPayload(map, mockSource(map, batches), "all");
		expect(Math.max(...batches)).toBeLessThanOrEqual(200);
		const page = sourceFromPayload(payload);
		const all = allRefs(map);
		const direct = await mockSource(map).excerpts(all);
		const exported = await page.excerpts(all);
		all.forEach((_, i) => expect(exported[i]?.lines).toEqual(direct[i]?.lines));
	});

	it("plans the read before reading: fewer reads than citations, and a bigger page for more code", () => {
		const map = fullMap();
		const plans = planExports(map);
		expect(plans.all.citations).toBeGreaterThan(plans.diagrams.citations);
		expect(plans.all.bytes).toBeGreaterThan(plans.diagrams.bytes);
		expect(plans.all.reads).toBeLessThanOrEqual(plans.all.citations);
	});

	it("covers the lines around every citation with the citations it picks, and merges runs", () => {
		const at = (path: string, line: number): BlueprintRef => ({ path, line, token: "x" });
		const refs = [
			at("a.ts", 100),
			at("a.ts", 110),
			at("a.ts", 130),
			at("a.ts", 400),
			at("b.ts", 5),
			{ ...at("a.ts", 100), side: "base" as const },
		];
		const cover = coverRefs(refs);
		expect(cover.files).toBe(3);
		// a.ts head: 100, 110 and 130 chain into one run (88..142); 400 is alone (388..412); b.ts 1..17; a.ts base 88..112.
		expect(cover.lines).toBe(142 - 88 + 1 + 25 + 17 + 25);
		const picked = new Set(cover.reps.map(ref => `${fileKey(ref)}@${ref.line}`));
		expect(picked.has("head:a.ts@400")).toBe(true);
		expect(picked.has("head:a.ts@130")).toBe(true);
		expect(cover.reps.length).toBeLessThan(refs.length + 1);
	});

	it("splits highlighted markup per line, reopening spans a line break ran through", () => {
		const lines = splitHighlighted('a <span class="c">/* x\n y */</span> b\nz');
		expect(lines).toEqual(['a <span class="c">/* x</span>', '<span class="c"> y */</span> b', "z"]);
	});

	it("builds a page that holds the payload, and reads it back", async () => {
		const map = fullMap();
		const payload = await collectPayload(map, mockSource(map), "diagrams");
		const html = buildHtml(payload, { script: "window.__ran = true;", style: ".ar-viewer{color:red}" });
		const embedded = new RegExp(
			`<script type="application/json" id="${PAYLOAD_ELEMENT_ID}">([\\s\\S]*?)</script>`,
		).exec(html);
		expect(embedded).not.toBeNull();
		expect(parsePayload(embedded![1]!)).toEqual(JSON.parse(JSON.stringify(payload)));
	});

	it("survives text that would end a script element or open a comment", async () => {
		const hostile = '</script><!-- <script>alert(1)</script> \u2028 & "quotes"';
		const map: Blueprint = {
			...fullMap(),
			title: `</title>${hostile}`,
			diagrams: { system: { ...fullMap().diagrams.system!, summary: hostile } },
			warnings: [hostile],
		};
		const payload = await collectPayload(map, { excerpts: async refs => refs.map(() => null) }, "diagrams");
		const html = buildHtml(payload, { script: `var s = "</script><!--";`, style: "</style>" });
		// Exactly the three script elements and the one style element the page has.
		expect(html.match(/<script/gi)).toHaveLength(3);
		expect(html.match(/<\/script>/gi)).toHaveLength(3);
		expect(html.match(/<\/style>/gi)).toHaveLength(1);
		expect(html).not.toContain("<!--");
		const embedded = new RegExp(`id="${PAYLOAD_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html)!;
		expect(parsePayload(embedded[1]!).map.warnings).toEqual([hostile]);
	});

	it("refuses a payload from another version", () => {
		expect(() => parsePayload(JSON.stringify({ v: 99, map: {} }))).toThrow();
	});

	it("names the file after the map, without repeating the repository", () => {
		const map = fullMap();
		const day = new Date(map.createdAt).toISOString().slice(0, 10);
		const named = (repo: string, title: string) =>
			exportFilename({ ...map, repo: { ...map.repo, name: repo }, title });
		expect(named("acme-shop", "acme-shop @ main")).toBe(`acme-shop-main-${day}.html`);
		expect(named("acme-shop", "acme-shop")).toBe(`acme-shop-${day}.html`);
		expect(named("acme-shop", "Checkout flow")).toBe(`acme-shop-checkout-flow-${day}.html`);
	});
});

describe("mock fixture", () => {
	it("cites only lines that hold their token, on the side the ref names", async () => {
		const mock = createMockBlueprint({ onChanged: () => {}, instanceId: "inst-test" });
		for (const map of [fullMap(), changesMap()]) {
			for (const ref of allRefs(map)) {
				const out = mock.answer({ t: "blueprint-excerpt", reqId: 3, id: map.id, refs: [ref] });
				if (out.t !== "blueprint-excerpt") throw new Error("unexpected reply");
				const excerpt = out.excerpts[0];
				expect(excerpt).toBeTruthy();
				expect(excerpt!.lines[excerpt!.line - excerpt!.start]).toContain(ref.token);
			}
		}
		expect(MOCK_REPO_ROOT).toBe(fullMap().repo.root);
	});
});
