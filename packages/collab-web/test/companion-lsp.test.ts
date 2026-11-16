import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	hoverMarkdown,
	previewOf,
	rawLocations,
	severityName,
	toDiagnostics,
	toLocation,
	toServerPosition,
	toWireRange,
} from "../scripts/companion-lsp-map";
import {
	MAX_TEXT_BYTES,
	checkLspQuery,
	checkText,
	liveRoots,
	lspDiagnostics,
	lspQuery,
} from "../scripts/companion-lsp";

const range = (a: number, b: number, c: number, d: number) => ({
	start: { line: a, character: b },
	end: { line: c, character: d },
});

describe("hover content", () => {
	it("passes markdown MarkupContent through", () => {
		expect(hoverMarkdown({ kind: "markdown", value: "```ts\nconst a: 1\n```\n\ndocs" })).toBe(
			"```ts\nconst a: 1\n```\n\ndocs",
		);
	});

	it("fences plain text so it is not read as markdown", () => {
		expect(hoverMarkdown({ kind: "plaintext", value: "a *b* c" })).toBe("```\na *b* c\n```");
	});

	it("fences a MarkedString with its language, and keeps a bare one as markdown", () => {
		expect(hoverMarkdown({ language: "rust", value: "fn main()" })).toBe("```rust\nfn main()\n```");
		expect(hoverMarkdown("**bold**")).toBe("**bold**");
	});

	it("joins arrays and drops empty items", () => {
		expect(hoverMarkdown([{ language: "ts", value: "let x" }, "", "doc", { kind: "markdown", value: "  " }])).toBe(
			"```ts\nlet x\n```\n\ndoc",
		);
	});

	it("uses a fence longer than any backticks inside", () => {
		expect(hoverMarkdown({ language: "md", value: "a ``` b" })).toBe("````md\na ``` b\n````");
	});

	it("is null when there is no text", () => {
		expect(hoverMarkdown(null)).toBeNull();
		expect(hoverMarkdown("")).toBeNull();
		expect(hoverMarkdown([])).toBeNull();
		expect(hoverMarkdown({ kind: "markdown" })).toBeNull();
	});
});

describe("locations", () => {
	const base = "/work/repo";
	const toPath = (uri: string) => Bun.fileURLToPath(uri);

	it("normalises Location, LocationLink and arrays of either", () => {
		const location = { uri: "file:///work/repo/a.ts", range: range(1, 2, 1, 5) };
		const link = {
			targetUri: "file:///work/repo/b.ts",
			targetRange: range(0, 0, 9, 0),
			targetSelectionRange: range(3, 4, 3, 8),
			originSelectionRange: range(0, 0, 0, 1),
		};
		expect(rawLocations(location)).toEqual([location]);
		expect(rawLocations(link)).toEqual([{ uri: link.targetUri, range: link.targetSelectionRange }]);
		expect(rawLocations([location, link])).toHaveLength(2);
		expect(rawLocations([{ targetUri: "file:///x", targetRange: range(1, 1, 2, 2) }])[0]?.range).toEqual(
			range(1, 1, 2, 2),
		);
		expect(rawLocations(null)).toEqual([]);
		expect(rawLocations([{ nonsense: true }, 4, null])).toEqual([]);
	});

	it("makes in-repo paths repository-relative and lines 1-based", () => {
		const { location, abs } = toLocation(
			{ uri: "file:///work/repo/src/a.ts", range: range(1, 2, 1, 5) },
			base,
			toPath,
		);
		expect(abs).toBe("/work/repo/src/a.ts");
		expect(location).toEqual({ path: "src/a.ts", inRepo: true, range: range(2, 2, 2, 5) });
	});

	it("keeps outside paths absolute and not openable", () => {
		const outside = toLocation({ uri: "file:///usr/lib/lib.d.ts", range: range(0, 0, 0, 3) }, base, toPath).location;
		expect(outside).toEqual({ path: "/usr/lib/lib.d.ts", inRepo: false, range: range(1, 0, 1, 3) });
		// A sibling directory sharing the repository's prefix is not inside it.
		expect(
			toLocation({ uri: "file:///work/repo-two/a.ts", range: range(0, 0, 0, 1) }, base, toPath).location.inRepo,
		).toBe(false);
		// Nor is git's own directory.
		expect(
			toLocation({ uri: "file:///work/repo/.git/config", range: range(0, 0, 0, 1) }, base, toPath).location.inRepo,
		).toBe(false);
	});

	it("converts positions both ways", () => {
		expect(toServerPosition({ line: 1, character: 7 })).toEqual({ line: 0, character: 7 });
		expect(toWireRange(range(0, 1, 2, 3))).toEqual(range(1, 1, 3, 3));
	});

	it("trims and cuts previews", () => {
		expect(previewOf("\t  const a = 1;  ")).toBe("const a = 1;");
		expect(previewOf("x".repeat(500))).toHaveLength(200);
		expect(previewOf("   ")).toBeUndefined();
		expect(previewOf(undefined)).toBeUndefined();
	});
});

