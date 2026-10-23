import type { VmEntry } from "@oh-my-pi/pi-wire/vm";
import { GitBranch, LoaderCircle, Plus, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { freshFolder, type FreshProgress } from "../../lib/fresh-vm";
import { shortenPath } from "../../lib/format";

export interface FreshVmFormProps {
	/** Templates a fresh VM can be cloned from, at least one. */
	templates: readonly VmEntry[];
	/** The chosen template's name. */
	template: string;
	onTemplate(name: string): void;
	/** The chosen repository, `owner/repo`. */
	repo: string;
	onRepo(repo: string): void;
	/** Offer High stakes (the computer supports it). */
	canHighStakes: boolean;
	highStakes: boolean;
	onHighStakes(on: boolean): void;
	worktree: boolean;
	onWorktree(on: boolean): void;
	branch: string;
	onBranch(branch: string): void;
	prompt: string;
	onPrompt(prompt: string): void;
	/** Why no fresh VM can be made now (the limit), or null. */
	disabledReason: string | null;
	onStart(): void;
}

/** The template picked, or the first one when the pick is gone from the list. */
export function chosenTemplate(templates: readonly VmEntry[], name: string): VmEntry | undefined {
	return templates.find(template => template.name === name) ?? templates[0];
}

/**
 * Start in a fresh VM: a throwaway clone of a template runs this one session and is deleted when it ends. The
 * options that make sense in the VM carry over; Sandboxed does not (the VM is the sandbox).
 */
export function FreshVmForm(props: FreshVmFormProps): ReactNode {
	const template = chosenTemplate(props.templates, props.template);
	if (template === undefined) return null;
	const repo = template.repos.includes(props.repo) ? props.repo : (template.repos[0] ?? "");
	const folder = template.home === undefined ? "" : freshFolder(template.home, repo);
	return (
		<div className="sh-start-form">
			<div className="sh-field-hint">
				The session runs in a throwaway copy of {template.name}, with its own GitHub access limited to the
				template's repositories. The copy is deleted when the session ends.
			</div>
			{props.templates.length > 1 && (
				<label className="sh-field">
					<span className="sh-field-label">Template</span>
					<select
						className="sh-input"
						value={template.name}
						onChange={e => props.onTemplate(e.currentTarget.value)}
						aria-label="Template"
					>
						{props.templates.map(entry => (
							<option key={entry.name} value={entry.name}>
								{entry.name}
							</option>
						))}
					</select>
				</label>
			)}
			<label className="sh-field">
				<span className="sh-field-label">Repository</span>
				<select
					className="sh-input"
					value={repo}
					onChange={e => props.onRepo(e.currentTarget.value)}
					aria-label="Repository"
				>
					{template.repos.map(entry => (
						<option key={entry} value={entry}>
							{entry}
						</option>
					))}
				</select>
				<span className="sh-field-hint">Starts in {shortenPath(folder)} inside the VM.</span>
			</label>
			{props.canHighStakes && (
				<label className="sh-start-sandbox">
					<input
						type="checkbox"
						checked={props.highStakes}
						onChange={e => props.onHighStakes(e.currentTarget.checked)}
					/>
					<span className="sh-start-sandbox-text">
						<span className="sh-start-sandbox-title">
							<ShieldAlert size={14} /> High stakes
						</span>
						<span className="sh-field-hint">Pushes and pull requests need a passed quiz.</span>
					</span>
				</label>
			)}
			<label className="sh-start-sandbox">
				<input type="checkbox" checked={props.worktree} onChange={e => props.onWorktree(e.currentTarget.checked)} />
				<span className="sh-start-sandbox-text">
					<span className="sh-start-sandbox-title">
						<GitBranch size={14} /> New git worktree
					</span>
					<span className="sh-field-hint">
						Work on a fresh branch in its own checkout, so the VM's clone stays untouched.
					</span>
				</span>
			</label>
			{props.worktree && (
				<input
					className="sh-input sh-input-mono"
					value={props.branch}
					onChange={e => props.onBranch(e.currentTarget.value)}
					placeholder="Branch name (default: <prefix><date>-<id>)"
					aria-label="Worktree branch name"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			)}
			<label className="sh-start-prompt">
				<span className="sh-field-label">First prompt (optional)</span>
				<textarea
					className="sh-input sh-start-prompt-input"
					value={props.prompt}
					onChange={e => props.onPrompt(e.currentTarget.value)}
					placeholder="Sent as soon as the session is up"
					rows={3}
					spellCheck={false}
				/>
			</label>
			{props.disabledReason !== null && (
				<div className="sh-connect-error" role="alert">
					{props.disabledReason}
				</div>
			)}
			<div className="sh-start-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary sh-start-new"
					disabled={props.disabledReason !== null || repo === ""}
					onClick={props.onStart}
				>
					<Plus size={16} /> New session
				</button>
			</div>
		</div>
	);
}

/** A fresh VM on its way: what it is doing now, and a way out that deletes the half-made VM. */
export function FreshVmProgress({
	progress,
	template,
	onCancel,
}: {
	progress: FreshProgress;
	template: string;
	onCancel(): void;
}): ReactNode {
	return (
		<div className="sh-start-progress" role="status">
			<LoaderCircle size={22} className="sh-spin" />
			<div className="sh-start-progress-title">Starting a fresh VM from {template}…</div>
			<div className="sh-field-hint">{progress.message}</div>
			<div className="sh-field-hint">A copy takes about a minute. Cancel deletes the half-made VM.</div>
			<button type="button" className="sh-btn" onClick={onCancel}>
				Cancel
			</button>
		</div>
	);
}
