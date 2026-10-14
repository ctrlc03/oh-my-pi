import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentWatch, type AgentWatchOptions, waitForAgent } from "../scripts/companion-blueprint-agent";
import { createBlueprints, excerptOf, parseAgentJson } from "../scripts/companion-blueprint";
import {
	buildIndexDiagrams,
	findImportRef,
	type IndexFile,
	type IndexSource,
} from "../scripts/companion-blueprint-index";
import { loadCodemap, openThrowawayIndex } from "../scripts/companion-codemap";

// ── the index levels, from a hand-made source ───────────────────────────────

const TEXT: Record<string, string[]> = {
	"packages/app/src/main.ts": [
		'import { render } from "./ui/view";',
		'import { helper } from "@scope/lib";',
		"",
		"export function main() {",
		"\trender(helper());",
		"}",
	],
	"packages/app/src/ui/view.ts": [
		"export function render(x: string) {",
		"\treturn x;",
		"}",
		"export function other() {}",
	],
	"packages/lib/src/index.ts": ["export function helper() {", '\treturn "x";', "}", "export const extra = 1;"],
};

function source(over: { files?: IndexFile[]; edges?: IndexSource["edges"] } = {}): IndexSource {
	return {
		files: over.files ?? [
			{ rel: "packages/app/src/main.ts", lang: "ts", symbols: 2 },
			{ rel: "packages/app/src/ui/view.ts", lang: "ts", symbols: 2 },
			{ rel: "packages/lib/src/index.ts", lang: "ts", symbols: 2 },
		],
		edges: over.edges ?? [
			{ from: "packages/app/src/main.ts", to: "packages/app/src/ui/view.ts", weight: 1, label: "references" },
			{ from: "packages/app/src/main.ts", to: "packages/lib/src/index.ts", weight: 1, label: "references" },
			// Nothing in main.ts's text mentions this file: no line to cite, so no arrow.
			{ from: "packages/app/src/ui/view.ts", to: "packages/lib/src/index.ts", weight: 1, label: "references" },
		],
		manifests: ["packages/app/package.json", "packages/lib/package.json"],
		lines: async rel => TEXT[rel] ?? null,
		symbols: async rel =>
			(TEXT[rel] ?? [])
				.map((line, i) => ({ line, i }))
				.filter(({ line }) => line.startsWith("export"))
				.map(({ line, i }) => ({
					name: /(?:function|const) (\w+)/.exec(line)![1]!,
					kind: "function",
					startLine: i + 1,
					endLine: i + 1,
					signature: line,
					side: "head" as const,
				})),
		calls: async () => [],
	};
}

describe("buildIndexDiagrams", () => {
	it("cites each arrow with the import line behind it and skips dependencies it cannot cite", async () => {
		const result = await buildIndexDiagrams(source(), { repoName: "demo" });
		const overview = result.diagrams[result.root]!;
		expect(overview.nodes.map(n => n.label).sort()).toEqual(["packages/app", "packages/lib"]);
		const toLib = overview.edges.find(e => e.to.includes("packages/lib"))!;
		expect(toLib.refs?.[0]).toMatchObject({ path: "packages/app/src/main.ts", line: 2 });
		expect(TEXT["packages/app/src/main.ts"]![toLib.refs![0]!.line - 1]).toContain(toLib.refs![0]!.token);
		const app = result.diagrams["index:dir:packages/app/src"]!;
		expect(app.edges).toHaveLength(2);
		expect(result.warnings.join(" ")).toContain("1 file dependency had no import line to cite");
		expect(result.byPath.get("packages/app/src")).toBe("index:dir:packages/app/src");
	});

	it("is deterministic and keeps every diagram reachable, folding extra entries into an overflow diagram", async () => {
		const many: IndexFile[] = Array.from({ length: 40 }, (_, i) => ({
			rel: `packages/big/src/f${String(i).padStart(2, "0")}.ts`,
			lang: "ts",
			symbols: 0,
		}));
		const input = { ...source({ files: many, edges: [] }), manifests: ["packages/big/package.json"] };
		const options = { repoName: "demo", maxNodes: 10 };
		const first = await buildIndexDiagrams(input, options);
		const second = await buildIndexDiagrams(input, options);
		expect(JSON.stringify(first.diagrams)).toBe(JSON.stringify(second.diagrams));
		const dir = first.diagrams["index:dir:packages/big/src"]!;
		expect(dir.nodes).toHaveLength(11);
		const more = dir.nodes.find(n => n.label === "30 more")!;
		expect(first.diagrams[more.child!]!.nodes).toHaveLength(30);
		const opened = new Set(
			Object.values(first.diagrams).flatMap(d => d.nodes.flatMap(n => (n.child ? [n.child] : []))),
		);
		for (const id of Object.keys(first.diagrams)) if (id !== first.root) expect(opened.has(id)).toBe(true);
	});

	it("marks added, modified and removed files and rolls the change up to folders", async () => {
		const files: IndexFile[] = [
			{ rel: "packages/app/src/main.ts", lang: "ts", symbols: 2, change: "modified" },
			{ rel: "packages/app/src/ui/view.ts", lang: "ts", symbols: 2 },
			{ rel: "packages/lib/src/index.ts", lang: "ts", symbols: 2 },
			{ rel: "packages/lib/src/old.ts", lang: "ts", symbols: 0, change: "removed" },
		];
		const result = await buildIndexDiagrams(source({ files }), { repoName: "demo" });
		const overview = result.diagrams[result.root]!;
		const byLabel = Object.fromEntries(overview.nodes.map(n => [n.label, n.change]));
		expect(byLabel["packages/app"]).toBe("modified");
		expect(byLabel["packages/lib"]).toBe("modified");
	});

	it("finds the import line that names a file, by its stem or its folder", () => {
		const lines = ["// header", 'import { a } from "./other";', 'import { helper } from "@scope/lib";'];
		expect(findImportRef(lines, "packages/lib/src/index.ts", ["helper"])).toMatchObject({ line: 3 });
		expect(findImportRef(lines, "src/other.ts", [])).toMatchObject({ line: 2, token: "other" });
		expect(findImportRef(lines, "src/unrelated.ts", [])).toBeUndefined();
	});
});

