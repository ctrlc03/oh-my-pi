import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, GitFlowSettings, GitFlowSettingsReply, GitSettingsOptions } from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import "./review.css";

const CLEANUP_MODES: { mode: GitFlowSettings["cleanup"]["mode"]; label: string }[] = [
	{ mode: "off", label: "Never" },
	{ mode: "merged", label: "After merge" },
	{ mode: "inactive", label: "When unused" },
];

/** The computer's git worktree settings: where and how new ones are made, and when old ones go. */
export function WorktreeSettings({ client }: { client: CompanionClient }): ReactNode {
	const load = useCallback(() => client.gitSettings(), [client]);
	const { state, reload } = useRequest(load);
	return (
		<section className="sh-stats-section" aria-label="worktree settings">
			<h2 className="sh-recents-title">Git worktrees</h2>
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
				</div>
			)}
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{state.status === "ready" && <WorktreeForm client={client} saved={state.value} />}
		</section>
	);
}

function WorktreeForm({ client, saved }: { client: CompanionClient; saved: GitFlowSettingsReply }): ReactNode {
	const [current, setCurrent] = useState(saved);
	const [draft, setDraft] = useState(saved.settings);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const dirty = JSON.stringify(draft) !== JSON.stringify(current.settings);

	const set = (patch: Partial<GitFlowSettings>): void => {
		setDraft({ ...draft, ...patch });
		setNotice(null);
	};

	const request = async (options: GitSettingsOptions): Promise<void> => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const reply = await client.gitSettings(options);
			setCurrent(reply);
			if (!options.trust) setDraft(reply.settings);
			if (options.sweep) {
				const removed = reply.swept?.length ?? 0;
				setNotice(
					removed === 0 ? "Nothing to clean up." : `Removed ${removed} worktree${removed === 1 ? "" : "s"}.`,
				);
			} else
				setNotice(options.trust ? (options.trust.hash === null ? "Approval withdrawn." : "Approved.") : "Saved.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="sh-spend">
			<label className="sh-field">
				<span className="sh-field-label">Branch name prefix</span>
				<input
					className="sh-input sh-input-mono"
					value={draft.branchPrefix}
					onChange={e => set({ branchPrefix: e.currentTarget.value })}
					placeholder="omp/"
					aria-label="branch name prefix"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<span className="sh-field-hint">
					New worktree branches are named {draft.branchPrefix || "(no prefix)"}&lt;date&gt;-&lt;id&gt; unless you
					type a name.
				</span>
			</label>
			<label className="sh-field">
				<span className="sh-field-label">Worktree folder</span>
				<input
					className="sh-input sh-input-mono"
					value={draft.worktreesDir ?? ""}
					onChange={e => set({ worktreesDir: e.currentTarget.value.trim() === "" ? null : e.currentTarget.value })}
					placeholder="default"
					aria-label="worktree folder"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<span className="sh-field-hint">
					Absolute path on the computer; empty keeps the default. Now: {current.worktreesDir}. Worktrees made
					earlier stay where they are.
				</span>
			</label>
			<label className="sh-field">
				<span className="sh-field-label">Setup script</span>
				<textarea
					className="sh-input sh-input-mono sh-review-textarea"
					rows={2}
					value={draft.setupScript}
					onChange={e => set({ setupScript: e.currentTarget.value })}
					placeholder="bun install"
					aria-label="worktree setup script"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<span className="sh-field-hint">
					Runs once in each new worktree, with OMP_WORKTREE_PATH, OMP_WORKTREE_BRANCH and OMP_REPO_ROOT set. A
					repository's own <code>.omp/worktree-setup</code> runs instead of this only after you approve it here,
					and never in a sandboxed session. If it fails, the worktree is discarded and the session does not start.
				</span>
			</label>
			{current.projects.map(project => (
				<div key={project.root} className="sh-field" aria-label={`setup script of ${project.root}`}>
					<span className="sh-field-label">Repository setup script · {project.root}</span>
					{project.script !== null && (
						<pre className="sh-review-cmd sh-review-script" tabIndex={0}>
							{project.script}
						</pre>
					)}
					<span className="sh-field-hint">
						{project.trusted
							? "Approved: it runs in each new worktree of this repository."
							: project.script === null
								? "The repository no longer has a setup script."
								: project.approved
									? "Changed since you approved it, so it does not run. Read it again before approving."
									: "It is code from the repository and was not run. Read it, then approve it to run in new worktrees of this repository."}
					</span>
					<div className="sh-review-confirm-actions">
						{project.approved && (
							<button
								type="button"
								className="sh-btn"
								disabled={busy}
								onClick={() => void request({ trust: { root: project.root, hash: null } })}
							>
								Withdraw approval
							</button>
						)}
						{!project.trusted && project.hash !== null && (
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								disabled={busy}
								onClick={() => void request({ trust: { root: project.root, hash: project.hash } })}
							>
								Approve this script
							</button>
						)}
					</div>
				</div>
			))}
			<div className="sh-field">
				<span className="sh-field-label">Remove worktrees</span>
				<div className="sh-segmented" role="radiogroup" aria-label="worktree cleanup">
					{CLEANUP_MODES.map(({ mode, label }) => (
						<button
							key={mode}
							type="button"
							role="radio"
							aria-checked={draft.cleanup.mode === mode}
							className={draft.cleanup.mode === mode ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => set({ cleanup: { ...draft.cleanup, mode } })}
						>
							{label}
						</button>
					))}
				</div>
				{draft.cleanup.mode === "inactive" && (
					<label className="sh-review-draft">
						Unused for
						<input
							className="sh-input"
							type="number"
							min={1}
							max={365}
							step={1}
							value={draft.cleanup.days}
							onChange={e =>
								set({ cleanup: { ...draft.cleanup, days: Math.trunc(Number(e.currentTarget.value)) || 1 } })
							}
							aria-label="days unused"
						/>
						days
					</label>
				)}
				<span className="sh-field-hint">
					{draft.cleanup.mode === "off"
						? "The computer keeps every worktree until you remove it."
						: draft.cleanup.mode === "merged"
							? "Once the branch's pull request is merged."
							: "Once nothing was committed or checked out in it for that long."}{" "}
					Never a worktree with uncommitted changes or one a session is running in; the branch always stays.
					Checked every few minutes.
				</span>
			</div>
			<label className="sh-field">
				<span className="sh-field-label">Commit and pull request text model</span>
				<input
					className="sh-input sh-input-mono"
					value={draft.messageModel}
					onChange={e => set({ messageModel: e.currentTarget.value })}
					placeholder="@smol"
					aria-label="commit text model"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<span className="sh-field-hint">
					A model id or role (<code>@smol</code>, the cheap one, by default) the computer's omp uses to write the
					text offered before committing and opening a pull request.
				</span>
			</label>
			<div className="sh-review-confirm-actions">
				{current.settings.cleanup.mode !== "off" && (
					<button
						type="button"
						className="sh-btn"
						disabled={busy || dirty}
						onClick={() => void request({ sweep: true })}
					>
						Clean up now
					</button>
				)}
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					disabled={busy || !dirty}
					onClick={() => void request({ settings: draft })}
				>
					{busy ? <LoaderCircle size={14} className="sh-spin" /> : null} Save
				</button>
			</div>
			{notice && <div className="sh-field-hint">{notice}</div>}
			{error && <div className="sh-connect-error">{error}</div>}
		</div>
	);
}
