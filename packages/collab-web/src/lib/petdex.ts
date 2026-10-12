/**
 * The petdex gallery (https://github.com/crafter-station/petdex): the manifest of user-submitted pets, their
 * sprite sheets and the geometry that maps our pet states onto a sheet. Nothing here runs until the pet picker
 * is opened or a petdex pet is already chosen; sheets are fetched at runtime from `assets.petdex.dev`, never bundled.
 *
 * Sheet format: a grid of 8 columns of 192x208 cells, one row per state (version 1: 9 rows, version 2: 11 rows;
 * rows past the ninth are unused here). Row order, frame counts and frame timing come from petdex's own
 * `src/lib/pet-states.ts` and `packages/petdex-desktop-native/src/sprite.zig`.
 */

import type { PetState } from "./pet-state";

export const PETDEX_MANIFEST_URL = "https://petdex.dev/api/manifest";
const ASSET_HOST = "assets.petdex.dev";
/** Manifest fetches give up after this long. */
const MANIFEST_TIMEOUT_MS = 20_000;
/** A saved manifest younger than this is used as is. */
const MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Sheets are about 2 MB; anything much larger is not a sprite sheet. */
const SHEET_MAX_BYTES = 16 * 1024 * 1024;
const SHEET_TIMEOUT_MS = 30_000;
const CACHE_NAME = "omp-collab-pet-v1";
const MANIFEST_KEY = "https://omp-collab.invalid/petdex-manifest";

/** One pet of the gallery, reduced to what the app uses. */
export interface PetdexPet {
	slug: string;
	name: string;
	kind: string;
	/** The submitter's name as petdex shows it. */
	by: string;
	/** An https `assets.petdex.dev` URL of the sprite sheet. */
	sheet: string;
	version: 1 | 2;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** True for an https URL on petdex's asset host, the only place sprites are fetched from. */
export function isPetdexAssetUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 300) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === ASSET_HOST && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

function text(value: unknown, max: number): string | null {
	return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;
}

/** A pet from untrusted JSON (the manifest, or this device's saved choice), or null when it is unusable. */
export function parsePetdexPet(raw: unknown): PetdexPet | null {
	if (typeof raw !== "object" || raw === null) return null;
	const entry = raw as Record<string, unknown>;
	const slug = typeof entry.slug === "string" && SLUG.test(entry.slug) ? entry.slug : null;
	const sheet = entry.sheet ?? entry.spritesheetUrl;
	if (slug === null || !isPetdexAssetUrl(sheet)) return null;
	const rawVersion = entry.version ?? entry.spriteVersionNumber;
	return {
		slug,
		name: text(entry.name ?? entry.displayName, 80) ?? slug,
		kind: text(entry.kind, 24) ?? "pet",
		by: text(entry.by ?? entry.submittedBy, 60) ?? "unknown",
		sheet,
		version: rawVersion === 2 ? 2 : 1,
	};
}

/** The gallery from the manifest JSON, dropping entries without an https `assets.petdex.dev` sheet. */
export function parseManifest(json: unknown): PetdexPet[] {
	const list = typeof json === "object" && json !== null && "pets" in json ? json.pets : null;
	if (!Array.isArray(list)) throw new Error("The petdex list is not in the expected format.");
	const seen = new Set<string>();
	const pets: PetdexPet[] = [];
	for (const raw of list as unknown[]) {
		const pet = parsePetdexPet(raw);
		if (pet === null || seen.has(pet.slug)) continue;
		seen.add(pet.slug);
		pets.push(pet);
	}
	return pets;
}

/** The lightweight animated preview petdex publishes per pet: the idle row alone, six frames, about 55 KB. */
export function petdexPreviewUrl(slug: string): string {
	return `https://${ASSET_HOST}/pets/${encodeURIComponent(slug)}/preview.webp`;
}

/** Frames in a preview strip (the idle row). */
export const PREVIEW_FRAMES = 6;

/** Row, frame count and loop time of each state on a petdex sheet. */
export const PETDEX_ROWS: Readonly<Record<PetState, { row: number; frames: number; durationMs: number }>> = {
	idle: { row: 0, frames: 6, durationMs: 1100 },
	"running-right": { row: 1, frames: 8, durationMs: 1060 },
	"running-left": { row: 2, frames: 8, durationMs: 1060 },
	waving: { row: 3, frames: 4, durationMs: 700 },
	jumping: { row: 4, frames: 5, durationMs: 840 },
	failed: { row: 5, frames: 8, durationMs: 1220 },
	waiting: { row: 6, frames: 6, durationMs: 1010 },
	running: { row: 7, frames: 6, durationMs: 820 },
	review: { row: 8, frames: 6, durationMs: 1030 },
};

const COLUMNS = 8;
/** A cell is 192 wide by 208 high. */
export const CELL_ASPECT = 208 / 192;

