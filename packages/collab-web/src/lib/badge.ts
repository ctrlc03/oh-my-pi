import { useEffect } from "react";

/** The Badging API as far as this app uses it; absent on browsers without it. */
export interface BadgeTarget {
	setAppBadge?(count?: number): Promise<void>;
	clearAppBadge?(): Promise<void>;
}

/** Show `count` on the app icon, or clear it at 0. Unsupported or refused (permission) is silent. */
export function applyBadge(target: BadgeTarget, count: number): void {
	const done = count > 0 ? target.setAppBadge?.(count) : target.clearAppBadge?.();
	done?.catch(() => {});
}

/**
 * Keep the app icon badge at `count`. `null` (the count is unknown, e.g. the computer is not
 * connected) leaves the badge a push set alone. Re-applied when the app comes back to the
 * foreground, so a visible app with nothing waiting never shows a stale number.
 */
export function useAppBadge(count: number | null): void {
	useEffect(() => {
		if (count === null) return;
		const apply = (): void => applyBadge(navigator, count);
		apply();
		document.addEventListener("visibilitychange", apply);
		return () => document.removeEventListener("visibilitychange", apply);
	}, [count]);
}
