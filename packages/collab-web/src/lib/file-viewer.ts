/**
 * What the editor and the file viewer show a file as: its text, an image, a PDF, or text with a rendered preview
 * beside it (Markdown, SVG). Pure decisions only: which viewer a path gets, how a Markdown link reaches the file it
 * names, how a PDF page is scaled, and the byte-budgeted cache that keeps a viewed file from being fetched again
 * each time its tab is shown. The components are in components/viewer/.
 */

export type ViewerKind = "text" | "image" | "pdf";

/** Text files that also have a rendered form; the editor offers Source, Preview and Split for them. */
export type PreviewKind = "markdown" | "svg";

export type PreviewMode = "source" | "preview" | "split";

export const PREVIEW_MODES: readonly PreviewMode[] = ["source", "preview", "split"];

/** Image formats a browser draws from bytes (`<img>`), by extension. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
};

/** Largest image the viewer fetches: it is held in memory twice (the blob and the decoded bitmap). */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
/** Largest PDF the viewer fetches: every byte crosses the relay in 4 MB frames before the first page shows. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The content type an image is shown under (the companion's own table lacks some formats); null for a path that is not an image. */
export function imageMime(path: string): string | null {
	const ext = extensionOf(path);
	return Object.hasOwn(IMAGE_MIME, ext) ? IMAGE_MIME[ext]! : null;
}

/** How `path` is opened: by what its extension says, never by sniffing, so a text file is never mistaken for an image. */
export function viewerKind(path: string): ViewerKind {
	const ext = extensionOf(path);
	if (ext === "pdf") return "pdf";
	return Object.hasOwn(IMAGE_MIME, ext) ? "image" : "text";
}

export function previewKind(path: string): PreviewKind | null {
	const ext = extensionOf(path);
	if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
	return ext === "svg" ? "svg" : null;
}

/** The mode a file's preview opens in: a rendered SVG is the point of opening it; Markdown opens as the text it is. */
export function defaultPreviewMode(kind: PreviewKind): PreviewMode {
	return kind === "svg" ? "preview" : "source";
}

/** The largest file the viewer of `kind` fetches; null for text, which the editor reads itself. */
export function viewerLimit(kind: ViewerKind): number | null {
	if (kind === "image") return MAX_IMAGE_BYTES;
	return kind === "pdf" ? MAX_PDF_BYTES : null;
}

/** An image link of a Markdown file that names a file to load: anything with a scheme (`https:`, `data:`) is not. */
export function isRelativeLink(href: string): boolean {
	const trimmed = href.trim();
	return trimmed !== "" && !trimmed.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/**
 * The file a reply's Markdown link names (`[ROADMAP.md](ROADMAP.md)`, `docs/a.md#usage`, `/abs/path.ts`), as the path
 * the session's file opener takes: relative to the session's folder, or absolute. Query and fragment are dropped and
 * percent-escapes decoded; null for a link with a scheme or nothing left.
 */
export function linkedFilePath(href: string): string | null {
	if (!isRelativeLink(href)) return null;
	const path = href.trim().replace(/[?#].*$/, "");
	try {
		return decodeURIComponent(path) || null;
	} catch {
		return null;
	}
}

/**
 * The file a Markdown link names, as a path of the same form as `from` (the Markdown file's own path): `./a.png` and
 * `a.png` are beside it, `../a.png` above it, `/a.png` at the repository root. Query and fragment are dropped and
 * percent-escapes decoded. `/`-rooted links resolve only for a root-relative `from`: an absolute `from` does not say
 * where the repository's root is. Null for a link that is not relative, or climbs out of the tree.
 */
export function resolveRelativeLink(from: string, href: string): string | null {
	if (!isRelativeLink(href)) return null;
	let target = href.trim().replace(/[?#].*$/, "");
	try {
		target = decodeURIComponent(target);
	} catch {
		return null;
	}
	const absolute = from.startsWith("/");
	if (target === "") return null;
	let parts: string[];
	if (target.startsWith("/")) {
		if (absolute) return null;
		parts = [];
	} else {
		parts = from.split("/").filter(part => part !== "");
		parts.pop();
	}
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	if (parts.length === 0) return null;
	return `${absolute ? "/" : ""}${parts.join("/")}`;
}

/** The directory part of a path (without the trailing slash; empty at the top). */
export function dirName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

export const PDF_ZOOM_MIN = 0.25;
export const PDF_ZOOM_MAX = 5;
const PDF_ZOOM_STEP = 1.25;
/** Space kept around a page that is fitted to the viewer's width. */
export const PDF_PAGE_MARGIN = 24;

export function clampPdfZoom(zoom: number): number {
	return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom));
}

/** One zoom button step (the result is rounded so repeated steps do not drift into odd percentages). */
export function stepPdfZoom(zoom: number, direction: 1 | -1): number {
	return clampPdfZoom(Math.round(zoom * (direction > 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP) * 100) / 100);
}

/** The zoom at which a page `pageWidth` points wide fills a viewer `viewerWidth` pixels wide (less its margins). */
export function pdfFitWidthZoom(pageWidth: number, viewerWidth: number): number {
	if (pageWidth <= 0 || viewerWidth <= 0) return 1;
	return clampPdfZoom((viewerWidth - 2 * PDF_PAGE_MARGIN) / pageWidth);
}

/** `page` kept inside the document (1-based); a document without pages has page 1. */
export function clampPage(page: number, total: number): number {
	if (!Number.isFinite(page)) return 1;
	return Math.min(Math.max(1, total), Math.max(1, Math.trunc(page)));
}

/** What a page-number field holds as a page: a whole number inside the document, else null (the field reverts). */
export function parsePageInput(text: string, total: number): number | null {
	if (!/^\s*\d+\s*$/.test(text)) return null;
	const page = Number(text);
	return page >= 1 && page <= total ? page : null;
}

/** What the viewer says when PDF.js could not open the file; it names its failures by `name`, not by class. */
export function pdfOpenMessage(err: unknown): string {
	const name = err instanceof Error ? err.name : "";
	if (name === "PasswordException") return "This PDF is password-protected; the viewer cannot open it.";
	if (name === "InvalidPDFException") return "This file is not a valid PDF.";
	return `Could not open the PDF: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Values kept up to a byte budget, the least recently used dropped first. A value larger than the whole budget is
 * not kept at all: caching it would evict everything else for one entry that is about to be evicted itself.
 */
export class ByteBudgetCache<V> {
	readonly #entries = new Map<string, { value: V; bytes: number }>();
	readonly #budget: number;
	#used = 0;

	constructor(budget: number) {
		this.#budget = budget;
	}

	get(key: string): V | undefined {
		const entry = this.#entries.get(key);
		if (entry === undefined) return undefined;
		// Re-inserted: the Map's order is the recency order.
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return entry.value;
	}

	set(key: string, value: V, bytes: number): void {
		this.delete(key);
		if (bytes > this.#budget) return;
		this.#entries.set(key, { value, bytes });
		this.#used += bytes;
		for (const [oldest, entry] of this.#entries) {
			if (this.#used <= this.#budget) break;
			this.#entries.delete(oldest);
			this.#used -= entry.bytes;
		}
	}

	delete(key: string): void {
		const entry = this.#entries.get(key);
		if (entry === undefined) return;
		this.#entries.delete(key);
		this.#used -= entry.bytes;
	}

	get bytes(): number {
		return this.#used;
	}
}
