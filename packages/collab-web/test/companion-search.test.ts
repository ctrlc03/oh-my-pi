import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionSearch, parseQuery, snippetAround, withLiveness } from "../scripts/companion-search";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-search-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

type Line = Record<string, unknown>;

const header = (id: string, cwd = "/work/app", extra: Line = {}): Line => ({
	type: "session",
	version: 3,
	id,
	timestamp: "2026-10-01T10:00:00.000Z",
	cwd,
	...extra,
});
const user = (id: string, text: string, extra: Line = {}): Line => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-10-01T10:01:00.000Z",
	message: { role: "user", content: [{ type: "text", text }], attribution: "user", ...extra },
});
const reply = (id: string, text: string): Line => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-10-01T10:02:00.000Z",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

/** Write a session file the way omp lays them out; `at` is its mtime in Unix seconds. */
async function session(id: string, lines: Line[], at: number, folder = "-work-app"): Promise<string> {
	const folderDir = path.join(dir, folder);
	await fs.mkdir(folderDir, { recursive: true });
	const file = path.join(folderDir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	await fs.utimes(file, at, at);
	return file;
}

const search = (query: string) => createSessionSearch({ sessionsDir: dir }).search(query);

describe("what is searchable", () => {
	it("finds prompts (text, blocks, collab guests) and reply text, and nothing else", async () => {
		await session(
			"s1",
			[
				header("s1"),
				user("u1", "needle in a typed prompt"),
				{
					type: "message",
					id: "u2",
					message: { role: "user", content: "needle as plain string" },
				},
				{ type: "custom_message", customType: "collab-prompt", id: "g1", content: "needle from a guest" },
				{
					type: "custom_message",
					customType: "collab-prompt",
					id: "g2",
					content: [{ type: "text", text: "needle from a guest in blocks" }],
				},
				reply("a1", "needle in a reply"),
				// Everything below must stay invisible.
				{
					type: "message",
					id: "t1",
					message: {
						role: "toolResult",
						toolName: "read",
						content: [{ type: "text", text: "needle in tool output" }],
					},
				},
				{
					type: "message",
					id: "a2",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "needle in thinking" },
							{ type: "toolCall", id: "c", name: "bash", arguments: { command: "echo needle" } },
						],
					},
				},
				user("u3", "needle in a harness-written prompt", { attribution: "agent" }),
				{ type: "custom_message", customType: "async-result", id: "n1", content: "needle in a notice" },
			],
			100,
		);
		const { results, truncated } = await search("needle");
		expect(truncated).toBe(false);
		expect(results.map(hit => [hit.entryId, hit.role]).sort()).toEqual(
			[
				["u1", "user"],
				["u2", "user"],
				["g1", "user"],
				["g2", "user"],
				["a1", "assistant"],
			].sort(),
		);
	});

	it("needs every term in the same entry, ignoring case", async () => {
		await session(
			"s1",
			[
				header("s1"),
				user("u1", "Fix the Flaky TEST in CI"),
				user("u2", "fix the build"),
				reply("a1", "the test passes"),
			],
			100,
		);
		const { results } = await search("flaky  test");
		expect(results.map(hit => hit.entryId)).toEqual(["u1"]);
		expect((await search("fix test")).results.map(hit => hit.entryId)).toEqual(["u1"]);
		expect((await search("build test")).results).toEqual([]);
	});

	it("skips a half-written last line and keeps what precedes it", async () => {
		const file = await session("s1", [header("s1"), user("u1", "findme early")], 100);
		await fs.appendFile(file, '{"type":"message","id":"u2","message":{"role":"user","content":"findme tor');
		expect((await search("findme")).results.map(hit => hit.entryId)).toEqual(["u1"]);
	});
});

describe("results", () => {
	it("carry the session's title and folder, newest session and newest entry first, subagents excluded", async () => {
		await session("old", [header("old", "/work/old"), user("o1", "shared words here")], 100, "-work-old");
		await session(
			"new",
			[
				header("new", "/work/new", { title: "Header name" }),
				{ type: "title", v: 1, title: "Slot name", source: "auto" },
				user("n1", "shared words early"),
				reply("n2", "shared words late"),
			],
			200,
			"-work-new",
		);
		// A subagent's transcript lives in a subfolder of the parent's directory.
		const nested = path.join(dir, "-work-new", "agents");
		await fs.mkdir(nested, { recursive: true });
		await Bun.write(
			path.join(nested, "0-Sub.jsonl"),
			`${JSON.stringify(header("sub"))}\n${JSON.stringify(user("x1", "shared words sub"))}\n`,
		);

		const { results } = await search("shared words");
		expect(results.map(hit => hit.entryId)).toEqual(["n2", "n1", "o1"]);
		expect(results[0]).toMatchObject({
			sessionId: "new",
			title: "Slot name",
			cwd: "/work/new",
			role: "assistant",
			time: Date.parse("2026-10-01T10:02:00.000Z"),
		});
		expect(results[2]).toMatchObject({ sessionId: "old", title: null, cwd: "/work/old" });
	});

	it("name a renamed session by its latest title_change when there is no title slot", async () => {
		await session(
			"s1",
			[
				header("s1", "/work/app", { title: "First" }),
				user("u1", "rename me"),
				{ type: "title_change", id: "t", title: "Second" },
			],
			100,
		);
		expect((await search("rename")).results[0]?.title).toBe("Second");
	});
});

