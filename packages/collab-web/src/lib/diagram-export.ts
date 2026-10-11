/**
 * Getting a rendered diagram out of the page: as a standalone SVG file, or rasterised to PNG. Browser-only.
 */

import type { SvgSize } from "./svg";
import { standaloneSvg } from "./svg";

/** Longest PNG edge; a larger diagram is drawn smaller rather than failing on canvas limits. */
const MAX_PNG_EDGE = 4096;

/** The SVG as a downloadable file. */
export function svgBlob(svg: string, size: SvgSize): Blob {
	return new Blob([standaloneSvg(svg, size)], { type: "image/svg+xml" });
}

/**
 * Rasterise `svg` to PNG at `scale`× its size (less when that would pass the canvas limit) over an opaque
 * `background`: a transparent PNG of a dark-theme diagram is unreadable in most viewers.
 */
export async function svgToPngBlob(svg: string, size: SvgSize, background: string, scale = 2): Promise<Blob> {
	const factor = Math.min(scale, MAX_PNG_EDGE / Math.max(size.width, size.height));
	const image = new Image();
	const loaded = Promise.withResolvers<void>();
	image.onload = () => loaded.resolve();
	image.onerror = () => loaded.reject(new Error("the browser could not draw the diagram"));
	// A data URL, not a blob URL: it keeps the canvas untainted in every browser.
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standaloneSvg(svg, size))}`;
	await loaded.promise;
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(size.width * factor));
	canvas.height = Math.max(1, Math.round(size.height * factor));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("canvas is unavailable");
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
	const encoded = Promise.withResolvers<Blob | null>();
	canvas.toBlob(encoded.resolve, "image/png");
	const png = await encoded.promise;
	if (!png) throw new Error("could not encode the image");
	return png;
}
