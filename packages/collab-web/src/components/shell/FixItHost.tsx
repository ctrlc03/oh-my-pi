import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { computerById, type ComputerHandle } from "../../lib/computers";
import { type FixTarget, parseFixRoute } from "../../lib/fix-route";
import { subscribeRoute } from "../../lib/notify-route";
import { FixItSheet } from "./FixItSheet";
import { Sheet } from "./Sheet";

export interface FixItHostProps {
	/** Every paired computer; the flow runs on the one the route names. */
	computers: readonly ComputerHandle[];
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
}

interface Target extends FixTarget {
	/** The computer the notification came from; null when the route did not say (the first that can run the flow is used). */
	computerId: string | null;
}

/**
 * Opens the Fix-it flow for a `fix:<owner/repo>/<number>` route: a failed-checks notification tap
 * (also on a cold launch) or the GitHub sheet's *Fix it* button. Mounted once, outside the session,
 * so the flow works from the connect screen and can switch sessions. The repository's checks are read
 * on the computer the route names (a notification comes from one computer, the GitHub sheet from the
 * one that hosts the session).
 */
export function FixItHost({ computers, onOpenHost, onOpenLink }: FixItHostProps): ReactNode {
	const [target, setTarget] = useState<Target | null>(null);
	useEffect(
		() =>
			subscribeRoute((route, computerId) => {
				const next = parseFixRoute(route);
				if (next !== null) setTarget({ ...next, computerId });
			}),
		[],
	);
	if (target === null) return null;
	const close = (): void => setTarget(null);
	const named = computerById(computers, target.computerId);
	const computer =
		named ?? computers.find(candidate => candidate.snap.phase === "live" && candidate.snap.canFixIt) ?? computers[0];
	const client = computer?.client ?? null;
	const live = computer?.snap.phase === "live";
	if (computer !== undefined && client !== null && live && computer.snap.canFixIt) {
		return (
			<FixItSheet
				client={client}
				target={target}
				canStart={computer.snap.canStart}
				onOpenHost={instanceId => onOpenHost(computer.id, instanceId)}
				onOpenLink={onOpenLink}
				onClose={close}
			/>
		);
	}
	const where = computers.length > 1 && computer !== undefined ? computer.name : "your computer";
	let message = `Connecting to ${where}…`;
	if (computer === undefined) message = "Pair this device with your computer to fix failing checks from here.";
	else if (live) message = `The companion on ${where} is too old for this. Restart it to update.`;
	return (
		<Sheet label="fix failing checks" onClose={close}>
			<div className="sh-sheet-head">
				<span className="sh-sheet-title">
					Fix it · {target.repo}#{target.number}
				</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={close} aria-label="Close" title="Close">
					<X size={15} />
				</button>
			</div>
			<div className="sh-companion-empty">{message}</div>
		</Sheet>
	);
}
