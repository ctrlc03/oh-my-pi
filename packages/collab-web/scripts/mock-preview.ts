/**
 * The `preview`, `preview-targets` and `preview-pick` requests for scripts/mock-companion.ts, so the Preview sheet and its
 * design mode (Pick element) can be tried in a browser without Chrome. The "dev server" is one canned landing page on
 * `localhost:5173`: a small tree of boxes (header, hero, three cards, footer) that lays itself out for the phone, tablet
 * and desktop widths. The same tree draws the screenshot (text is drawn as bars: there is no font here) and answers a
 * pick, so the box, the crop, the HTML and the styles agree. The selector, ancestors, styles and HTML excerpt go through
 * the companion's real helpers (./companion-preview-pick); only the page is fake.
 */

import { deflateSync } from "node:zlib";
import {
	PREVIEW_SCALE,
	type CompanionReply,
	type CompanionRequest,
	type PreviewBox,
	type PreviewPick,
	type PreviewShot,
	type PreviewViewport,
} from "../src/lib/companion";
import { checkPreviewUrl, isViewport, VIEWPORTS } from "./companion-preview";
import {
	ancestorLabels,
	collapseText,
	curateStyles,
	excerptHtml,
	type SelectorStep,
	selectorCandidates,
	STYLE_PROPS,
} from "./companion-preview-pick";

const PORT = 5173;
const MAX_FULL_PAGE_CSS_PX = 6_000;
const CROP_PAD_CSS_PX = 8;
const MAX_CROP_CSS_PX = 2_000;
/** What the computer takes to open the page and read it, so "Finding the element…" shows. */
const WORK_MS = 350;

type Rgb = readonly [number, number, number];

interface MockEl {
	tag: string;
	id?: string;
	classes?: string[];
	/** Attributes written after `class`, as they appear in the HTML. */
	attrs?: string;
	box: PreviewBox;
	fill?: Rgb;
	border?: Rgb;
	radius?: number;
	/** Drawn as bars; the element's own text. */
	text?: string;
	textColor?: Rgb;
	fontSize?: number;
	weight?: number;
	lineHeight?: number;
	center?: boolean;
	padding?: [number, number, number, number];
	/** Computed styles beyond what the fields above imply. */
	style?: Record<string, string>;
	children: MockEl[];
}

const INK: Rgb = [17, 24, 39];
const GRAY: Rgb = [75, 85, 99];
const INDIGO: Rgb = [79, 70, 229];
const WHITE: Rgb = [255, 255, 255];
const PAGE_BG: Rgb = [246, 247, 251];
const HERO_BG: Rgb = [237, 233, 254];
const LINE: Rgb = [229, 231, 235];
const DARK: Rgb = [17, 24, 39];

const rgb = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;
const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

/** How many lines `text` takes in a box `width` wide at `fontSize` (bars stand for text: about half an em per letter). */
function lineCount(text: string, fontSize: number, width: number): number {
	return Math.max(1, Math.ceil((text.length * fontSize * 0.52) / Math.max(1, width)));
}

/** A text element with its height worked out from its width. */
function textEl(
	tag: string,
	box: { x: number; y: number; width: number },
	text: string,
	options: Partial<MockEl> & { fontSize: number },
): MockEl {
	const lineHeight = options.lineHeight ?? 1.5;
	const [, right = 0, , left = 0] = options.padding ?? [0, 0, 0, 0];
	const lines = lineCount(text, options.fontSize, box.width - left - right);
	const [top = 0, , bottom = 0] = options.padding ?? [0, 0, 0, 0];
	return {
		tag,
		...options,
		lineHeight,
		text,
		box: { ...box, height: lines * options.fontSize * lineHeight + top + bottom },
		children: [],
	};
}

