import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { type FixTarget, parseFixRoute } from "../../lib/fix-route";
import { subscribeRoute } from "../../lib/notify-route";
import { FixItSheet } from "./FixItSheet";
import { Sheet } from "./Sheet";

export interface FixItHostProps {
	/** The paired computer; null while this device is not paired. */
	client: CompanionClient | null;
	/** The computer's connection is up and has answered with its capabilities. */
	live: boolean;
	/** The companion answers `ci-log`; older ones do not. */
	canFixIt: boolean;
	canStart: boolean;
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
}

/**
 * Opens the Fix-it flow for a `fix:<owner/repo>/<number>` route: a failed-checks notification tap
 * (also on a cold launch) or the GitHub sheet's *Fix it* button. Mounted once, outside the session,
 * so the flow works from the connect screen and can switch sessions.
 */
export function FixItHost({ client, live, canFixIt, canStart, onOpenHost, onOpenLink }: FixItHostProps): ReactNode {
	const [target, setTarget] = useState<FixTarget | null>(null);
	useEffect(
		() =>
			subscribeRoute(route => {
				const next = parseFixRoute(route);
				if (next !== null) setTarget(next);
			}),
		[],
	);
	if (target === null) return null;
	const close = (): void => setTarget(null);
	if (client !== null && live && canFixIt) {
		return (
			<FixItSheet
				client={client}
				target={target}
				canStart={canStart}
				onOpenHost={onOpenHost}
				onOpenLink={onOpenLink}
				onClose={close}
			/>
		);
	}
	let message = "Connecting to your computer…";
	if (client === null) message = "Pair this device with your computer to fix failing checks from here.";
	else if (live) message = "The companion on your computer is too old for this. Restart it to update.";
	return (
		<Sheet label="fix failing checks" onClose={close}>
			<div className="sh-sheet-head">
				<span className="sh-sheet-title">
					Fix it · {target.repo}#{target.number}
				</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={close} aria-label="close" title="close">
					<X size={15} />
				</button>
			</div>
			<div className="sh-companion-empty">{message}</div>
		</Sheet>
	);
}
