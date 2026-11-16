/**
 * Colour themes for the code editor and the Explorer around it (Settings → Appearance → Code editor theme).
 *
 * A theme is a published palette (editor background, sidebar, text, eight syntax colours, accent). {@link editorThemeVars}
 * turns one into the CSS variables the editor sheet reads, and the sheet's root wears them as an inline style, so the
 * sidebar, tabs, status bar, definition list, CodeMirror and Monaco (whose theme is read from the same variables) all
 * follow it like a VS Code theme. `app` applies none: the editor then follows the app's own theme.
 *
 * Everything the sheet needs is derived here from the palette, so a theme cannot define some variables and miss others;
 * `test/editor-themes.test.ts` checks that every theme sets every variable in {@link EDITOR_THEME_VARS}.
 */

export type EditorThemeScheme = "light" | "dark";

/** The palette a theme is published as. The editor's background is `bg`; `side` is the Explorer, tab strip and status bar. */
interface Palette {
	label: string;
	scheme: EditorThemeScheme;
	bg: string;
	side: string;
	fg: string;
	keyword: string;
	string: string;
	number: string;
	comment: string;
	type: string;
	function: string;
	attr: string;
	meta: string;
	accent: string;
}

const PALETTES = {
	"vscode-light": {
		label: "VS Code Light+",
		scheme: "light",
		bg: "#ffffff",
		side: "#f3f3f3",
		fg: "#1f1f1f",
		keyword: "#0000ff",
		string: "#a31515",
		number: "#098658",
		comment: "#008000",
		type: "#267f99",
		function: "#795e26",
		attr: "#001080",
		meta: "#800000",
		accent: "#005fb8",
	},
	"github-light": {
		label: "GitHub Light",
		scheme: "light",
		bg: "#ffffff",
		side: "#f6f8fa",
		fg: "#1f2328",
		keyword: "#cf222e",
		string: "#0a3069",
		number: "#0550ae",
		comment: "#6e7781",
		type: "#953800",
		function: "#8250df",
		attr: "#0550ae",
		meta: "#116329",
		accent: "#0969da",
	},
	"solarized-light": {
		label: "Solarized Light",
		scheme: "light",
		bg: "#fdf6e3",
		side: "#eee8d5",
		fg: "#586e75",
		keyword: "#859900",
		string: "#2aa198",
		number: "#d33682",
		comment: "#93a1a1",
		type: "#b58900",
		function: "#268bd2",
		attr: "#cb4b16",
		meta: "#6c71c4",
		accent: "#268bd2",
	},
	"vscode-dark": {
		label: "VS Code Dark+",
		scheme: "dark",
		bg: "#1e1e1e",
		side: "#252526",
		fg: "#d4d4d4",
		keyword: "#569cd6",
		string: "#ce9178",
		number: "#b5cea8",
		comment: "#6a9955",
		type: "#4ec9b0",
		function: "#dcdcaa",
		attr: "#9cdcfe",
		meta: "#d7ba7d",
		accent: "#007acc",
	},
	"github-dark": {
		label: "GitHub Dark",
		scheme: "dark",
		bg: "#0d1117",
		side: "#161b22",
		fg: "#e6edf3",
		keyword: "#ff7b72",
		string: "#a5d6ff",
		number: "#79c0ff",
		comment: "#8b949e",
		type: "#ffa657",
		function: "#d2a8ff",
		attr: "#79c0ff",
		meta: "#7ee787",
		accent: "#2f81f7",
	},
	"one-dark": {
		label: "One Dark",
		scheme: "dark",
		bg: "#282c34",
		side: "#21252b",
		fg: "#abb2bf",
		keyword: "#c678dd",
		string: "#98c379",
		number: "#d19a66",
		comment: "#5c6370",
		type: "#e5c07b",
		function: "#61afef",
		attr: "#e06c75",
		meta: "#56b6c2",
		accent: "#528bff",
	},
	dracula: {
		label: "Dracula",
		scheme: "dark",
		bg: "#282a36",
		side: "#21222c",
		fg: "#f8f8f2",
		keyword: "#ff79c6",
		string: "#f1fa8c",
		number: "#bd93f9",
		comment: "#6272a4",
		type: "#8be9fd",
		function: "#50fa7b",
		attr: "#ffb86c",
		meta: "#ff5555",
		accent: "#bd93f9",
	},
	monokai: {
		label: "Monokai",
		scheme: "dark",
		bg: "#272822",
		side: "#1e1f1c",
		fg: "#f8f8f2",
		keyword: "#f92672",
		string: "#e6db74",
		number: "#ae81ff",
		comment: "#75715e",
		type: "#66d9ef",
		function: "#a6e22e",
		attr: "#fd971f",
		meta: "#ae81ff",
		accent: "#a6e22e",
	},
	nord: {
		label: "Nord",
		scheme: "dark",
		bg: "#2e3440",
		side: "#3b4252",
		fg: "#d8dee9",
		keyword: "#81a1c1",
		string: "#a3be8c",
		number: "#b48ead",
		comment: "#616e88",
		type: "#8fbcbb",
		function: "#88c0d0",
		attr: "#8fbcbb",
		meta: "#ebcb8b",
		accent: "#88c0d0",
	},
	"solarized-dark": {
		label: "Solarized Dark",
		scheme: "dark",
		bg: "#002b36",
		side: "#073642",
		fg: "#93a1a1",
		keyword: "#859900",
		string: "#2aa198",
		number: "#d33682",
		comment: "#586e75",
		type: "#b58900",
		function: "#268bd2",
		attr: "#cb4b16",
		meta: "#6c71c4",
		accent: "#268bd2",
	},
} as const satisfies Record<string, Palette>;