/** The landing page laid out for a screen `width` CSS px wide. */
function buildPage(width: number): MockEl {
	const phone = width < 500;
	const tablet = !phone && width < 1000;
	const pad = phone ? 20 : 48;
	const inner = width - 2 * pad;

	const nav: MockEl[] = phone
		? [
				{
					tag: "button",
					classes: ["menu-toggle"],
					attrs: 'type="button" aria-label="Menu"',
					box: { x: width - pad - 40, y: 12, width: 40, height: 40 },
					border: LINE,
					radius: 8,
					children: [],
				},
			]
		: ["Product", "Pricing", "Docs"].map((label, i) =>
				textEl(
					"a",
					{ x: width - pad - 3 * 96 + i * 96, y: 20, width: 80 },
					label,
					{ classes: ["nav-link"], attrs: `href="/${label.toLowerCase()}"`, fontSize: 15, weight: 500, textColor: GRAY },
				),
			);
	const header: MockEl = {
		tag: "header",
		id: "site-header",
		classes: ["site-header"],
		box: { x: 0, y: 0, width, height: 64 },
		fill: WHITE,
		style: { display: "flex", "justify-content": "space-between", "align-items": "center", position: "sticky", "z-index": "20" },
		children: [
			textEl("a", { x: pad, y: 20, width: 96 }, "acme", {
				classes: ["logo"],
				attrs: 'href="/"',
				fontSize: 22,
				weight: 700,
				textColor: INDIGO,
			}),
			...nav,
		],
	};

	// Hero.
	const heroTop = 64;
	const heroPad = phone ? 40 : 64;
	const title = textEl(
		"h1",
		{ x: pad, y: heroTop + heroPad, width: Math.min(inner, 720) },
		"Ship interface changes in minutes, not sprints",
		{ classes: ["hero-title"], fontSize: phone ? 30 : tablet ? 38 : 48, weight: 700, lineHeight: 1.15, textColor: INK },
	);
	const lead = textEl(
		"p",
		{ x: pad, y: title.box.y + title.box.height + 16, width: Math.min(inner, 560) },
		"Describe the change you want, review the result on a real device size, and merge when it looks right.",
		{ classes: ["hero-lead"], fontSize: 18, lineHeight: 1.6, textColor: GRAY },
	);
	const buttonY = lead.box.y + lead.box.height + 24;
	const primary = textEl("a", { x: pad, y: buttonY, width: 156 }, "Get started", {
		classes: ["btn", "btn-primary"],
		attrs: 'href="/signup"',
		fill: INDIGO,
		radius: 8,
		fontSize: 16,
		weight: 600,
		center: true,
		padding: [12, 24, 12, 24],
		textColor: WHITE,
		style: { display: "inline-block", "box-shadow": "rgba(79, 70, 229, 0.3) 0px 6px 16px 0px", "text-decoration-line": "none" },
	});
	const ghost = textEl("a", { x: pad + 156 + 12, y: buttonY, width: 132 }, "See a demo", {
		classes: ["btn", "btn-ghost"],
		attrs: 'href="/demo"',
		fill: HERO_BG,
		border: INDIGO,
		radius: 8,
		fontSize: 16,
		weight: 600,
		center: true,
		padding: [12, 24, 12, 24],
		textColor: INDIGO,
		style: { display: "inline-block", "text-decoration-line": "none" },
	});
	const hero: MockEl = {
		tag: "section",
		classes: ["hero"],
		box: { x: 0, y: heroTop, width, height: buttonY + primary.box.height + heroPad - heroTop },
		fill: HERO_BG,
		children: [title, lead, primary, ghost],
	};

	// Features: a grid of cards, one to three columns.
	const featuresTop = hero.box.y + hero.box.height;
	const heading = textEl("h2", { x: pad, y: featuresTop + 48, width: inner }, "Why teams use it", {
		classes: ["section-title"],
		fontSize: 28,
		weight: 700,
		lineHeight: 1.2,
		textColor: INK,
	});
	const columns = phone ? 1 : tablet ? 2 : 3;
	const gap = 24;
	const cardWidth = (inner - gap * (columns - 1)) / columns;
	const cards = [
		["Live previews", "Every change renders at phone, tablet and desktop size before you read the diff."],
		["Pick and point", "Click any element on the page to hand the agent its exact selector, HTML and styles."],
		["Review in place", "Comments, screenshots and diffs stay with the conversation that produced them."],
	].map(([name, body], i): MockEl => {
		const col = i % columns;
		const row = Math.floor(i / columns);
		const cardPad = 24;
		const x = pad + col * (cardWidth + gap);
		const cardTitle = textEl("h3", { x: x + cardPad, y: 0, width: cardWidth - 2 * cardPad }, name ?? "", {
			classes: ["card-title"],
			fontSize: 20,
			weight: 600,
			lineHeight: 1.3,
			textColor: INK,
		});
		const cardText = textEl("p", { x: x + cardPad, y: 0, width: cardWidth - 2 * cardPad }, body ?? "", {
			classes: ["card-text"],
			fontSize: 15,
			lineHeight: 1.55,
			textColor: GRAY,
		});
		return {
			tag: "article",
			classes: ["card"],
			box: { x, y: row, width: cardWidth, height: 0 },
			fill: WHITE,
			border: LINE,
			radius: 12,
			padding: [cardPad, cardPad, cardPad, cardPad],
			style: { "box-shadow": "rgba(17, 24, 39, 0.06) 0px 1px 3px 0px" },
			children: [
				{
					tag: "div",
					classes: ["card-icon"],
					box: { x: x + cardPad, y: 0, width: 40, height: 40 },
					fill: i === 1 ? [16, 185, 129] : i === 2 ? [245, 158, 11] : INDIGO,
					radius: 10,
					children: [],
				},
				cardTitle,
				cardText,
			],
		};
	});
	// Rows are as tall as their tallest card; the children stack inside the padding.
	const rows = Math.ceil(cards.length / columns);
	const gridTop = heading.box.y + heading.box.height + 24;
	let rowY = gridTop;
	for (let row = 0; row < rows; row++) {
		const inRow = cards.filter((_, i) => Math.floor(i / columns) === row);
		const heights = inRow.map(card => {
			const [, cardTitle, cardText] = card.children;
			return 24 + 40 + 16 + (cardTitle?.box.height ?? 0) + 8 + (cardText?.box.height ?? 0) + 24;
		});
		const rowHeight = Math.max(...heights);
		for (const card of inRow) {
			card.box.y = rowY;
			card.box.height = rowHeight;
			const [icon, cardTitle, cardText] = card.children;
			if (icon) icon.box.y = rowY + 24;
			if (cardTitle) cardTitle.box.y = rowY + 24 + 40 + 16;
			if (cardText && cardTitle) cardText.box.y = cardTitle.box.y + cardTitle.box.height + 8;
		}
		rowY += rowHeight + gap;
	}
	const gridHeight = rowY - gap - gridTop;
	const grid: MockEl = {
		tag: "div",
		classes: ["card-grid"],
		box: { x: pad, y: gridTop, width: inner, height: gridHeight },
		style: { display: "grid", "grid-template-columns": Array(columns).fill(`${Math.round(cardWidth * 100) / 100}px`).join(" "), gap: `${gap}px` },
		children: cards,
	};
	const featuresBottom = gridTop + gridHeight + 56;
	const features: MockEl = {
		tag: "section",
		classes: ["features"],
		box: { x: 0, y: featuresTop, width, height: featuresBottom - featuresTop },
		children: [heading, grid],
	};

	const main: MockEl = {
		tag: "main",
		id: "app",
		box: { x: 0, y: heroTop, width, height: featuresBottom - heroTop },
		children: [hero, features],
	};
	const footer: MockEl = {
		tag: "footer",
		classes: ["site-footer"],
		box: { x: 0, y: featuresBottom, width, height: 120 },
		fill: DARK,
		children: [
			textEl("p", { x: pad, y: featuresBottom + 48, width: inner }, "© 2026 Acme, Inc. All rights reserved.", {
				classes: ["footer-note"],
				fontSize: 14,
				textColor: [156, 163, 175],
			}),
		],
	};
	const bodyHeight = featuresBottom + 120;
	return {
		tag: "html",
		box: { x: 0, y: 0, width, height: bodyHeight },
		children: [
			{
				tag: "body",
				box: { x: 0, y: 0, width, height: bodyHeight },
				fill: PAGE_BG,
				style: { "font-family": FONT },
				children: [header, main, footer],
			},
		],
	};
}

