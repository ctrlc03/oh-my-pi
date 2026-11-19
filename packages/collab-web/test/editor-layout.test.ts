import { describe, expect, it } from "bun:test";
import { EDITOR_MIN, explorerFits } from "../src/components/ide/explorer/explorer-state";
import { problemRows, type ProblemRow, sortProblems } from "../src/components/ide/problems";
import {
	clampDefsSize,
	clampFontSize,
	clampPanelHeight,
	DEFAULT_LAYOUT,
	DEFS_MARGIN,
	DEFS_MIN_HEIGHT,
	DEFS_MIN_WIDTH,
	FONT_MAX,
	FONT_MIN,
	fontShortcut,
	formatFontSize,
	HEAD_COMPACT_BELOW,
	HEAD_TIGHT_BELOW,
	headTierFor,
	MINIMAP_MIN_WIDTH,
	minimapShown,
	PANEL_DEFAULT,
	PANEL_MIN,
	panelMaxHeight,
	parseEditorLayout,
	serializeEditorLayout,
	stepFontSize,
} from "../src/lib/editor-layout";

const chord = (key: string, extra: Partial<Parameters<typeof fontShortcut>[0]> = {}) =>
	fontShortcut({ key, code: "", metaKey: true, ctrlKey: false, altKey: false, ...extra });

describe("parseEditorLayout", () => {
	it("is the defaults for nothing and for junk", () => {
		for (const raw of [null, undefined, 5, "x", [], [1, 2], {}, { rail: "no", fontSize: "13", panel: 3 }]) {
			expect(parseEditorLayout(raw)).toEqual(DEFAULT_LAYOUT);
		}
	});

	it("defaults every toggle on and the minimap to automatic", () => {
		expect(DEFAULT_LAYOUT).toMatchObject({
			rail: true,
			tabs: true,
			lineNumbers: true,
			status: true,
			attribution: true,
			minimap: null,
			fontSize: null,
			panelOpen: false,
			defsSize: null,
		});
	});

	it("reads each toggle and keeps an explicit minimap choice either way", () => {
		const layout = parseEditorLayout({
			rail: false,
			tabs: false,
			minimap: true,
			lineNumbers: false,
			status: false,
			attribution: false,
		});
		expect(layout).toMatchObject({
			rail: false,
			tabs: false,
			minimap: true,
			lineNumbers: false,
			status: false,
			attribution: false,
		});
		expect(parseEditorLayout({ minimap: false }).minimap).toBe(false);
		expect(parseEditorLayout({ minimap: "yes" }).minimap).toBeNull();
	});

	it("clamps the font size to 9 through 28 whole pixels and drops what is not a number", () => {
		expect(parseEditorLayout({ fontSize: 3 }).fontSize).toBe(FONT_MIN);
		expect(parseEditorLayout({ fontSize: 99 }).fontSize).toBe(FONT_MAX);
		expect(parseEditorLayout({ fontSize: 13.4 }).fontSize).toBe(13);
		expect(parseEditorLayout({ fontSize: Number.NaN }).fontSize).toBeNull();
		expect(parseEditorLayout({ fontSize: null }).fontSize).toBeNull();
	});

	it("keeps the panel at least 80px and falls back to its default for junk", () => {
		expect(parseEditorLayout({ panel: { height: 10 } }).panelHeight).toBe(PANEL_MIN);
		expect(parseEditorLayout({ panel: { height: 300.6 } }).panelHeight).toBe(301);
		expect(parseEditorLayout({ panel: { height: "tall" } }).panelHeight).toBe(PANEL_DEFAULT);
		expect(parseEditorLayout({ panel: { height: 1e9 } }).panelHeight).toBe(PANEL_DEFAULT);
		expect(parseEditorLayout({ panel: { open: true } }).panelOpen).toBe(true);
		expect(parseEditorLayout({ panel: { open: 1 } }).panelOpen).toBe(false);
	});

	it("reads the definitions size only when both sides are numbers, at least its minimum", () => {
		expect(parseEditorLayout({ defs: { width: 500, height: 300 } }).defsSize).toEqual({ width: 500, height: 300 });
		expect(parseEditorLayout({ defs: { width: 10, height: 10 } }).defsSize).toEqual({
			width: DEFS_MIN_WIDTH,
			height: DEFS_MIN_HEIGHT,
		});
		expect(parseEditorLayout({ defs: { width: 500 } }).defsSize).toBeNull();
		expect(parseEditorLayout({ defs: { width: "a", height: 1 } }).defsSize).toBeNull();
		expect(parseEditorLayout({ defs: { width: 1e9, height: 300 } }).defsSize).toBeNull();
	});
});

