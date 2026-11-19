/**
 * Design mode of the preview sheet: turning a click on the screenshot into a point of the page, and a picked element
 * into what goes to the agent (a picture of it and a text block).
 */

import { fence } from "./blocks";
import type { PreviewPick } from "./companion";

/** Where an element is on the screen, in CSS pixels. */
interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * The page point under a click on the screenshot: `shown` is where the image is on screen and `page` its size in page CSS
 * pixels (the screenshot's pixels divided by its scale), so the answer is right however far the image is scaled to fit.
 * Whole pixels, inside the page; null for an image that has no size yet.
 */
export function shotPoint(
	click: { x: number; y: number },
	shown: Rect,
	page: { width: number; height: number },
): { x: number; y: number } | null {
	if (shown.width <= 0 || shown.height <= 0) return null;
	const at = (offset: number, shownSize: number, pageSize: number): number =>
		Math.min(pageSize, Math.max(0, Math.round((offset / shownSize) * pageSize)));
	return {
		x: at(click.x - shown.left, shown.width, page.width),
		y: at(click.y - shown.top, shown.height, page.height),
	};
}

/** The text block that goes in the message box with the element's picture. */
export function pickPrompt(pick: PreviewPick): string {
	const { box } = pick;
	const lines = [
		`I picked an element in the preview of ${pick.url} (${pick.viewport} screen size). The attached image shows it.`,
		"",
		`Selector: \`${pick.selector}\``,
		`Size: ${box.width}×${box.height} px at (${box.x}, ${box.y}) on the page`,
	];
	if (pick.ancestors.length > 0) lines.push(`Inside: ${pick.ancestors.join(" > ")}`);
	if (pick.text !== "") lines.push(`Text: ${JSON.stringify(pick.text)}`);
	lines.push("", "HTML:", fence(pick.html, "html"));
	if (pick.htmlCut) lines.push("(The element is longer: the HTML is cut.)");
	if (pick.styles.length > 0) {
		const css = pick.styles.map(([name, value]) => `${name}: ${value};`).join("\n");
		lines.push("", "Computed styles (defaults left out):", fence(css, "css"));
	}
	return lines.join("\n");
}

/** The element's picture as a file the message box can attach. */
export function pickCropFile(pick: PreviewPick): File {
	const bytes = Uint8Array.from(atob(pick.crop.data), char => char.charCodeAt(0));
	const extension = pick.crop.mimeType === "image/png" ? "png" : "jpg";
	return new File([bytes], `preview-${pick.tag.replace(/[^a-z0-9-]/g, "")}.${extension}`, {
		type: pick.crop.mimeType,
	});
}
