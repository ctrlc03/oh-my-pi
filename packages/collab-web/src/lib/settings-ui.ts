/**
 * The Settings pane's open state, as a store so the header gear, the palette, the `?` key and contextual links can
 * open it from anywhere, and the section it shows. `openSettings("sessions")` is the deep link; without a section
 * it reopens the one that was open last on this device.
 */

import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";

/** Section label and the order of the list. */
const LABELS = {
	appearance: "Appearance",
	messages: "Messages",
	notifications: "Notifications",
	sessions: "Sessions",
	keyboard: "Keyboard",
	devices: "Devices",
	about: "About & maintenance",
} as const;

export type SettingsSection = keyof typeof LABELS;

export const SETTINGS_SECTIONS = Object.keys(LABELS) as readonly SettingsSection[];

export function settingsLabel(section: SettingsSection): string {
	return LABELS[section];
}

export function isSettingsSection(value: unknown): value is SettingsSection {
	return typeof value === "string" && Object.hasOwn(LABELS, value);
}

/** Sections that act on the paired computer (or, for notifications, need it to send them). Sessions works without one: auto-settle is kept on this device. */
const NEEDS_COMPUTER: Record<SettingsSection, boolean> = {
	appearance: false,
	messages: false,
	notifications: true,
	sessions: false,
	keyboard: false,
	devices: true,
	about: false,
};

/** The sections to list: the ones that need the paired computer only while one is paired. */
export function visibleSettingsSections(computer: boolean): readonly SettingsSection[] {
	return SETTINGS_SECTIONS.filter(section => computer || !NEEDS_COMPUTER[section]);
}

const SECTION_KEY = "omp.collab.settings-section";

/** The section left open last on this device, or null. */
export function lastSettingsSection(): SettingsSection | null {
	const stored = readJson(SECTION_KEY);
	return isSettingsSection(stored) ? stored : null;
}

export function rememberSettingsSection(section: SettingsSection): void {
	writeJson(SECTION_KEY, section);
}

/** `section` null: the last one, or the first. `id` changes on every request, so asking for another section while open takes effect. */
export interface SettingsRequest {
	id: number;
	section: SettingsSection | null;
}

let request: SettingsRequest | null = null;
let nextId = 0;
const listeners = new Set<() => void>();

function set(next: SettingsRequest | null): void {
	request = next;
	for (const listener of listeners) listener();
}

export function openSettings(section?: SettingsSection): void {
	set({ id: ++nextId, section: section ?? null });
}

export function closeSettings(): void {
	if (request !== null) set(null);
}

export function settingsOpen(): boolean {
	return request !== null;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The open request, or null while Settings is closed. */
export function useSettingsRequest(): SettingsRequest | null {
	return useSyncExternalStore(subscribe, () => request);
}
