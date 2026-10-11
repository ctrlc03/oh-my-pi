import {
	Bot,
	Check,
	ChevronLeft,
	Copy,
	Download,
	LoaderCircle,
	Pencil,
	Plus,
	RefreshCw,
	TriangleAlert,
	Trash2,
	X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import {
	type AgentReadiness,
	agentReadiness,
	agentStatusLabel,
	commandLine,
	type CustomAgentDraft,
	customAgentDraft,
	customAgentInput,
	newArgRow,
	newEnvRow,
} from "../../lib/agents";
import type { CompanionAgent, CompanionClient } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";
import "./agents.css";
import "./review.css";

export interface AgentsSheetProps {
	client: CompanionClient;
	onClose(): void;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The agents' status classes: a state the person has to act on is warm, a ready one calm. */
const READINESS_CLASS: Record<AgentReadiness, string> = {
	ready: "sh-agent-state sh-agent-state-ok",
	login: "sh-agent-state sh-agent-state-warn",
	missing: "sh-agent-state",
	error: "sh-agent-state sh-agent-state-err",
};

/**
 * Other vendors' coding agents on the paired computer: what is installed and signed in, installing or updating the
 * adapters the companion manages, the commands to run for the rest, and custom ACP commands.
 */
export function AgentsSheet({ client, onClose }: AgentsSheetProps): ReactNode {
	const load = useCallback(() => client.requestAgents(), [client]);
	const { state } = useRequest(load);
	const [agents, setAgents] = useState<CompanionAgent[] | null>(null);
	useEffect(() => {
		if (state.status === "ready") setAgents(state.value);
	}, [state]);
	/** An id while its install runs, `refresh` while the probes run again, `save` while a custom agent is written. */
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<CustomAgentDraft | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	const act = async (key: string, work: () => Promise<CompanionAgent[]>): Promise<boolean> => {
		setBusy(key);
		setError(null);
		try {
			setAgents(await work());
			return true;
		} catch (err) {
			setError(errorText(err));
			return false;
		} finally {
			setBusy(null);
		}
	};

	const save = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		if (editing === null) return;
		const result = customAgentInput(editing);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		if (await act("save", () => client.saveCustomAgent(result.input))) setEditing(null);
	};

	const loading = state.status === "loading" || busy === "refresh";
	const builtin = agents?.filter(agent => agent.kind === "builtin") ?? [];
	const custom = agents?.filter(agent => agent.kind === "custom") ?? [];

	return (
		<Sheet label="Agents" onClose={onClose}>
			<div className="sh-sheet-head">
				{editing !== null && (
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => {
							setEditing(null);
							setError(null);
						}}
						aria-label="Back to agents"
					>
						<ChevronLeft size={16} />
					</button>
				)}
				<div className="sh-sheet-title">
					{editing === null ? "Agents" : editing.id === undefined ? "Add a custom agent" : "Edit custom agent"}
				</div>
				<span className="sh-agents-head-actions">
					{editing === null && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => void act("refresh", () => client.requestAgents(true))}
							disabled={busy !== null || loading}
							aria-label="Refresh agents"
						>
							{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
						</button>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{error && <div className="sh-connect-error">{error}</div>}
			{editing !== null ? (
				<CustomAgentEditor
					draft={editing}
					saving={busy === "save"}
					onChange={setEditing}
					onSubmit={save}
					onCancel={() => {
						setEditing(null);
						setError(null);
					}}
				/>
			) : agents === null ? (
				state.status === "loading" ? (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Checking agents… this can take a few seconds.
					</div>
				) : state.status === "error" ? (
					<div className="sh-companion-offline">
						<span>{state.message}</span>
					</div>
				) : null
			) : (
				<>
					<div className="sh-field-hint">
						Coding agents your computer can run beside omp. Each runs as its own session on your computer, with
						its own sign-in.
					</div>
					<ul className="sh-agents-list" aria-label="Agents">
						{builtin.map(agent => (
							<AgentRow
								key={agent.id}
								agent={agent}
								busy={busy}
								onInstall={() => void act(agent.id, () => client.installAgent(agent.id))}
							/>
						))}
					</ul>
					<div className="sh-agents-section">
						<h2 className="sh-recents-title">Custom agents</h2>
						<button
							type="button"
							className="sh-btn"
							onClick={() => {
								setEditing(customAgentDraft());
								setError(null);
							}}
							disabled={busy !== null}
						>
							<Plus size={14} /> Add agent
						</button>
					</div>
					{custom.length === 0 ? (
						<div className="sh-companion-empty">
							No custom agents. Add any agent that speaks the Agent Client Protocol (ACP) over stdio.
						</div>
					) : (
						<ul className="sh-agents-list" aria-label="Custom agents">
							{custom.map(agent => (
								<AgentRow
									key={agent.id}
									agent={agent}
									busy={busy}
									deleting={deleting === agent.id}
									onEdit={() => {
										setEditing(customAgentDraft(agent));
										setError(null);
									}}
									onDelete={() => setDeleting(agent.id)}
									onCancelDelete={() => setDeleting(null)}
									onConfirmDelete={() =>
										void act(agent.id, () => client.deleteCustomAgent(agent.id)).then(ok => {
											if (ok) setDeleting(null);
										})
									}
								/>
							))}
						</ul>
					)}
				</>
			)}
		</Sheet>
	);
}

interface AgentRowProps {
	agent: CompanionAgent;
	/** Id of the agent being worked on (any value disables every action). */
	busy: string | null;
	deleting?: boolean;
	onInstall?(): void;
	onEdit?(): void;
	onDelete?(): void;
	onCancelDelete?(): void;
	onConfirmDelete?(): void;
}

function AgentRow({
	agent,
	busy,
	deleting = false,
	onInstall,
	onEdit,
	onDelete,
	onCancelDelete,
	onConfirmDelete,
}: AgentRowProps): ReactNode {
	const readiness = agentReadiness(agent);
	const working = busy === agent.id;
	return (
		<li className="sh-agent">
			<div className="sh-agent-head">
				<span className="sh-recent-title">
					<Bot size={14} />
					<span className="sh-recent-name">{agent.name}</span>
					<span className={READINESS_CLASS[readiness]}>{agentStatusLabel(agent)}</span>
				</span>
				<span className="sh-agent-actions">
					{agent.installable && onInstall !== undefined && (
						<button type="button" className="sh-btn" onClick={onInstall} disabled={busy !== null}>
							{working ? <LoaderCircle size={14} className="sh-spin" /> : <Download size={14} />}{" "}
							{agent.installed ? "Update" : "Install"}
						</button>
					)}
					{onEdit !== undefined && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onEdit}
							disabled={busy !== null}
							aria-label={`Edit ${agent.name}`}
						>
							<Pencil size={15} />
						</button>
					)}
					{onDelete !== undefined && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={onDelete}
							disabled={busy !== null}
							aria-label={`Delete ${agent.name}`}
						>
							<Trash2 size={15} />
						</button>
					)}
				</span>
			</div>
			{agent.error !== undefined && <div className="sh-agent-error">{agent.error}</div>}
			{agent.kind === "custom" && agent.command !== undefined && (
				<code className="sh-agent-argv">{commandLine(agent.command)}</code>
			)}
			{!agent.installed && agent.kind === "builtin" && !agent.installable && agent.installCommand !== null && (
				<CopyCommand label="Install on your computer" command={agent.installCommand} />
			)}
			{agent.installed && agent.auth === "needed" && agent.loginCommand !== null && (
				<CopyCommand label="Sign in on your computer" command={agent.loginCommand} />
			)}
			{deleting && (
				<div className="sh-review-confirm" role="group" aria-label={`Delete ${agent.name}`}>
					<div className="sh-field-hint">
						Removes {agent.name} from this computer. Sessions already started with it keep their transcripts.
					</div>
					<div className="sh-review-confirm-actions">
						<button type="button" className="sh-btn" onClick={onCancelDelete} disabled={working}>
							Cancel
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={onConfirmDelete}
							disabled={busy !== null}
						>
							{working ? <LoaderCircle size={14} className="sh-spin" /> : <Trash2 size={14} />} Delete
						</button>
					</div>
				</div>
			)}
		</li>
	);
}

