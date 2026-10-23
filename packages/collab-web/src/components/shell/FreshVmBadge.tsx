import type { ReactNode } from "react";

/** Marks a computer that is a fresh VM: it is deleted when its session ends, and leaves the app then. */
export function FreshVmBadge(): ReactNode {
	return (
		<span className="sh-group-state" title="A throwaway VM: deleted when its session ends">
			fresh VM
		</span>
	);
}