// ── waiting for the agent ────────────────────────────────────────────────────

const WATCH: AgentWatchOptions = { pollMs: 1_000, settleMs: 3_000, idleMs: 20_000, goneMs: 5_000, timeoutMs: 100_000 };

function fakeWatch(
	script: (t: number) => { host: { busy: boolean | null } | null; output: string | null },
	cancelAt = Infinity,
) {
	let t = 0;
	const watch: AgentWatch = {
		host: async () => script(t).host,
		output: async () => {
			const text = script(t).output;
			return text === null ? null : { text, signature: text };
		},
		now: () => t,
		sleep: async ms => {
			t += ms;
		},
		cancelled: () => t >= cancelAt,
	};
	return watch;
}

describe("waitForAgent", () => {
	it("takes the file once it stops changing and the session is idle, not while the agent is still working", async () => {
		const watch = fakeWatch(t => ({
			host: { busy: t < 10_000 },
			output: t < 2_000 ? null : t < 6_000 ? "draft" : "final",
		}));
		expect(await waitForAgent(watch, WATCH)).toEqual({ kind: "done", text: "final" });
	});

	it("takes the file when the session exited right after writing it", async () => {
		const watch = fakeWatch(t => ({ host: t < 3_000 ? { busy: true } : null, output: t >= 2_000 ? "out" : null }));
		expect(await waitForAgent(watch, WATCH)).toEqual({ kind: "done", text: "out" });
	});

	it("reports a session that vanished or sat idle without a file, and a timeout", async () => {
		expect(
			await waitForAgent(
				fakeWatch(t => ({ host: t < 2_000 ? { busy: true } : null, output: null })),
				WATCH,
			),
		).toEqual({ kind: "ended" });
		expect(
			await waitForAgent(
				fakeWatch(t => ({ host: { busy: t < 2_000 }, output: null })),
				WATCH,
			),
		).toEqual({ kind: "stalled" });
		expect(
			await waitForAgent(
				fakeWatch(() => ({ host: { busy: true }, output: null })),
				WATCH,
			),
		).toEqual({ kind: "timeout" });
		expect(
			await waitForAgent(
				fakeWatch(() => ({ host: { busy: true }, output: null }), 4_000),
				WATCH,
			),
		).toEqual({ kind: "cancelled" });
	});
});

