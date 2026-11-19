import { describe, expect, it } from "bun:test";
import {
	ByteBudgetCache,
	clampPage,
	clampPdfZoom,
	defaultPreviewMode,
	imageMime,
	isRelativeLink,
	PDF_PAGE_MARGIN,
	PDF_ZOOM_MAX,
	PDF_ZOOM_MIN,
	parsePageInput,
	pdfFitWidthZoom,
	pdfOpenMessage,
	previewKind,
	resolveRelativeLink,
	stepPdfZoom,
	viewerKind,
	viewerLimit,
} from "../src/lib/file-viewer";

describe("which viewer a path gets", () => {
	it("goes by the extension, whatever its case", () => {
		expect(viewerKind("docs/Logo.PNG")).toBe("image");
		expect(viewerKind("a/b.jpeg")).toBe("image");
		expect(viewerKind("icon.ico")).toBe("image");
		expect(viewerKind("diagram.svg")).toBe("image");
		expect(viewerKind("spec.PDF")).toBe("pdf");
		expect(viewerKind("src/index.ts")).toBe("text");
		expect(viewerKind("README.md")).toBe("text");
	});

	it("takes no extension from a dot in a directory name or a dotfile", () => {
		expect(viewerKind("assets.png/readme")).toBe("text");
		expect(viewerKind(".png")).toBe("text");
		expect(viewerKind("Makefile")).toBe("text");
	});

	it("names the content type an image is shown under", () => {
		expect(imageMime("a.avif")).toBe("image/avif");
		expect(imageMime("a.svg")).toBe("image/svg+xml");
		expect(imageMime("a.jpg")).toBe("image/jpeg");
		expect(imageMime("a.pdf")).toBeNull();
	});

	it("limits only what the viewers fetch", () => {
		expect(viewerLimit("text")).toBeNull();
		expect(viewerLimit("image")).toBeGreaterThan(0);
		expect(viewerLimit("pdf")).toBeGreaterThan(0);
	});

	it("previews Markdown and SVG, opening an SVG rendered and Markdown as text", () => {
		expect(previewKind("docs/guide.MD")).toBe("markdown");
		expect(previewKind("a.mdx")).toBe("markdown");
		expect(previewKind("logo.svg")).toBe("svg");
		expect(previewKind("main.rs")).toBeNull();
		expect(defaultPreviewMode("svg")).toBe("preview");
		expect(defaultPreviewMode("markdown")).toBe("source");
	});
});

describe("Markdown links to files", () => {
	it("tells a file from an address with a scheme", () => {
		expect(isRelativeLink("img/a.png")).toBe(true);
		expect(isRelativeLink("../a.png")).toBe(true);
		expect(isRelativeLink("/a.png")).toBe(true);
		expect(isRelativeLink("https://x.test/a.png")).toBe(false);
		expect(isRelativeLink("data:image/png;base64,AAAA")).toBe(false);
		expect(isRelativeLink("//cdn.test/a.png")).toBe(false);
		expect(isRelativeLink("  ")).toBe(false);
	});

	it("resolves beside, above and at the root of a root-relative file", () => {
		expect(resolveRelativeLink("docs/guide/intro.md", "a.png")).toBe("docs/guide/a.png");
		expect(resolveRelativeLink("docs/guide/intro.md", "./img/a.png")).toBe("docs/guide/img/a.png");
		expect(resolveRelativeLink("docs/guide/intro.md", "../a.png")).toBe("docs/a.png");
		expect(resolveRelativeLink("docs/guide/intro.md", "/assets/a.png")).toBe("assets/a.png");
		expect(resolveRelativeLink("README.md", "docs/a.png")).toBe("docs/a.png");
	});

	it("drops the query and fragment and decodes escapes", () => {
		expect(resolveRelativeLink("README.md", "my%20pic.png?raw=1#top")).toBe("my pic.png");
	});

	it("refuses to climb out of the tree", () => {
		expect(resolveRelativeLink("README.md", "../secret.png")).toBeNull();
		expect(resolveRelativeLink("docs/a.md", "../../x.png")).toBeNull();
		expect(resolveRelativeLink("docs/a.md", "../../x.png?y")).toBeNull();
	});

	it("resolves against an absolute file but not a rooted link, whose root it cannot know", () => {
		expect(resolveRelativeLink("/home/me/repo/docs/a.md", "../img/b.png")).toBe("/home/me/repo/img/b.png");
		expect(resolveRelativeLink("/home/me/repo/docs/a.md", "/img/b.png")).toBeNull();
		expect(resolveRelativeLink("/a.md", "../b.png")).toBeNull();
	});

	it("resolves nothing for an address, a bad escape or an empty link", () => {
		expect(resolveRelativeLink("README.md", "https://x.test/a.png")).toBeNull();
		expect(resolveRelativeLink("README.md", "%E0%A4%A.png")).toBeNull();
		expect(resolveRelativeLink("README.md", "#top")).toBeNull();
		expect(resolveRelativeLink("README.md", "./")).toBeNull();
	});
});