export interface SpriteGeometry {
	/** Box of one frame in CSS px. */
	width: number;
	height: number;
	/** `background-size` width: the whole sheet at this scale; its height follows the aspect ratio. */
	sheetWidth: number;
	/** `background-position-y`: the state's row scrolled into view. */
	offsetY: number;
	/** Frames to step through, and the time one loop takes. */
	frames: number;
	durationMs: number;
	/** The animation's end, as a `background-position-x` offset (the row's width at this scale). */
	travelX: number;
}

/** Where on a sheet drawn `size` px wide per cell the frames of `state` are. */
export function spriteGeometry(size: number, state: PetState): SpriteGeometry {
	const row = PETDEX_ROWS[state];
	const height = size * CELL_ASPECT;
	return {
		width: size,
		height,
		sheetWidth: size * COLUMNS,
		offsetY: -row.row * height,
		frames: row.frames,
		durationMs: row.durationMs,
		travelX: -row.frames * size,
	};
}

export interface PetdexList {
	pets: PetdexPet[];
	/** The list came from this device's saved copy because the fetch failed. */
	stale: boolean;
}

async function openCache(): Promise<Cache | null> {
	if (typeof caches === "undefined") return null;
	try {
		return await caches.open(CACHE_NAME);
	} catch {
		return null;
	}
}

async function fetchChecked(url: string, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			credentials: "omit",
			referrerPolicy: "no-referrer",
		});
		if (!response.ok) throw new Error(`petdex answered ${response.status}`);
		return response;
	} catch (err) {
		if (controller.signal.aborted) throw new Error("petdex did not answer in time");
		if (err instanceof Error && err.message.startsWith("petdex answered")) throw err;
		throw new Error("Could not reach petdex.");
	} finally {
		clearTimeout(timer);
	}
}

async function savedManifest(cache: Cache | null): Promise<{ pets: PetdexPet[]; fetchedAt: number } | null> {
	if (cache === null) return null;
	try {
		const hit = await cache.match(MANIFEST_KEY);
		if (!hit) return null;
		const saved: unknown = await hit.json();
		if (typeof saved !== "object" || saved === null || !("fetchedAt" in saved)) return null;
		return { pets: parseManifest(saved), fetchedAt: Number(saved.fetchedAt) || 0 };
	} catch {
		return null;
	}
}

/**
 * The gallery: this device's copy while it is less than a day old, else a fresh fetch (validated, then saved).
 * A failed fetch falls back to an older copy, marked `stale`, and only throws when there is none.
 */
export async function loadPetdexList(now: number = Date.now()): Promise<PetdexList> {
	const cache = await openCache();
	const saved = await savedManifest(cache);
	if (saved !== null && now - saved.fetchedAt < MANIFEST_MAX_AGE_MS) return { pets: saved.pets, stale: false };
	try {
		const response = await fetchChecked(PETDEX_MANIFEST_URL, MANIFEST_TIMEOUT_MS);
		if (response.redirected && !isPetdexAssetUrl(response.url))
			throw new Error("petdex sent the list from an unexpected place");
		const pets = parseManifest(await response.json());
		if (pets.length === 0) throw new Error("The petdex list is empty.");
		if (cache !== null) {
			const body = { fetchedAt: now, pets };
			await cache
				.put(MANIFEST_KEY, new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }))
				.catch(() => {});
		}
		return { pets, stale: false };
	} catch (err) {
		if (saved !== null) return { pets: saved.pets, stale: true };
		throw err instanceof Error ? err : new Error(String(err));
	}
}

/**
 * The sprite sheet at `sheet` as an image blob: this device's copy when there is one (so a chosen pet works
 * offline), else downloaded once (about 2 MB) and kept.
 */
export async function loadPetdexSheet(sheet: string): Promise<Blob> {
	if (!isPetdexAssetUrl(sheet)) throw new Error("This pet has no sprite sheet.");
	const cache = await openCache();
	const hit = cache ? await cache.match(sheet).catch(() => undefined) : undefined;
	if (hit) return await hit.blob();
	const response = await fetchChecked(sheet, SHEET_TIMEOUT_MS);
	const blob = await response.clone().blob();
	if (!blob.type.startsWith("image/") || blob.size > SHEET_MAX_BYTES)
		throw new Error("This pet's sprite sheet is not a usable image.");
	await cache?.put(sheet, response).catch(() => {});
	return blob;
}

/** Forget every saved sprite sheet except `keep`'s, so the device holds only the chosen pet. */
export async function pruneSheets(keep: string | null): Promise<void> {
	const cache = await openCache();
	if (cache === null) return;
	for (const request of await cache.keys()) {
		if (request.url !== MANIFEST_KEY && request.url !== keep) await cache.delete(request);
	}
}

/** Pets whose name, slug, kind or submitter contains every word of `query`; the list unchanged for a blank query. */
export function searchPets(pets: readonly PetdexPet[], query: string): readonly PetdexPet[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return pets;
	return pets.filter(pet => {
		const haystack = `${pet.name} ${pet.slug} ${pet.kind} ${pet.by}`.toLowerCase();
		return words.every(word => haystack.includes(word));
	});
}
