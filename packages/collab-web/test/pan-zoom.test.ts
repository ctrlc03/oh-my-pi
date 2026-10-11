import { describe, expect, it } from "bun:test";
import { fitView, MAX_SCALE, MIN_SCALE, panBy, pinchView, wheelFactor, zoomAt } from "../src/lib/pan-zoom";
import { isSafeSvg, standaloneSvg, svgSize } from "../src/lib/svg";
import { mermaidThemeVariables } from "../src/lib/theme-tokens";

describe("pan-zoom", () => {
	it("fits content inside the viewport, centred", () => {
		const view = fitView({ width: 400, height: 200 }, { width: 800, height: 600 });
		expect(view.scale).toBeCloseTo(768 / 400 > 3 ? 3 : 768 / 400);
		expect(view.x).toBeCloseTo((800 - 400 * view.scale) / 2);
		expect(view.y).toBeCloseTo((600 - 200 * view.scale) / 2);
	});

	it("does not blow a tiny diagram up past the fit limit and survives empty sizes", () => {
		expect(fitView({ width: 10, height: 10 }, { width: 800, height: 600 }).scale).toBe(3);
		expect(fitView({ width: 0, height: 10 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, scale: 1 });
	});

	it("zooms about the anchor", () => {
		const view = zoomAt({ x: 10, y: 20, scale: 1 }, 2, { x: 110, y: 120 });
		expect(view.scale).toBe(2);
		// The content point under the anchor stays under it.
		expect((110 - view.x) / view.scale).toBeCloseTo((110 - 10) / 1);
		expect((120 - view.y) / view.scale).toBeCloseTo((120 - 20) / 1);
	});

	it("clamps the zoom", () => {
		expect(zoomAt({ x: 0, y: 0, scale: 1 }, 1e9, { x: 0, y: 0 }).scale).toBe(MAX_SCALE);
		expect(zoomAt({ x: 0, y: 0, scale: 1 }, 1e-9, { x: 0, y: 0 }).scale).toBe(MIN_SCALE);
	});

	it("pans", () => {
		expect(panBy({ x: 1, y: 2, scale: 3 }, 10, -5)).toEqual({ x: 11, y: -3, scale: 3 });
	});

	it("pinches: spread zooms, midpoint drag pans", () => {
		const from = { a: { x: 100, y: 100 }, b: { x: 200, y: 100 } };
		const spread = pinchView({ x: 0, y: 0, scale: 1 }, from, { a: { x: 50, y: 100 }, b: { x: 250, y: 100 } });
		expect(spread.scale).toBeCloseTo(2);
		const drag = pinchView({ x: 0, y: 0, scale: 1 }, from, { a: { x: 130, y: 120 }, b: { x: 230, y: 120 } });
		expect(drag.scale).toBeCloseTo(1);
		expect(drag.x).toBeCloseTo(30);
		expect(drag.y).toBeCloseTo(20);
	});

	it("ignores a pinch that starts with the fingers together", () => {
		const together = { a: { x: 5, y: 5 }, b: { x: 5, y: 5 } };
		expect(pinchView({ x: 0, y: 0, scale: 1 }, together, together).scale).toBe(1);
	});

	it("turns wheel notches into zoom factors, in and out", () => {
		expect(wheelFactor(-100, 0)).toBeGreaterThan(1);
		expect(wheelFactor(100, 0)).toBeLessThan(1);
		expect(wheelFactor(1, 1)).toBeCloseTo(wheelFactor(16, 0));
		expect(wheelFactor(1e6, 0)).toBeGreaterThan(0);
	});
});

describe("svg helpers", () => {
	it("accepts plain SVG and refuses active content", () => {
		expect(isSafeSvg('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')).toBe(true);
		expect(isSafeSvg("<div></div>")).toBe(false);
		expect(isSafeSvg("<svg><script>alert(1)</script></svg>")).toBe(false);
		expect(isSafeSvg("<svg><foreignObject><div/></foreignObject></svg>")).toBe(false);
		expect(isSafeSvg('<svg onload="x()"></svg>')).toBe(false);
		expect(isSafeSvg('<svg><a href="javascript:alert(1)"><text/></a></svg>')).toBe(false);
	});

	it("judges markup, not label text", () => {
		expect(
			isSafeSvg("<svg><text>retry once = 3</text><text>javascript: basics</text><text>only = true</text></svg>"),
		).toBe(true);
		expect(isSafeSvg('<svg><g title="a > b" class="x"><text>ok</text></g></svg>')).toBe(true);
	});

	it("still catches handlers hidden behind a quoted '>'", () => {
		expect(isSafeSvg('<svg><g title=">" onclick="x()"><text/></g></svg>')).toBe(false);
		expect(isSafeSvg("<svg><g title='>' onmouseover = 'x()'/></svg>")).toBe(false);
		expect(isSafeSvg('<svg><a href="JavaScript :alert(1)"/></svg>')).toBe(false);
		expect(isSafeSvg("<svg><script")).toBe(false);
		expect(isSafeSvg("<svg><SCRIPT>x</SCRIPT></svg>")).toBe(false);
	});

	it("reads the size from the viewBox", () => {
		expect(svgSize('<svg width="100%" viewBox="0 0 320.5 180"><g/></svg>')).toEqual({ width: 320.5, height: 180 });
		expect(svgSize("<svg><g/></svg>")).toBeNull();
		expect(svgSize('<svg viewBox="0 0 0 10"></svg>')).toBeNull();
	});

	it("makes a standalone file with a namespace and pixel size", () => {
		const out = standaloneSvg(
			'<svg width="100%" style="max-width: 300px; color: red" viewBox="0 0 320.5 180"><g/></svg>',
			{
				width: 320.5,
				height: 180,
			},
		);
		expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(out).toContain('width="321"');
		expect(out).toContain('height="180"');
		expect(out).not.toContain('width="100%"');
		expect(out).not.toContain("max-width");
	});
});

describe("mermaidThemeVariables", () => {
	const tokens: Record<string, string> = { "--fg": "#111111", "--bg-raised": "#fafafa", "--err": "#cc0000" };
	const read = (name: string): string => tokens[name] ?? "";

	it("maps tokens to theme variables and flags the dark theme", () => {
		const light = mermaidThemeVariables(read, "light");
		expect(light.darkMode).toBe(false);
		expect(light.textColor).toBe("#111111");
		expect(light.primaryColor).toBe("#fafafa");
		expect(mermaidThemeVariables(read, "dark").darkMode).toBe(true);
	});

	it("leaves out variables whose token is unset", () => {
		expect(Object.hasOwn(mermaidThemeVariables(read, "light"), "lineColor")).toBe(false);
	});
});