describe("serializeEditorLayout", () => {
	it("stores nothing for the defaults", () => {
		expect(serializeEditorLayout(DEFAULT_LAYOUT)).toBeNull();
	});

	it("round-trips a changed layout and stores only what differs", () => {
		const changed = {
			...DEFAULT_LAYOUT,
			rail: false,
			minimap: false,
			fontSize: 15,
			panelHeight: 300,
			panelOpen: true,
			defsSize: { width: 500, height: 280 },
		};
		const stored = serializeEditorLayout(changed);
		expect(stored).toEqual({
			rail: false,
			minimap: false,
			fontSize: 15,
			panel: { height: 300, open: true },
			defs: { width: 500, height: 280 },
		});
		expect(parseEditorLayout(stored)).toEqual(changed);
	});
});

describe("font size", () => {
	it("clamps to the range", () => {
		expect(clampFontSize(0)).toBe(FONT_MIN);
		expect(clampFontSize(100)).toBe(FONT_MAX);
		expect(clampFontSize(12.6)).toBe(13);
	});

	it("steps from the app's fractional size and stops at the ends", () => {
		expect(stepFontSize(12.5, 1)).toBe(14);
		expect(stepFontSize(12.4, -1)).toBe(11);
		expect(stepFontSize(FONT_MAX, 1)).toBe(FONT_MAX);
		expect(stepFontSize(FONT_MIN, -1)).toBe(FONT_MIN);
	});

	it("recognises the zoom chords with Cmd or Ctrl and not with Alt", () => {
		expect(chord("=")).toBe("bigger");
		expect(chord("+", { metaKey: false, ctrlKey: true })).toBe("bigger");
		expect(chord("-")).toBe("smaller");
		expect(chord("0")).toBe("reset");
		expect(chord("", { code: "NumpadAdd" })).toBe("bigger");
		expect(chord("", { code: "NumpadSubtract" })).toBe("smaller");
		expect(chord("=", { altKey: true })).toBeNull();
		expect(chord("=", { metaKey: false })).toBeNull();
		expect(chord("p")).toBeNull();
	});
});

describe("minimap", () => {
	it("follows the user's choice whatever the pane", () => {
		expect(minimapShown(true, false, 300)).toBe(true);
		expect(minimapShown(false, true, 2000)).toBe(false);
	});

	it("is automatic when unset: shown in a tab or a wide pane", () => {
		expect(minimapShown(null, true, 300)).toBe(true);
		expect(minimapShown(null, false, MINIMAP_MIN_WIDTH)).toBe(true);
		expect(minimapShown(null, false, MINIMAP_MIN_WIDTH - 1)).toBe(false);
	});
});

describe("formatFontSize", () => {
	it("shows whole pixels plainly and the app's fractional sizes to a tenth", () => {
		expect(formatFontSize(13)).toBe("13px");
		expect(formatFontSize(13.75)).toBe("13.8px");
		expect(formatFontSize(12.5)).toBe("12.5px");
	});
});

describe("panel and popup limits", () => {
	it("holds the panel between 80px and 70% of the column", () => {
		expect(clampPanelHeight(10, 600)).toBe(PANEL_MIN);
		expect(clampPanelHeight(900, 600)).toBe(420);
		expect(clampPanelHeight(250, 600)).toBe(250);
		expect(panelMaxHeight(600)).toBe(420);
	});

	it("keeps the panel's minimum in a column too short for 70%", () => {
		expect(clampPanelHeight(200, 60)).toBe(PANEL_MIN);
	});

	it("holds the popup between its minimum and the area less a margin", () => {
		const area = { width: 800, height: 500 };
		expect(clampDefsSize({ width: 10, height: 10 }, area)).toEqual({
			width: DEFS_MIN_WIDTH,
			height: DEFS_MIN_HEIGHT,
		});
		expect(clampDefsSize({ width: 5000, height: 5000 }, area)).toEqual({
			width: 800 - DEFS_MARGIN,
			height: 500 - DEFS_MARGIN,
		});
		expect(clampDefsSize({ width: 400, height: 200 }, area)).toEqual({ width: 400, height: 200 });
	});

	it("keeps the popup's minimum in an area smaller than it", () => {
		expect(clampDefsSize({ width: 400, height: 400 }, { width: 100, height: 50 })).toEqual({
			width: DEFS_MIN_WIDTH,
			height: DEFS_MIN_HEIGHT,
		});
	});
});

