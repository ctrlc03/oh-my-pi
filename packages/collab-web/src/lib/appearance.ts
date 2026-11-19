/**
 * Appearance settings kept per device: zoom, text size, fonts, line spacing, accent colour (a preset or one custom
 * hex) and the dark and light surface palettes. (The theme keeps its own store in `theme.ts`; "Reset appearance"
 * resets both.) They apply live: the values land on the root element as `data-*` attributes and CSS custom
 * properties that tokens.css and the stylesheets read, so nothing re-renders to change a font. A stored value that
 * is not one of the options (an old build, a hand-edited entry) falls back to that setting's default.
 *
 * index.html applies the same attributes before the first paint (its inline script is checked against
 * {@link applyAppearance} in test/appearance.test.ts), so a saved palette or accent does not flash the default.
 */
import { useSyncExternalStore } from "react";
import { applyZoom } from "./zoom";
import { readJson, writeJson } from "./storage";
import { setThemePreference } from "./theme";

export const APPEARANCE_KEY = "omp.collab.appearance";

/** UI zoom, in percent. */
export const ZOOM_STEPS = [75, 85, 100, 115, 130, 150] as const;
export type Zoom = (typeof ZOOM_STEPS)[number];

export const TEXT_SIZES = ["small", "default", "large", "xlarge"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

/** UI and prose font. */
export const FONTS = ["system", "serif", "rounded", "mono"] as const;
export type Font = (typeof FONTS)[number];

export const CODE_FONTS = ["system", "jetbrains", "fira", "cascadia", "sfmono", "menlo"] as const;
export type CodeFont = (typeof CODE_FONTS)[number];

export const SPACINGS = ["compact", "comfortable", "relaxed"] as const;
export type Spacing = (typeof SPACINGS)[number];

/** The accent presets, in the order of the swatches; each has its own tokens in tokens.css. */
export const ACCENT_PRESETS = [
	"pink",
	"red",
	"orange",
	"amber",
	"green",
	"teal",
	"cyan",
	"blue",
	"indigo",
	"violet",
	"slate",
] as const;
export type AccentPreset = (typeof ACCENT_PRESETS)[number];

/** A preset, or `custom`: the colour kept in {@link Appearance.customAccent}, from which tokens.css derives the tokens. */
export const ACCENTS = [...ACCENT_PRESETS, "custom"] as const;
export type Accent = (typeof ACCENTS)[number];

/** The surface, text and hairline palettes, chosen apart for dark and light (System uses both). Tokens in tokens.css. */
export const DARK_PALETTES = ["plum", "graphite", "midnight", "black", "nord"] as const;
export type DarkPalette = (typeof DARK_PALETTES)[number];
export const LIGHT_PALETTES = ["marble", "paper", "sand", "sky"] as const;
export type LightPalette = (typeof LIGHT_PALETTES)[number];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** `value` as a lower-case `#rrggbb`, or `null` when it is not a six-digit hex colour. */
export function parseHexColor(value: unknown): string | null {
	return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

export interface Appearance {
	zoom: Zoom;
	textSize: TextSize;
	font: Font;
	codeFont: CodeFont;
	spacing: Spacing;
	accent: Accent;
	/** The colour of the `custom` accent, kept while a preset is chosen; `null` until one has been picked. */
	customAccent: string | null;
	darkPalette: DarkPalette;
	lightPalette: LightPalette;
}

export const DEFAULT_APPEARANCE: Appearance = {
	zoom: 100,
	textSize: "default",
	font: "system",
	codeFont: "system",
	spacing: "comfortable",
	accent: "pink",
	customAccent: null,
	darkPalette: "plum",
	lightPalette: "marble",
};

function pick<T extends string | number>(options: readonly T[], value: unknown, fallback: T): T {
	return options.find(option => option === value) ?? fallback;
}

/** Whatever was stored, as a complete `Appearance`: each field that is not one of its options is the default. */
export function parseAppearance(raw: unknown): Appearance {
	const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const d = DEFAULT_APPEARANCE;
	const customAccent = parseHexColor(o.customAccent);
	const accent = pick(ACCENTS, o.accent, d.accent);
	return {
		zoom: pick(ZOOM_STEPS, o.zoom, d.zoom),
		textSize: pick(TEXT_SIZES, o.textSize, d.textSize),
		font: pick(FONTS, o.font, d.font),
		codeFont: pick(CODE_FONTS, o.codeFont, d.codeFont),
		spacing: pick(SPACINGS, o.spacing, d.spacing),
		// `custom` without a colour has nothing to derive from.
		accent: accent === "custom" && customAccent === null ? d.accent : accent,
		customAccent,
		darkPalette: pick(DARK_PALETTES, o.darkPalette, d.darkPalette),
		lightPalette: pick(LIGHT_PALETTES, o.lightPalette, d.lightPalette),
	};
}

/** The next zoom step in `direction` (clamped at the ends); a value off the steps moves to the nearest one that way. */
export function stepZoom(zoom: number, direction: 1 | -1): Zoom {
	const candidates = ZOOM_STEPS.filter(step => (direction === 1 ? step > zoom : step < zoom));
	const next = direction === 1 ? candidates[0] : candidates[candidates.length - 1];
	return next ?? (direction === 1 ? ZOOM_STEPS[ZOOM_STEPS.length - 1]! : ZOOM_STEPS[0]);
}

/**
 * Puts `a` on `root`: `data-font`, `data-code-font`, `data-text-size`, `data-spacing`, `data-accent`,
 * `data-palette-dark` and `data-palette-light` (tokens.css and the stylesheets key off them), the custom accent as
 * `--accent-custom` with a `data-accent-custom` mirror (so `watchTheme` sees it change), `--ui-zoom` (the zoom as
 * a factor) and the `zoom` style.
 */
export function applyAppearance(a: Appearance, root: HTMLElement): void {
	root.dataset.font = a.font;
	root.dataset.codeFont = a.codeFont;
	root.dataset.textSize = a.textSize;
	root.dataset.spacing = a.spacing;
	root.dataset.accent = a.accent;
	root.dataset.paletteDark = a.darkPalette;
	root.dataset.paletteLight = a.lightPalette;
	if (a.customAccent === null) {
		delete root.dataset.accentCustom;
		root.style.removeProperty("--accent-custom");
	} else {
		root.dataset.accentCustom = a.customAccent;
		root.style.setProperty("--accent-custom", a.customAccent);
	}
	applyZoom(a.zoom / 100, root);
}

let current: Appearance = parseAppearance(readJson(APPEARANCE_KEY));
const listeners = new Set<() => void>();

/** Reads the saved settings onto the page; call once before the first render. */
export function initAppearance(): void {
	current = parseAppearance(readJson(APPEARANCE_KEY));
	applyAppearance(current, document.documentElement);
}

function commit(next: Appearance): void {
	current = next;
	writeJson(APPEARANCE_KEY, JSON.stringify(next) === JSON.stringify(DEFAULT_APPEARANCE) ? null : next);
	applyAppearance(next, document.documentElement);
	for (const listener of listeners) listener();
}

export function setAppearance(patch: Partial<Appearance>): void {
	commit(parseAppearance({ ...current, ...patch }));
}

/** Everything under Settings → Appearance except the pet and the pane sizes: these settings and the theme. */
export function resetAppearance(): void {
	setThemePreference("system");
	commit(DEFAULT_APPEARANCE);
}

export function currentAppearance(): Appearance {
	return current;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useAppearance(): Appearance {
	return useSyncExternalStore(subscribe, currentAppearance, () => DEFAULT_APPEARANCE);
}
