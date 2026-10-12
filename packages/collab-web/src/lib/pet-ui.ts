/** Whether the pet sheet is open: a store so the palette, the connect screen and the pet itself can open it. */

import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
	if (next === open) return;
	open = next;
	for (const listener of listeners) listener();
}

export function openPetSheet(): void {
	set(true);
}

export function closePetSheet(): void {
	set(false);
}

export function usePetSheetOpen(): boolean {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => open,
	);
}