describe("sortProblems", () => {
	const row = (over: Partial<ProblemRow>): ProblemRow => ({
		path: "a.ts",
		line: 1,
		character: 0,
		severity: "error",
		message: "m",
		...over,
	});

	it("puts errors before warnings, information and hints", () => {
		const sorted = sortProblems([
			row({ severity: "hint", message: "h" }),
			row({ severity: "warning", message: "w" }),
			row({ severity: "info", message: "i" }),
			row({ severity: "error", message: "e" }),
		]);
		expect(sorted.map(r => r.message)).toEqual(["e", "w", "i", "h"]);
	});

	it("orders equal severities by file, then line, then column", () => {
		const sorted = sortProblems([
			row({ path: "b.ts", line: 1 }),
			row({ path: "a.ts", line: 9 }),
			row({ path: "a.ts", line: 2, character: 8 }),
			row({ path: "a.ts", line: 2, character: 1 }),
		]);
		expect(sorted.map(r => `${r.path}:${r.line}:${r.character}`)).toEqual([
			"a.ts:2:1",
			"a.ts:2:8",
			"a.ts:9:0",
			"b.ts:1:0",
		]);
	});

	it("does not reorder its input", () => {
		const input = [row({ severity: "warning" }), row({ severity: "error" })];
		sortProblems(input);
		expect(input[0]?.severity).toBe("warning");
	});
});

describe("problemRows", () => {
	const at = (line: number, character: number) => ({ line, character });
	it("flattens the open files' diagnostics worst first and skips files with none known", () => {
		const rows = problemRows([
			{
				path: "b.ts",
				diagnostics: [{ range: { start: at(3, 2), end: at(3, 5) }, severity: "warning", message: "unused" }],
			},
			{ path: "c.ts", diagnostics: null },
			{
				path: "a.ts",
				diagnostics: [
					{
						range: { start: at(7, 0), end: at(7, 1) },
						severity: "error",
						message: "bad",
						source: "tsc",
						code: "2304",
					},
				],
			},
		]);
		expect(rows).toEqual([
			{ path: "a.ts", line: 7, character: 0, severity: "error", message: "bad", source: "tsc", code: "2304" },
			{
				path: "b.ts",
				line: 3,
				character: 2,
				severity: "warning",
				message: "unused",
				source: undefined,
				code: undefined,
			},
		]);
	});
});

describe("headTierFor", () => {
	it("is full until the editor is measured and while it is wide", () => {
		expect(headTierFor(null)).toBe("full");
		expect(headTierFor(HEAD_COMPACT_BELOW)).toBe("full");
		expect(headTierFor(1200)).toBe("full");
	});

	it("moves the font buttons into the menu below the compact width, the code actions too below the tight one", () => {
		expect(headTierFor(HEAD_COMPACT_BELOW - 1)).toBe("compact");
		expect(headTierFor(HEAD_TIGHT_BELOW)).toBe("compact");
		expect(headTierFor(HEAD_TIGHT_BELOW - 1)).toBe("tight");
		expect(headTierFor(0)).toBe("tight");
	});
});

describe("explorerFits", () => {
	it("keeps the code at least EDITOR_MIN (360px) wide beside the explorer", () => {
		expect(EDITOR_MIN).toBe(360);
		expect(explorerFits(640, 280)).toBe(true);
		expect(explorerFits(639, 280)).toBe(false);
		expect(explorerFits(520, 280)).toBe(false);
	});

	it("depends on the explorer's width: a wider one needs a wider body", () => {
		expect(explorerFits(700, 200)).toBe(true);
		expect(explorerFits(700, 400)).toBe(false);
	});
});
