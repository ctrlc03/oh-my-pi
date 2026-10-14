/**
 * Pairing the app's own window with this computer's companion. The window has storage of its own, so it pairs like
 * any browser: the companion issues a one-time invite (`companion --print-local-link`, which reads the companion's
 * state directory, so only this user can ask) and the app opens it. The invite buys credentials that the window then
 * keeps, so it is asked for once, not on every launch.
 */

/** The page's own record of paired computers (`omp.collab.computers` in the web app's storage). */
export const COMPUTERS_STORAGE_KEY = "omp.collab.computers";

/** Script that reads the record in the page; the result goes to {@link needsPairing}. */
export const READ_COMPUTERS_SCRIPT = `(() => { try { return window.localStorage.getItem(${JSON.stringify(COMPUTERS_STORAGE_KEY)}); } catch { return null; } })()`;

/** The companion's room id from its state file, or null when it cannot be read yet. */
export function roomIdFromState(text: string | null): string | null {
	if (text === null) return null;
	try {
		const raw: unknown = JSON.parse(text);
		const roomId = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).roomId : undefined;
		return typeof roomId === "string" && /^[A-Za-z0-9_-]{8,}$/.test(roomId) ? roomId : null;
	} catch {
		return null;
	}
}

/**
 * Whether the window must be paired with this computer: the stored record holds no computer whose link names the
 * companion's room, with credentials (or an invite on its way to becoming them). Without a room id, any paired
 * computer counts, so a state file that cannot be read never makes the app pair twice.
 */
export function needsPairing(stored: string | null, roomId: string | null): boolean {
	let list: unknown;
	try {
		list = stored === null ? [] : JSON.parse(stored);
	} catch {
		return true;
	}
	if (!Array.isArray(list)) return true;
	return !list.some(entry => {
		if (typeof entry !== "object" || entry === null) return false;
		const { link, device, invite } = entry as Record<string, unknown>;
		if (typeof link !== "string") return false;
		if (roomId !== null && !link.includes(roomId)) return false;
		const hasDevice =
			typeof device === "object" &&
			device !== null &&
			typeof (device as Record<string, unknown>).id === "string" &&
			typeof (device as Record<string, unknown>).token === "string";
		return hasDevice || typeof invite === "string";
	});
}

/**
 * The pairing link in the output of `companion --print-local-link`, if it points at this app (`origin`, with no path):
 * anything else is not navigated to, whatever the process printed.
 */
export function parseLocalLink(output: string, origin: string): string | null {
	for (const token of output.split(/\s+/)) {
		if (!token.includes("#pair:")) continue;
		try {
			const url = new URL(token);
			if (url.origin === origin && url.protocol === "http:") return url.href;
		} catch {
			// not a URL
		}
	}
	return null;
}
