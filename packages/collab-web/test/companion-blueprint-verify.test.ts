import { describe, expect, it } from "bun:test";
import type { Blueprint, BlueprintDiagram } from "@oh-my-pi/pi-wire/blueprint";
import { BLUEPRINT_VERSION } from "@oh-my-pi/pi-wire/blueprint";
import { parseAgentOutput, verifyBlueprint, type VerifyIo } from "../scripts/companion-blueprint-verify";
import { parseRefText, type Side } from "../scripts/companion-citations";

const HEAD_FILES: Record<string, string> = {
	"src/a.ts": ["import { b } from './b';", "", "export function run() {", "\treturn b();", "}"].join("\n"),
	"src/b.ts": ["export function b() {", "\treturn 1;", "}", "", "// b again", "export const other = b;"].join("\n"),
};
const BASE_FILES: Record<string, string> = { ...HEAD_FILES, "src/gone.ts": "export const gone = 1;\n" };

function io(): VerifyIo {
	const files: Record<Side, Record<string, string>> = { head: HEAD_FILES, base: BASE_FILES };
	return {
		lines: async (side, file) => (Object.hasOwn(files[side], file) ? files[side][file]!.split("\n") : null),
		hasPath: (side, file) => Object.keys(files[side]).some(f => f === file || f.startsWith(`${file}/`)),
		diagramForPath: file => (file === "src" ? "index:dir:src" : undefined),
	};
}

function diagram(id: string, over: Partial<BlueprintDiagram> = {}): BlueprintDiagram {
	return { id, title: id, origin: "agent", nodes: [], edges: [], ...over };
}

function draft(diagrams: BlueprintDiagram[], over: Partial<Blueprint> = {}): Blueprint {
	return {
		v: BLUEPRINT_VERSION,
		id: "bp-000000000000",
		title: "t",
		repo: { root: "/r", name: "r" },
		head: { commit: "a".repeat(40) },
		createdAt: 0,
		root: diagrams[0]!.id,
		diagrams: Object.fromEntries(diagrams.map(d => [d.id, d])),
		warnings: [],
		...over,
	};
}

describe("verifyBlueprint", () => {
	it("keeps a correct citation, moves one whose token is elsewhere, drops one that cites nothing real", async () => {
		const system = diagram("system", {
			nodes: [
				{ id: "a", label: "A", kind: "module", refs: [{ path: "src/a.ts", line: 3, token: "run" }] },
				{ id: "b", label: "B", kind: "module", refs: [{ path: "src/b.ts", line: 40, token: "return 1" }] },
				{ id: "c", label: "C", kind: "module", refs: [{ path: "src/b.ts", line: 1, token: "nonexistent" }] },
				{ id: "d", label: "D", kind: "module", refs: [{ path: "src/missing.ts", line: 1, token: "x" }] },
			],
			edges: [
				{
					id: "a>b",
					from: "a",
					to: "b",
					label: "calls",
					kind: "call",
					refs: [{ path: "src/a.ts", line: 4, token: "b()" }],
				},
				{
					id: "b>c",
					from: "b",
					to: "c",
					label: "invented",
					refs: [{ path: "src/b.ts", line: 1, token: "nonexistent" }],
				},
			],
		});
		const { map, stats } = await verifyBlueprint(draft([system]), io());
		const nodes = Object.fromEntries(map.diagrams.system!.nodes.map(n => [n.id, n]));
		expect(nodes.a!.refs).toEqual([{ path: "src/a.ts", line: 3, token: "run" }]);
		expect(nodes.b!.refs).toEqual([{ path: "src/b.ts", line: 2, token: "return 1" }]);
		expect(nodes.c!.refs).toBeUndefined();
		expect(nodes.d!.refs).toBeUndefined();
		expect(map.diagrams.system!.edges.map(e => e.id)).toEqual(["a>b"]);
		expect(stats).toMatchObject({ refsVerified: 2, refsMoved: 1, refsDropped: 3, edgesDropped: 1 });
		expect(map.warnings.at(-1)).toContain("2 correct, 1 moved to the right line, 3 dropped");
	});

	it("moves a repeated token to the one occurrence near the cited line, and drops it when none is clearly meant", async () => {
		const lots = Array.from({ length: 200 }, (_, i) => (i === 10 || i === 150 ? "hit" : "x"));
		const wide: VerifyIo = { ...io(), lines: async () => lots };
		const system = diagram("system", {
			nodes: [
				{ id: "n", label: "N", kind: "module", refs: [{ path: "src/a.ts", line: 12, token: "hit" }] },
				{ id: "m", label: "M", kind: "module", refs: [{ path: "src/a.ts", line: 80, token: "hit" }] },
			],
		});
		const { map } = await verifyBlueprint(draft([system]), wide);
		expect(map.diagrams.system!.nodes[0]!.refs).toEqual([{ path: "src/a.ts", line: 11, token: "hit" }]);
		expect(map.diagrams.system!.nodes[1]!.refs).toBeUndefined();
	});

	it("drops edges that name missing nodes and node paths that are not in the repository", async () => {
		const system = diagram("system", {
			nodes: [
				{ id: "a", label: "A", kind: "module", path: "src/a.ts" },
				{ id: "z", label: "Z", kind: "module", path: "nowhere/at/all" },
			],
			edges: [{ id: "a>q", from: "a", to: "q", label: "x", refs: [{ path: "src/a.ts", line: 1, token: "import" }] }],
		});
		const { map, stats } = await verifyBlueprint(draft([system]), io());
		expect(map.diagrams.system!.edges).toEqual([]);
		expect(map.diagrams.system!.nodes.map(n => n.path)).toEqual(["src/a.ts", undefined]);
		expect(stats.edgesDropped).toBe(1);
	});

	it("links a node to a diagram by id or by folder path, drops unknown links, and computes parents", async () => {
		const index = diagram("index:dir:src", { origin: "index" });
		const repo = diagram("index:repo", { origin: "index" });
		const system = diagram("system", {
			nodes: [
				{ id: "by-path", label: "src", kind: "package", child: "src" },
				{ id: "by-id", label: "web", kind: "ui", child: "web" },
				{ id: "lost", label: "lost", kind: "ui", child: "nothing" },
			],
		});
		const web = diagram("web");
		const { map, stats } = await verifyBlueprint(draft([system, web, index, repo]), io());
		const nodes = Object.fromEntries(map.diagrams.system!.nodes.map(n => [n.id, n]));
		expect(nodes["by-path"]!.child).toBe("index:dir:src");
		expect(nodes["by-id"]!.child).toBe("web");
		expect(nodes.lost!.child).toBeUndefined();
		expect(stats.nodesUnlinked).toBe(1);
		expect(map.diagrams.web!.parent).toBe("system");
		expect(map.diagrams["index:dir:src"]!.parent).toBe("system");
		// The root of an agent map always opens the whole-repository overview.
		expect(nodes["all-code"]!.child).toBe("index:repo");
		expect(map.diagrams["index:repo"]!.parent).toBe("system");
		expect(map.diagrams.system!.parent).toBeUndefined();
	});

	it("drops a diagram nothing opens", async () => {
		const { map, stats } = await verifyBlueprint(draft([diagram("system"), diagram("orphan")]), io());
		expect(Object.keys(map.diagrams)).toEqual(["system"]);
		expect(stats.diagramsDropped).toBe(1);
	});

	it("checks a removed item against the base commit and keeps `change` only in a diff map", async () => {
		const removed = diagram("system", {
			nodes: [
				{
					id: "g",
					label: "gone",
					kind: "file",
					path: "src/gone.ts",
					change: "removed",
					refs: [{ path: "src/gone.ts", line: 1, token: "gone" }],
				},
			],
		});
		const diff = await verifyBlueprint(draft([removed], { base: { commit: "b".repeat(40) } }), io());
		const node = diff.map.diagrams.system!.nodes[0]!;
		expect(node.change).toBe("removed");
		expect(node.path).toBe("src/gone.ts");
		expect(node.refs).toEqual([{ path: "src/gone.ts", line: 1, token: "gone", side: "base" }]);

		const plain = await verifyBlueprint(draft([removed]), io());
		expect(plain.map.diagrams.system!.nodes[0]!.change).toBeUndefined();
		expect(plain.map.diagrams.system!.nodes[0]!.refs).toBeUndefined();
	});
});

