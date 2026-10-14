import type { PersonalSource } from "@oh-my-pi/pi-wire/personal";
import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import {
	draftFromSource,
	MIN_SOURCE_MINUTES,
	type SourceDraft,
	sourceFromDraft,
	upsertSource,
	validateDraft,
} from "../../lib/personal-settings";
import { useAction } from "./shared";
import "./agent.css";

function SourceForm({
	draft,
	existing,
	mcpServers,
	busy,
	error,
	onChange,
	onSubmit,
	onCancel,
}: {
	draft: SourceDraft;
	existing: PersonalSource | null;
	mcpServers: readonly string[];
	busy: boolean;
	error: string | null;
	onChange(draft: SourceDraft): void;
	onSubmit(): void;
	onCancel(): void;
}): ReactNode {
	const id = useId();
	const form = useRef<HTMLFormElement>(null);
	// The form opens below the list: focusing its first field brings it into view.
	useEffect(() => {
		form.current?.querySelector("input")?.focus();
	}, []);
	const missing = draft.mcpServer !== "" && !mcpServers.includes(draft.mcpServer);
	const submit = (event: FormEvent): void => {
		event.preventDefault();
		onSubmit();
	};
	return (
		<form
			ref={form}
			className="pa-source-form"
			onSubmit={submit}
			aria-label={existing === null ? "Add a source" : `Edit ${existing.label}`}
		>
			<div className="sh-field">
				<label className="sh-field-label" htmlFor={`${id}-label`}>
					Name
				</label>
				<input
					id={`${id}-label`}
					className="sh-input"
					value={draft.label}
					placeholder="Work email"
					maxLength={80}
					onChange={event => onChange({ ...draft, label: event.currentTarget.value })}
				/>
			</div>
			<div className="sh-field">
				<label className="sh-field-label" htmlFor={`${id}-server`}>
					MCP server
				</label>
				<select
					id={`${id}-server`}
					className="sh-input"
					value={draft.mcpServer}
					onChange={event => onChange({ ...draft, mcpServer: event.currentTarget.value })}
				>
					{missing && <option value={draft.mcpServer}>{draft.mcpServer} (not in mcp.json)</option>}
					{mcpServers.map(name => (
						<option key={name} value={name}>
							{name}
						</option>
					))}
				</select>
			</div>
			<div className="sh-field">
				<label className="sh-field-label" htmlFor={`${id}-every`}>
					Check every (minutes)
				</label>
				<input
					id={`${id}-every`}
					type="number"
					className="sh-input pa-input-short"
					inputMode="numeric"
					min={MIN_SOURCE_MINUTES}
					step={1}
					value={draft.everyMinutes}
					onChange={event => onChange({ ...draft, everyMinutes: event.currentTarget.value })}
				/>
				<div className="sh-field-hint">At least {MIN_SOURCE_MINUTES} minutes.</div>
			</div>
			<div className="sh-field">
				<label className="sh-field-label" htmlFor={`${id}-prompt`}>
					What to check and report, in your words
				</label>
				<textarea
					id={`${id}-prompt`}
					className="sh-input pa-textarea"
					rows={4}
					value={draft.prompt}
					placeholder="Any unread mail from my landlord"
					onChange={event => onChange({ ...draft, prompt: event.currentTarget.value })}
				/>
			</div>
			<label className="pa-check">
				<input
					type="checkbox"
					checked={draft.enabled}
					onChange={event => onChange({ ...draft, enabled: event.currentTarget.checked })}
				/>
				<span>Check it on schedule</span>
			</label>
			{error !== null && (
				<div className="sh-connect-error" role="alert">
					{error}
				</div>
			)}
			<div className="pa-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={busy}>
					{busy && <LoaderCircle size={14} className="sh-spin" />}{" "}
					{existing === null ? "Add source" : "Save source"}
				</button>
				<button type="button" className="sh-btn" disabled={busy} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

/**
 * The inboxes and calendars the agent checks on a schedule. Every change sends the whole list (the companion replaces it),
 * so each add, edit, switch and removal is saved on its own: there is no group Save button.
 */
export function SourcesEditor({
	sources,
	mcpServers,
	machine,
	onSave,
}: {
	sources: readonly PersonalSource[];
	mcpServers: readonly string[];
	machine: string;
	onSave(sources: PersonalSource[]): Promise<void>;
}): ReactNode {
	const [draft, setDraft] = useState<SourceDraft | null>(null);
	const [invalid, setInvalid] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const action = useAction();
	const editingId = draft?.id ?? null;
	const existing = editingId === null ? null : (sources.find(source => source.id === editingId) ?? null);

	const open = (source: PersonalSource | null): void => {
		setDraft(draftFromSource(source, mcpServers));
		setInvalid(null);
		setRemoving(null);
		action.clear();
	};

	const submit = (): void => {
		if (draft === null) return;
		const problem = validateDraft(draft, mcpServers);
		setInvalid(problem);
		if (problem !== null) return;
		void action
			.run(() => onSave(upsertSource(sources, sourceFromDraft(draft, existing))))
			.then(ok => {
				if (ok) setDraft(null);
			});
	};

	return (
		<div className="pa-sources">
			<div className="sh-field-hint">
				Each check runs a short headless Personal turn; what it brings back is treated as outside content (not
				trusted as instructions). Personal never polls anything you have not added.
			</div>
			{sources.length === 0 && draft === null && <div className="sh-companion-empty">No sources yet.</div>}
			{sources.length > 0 && (
				<ul className="pa-source-list">
					{sources.map(source => (
						<li key={source.id} className="pa-source">
							<div className="pa-source-head">
								<div className="pa-source-main">
									<div className="pa-source-title">{source.label}</div>
									<div className="sh-field-hint">
										<code>{source.mcpServer}</code> · every {source.everyMinutes} minutes ·{" "}
										{source.lastPollAt === undefined
											? "not checked yet"
											: `checked ${relTime(source.lastPollAt)}`}
									</div>
								</div>
								<label className="pa-check">
									<input
										type="checkbox"
										checked={source.enabled}
										disabled={action.busy}
										aria-label={`Check ${source.label} on schedule`}
										onChange={event => {
											const enabled = event.currentTarget.checked;
											void action.run(() =>
												onSave(sources.map(item => (item.id === source.id ? { ...item, enabled } : item))),
											);
										}}
									/>
									<span>{source.enabled ? "On" : "Off"}</span>
								</label>
							</div>
							{source.lastError !== undefined && <div className="pa-note pa-note-err">{source.lastError}</div>}
							{removing === source.id ? (
								<div className="pa-confirm" role="group" aria-label={`Confirm removing ${source.label}`}>
									<p className="pa-note-text">
										{source.label} stops being checked. What it already brought back stays in memory.
									</p>
									<div className="pa-actions">
										<button
											type="button"
											className="sh-btn sh-btn-stop"
											disabled={action.busy}
											onClick={() => {
												void action
													.run(() => onSave(sources.filter(item => item.id !== source.id)))
													.then(ok => {
														if (ok) setRemoving(null);
													});
											}}
										>
											Remove
										</button>
										<button
											type="button"
											className="sh-btn"
											disabled={action.busy}
											onClick={() => setRemoving(null)}
										>
											Keep
										</button>
									</div>
								</div>
							) : (
								<div className="pa-actions">
									<button
										type="button"
										className="sh-btn"
										aria-label={`Edit ${source.label}`}
										onClick={() => open(source)}
									>
										<Pencil size={14} /> Edit
									</button>
									<button
										type="button"
										className="sh-btn"
										aria-label={`Remove ${source.label}`}
										onClick={() => {
											setRemoving(source.id);
											setDraft(null);
										}}
									>
										<Trash2 size={14} /> Remove
									</button>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
			{draft !== null && (
				<SourceForm
					draft={draft}
					existing={existing}
					mcpServers={mcpServers}
					busy={action.busy}
					error={invalid ?? action.error}
					onChange={next => {
						setDraft(next);
						setInvalid(null);
					}}
					onSubmit={submit}
					onCancel={() => setDraft(null)}
				/>
			)}
			{draft === null && action.error !== null && <div className="sh-connect-error">{action.error}</div>}
			{draft === null &&
				(mcpServers.length === 0 ? (
					<div className="pa-note">
						Add an MCP server (email, calendar) to the profile's <code>mcp.json</code> on {machine} first;
						Personal never polls anything you have not added.
					</div>
				) : (
					<div className="pa-actions">
						<button type="button" className="sh-btn" onClick={() => open(null)}>
							<Plus size={14} /> Add a source
						</button>
					</div>
				))}
		</div>
	);
}
