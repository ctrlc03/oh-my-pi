/**
 * The pet's pop-out window: a Document Picture-in-Picture window (desktop Chrome and Edge) that floats above
 * other windows. The app renders the pet into it through a React portal, so state, theme and settings are the
 * page's own; this module opens and closes the window and carries the app's stylesheets over.
 */

import { useSyncExternalStore } from "react";
import { setPetSettings } from "./pet-settings";

/** The window's size in CSS px. */
export const PIP_WIDTH = 180;
export const PIP_HEIGHT = 200;

interface DocumentPictureInPictureApi {
	requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
	readonly window: Window | null;
}

/** The API where the browser has it. Chrome's own typings do not ship it, so the shape is declared here. */
function pictureInPicture(): DocumentPictureInPictureApi | null {
	if (typeof window === "undefined" || !("documentPictureInPicture" in window)) return null;
	const api = window.documentPictureInPicture as DocumentPictureInPictureApi;
	return api;
}

/** The pop-out needs Document Picture-in-Picture; elsewhere its entry points are hidden. */
export function petPipSupported(): boolean {
	return pictureInPicture() !== null;
}

let popped: Window | null = null;
let unloading = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** Copies the page's styles into the pop-out: linked sheets by address (so relative URLs keep working), inline ones by rules. */
function copyStyles(into: Document): void {
	for (const sheet of document.styleSheets) {
		if (sheet.href !== null) {
			const link = into.createElement("link");
			link.rel = "stylesheet";
			link.href = sheet.href;
			into.head.append(link);
			continue;
		}
		try {
			const style = into.createElement("style");
			style.textContent = Array.from(sheet.cssRules, rule => rule.cssText).join("\n");
			into.head.append(style);
		} catch {
			// a sheet whose rules the page may not read has no address either: nothing to carry over
		}
	}
}

/**
 * Opens the pop-out; needs a user gesture (a click), which is why it is never reopened on load. Resolves to
 * null once open, else to why it did not.
 */
export async function openPetPip(): Promise<string | null> {
	const api = pictureInPicture();
	if (api === null) return "This browser cannot pop the pet out.";
	if (popped !== null) return null;
	let pip: Window;
	try {
		api.window?.close();
		pip = await api.requestWindow({ width: PIP_WIDTH, height: PIP_HEIGHT });
	} catch (err) {
		return err instanceof Error && err.name === "NotAllowedError"
			? "The browser needs a click to pop the pet out."
			: "The browser did not open the pet window.";
	}
	copyStyles(pip.document);
	pip.document.title = "omp pet";
	pip.document.documentElement.lang = document.documentElement.lang;
	popped = pip;
	setPetSettings({ popout: true });
	window.addEventListener("pagehide", () => (unloading = true), { once: true });
	pip.addEventListener("pagehide", () => {
		popped = null;
		// Closing the window brings the pet back and forgets the pop-out; reloading the page does not forget it.
		if (!unloading) setPetSettings({ popout: false });
		emit();
	});
	emit();
	return null;
}

/** Closes the pop-out; the pet is in the page again. */
export function closePetPip(): void {
	popped?.close();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** The pop-out's window while it is open. */
export function usePetPipWindow(): Window | null {
	return useSyncExternalStore(
		subscribe,
		() => popped,
		() => null,
	);
}
