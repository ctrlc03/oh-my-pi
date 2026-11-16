/**
 * CSS colours as Monaco wants them (hex): the app's tokens are `color-mix()` and translucent values, so the
 * browser's computed colour is parsed instead of the declared text.
 */

/** Red, green, blue (0-255) and alpha (0-1). */
export type Rgba = readonly [number, number, number, number];

const clamp = (n: number, max: number): number => Math.min(Math.max(n, 0), max);

function channel(token: string, scale: number): number {
	return token.endsWith("%") ? (Number.parseFloat(token) / 100) * scale : Number.parseFloat(token);
}

/**
 * The parts of `rgb()`, `rgba()`, `color(srgb …)` and hex notations a browser reports as a computed colour;
 * null for anything else (the caller asks a canvas to resolve it).
 */
export function parseCssColor(value: string): Rgba | null {
	const text = value.trim().toLowerCase();
	if (text === "transparent") return [0, 0, 0, 0];
	const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
	if (hex !== undefined) {
		const full = hex.length <= 4 ? [...hex].map(c => c + c).join("") : hex;
		if (full.length !== 6 && full.length !== 8) return null;
		const alpha = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
		return [
			Number.parseInt(full.slice(0, 2), 16),
			Number.parseInt(full.slice(2, 4), 16),
			Number.parseInt(full.slice(4, 6), 16),
			alpha,
		];
	}
	const fn = /^(rgba?|color)\((.*)\)$/.exec(text);
	if (fn === null) return null;
	let body = fn[2]!;
	let scale = 255;
	if (fn[1] === "color") {
		if (!body.startsWith("srgb")) return null;
		body = body.slice(4);
		scale = 1;
	}
	const [colors, alphaPart] = body.split("/");
	const parts = (colors ?? "")
		.trim()
		.split(/[\s,]+/)
		.filter(Boolean);
	const alphaToken = alphaPart?.trim() ?? parts[3];
	if (parts.length < 3) return null;
	const rgb = parts.slice(0, 3).map(p => channel(p, scale));
	if (rgb.some(Number.isNaN)) return null;
	const alpha = alphaToken === undefined ? 1 : channel(alphaToken, 1);
	if (Number.isNaN(alpha)) return null;
	const to255 = (n: number): number => Math.round(clamp((n / scale) * 255, 255));
	return [to255(rgb[0]!), to255(rgb[1]!), to255(rgb[2]!), clamp(alpha, 1)];
}

/** `#rrggbb`, or `#rrggbbaa` for a translucent colour. */
export function toHex([r, g, b, a]: Rgba): string {
	const h = (n: number): string => Math.round(clamp(n, 255)).toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ""}`;
}

/** Relative luminance (0 black .. 1 white) of the opaque part; picks Monaco's light or dark base theme. */
export function luminance([r, g, b]: Rgba): number {
	const lin = (c: number): number => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