describe("limit and time budget", () => {
	it("stops at the limit and says more exist only when more do", async () => {
		await session(
			"s1",
			[header("s1"), user("u1", "match one"), user("u2", "match two"), user("u3", "match three")],
			100,
		);
		const search2 = createSessionSearch({ sessionsDir: dir });
		const limited = await search2.search("match", 2);
		expect(limited.results.map(hit => hit.entryId)).toEqual(["u3", "u2"]);
		expect(limited.truncated).toBe(true);
		const exact = await search2.search("match", 3);
		expect(exact.results).toHaveLength(3);
		expect(exact.truncated).toBe(false);
	});

	it("reports truncated, with what it did reach, when the budget runs out between files", async () => {
		await session("old", [header("old"), user("o1", "budget match")], 100, "-work-old");
		await session("new", [header("new"), user("n1", "budget match")], 200, "-work-new");
		let clock = 0;
		// Each clock read costs 100 ms against a 150 ms budget: the first file starts in time, the second finds it spent.
		const found = await createSessionSearch({
			sessionsDir: dir,
			budgetMs: 150,
			now: () => {
				clock += 100;
				return clock;
			},
		}).search("budget");
		expect(found.truncated).toBe(true);
		expect(found.results.map(hit => hit.entryId)).toEqual(["n1"]);
	});

	it("scans every file within the budget and reports a complete result", async () => {
		await session("old", [header("old"), user("o1", "budget match")], 100, "-work-old");
		await session("new", [header("new"), user("n1", "budget match")], 200, "-work-new");
		const found = await search("budget");
		expect(found.truncated).toBe(false);
		expect(found.results).toHaveLength(2);
	});
});

describe("cache", () => {
	it("serves an unchanged file from memory, and rescans it once it grows", async () => {
		const file = await session("s1", [header("s1"), user("u1", "alpha cached")], 100);
		const searcher = createSessionSearch({ sessionsDir: dir });
		expect((await searcher.search("cached")).results).toHaveLength(1);
		// Same size, same mtime: nothing on disk is read again.
		const before = await fs.stat(file);
		await Bun.write(file, (await Bun.file(file).text()).replace("alpha cached", "omega cached"));
		await fs.utimes(file, before.mtimeMs / 1000, before.mtimeMs / 1000);
		expect((await searcher.search("omega")).results).toHaveLength(0);
		await fs.appendFile(file, `${JSON.stringify(user("u2", "fresh cached"))}\n`);
		expect((await searcher.search("cached")).results.map(hit => hit.entryId)).toEqual(["u2", "u1"]);
		expect((await searcher.search("omega")).results.map(hit => hit.entryId)).toEqual(["u1"]);
	});

	it("keeps answering correctly when the bound is smaller than the sessions", async () => {
		for (const [i, id] of ["a", "b", "c"].entries()) {
			await session(id, [header(id), user(`u-${id}`, `bounded text ${id}`)], 100 + i, `-work-${id}`);
		}
		const searcher = createSessionSearch({ sessionsDir: dir, maxFiles: 1 });
		for (let round = 0; round < 2; round++) {
			expect((await searcher.search("bounded")).results.map(hit => hit.entryId)).toEqual(["u-c", "u-b", "u-a"]);
		}
		const tiny = createSessionSearch({ sessionsDir: dir, maxChars: 5 });
		expect((await tiny.search("bounded")).results).toHaveLength(3);
	});
});

describe("parseQuery", () => {
	it("splits words, lowercases, and refuses fewer than two characters", () => {
		expect(parseQuery("  Foo  BAR foo ")).toEqual(["foo", "bar"]);
		expect(() => parseQuery("a")).toThrow();
		expect(() => parseQuery("   ")).toThrow();
		expect(() => parseQuery(42)).toThrow();
	});
});

describe("snippetAround", () => {
	it("shows about 160 characters around the hit, whitespace collapsed, with ellipses where cut", () => {
		const text = `${"a ".repeat(100)}NEEDLE\n\n  tail ${"b ".repeat(100)}`;
		const snippet = snippetAround(text, text.indexOf("NEEDLE"));
		expect(snippet).toContain("NEEDLE tail");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBeGreaterThan(100);
		expect(snippet.length).toBeLessThanOrEqual(162);
		expect(snippetAround("short text", 6)).toBe("short text");
	});

	it("does not start or end inside a surrogate pair", () => {
		// The window would start on the emoji's second half...
		const early = snippetAround(`${"x".repeat(49)}😀${"y".repeat(300)}`, 100);
		expect(early).toMatch(/^…y/);
		// ...and end after its first half.
		const late = snippetAround(`${"a".repeat(159)}😀${"b".repeat(50)}`, 10);
		expect(late).toMatch(/a…$/);
	});
});

describe("withLiveness", () => {
	it("marks hits of hosting and idle sessions, preferring the host", () => {
		const hit = (sessionId: string) => ({
			sessionId,
			title: null,
			cwd: "/w",
			entryId: "e",
			role: "user" as const,
			snippet: "s",
			time: 1,
		});
		const marked = withLiveness([hit("a"), hit("b"), hit("c")], {
			hosts: [{ sessionId: "a", instanceId: "H" }],
			idle: [
				{ sessionId: "a", instanceId: "I1" },
				{ sessionId: "b", instanceId: "I2" },
			],
		});
		expect(marked[0]).toMatchObject({ instanceId: "H", live: "host" });
		expect(marked[1]).toMatchObject({ instanceId: "I2", live: "idle" });
		expect(marked[2]?.live).toBeUndefined();
	});
});
