/**
 * Installed-app plumbing: service worker registration, update detection, and Web Share Target intake.
 */

import { useSyncExternalStore } from "react";
import { extractLink } from "./rooms";

/** Foregrounding checks for a new deploy at most this often. */
const UPDATE_CHECK_MS = 60_000;

let updateReady = false;
const updateListeners = new Set<() => void>();

/**
 * Register `sw.js` next to `index.html`, relative so the build works under any
 * path prefix (e.g. GitHub Pages project sites). Production builds only: the Bun
 * dev server neither emits `sw.js` nor wants a cache in front of HMR.
 *
 * Browsers look for a new `sw.js` only on navigation, and an installed app resumed
 * from the background never navigates, so the app also checks whenever it is
 * foregrounded. The new worker takes over at once (`skipWaiting` + `clients.claim`),
 * but this page still runs the old bundle: {@link useUpdateReady} turns true so the
 * app can offer a reload.
 */
export function registerServiceWorker(): void {
	if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
	// The first install also claims the page; only a replaced worker is an update.
	const hadController = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!hadController || updateReady) return;
		updateReady = true;
		for (const listener of updateListeners) listener();
	});
	navigator.serviceWorker.register("./sw.js").then(
		registration => {
			let lastCheck = Date.now();
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState !== "visible" || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
				lastCheck = Date.now();
				registration.update().catch(() => {
					// Offline or the host is unreachable: the next foreground retries.
				});
			});
		},
		err => {
			console.warn("collab: service worker registration failed", err);
		},
	);
}

/** True once a newer deploy controls this page; reloading runs it. */
export function useUpdateReady(): boolean {
	return useSyncExternalStore(
		listener => {
			updateListeners.add(listener);
			return () => {
				updateListeners.delete(listener);
			};
		},
		() => updateReady,
	);
}

/**
 * A collab link delivered through the manifest's `share_target` (Android share
 * sheet → "omp collab"). The browser opens `./?title=…&text=…&url=…`. The query is
 * stripped afterwards so a reload does not re-join from a stale share.
 */
export function takeSharedLink(): string | null {
	const params = new URLSearchParams(window.location.search);
	if (!params.has("text") && !params.has("url") && !params.has("title")) return null;
	const link = extractLink([params.get("url"), params.get("text"), params.get("title")].filter(Boolean).join(" "));
	history.replaceState(null, "", window.location.pathname + window.location.hash);
	return link;
}