describe("diagnostics", () => {
	it("maps severity numbers", () => {
		expect([1, 2, 3, 4, undefined, 9].map(severityName)).toEqual([
			"error",
			"warning",
			"info",
			"hint",
			"info",
			"info",
		]);
	});

	it("maps and orders diagnostics, with code as text", () => {
		const out = toDiagnostics([
			{ range: range(4, 0, 4, 1), severity: 2, message: "later", source: "ts", code: 6133 },
			{ range: range(1, 2, 1, 3), severity: 1, message: "first", code: { value: "E1" } },
			{ range: range(1, 0, 1, 1), message: "no severity" },
		]);
		expect(out.map(d => [d.range.start.line, d.severity, d.message, d.code, d.source])).toEqual([
			[2, "info", "no severity", undefined, undefined],
			[2, "error", "first", "E1", undefined],
			[5, "warning", "later", "6133", "ts"],
		]);
	});
});

describe("query validation", () => {
	it("accepts a well-formed query and rejects the rest", () => {
		const ok = { op: "hover", path: "src/a.ts", position: { line: 3, character: 0 } };
		expect(checkLspQuery(ok).path).toBe("src/a.ts");
		expect(() => checkLspQuery({ ...ok, op: "rename" })).toThrow("operation");
		expect(() => checkLspQuery({ ...ok, position: { line: 0, character: 0 } })).toThrow("invalid");
		expect(() => checkLspQuery({ ...ok, position: { line: 1.5, character: 0 } })).toThrow("invalid");
		expect(() => checkLspQuery({ ...ok, position: { line: 1, character: -1 } })).toThrow("invalid");
		expect(() => checkLspQuery({ ...ok, path: "" })).toThrow("invalid path");
		expect(() => checkLspQuery({ ...ok, text: 4 })).toThrow("too large");
		expect(() => checkLspQuery(null)).toThrow("invalid");
	});

	it("caps unsaved text at 4 MB", () => {
		expect(MAX_TEXT_BYTES).toBe(4 * 1024 * 1024);
		expect(() => checkText("x".repeat(MAX_TEXT_BYTES))).not.toThrow();
		expect(() => checkText("x".repeat(MAX_TEXT_BYTES + 1))).toThrow("too large");
		// Few characters, many bytes.
		expect(() => checkText("€".repeat(MAX_TEXT_BYTES / 3 + 1))).toThrow("too large");
		expect(() => checkText(undefined)).not.toThrow();
	});
});

describe("answers that need no server", () => {
	let tmp: string;
	let repo: string;
	let outside: string;

	beforeAll(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-lsp-")));
		repo = path.join(tmp, "repo");
		outside = path.join(tmp, "outside");
		await fs.mkdir(repo);
		await fs.mkdir(outside);
		const git = Bun.spawn(["git", "init", "-q"], { cwd: repo });
		await git.exited;
		await fs.writeFile(path.join(repo, "notes.zzunknown"), "hello\n");
		await fs.writeFile(path.join(outside, "x.ts"), "export const x = 1;\n");
		await fs.symlink(path.join(outside, "x.ts"), path.join(repo, "escape.ts"));
	});

	afterAll(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	const query = (file: string) => ({ op: "hover" as const, path: file, position: { line: 1, character: 0 } });

	it("says why a sandboxed session gets none", async () => {
		expect(await lspQuery(repo, true, query("notes.zzunknown"))).toEqual({
			kind: "unavailable",
			reason: "language servers don't run for sandboxed sessions",
		});
		expect(await lspDiagnostics(repo, true, "notes.zzunknown", undefined)).toMatchObject({ kind: "unavailable" });
	});

	it("says when no server handles the file", async () => {
		const result = await lspQuery(repo, false, query("notes.zzunknown"));
		expect(result).toMatchObject({ kind: "unavailable" });
		expect(result.kind === "unavailable" && result.reason).toContain(".zzunknown");
		expect(liveRoots()).toEqual([]);
	});

	it("refuses a path that escapes the repository through a symlink", async () => {
		await expect(lspQuery(repo, false, query("escape.ts"))).rejects.toThrow("outside the repository");
		await expect(lspQuery(repo, false, query("../outside/x.ts"))).rejects.toThrow("outside the repository");
	});

	it("reports a missing file", async () => {
		await expect(lspQuery(repo, false, query("gone.ts"))).rejects.toThrow("file not found");
	});
});
