/**
 * Installed-app plumbing: service worker registration and Web Share Target intake.
 */

import { extractLink } from "./rooms";

/**
 * Register `sw.js` next to `index.html`, relative so the build works under any
 * path prefix (e.g. GitHub Pages project sites). Production builds only: the Bun
 * dev server neither emits `sw.js` nor wants a cache in front of HMR.
 */
export function registerServiceWorker(): void {
	if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
	navigator.serviceWorker.register("./sw.js").catch(err => {
		console.warn("collab: service worker registration failed", err);
	});
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
