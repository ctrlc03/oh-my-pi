/**
 * The Memory screen's pure parts: filter state → the companion's query, paging and live updates of the shown list, and
 * the name an export is saved under.
 */

import type { PersonalExportFormat, PersonalMemory, PersonalMemoryQuery } from "@oh-my-pi/pi-wire/personal";
import type { PersonalOrigin } from "@oh-my-pi/pi-wire/personal-ipc";

export const MEMORY_PAGE = 30;

export interface MemoryFilters {
	/** As typed; trimmed when it becomes the query. */
	q: string;
	/** Empty: every origin. */
	origins: readonly PersonalOrigin[];
	pinnedOnly: boolean;
	/** Retracted and replaced memories too. */
	includeInvalid: boolean;
}

export const NO_FILTERS: MemoryFilters = { q: "", origins: [], pinnedOnly: false, includeInvalid: false };

/** The origins in the order the chips show them. */
export const ORIGIN_ORDER: readonly PersonalOrigin[] = ["owner", "agent", "external"];

export function toggleOrigin(filters: MemoryFilters, origin: PersonalOrigin): MemoryFilters {
	const origins = filters.origins.includes(origin)
		? filters.origins.filter(o => o !== origin)
		: ORIGIN_ORDER.filter(o => o === origin || filters.origins.includes(o));
	return { ...filters, origins };
}

/** Whether any filter narrows the list (an empty answer then means "no matches", not "nothing remembered"). */
export function isFiltered(filters: MemoryFilters): boolean {
	return filters.q.trim() !== "" || filters.origins.length > 0 || filters.pinnedOnly || filters.includeInvalid;
}

/** `limit` memories from `offset`; keys that would say "no filter" are left out. */
export function memoryQuery(filters: MemoryFilters, offset: number, limit = MEMORY_PAGE): PersonalMemoryQuery {
	const query: PersonalMemoryQuery = { limit, offset };
	const q = filters.q.trim();
	if (q !== "") query.q = q;
	if (filters.origins.length > 0) query.origin = [...filters.origins];
	if (filters.pinnedOnly) query.pinnedOnly = true;
	if (filters.includeInvalid) query.includeInvalid = true;
	return query;
}

/** Identifies the list a filter state asks for: a page shown for another key is not extended. */
export function filtersKey(filters: MemoryFilters): string {
	return JSON.stringify(memoryQuery(filters, 0));
}

/**
 * `page` appended to `shown`. A memory already shown (the list moved under a page boundary) keeps its place and takes the
 * newer copy, so no id appears twice.
 */
export function mergePage(shown: readonly PersonalMemory[], page: readonly PersonalMemory[]): PersonalMemory[] {
	const fresh = new Map(page.map(memory => [memory.id, memory]));
	const seen = new Set<string>();
	const merged: PersonalMemory[] = [];
	for (const memory of shown) {
		seen.add(memory.id);
		merged.push(fresh.get(memory.id) ?? memory);
	}
	for (const memory of page) {
		if (seen.has(memory.id)) continue;
		seen.add(memory.id);
		merged.push(memory);
	}
	return merged;
}

/**
 * The list after `memory` changed (pinned, unpinned, retracted): its row replaced in place. A row that no longer belongs
 * (an invalid one while retracted memories are hidden) leaves the list; `total` follows.
 */
export function applyMemory(
	shown: readonly PersonalMemory[],
	total: number,
	memory: PersonalMemory,
	includeInvalid: boolean,
): { items: PersonalMemory[]; total: number } {
	const at = shown.findIndex(row => row.id === memory.id);
	if (at < 0) return { items: [...shown], total };
	if (memory.invalid && !includeInvalid)
		return { items: shown.filter((_, i) => i !== at), total: Math.max(0, total - 1) };
	return { items: shown.map((row, i) => (i === at ? memory : row)), total };
}

const EXPORT_EXTENSIONS: Record<PersonalExportFormat, string> = { json: "json", markdown: "md" };

/**
 * The name to save an export under. The computer suggests one; it is used when it is a plain file name with the extension
 * the format needs, and made so otherwise (no folders, no control characters, never hidden or empty).
 */
export function exportFileName(suggested: string, format: PersonalExportFormat): string {
	const ext = EXPORT_EXTENSIONS[format];
	const base =
		suggested
			.split(/[\\/]/)
			.pop()
			?.replace(/\p{Cc}/gu, "")
			.replace(/^[.\s]+/, "")
			.trim() ?? "";
	if (base === "") return `personal-memory.${ext}`;
	return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** "3 Jan", with the year when it is not this one; the text itself when it is not a date. */
export function memoryDate(iso: string, now = Date.now()): string {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return iso;
	const sameYear = at.getFullYear() === new Date(now).getFullYear();
	return at.toLocaleDateString(undefined, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

/** "recalled once" / "recalled 7 times"; empty for a memory never recalled. */
export function recallText(count: number): string {
	if (count <= 0) return "";
	return count === 1 ? "recalled once" : `recalled ${count} times`;
}

/** Importance (0 to 1) as a whole percent. */
export function importancePercent(importance: number): number {
	return Math.round(Math.min(1, Math.max(0, Number.isFinite(importance) ? importance : 0)) * 100);
}
