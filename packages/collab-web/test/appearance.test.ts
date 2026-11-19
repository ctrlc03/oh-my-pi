import { describe, expect, it } from "bun:test";
import {
	ACCENT_PRESETS,
	type Appearance,
	applyAppearance,
	DARK_PALETTES,
	DEFAULT_APPEARANCE,
	LIGHT_PALETTES,
	parseAppearance,
	parseHexColor,
	stepZoom,
} from "../src/lib/appearance";
import { differsFromBaselines } from "../src/lib/fonts";

describe("parseAppearance", () => {
	it("is the defaults for anything that is not an object", () => {
		for (const raw of [null, undefined, "dark", 42, true, []]) {
			expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
		}
	});

	it("keeps every valid value", () => {
		const stored: Appearance = {
			zoom: 130,
			textSize: "xlarge",
			font: "serif",
			codeFont: "fira",
			spacing: "relaxed",
			accent: "green",
			customAccent: "#1a2b3c",
			darkPalette: "nord",
			lightPalette: "sand",
		};
		expect(parseAppearance(stored)).toEqual(stored);
	});

	it("keeps every preset accent and every palette", () => {
		for (const accent of ACCENT_PRESETS) expect(parseAppearance({ accent }).accent).toBe(accent);
		for (const darkPalette of DARK_PALETTES) expect(parseAppearance({ darkPalette }).darkPalette).toBe(darkPalette);
		for (const lightPalette of LIGHT_PALETTES) {
			expect(parseAppearance({ lightPalette }).lightPalette).toBe(lightPalette);
		}
	});

	it("defaults an unknown palette id, and one of the other theme's palettes", () => {
		expect(parseAppearance({ darkPalette: "solarized", lightPalette: "neon" })).toEqual(DEFAULT_APPEARANCE);
		expect(parseAppearance({ darkPalette: "paper", lightPalette: "nord" })).toEqual(DEFAULT_APPEARANCE);
		expect(parseAppearance({ darkPalette: 3, lightPalette: ["sky"] })).toEqual(DEFAULT_APPEARANCE);
		expect(parseAppearance({ darkPalette: "graphite", lightPalette: "neon" })).toEqual({
			...DEFAULT_APPEARANCE,
			darkPalette: "graphite",
		});
	});

	it("keeps a custom accent hex, lower-cased, and defaults anything else", () => {
		expect(parseAppearance({ accent: "custom", customAccent: "#1A2B3C" })).toEqual({
			...DEFAULT_APPEARANCE,
			accent: "custom",
			customAccent: "#1a2b3c",
		});
		for (const customAccent of [
			"1a2b3c",
			"#1a2b3",
			"#1a2b3c4",
			"#12345g",
			"red",
			"rgb(1,2,3)",
			"",
			0x1a2b3c,
			null,
			{},
		]) {
			expect(parseAppearance({ customAccent }).customAccent).toBeNull();
		}
	});

	it("falls back to the default accent when custom has no valid colour", () => {
		expect(parseAppearance({ accent: "custom" })).toEqual(DEFAULT_APPEARANCE);
		expect(parseAppearance({ accent: "custom", customAccent: "#nothex" })).toEqual(DEFAULT_APPEARANCE);
		// A kept colour stays while a preset is chosen, so Custom can be picked again.
		expect(parseAppearance({ accent: "blue", customAccent: "#336699" })).toEqual({
			...DEFAULT_APPEARANCE,
			accent: "blue",
			customAccent: "#336699",
		});
	});

	it("falls back field by field, keeping the valid ones", () => {
		expect(
			parseAppearance({
				zoom: 112,
				textSize: "large",
				font: "comic",
				codeFont: 7,
				spacing: null,
				accent: "blue",
				extra: "ignored",
			}),
		).toEqual({ ...DEFAULT_APPEARANCE, textSize: "large", accent: "blue" });
	});

	it("rejects wrong-typed values, including a zoom stored as a string", () => {
		expect(parseAppearance({ zoom: "115", textSize: 1, accent: ["pink"] })).toEqual(DEFAULT_APPEARANCE);
	});
});

describe("parseHexColor", () => {
	it("accepts six-digit hex in either case and nothing else", () => {
		expect(parseHexColor("#AbCdEf")).toBe("#abcdef");
		expect(parseHexColor("#abc")).toBeNull();
		expect(parseHexColor("#abcdefff")).toBeNull();
		expect(parseHexColor(" #abcdef")).toBeNull();
		expect(parseHexColor(undefined)).toBeNull();
	});
});

