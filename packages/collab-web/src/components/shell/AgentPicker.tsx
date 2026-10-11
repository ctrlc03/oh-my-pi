import { Bot, RefreshCw, Settings2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	agentReadiness,
	agentSetupHint,
	agentStatusLabel,
	FULL_ACCESS_WARNING,
	PERMISSION_HINT,
	PERMISSION_LABEL,
	PERMISSIONS,
} from "../../lib/agents";
import type { CompanionAgent, ForeignPermission } from "../../lib/companion";
import type { RequestState } from "../../lib/use-request";
import { OmpMark } from "./OmpMark";
import "./agents.css";
import "./stats.css";

export interface AgentPickerProps {
	agents: RequestState<CompanionAgent[]>;
	/** Id of the chosen agent; null: omp. */
	agent: string | null;
	/** Vendor model id; empty: the agent's default. */
	model: string;
	permission: ForeignPermission;
	onAgent(id: string | null): void;
	onModel(model: string): void;
	onPermission(permission: ForeignPermission): void;
	onRetry(): void;
	/** Open the agents screen to install or sign in. */
	onManage(): void;
}

/** The agent a new session runs: omp or a vendor agent, with its model and how it answers permission requests. */
export function AgentPicker({
	agents,
	agent,
	model,
	permission,
	onAgent,
	onModel,
	onPermission,
	onRetry,
	onManage,
}: AgentPickerProps): ReactNode {
	const list = agents.status === "ready" ? agents.value : [];
	const chosen = agent === null ? null : (list.find(entry => entry.id === agent) ?? null);
	/** An agent that cannot start yet, tapped to read what it needs. */
	const [unready, setUnready] = useState<CompanionAgent | null>(null);
	const hint = unready === null ? null : agentSetupHint(unready);
	const models = chosen?.models ?? [];

	return (
		<div className="sh-field">
			<div className="sh-field-label" id="sh-agent-label">
				Agent
			</div>
			<div className="sh-agent-pick" role="radiogroup" aria-labelledby="sh-agent-label">
				<button
					type="button"
					role="radio"
					aria-checked={agent === null}
					className="sh-agent-opt"
					onClick={() => {
						setUnready(null);
						onAgent(null);
					}}
				>
					<span className="sh-agent-opt-name">
						<OmpMark size={14} /> <span>omp</span>
					</span>
					<span className="sh-agent-opt-status">Default</span>
				</button>
				{list.map(entry => {
					const ready = agentReadiness(entry) === "ready";
					return (
						<button
							key={entry.id}
							type="button"
							role="radio"
							aria-checked={agent === entry.id}
							aria-disabled={!ready || undefined}
							className="sh-agent-opt"
							onClick={() => {
								if (ready) {
									setUnready(null);
									onAgent(entry.id);
								} else setUnready(entry);
							}}
						>
							<span className="sh-agent-opt-name">
								<Bot size={14} /> <span>{entry.name}</span>
							</span>
							<span className="sh-agent-opt-status">{agentStatusLabel(entry)}</span>
						</button>
					);
				})}
			</div>
			{agents.status === "loading" && <div className="sh-field-hint">Checking which agents are installed…</div>}
			{agents.status === "error" && (
				<div className="sh-agent-notice" role="alert">
					<span>{agents.message}</span>
					<button type="button" className="sh-btn" onClick={onRetry}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{hint !== null && (
				<div className="sh-agent-notice" role="status">
					<span>{hint}</span>
					<button type="button" className="sh-btn" onClick={onManage}>
						<Settings2 size={14} /> Open agents
					</button>
				</div>
			)}
			{chosen !== null && (
				<>
					{models.length > 0 ? (
						<label className="sh-field">
							<span className="sh-field-label">Model</span>
							<select className="sh-input" value={model} onChange={e => onModel(e.currentTarget.value)}>
								<option value="">Agent default</option>
								{models.map(entry => (
									<option key={entry.id} value={entry.id}>
										{entry.name}
									</option>
								))}
							</select>
						</label>
					) : (
						<div className="sh-field-hint">Uses {chosen.name}'s default model.</div>
					)}
					<div className="sh-agent-perm">
						<div className="sh-field-label" id="sh-agent-perm-label">
							Permissions
						</div>
						<div
							className="sh-segmented sh-segmented-fill"
							role="radiogroup"
							aria-labelledby="sh-agent-perm-label"
						>
							{PERMISSIONS.map(choice => (
								<button
									key={choice}
									type="button"
									role="radio"
									aria-checked={permission === choice}
									className={permission === choice ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => onPermission(choice)}
								>
									{PERMISSION_LABEL[choice]}
								</button>
							))}
						</div>
						{permission === "full" ? (
							<div className="sh-agent-warn" role="note">
								<TriangleAlert size={15} />
								<span>{FULL_ACCESS_WARNING}</span>
							</div>
						) : (
							<div className="sh-field-hint">{PERMISSION_HINT[permission]}</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
