/**
 * Excalidraw scenes as this app handles them: untrusted JSON (an agent's reply, a repository file) is
 * validated into a {@link Scene} before anything renders it, and a scene is compacted before it goes to the
 * agent. Pure and dependency-free: the Excalidraw library itself is only imported by the canvas.
 *
 * Validation is an allow-list. Every element is rebuilt from the fields below, each checked for its shape,
 * so nothing else in the input (links, embeds, prototype keys, oversized buffers) reaches the renderer.
 */

import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

export const SCENE_TYPE = "excalidraw";
export const SCENE_VERSION = 2;

/** Largest scene text parsed, in characters. */
export const MAX_SCENE_CHARS = 4_000_000;
export const MAX_ELEMENTS = 5_000;
/** Longest `points` list of one line, arrow or freehand stroke. */
export const MAX_POINTS = 20_000;
export const MAX_TEXT_CHARS = 20_000;
/** Largest coordinate or size: far past any real drawing, small enough that arithmetic stays exact. */
export const MAX_COORD = 1e7;
/** Embedded images: their data URLs together stay under this many characters. */
export const MAX_FILES_CHARS = 8_000_000;
export const MAX_FILES = 64;

/** Element types the app renders. Embeds (`embeddable`, `iframe`) and anything unknown are dropped: they load other pages. */
const ELEMENT_TYPES = [
	"rectangle",
	"diamond",
	"ellipse",
	"arrow",
	"line",
	"freedraw",
	"text",
	"image",
	"frame",
] as const;
export type SceneElementType = (typeof ELEMENT_TYPES)[number];

/** One validated element: only allow-listed fields, all of the shape their validator accepts. */
export interface SceneElement {
	id: string;
	type: SceneElementType;
	x: number;
	y: number;
	[field: string]: unknown;
}

/** An embedded raster image of the scene. */
export interface SceneFile {
	id: string;
	mimeType: string;
	dataURL: string;
	created: number;
}

export interface Scene {
	type: typeof SCENE_TYPE;
	version: number;
	elements: SceneElement[];
	appState: { viewBackgroundColor?: string; gridSize?: number | null };
	files: Record<string, SceneFile>;
}

export type SceneParse = { ok: true; scene: Scene; skipped: number } | { ok: false; error: string };

class SceneError extends Error {}

function fail(message: string): never {
	throw new SceneError(message);
}

type Validator = (value: unknown, where: string) => unknown;

const num = (value: unknown, where: string): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_COORD) {
		fail(`${where} must be a finite number`);
	}
	return value;
};

const str =
	(max: number): Validator =>
	(value, where) => {
		if (typeof value !== "string" || value.length > max)
			fail(`${where} must be a string of at most ${max} characters`);
		return value;
	};

const bool: Validator = (value, where) => {
	if (typeof value !== "boolean") fail(`${where} must be true or false`);
	return value;
};

