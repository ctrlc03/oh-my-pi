import type {
	AgentProgress,
	AgentSnapshot,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens, relTime } from "../../lib/format";
import { readJson, writeJson } from "../../lib/storage";
import "./agents.css";

/** Re-render tick so running-tool durations and relative times stay live. */
function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs]);
	return now;
}

/**
 * Best-effort start timestamp for the in-flight tool. The host serializes the
 * full AgentProgress (which carries `currentToolStartMs`); the wire mirror
 * omits it, so read it tolerantly and fall back to the last tool's end time.
 */
function toolStartMs(p: AgentProgress): number | null {
	const start = (p as { currentToolStartMs?: unknown }).currentToolStartMs;
	if (typeof start === "number") return start;
	const lastEnd = p.recentTools[0]?.endMs;
	return typeof lastEnd === "number" ? lastEnd : null;
}

function activityLine(
	agent: AgentSnapshot,
	p: AgentProgress | undefined,
	lc: SubagentLifecyclePayload | undefined,
	now: number,
): string {
	if (p?.currentTool) {
		const start = toolStartMs(p);
		if (start !== null) return `${p.currentTool} · ${fmtDuration(Math.max(0, now - start))}`;
		return p.currentTool;
	}
	if (p?.lastIntent) return p.lastIntent;
	if (lc) return lc.status;
	return agent.status;
}

/** Parked (released, resumable on demand) and aborted subagents: folded away under *Inactive*. */
export function isInactive(agent: AgentSnapshot): boolean {
	return agent.status === "parked" || agent.status === "aborted";
}

const AgentRow = memo(function AgentRow(props: {
	agent: AgentSnapshot;
	payload: SubagentProgressPayload | undefined;
	lifecycle: SubagentLifecyclePayload | undefined;
	selected: boolean;
	now: number;
	onSelect(id: string | null): void;
}): ReactNode {
	const { agent, payload, lifecycle, selected, now, onSelect } = props;
	const p = payload?.progress;
	return (
		<button
			type="button"
			className={selected ? "ag-row ag-row--selected" : "ag-row"}
			onClick={() => onSelect(selected ? null : agent.id)}
		>
			<span className="ag-row-head">
				<span className={`ag-dot ag-dot--${agent.status}`} />
				<span className="ag-row-name">{agent.displayName}</span>
				<span className="ag-chip">{agent.kind}</span>
			</span>
			<span className="ag-row-activity">
				<span className="ag-row-activity-text">{activityLine(agent, p, lifecycle, now)}</span>
				<span className="ag-row-when">{relTime(agent.lastActivity)}</span>
			</span>
			{p ? (
				<span className="ag-row-meta">
					<span>{fmtTokens(p.tokens)} tok</span>
					<span>{fmtCost(p.cost)}</span>
				</span>
			) : null}
		</button>
	);
});

/** Per session: ids of inactive subagents this device cleared from the rail. */
const CLEARED_KEY_PREFIX = "omp.collab.clearedAgents.";

function loadCleared(sessionId: string | null): Record<string, true> {
	const stored = sessionId === null ? null : readJson(CLEARED_KEY_PREFIX + sessionId);
	const cleared: Record<string, true> = {};
	if (Array.isArray(stored)) for (const id of stored) if (typeof id === "string") cleared[id] = true;
	return cleared;
}

/**
 * Memoized: the client replaces `progress`/`lifecycle` only when they change. Mount it keyed by
 * `sessionId`: the cleared list is read once per session.
 */
export const AgentsPanel = memo(function AgentsPanel(props: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	selectedId: string | null;
	onSelect(id: string | null): void;
	/** Session the cleared list is saved under; null keeps it in memory only. */
	sessionId: string | null;
}): ReactNode {
	const { agents, progress, lifecycle, selectedId, onSelect, sessionId } = props;
	const now = useNow(1000);
	const [showInactive, setShowInactive] = useState(false);
	// Cleared only hides an agent while it stays inactive: a revived one shows again.
	const [cleared, setCleared] = useState(() => loadCleared(sessionId));

	const sorted = useMemo(() => {
		const mains: AgentSnapshot[] = [];
		const active: AgentSnapshot[] = [];
		const inactive: AgentSnapshot[] = [];
		let hidden = 0;
		for (const agent of agents) {
			if (agent.kind === "main") mains.push(agent);
			else if (!isInactive(agent)) active.push(agent);
			else if (cleared[agent.id]) hidden++;
			else inactive.push(agent);
		}
		const newest = (a: AgentSnapshot, b: AgentSnapshot): number => b.lastActivity - a.lastActivity;
		active.sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			return ar !== br ? ar - br : newest(a, b);
		});
		inactive.sort(newest);
		return { mains, active, inactive, hidden };
	}, [agents, cleared]);

	const save = (next: Record<string, true>): void => {
		setCleared(next);
		if (sessionId === null) return;
		const ids = Object.keys(next);
		writeJson(CLEARED_KEY_PREFIX + sessionId, ids.length > 0 ? ids : null);
	};
	const clearInactive = (): void => {
		// Keep only ids the host still lists, so the stored list stays bounded by the session's agents.
		const next: Record<string, true> = {};
		for (const agent of agents) if (cleared[agent.id] || isInactive(agent)) next[agent.id] = true;
		setShowInactive(false);
		save(next);
	};

	const row = (agent: AgentSnapshot): ReactNode => (
		<AgentRow
			key={agent.id}
			agent={agent}
			payload={progress.get(agent.id)}
			lifecycle={lifecycle.get(agent.id)}
			selected={selectedId === agent.id}
			now={now}
			onSelect={onSelect}
		/>
	);
	// The selected agent stays visible even when its group is folded.
	const inactiveShown = showInactive ? sorted.inactive : sorted.inactive.filter(agent => agent.id === selectedId);

	return (
		<div className="ag-panel">
			<div className="ag-heading">Session</div>
			{sorted.mains.map(row)}
			<div className="ag-heading">
				Subagents
				{sorted.active.length > 0 && <span className="ag-heading-count">{sorted.active.length}</span>}
			</div>
			{sorted.active.map(row)}
			{sorted.active.length === 0 && <div className="ag-empty">None running</div>}
			{(sorted.inactive.length > 0 || sorted.hidden > 0) && (
				<div className="ag-fold-row">
					{sorted.inactive.length > 0 ? (
						<button
							type="button"
							className="ag-fold"
							onClick={() => setShowInactive(open => !open)}
							aria-expanded={showInactive}
						>
							<ChevronRight
								size={13}
								className={showInactive ? "ag-fold-chev ag-fold-chev--open" : "ag-fold-chev"}
							/>
							Inactive
							<span className="ag-heading-count">{sorted.inactive.length}</span>
						</button>
					) : (
						<span className="ag-fold ag-fold--static">Inactive</span>
					)}
					{sorted.inactive.length > 0 && (
						<button
							type="button"
							className="ag-fold-action"
							onClick={clearInactive}
							title="Hide parked and aborted subagents on this device"
						>
							Clear
						</button>
					)}
					{sorted.hidden > 0 && (
						<button
							type="button"
							className="ag-fold-action"
							onClick={() => save({})}
							title="Show cleared subagents again"
						>
							{sorted.hidden} cleared · Show
						</button>
					)}
				</div>
			)}
			{inactiveShown.map(row)}
		</div>
	);
});
