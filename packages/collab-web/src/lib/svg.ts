/**
 * SVG text handling for diagrams: the checks a rendered diagram passes before it is inserted into the page,
 * its intrinsic size, and the self-contained form that is downloaded or rasterised. Pure string work.
 */

export interface SvgSize {
	width: number;
	height: number;
}

/** One tag, quoted attribute values (which may hold `>`) included. */
const TAG = /<[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
/** Elements a diagram must not carry. */
const UNSAFE_ELEMENT = /^<\s*\/?\s*(?:script|foreignObject|iframe|object|embed)\b/i;
/** An event-handler attribute name, tested on a tag with its quoted values removed. */
const HANDLER_ATTRIBUTE = /[\s/"']on[a-z]+\s*=/i;
/** Script or HTML a quoted attribute value could load. */
const UNSAFE_VALUE = /javascript\s*:|data:text\/html/i;

/**
 * Whether a rendered diagram is plain SVG. Mermaid's strict mode and Excalidraw's exporter already produce no
 * active content; this is the last check before the SVG becomes part of the page. Only markup is judged: a label
 * that reads "retry once = 3" or "javascript: basics" is text (its `<` and `>` are escaped), not an attribute.
 */
export function isSafeSvg(svg: string): boolean {
	if (!svg.trimStart().startsWith("<svg")) return false;
	for (const [tag] of svg.matchAll(TAG)) {
		if (UNSAFE_ELEMENT.test(tag) || UNSAFE_VALUE.test(tag)) return false;
		if (HANDLER_ATTRIBUTE.test(tag.replace(/"[^"]*"|'[^']*'/g, '""'))) return false;
	}
	// A `<` outside every complete tag is a broken or hidden tag.
	return !svg.replace(TAG, "").includes("<");
}

/** Width and height from the root's `viewBox`, or null when it has none. */
export function svgSize(svg: string): SvgSize | null {
	const root = /^\s*<svg\b[^>]*>/i.exec(svg)?.[0];
	if (root === undefined) return null;
	const box = /\bviewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(root);
	if (box === null) return null;
	const width = Number(box[3]);
	const height = Number(box[4]);
	return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

/** The SVG as a standalone file: the namespace declared and an explicit pixel size (renderers size `width="100%"` to nothing). */
export function standaloneSvg(svg: string, size: SvgSize): string {
	return svg.replace(/^\s*<svg\b([^>]*)>/i, (_, attrs: string) => {
		const rest = attrs
			.replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, "")
			.replace(/\sxmlns\s*=\s*"[^"]*"/i, "")
			.replace(/(\sstyle\s*=\s*"[^"]*?)max-width\s*:[^;"]*;?\s*/i, "$1");
		return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(size.width)}" height="${Math.ceil(size.height)}"${rest}>`;
	});
}
