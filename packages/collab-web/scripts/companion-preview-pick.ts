/**
 * What the companion makes of an element it found in a previewed page (`preview-pick`): the unique CSS selector, the
 * ancestor chain, the curated computed styles and the HTML excerpt. The browser only reports raw facts (one step per
 * ancestor, every property's computed value); the decisions live here, away from the page, so they can be tested.
 */

/** Longest outer HTML sent; the rest is cut with a note. */
export const MAX_HTML_CHARS = 2_000;
/** Longest visible text sent. */
export const MAX_TEXT_CHARS = 160;
/** How many parents the card names, nearest first in the page and outermost first in the answer. */
const MAX_ANCESTORS = 5;
/** Classes put in a selector segment: more only make it long. */
const MAX_SEGMENT_CLASSES = 3;
/** A class that needs no escaping and is not a hashed or utility one (`md:flex`, `w-[10px]`, `css-1x2y3z` are long or odd). */
const USABLE_CLASS_RE = /^[A-Za-z_][\w-]{0,31}$/;
/** Inline data (images, fonts) that would fill the excerpt with noise. */
const DATA_URI_RE = /data:[^"'\s)]{48,}/g;

/** One element on the way from the picked element up to `<html>`, as the page reports it. */
export interface SelectorStep {
	/** Lower-case local name. */
	tag: string;
	/** The `id` attribute; empty when there is none. */
	id: string;
	classes: string[];
	/** 1-based position among the parent's children of the same tag, and how many of them there are. */
	nth: number;
	same: number;
}

/**
 * `value` as a CSS identifier (what `CSS.escape` returns), for ids that start with a digit or hold characters a
 * selector cannot carry bare.
 */
export function cssIdent(value: string): string {
	let out = "";
	for (let i = 0; i < value.length; i++) {
		const ch = value.charAt(i);
		const code = value.charCodeAt(i);
		const digit = ch >= "0" && ch <= "9";
		if (code === 0) out += "\uFFFD";
		else if (code <= 0x1f || code === 0x7f || (i === 0 && digit) || (i === 1 && digit && value.startsWith("-")))
			out += `\\${code.toString(16)} `;
		else if (i === 0 && ch === "-" && value.length === 1) out += "\\-";
		else if (code >= 0x80 || ch === "-" || ch === "_" || digit || /[a-zA-Z]/.test(ch)) out += ch;
		else out += `\\${ch}`;
	}
	return out;
}

/** `#id`, or the tag with its first classes: how one step reads inside a selector or a chain. */
function segment(step: SelectorStep, classes: number): string {
	if (step.id !== "") return `#${cssIdent(step.id)}`;
	const usable = step.classes.filter(name => USABLE_CLASS_RE.test(name)).slice(0, classes);
	return step.tag + usable.map(name => `.${name}`).join("");
}

/**
 * Selectors for the element at `chain[0]`, shortest first: its own segment, then with one more parent in front, and so
 * on until a parent with an id anchors it. They are only candidates (a class is rarely unique): the page checks which
 * one matches this element alone. The last two cannot fail: the position-by-position path from the nearest id (or
 * from `<html>`) and from `<html>` itself.
 */
export function selectorCandidates(chain: readonly SelectorStep[]): string[] {
	const candidates: string[] = [];
	for (let depth = 0; depth < chain.length; depth++) {
		const parts = chain
			.slice(0, depth + 1)
			.reverse()
			.map(step => segment(step, MAX_SEGMENT_CLASSES));
		candidates.push(parts.join(" > "));
		// An id anchors the selector: nothing further out can make it more specific.
		if (chain[depth]?.id) break;
	}
	candidates.push(pathSelector(chain, true), pathSelector(chain, false));
	return [...new Set(candidates)];
}

/** Every step from `<html>` (or, with `anchor`, from the nearest id) down by tag and position: unique when ids are. */
function pathSelector(chain: readonly SelectorStep[], anchor: boolean): string {
	const anchored = anchor ? chain.findIndex(step => step.id !== "") : -1;
	const steps = chain.slice(0, anchored < 0 ? chain.length : anchored + 1).reverse();
	return steps
		.map((step, i) => {
			if (anchored >= 0 && i === 0) return `#${cssIdent(step.id)}`;
			return step.same > 1 ? `${step.tag}:nth-of-type(${step.nth})` : step.tag;
		})
		.join(" > ");
}

/** The picked element's parents, outermost first, without `<html>` and only the nearest few: `body`, `main#app`, `section.hero`. */
export function ancestorLabels(chain: readonly SelectorStep[]): string[] {
	return chain
		.slice(1)
		.filter(step => step.tag !== "html")
		.slice(0, MAX_ANCESTORS)
		.reverse()
		.map(step => segment(step, 2));
}

/** Text as one line cut at `max` characters. */
export function collapseText(text: string, max = MAX_TEXT_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The HTML kept for the prompt: whitespace runs collapsed and long inline data replaced by its first characters, then cut
 * at `max`. `cut` is true when the element had more than what is returned (`clipped`: the page already sent only a part).
 */
export function excerptHtml(html: string, clipped: boolean, max = MAX_HTML_CHARS): { html: string; cut: boolean } {
	const flat = html.replace(DATA_URI_RE, found => `${found.slice(0, 24)}…`).replace(/\s+/g, " ").trim();
	if (flat.length <= max) return { html: flat, cut: clipped };
	return { html: `${flat.slice(0, max)}…`, cut: true };
}

/** What the page is asked to read of an element's computed style. */
export const STYLE_PROPS = [
	"display",
	"position",
	"float",
	"flex-direction",
	"flex-wrap",
	"justify-content",
	"align-items",
	"gap",
	"grid-template-columns",
	"overflow",
	"z-index",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"border-top-width",
	"border-top-style",
	"border-top-color",
	"border-right-width",
	"border-right-style",
	"border-right-color",
	"border-bottom-width",
	"border-bottom-style",
	"border-bottom-color",
	"border-left-width",
	"border-left-style",
	"border-left-color",
	"border-radius",
	"box-shadow",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"line-height",
	"letter-spacing",
	"text-align",
	"text-transform",
	"text-decoration-line",
	"color",
	"background-color",
	"background-image",
	"opacity",
] as const;

/** Values a property has when nothing was set; a style at its default says nothing about the element. */
const DEFAULTS: Readonly<Record<string, readonly string[]>> = {
	position: ["static"],
	float: ["none"],
	"flex-direction": ["row"],
	"flex-wrap": ["nowrap"],
	"justify-content": ["normal"],
	"align-items": ["normal"],
	gap: ["normal", "normal normal", "0px"],
	"grid-template-columns": ["none"],
	overflow: ["visible", "visible visible"],
	"z-index": ["auto"],
	"border-radius": ["0px"],
	"box-shadow": ["none"],
	"font-weight": ["400"],
	"font-style": ["normal"],
	"line-height": ["normal"],
	"letter-spacing": ["normal"],
	"text-align": ["start"],
	"text-transform": ["none"],
	"text-decoration-line": ["none"],
	"background-color": ["rgba(0, 0, 0, 0)", "transparent"],
	"background-image": ["none"],
	opacity: ["1"],
};

const SIDES = ["top", "right", "bottom", "left"] as const;

/** The CSS shorthand for four side values: `8px`, `8px 16px`, `8px 16px 4px` or all four. */
function sidesShorthand(values: readonly [string, string, string, string]): string {
	const [top, right, bottom, left] = values;
	if (top === right && right === bottom && bottom === left) return top;
	if (top === bottom && right === left) return `${top} ${right}`;
	if (right === left) return `${top} ${right} ${bottom}`;
	return `${top} ${right} ${bottom} ${left}`;
}

/**
 * The computed styles worth showing, as name/value pairs in reading order (layout, box model, typography, colours): the
 * four sides of margin, padding and border joined into the shorthand, flex and grid properties only on containers, and
 * every value that is the property's default left out.
 */
export function curateStyles(raw: Readonly<Record<string, string>>): [string, string][] {
	const out: [string, string][] = [];
	const add = (name: string, value: string | undefined): void => {
		if (value === undefined || value === "" || DEFAULTS[name]?.includes(value)) return;
		out.push([name, value]);
	};
	const display = raw.display ?? "";
	const flexy = /flex|grid/.test(display);
	add("display", display);
	add("position", raw.position);
	add("float", raw.float);
	if (flexy) {
		for (const name of ["flex-direction", "flex-wrap", "justify-content", "align-items", "gap"]) add(name, raw[name]);
	}
	if (display.includes("grid")) add("grid-template-columns", raw["grid-template-columns"]);
	add("overflow", raw.overflow);
	add("z-index", raw["z-index"]);

	for (const box of ["margin", "padding"]) {
		const values: [string, string, string, string] = [
			raw[`${box}-top`] ?? "0px",
			raw[`${box}-right`] ?? "0px",
			raw[`${box}-bottom`] ?? "0px",
			raw[`${box}-left`] ?? "0px",
		];
		if (values.some(value => value !== "0px")) out.push([box, sidesShorthand(values)]);
	}
	const borders = SIDES.map(side => {
		const width = raw[`border-${side}-width`] ?? "0px";
		const style = raw[`border-${side}-style`] ?? "none";
		const color = raw[`border-${side}-color`] ?? "";
		return style === "none" || style === "hidden" || width === "0px" ? null : `${width} ${style} ${color}`.trim();
	});
	const visible = borders.filter((border): border is string => border !== null);
	const [first] = visible;
	if (first !== undefined && visible.length === 4 && new Set(visible).size === 1) out.push(["border", first]);
	else
		SIDES.forEach((side, i) => {
			const border = borders[i];
			if (border) out.push([`border-${side}`, border]);
		});
	add("border-radius", raw["border-radius"]);
	add("box-shadow", raw["box-shadow"]);

	for (const name of [
		"font-family",
		"font-size",
		"font-weight",
		"font-style",
		"line-height",
		"letter-spacing",
		"text-align",
		"text-transform",
		"text-decoration-line",
		"color",
		"background-color",
		"background-image",
		"opacity",
	])
		add(name, raw[name]);
	return out;
}