interface Node {
	el: MockEl;
	parent: Node | null;
}

function flatten(el: MockEl, parent: Node | null = null): Node[] {
	const node: Node = { el, parent };
	return [node, ...el.children.flatMap(child => flatten(child, node))];
}

/** The deepest element whose box holds the point (siblings do not overlap, so the last match at each level wins). */
function hitAt(nodes: readonly Node[], x: number, y: number): Node | null {
	let found: Node | null = null;
	for (const node of nodes) {
		const { box } = node.el;
		if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) found = node;
	}
	return found;
}

/** `el`'s computed styles as the page would report them: the browser's defaults, then what its fields imply. */
function computedOf(el: MockEl): Record<string, string> {
	const side = (value: number): string => `${value}px`;
	const style: Record<string, string> = {};
	for (const prop of STYLE_PROPS) style[prop] = DEFAULT_STYLE[prop] ?? "";
	const inline = el.tag === "a" || el.tag === "button";
	style.display = inline ? "inline" : "block";
	style.color = rgb(el.textColor ?? INK);
	if (el.fill) style["background-color"] = rgb(el.fill);
	if (el.radius) style["border-radius"] = side(el.radius);
	if (el.border) {
		for (const s of ["top", "right", "bottom", "left"]) {
			style[`border-${s}-width`] = "1px";
			style[`border-${s}-style`] = "solid";
			style[`border-${s}-color`] = rgb(el.border);
		}
	}
	if (el.padding) {
		["top", "right", "bottom", "left"].forEach((s, i) => {
			style[`padding-${s}`] = side(el.padding?.[i] ?? 0);
		});
	}
	if (el.fontSize) style["font-size"] = side(el.fontSize);
	if (el.weight) style["font-weight"] = String(el.weight);
	if (el.lineHeight && el.fontSize) style["line-height"] = side(Math.round(el.fontSize * el.lineHeight * 10) / 10);
	if (el.center) style["text-align"] = "center";
	return { ...style, ...el.style };
}

