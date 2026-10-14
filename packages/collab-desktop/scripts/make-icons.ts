/**
 * Draws the menu-bar icons into `assets/tray/` and copies the app icon into `build/`. The outputs are committed;
 * run `bun run icons` after changing the artwork. The glyph is the app's mark (`packages/collab-web/public/favicon.svg`),
 * rasterised here with plain coverage sampling so no image library is needed.
 *
 * macOS tints a "Template" image to match the menu bar, using only its alpha, so the idle, working and offline icons
 * are black with alpha; the needs-input icon is orange and not a template, so it stands out.
 */
import { deflateSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");

/** The mark's outline in the favicon's 64 × 64 box. */
const GLYPH: readonly (readonly [number, number])[] = [
	[14, 16],
	[50, 16],
	[50, 24],
	[40, 24],
	[40, 56],
	[32, 56],
	[32, 24],
	[26, 24],
	[26, 46],
	[18, 46],
	[18, 24],
	[14, 24],
];
const DOT = { x: 48, y: 46, r: 5.5 };
/** The part of the 64-unit box that is drawn, so the glyph fills the icon. */
const VIEW = { x: 10, y: 12, size: 48 };
const SAMPLES = 8;

function inGlyph(x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = GLYPH.length - 1; i < GLYPH.length; j = i++) {
		const [xi, yi] = GLYPH[i]!;
		const [xj, yj] = GLYPH[j]!;
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

function inDot(x: number, y: number): boolean {
	return (x - DOT.x) ** 2 + (y - DOT.y) ** 2 <= DOT.r ** 2;
}

interface Style {
	color: readonly [number, number, number];
	/** Alpha multiplier, 0–1. */
	alpha: number;
	dot: boolean;
}

function render(size: number, style: Style): Uint8Array {
	const pixels = new Uint8Array(size * size * 4);
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let covered = 0;
			for (let sy = 0; sy < SAMPLES; sy++) {
				for (let sx = 0; sx < SAMPLES; sx++) {
					const x = VIEW.x + ((px + (sx + 0.5) / SAMPLES) / size) * VIEW.size;
					const y = VIEW.y + ((py + (sy + 0.5) / SAMPLES) / size) * VIEW.size;
					if (inGlyph(x, y) || (style.dot && inDot(x, y))) covered++;
				}
			}
			const at = (py * size + px) * 4;
			pixels[at] = style.color[0];
			pixels[at + 1] = style.color[1];
			pixels[at + 2] = style.color[2];
			pixels[at + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * style.alpha * 255);
		}
	}
	return pixels;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

function png(size: number, pixels: Uint8Array): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, size);
	view.setUint32(4, size);
	header.set([8, 6, 0, 0, 0], 8);
	const rows = new Uint8Array(size * (size * 4 + 1));
	for (let y = 0; y < size; y++) rows.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
	const parts = [
		new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", new Uint8Array()),
	];
	return Buffer.concat(parts);
}

const ICONS: Record<string, Style> = {
	trayIdleTemplate: { color: [0, 0, 0], alpha: 1, dot: false },
	trayWorkingTemplate: { color: [0, 0, 0], alpha: 1, dot: true },
	trayOfflineTemplate: { color: [0, 0, 0], alpha: 0.35, dot: false },
	trayInput: { color: [255, 159, 10], alpha: 1, dot: true },
};

const trayDir = path.join(root, "assets", "tray");
fs.mkdirSync(trayDir, { recursive: true });
for (const [name, style] of Object.entries(ICONS)) {
	for (const [suffix, size] of [
		["", 18],
		["@2x", 36],
	] as const) {
		fs.writeFileSync(path.join(trayDir, `${name}${suffix}.png`), png(size, render(size, style)));
	}
}

const favicon = path.join(root, "..", "collab-web", "public", "favicon-512x512.png");
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.copyFileSync(favicon, path.join(root, "build", "icon.png"));

// macOS wants an .icns; building it here (sips and iconutil ship with macOS) keeps the packager from downloading a converter.
const iconset = path.join(root, "build", "icon.iconset");
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset);
for (const [name, size] of [
	["icon_16x16", 16],
	["icon_16x16@2x", 32],
	["icon_32x32", 32],
	["icon_32x32@2x", 64],
	["icon_128x128", 128],
	["icon_128x128@2x", 256],
	["icon_256x256", 256],
	["icon_256x256@2x", 512],
	["icon_512x512", 512],
] as const) {
	const resized = Bun.spawnSync([
		"sips",
		"-z",
		String(size),
		String(size),
		favicon,
		"--out",
		path.join(iconset, `${name}.png`),
	]);
	if (resized.exitCode !== 0) throw new Error(`sips failed: ${resized.stderr.toString()}`);
}
const made = Bun.spawnSync(["iconutil", "-c", "icns", iconset, "-o", path.join(root, "build", "icon.icns")]);
fs.rmSync(iconset, { recursive: true, force: true });
if (made.exitCode !== 0) throw new Error(`iconutil failed: ${made.stderr.toString()}`);
console.log(`wrote ${Object.keys(ICONS).length * 2} tray icons, build/icon.png and build/icon.icns`);
