/**
 * Monaco's theme and font from the app's tokens. Monaco wants hex colours, and the tokens are CSS variables
 * (some `color-mix()`es, some translucent), so each is resolved by the browser on a probe element and read
 * back as a computed colour. The theme follows `data-theme`, `data-accent`, `data-accent-custom`, `data-palette-dark`,
 * `data-palette-light`, `data-code-font` and `data-text-size` on the root (and the device's colour scheme when no
 * theme is set), and the editor theme the IDE sheet wears (`data-editor-theme`, whose inline variables override the
 * tokens below it): {@link watchTheme} calls back whenever one of them changes.
 */
import { luminance, parseCssColor, toHex } from "./color";
import type { Rgba } from "./color";
import type { editor } from "./monaco-core";

export interface ThemeSnapshot {
	data: editor.IStandaloneThemeData;
	fontFamily: string;
	/** Pixels. */
	fontSize: number;
	/** Pixels. */
	lineHeight: number;
}

/** Colour the canvas parses when the computed value is a notation `parseCssColor` does not read. */
let canvas: CanvasRenderingContext2D | null | undefined;

function viaCanvas(css: string): Rgba | null {
	canvas ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	if (canvas === null) return null;
	canvas.clearRect(0, 0, 1, 1);
	canvas.fillStyle = "#000";
	canvas.fillStyle = css;
	canvas.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
	return [r!, g!, b!, a! / 255];
}

/** `css` (any colour expression, `var()`s included) as the browser computes it; `fallback` when it is not a colour. */
function resolve(probe: HTMLElement, css: string, fallback: Rgba): Rgba {
	probe.style.color = "";
	probe.style.color = css;
	if (probe.style.color === "") return fallback;
	const computed = getComputedStyle(probe).color;
	return parseCssColor(computed) ?? viaCanvas(computed) ?? fallback;
}

const FALLBACK: Rgba = [128, 128, 128, 1];

/** Tokens of Monaco's Monarch languages and the `--syn-*` colour each takes (the CodeMirror editor's mapping). */
const TOKEN_COLORS: readonly (readonly [string, string, string?])[] = [
	["keyword", "--syn-keyword"],
	["tag", "--syn-keyword"],
	["string", "--syn-string"],
	["regexp", "--syn-string"],
	["attribute.value", "--syn-string"],
	["number", "--syn-number"],
	["constant", "--syn-number"],
	["comment", "--syn-comment", "italic"],
	["type", "--syn-type"],
	["namespace", "--syn-type"],
	["predefined", "--syn-type"],
	["function", "--syn-function"],
	["attribute.name", "--syn-attr"],
	["key", "--syn-attr"],
	["annotation", "--syn-meta"],
	["metatag", "--syn-meta"],
	["string.link", "--syn-meta"],
	["strong", "--syn-meta", "bold"],
	["emphasis", "--syn-meta", "italic"],
	["invalid", "--err"],
];