const DEFAULT_STYLE: Record<string, string> = {
	display: "block",
	position: "static",
	float: "none",
	"flex-direction": "row",
	"flex-wrap": "nowrap",
	"justify-content": "normal",
	"align-items": "normal",
	gap: "normal",
	"grid-template-columns": "none",
	overflow: "visible",
	"z-index": "auto",
	"margin-top": "0px",
	"margin-right": "0px",
	"margin-bottom": "0px",
	"margin-left": "0px",
	"padding-top": "0px",
	"padding-right": "0px",
	"padding-bottom": "0px",
	"padding-left": "0px",
	"border-top-width": "0px",
	"border-top-style": "none",
	"border-top-color": "rgb(17, 24, 39)",
	"border-right-width": "0px",
	"border-right-style": "none",
	"border-right-color": "rgb(17, 24, 39)",
	"border-bottom-width": "0px",
	"border-bottom-style": "none",
	"border-bottom-color": "rgb(17, 24, 39)",
	"border-left-width": "0px",
	"border-left-style": "none",
	"border-left-color": "rgb(17, 24, 39)",
	"border-radius": "0px",
	"box-shadow": "none",
	"font-family": FONT,
	"font-size": "16px",
	"font-weight": "400",
	"font-style": "normal",
	"line-height": "normal",
	"letter-spacing": "normal",
	"text-align": "start",
	"text-transform": "none",
	"text-decoration-line": "none",
	color: "rgb(17, 24, 39)",
	"background-color": "rgba(0, 0, 0, 0)",
	"background-image": "none",
	opacity: "1",
};

function openTag(el: MockEl): string {
	const attrs = [
		el.id === undefined ? "" : ` id="${el.id}"`,
		el.classes?.length ? ` class="${el.classes.join(" ")}"` : "",
		el.attrs === undefined ? "" : ` ${el.attrs}`,
	].join("");
	return `<${el.tag}${attrs}>`;
}

function htmlOf(el: MockEl): string {
	return `${openTag(el)}${el.text ?? ""}${el.children.map(htmlOf).join("")}</${el.tag}>`;
}

/** The elements as `<html>`-to-element steps for the selector helpers. */
function stepsOf(node: Node): SelectorStep[] {
	const steps: SelectorStep[] = [];
	for (let at: Node | null = node; at !== null; at = at.parent) {
		const siblings = at.parent?.el.children.filter(sibling => sibling.tag === at?.el.tag) ?? [at.el];
		steps.push({
			tag: at.el.tag,
			id: at.el.id ?? "",
			classes: at.el.classes ?? [],
			nth: siblings.indexOf(at.el) + 1,
			same: siblings.length,
		});
	}
	return steps;
}

