/**
 * Appearance settings kept per device: zoom, text size, fonts, line spacing and accent colour. (The theme
 * keeps its own store in `theme.ts`; "Reset appearance" resets both.) They apply live: the values land on the
 * root element as `data-*` attributes and CSS custom properties that tokens.css and the stylesheets read, so
 * nothing re-renders to change a font. A stored value that is not one of the options (an old build, a
 * hand-edited entry) falls back to that setting's default.
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

export const ACCENTS = ["pink", "blue", "violet", "green", "orange", "slate"] as const;
export type Accent = (typeof ACCENTS)[number];

export interface Appearance {
	zoom: Zoom;
	textSize: TextSize;
	font: Font;
	codeFont: CodeFont;
	spacing: Spacing;
	accent: Accent;
}

export const DEFAULT_APPEARANCE: Appearance = {
	zoom: 100,
	textSize: "default",
	font: "system",
	codeFont: "system",
	spacing: "comfortable",
	accent: "pink",
};

function pick<T extends string | number>(options: readonly T[], value: unknown, fallback: T): T {
	return options.find(option => option === value) ?? fallback;
}

/** Whatever was stored, as a complete `Appearance`: each field that is not one of its options is the default. */
export function parseAppearance(raw: unknown): Appearance {
	const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const d = DEFAULT_APPEARANCE;
	return {
		zoom: pick(ZOOM_STEPS, o.zoom, d.zoom),
		textSize: pick(TEXT_SIZES, o.textSize, d.textSize),
		font: pick(FONTS, o.font, d.font),
		codeFont: pick(CODE_FONTS, o.codeFont, d.codeFont),
		spacing: pick(SPACINGS, o.spacing, d.spacing),
		accent: pick(ACCENTS, o.accent, d.accent),
	};
}

/** The next zoom step in `direction` (clamped at the ends); a value off the steps moves to the nearest one that way. */
export function stepZoom(zoom: number, direction: 1 | -1): Zoom {
	const candidates = ZOOM_STEPS.filter(step => (direction === 1 ? step > zoom : step < zoom));
	const next = direction === 1 ? candidates[0] : candidates[candidates.length - 1];
	return next ?? (direction === 1 ? ZOOM_STEPS[ZOOM_STEPS.length - 1]! : ZOOM_STEPS[0]);
}

/**
 * Puts `a` on `root`: `data-font`, `data-code-font`, `data-text-size`, `data-spacing` and `data-accent`
 * (tokens.css and the stylesheets key off them), `--ui-zoom` (the zoom as a factor) and the `zoom` style.
 */
export function applyAppearance(a: Appearance, root: HTMLElement): void {
	root.dataset.font = a.font;
	root.dataset.codeFont = a.codeFont;
	root.dataset.textSize = a.textSize;
	root.dataset.spacing = a.spacing;
	root.dataset.accent = a.accent;
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
