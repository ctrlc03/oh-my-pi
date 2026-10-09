import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Codemap, type GraphEdge } from "../../src/codemap";

const FILES: Record<string, string> = {
	"src/alpha.ts": `export function alphaHelper(n: number): number {
	return n;
}
`,
	// A test-path copy of the same name must not make `alphaHelper` ambiguous, and its own calls are not edges.
	"src/__tests__/alpha-fake.ts": `export function alphaHelper(n: number): number {
	return n + 1;
}
export function onlyInTest(): number {
	return alphaHelper(1);
}
`,
	"src/caller.ts": `import { alphaHelper } from "./alpha";
import { dupName } from "./dup1";
import { sharedName } from "./shared";

export function useAlpha(): number {
	alphaHelper(1);
	return alphaHelper(2);
}

export function useDup(): number {
	onlyInTest();
	return dupName();
}

export function selfOnly(): number {
	return selfOnly();
}

export function useShared(): number {
	return sharedName();
}
`,
	"src/dup1.ts": "export function dupName(): number {\n\treturn 1;\n}\n",
	"src/dup2.ts": "export function dupName(): number {\n\treturn 2;\n}\n",
	"src/helper.ts": "export function helper(): number {\n\treturn 1;\n}\n",
	// Calls `obj.helper()` without importing it: a method on some receiver, not a use of src/helper.ts.
	"src/receiver.ts": `export function viaReceiver(obj: Record<string, () => number>): number {
	return obj.helper();
}
`,
	"src/importer.ts": `import { helper } from "./helper";

export function viaImport(): number {
	return helper();
}
`,
	"contracts/MathLib.sol": `library MathLib {
	function twice(uint256 x) internal pure returns (uint256) {
		return x * 2;
	}
}
`,
	// A whole-file import names nothing, yet the library is in scope: a type ref to it is a dependency.
	"contracts/Consumer.sol": `import "./MathLib.sol";

contract Consumer {
	function f() external pure returns (uint256) {
		return MathLib.twice(1);
	}
}
`,
	"pkg/a.go": "package pkg\n\nfunc A() {\n\tGoHelper()\n}\n",
	"pkg/b.go": "package pkg\n\nfunc GoHelper() {}\n",
	"other/c.go": "package other\n\nfunc C() {\n\tGoHelper()\n}\n",
	"src/shared.ts": "export function sharedName(): number {\n\treturn 1;\n}\n",
	"crates/core/src/shared.rs": `pub fn sharedName() -> u32 {
	1
}

pub fn use_rust_shared() -> u32 {
	sharedName()
}
`,
	"contracts/Registry.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Registry {
	event CommitteeSealed(uint256 indexed e3Id);

	function sealCommittee(uint256 e3Id) external {
		emit CommitteeSealed(e3Id);
	}

	function finishCommittee(uint256 e3Id) external {}
}
`,
	"crates/evm/src/decode.rs": `pub fn decode(data: &LogData) {
	let event = IRegistry::CommitteeSealed::decode_log_data(data);
}

pub fn seal(contract: &Contract) {
	contract.sealCommittee(1);
	contract.sealCommittee(2);
}
`,
	"crates/model/src/widget.rs": `pub struct Widget {
	pub size: u32,
}

pub struct Other {}

impl Widget {
	pub fn grow(&mut self) {}

	pub fn shrink(&mut self) {}
}

