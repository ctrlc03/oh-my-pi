import { Brain, LoaderCircle, Play, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { ComputerHandle } from "../../lib/computers";
import { entryState, openCount, personalHostOf } from "../../lib/personal";
import { openPersonalSettings } from "../../lib/personal-ui";
import { usePersonal } from "../../lib/use-personal";
import { StatusDot } from "../personal/StatusDot";
import "./personal-entry.css";

export interface PersonalSlotProps {
	/** The computer whose group this is in. */
	computer: ComputerHandle;
	/** Several computers are paired: the other computers' groups say where Personal lives. */
	grouped: boolean;
	currentSessionId: string | null;
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Personal in a computer's group of the sessions list. On the home computer it is the pinned entry above the sessions:
 * the one Personal thread with its run state and a badge for what waits on the owner, or the state with a Start button
 * while no session is up. On another computer (several paired) a line says where Personal lives and opens it. Without a
 * Personal agent it renders nothing, so the list is as it was.
 */
export function PersonalSlot({ computer, grouped, currentSessionId, onOpenHost }: PersonalSlotProps): ReactNode {
	const personal = usePersonal();
	const { home } = personal;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (home.computer === null) return null;
	const remembered = home.status === null && home.offline;
	if (!remembered && home.status?.enabled !== true) return null;
	const homeHost = personalHostOf(home.computer.snap.hosts);

	const openThread = (): void => {
		if (homeHost === null) return;
		setBusy(true);
		setError(null);
		onOpenHost(home.computer!.id, homeHost.instanceId)
			.catch((err: unknown) => setError(errorText(err)))
			.finally(() => setBusy(false));
	};

	if (home.computer.id !== computer.id) {
		if (!grouped || homeHost === null || home.offline) return null;
		return (
			<div className="pa-entry-away">
				<Brain size={13} aria-hidden="true" />
				<span className="pa-entry-away-text">Personal lives on {home.computer.name}.</span>
				<button type="button" className="sh-btn pa-entry-away-open" onClick={openThread} disabled={busy}>
					Open Personal
				</button>
				{error !== null && <div className="sh-connect-error">{error}</div>}
			</div>
		);
	}

	const state = entryState(
		home.status,
		home.offline,
		homeHost,
		computer.snap.canStart && home.status?.login.state !== "missing",
	);
	const open = openCount(home.status);
	const current = homeHost !== null && homeHost.sessionId === currentSessionId;
	const start = (): void => {
		setBusy(true);
		setError(null);
		personal
			.call({ t: "personal-control", action: "start" })
			.then(reply => personal.adopt(computer.id, reply.status))
			.catch((err: unknown) => setError(errorText(err)))
			.finally(() => setBusy(false));
	};

	return (
		<>
			<ul className="sh-recents-list pa-entry-list">
				<li className="sh-recent pa-entry" data-tone={state.tone}>
					<button
						type="button"
						className="sh-recent-join"
						onClick={state.thread ? openThread : () => openPersonalSettings("agent")}
						disabled={busy || current}
						aria-current={current || undefined}
						aria-label={`Personal, ${state.label}${open > 0 ? `, ${open} waiting` : ""}`}
					>
						<span className="sh-recent-title">
							<Brain size={14} aria-hidden="true" />
							<span className="sh-recent-name">Personal</span>
							{current && <span className="sh-chip">here</span>}
							{busy && <LoaderCircle size={13} className="sh-spin" aria-hidden="true" />}
							{open > 0 && <span className="sh-inbox-badge pa-entry-badge">{open}</span>}
						</span>
						<span className="sh-recent-meta">
							<StatusDot tone={state.tone} />
							<span className="pa-entry-state">{state.label}</span>
							{home.computer.name !== "" && grouped && (
								<span className="sh-recent-cwd">{home.computer.name}</span>
							)}
						</span>
					</button>
					{state.startable && (
						<button type="button" className="sh-btn pa-entry-start" onClick={start} disabled={busy}>
							<Play size={13} aria-hidden="true" /> Start
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => openPersonalSettings(open > 0 ? "activity" : "agent")}
						aria-label="Open Personal settings"
						title="Personal settings"
					>
						<SlidersHorizontal size={15} />
					</button>
				</li>
			</ul>
			{error !== null && <div className="sh-connect-error">{error}</div>}
		</>
	);
}