describe("parseRefText", () => {
	it("reads path@line@token and the base: prefix", () => {
		expect(parseRefText("src/a.ts@12@run")).toEqual({ path: "src/a.ts", line: 12, token: "run" });
		expect(parseRefText("base:src/a.ts@3@a@b")).toEqual({ path: "src/a.ts", line: 3, token: "a@b", side: "base" });
		expect(parseRefText("src/a.ts@0@run")).toBeUndefined();
		expect(parseRefText("../escape.ts@1@x")).toBeUndefined();
		expect(parseRefText("/etc/passwd@1@x")).toBeUndefined();
		expect(parseRefText("no at signs")).toBeUndefined();
	});
});

describe("parseAgentOutput", () => {
	it("accepts diagrams as a list or an object, string or object refs, and refuses ids that collide with index diagrams", () => {
		const warnings: string[] = [];
		const out = parseAgentOutput(
			{
				root: "system",
				diagrams: [
					{
						id: "system",
						title: "System",
						nodes: [
							{
								id: "a",
								label: "A",
								kind: "service",
								refs: ["src/a.ts@3@run", { path: "src/b.ts", line: 1, token: "b" }],
							},
						],
						edges: [
							{
								from: "a",
								to: "a",
								label: "loops",
								refs: ["src/a.ts@1@import"],
								origin: "index",
								change: "bogus",
							},
						],
					},
					{ id: "index:repo", title: "Sneaky", nodes: [], edges: [] },
				],
			},
			warnings,
		);
		expect(Object.keys(out.diagrams)).toEqual(["system"]);
		const system = out.diagrams.system!;
		expect(system.origin).toBe("agent");
		expect(system.nodes[0]!.refs).toHaveLength(2);
		expect(Object.hasOwn(system.edges[0]!, "origin")).toBe(false);
		expect(system.edges[0]!.change).toBeUndefined();
		expect(warnings.join(" ")).toContain("index:repo");

		const asObject = parseAgentOutput({ root: "x", diagrams: { x: { title: "X", nodes: [], edges: [] } } }, []);
		expect(Object.keys(asObject.diagrams)).toEqual(["x"]);
		expect(asObject.root).toBe("x");
	});
});
