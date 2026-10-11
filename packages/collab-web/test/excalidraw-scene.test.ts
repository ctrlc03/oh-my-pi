import { describe, expect, it } from "bun:test";
import {
	compactScene,
	MAX_COORD,
	MAX_ELEMENTS,
	parseScene,
	type Scene,
	sceneNote,
	validateScene,
} from "../src/lib/excalidraw-scene";

const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

function scene(elements: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "excalidraw", version: 2, elements, appState: {}, files: {}, ...extra };
}

const box = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	id,
	type: "rectangle",
	x: 10,
	y: 20,
	width: 100,
	height: 50,
	...extra,
});

function ok(raw: unknown): { scene: Scene; skipped: number } {
	const result = validateScene(raw);
	if (!result.ok) throw new Error(result.error);
	return result;
}

describe("validateScene", () => {
	it("accepts a well-formed scene", () => {
		const { scene: parsed, skipped } = ok(scene([box("a"), box("b", { strokeColor: "#ff0000" })]));
		expect(parsed.elements.map(element => element.id)).toEqual(["a", "b"]);
		expect(skipped).toBe(0);
	});

	it("rejects things that are not a scene", () => {
		expect(validateScene(null).ok).toBe(false);
		expect(validateScene([]).ok).toBe(false);
		expect(validateScene({ type: "other", elements: [] }).ok).toBe(false);
		expect(validateScene({ type: "excalidraw" }).ok).toBe(false);
		expect(validateScene({ ...scene([]), elements: "nope" }).ok).toBe(false);
	});

	it("rejects non-finite and absurd numbers", () => {
		expect(validateScene(scene([box("a", { x: Number.NaN })])).ok).toBe(false);
		expect(validateScene(scene([box("a", { width: Number.POSITIVE_INFINITY })])).ok).toBe(false);
		expect(validateScene(scene([box("a", { x: MAX_COORD * 10 })])).ok).toBe(false);
		expect(validateScene(scene([box("a", { y: "20" })])).ok).toBe(false);
	});

	it("rejects ids that could shadow object members, and duplicate ids", () => {
		expect(validateScene(scene([box("__proto__")])).ok).toBe(false);
		expect(validateScene(scene([box("a"), box("a")])).ok).toBe(false);
		expect(validateScene(scene([{ ...box("a"), id: 7 }])).ok).toBe(false);
	});

	it("drops embeds and unknown element types instead of loading them", () => {
		const { scene: parsed, skipped } = ok(
			scene([
				box("a"),
				{ id: "e", type: "embeddable", x: 0, y: 0, link: "https://evil.example" },
				{ id: "f", type: "iframe", x: 0, y: 0 },
				{ id: "g", type: "something-new", x: 0, y: 0 },
			]),
		);
		expect(parsed.elements.map(element => element.id)).toEqual(["a"]);
		expect(skipped).toBe(3);
	});

	it("rejects hostile colors and drops script links", () => {
		expect(validateScene(scene([box("a", { strokeColor: "url(https://evil.example/x)" })])).ok).toBe(false);
		expect(validateScene(scene([box("a", { backgroundColor: 'red" onload="x' })])).ok).toBe(false);
		const withLink = validateScene(scene([box("a", { link: "javascript:alert(1)" })]));
		if (withLink.ok) expect(JSON.stringify(withLink.scene.elements)).not.toContain("javascript:");
	});

	it("does not copy unknown fields onto elements", () => {
		const { scene: parsed } = ok(scene([box("a", { onclick: "alert(1)", constructor: { polluted: true } })]));
		expect(Object.hasOwn(parsed.elements[0]!, "onclick")).toBe(false);
		expect(JSON.stringify(parsed.elements[0])).not.toContain("polluted");
	});

	it("rejects more elements than the limit", () => {
		const many = Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => box(`e${i}`));
		expect(validateScene(scene(many)).ok).toBe(false);
	});

	it("keeps only raster data URLs of files that an image element uses", () => {
		const image = { id: "img", type: "image", x: 0, y: 0, width: 10, height: 10, fileId: "f1" };
		const kept = ok(
			scene([image], {
				files: {
					f1: { id: "f1", mimeType: "image/png", dataURL: PIXEL, created: 1 },
					f2: { id: "f2", mimeType: "image/png", dataURL: PIXEL, created: 1 },
				},
			}),
		);
		expect(Object.keys(kept.scene.files)).toEqual(["f1"]);
		const svgFile = validateScene(
			scene([image], {
				files: {
					f1: { id: "f1", mimeType: "image/svg+xml", dataURL: "data:image/svg+xml;base64,PHN2Zz4=", created: 1 },
				},
			}),
		);
		expect(svgFile.ok === false || Object.keys(svgFile.scene.files).length === 0).toBe(true);
		const html = validateScene(
			scene([image], {
				files: { f1: { id: "f1", mimeType: "image/png", dataURL: "data:text/html,<script>", created: 1 } },
			}),
		);
		expect(html.ok === false || Object.keys(html.scene.files).length === 0).toBe(true);
	});
});

