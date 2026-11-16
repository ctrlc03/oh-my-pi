/** What the explorer remembers: its width on this device, and per computer which view and search it was left on. */
import { readJson, writeJson } from "../../../lib/storage";

export type ExplorerView = "files" | "changes" | "search" | "references";

export const WIDTH_KEY = "omp.collab.explorer-width";
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 600;
export const DEFAULT_WIDTH = 280;
/** What an arrow key moves the divider by (with Shift, the larger step). */
export const KEY_STEP = 16;
export const KEY_STEP_SHIFT = 64;

export function clampWidth(px: number, max: number = MAX_WIDTH): number {
	return Math.round(Math.min(Math.max(MIN_WIDTH, max), Math.max(MIN_WIDTH, px)));
}

export function loadWidth(): number {
	const stored = readJson(WIDTH_KEY);
	return typeof stored === "number" && Number.isFinite(stored) ? clampWidth(stored) : DEFAULT_WIDTH;
}

export function saveWidth(px: number): void {
	writeJson(WIDTH_KEY, px === DEFAULT_WIDTH ? null : px);
}

export interface SearchForm {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regex: boolean;
	glob: string;
}

export const EMPTY_SEARCH: SearchForm = { query: "", caseSensitive: false, wholeWord: false, regex: false, glob: "" };

export interface ExplorerMemory {
	view: ExplorerView;
	search: SearchForm;
}

const memories = new Map<string, ExplorerMemory>();

/** The remembered state of the computer's explorer, for the page's lifetime (closing the sheet keeps it). */
export function memoryFor(instanceId: string): ExplorerMemory {
	let memory = memories.get(instanceId);
	if (memory === undefined) {
		memory = { view: "files", search: EMPTY_SEARCH };
		memories.set(instanceId, memory);
	}
	return memory;
}
