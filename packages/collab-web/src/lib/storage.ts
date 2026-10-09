/**
 * Best-effort localStorage access. Private mode and quota errors degrade to
 * "nothing stored": every caller treats persistence as a convenience.
 */

export function readJson(key: string): unknown {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

/** `null` removes the key. */
export function writeJson(key: string, value: unknown): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// storage unavailable (private mode, quota)
	}
}
