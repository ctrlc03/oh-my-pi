/**
 * The app's design tokens as plain values for renderers that cannot take `var(--x)`: Mermaid colours its
 * SVG from a variable table and Excalidraw scenes carry literal colours. Values are read from the live
 * `:root`, so they follow the light/dark theme at the moment of the call.
 */

import type { GraphPalette } from "./codemap-scene";
import type { SystemTheme } from "./theme";

/** The value of custom property `name` on `:root`, or "" outside a browser or when it is unset. */
export function readToken(name: string): string {
	if (typeof document === "undefined") return "";
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Mermaid theme variables (the `base` theme) from token values: `read` maps a token name to its value. */
export function mermaidThemeVariables(
	read: (name: string) => string,
	theme: SystemTheme,
): Record<string, string | boolean> {
	const vars: Record<string, string | boolean> = { darkMode: theme === "dark" };
	const set = (key: string, token: string): void => {
		const value = read(token);
		if (value !== "") vars[key] = value;
	};
	set("background", "--bg-inset");
	set("primaryColor", "--bg-raised");
	set("primaryTextColor", "--fg");
	set("primaryBorderColor", "--fg-faint");
	set("secondaryColor", "--bg-inset");
	set("secondaryTextColor", "--fg");
	set("tertiaryColor", "--panel");
	set("tertiaryTextColor", "--fg");
	set("lineColor", "--fg-muted");
	set("textColor", "--fg");
	set("mainBkg", "--bg-raised");
	set("nodeBorder", "--fg-faint");
	set("nodeTextColor", "--fg");
	set("clusterBkg", "--bg-inset");
	set("clusterBorder", "--fg-faint");
	set("edgeLabelBackground", "--bg-raised");
	set("titleColor", "--fg");
	set("noteBkgColor", "--bg-inset");
	set("noteTextColor", "--fg");
	set("noteBorderColor", "--fg-faint");
	set("errorBkgColor", "--bg-inset");
	set("errorTextColor", "--err");
	set("fontFamily", "--font-ui");
	return vars;
}

/** The code map palette from the language tokens. */
export function graphPalette(): GraphPalette {
	return {
		line: readToken("--fg-muted"),
		bridge: readToken("--accent"),
		lang: lang => readToken(`--lang-${lang}`) || readToken("--lang-other"),
	};
}

/** The page background, for rasterising a diagram whose own background is transparent. */
export function pageBackground(): string {
	return readToken("--bg-inset") || readToken("--bg");
}
