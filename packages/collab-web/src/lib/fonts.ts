/**
 * Which of the fonts Settings offers are available on this device. The page loads no web fonts, so a named family
 * either exists locally or its stack silently falls through to the system font; the pickers say which.
 *
 * `document.fonts.check()` answers true for a family it has never heard of, so availability is measured: the same
 * text is drawn in `<family>, monospace` and `<family>, serif` and compared with plain `monospace` and `serif`. An
 * installed family changes at least one of the two widths (a font that is metrically the generic monospace still
 * differs from the serif fallback); an unknown family, or a generic keyword the browser does not know
 * (`ui-rounded` outside Safari), changes neither.
 */
import { useSyncExternalStore } from "react";
import { CODE_FONTS, type CodeFont, FONTS, type Font } from "./appearance";

/**
 * The families each option's stack in tokens.css tries first, as CSS tokens; the option works if any of them is
 * available. An empty list is a stack that always renders (the system stacks, and serif, which ends in `serif`).
 */
export const FONT_FAMILIES: Readonly<Record<Font, readonly string[]>> = {
	system: [],
	serif: [],
	rounded: ["ui-rounded", '"SF Pro Rounded"'],
	mono: [],
};

export const CODE_FONT_FAMILIES: Readonly<Record<CodeFont, readonly string[]>> = {
	system: [],
	jetbrains: ['"JetBrains Mono"'],
	fira: ['"Fira Code"', '"Fira Mono"'],
	cascadia: ['"Cascadia Code"', '"Cascadia Mono"'],
	sfmono: ['"SF Mono"', "SFMono-Regular"],
	menlo: ["Menlo"],
};

const SAMPLE = "mmmmmmmmmmlli0Oo1WwAaQq@#{}()[]";
const SIZE_PX = 72;
const EPSILON = 0.01;

/** Widths of the sample drawn behind each generic family; also the same text with a candidate family first. */
export interface FontWidths {
	mono: number;
	serif: number;
}

/** True when drawing with the candidate family changed the width against either generic baseline. */
export function differsFromBaselines(withFamily: FontWidths, baseline: FontWidths): boolean {
	return Math.abs(withFamily.mono - baseline.mono) > EPSILON || Math.abs(withFamily.serif - baseline.serif) > EPSILON;
}

let context: CanvasRenderingContext2D | null | undefined;

function measure(font: string): number | null {
	if (context === undefined) {
		context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
	}
	if (context === null) return null;
	context.font = `${SIZE_PX}px ${font}`;
	return context.measureText(SAMPLE).width;
}

/** Whether the family token is available; null when this browser cannot measure text (the option is then offered as is). */
function measureAvailable(family: string): boolean | null {
	const baseMono = measure("monospace");
	const baseSerif = measure("serif");
	const withMono = measure(`${family}, monospace`);
	const withSerif = measure(`${family}, serif`);
	if (baseMono === null || baseSerif === null || withMono === null || withSerif === null) return null;
	return differsFromBaselines({ mono: withMono, serif: withSerif }, { mono: baseMono, serif: baseSerif });
}

function anyAvailable(families: readonly string[]): boolean {
	return families.length === 0 || families.some(family => measureAvailable(family) !== false);
}

export interface FontAvailability {
	font: Readonly<Record<Font, boolean>>;
	codeFont: Readonly<Record<CodeFont, boolean>>;
}

function measureAll(): FontAvailability {
	const font = {} as Record<Font, boolean>;
	for (const option of FONTS) font[option] = anyAvailable(FONT_FAMILIES[option]);
	const codeFont = {} as Record<CodeFont, boolean>;
	for (const option of CODE_FONTS) codeFont[option] = anyAvailable(CODE_FONT_FAMILIES[option]);
	return { font, codeFont };
}

let snapshot: FontAvailability | null = null;
const listeners = new Set<() => void>();
let watching = false;

function invalidate(): void {
	snapshot = null;
	for (const listener of listeners) listener();
}

/** A font that finishes loading later (or a late `fonts.ready`) can change what is available: measure again. */
function watchFontLoading(): void {
	if (watching || typeof document === "undefined" || !("fonts" in document)) return;
	watching = true;
	document.fonts.addEventListener("loadingdone", invalidate);
	void document.fonts.ready.then(invalidate);
}

function subscribe(listener: () => void): () => void {
	watchFontLoading();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): FontAvailability {
	snapshot ??= measureAll();
	return snapshot;
}

const EVERYTHING: FontAvailability = {
	font: { system: true, serif: true, rounded: true, mono: true },
	codeFont: { system: true, jetbrains: true, fira: true, cascadia: true, sfmono: true, menlo: true },
};

/** Which fonts this device has; measured once, and again when the browser reports fonts loading. */
export function useFontAvailability(): FontAvailability {
	return useSyncExternalStore(subscribe, getSnapshot, () => EVERYTHING);
}