/** `app` (follow the app's theme) and every theme below, light ones first. */
export const EDITOR_THEME_IDS = ["app", ...(Object.keys(PALETTES) as (keyof typeof PALETTES)[])] as const;
export type EditorThemePref = (typeof EDITOR_THEME_IDS)[number];
export type EditorThemeId = Exclude<EditorThemePref, "app">;

/** What the Settings select lists: `Match app`, then the light themes, then the dark ones. */
export const EDITOR_THEME_GROUPS: readonly {
	label: string;
	themes: readonly { id: EditorThemeId; label: string }[];
}[] = (["light", "dark"] as const).map(scheme => ({
	label: scheme === "light" ? "Light" : "Dark",
	themes: (Object.keys(PALETTES) as EditorThemeId[])
		.filter(id => PALETTES[id].scheme === scheme)
		.map(id => ({ id, label: PALETTES[id].label })),
}));

/** Whether the theme is light or dark; `null` for `app`, which is whatever the app is. */
export function editorThemeScheme(id: EditorThemePref): EditorThemeScheme | null {
	return id === "app" ? null : PALETTES[id].scheme;
}

/** Every property a theme sets: the tokens the editor sheet, CodeMirror and Monaco read, and `color-scheme`. */
export const EDITOR_THEME_VARS = [
	"color-scheme",
	"--bg",
	"--bg-raised",
	"--bg-inset",
	"--bg-overlay",
	"--hover",
	"--selected",
	"--border",
	"--border-strong",
	"--edge-top",
	"--fg",
	"--fg-muted",
	"--fg-faint",
	"--accent",
	"--accent-muted",
	"--accent-fg",
	"--accent-strong",
	"--accent-strong-hover",
	"--accent-soft",
	"--accent-soft-hover",
	"--accent-soft-fg",
	"--ring",
	"--ring-soft",
	"--ok",
	"--warn",
	"--err",
	"--shadow-accent",
	"--shadow-overlay",
	"--syn-keyword",
	"--syn-string",
	"--syn-number",
	"--syn-comment",
	"--syn-type",
	"--syn-function",
	"--syn-attr",
	"--syn-meta",
] as const;
export type EditorThemeVar = (typeof EDITOR_THEME_VARS)[number];

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
	return `#${[r, g, b].map(c => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** `a` at `weight` (0–1) over `b`, as hex. */
export function mixHex(a: string, b: string, weight: number): string {
	const x = parseHex(a);
	const y = parseHex(b);
	return toHex([0, 1, 2].map(i => x[i]! * weight + y[i]! * (1 - weight)) as unknown as Rgb);
}

function luminance(hex: string): number {
	const [r, g, b] = parseHex(hex).map(c => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two opaque hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** `hex` at `percent` opacity as 8-digit hex: the translucent fills (hover, hairlines) that read on every surface step. */
function alpha(hex: string, percent: number): string {
	return `${hex}${Math.round((percent / 100) * 255)
		.toString(16)
		.padStart(2, "0")}`;
}

/** The status colours of VS Code's own themes, per scheme: legible on every palette of that scheme. */
const STATUS = {
	light: { ok: "#388a34", warn: "#bf8803", err: "#e51400" },
	dark: { ok: "#89d185", warn: "#cca700", err: "#f14c4c" },
} as const;

/** The variables of one theme; `app` has none. */
export function editorThemeVars(id: EditorThemePref): Record<EditorThemeVar, string> | null {
	if (id === "app") return null;
	const p: Palette = PALETTES[id];
	const light = p.scheme === "light";
	const status = STATUS[p.scheme];
	const accentFg = contrastRatio(p.accent, "#ffffff") >= contrastRatio(p.accent, "#000000") ? "#ffffff" : "#000000";
	const vars: Record<EditorThemeVar, string> = {
		"color-scheme": p.scheme,
		// The sheet's own surface; the editor itself is --bg-inset, the Explorer, tab strip and status bar --bg-raised.
		"--bg": p.side,
		"--bg-raised": p.side,
		"--bg-inset": p.bg,
		"--bg-overlay": light ? p.bg : mixHex(p.fg, p.side, 0.07),
		"--hover": alpha(p.fg, 7),
		"--selected": alpha(p.fg, 13),
		"--border": alpha(p.fg, 12),
		"--border-strong": alpha(p.fg, 24),
		"--edge-top": alpha(p.fg, 24),
		"--fg": p.fg,
		"--fg-muted": mixHex(p.fg, p.bg, 0.86),
		"--fg-faint": mixHex(p.fg, p.bg, 0.68),
		"--accent": p.accent,
		"--accent-muted": alpha(p.accent, 16),
		"--accent-fg": accentFg,
		"--accent-strong": p.accent,
		"--accent-strong-hover": mixHex(p.accent, p.fg, 0.85),
		"--accent-soft": alpha(p.accent, 16),
		"--accent-soft-hover": alpha(p.accent, 26),
		"--accent-soft-fg": p.accent,
		"--ring": p.accent,
		"--ring-soft": alpha(p.accent, 30),
		"--ok": status.ok,
		"--warn": status.warn,
		"--err": status.err,
		"--shadow-accent": "none",
		"--shadow-overlay": light ? "0 12px 32px rgba(0, 0, 0, 0.18)" : "0 16px 48px rgba(0, 0, 0, 0.5)",
		"--syn-keyword": p.keyword,
		"--syn-string": p.string,
		"--syn-number": p.number,
		"--syn-comment": p.comment,
		"--syn-type": p.type,
		"--syn-function": p.function,
		"--syn-attr": p.attr,
		"--syn-meta": p.meta,
	};
	return vars;
}
