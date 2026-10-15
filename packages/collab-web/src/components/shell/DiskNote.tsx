import type { DiskHealth } from "@oh-my-pi/pi-wire/disk";
import { HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import { fmtGb } from "../../lib/format";
import { openSettings } from "../../lib/settings-ui";
import "./disk.css";

/** Under this much free space the note turns red: the computer is close to stalling. */
const CRITICAL_BYTES = 10e9;

/**
 * Why the computer may stall and its sessions drop offline: a disk it watches is below the limit. Nothing while
 * every disk has room, and nothing from a companion that predates the disk guard.
 */
export function DiskNote({ disk }: { disk: DiskHealth | null }): ReactNode {
	if (disk === null) return null;
	const critical = disk.freeBytes < CRITICAL_BYTES;
	return (
		<div className={critical ? "sh-power sh-power-low sh-disk-note" : "sh-power sh-disk-note"} role="status">
			<HardDrive size={14} />
			<span>
				Low on disk space: {fmtGb(disk.freeBytes)} free, limit {fmtGb(disk.limitBytes)}. A full disk slows sessions
				until they drop offline.
			</span>
			<button type="button" className="sh-btn" onClick={() => openSettings("sessions")}>
				Review
			</button>
		</div>
	);
}
