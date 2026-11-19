import { describe, expect, it } from "bun:test";
import type { PreviewPick } from "../src/lib/companion";
import { pickPrompt, shotPoint } from "../src/lib/preview-pick";

describe("shotPoint", () => {
	// A 390×844 page shown 195 px wide (half size) at (40, 100) on the screen.
	const shown = { left: 40, top: 100, width: 195, height: 422 };
	const page = { width: 390, height: 844 };

	it("scales a click on the scaled image back to page pixels", () => {
		expect(shotPoint({ x: 40 + 97.5, y: 100 + 211 }, shown, page)).toEqual({ x: 195, y: 422 });
		expect(shotPoint({ x: 40, y: 100 }, shown, page)).toEqual({ x: 0, y: 0 });
	});

	it("keeps a click on the image's border inside the page", () => {
		expect(shotPoint({ x: 10, y: 9_999 }, shown, page)).toEqual({ x: 0, y: 844 });
	});

	it("has no answer for an image that is not laid out", () => {
		expect(shotPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, page)).toBeNull();
	});
});

describe("pickPrompt", () => {
	const pick: PreviewPick = {
		url: "http://localhost:5173/",
		viewport: "phone",
		tag: "a",
		selector: "a.btn-primary",
		ancestors: ["main#app", "section.hero"],
		html: '<a class="btn-primary" href="/signup">Get started</a>',
		htmlCut: false,
		text: "Get started",
		styles: [
			["display", "inline-block"],
			["color", "rgb(255, 255, 255)"],
		],
		box: { x: 20, y: 300, width: 156, height: 48 },
		crop: { data: "", mimeType: "image/png", width: 344, height: 128, cut: false },
	};

	it("names the page, selector, size, text, HTML and styles", () => {
		const text = pickPrompt(pick);
		expect(text).toContain("http://localhost:5173/ (phone screen size)");
		expect(text).toContain("Selector: `a.btn-primary`");
		expect(text).toContain("Size: 156×48 px at (20, 300)");
		expect(text).toContain("Inside: main#app > section.hero");
		expect(text).toContain('Text: "Get started"');
		expect(text).toContain('```html\n<a class="btn-primary" href="/signup">Get started</a>\n```');
		expect(text).toContain("```css\ndisplay: inline-block;\ncolor: rgb(255, 255, 255);\n```");
		expect(text).not.toContain("is cut");
	});

	it("fences HTML that holds backticks with a longer fence and notes a cut", () => {
		const text = pickPrompt({ ...pick, html: "<code>```</code>", htmlCut: true });
		expect(text).toContain("````html\n<code>```</code>\n````");
		expect(text).toContain("the HTML is cut");
	});

	it("leaves out what the element lacks", () => {
		const text = pickPrompt({ ...pick, ancestors: [], text: "", styles: [] });
		expect(text).not.toContain("Inside:");
		expect(text).not.toContain("Text:");
		expect(text).not.toContain("Computed styles");
	});
});
