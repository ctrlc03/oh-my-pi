/**
 * Focus mode: a view of the open session without the chrome around it (sessions sidebar, top-bar buttons, pet, task
 * and cache strips, suggestion chips, informational banners). It is a per-device choice kept under
 * {@link FOCUS_MODE_KEY}, so a reload keeps it, and it only ever changes what is drawn: notifications, badges and other
 * sessions behave as before. It applies to an open session; the home screen always shows its normal UI and a session
 * opened later finds the choice as it was left.
 */
import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "./storage";
import { isTypingTarget } from "./shortcuts";

export const FOCUS_MODE_KEY = "omp.collab.focus-mode";

/** Whatever was stored, as the choice: only a literal `true` turns it on, so a stale or hand-edited value never does. */
export function parseFocusMode(raw: unknown): boolean {
	return raw === true;
}

/**
 * The elements that own Esc while they are open: a sheet, the ended-session card, a menu or a list of choices. A sheet
 * placed in the main area is a `region`, not a dialog, so it does not count: Esc leaves it open anyway.
 */
export const ESCAPE_OWNERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Whether Esc, which nothing else on the page claimed, leaves focus mode: not while the keys go into a text field, the
 * editor or a terminal (they are all fields or editable content), where Esc means something to that widget, and not
 * while a sheet or menu is open, which closes itself on it.
 */
export function escapeLeavesFocus(target: object | null, ownerOpen: boolean): boolean {
	return !ownerOpen && !isTypingTarget(target);
}

let current = parseFocusMode(readJson(FOCUS_MODE_KEY));
const listeners = new Set<() => void>();

export function setFocusMode(on: boolean): void {
	if (on === current) return;
	current = on;
	writeJson(FOCUS_MODE_KEY, on ? true : null);
	for (const listener of listeners) listener();
}

export function toggleFocusMode(): void {
	setFocusMode(!current);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function currentFocusMode(): boolean {
	return current;
}

/** Whether focus mode is on, re-rendering when it changes. */
export function useFocusMode(): boolean {
	return useSyncExternalStore(subscribe, currentFocusMode, () => false);
}
