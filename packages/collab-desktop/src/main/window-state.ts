/** Where the window was left, restored on the next launch and kept on a screen that still exists. */
import * as fs from "node:fs";
import * as path from "node:path";
import { readText, writeJsonAtomic } from "./settings";

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface WindowState extends Bounds {
	maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 860 } as const;
export const MIN_SIZE = { width: 520, height: 480 } as const;
/** How much of the window must be on a screen for the saved position to be used. */
const MIN_VISIBLE = 120;

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function parseWindowState(text: string | null): WindowState | null {
	if (text === null) return null;
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (!finite(raw.x) || !finite(raw.y) || !finite(raw.width) || !finite(raw.height)) return null;
		if (raw.width < MIN_SIZE.width || raw.height < MIN_SIZE.height) return null;
		return { x: raw.x, y: raw.y, width: raw.width, height: raw.height, maximized: raw.maximized === true };
	} catch {
		return null;
	}
}

function overlap(a: Bounds, b: Bounds): number {
	const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return width > 0 && height > 0 ? Math.min(width, height) : 0;
}

/**
 * The bounds to open with: the saved ones when enough of the window lands on a current screen (a monitor may have
 * been unplugged), else the default size centred on the primary screen (`workAreas[0]`).
 */
export function restoreBounds(saved: WindowState | null, workAreas: readonly Bounds[]): Partial<Bounds> {
	if (saved !== null && workAreas.some(area => overlap(saved, area) >= MIN_VISIBLE)) {
		return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
	}
	const primary = workAreas[0];
	if (primary === undefined) return { ...DEFAULT_SIZE };
	const width = Math.min(DEFAULT_SIZE.width, primary.width);
	const height = Math.min(DEFAULT_SIZE.height, primary.height);
	return {
		x: Math.round(primary.x + (primary.width - width) / 2),
		y: Math.round(primary.y + (primary.height - height) / 2),
		width,
		height,
	};
}

export function loadWindowState(file: string): WindowState | null {
	return parseWindowState(readText(file));
}

export function saveWindowState(file: string, state: WindowState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeJsonAtomic(file, state);
}