describe("agent output text", () => {
	it("reads JSON with or without a markdown fence", () => {
		expect(parseAgentJson('{"a":1}')).toEqual({ a: 1 });
		expect(parseAgentJson('```json\n{"a":1}\n```\n')).toEqual({ a: 1 });
		expect(() => parseAgentJson("not json")).toThrow(SyntaxError);
	});

	it("cuts an excerpt around the cited line, shortens long lines, and refuses a line outside the file", () => {
		const lines = Array.from({ length: 100 }, (_, i) => (i === 49 ? "x".repeat(1_000) : `line ${i + 1}`));
		const hit = excerptOf(lines, { path: "a.ts", line: 50 }, "head", "c".repeat(40))!;
		expect(hit.lines).toContain("line 49");
		expect(hit.lines.at(hit.line - hit.start)!.length).toBeLessThan(500);
		expect(excerptOf(lines, { path: "a.ts", line: 101 }, "head", "c")).toBeNull();
		expect(excerptOf(lines, { path: "a.ts", line: 0 }, "head", "c")).toBeNull();
		expect(excerptOf(lines, { path: "a.ts", line: 1 }, "head", "c")!.start).toBe(1);
	});
});

// ── a whole run against a real repository and the real code index ───────────

let tmp: string;
let repo: string;
/** The code index needs the native extractor, which a checkout may not have built. */
const indexReady = await loadCodemap();
const savedJudgmentDb = process.env.OMP_JUDGMENT_CACHE_DB;

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
	return out.trim();
}

const FILES: Record<string, string> = {
	"package.json": '{"name":"demo","private":true}\n',
	"packages/app/package.json": '{"name":"@demo/app"}\n',
	"packages/app/src/main.ts":
		'import { helper } from "@demo/lib";\nimport { render } from "./view";\n\nexport function main(): string {\n\treturn render(helper());\n}\n',
	"packages/app/src/view.ts": "export function render(text: string): string {\n\treturn `<p>${text}</p>`;\n}\n",
	"packages/lib/package.json": '{"name":"@demo/lib"}\n',
	"packages/lib/src/index.ts": 'export function helper(): string {\n\treturn "hello";\n}\n',
};

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-run-")));
	// The code index of a checkout is stored under the omp cache folder: keep the test's out of the user's.
	process.env.OMP_JUDGMENT_CACHE_DB = path.join(tmp, "cache", "judgment-cache.db");
	repo = path.join(tmp, "demo");
	await fs.mkdir(repo);
	await git(repo, "init", "-q", "-b", "main");
	for (const [file, text] of Object.entries(FILES)) {
		await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
		await fs.writeFile(path.join(repo, file), text);
	}
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "init");
});

afterAll(async () => {
	if (savedJudgmentDb === undefined) delete process.env.OMP_JUDGMENT_CACHE_DB;
	else process.env.OMP_JUDGMENT_CACHE_DB = savedJudgmentDb;
	await fs.rm(tmp, { recursive: true, force: true });
});

function manager(agent: Parameters<typeof createBlueprints>[0]["agent"], name: string) {
	const changes: string[] = [];
	const blueprints = createBlueprints({
		storeDir: path.join(tmp, name, "agent", "blueprints"),
		cacheDir: path.join(tmp, name, "cache", "blueprints"),
		now: () => Date.now(),
		changed: id => changes.push(id),
		openIndex: openThrowawayIndex,
		agent,
		watch: { pollMs: 10, settleMs: 30 },
	});
	return { blueprints, changes };
}

