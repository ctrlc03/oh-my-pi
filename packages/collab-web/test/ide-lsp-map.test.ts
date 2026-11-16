import { describe, expect, it } from "bun:test";
import { Text } from "@codemirror/state";
import {
	chooseDefinitionTarget,
	countDiagnostics,
	offsetToPosition,
	positionToOffset,
	textPositionAt,
	toMarker,
	toRangeDiagnostic,
	uniqueLocations,
	unavailableNote,
} from "../src/components/ide/backend/lsp-map";
import { luminance, parseCssColor, toHex } from "../src/components/ide/backend/color";
import type { LspDiagnostic, LspLocation } from "../src/lib/repo-intel";

const loc = (path: string, line: number, character = 0, inRepo = true): LspLocation => ({
	path,
	inRepo,
	range: { start: { line, character }, end: { line, character: character + 1 } },
});

describe("position conversion", () => {
	const doc = Text.of(["let a = 1;", "", "😀 x"]);

	it("maps offsets to 1-based lines and 0-based UTF-16 characters", () => {
		expect(offsetToPosition(doc, 0)).toEqual({ line: 1, character: 0 });
		expect(offsetToPosition(doc, 4)).toEqual({ line: 1, character: 4 });
		// The empty second line starts at 11.
		expect(offsetToPosition(doc, 11)).toEqual({ line: 2, character: 0 });
		// After the astral character: two UTF-16 units.
		expect(offsetToPosition(doc, 12 + 2)).toEqual({ line: 3, character: 2 });
	});

	it("round-trips and clamps", () => {
		expect(positionToOffset(doc, { line: 3, character: 3 })).toBe(15);
		expect(positionToOffset(doc, { line: 1, character: 99 })).toBe(10);
		expect(positionToOffset(doc, { line: 99, character: 0 })).toBe(12);
		expect(positionToOffset(doc, { line: 0, character: -4 })).toBe(0);
		expect(offsetToPosition(doc, 9999)).toEqual({ line: 3, character: 4 });
		expect(offsetToPosition(doc, -5)).toEqual({ line: 1, character: 0 });
	});

	it("finds a position in LF text; a lone CR is not a line break", () => {
		expect(textPositionAt("ab\ncd\nef", 0)).toEqual({ line: 1, character: 0 });
		expect(textPositionAt("ab\ncd\nef", 4)).toEqual({ line: 2, character: 1 });
		expect(textPositionAt("ab\ncd\nef", 99)).toEqual({ line: 3, character: 2 });
		expect(textPositionAt("a\rb\nc", 3)).toEqual({ line: 1, character: 3 });
		// An offset at the break stays on the line it ends.
		expect(textPositionAt("ab\ncd", 2)).toEqual({ line: 1, character: 2 });
		expect(textPositionAt("ab\ncd", 3)).toEqual({ line: 2, character: 0 });
	});
});

describe("definition answers", () => {
	it("opens a single in-repo location", () => {
		expect(chooseDefinitionTarget({ kind: "locations", server: "ts", locations: [loc("src/a.ts", 7, 4)] })).toEqual({
			kind: "open",
			path: "src/a.ts",
			line: 7,
			character: 4,
		});
	});

	it("lists several places, and one outside the repository", () => {
		const two = [loc("a.ts", 1), loc("b.ts", 2)];
		expect(chooseDefinitionTarget({ kind: "locations", server: "ts", locations: two })).toEqual({
			kind: "list",
			locations: two,
		});
		const outside = [loc("/usr/lib/lib.d.ts", 3, 0, false)];
		expect(chooseDefinitionTarget({ kind: "locations", server: "ts", locations: outside }).kind).toBe("list");
	});

	it("does not list a symbol twice", () => {
		const dup = [loc("a.ts", 1, 2), loc("a.ts", 1, 2), loc("a.ts", 1, 3)];
		expect(uniqueLocations(dup)).toHaveLength(2);
		expect(chooseDefinitionTarget({ kind: "locations", server: "ts", locations: [dup[0]!, dup[1]!] }).kind).toBe(
			"open",
		);
	});

	it("falls back to the code map when the server has nothing", () => {
		expect(chooseDefinitionTarget({ kind: "locations", server: "ts", locations: [] })).toEqual({ kind: "fallback" });
		expect(chooseDefinitionTarget({ kind: "unavailable", reason: "none" })).toEqual({ kind: "fallback" });
		expect(chooseDefinitionTarget({ kind: "hover", server: "ts", markdown: "x" })).toEqual({ kind: "fallback" });
		expect(chooseDefinitionTarget(null)).toEqual({ kind: "fallback" });
	});
});

