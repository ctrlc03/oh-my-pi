import { BellRing, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import { hostKey } from "../../lib/inbox";
import { hostTitle } from "./CompanionCard";

export interface SessionAlertProps {
	computers: readonly ComputerHandle[];
	/** Session on screen; its own prompts show in the composer instead. */
	currentSessionId: string | null;
	onOpen(computerId: string, instanceId: string): Promise<void>;
}

/**
 * "Other session needs input" notice. Raised when a host on any paired
 * computer is seen to start waiting on a prompt: hosts already waiting (or
 * not yet listed) when this view opened stay with the switcher badge.
 * Cleared once the host stops waiting. With several computers the notice
 * names the one the session runs on.
 */
export function SessionAlert({ computers, currentSessionId, onOpen }: SessionAlertProps): ReactNode {
	const seenRef = useRef<Record<string, boolean> | null>(null);
	/** Raised sessions (`computer|instance`, see `hostKey`), oldest first. */
	const [raised, setRaised] = useState<string[]>([]);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const before = seenRef.current;
		const now: Record<string, boolean> = {};
		for (const computer of computers) {
			for (const host of computer.snap.hosts) now[hostKey(computer.id, host.instanceId)] = host.inputRequired;
		}
		seenRef.current = now;
		setRaised(list => {
			const kept = list.filter(key => now[key]);
			if (before === null) return kept;
			for (const computer of computers) {
				for (const host of computer.snap.hosts) {
					const key = hostKey(computer.id, host.instanceId);
					if (host.inputRequired && before[key] === false && host.sessionId !== currentSessionId) kept.push(key);
				}
			}
			return kept.length === list.length && kept.every((key, i) => key === list[i]) ? list : kept;
		});
	}, [computers, currentSessionId]);

	const latest = raised.at(-1);
	let found: { computer: ComputerHandle; instanceId: string; title: string } | null = null;
	if (latest !== undefined) {
		for (const computer of computers) {
			const host = computer.snap.hosts.find(row => hostKey(computer.id, row.instanceId) === latest);
			if (host !== undefined) found = { computer, instanceId: host.instanceId, title: hostTitle(host) };
		}
	}
	if (found === null) return null;
	const { computer, instanceId, title } = found;

	const open = (): void => {
		setOpening(true);
		setError(null);
		onOpen(computer.id, instanceId).catch((err: unknown) => {
			setError(err instanceof Error ? err.message : String(err));
			setOpening(false);
		});
	};

	return (
		<div className="sh-alert" role="status">
			<button type="button" className="sh-alert-open" onClick={open} disabled={opening}>
				{opening ? <LoaderCircle size={15} className="sh-spin" /> : <BellRing size={15} />}
				<span className="sh-alert-text">
					<strong>{title}</strong>
					{computers.length > 1 && <span className="sh-alert-where"> on {computer.name}</span>}{" "}
					{error ?? "needs input"}
					{raised.length > 1 && <span className="sh-alert-more"> +{raised.length - 1}</span>}
				</span>
			</button>
			<button
				type="button"
				className="sh-btn sh-btn-icon"
				onClick={() => setRaised(list => list.filter(key => key !== latest))}
				aria-label="Dismiss"
			>
				<X size={14} />
			</button>
		</div>
	);
}
