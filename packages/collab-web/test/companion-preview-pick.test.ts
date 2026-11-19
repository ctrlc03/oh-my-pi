import { describe, expect, it } from "bun:test";
import {
	ancestorLabels,
	collapseText,
	cssIdent,
	curateStyles,
	excerptHtml,
	type SelectorStep,
	selectorCandidates,
} from "../scripts/companion-preview-pick";

const step = (tag: string, extra: Partial<SelectorStep> = {}): SelectorStep => ({
	tag,
	id: "",
	classes: [],
	nth: 1,
	same: 1,
	...extra,
});

describe("cssIdent", () => {
	it("escapes what a selector cannot carry bare", () => {
		expect(cssIdent("hero")).toBe("hero");
		expect(cssIdent("a:b.c")).toBe("a\\:b\\.c");
		expect(cssIdent("1st")).toBe("\\31 st");
		expect(cssIdent("-1")).toBe("-\\31 ");
		expect(cssIdent("-")).toBe("\\-");
		expect(cssIdent("naïve")).toBe("naïve");
	});
});

describe("selectorCandidates", () => {
	// h1 inside section.hero inside main#app inside body inside html.
	const chain = [
		step("h1", { classes: ["hero-title", "md:text-5xl"] }),
		step("section", { classes: ["hero"], nth: 1, same: 2 }),
		step("main", { id: "app" }),
		step("body"),
		step("html"),
	];

	it("grows from the element outwards and stops at the first id, keeping only usable classes", () => {
		expect(selectorCandidates(chain).slice(0, 3)).toEqual([
			"h1.hero-title",
			"section.hero > h1.hero-title",
			"#app > section.hero > h1.hero-title",
		]);
	});

	it("ends with paths that name every step by position, from the nearest id and from the root", () => {
		expect(selectorCandidates(chain).slice(3)).toEqual([
			"#app > section:nth-of-type(1) > h1",
			"html > body > main > section:nth-of-type(1) > h1",
		]);
	});

	it("escapes an id and drops duplicates", () => {
		expect(selectorCandidates([step("div", { id: "9lives" })])).toEqual(["#\\39 lives", "div"]);
	});
});

describe("ancestorLabels", () => {
	it("lists the nearest parents outermost first, without html", () => {
		const chain = [
			step("span"),
			step("a", { classes: ["btn", "btn-primary", "wide"] }),
			step("li"),
			step("ul", { id: "menu" }),
			step("nav"),
			step("header"),
			step("body"),
			step("html"),
		];
		// An element with an id is named by it alone; only the five nearest parents are kept, so `body` is dropped.
		expect(ancestorLabels(chain)).toEqual(["header", "nav", "#menu", "li", "a.btn.btn-primary"]);
	});
});

describe("curateStyles", () => {
	const base = {
		display: "block",
		position: "static",
		float: "none",
		"flex-direction": "row",
		"flex-wrap": "nowrap",
		"justify-content": "normal",
		"align-items": "normal",
		gap: "normal",
		overflow: "visible",
		"z-index": "auto",
		"margin-top": "0px",
		"margin-right": "0px",
		"margin-bottom": "0px",
		"margin-left": "0px",
		"padding-top": "0px",
		"padding-right": "0px",
		"padding-bottom": "0px",
		"padding-left": "0px",
		"border-top-style": "none",
		"border-right-style": "none",
		"border-bottom-style": "none",
		"border-left-style": "none",
		"border-radius": "0px",
		"box-shadow": "none",
		"font-weight": "400",
		"line-height": "normal",
		color: "rgb(0, 0, 0)",
		"background-color": "rgba(0, 0, 0, 0)",
		"background-image": "none",
		opacity: "1",
	};

	it("leaves every default out", () => {
		expect(curateStyles(base)).toEqual([
			["display", "block"],
			["color", "rgb(0, 0, 0)"],
		]);
	});

	it("joins sides into shorthands and reads flex properties only on containers", () => {
		const styled = curateStyles({
			...base,
			display: "flex",
			"flex-direction": "column",
			"align-items": "center",
			gap: "8px 16px",
			"padding-top": "12px",
			"padding-bottom": "12px",
			"padding-left": "24px",
			"padding-right": "24px",
			"margin-left": "auto",
		});
		expect(styled).toContainEqual(["flex-direction", "column"]);
		expect(styled).toContainEqual(["align-items", "center"]);
		expect(styled).toContainEqual(["gap", "8px 16px"]);
		expect(styled).toContainEqual(["padding", "12px 24px"]);
		expect(styled).toContainEqual(["margin", "0px 0px 0px auto"]);
		// The same values on a block say nothing: the properties do not apply.
		const block = curateStyles({ ...base, "align-items": "center", gap: "8px" });
		expect(block.map(([name]) => name)).not.toContain("align-items");
		expect(block.map(([name]) => name)).not.toContain("gap");
	});

	it("shows a border once when all sides agree, per side otherwise, and not at all without a visible one", () => {
		const side = (name: string, width: string, style: string): Record<string, string> => ({
			[`border-${name}-width`]: width,
			[`border-${name}-style`]: style,
			[`border-${name}-color`]: "rgb(229, 231, 235)",
		});
		const all = Object.assign({}, base, ...["top", "right", "bottom", "left"].map(s => side(s, "1px", "solid")));
		expect(curateStyles(all)).toContainEqual(["border", "1px solid rgb(229, 231, 235)"]);
		const bottomOnly = Object.assign({}, base, side("bottom", "2px", "solid"), side("top", "0px", "solid"));
		const names = curateStyles(bottomOnly).map(([name]) => name);
		expect(names).toContain("border-bottom");
		expect(names).not.toContain("border");
		expect(names).not.toContain("border-top");
	});
});

describe("excerptHtml", () => {
	it("collapses whitespace and shortens inline data", () => {
		const html = `<img  src="data:image/png;base64,${"A".repeat(500)}"\n  alt="x">`;
		const { html: out, cut } = excerptHtml(html, false);
		expect(out).toBe('<img src="data:image/png;base64,AA…" alt="x">');
		expect(cut).toBe(false);
	});

	it("cuts at the cap and says so, also when the page already sent only the start", () => {
		expect(excerptHtml("x".repeat(30), false, 10)).toEqual({ html: `${"x".repeat(10)}…`, cut: true });
		expect(excerptHtml("<b>hi</b>", true)).toEqual({ html: "<b>hi</b>", cut: true });
	});
});

describe("collapseText", () => {
	it("makes one line and cuts it", () => {
		expect(collapseText("  Get\n  started  ")).toBe("Get started");
		expect(collapseText("abcdefghij", 5)).toBe("abcd…");
	});
});
