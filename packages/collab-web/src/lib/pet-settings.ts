/**
 * The pet's per-device settings and spot, kept in `localStorage` like the theme: a module-level store that
 * the pet layer, the settings sheet and the palette all read through `usePetSettings`.
 */

import { useSyncExternalStore } from "react";
import { type PetdexPet, parsePetdexPet } from "./petdex";
import { readJson, writeJson } from "./storage";

const SETTINGS_KEY = "omp.collab.pet";
const SPOT_KEY = "omp.collab.pet-spot";

export const PET_SIZE_MIN = 32;
export const PET_SIZE_MAX = 160;
const SIZE_DESKTOP = 64;
const SIZE_TOUCH = 44;
export const MASCOT = "mascot";

export interface PetSettings {
	enabled: boolean;
	/** `mascot` (our own art) or the slug of the petdex pet in `pick`. */
	choice: string;
	/** The chosen petdex pet, kept whole so it draws without the gallery; null with the mascot. */
	pick: PetdexPet | null;
	/** Width of the pet in CSS px. */
	size: number;
	/** Wander along the bottom while idle. */
	roam: boolean;
	/** It was popped out into its own window last time; the window is never reopened on load (it needs a click). */
	popout: boolean;
}

/** Where the pet sits, as fractions of the room left in the viewport (0 left/top, 1 right/bottom). */
export interface PetSpot {
	x: number;
	y: number;
}

export function clampPetSize(size: number): number {
	return Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, Math.round(size)));
}

/** Defaults: on with a mouse, off on a touch screen, which also gets the smaller pet. */
export function defaultPetSettings(touch: boolean): PetSettings {
	return {
		enabled: !touch,
		choice: MASCOT,
		pick: null,
		size: touch ? SIZE_TOUCH : SIZE_DESKTOP,
		roam: false,
		popout: false,
	};
}

/** Settings from whatever is stored, field by field: a missing, mistyped or unsafe value takes its default. */
export function parsePetSettings(raw: unknown, touch: boolean): PetSettings {
	const defaults = defaultPetSettings(touch);
	if (typeof raw !== "object" || raw === null) return defaults;
	const stored = raw as Record<string, unknown>;
	const pick = parsePetdexPet(stored.pick);
	const wantsPick = typeof stored.choice === "string" && stored.choice !== MASCOT;
	// A petdex choice is only as good as its saved pet: without one it is the mascot again.
	const usable = wantsPick && pick !== null && pick.slug === stored.choice;
	return {
		enabled: typeof stored.enabled === "boolean" ? stored.enabled : defaults.enabled,
		choice: usable ? pick.slug : MASCOT,
		pick: usable ? pick : null,
		size: typeof stored.size === "number" && Number.isFinite(stored.size) ? clampPetSize(stored.size) : defaults.size,
		roam: typeof stored.roam === "boolean" ? stored.roam : defaults.roam,
		popout: typeof stored.popout === "boolean" ? stored.popout : defaults.popout,
	};
}

export function parsePetSpot(raw: unknown): PetSpot | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { x, y } = raw as Record<string, unknown>;
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function isTouchDevice(): boolean {
	return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

let settings: PetSettings | null = null;
let spot: PetSpot | null | undefined;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function getSettings(): PetSettings {
	settings ??= parsePetSettings(readJson(SETTINGS_KEY), isTouchDevice());
	return settings;
}

function getSpot(): PetSpot | null {
	if (spot === undefined) spot = parsePetSpot(readJson(SPOT_KEY));
	return spot;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Change some settings; a petdex choice carries its pet, the mascot clears it. */
export function setPetSettings(patch: Partial<PetSettings>): void {
	const next = { ...getSettings(), ...patch };
	if (patch.size !== undefined) next.size = clampPetSize(patch.size);
	settings = parsePetSettings(next, isTouchDevice());
	writeJson(SETTINGS_KEY, settings);
	emit();
}

/** Remember where the user dropped the pet; null goes back to the default spot above the message box. */
export function setPetSpot(next: PetSpot | null): void {
	spot = next === null ? null : parsePetSpot(next);
	writeJson(SPOT_KEY, spot);
	emit();
}

export function usePetSettings(): PetSettings {
	return useSyncExternalStore(subscribe, getSettings, getSettings);
}

export function usePetSpot(): PetSpot | null {
	return useSyncExternalStore(subscribe, getSpot, getSpot);
}
