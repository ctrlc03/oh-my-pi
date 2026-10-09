import { BellRing, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { CompanionHost } from "../../lib/companion";
import { hostTitle } from "./CompanionCard";

export interface SessionAlertProps {
	hosts: readonly CompanionHost[];
	/** Session on screen; its own prompts show in the composer instead. */
	currentSessionId: string | null;
	onOpen(instanceId: string): Promise<void>;
}

/**
 * "Other session needs input" notice. Raised when a host on the paired
 * computer is seen to start waiting on a prompt: hosts already waiting (or
 * not yet listed) when this view opened stay with the switcher badge.
 * Cleared once the host stops waiting.
 */
export function SessionAlert({ hosts, currentSessionId, onOpen }: SessionAlertProps): ReactNode {
	const seenRef = useRef<Record<string, boolean> | null>(null);
	/** Raised instanceIds, oldest first. */
	const [raised, setRaised] = useState<string[]>([]);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const before = seenRef.current;
		const now: Record<string, boolean> = {};
		for (const host of hosts) now[host.instanceId] = host.inputRequired;
		seenRef.current = now;
		setRaised(list => {
			const kept = list.filter(id => now[id]);
			if (before === null) return kept;
			for (const host of hosts) {
				if (host.inputRequired && before[host.instanceId] === false && host.sessionId !== currentSessionId) {
					kept.push(host.instanceId);
				}
			}
			return kept.length === list.length && kept.every((id, i) => id === list[i]) ? list : kept;
		});
	}, [hosts, currentSessionId]);

	const latest = raised.at(-1);
	const host = latest === undefined ? undefined : hosts.find(h => h.instanceId === latest);
	if (!host) return null;

	const open = (): void => {
		setOpening(true);
		setError(null);
		onOpen(host.instanceId).catch((err: unknown) => {
			setError(err instanceof Error ? err.message : String(err));
			setOpening(false);
		});
	};

	return (
		<div className="sh-alert" role="status">
			<button type="button" className="sh-alert-open" onClick={open} disabled={opening}>
				{opening ? <LoaderCircle size={15} className="sh-spin" /> : <BellRing size={15} />}
				<span className="sh-alert-text">
					<strong>{hostTitle(host)}</strong> {error ?? "needs input"}
					{raised.length > 1 && <span className="sh-alert-more"> +{raised.length - 1}</span>}
				</span>
			</button>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				onClick={() => setRaised(list => list.filter(id => id !== host.instanceId))}
				aria-label="dismiss"
			>
				<X size={14} />
			</button>
		</div>
	);
}
