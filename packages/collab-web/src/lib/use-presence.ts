import { useCallback, useEffect, useRef } from "react";
import type { CompanionClient } from "./companion";
import type { ComputerHandle } from "./computers";
import type { PushControls } from "./push";

/**
 * Each companion holds its pushes for this device while it shows the app, and needs this device's subscription
 * endpoint with that computer to know which device is meant. Re-told when the page's visibility changes, and to
 * a computer's new connection (the one it had told is gone).
 */
export function usePresence(computers: readonly ComputerHandle[], pushes: PushControls): void {
	/** What each connection was last told: `<endpoint>|<visible>`. */
	const told = useRef(new WeakMap<CompanionClient, string>());
	const latest = useRef({ computers, pushes });
	latest.current = { computers, pushes };

	const report = useCallback((): void => {
		const visible = document.visibilityState === "visible";
		for (const computer of latest.current.computers) {
			if (computer.client === null) continue;
			const endpoint = latest.current.pushes.of(computer.id).endpoint;
			const state = `${endpoint ?? ""}|${visible}`;
			if (told.current.get(computer.client) === state) continue;
			told.current.set(computer.client, state);
			computer.client.setPresence(endpoint, visible);
		}
	}, []);

	// Every render: it only sends what changed since the last one.
	useEffect(report);
	useEffect(() => {
		document.addEventListener("visibilitychange", report);
		return () => document.removeEventListener("visibilitychange", report);
	}, [report]);
}