describe("PDF zoom and pages", () => {
	it("keeps the zoom between its limits", () => {
		expect(clampPdfZoom(0.01)).toBe(PDF_ZOOM_MIN);
		expect(clampPdfZoom(99)).toBe(PDF_ZOOM_MAX);
		expect(clampPdfZoom(1.5)).toBe(1.5);
	});

	it("steps by a quarter, rounded, and stops at the limits", () => {
		expect(stepPdfZoom(1, 1)).toBe(1.25);
		expect(stepPdfZoom(1, -1)).toBe(0.8);
		expect(stepPdfZoom(PDF_ZOOM_MAX, 1)).toBe(PDF_ZOOM_MAX);
		expect(stepPdfZoom(PDF_ZOOM_MIN, -1)).toBe(PDF_ZOOM_MIN);
	});

	it("fits a page to the viewer's width less its margins, and survives sizes not measured yet", () => {
		expect(pdfFitWidthZoom(612, 612 + 2 * PDF_PAGE_MARGIN)).toBe(1);
		expect(pdfFitWidthZoom(612, 0)).toBe(1);
		expect(pdfFitWidthZoom(0, 800)).toBe(1);
		expect(pdfFitWidthZoom(612, 100)).toBe(PDF_ZOOM_MIN);
	});

	it("keeps the page inside the document", () => {
		expect(clampPage(0, 5)).toBe(1);
		expect(clampPage(9, 5)).toBe(5);
		expect(clampPage(2.9, 5)).toBe(2);
		expect(clampPage(Number.NaN, 5)).toBe(1);
		expect(clampPage(3, 0)).toBe(1);
	});

	it("reads a page number field, and reverts on anything else", () => {
		expect(parsePageInput(" 3 ", 5)).toBe(3);
		expect(parsePageInput("6", 5)).toBeNull();
		expect(parsePageInput("0", 5)).toBeNull();
		expect(parsePageInput("2.5", 5)).toBeNull();
		expect(parsePageInput("two", 5)).toBeNull();
		expect(parsePageInput("", 5)).toBeNull();
	});

	it("words a password-protected file and a broken one differently", () => {
		const named = (name: string): Error => Object.assign(new Error("x"), { name });
		expect(pdfOpenMessage(named("PasswordException"))).toContain("password");
		expect(pdfOpenMessage(named("InvalidPDFException"))).toContain("not a valid PDF");
		expect(pdfOpenMessage(new Error("boom"))).toBe("Could not open the PDF: boom");
	});
});

describe("ByteBudgetCache", () => {
	it("drops the least recently used entries once over the budget", () => {
		const cache = new ByteBudgetCache<string>(10);
		cache.set("a", "A", 4);
		cache.set("b", "B", 4);
		// Reading `a` makes `b` the oldest.
		expect(cache.get("a")).toBe("A");
		cache.set("c", "C", 4);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("A");
		expect(cache.get("c")).toBe("C");
		expect(cache.bytes).toBe(8);
	});

	it("does not keep a value larger than the whole budget, and does not evict for it", () => {
		const cache = new ByteBudgetCache<string>(10);
		cache.set("a", "A", 6);
		cache.set("huge", "H", 11);
		expect(cache.get("huge")).toBeUndefined();
		expect(cache.get("a")).toBe("A");
		expect(cache.bytes).toBe(6);
	});

	it("counts a replaced entry once", () => {
		const cache = new ByteBudgetCache<string>(10);
		cache.set("a", "A", 4);
		cache.set("a", "A2", 7);
		expect(cache.get("a")).toBe("A2");
		expect(cache.bytes).toBe(7);
		cache.delete("a");
		expect(cache.bytes).toBe(0);
	});
});