/** The theme and font for the page as it looks now; `host` is the editor's container (it supplies the font size). */
export function readTheme(host: HTMLElement): ThemeSnapshot {
	const probe = document.createElement("span");
	probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
	host.append(probe);
	try {
		const c = (css: string): string => toHex(resolve(probe, css, FALLBACK));
		const mix = (token: string, percent: number): string =>
			c(`color-mix(in srgb, var(${token}) ${percent}%, transparent)`);
		const background = resolve(probe, "var(--bg-inset)", [21, 15, 23, 1]);
		const dark = luminance(background) < 0.4;
		const rules = [
			{ token: "", foreground: c("var(--fg)").slice(1) },
			{ token: "delimiter", foreground: c("var(--fg-muted)").slice(1) },
			...TOKEN_COLORS.map(([token, variable, fontStyle]) => ({
				token,
				foreground: c(`var(${variable})`).slice(1),
				...(fontStyle === undefined ? {} : { fontStyle }),
			})),
		];
		probe.style.fontFamily = "var(--font-mono)";
		const fontFamily = getComputedStyle(probe).fontFamily;
		const fontSize = Number.parseFloat(getComputedStyle(host).fontSize) || 12.5;
		const border = c("var(--border)");
		const borderStrong = c("var(--border-strong)");
		const overlay = c("var(--bg-overlay)");
		const faint = c("var(--fg-faint)");
		const colors: Record<string, string> = {
			"editor.background": c("var(--bg-inset)"),
			"editor.foreground": c("var(--fg)"),
			"editorCursor.foreground": c("var(--fg)"),
			"editor.selectionBackground": mix("--accent", 30),
			"editor.inactiveSelectionBackground": mix("--accent", 18),
			"editor.selectionHighlightBackground": mix("--accent", 14),
			"editor.wordHighlightBackground": mix("--accent", 14),
			"editor.wordHighlightStrongBackground": mix("--accent", 22),
			"editor.findMatchBackground": mix("--warn", 55),
			"editor.findMatchHighlightBackground": mix("--warn", 30),
			"editor.findRangeHighlightBackground": mix("--accent", 10),
			"editor.lineHighlightBackground": c("var(--hover)"),
			"editor.lineHighlightBorder": "#00000000",
			"editorLineNumber.foreground": faint,
			"editorLineNumber.activeForeground": c("var(--fg-muted)"),
			"editorGutter.background": c("var(--bg-inset)"),
			"editorBracketMatch.background": mix("--accent", 22),
			"editorBracketMatch.border": "#00000000",
			"editorIndentGuide.background1": border,
			"editorIndentGuide.activeBackground1": borderStrong,
			"editorWhitespace.foreground": border,
			"editorError.foreground": c("var(--err)"),
			"editorWarning.foreground": c("var(--warn)"),
			"editorInfo.foreground": c("var(--accent)"),
			"editorHint.foreground": faint,
			"editorWidget.background": overlay,
			"editorWidget.foreground": c("var(--fg)"),
			"editorWidget.border": borderStrong,
			"editorHoverWidget.background": overlay,
			"editorHoverWidget.border": borderStrong,
			"editorHoverWidget.foreground": c("var(--fg)"),
			"editorHoverWidget.statusBarBackground": c("var(--bg-raised)"),
			"editorSuggestWidget.background": overlay,
			"editorSuggestWidget.border": borderStrong,
			"editorMarkerNavigation.background": overlay,
			"editorOverviewRuler.border": "#00000000",
			"editorOverviewRuler.errorForeground": c("var(--err)"),
			"editorOverviewRuler.warningForeground": c("var(--warn)"),
			"input.background": c("var(--bg-inset)"),
			"input.foreground": c("var(--fg)"),
			"input.border": borderStrong,
			"inputOption.activeBackground": mix("--accent", 30),
			"inputOption.activeBorder": c("var(--accent)"),
			focusBorder: c("var(--accent)"),
			"list.hoverBackground": c("var(--hover)"),
			"list.activeSelectionBackground": c("var(--selected)"),
			"list.activeSelectionForeground": c("var(--fg)"),
			"list.focusBackground": c("var(--selected)"),
			"menu.background": overlay,
			"menu.foreground": c("var(--fg)"),
			"menu.selectionBackground": c("var(--selected)"),
			"menu.selectionForeground": c("var(--fg)"),
			"menu.separatorBackground": border,
			"menu.border": borderStrong,
			"minimap.background": c("var(--bg-inset)"),
			"minimapSlider.background": mix("--fg-faint", 20),
			"minimapSlider.hoverBackground": mix("--fg-faint", 30),
			"minimapSlider.activeBackground": mix("--fg-faint", 40),
			"scrollbarSlider.background": mix("--fg-faint", 25),
			"scrollbarSlider.hoverBackground": mix("--fg-faint", 40),
			"scrollbarSlider.activeBackground": mix("--fg-faint", 55),
			"widget.shadow": "#00000040",
			"quickInput.background": overlay,
			"quickInput.foreground": c("var(--fg)"),
			"quickInputList.focusBackground": c("var(--selected)"),
			"pickerGroup.foreground": c("var(--fg-muted)"),
		};
		return {
			data: { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors },
			fontFamily,
			fontSize,
			lineHeight: Math.round(fontSize * 1.55),
		};
	} finally {
		probe.remove();
	}
}

/** The attributes of the root element the theme and font follow. */
export const THEME_ATTRIBUTES = [
	"data-theme",
	"data-accent",
	"data-accent-custom",
	"data-palette-dark",
	"data-palette-light",
	"data-code-font",
	"data-text-size",
];

/**
 * Call `onChange` when the page's theme, palette, accent, code font, text size, colour scheme or the editor theme of the sheet
 * around `host` changes. Returns the stop function.
 */
export function watchTheme(host: HTMLElement, onChange: () => void): () => void {
	let pending = 0;
	// A burst of attribute writes (Reset appearance sets several) is one rebuild.
	const schedule = (): void => {
		cancelAnimationFrame(pending);
		pending = requestAnimationFrame(onChange);
	};
	const observer = new MutationObserver(schedule);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
	const sheet = host.closest("[data-editor-theme]");
	if (sheet !== null) observer.observe(sheet, { attributes: true, attributeFilter: ["data-editor-theme"] });
	const scheme = matchMedia("(prefers-color-scheme: dark)");
	const narrow = matchMedia("(max-width: 640px)");
	scheme.addEventListener("change", schedule);
	narrow.addEventListener("change", schedule);
	return () => {
		cancelAnimationFrame(pending);
		observer.disconnect();
		scheme.removeEventListener("change", schedule);
		narrow.removeEventListener("change", schedule);
	};
}