impl Other {
	pub fn unrelated(&self) {}
}
`,
};

let root: string;
let cacheDir: string;
const previousCache = process.env.OMP_JUDGMENT_CACHE_DB;

beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codemap-graph-")));
	cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "codemap-cache-"));
	process.env.OMP_JUDGMENT_CACHE_DB = path.join(cacheDir, "judgment-cache.db");
	for (const [rel, text] of Object.entries(FILES)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	}
});

afterAll(() => {
	if (previousCache === undefined) delete process.env.OMP_JUDGMENT_CACHE_DB;
	else process.env.OMP_JUDGMENT_CACHE_DB = previousCache;
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(cacheDir, { recursive: true, force: true });
});

function find(edges: GraphEdge[], from: string, to: string, label = "references"): GraphEdge | undefined {
	return edges.find(edge => edge.from === from && edge.to === to && edge.label === label);
}

describe("codemap dependency graph", () => {
	it("lists parsed source files with languages and symbol counts, without test paths", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const files = codemap.query.graphFiles();
			const rels = files.map(file => file.rel);
			expect(rels).toEqual([...rels].sort());
			expect(rels).toContain("src/alpha.ts");
			expect(rels).not.toContain("src/__tests__/alpha-fake.ts");
			const byRel = Object.fromEntries(files.map(file => [file.rel, file]));
			expect(byRel["src/alpha.ts"]).toEqual({ rel: "src/alpha.ts", lang: "ts", symbols: 1 });
			expect(byRel["crates/core/src/shared.rs"]?.lang).toBe("rust");
			expect(byRel["contracts/Registry.sol"]?.lang).toBe("sol");
			// impl blocks are not symbols of the file: two methods and two structs, not four plus three impls.
			expect(byRel["crates/model/src/widget.rs"]?.symbols).toBe(5);
		} finally {
			codemap.close();
		}
	});

	it("links a file to the unique definer of a name, weighted by reference count", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const edge = find(codemap.query.graphEdges(), "src/caller.ts", "src/alpha.ts");
			expect(edge).toEqual({
				from: "src/caller.ts",
				to: "src/alpha.ts",
				weight: 2,
				label: "references",
				bridge: false,
			});
		} finally {
			codemap.close();
		}
	});

	it("makes no edge for names defined in several files of the family or only in tests", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const edges = codemap.query.graphEdges();
			expect(edges.some(edge => edge.to === "src/dup1.ts" || edge.to === "src/dup2.ts")).toBe(false);
			expect(edges.some(edge => edge.to.includes("__tests__") || edge.from.includes("__tests__"))).toBe(false);
		} finally {
			codemap.close();
		}
	});

	it("never links a file to itself", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			expect(codemap.query.graphEdges().filter(edge => edge.from === edge.to)).toEqual([]);
		} finally {
			codemap.close();
		}
	});

	it("resolves a name defined in two languages only within the referencing language family", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const edges = codemap.query.graphEdges();
			expect(find(edges, "src/caller.ts", "src/shared.ts")?.weight).toBe(1);
			expect(find(edges, "src/caller.ts", "crates/core/src/shared.rs")).toBeUndefined();
			// The Rust call to the same name stays in Rust: it is its own file, so no edge at all.
			expect(edges.some(edge => edge.from === "crates/core/src/shared.rs" && edge.to === "src/shared.ts")).toBe(
				false,
			);
		} finally {
			codemap.close();
		}
	});

	it("links a name only from files that import it, not from a same-named method call on a receiver", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const edges = codemap.query.graphEdges();
			expect(find(edges, "src/receiver.ts", "src/helper.ts")).toBeUndefined();
			expect(find(edges, "src/importer.ts", "src/helper.ts")?.weight).toBe(1);
			// Duplicated definitions stay ambiguous even when imported.
			expect(edges.some(edge => edge.from === "src/caller.ts" && edge.to.startsWith("src/dup"))).toBe(false);
		} finally {
			codemap.close();
		}
	});

	it("links Solidity files through type references without a named import", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			expect(
				find(codemap.query.graphEdges(), "contracts/Consumer.sol", "contracts/MathLib.sol")?.weight,
			).toBeGreaterThan(0);
		} finally {
			codemap.close();
		}
	});

	it("links Go files only within one package directory", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const edges = codemap.query.graphEdges();
			expect(find(edges, "pkg/a.go", "pkg/b.go")?.weight).toBe(1);
			expect(find(edges, "other/c.go", "pkg/b.go")).toBeUndefined();
		} finally {
			codemap.close();
		}
	});

	it("bridges Rust to Solidity: a decoded event and called contract functions", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const edges = codemap.query.graphEdges();
			const decodes = find(edges, "crates/evm/src/decode.rs", "contracts/Registry.sol", "decodes");
			expect(decodes?.bridge).toBe(true);
			expect(decodes?.weight).toBeGreaterThan(0);
			expect(find(edges, "crates/evm/src/decode.rs", "contracts/Registry.sol", "calls contract")).toEqual({
				from: "crates/evm/src/decode.rs",
				to: "contracts/Registry.sol",
				weight: 2,
				label: "calls contract",
				bridge: true,
			});
			expect(find(edges, "crates/evm/src/decode.rs", "contracts/Registry.sol")).toBeUndefined();
		} finally {
			codemap.close();
		}
	});
});

describe("codemap symbol listings", () => {
	it("lists a file's symbols in source order, capped by the limit", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const symbols = codemap.query.fileSymbols("crates/model/src/widget.rs", 100);
			expect(symbols.map(symbol => symbol.name)).toEqual([
				"Widget",
				"Other",
				"Widget::grow",
				"Widget::shrink",
				"Other::unrelated",
			]);
			expect(codemap.query.fileSymbols("crates/model/src/widget.rs", 2).map(symbol => symbol.name)).toEqual([
				"Widget",
				"Other",
			]);
		} finally {
			codemap.close();
		}
	});

	it("returns a struct's impl methods and a contract's nested members, excluding the node itself", async () => {
		const codemap = await Codemap.open(root, { cwd: root });
		try {
			const widget = codemap.query.flowDefinitions("Widget")[0]!;
			expect(codemap.query.symbolMembers(widget, 100).map(member => member.name)).toEqual([
				"Widget::grow",
				"Widget::shrink",
			]);
			const registry = codemap.query.flowDefinitions("Registry")[0]!;
			const members = codemap.query.symbolMembers(registry, 100).map(member => member.name);
			expect(members).toEqual(["CommitteeSealed", "Registry.sealCommittee", "Registry.finishCommittee"]);
			expect(codemap.query.symbolMembers(registry, 1)).toHaveLength(1);
		} finally {
			codemap.close();
		}
	});
});