describe("parseScene", () => {
	it("parses scene JSON", () => {
		const result = parseScene(JSON.stringify(scene([box("a")])));
		expect(result.ok).toBe(true);
	});

	it("rejects text that is not JSON", () => {
		expect(parseScene("not json").ok).toBe(false);
		expect(parseScene("").ok).toBe(false);
		expect(parseScene('{"type":"excalidraw","elements":').ok).toBe(false);
	});

	it("rejects oversized text without parsing it", () => {
		expect(parseScene(`{"type":"excalidraw","elements":[],"pad":"${"a".repeat(4_100_000)}"}`).ok).toBe(false);
	});

	it("ignores a __proto__ key in the JSON", () => {
		const result = parseScene('{"type":"excalidraw","version":2,"elements":[],"__proto__":{"polluted":true}}');
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		if (result.ok) expect(Object.hasOwn(result.scene, "polluted")).toBe(false);
	});
});

describe("compactScene", () => {
	const stroke = {
		id: "s",
		type: "freedraw",
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		points: Array.from({ length: 200 }, (_, i) => [i * 0.123456, i * 0.654321]),
		pressures: [],
		simulatePressure: true,
	};

	function compacted(elements: unknown[], files: Record<string, unknown> = {}): Scene {
		return ok(scene(elements, { files, appState: { viewBackgroundColor: "#ffffff" } })).scene;
	}

	it("drops deleted elements and rendering noise", () => {
		const result = compactScene(
			compacted([
				box("keep", { seed: 123, versionNonce: 5, roughness: 1, updated: 99, index: "a0" }),
				box("gone", { isDeleted: true }),
			]),
			100_000,
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.elements).toBe(1);
		const parsed = JSON.parse(result.json);
		expect(parsed.type).toBe("excalidraw");
		expect(parsed.elements.map((element: { id: string }) => element.id)).toEqual(["keep"]);
		expect(result.json).not.toContain("versionNonce");
		expect(result.json).not.toContain('"seed"');
		expect(result.json).not.toContain('"updated"');
	});

	it("rounds numbers and thins strokes", () => {
		const result = compactScene(compacted([stroke]), 100_000);
		if (!result.ok) throw new Error(result.error);
		const element = JSON.parse(result.json).elements[0];
		expect(element.points.length).toBeLessThanOrEqual(24);
		expect(result.json).not.toMatch(/\d\.\d{3,}/);
	});

	it("drops embedded image data", () => {
		const image = { id: "img", type: "image", x: 0, y: 0, width: 10, height: 10, fileId: "f1" };
		const result = compactScene(
			compacted([image], { f1: { id: "f1", mimeType: "image/png", dataURL: PIXEL, created: 1 } }),
			100_000,
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.json).not.toContain("data:image");
	});

	it("is smaller than the full scene and still a loadable scene", () => {
		const full = compacted([box("a", { seed: 1, versionNonce: 2, version: 3 }), stroke]);
		const result = compactScene(full, 100_000);
		if (!result.ok) throw new Error(result.error);
		expect(result.json.length).toBeLessThan(JSON.stringify(full).length);
		expect(parseScene(result.json).ok).toBe(true);
	});

	it("fails rather than truncating when the scene cannot fit", () => {
		const many = Array.from({ length: 200 }, (_, i) => box(`e${i}`));
		const result = compactScene(compacted(many), 500);
		expect(result.ok).toBe(false);
	});
});

describe("sceneNote", () => {
	it("names both attachments", () => {
		const note = sceneNote("sketch.png", "sketch.excalidraw");
		expect(note).toContain("sketch.png");
		expect(note).toContain("sketch.excalidraw");
	});
});