/** A CSS color word, hex or `rgb()`/`hsl()` call: characters that cannot break out of an attribute or add a URL. */
const COLOR = /^[#a-zA-Z0-9(),.%\s/-]{1,64}$/;
const color: Validator = (value, where) => {
	if (typeof value !== "string" || !COLOR.test(value) || /url|expression|javascript/i.test(value)) {
		fail(`${where} must be a color`);
	}
	return value;
};

const oneOf =
	(options: readonly (string | number)[]): Validator =>
	(value, where) => {
		if ((typeof value !== "string" && typeof value !== "number") || !options.includes(value)) {
			fail(`${where} must be one of ${options.join(", ")}`);
		}
		return value;
	};

const nullable =
	(inner: Validator): Validator =>
	(value, where) =>
		value === null ? null : inner(value, where);

const idList: Validator = (value, where) => {
	if (!Array.isArray(value) || value.length > 64) fail(`${where} must be a list of at most 64 ids`);
	return value.map((id, i) => str(100)(id, `${where}[${i}]`));
};

const points = (value: unknown, where: string): number[][] => {
	if (!Array.isArray(value) || value.length > MAX_POINTS)
		fail(`${where} must be a list of at most ${MAX_POINTS} points`);
	return value.map((point, i) => {
		if (!Array.isArray(point) || point.length < 2) fail(`${where}[${i}] must be an [x, y] pair`);
		return [num(point[0], `${where}[${i}][0]`), num(point[1], `${where}[${i}][1]`)];
	});
};

const numberList: Validator = (value, where) => {
	if (!Array.isArray(value) || value.length > MAX_POINTS) fail(`${where} must be a list of numbers`);
	return value.map((n, i) => num(n, `${where}[${i}]`));
};

const roundness: Validator = (value, where) => {
	if (value === null) return null;
	if (!isRecord(value)) fail(`${where} must be null or an object`);
	const out: Record<string, unknown> = { type: oneOf([1, 2, 3])(value.type, `${where}.type`) };
	if (value.value !== undefined) out.value = num(value.value, `${where}.value`);
	return out;
};

const boundElements: Validator = (value, where) => {
	if (value === null) return null;
	if (!Array.isArray(value) || value.length > 256) fail(`${where} must be null or a list of at most 256 bindings`);
	return value.map((bound, i) => {
		if (!isRecord(bound)) fail(`${where}[${i}] must be an object`);
		return {
			id: str(100)(bound.id, `${where}[${i}].id`),
			type: oneOf(["arrow", "text"])(bound.type, `${where}[${i}].type`),
		};
	});
};

const binding: Validator = (value, where) => {
	if (value === null) return null;
	if (!isRecord(value)) fail(`${where} must be null or an object`);
	const out: Record<string, unknown> = {
		elementId: str(100)(value.elementId, `${where}.elementId`),
		focus: value.focus === undefined ? 0 : num(value.focus, `${where}.focus`),
		gap: value.gap === undefined ? 0 : num(value.gap, `${where}.gap`),
	};
	if (Array.isArray(value.fixedPoint)) out.fixedPoint = points([value.fixedPoint], `${where}.fixedPoint`)[0];
	return out;
};

const ARROWHEADS = [
	"arrow",
	"bar",
	"dot",
	"circle",
	"circle_outline",
	"triangle",
	"triangle_outline",
	"diamond",
	"diamond_outline",
];
const arrowhead = nullable(oneOf(ARROWHEADS));

const scale: Validator = (value, where) => {
	if (!Array.isArray(value) || value.length !== 2) fail(`${where} must be a pair`);
	return [oneOf([1, -1])(value[0], `${where}[0]`), oneOf([1, -1])(value[1], `${where}[1]`)];
};

/** The allow-list: element fields that survive validation, each with the check for its shape. */
const FIELDS: Record<string, Validator> = {
	id: str(100),
	x: num,
	y: num,
	width: num,
	height: num,
	angle: num,
	strokeColor: color,
	backgroundColor: color,
	fillStyle: oneOf(["solid", "hachure", "cross-hatch", "zigzag"]),
	strokeWidth: num,
	strokeStyle: oneOf(["solid", "dashed", "dotted"]),
	roughness: num,
	opacity: num,
	groupIds: idList,
	frameId: nullable(str(100)),
	roundness,
	seed: num,
	version: num,
	versionNonce: num,
	isDeleted: bool,
	boundElements,
	updated: num,
	locked: bool,
	index: nullable(str(100)),
	text: str(MAX_TEXT_CHARS),
	originalText: str(MAX_TEXT_CHARS),
	fontSize: num,
	fontFamily: oneOf([1, 2, 3, 4, 5, 6, 7, 8, 9]),
	textAlign: oneOf(["left", "center", "right"]),
	verticalAlign: oneOf(["top", "middle", "bottom"]),
	containerId: nullable(str(100)),
	autoResize: bool,
	lineHeight: num,
	points,
	pressures: numberList,
	simulatePressure: bool,
	startBinding: binding,
	endBinding: binding,
	startArrowhead: arrowhead,
	endArrowhead: arrowhead,
	elbowed: bool,
	fileId: nullable(str(100)),
	status: oneOf(["pending", "saved", "error"]),
	scale,
	name: nullable(str(200)),
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function validateElement(raw: unknown, index: number): SceneElement | null {
	const where = `element ${index + 1}`;
	if (!isRecord(raw)) fail(`${where} is not an object`);
	if (typeof raw.type !== "string") fail(`${where} has no type`);
	if (!(ELEMENT_TYPES as readonly string[]).includes(raw.type)) return null;
	const out: Record<string, unknown> = { type: raw.type };
	for (const key of Object.keys(FIELDS)) {
		if (!Object.hasOwn(raw, key) || raw[key] === undefined) continue;
		out[key] = FIELDS[key]!(raw[key], `${where}.${key}`);
	}
	const id = out.id ?? `el-${index}`;
	if (typeof id !== "string" || !ID_PATTERN.test(id) || id === "__proto__") fail(`${where} has an invalid id`);
	out.id = id;
	out.x ??= 0;
	out.y ??= 0;
	return out as SceneElement;
}

function validateFiles(raw: unknown, wanted: ReadonlySet<string>): Record<string, SceneFile> {
	const files: Record<string, SceneFile> = {};
	if (raw === undefined || raw === null) return files;
	if (!isRecord(raw)) fail("files must be an object");
	let total = 0;
	let count = 0;
	for (const id of Object.keys(raw)) {
		// Only the images the elements use are kept.
		if (!wanted.has(id)) continue;
		const file = raw[id];
		if (!ID_PATTERN.test(id) || id === "__proto__") fail(`file ${id} has an invalid id`);
		if (!isRecord(file)) fail(`file ${id} is not an object`);
		const dataURL = str(MAX_FILES_CHARS)(file.dataURL, `file ${id}.dataURL`) as string;
		if (!IMAGE_DATA_URL.test(dataURL)) fail(`file ${id} must be a png, jpeg, gif or webp data URL`);
		total += dataURL.length;
		if (++count > MAX_FILES || total > MAX_FILES_CHARS) fail("the embedded images are too large");
		const mimeType = /^data:([^;]+);/.exec(dataURL)![1]!;
		const created = typeof file.created === "number" && Number.isFinite(file.created) ? file.created : 0;
		files[id] = { id, mimeType, dataURL, created };
	}
	return files;
}

/** Validate already-parsed JSON as a scene. Never throws. */
export function validateScene(raw: unknown): SceneParse {
	try {
		if (!isRecord(raw)) fail("the scene is not an object");
		if (raw.type !== SCENE_TYPE) fail('the scene is missing "type": "excalidraw"');
		if (!Array.isArray(raw.elements)) fail("the scene has no elements list");
		if (raw.elements.length > MAX_ELEMENTS) fail(`the scene has more than ${MAX_ELEMENTS} elements`);
		const elements: SceneElement[] = [];
		const seen = new Set<string>();
		let skipped = 0;
		raw.elements.forEach((item, index) => {
			const element = validateElement(item, index);
			if (element === null) {
				skipped++;
				return;
			}
			if (seen.has(element.id)) fail(`element ${index + 1} repeats the id ${element.id}`);
			seen.add(element.id);
			elements.push(element);
		});
		const wanted = new Set<string>();
		for (const element of elements) {
			if (element.type === "image" && typeof element.fileId === "string") wanted.add(element.fileId);
		}
		const state = isRecord(raw.appState) ? raw.appState : {};
		const appState: Scene["appState"] = {};
		if (state.viewBackgroundColor !== undefined) {
			appState.viewBackgroundColor = color(state.viewBackgroundColor, "viewBackgroundColor") as string;
		}
		if (state.gridSize !== undefined) {
			appState.gridSize = state.gridSize === null ? null : (num(state.gridSize, "gridSize") as number);
		}
		return {
			ok: true,
			scene: {
				type: SCENE_TYPE,
				version: SCENE_VERSION,
				elements,
				appState,
				files: validateFiles(raw.files, wanted),
			},
			skipped,
		};
	} catch (error) {
		if (error instanceof SceneError) return { ok: false, error: error.message };
		throw error;
	}
}

/** Parse and validate scene JSON text (an agent's fence, a repository file). Never throws. */
export function parseScene(text: string): SceneParse {
	if (text.length > MAX_SCENE_CHARS) return { ok: false, error: "the scene is too large" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: "the scene is not valid JSON" };
	}
	return validateScene(raw);
}

// --- Compaction for the agent ---

const DEFAULT_STROKE = "#1e1e1e";
const POINT_BUDGET = 24;
const TIGHT_POINT_BUDGET = 8;

function round(value: number, places = 0): number {
	const k = 10 ** places;
	return Math.round(value * k) / k;
}

function thin(list: readonly unknown[], budget: number): unknown[] {
	if (list.length <= budget) return [...list];
	const out: unknown[] = [];
	for (let i = 0; i < budget; i++) out.push(list[Math.round((i * (list.length - 1)) / (budget - 1))]);
	return out;
}

function compactElement(element: SceneElement, budget: number): Record<string, unknown> {
	const out: Record<string, unknown> = { id: element.id, type: element.type };
	out.x = round(element.x);
	out.y = round(element.y);
	if (typeof element.width === "number") out.width = round(element.width);
	if (typeof element.height === "number") out.height = round(element.height);
	if (typeof element.angle === "number" && element.angle !== 0) out.angle = round(element.angle, 2);
	if (typeof element.strokeColor === "string" && element.strokeColor !== DEFAULT_STROKE) {
		out.strokeColor = element.strokeColor;
	}
	if (typeof element.backgroundColor === "string" && element.backgroundColor !== "transparent") {
		out.backgroundColor = element.backgroundColor;
	}
	if (element.strokeStyle === "dashed" || element.strokeStyle === "dotted") out.strokeStyle = element.strokeStyle;
	if (Array.isArray(element.groupIds) && element.groupIds.length > 0) out.groupIds = element.groupIds;
	if (typeof element.frameId === "string") out.frameId = element.frameId;
	if (typeof element.name === "string") out.name = element.name;
	if (element.type === "text") {
		out.text = element.text ?? "";
		if (typeof element.containerId === "string") out.containerId = element.containerId;
		if (typeof element.fontSize === "number" && element.fontSize !== 20) out.fontSize = round(element.fontSize);
	}
	if (element.type === "arrow" || element.type === "line" || element.type === "freedraw") {
		const list = Array.isArray(element.points) ? (element.points as number[][]) : [];
		const kept = element.type === "freedraw" ? thin(list, budget) : list;
		out.points = (kept as number[][]).map(point => [round(point[0]!), round(point[1]!)]);
	}
	if (element.type === "arrow") {
		const start = element.startBinding as { elementId: string } | null | undefined;
		const end = element.endBinding as { elementId: string } | null | undefined;
		if (start) out.startBinding = { elementId: start.elementId };
		if (end) out.endBinding = { elementId: end.elementId };
		if (element.startArrowhead) out.startArrowhead = element.startArrowhead;
		if (element.endArrowhead !== undefined && element.endArrowhead !== "arrow")
			out.endArrowhead = element.endArrowhead;
	}
	// An image's pixels travel in the PNG; the scene only says where it sits.
	return out;
}

export type CompactResult = { ok: true; json: string; elements: number } | { ok: false; error: string };

/**
 * The scene as the agent should read it: deleted elements, rendering noise (seed, version, roughness,
 * timestamps, ordering keys) and embedded image data dropped, numbers rounded, strokes thinned, one line of
 * JSON. The result is still an Excalidraw scene a person can load. Fails when it does not fit `maxChars`
 * even with strokes cut to a few points.
 */
export function compactScene(scene: Scene, maxChars: number): CompactResult {
	const live = scene.elements.filter(element => element.isDeleted !== true);
	for (const budget of [POINT_BUDGET, TIGHT_POINT_BUDGET]) {
		const json = JSON.stringify({
			type: SCENE_TYPE,
			version: SCENE_VERSION,
			elements: live.map(element => compactElement(element, budget)),
			...(scene.appState.viewBackgroundColor
				? { appState: { viewBackgroundColor: scene.appState.viewBackgroundColor } }
				: {}),
		});
		if (json.length <= maxChars) return { ok: true, json, elements: live.length };
	}
	return { ok: false, error: "the drawing is too large to attach as a scene" };
}

/** The note that goes into the message with an attached drawing, so the agent knows how to read both parts. */
export function sceneNote(imageName: string, sceneName: string): string {
	return `Attached a drawing: ${imageName} (the picture) and ${sceneName} (its Excalidraw scene: shapes have x/y/width/height, text elements hold the labels, arrows list the shapes they connect in startBinding/endBinding).`;
}