/** A shell command to run on the computer, with a button that copies it. */
function CopyCommand({ label, command }: { label: string; command: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2_000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="sh-agent-cmd">
			<span className="sh-field-label">{label}</span>
			<span className="sh-agent-cmd-line">
				<code className="sh-agent-argv">{command}</code>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={() => {
						navigator.clipboard.writeText(command).then(
							() => setCopied(true),
							() => setCopied(false),
						);
					}}
					aria-label={`Copy command: ${label.toLowerCase()}`}
				>
					{copied ? <Check size={15} /> : <Copy size={15} />}
				</button>
			</span>
		</div>
	);
}

interface CustomAgentEditorProps {
	draft: CustomAgentDraft;
	saving: boolean;
	onChange(draft: CustomAgentDraft): void;
	onSubmit(e: FormEvent<HTMLFormElement>): void;
	onCancel(): void;
}

/** The command line of an ACP agent as an argv: the program, one input per argument, and environment variables. */
function CustomAgentEditor({ draft, saving, onChange, onSubmit, onCancel }: CustomAgentEditorProps): ReactNode {
	const monoProps = { autoCapitalize: "off", autoCorrect: "off", autoComplete: "off", spellCheck: false } as const;
	const argv = [draft.command, ...draft.args.map(arg => arg.value)].filter(part => part !== "");
	return (
		<form className="sh-agent-edit" onSubmit={onSubmit}>
			<div className="sh-agent-warn" role="note">
				<TriangleAlert size={15} />
				<span>
					Every device paired with this computer can make it run this command, with your user's access. Add only
					programs you trust.
				</span>
			</div>
			<label className="sh-field">
				<span className="sh-field-label">Name</span>
				<input
					className="sh-input"
					value={draft.name}
					onChange={e => onChange({ ...draft, name: e.currentTarget.value })}
					placeholder="My agent"
					maxLength={60}
					autoComplete="off"
					spellCheck={false}
				/>
			</label>
			<label className="sh-field">
				<span className="sh-field-label">Command</span>
				<input
					className="sh-input sh-input-mono"
					value={draft.command}
					onChange={e => onChange({ ...draft, command: e.currentTarget.value })}
					placeholder="/usr/local/bin/my-agent"
					aria-label="Command"
					{...monoProps}
				/>
			</label>
			<fieldset className="sh-agent-kv">
				<legend className="sh-field-label">Arguments</legend>
				{draft.args.map((arg, index) => (
					<div key={arg.id} className="sh-agent-kv-row">
						<input
							className="sh-input sh-input-mono"
							value={arg.value}
							onChange={e =>
								onChange({
									...draft,
									args: draft.args.map(old =>
										old.id === arg.id ? { ...old, value: e.currentTarget.value } : old,
									),
								})
							}
							placeholder={`Argument ${index + 1}`}
							aria-label={`Argument ${index + 1}`}
							{...monoProps}
						/>
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => onChange({ ...draft, args: draft.args.filter(old => old.id !== arg.id) })}
							aria-label={`Remove argument ${index + 1}`}
						>
							<X size={15} />
						</button>
					</div>
				))}
				<button
					type="button"
					className="sh-btn"
					onClick={() => onChange({ ...draft, args: [...draft.args, newArgRow()] })}
				>
					<Plus size={14} /> Add argument
				</button>
				<span className="sh-field-hint">
					One input per argument, passed as they are: no shell runs, so quotes and spaces need no escaping.
				</span>
			</fieldset>
			<fieldset className="sh-agent-kv">
				<legend className="sh-field-label">Environment</legend>
				{draft.env.map((row, index) => (
					<div key={row.id} className="sh-agent-kv-row sh-agent-env-row">
						<input
							className="sh-input sh-input-mono"
							value={row.key}
							onChange={e =>
								onChange({
									...draft,
									env: draft.env.map(old =>
										old.id === row.id ? { ...old, key: e.currentTarget.value } : old,
									),
								})
							}
							placeholder="NAME"
							aria-label={`Variable ${index + 1} name`}
							{...monoProps}
						/>
						<input
							className="sh-input sh-input-mono"
							value={row.value}
							onChange={e =>
								onChange({
									...draft,
									env: draft.env.map(old =>
										old.id === row.id ? { ...old, value: e.currentTarget.value } : old,
									),
								})
							}
							placeholder="value"
							aria-label={`Variable ${index + 1} value`}
							{...monoProps}
						/>
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => onChange({ ...draft, env: draft.env.filter(old => old.id !== row.id) })}
							aria-label={`Remove variable ${index + 1}`}
						>
							<X size={15} />
						</button>
					</div>
				))}
				<button
					type="button"
					className="sh-btn"
					onClick={() => onChange({ ...draft, env: [...draft.env, newEnvRow()] })}
				>
					<Plus size={14} /> Add variable
				</button>
				<span className="sh-field-hint">
					Added to a minimal environment (HOME, PATH and a few more). The computer's own variables are not passed
					on.
				</span>
			</fieldset>
			{argv.length > 0 && (
				<div className="sh-agent-cmd">
					<span className="sh-field-label">Runs</span>
					<code className="sh-agent-argv">{commandLine(argv)}</code>
				</div>
			)}
			<div className="sh-review-confirm-actions">
				<button type="button" className="sh-btn" onClick={onCancel} disabled={saving}>
					Cancel
				</button>
				<button type="submit" className="sh-btn sh-btn-primary" disabled={saving}>
					{saving ? <LoaderCircle size={14} className="sh-spin" /> : <Check size={14} />} Save agent
				</button>
			</div>
		</form>
	);
}

/** The button that opens the agents screen. */
export function AgentsEntry({
	client,
	variant,
}: {
	client: CompanionClient;
	/** `card`: labelled button in the start screen's action row; `icon`: sidebar footer button. */
	variant: "card" | "icon";
}): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className={variant === "card" ? "sh-btn sh-card-action" : "sh-btn sh-btn-icon"}
				onClick={() => setOpen(true)}
				aria-label="Agents"
			>
				<Bot size={15} />
				{variant === "card" && " Agents"}
			</button>
			{open && <AgentsSheet client={client} onClose={() => setOpen(false)} />}
		</>
	);
}
