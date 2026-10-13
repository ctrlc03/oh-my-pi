import { Boxes } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { LazyArchitectureSheet } from "./LazyArchitectureSheet";

/** The start screen's button for architecture maps: every repository's maps, and a map can be made for any recent folder. */
export function ArchitectureEntry({
	client,
	onOpenHost,
}: {
	client: CompanionClient;
	onOpenHost(instanceId: string): Promise<void>;
}): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="sh-btn sh-card-action" onClick={() => setOpen(true)}>
				<Boxes size={15} /> Architecture
			</button>
			{open && (
				<LazyArchitectureSheet
					client={client}
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
