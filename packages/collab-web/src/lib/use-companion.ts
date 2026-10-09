import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { CompanionClient, type CompanionSnapshot } from "./companion";

export interface CompanionHandle {
	/** null while unpaired or when the pairing link does not parse (`error`). */
	client: CompanionClient | null;
	snap: CompanionSnapshot;
	error: string | null;
}

const UNPAIRED: CompanionSnapshot = { phase: "offline", machine: null, hosts: [], vapidKey: null, error: null };

/**
 * One companion connection for the whole app: the connect screen, the session
 * switcher, and cross-session alerts all read the same host list.
 */
export function useCompanion(pairing: string | null): CompanionHandle {
	const [client, setClient] = useState<CompanionClient | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setError(null);
		if (pairing === null) {
			setClient(null);
			return;
		}
		let next: CompanionClient;
		try {
			next = new CompanionClient(pairing);
		} catch (err) {
			setClient(null);
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		next.connect();
		setClient(next);
		const wake = (): void => {
			if (document.visibilityState === "visible") next.resume();
		};
		document.addEventListener("visibilitychange", wake);
		window.addEventListener("online", wake);
		return () => {
			document.removeEventListener("visibilitychange", wake);
			window.removeEventListener("online", wake);
			next.close();
		};
	}, [pairing]);

	const subscribe = useCallback((listener: () => void) => client?.subscribe(listener) ?? (() => {}), [client]);
	const getSnapshot = useCallback(() => client?.getSnapshot() ?? UNPAIRED, [client]);
	const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
	return { client, snap, error };
}
