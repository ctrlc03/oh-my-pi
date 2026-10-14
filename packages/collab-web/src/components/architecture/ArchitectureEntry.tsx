import { Boxes } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type ComputerHandle, unavailableReason } from "../../lib/computers";
import { LazyArchitectureSheet } from "./LazyArchitectureSheet";

/**
 * The start screen's button for architecture maps: every repository's maps on every computer that makes them,
 * and a map can be made for any recent folder. Absent while no computer can make maps.
 */
export function ArchitectureEntry({
	computers,
	onOpenHost,
}: {
	computers: readonly ComputerHandle[];
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const available = computers.some(computer => unavailableReason(computer, "blueprint") === null);
	// A sheet already open stays when the last computer drops: it lists why.
	if (!available && !open) return null;
	return (
		<>
			<button type="button" className="sh-btn sh-card-action" onClick={() => setOpen(true)}>
				<Boxes size={15} /> Architecture
			</button>
			{open && (
				<LazyArchitectureSheet
					computers={computers}
					computerId={null}
					cwd={null}
					instanceId={null}
					start={{ view: "home" }}
					onOpenHost={onOpenHost}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
