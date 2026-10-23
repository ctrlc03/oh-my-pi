import { createContext, useEffect, useRef } from "react";
import type { PairingLink } from "./companion";
import type { ComputerHandle, FreshComputer } from "./computers";
import { FRESH_FORGET_POLL_MS, forgettableComputers } from "./fresh-vm";

/** What the start sheet needs of the app to run a session in a fresh VM: pairing with the VM and dropping it again. Absent outside the app. */
export interface ComputerActions {
	/** Pair with the computer `link` names, marking it a fresh VM; its id, null when the link does not parse. */
	pair(link: PairingLink, fresh: FreshComputer): string | null;
	/** Take a computer off this device. */
	remove(id: string): Promise<void>;
	/** The computer's latest state, across every paired computer (a sheet is often given only one). */
	find(id: string): ComputerHandle | undefined;
}

export const ComputerActionsContext = createContext<ComputerActions | null>(null);

/**
 * Forgets the fresh VMs' computers once their VM is gone from the host's list (the session ended, or the VM expired).
 * The hosts are asked once when such a computer appears and then every minute, and only while one exists.
 */
export function useForgetFreshComputers(
	computers: readonly ComputerHandle[],
	remove: (id: string) => Promise<void>,
): void {
	const latest = useRef(computers);
	latest.current = computers;
	const removeRef = useRef(remove);
	removeRef.current = remove;
	const key = computers
		.filter(computer => computer.fresh !== undefined)
		.map(computer => computer.id)
		.join(",");
	useEffect(() => {
		if (key === "") return;
		let stopped = false;
		const check = async (): Promise<void> => {
			const hostIds = new Set<string>();
			for (const computer of latest.current)
				if (computer.fresh !== undefined) hostIds.add(computer.fresh.hostComputerId);
			const lists = new Map<string, readonly { name: string }[]>();
			await Promise.all(
				[...hostIds].map(async id => {
					const host = latest.current.find(computer => computer.id === id);
					const client = host?.client;
					if (!client || host.snap.phase !== "live" || !host.snap.canVms) return;
					try {
						lists.set(id, (await client.vmList()).vms);
					} catch {
						// The host could not be asked: its fresh computers stay until it can.
					}
				}),
			);
			if (stopped) return;
			for (const id of forgettableComputers(latest.current, lists)) await removeRef.current(id).catch(() => {});
		};
		void check();
		const timer = setInterval(() => void check(), FRESH_FORGET_POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [key]);
}
