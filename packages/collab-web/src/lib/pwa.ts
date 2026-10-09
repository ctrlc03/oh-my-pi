/**
 * Installed-app plumbing: service worker registration, update detection, and Web Share Target intake.
 */

import { useSyncExternalStore } from "react";
import { extractLink } from "./rooms";

/** Foregrounding checks for a new deploy at most this often. */
const UPDATE_CHECK_MS = 60_000;
/** Reload waits at most this long for the new worker before reloading anyway (navigations are network-first). */
const APPLY_WAIT_MS = 5_000;
/** The content-hashed entry bundle in a built `index.html`. */
const ENTRY_RE = /<script[^>]*type="module"[^>]*src="\.\/([^"]+\.js)"/;

let updateReady = false;
const updateListeners = new Set<() => void>();

function markUpdateReady(): void {
	if (updateReady) return;
	updateReady = true;
	for (const listener of updateListeners) listener();
}

/** This page's build: the content hash of its entry bundle (`t8m0dphc`), or `dev` outside production builds. */
export const APP_BUILD: string =
	document
		.querySelector<HTMLScriptElement>('script[type="module"][src]')
		?.getAttribute("src")
		?.match(/([^/]+)\.js$/)?.[1] ?? "dev";

/** True when the deployed `index.html` loads another entry bundle than this page. `no-store` passes the service worker. */
async function deployedDiffers(): Promise<boolean> {
	const res = await fetch("./", { cache: "no-store" });
	if (!res.ok) return false;
	const entry = ENTRY_RE.exec(await res.text())?.[1];
	return entry !== undefined && entry !== `${APP_BUILD}.js`;
}

/**
 * Register `sw.js` next to `index.html`, relative so the build works under any
 * path prefix (e.g. GitHub Pages project sites). Production builds only: the Bun
 * dev server neither emits `sw.js` nor wants a cache in front of HMR.
 *
 * Browsers look for a new `sw.js` only on navigation, and an installed app resumed
 * from the background never navigates, so the app also checks whenever it is
 * foregrounded: it asks for a worker update and compares its own entry bundle with
 * the deployed `index.html`, so a worker that fails to update cannot hide a deploy.
 * Either signal makes {@link useUpdateReady} true and the app offers a reload.
 */
export function registerServiceWorker(): void {
	if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
	// The first install also claims the page; only a replaced worker is an update.
	const hadController = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (hadController) markUpdateReady();
	});
	navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(
		registration => {
			let lastCheck = Date.now();
			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState !== "visible" || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
				lastCheck = Date.now();
				const update = registration.update();
				deployedDiffers().then(
					differs => {
						if (differs) markUpdateReady();
					},
					() => {
						// Offline or the host is unreachable: the next foreground retries.
					},
				);
				update.catch(() => {
					// Same: retried on the next foreground.
				});
			});
		},
		err => {
			console.warn("collab: service worker registration failed", err);
		},
	);
}

/** Reload into the newest deploy: let a pending worker take over first, so the reload is not served the old shell. */
export async function applyUpdate(): Promise<void> {
	const registration = await navigator.serviceWorker?.getRegistration();
	if (registration) {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, APPLY_WAIT_MS);
		navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
		await registration.update().catch(() => {
			// Unreachable: the network-first reload still tries the network.
		});
		if (registration.installing || registration.waiting) await promise;
		clearTimeout(timer);
	}
	window.location.reload();
}

/** True once a newer deploy is available; reloading runs it. */
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
