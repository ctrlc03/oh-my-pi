/**
 * A page that outlives its build. Bundles are content-hashed, so once the host serves another build (a deploy to
 * Pages, a companion that rebuilt after a restart, an updated `omp` binary) the lazy chunks this page was built
 * against may be gone: its `import()` rejects with a bare fetch error. {@link importChunk} is the one way the app
 * loads a lazy chunk: it retries once, then says the app was updated and lets {@link UpdateBar} offer the reload.
 * The reload is the user's: a draft in the composer must not be lost to an automatic one.
 */
import { useSyncExternalStore } from "react";

/** What the user sees in place of the browser's own error text. */
export const STALE_BUILD_MESSAGE = "The app was updated. Reload to continue.";

/**
 * The messages browsers give a dynamic `import()` that could not be fetched: Chromium "Failed to fetch dynamically
 * imported module: <url>", WebKit "Importing a module script failed.", Gecko "error loading dynamically imported
 * module". These are the only chunk loads the app makes through `import()`; the bundler emits no stylesheet loader.
 */
const CHUNK_FAILURE_RE =
	/failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i;

/** Whether `error` is a browser's failure to fetch a lazy chunk (not an error thrown by the chunk's own code). */
export function isChunkLoadError(error: unknown): boolean {
	return error instanceof Error && CHUNK_FAILURE_RE.test(error.message);
}

/** A lazy chunk that is still missing after a retry: the page is older than the build the host serves. */
export class StaleBuildError extends Error {
	constructor(options?: ErrorOptions) {
		super(STALE_BUILD_MESSAGE, options);
		this.name = "StaleBuildError";
	}
}

export function isStaleBuildError(error: unknown): boolean {
	return error instanceof StaleBuildError;
}

/**
 * `.catch` handler for a chunk load nobody awaits: the update bar already says what happened, so a
 * {@link StaleBuildError} ends here; any other error is rethrown.
 */
export function ignoreStaleBuild(error: unknown): void {
	if (!isStaleBuildError(error)) throw error;
}

let stale = false;
const listeners = new Set<() => void>();

function markStale(): void {
	if (stale) return;
	stale = true;
	for (const listener of listeners) listener();
}

/**
 * Run a dynamic `import()`. A chunk fetch failure is retried once; if it fails again the page is marked stale
 * ({@link useStaleBuild}) and the rejection is a {@link StaleBuildError} whose message is the notice. Other errors,
 * and any failure while the browser is offline (the chunk may well exist), pass through untouched.
 *
 * Never cache the returned promise past a rejection: a later call runs `load` again.
 */
export async function importChunk<T>(load: () => Promise<T>): Promise<T> {
	try {
		return await load();
	} catch (first) {
		if (!isChunkLoadError(first)) throw first;
		try {
			return await load();
		} catch (second) {
			if (!isChunkLoadError(second) || navigator.onLine === false) throw second;
			markStale();
			throw new StaleBuildError({ cause: second });
		}
	}
}

/** True once a lazy chunk of this page could not be loaded because the build it came from is gone. */
export function useStaleBuild(): boolean {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => stale,
	);
}