/** A root element that records what `applyAppearance` and the pre-paint script write. */
function fakeRoot() {
	const props: Record<string, string> = {};
	return {
		dataset: {} as Record<string, string | undefined>,
		style: {
			colorScheme: "",
			zoom: "",
			setProperty: (name: string, value: string) => {
				props[name] = value;
			},
			removeProperty: (name: string) => {
				delete props[name];
			},
		},
		props,
	};
}

/** What index.html's inline script puts on the root for these localStorage entries. */
function prePaint(entries: Record<string, string>, systemDark = true) {
	const html = Bun.file(new URL("../index.html", import.meta.url).pathname);
	return html.text().then(text => {
		const script = /<script>([\s\S]*?)<\/script>/.exec(text)?.[1];
		if (script === undefined) throw new Error("index.html has no plain inline script");
		const root = fakeRoot();
		const storage = { getItem: (key: string) => entries[key] ?? null };
		const matchMedia = () => ({ matches: systemDark });
		new Function("document", "localStorage", "matchMedia", script)({ documentElement: root }, storage, matchMedia);
		return root;
	});
}

describe("index.html pre-paint script", () => {
	it("applies the theme, the palettes and the accent like applyAppearance does", async () => {
		const stored: Appearance = {
			...DEFAULT_APPEARANCE,
			accent: "custom",
			customAccent: "#12ab9f",
			darkPalette: "midnight",
			lightPalette: "paper",
		};
		const root = await prePaint({ "omp-collab-theme": "light", "omp.collab.appearance": JSON.stringify(stored) });
		const applied = fakeRoot();
		applyAppearance(stored, applied as unknown as HTMLElement);
		expect(root.dataset.theme).toBe("light");
		expect(root.style.colorScheme).toBe("light");
		for (const key of ["accent", "accentCustom", "paletteDark", "paletteLight"]) {
			expect(root.dataset[key]).toBe(applied.dataset[key]);
		}
		expect(root.props["--accent-custom"]).toBe("#12ab9f");
		expect(root.props["--accent-custom"]).toBe(applied.props["--accent-custom"]);
	});

	it("follows the system when no theme is saved, and leaves an unsaved appearance to the defaults", async () => {
		const root = await prePaint({}, false);
		expect(root.dataset).toEqual({ theme: "light" });
		expect(root.props).toEqual({});
	});

	it("does not select the custom accent without a valid colour, and survives a damaged entry", async () => {
		const noHex = await prePaint({
			"omp.collab.appearance": JSON.stringify({ accent: "custom", customAccent: "red" }),
		});
		expect(noHex.dataset.accent).toBeUndefined();
		expect(noHex.dataset.accentCustom).toBeUndefined();
		expect(noHex.props["--accent-custom"]).toBeUndefined();
		const damaged = await prePaint({ "omp.collab.appearance": "{not json" });
		expect(damaged.dataset).toEqual({ theme: "dark" });
	});
});

describe("stepZoom", () => {
	it("moves one step in either direction", () => {
		expect(stepZoom(100, 1)).toBe(115);
		expect(stepZoom(100, -1)).toBe(85);
	});

	it("clamps at both ends", () => {
		expect(stepZoom(150, 1)).toBe(150);
		expect(stepZoom(75, -1)).toBe(75);
	});

	it("moves a value between the steps to the nearest step in that direction", () => {
		expect(stepZoom(110, 1)).toBe(115);
		expect(stepZoom(110, -1)).toBe(100);
		expect(stepZoom(200, -1)).toBe(150);
		expect(stepZoom(10, 1)).toBe(75);
	});
});

describe("differsFromBaselines", () => {
	const baseline = { mono: 1000, serif: 900 };

	it("is false for a family the browser does not have: both widths are the generic's", () => {
		expect(differsFromBaselines({ mono: 1000, serif: 900 }, baseline)).toBe(false);
	});

	it("is true when the family changes either width", () => {
		expect(differsFromBaselines({ mono: 1010, serif: 1010 }, baseline)).toBe(true);
		// A font metrically equal to the generic monospace still differs from the serif fallback.
		expect(differsFromBaselines({ mono: 1000, serif: 1000 }, baseline)).toBe(true);
	});

	it("ignores sub-pixel measurement noise", () => {
		expect(differsFromBaselines({ mono: 1000.004, serif: 899.996 }, baseline)).toBe(false);
	});
});
