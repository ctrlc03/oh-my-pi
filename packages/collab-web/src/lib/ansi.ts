/**
 * ANSI SGR parsing for the session terminal view: text with escape sequences becomes styled runs.
 * The 16 standard colors map to `--term-N` tokens (see styles/tokens.css); 256-color and truecolor
 * values are approximated by the nearest of the 16. Cursor movement, titles and other control
 * sequences are dropped.
 */

export interface AnsiStyle {
	/** Palette index 0-15; null: the default foreground. */
	fg: number | null;
	/** Palette index 0-15; null: the default background. */
	bg: number | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
}

/** A run of text (it may span lines) in one style. */
export interface AnsiSpan extends AnsiStyle {
	text: string;
}

const DEFAULT_STYLE: AnsiStyle = {
	fg: null,
	bg: null,
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	inverse: false,
};

/** Channel values of the 6×6×6 color cube of the 256-color palette. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** The 16-color palette index nearest to an RGB color. */
export function nearestAnsi16(r: number, g: number, b: number): number {
	const max = Math.max(r, g, b);
	const base = (r >= 128 ? 1 : 0) | (g >= 128 ? 2 : 0) | (b >= 128 ? 4 : 0);
	if (base === 0) return max >= 64 ? 8 : 0;
	// Bright variants for strongly lit colors; white is index 7 (grey) or 15 (full white).
	return max >= 224 ? base + 8 : base;
}

/** The 16-color palette index approximating entry `n` of the 256-color palette. */
function from256(n: number): number {
	if (n < 16) return n;
	if (n >= 232) {
		const level = 8 + 10 * (n - 232);
		return nearestAnsi16(level, level, level);
	}
	const i = n - 16;
	return nearestAnsi16(CUBE_LEVELS[Math.floor(i / 36)]!, CUBE_LEVELS[Math.floor(i / 6) % 6]!, CUBE_LEVELS[i % 6]!);
}

function clampByte(value: number | undefined): number {
	return Math.max(0, Math.min(255, value ?? 0));
}

/**
 * Apply one SGR sequence (the parameters between `ESC [` and `m`) to `style` in place.
 * Parameters are `;`-separated; extended colors may also use `:` subparameters.
 */
function applySgr(style: AnsiStyle, params: string): void {
	const codes =
		params === "" ? [[0]] : params.split(";").map(p => p.split(":").map(part => (part === "" ? 0 : Number(part))));
	for (let i = 0; i < codes.length; i++) {
		const group = codes[i]!;
		const code = group[0]!;
		if (code === 38 || code === 48) {
			// `38;5;n`, `38;2;r;g;b` span parameters; `38:5:n`, `38:2::r:g:b` sit in one.
			const args = group.length > 1 ? group.slice(1) : codes.slice(i + 1).flat();
			const consumed = group.length > 1 ? 0 : args[0] === 5 ? 2 : args[0] === 2 ? 4 : 1;
			let color: number | null = null;
			if (args[0] === 5) color = from256(clampByte(args[1]));
			else if (args[0] === 2) {
				const rgb = group.length > 1 ? args.slice(-3) : args.slice(1, 4);
				color = nearestAnsi16(clampByte(rgb[0]), clampByte(rgb[1]), clampByte(rgb[2]));
			}
			if (color !== null) {
				if (code === 38) style.fg = color;
				else style.bg = color;
			}
			i += consumed;
			continue;
		}
		if (code === 0) Object.assign(style, DEFAULT_STYLE);
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 7) style.inverse = true;
		else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code === 27) style.inverse = false;
		else if (code >= 30 && code <= 37) style.fg = code - 30;
		else if (code === 39) style.fg = null;
		else if (code >= 40 && code <= 47) style.bg = code - 40;
		else if (code === 49) style.bg = null;
		else if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
		else if (code >= 100 && code <= 107) style.bg = code - 100 + 8;
	}
}

/** `ESC [ params intermediates final`, `ESC ] … (BEL | ESC \)`, or `ESC` plus one byte. */
const ESCAPE_RE = /\x1b(?:\[([0-9:;<=>?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_]|.)/gs;

/** Text with ANSI escapes as styled runs; adjacent runs of one style are merged and unstyled text is kept as is. */
export function parseAnsi(input: string): AnsiSpan[] {
	const spans: AnsiSpan[] = [];
	const style: AnsiStyle = { ...DEFAULT_STYLE };
	const push = (text: string): void => {
		if (text === "") return;
		const last = spans[spans.length - 1];
		if (last && sameStyle(last, style)) last.text += text;
		else spans.push({ ...style, text });
	};
	let from = 0;
	for (const match of input.matchAll(ESCAPE_RE)) {
		push(input.slice(from, match.index).replaceAll("\r", ""));
		from = match.index + match[0].length;
		if (match[2] === "m") applySgr(style, match[1] ?? "");
	}
	push(input.slice(from).replaceAll("\r", ""));
	return spans;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
	return (
		a.fg === b.fg &&
		a.bg === b.bg &&
		a.bold === b.bold &&
		a.dim === b.dim &&
		a.italic === b.italic &&
		a.underline === b.underline &&
		a.inverse === b.inverse
	);
}

/** CSS classes (see the `sh-term-*` rules) for a run, or "" for the default style. */
export function ansiClass(span: AnsiStyle): string {
	const fg = span.inverse ? span.bg : span.fg;
	const bg = span.inverse ? span.fg : span.bg;
	const classes: string[] = [];
	if (fg !== null) classes.push(`sh-term-fg-${fg}`);
	else if (span.inverse) classes.push("sh-term-fg-inv");
	if (bg !== null) classes.push(`sh-term-bg-${bg}`);
	else if (span.inverse) classes.push("sh-term-bg-inv");
	if (span.bold) classes.push("sh-term-b");
	if (span.dim) classes.push("sh-term-dim");
	if (span.italic) classes.push("sh-term-i");
	if (span.underline) classes.push("sh-term-u");
	return classes.join(" ");
}