describe.skipIf(!indexReady)("a map run", () => {
	it("stores a verified map of the index levels and the agent's diagrams, and serves excerpts of its citations", async () => {
		const written: string[] = [];
		const { blueprints, changes } = manager(
			{
				start: async launch => {
					written.push(launch.cwd);
					await fs.writeFile(
						launch.outFile,
						JSON.stringify({
							root: "system",
							diagrams: [
								{
									id: "system",
									title: "System",
									nodes: [
										{ id: "app", label: "App", kind: "service", path: "packages/app", child: "packages/app" },
										{ id: "lib", label: "Lib", kind: "package", path: "packages/lib/src" },
									],
									edges: [
										// Cites line 9 of main.ts, where `@demo/lib` is not: it is moved to line 1, its only occurrence.
										{
											from: "app",
											to: "lib",
											label: "uses helper",
											refs: ["packages/app/src/main.ts@9@@demo/lib"],
										},
										{
											from: "lib",
											to: "app",
											label: "invented",
											refs: ["packages/lib/src/index.ts@1@nothing_like_this"],
										},
									],
								},
							],
						}),
					);
					return "agent-1";
				},
				hosts: async () => [],
				stop: async () => undefined,
				cost: async () => 0.42,
			},
			"run1",
		);
		const { id } = await blueprints.create({ cwd: repo });
		await blueprints.idle();
		const [summary] = await blueprints.list(repo);
		expect(summary).toMatchObject({ id, status: "ready" });
		const map = await blueprints.get(id);
		expect(map.root).toBe("system");
		expect(map.head.commit).toBe(await git(repo, "rev-parse", "HEAD"));
		const system = map.diagrams.system!;
		expect(system.edges.map(e => e.label)).toEqual(["uses helper"]);
		expect(system.edges[0]!.refs).toEqual([{ path: "packages/app/src/main.ts", line: 1, token: "@demo/lib" }]);
		expect(system.nodes.find(n => n.id === "app")!.child).toMatch(/^index:dir:/);
		expect(system.nodes.some(n => n.child === "index:repo")).toBe(true);
		expect(Object.keys(map.diagrams)).toContain("index:dir:packages/app/src");
		expect(map.diagrams["index:repo"]!.parent).toBe("system");
		expect(changes).toContain(id);
		// Nothing of the map lives in the repository, and the checkouts are gone.
		expect(await git(repo, "status", "--porcelain")).toBe("");
		expect(await fs.readdir(path.dirname(written[0]!)).catch(() => [])).toEqual([]);

		const [hit, missing] = await blueprints.excerpt(id, [
			system.edges[0]!.refs![0]!,
			{ path: "nope.ts", line: 1, token: "x" },
		]);
		expect(hit!.lines[hit!.line - hit!.start]).toContain("helper");
		expect(missing).toBeNull();

		await blueprints.remove(id);
		expect(await blueprints.list(repo)).toEqual([]);
		expect(await git(repo, "for-each-ref", "refs/omp-blueprint/maps")).toBe("");
	});

	it("keeps the index levels and says why when the agent writes nothing usable", async () => {
		const { blueprints } = manager(
			{
				start: async launch => {
					await fs.writeFile(launch.outFile, "I could not do it");
					return "agent-2";
				},
				hosts: async () => [],
				stop: async () => undefined,
				cost: async () => undefined,
			},
			"run2",
		);
		const { id } = await blueprints.create({ cwd: repo });
		await blueprints.idle();
		const map = await blueprints.get(id);
		expect(map.root).toBe("index:repo");
		expect(map.warnings.join(" ")).toContain("could not be used");
	});

	it("keeps the index levels and passes on why the agent session could not start", async () => {
		const { blueprints } = manager(
			{
				start: async () => {
					throw new Error(
						"omp stopped before it was ready. Last output: Error: Built-in tools unavailable in this session: ast_grep, trace, flow.",
					);
				},
				hosts: async () => [],
				stop: async () => undefined,
				cost: async () => undefined,
			},
			"run2b",
		);
		const { id } = await blueprints.create({ cwd: repo });
		await blueprints.idle();
		const map = await blueprints.get(id);
		expect(map.root).toBe("index:repo");
		expect(map.warnings).toEqual([
			"The agent diagrams are missing: omp stopped before it was ready. Last output: Error: Built-in tools unavailable in this session: ast_grep, trace, flow. The map shows the code-index levels only.",
		]);
	});

	it("marks a diff map's changed files and fails a diff with nothing to compare", async () => {
		await fs.appendFile(path.join(repo, "packages/lib/src/index.ts"), "export const added = 1;\n");
		await fs.writeFile(
			path.join(repo, "packages/app/src/extra.ts"),
			'import { helper } from "@demo/lib";\n\nexport function extra(): string {\n\treturn helper();\n}\n',
		);
		const { blueprints } = manager(null, "run3");
		const { id } = await blueprints.create({ cwd: repo, ref: "@worktree", base: "@default" });
		await blueprints.idle();
		const map = await blueprints.get(id);
		expect(map.base?.commit).toBe(await git(repo, "rev-parse", "HEAD"));
		const nodes = Object.values(map.diagrams).flatMap(d => d.nodes);
		expect(nodes.find(n => n.kind === "file" && n.path === "packages/app/src/extra.ts")?.change).toBe("added");
		expect(nodes.find(n => n.kind === "file" && n.path === "packages/lib/src/index.ts")?.change).toBe("modified");
		expect(nodes.find(n => n.kind === "symbol" && n.label === "added")?.change).toBe("added");
		const edges = Object.values(map.diagrams).flatMap(d => d.edges);
		expect(edges.some(e => e.change === "added")).toBe(true);
		expect(await git(repo, "status", "--porcelain")).toContain("extra.ts");
		await expect(blueprints.create({ cwd: repo, ref: "HEAD", base: "HEAD" })).rejects.toThrow(/nothing to compare/);
	});
});