/** One segment of the selectors ./companion-preview-pick writes: `#id` or `tag.class.class`, with an optional `:nth-of-type(n)`. */
function segmentMatches(node: Node, segment: string): boolean {
	const parsed = /^(?:#([\w-]+)|([a-z][a-z0-9-]*))((?:\.[\w-]+)*)(?::nth-of-type\((\d+)\))?$/.exec(segment);
	if (parsed === null) return false;
	const [, id, tag, classes = "", nth] = parsed;
	const { el } = node;
	if (id !== undefined && el.id !== id) return false;
	if (tag !== undefined && el.tag !== tag) return false;
	for (const name of classes.split(".").filter(Boolean)) if (!el.classes?.includes(name)) return false;
	if (nth !== undefined) {
		const siblings = node.parent?.el.children.filter(sibling => sibling.tag === el.tag) ?? [el];
		if (siblings.indexOf(el) + 1 !== Number(nth)) return false;
	}
	return true;
}

/** The elements a candidate selector (segments joined by ` > `) matches anywhere on the page. */
function matching(nodes: readonly Node[], selector: string): Node[] {
	const segments = selector.split(" > ");
	return nodes.filter(node => {
		let at: Node | null = node;
		for (let i = segments.length - 1; i >= 0; i--) {
			if (at === null || !segmentMatches(at, segments[i] ?? "")) return false;
			at = at.parent;
		}
		return true;
	});
}

/** A tiny raster: RGBA at {@link PREVIEW_SCALE}, drawn from the tree and encoded as PNG. */
class Canvas {
	readonly width: number;
	readonly height: number;
	readonly pixels: Uint8Array;
	readonly #origin: { x: number; y: number };

	constructor(clip: PreviewBox) {
		this.width = Math.round(clip.width * PREVIEW_SCALE);
		this.height = Math.round(clip.height * PREVIEW_SCALE);
		this.pixels = new Uint8Array(this.width * this.height * 4).fill(255);
		this.#origin = { x: clip.x, y: clip.y };
	}

	/** Fill a page-space rectangle; `radius` rounds its corners. */
	rect(box: PreviewBox, color: Rgb, radius = 0): void {
		const s = PREVIEW_SCALE;
		const left = (box.x - this.#origin.x) * s;
		const top = (box.y - this.#origin.y) * s;
		const right = left + box.width * s;
		const bottom = top + box.height * s;
		const r = radius * s;
		for (let py = Math.max(0, Math.floor(top)); py < Math.min(this.height, Math.ceil(bottom)); py++) {
			for (let px = Math.max(0, Math.floor(left)); px < Math.min(this.width, Math.ceil(right)); px++) {
				if (r > 0) {
					// Outside a corner's quarter circle.
					const dx = px + 0.5 < left + r ? left + r - (px + 0.5) : px + 0.5 > right - r ? px + 0.5 - (right - r) : 0;
					const dy = py + 0.5 < top + r ? top + r - (py + 0.5) : py + 0.5 > bottom - r ? py + 0.5 - (bottom - r) : 0;
					if (dx * dx + dy * dy > r * r) continue;
				}
				const at = (py * this.width + px) * 4;
				this.pixels[at] = color[0];
				this.pixels[at + 1] = color[1];
				this.pixels[at + 2] = color[2];
			}
		}
	}

	png(): Buffer {
		const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
		for (let y = 0; y < this.height; y++) {
			const row = y * (this.width * 4 + 1);
			raw[row] = 0;
			raw.set(this.pixels.subarray(y * this.width * 4, (y + 1) * this.width * 4), row + 1);
		}
		const header = Buffer.alloc(13);
		header.writeUInt32BE(this.width, 0);
		header.writeUInt32BE(this.height, 4);
		header[8] = 8;
		header[9] = 6;
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk("IHDR", header),
			chunk("IDAT", deflateSync(raw, { level: 6 })),
			chunk("IEND", Buffer.alloc(0)),
		]);
	}
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	let crc = 0xffffffff;
	for (const byte of body) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
	return out;
}

/** Draw the page into the part of it `clip` names. */
function paint(root: MockEl, clip: PreviewBox): Canvas {
	const canvas = new Canvas(clip);
	const draw = (el: MockEl): void => {
		const { box } = el;
		if (el.border) {
			canvas.rect(box, el.border, el.radius);
			canvas.rect(
				{ x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2 },
				el.fill ?? WHITE,
				Math.max(0, (el.radius ?? 0) - 1),
			);
		} else if (el.fill) {
			canvas.rect(box, el.fill, el.radius);
		}
		if (el.text !== undefined && el.fontSize !== undefined) {
			const [padTop = 0, padRight = 0, , padLeft = 0] = el.padding ?? [0, 0, 0, 0];
			const available = box.width - padLeft - padRight;
			const lineHeight = el.fontSize * (el.lineHeight ?? 1.5);
			const lines = lineCount(el.text, el.fontSize, available);
			const full = el.text.length * el.fontSize * 0.52;
			for (let i = 0; i < lines; i++) {
				const used = lines === 1 ? Math.min(full, available) : i < lines - 1 ? available : full - available * (lines - 1);
				const width = Math.max(8, Math.min(available, used));
				const barHeight = el.fontSize * 0.55;
				canvas.rect(
					{
						x: box.x + padLeft + (el.center ? (available - width) / 2 : 0),
						y: box.y + padTop + i * lineHeight + (lineHeight - barHeight) / 2,
						width,
						height: barHeight,
					},
					el.textColor ?? INK,
					barHeight / 2,
				);
			}
		}
		for (const child of el.children) draw(child);
	};
	draw(root);
	return canvas;
}

export interface MockPreview {
	/** Fields the mock companion's `hosts` frame needs for the app to offer the preview. */
	capabilities: { canPreview: true };
	handles(request: CompanionRequest): boolean;
	answer(request: CompanionRequest): Promise<CompanionReply>;
}

/** The page at `url`, refused the way the real companion refuses (not loopback, nothing listening there). */
function pageUrl(raw: unknown): string {
	const url = checkPreviewUrl(raw);
	if (new URL(url).port !== String(PORT)) throw new Error(`Nothing answered at ${url}. Is the dev server running?`);
	return url;
}

export function createMockPreview(): MockPreview {
	return {
		capabilities: { canPreview: true },
		handles: request => request.t === "preview" || request.t === "preview-targets" || request.t === "preview-pick",
		async answer(request) {
			await Bun.sleep(WORK_MS);
			if (request.t === "preview-targets") {
				return {
					t: "preview-targets",
					reqId: request.reqId,
					targets: [{ url: `http://localhost:${PORT}/`, port: PORT, command: "vite" }],
				};
			}
			if (request.t !== "preview" && request.t !== "preview-pick") throw new Error("not a preview request");
			if (!isViewport(request.viewport)) throw new Error("invalid viewport");
			const url = pageUrl(request.url);
			const viewport: PreviewViewport = request.viewport;
			const { width, height } = VIEWPORTS[viewport];
			const page = buildPage(width);
			if (request.t === "preview") {
				const pageHeight = request.fullPage ? Math.min(MAX_FULL_PAGE_CSS_PX, Math.max(height, page.box.height)) : height;
				const canvas = paint(page, { x: 0, y: 0, width, height: pageHeight });
				const shot: PreviewShot = {
					data: canvas.png().toString("base64"),
					mimeType: "image/png",
					width: canvas.width,
					height: canvas.height,
					url,
					viewport,
					at: Date.now(),
				};
				return { t: "preview", reqId: request.reqId, shot };
			}
			const { x, y } = request;
			if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
				throw new Error("invalid point");
			if (x < 0 || x > width || y < 0 || y > MAX_FULL_PAGE_CSS_PX) throw new Error("The point is outside the page.");
			const nodes = flatten(page);
			const hit = hitAt(nodes, x, y);
			if (hit === null) throw new Error("Nothing is at that point of the page.");
			const steps = stepsOf(hit);
			const candidates = selectorCandidates(steps);
			const selector =
				candidates.find(candidate => {
					const found = matching(nodes, candidate);
					return found.length === 1 && found[0] === hit;
				}) ??
				candidates.at(-1) ??
				"";
			const { box } = hit.el;
			const left = Math.min(Math.max(0, Math.floor(box.x - CROP_PAD_CSS_PX)), width - 1);
			const top = Math.max(0, Math.floor(box.y - CROP_PAD_CSS_PX));
			const right = Math.min(width, Math.ceil(box.x + box.width + CROP_PAD_CSS_PX));
			const bottom = Math.ceil(box.y + box.height + CROP_PAD_CSS_PX);
			const clip = {
				x: left,
				y: top,
				width: Math.max(1, right - left),
				height: Math.max(1, Math.min(bottom - top, MAX_CROP_CSS_PX)),
			};
			const crop = paint(page, clip);
			const excerpt = excerptHtml(htmlOf(hit.el), false);
			const pick: PreviewPick = {
				url,
				viewport,
				tag: hit.el.tag,
				selector,
				ancestors: ancestorLabels(steps),
				html: excerpt.html,
				htmlCut: excerpt.cut,
				text: collapseText(hit.el.text ?? ""),
				styles: curateStyles(computedOf(hit.el)),
				box: { x: box.x, y: box.y, width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 },
				crop: {
					data: crop.png().toString("base64"),
					mimeType: "image/png",
					width: crop.width,
					height: crop.height,
					cut: bottom - top > MAX_CROP_CSS_PX,
				},
			};
			return { t: "preview-pick", reqId: request.reqId, pick };
		},
	};
}