describe("diagnostics", () => {
	const diagnostic = (
		sl: number,
		sc: number,
		el: number,
		ec: number,
		severity: LspDiagnostic["severity"] = "error",
	): LspDiagnostic => ({
		range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
		severity,
		message: "bad",
		source: "ts",
		code: "2304",
	});
	const lines = ["let a = 1;", "", "abc"];
	const lineLength = (n: number): number => lines[n - 1]?.length ?? 0;

	it("makes Monaco markers with 1-based columns", () => {
		const marker = toMarker(diagnostic(1, 4, 1, 5, "warning"), 3, lineLength);
		expect(marker).toMatchObject({
			severity: 4,
			startLineNumber: 1,
			startColumn: 5,
			endLineNumber: 1,
			endColumn: 6,
			message: "bad",
			code: "2304",
		});
		expect(toMarker(diagnostic(1, 0, 1, 1, "hint"), 3, lineLength).severity).toBe(1);
		expect(toMarker(diagnostic(1, 0, 1, 1, "info"), 3, lineLength).severity).toBe(2);
		expect(toMarker(diagnostic(1, 0, 1, 1, "error"), 3, lineLength).severity).toBe(8);
	});

	it("widens an empty range, even at the end of a line", () => {
		expect(toMarker(diagnostic(1, 2, 1, 2), 3, lineLength)).toMatchObject({ startColumn: 3, endColumn: 4 });
		expect(toMarker(diagnostic(3, 3, 3, 3), 3, lineLength)).toMatchObject({ startColumn: 3, endColumn: 4 });
		// An empty line has nothing to underline: the marker keeps its one column.
		expect(toMarker(diagnostic(2, 0, 2, 0), 3, lineLength)).toMatchObject({ startColumn: 1, endColumn: 1 });
	});

	it("clamps ranges into the document", () => {
		const marker = toMarker(diagnostic(0, -3, 99, 99), 3, lineLength);
		expect(marker).toMatchObject({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 4 });
	});

	it("makes CodeMirror diagnostics with offsets", () => {
		const doc = Text.of(lines);
		expect(toRangeDiagnostic(diagnostic(1, 4, 1, 5), doc)).toMatchObject({
			from: 4,
			to: 5,
			severity: "error",
			message: "bad (2304)",
		});
		expect(toRangeDiagnostic(diagnostic(1, 2, 1, 2, "hint"), doc)).toMatchObject({
			from: 2,
			to: 3,
			severity: "info",
		});
		// Empty at the very end of the document: the character before it.
		const end = toRangeDiagnostic(diagnostic(3, 3, 3, 3), doc);
		expect(end.to).toBe(doc.length);
		expect(end.from).toBe(doc.length - 1);
		expect(toRangeDiagnostic(diagnostic(99, 0, 99, 5), doc).to).toBeLessThanOrEqual(doc.length);
	});

	it("counts errors and warnings", () => {
		const list = [diagnostic(1, 0, 1, 1), diagnostic(1, 0, 1, 1, "warning"), diagnostic(1, 0, 1, 1, "hint")];
		expect(countDiagnostics(list)).toEqual({ errors: 1, warnings: 1 });
		expect(countDiagnostics([])).toEqual({ errors: 0, warnings: 0 });
	});

	it("names what has no server", () => {
		expect(unavailableNote("src/a.rs")).toBe("No language server for .rs");
		expect(unavailableNote("Makefile")).toBe("No language server for Makefile");
		expect(unavailableNote("dir.d/.envrc")).toBe("No language server for .envrc");
	});
});

describe("css colours", () => {
	it("parses what a browser reports as a computed colour", () => {
		expect(parseCssColor("rgb(10, 20, 30)")).toEqual([10, 20, 30, 1]);
		expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 0.5]);
		expect(parseCssColor("rgb(10 20 30 / 50%)")).toEqual([10, 20, 30, 0.5]);
		expect(parseCssColor("color(srgb 1 0 0.5 / 0.25)")).toEqual([255, 0, 128, 0.25]);
		expect(parseCssColor("#abc")).toEqual([170, 187, 204, 1]);
		expect(parseCssColor("#11223380")?.[3]).toBeCloseTo(0.5, 1);
		expect(parseCssColor("transparent")).toEqual([0, 0, 0, 0]);
	});

	it("leaves anything else to the canvas", () => {
		expect(parseCssColor("color-mix(in srgb, red 10%, blue)")).toBeNull();
		expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
		expect(parseCssColor("#12")).toBeNull();
		expect(parseCssColor("")).toBeNull();
	});

	it("writes hex and tells light from dark", () => {
		expect(toHex([255, 0, 128, 1])).toBe("#ff0080");
		expect(toHex([0, 0, 0, 0.5])).toBe("#00000080");
		expect(luminance([0, 0, 0, 1])).toBe(0);
		expect(luminance([255, 255, 255, 1])).toBeCloseTo(1, 5);
	});
});
