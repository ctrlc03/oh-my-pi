import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type {
	CompanionClient,
	GitFlowSettings,
	GitFlowSettingsReply,
	GitSettingsOptions,
	SettleCleanupResult,
	WorktreeSetupStatus,
} from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import "./review.css";

const CLEANUP_MODES: { mode: GitFlowSettings["cleanup"]["mode"]; label: string }[] = [
	{ mode: "off", label: "Never" },
	{ mode: "merged", label: "After merge" },
	{ mode: "inactive", label: "When unused" },
];

/** The computer's git worktree settings: where and how new ones are made, and when old ones go. */
export function WorktreeSettings({
	client,
	computerName,
}: {
	client: CompanionClient;
	/** The computer's name, given when several are paired so the text can say which one; undefined: "the computer". */
	computerName?: string;
}): ReactNode {
	const load = useCallback(() => client.gitSettings(), [client]);
	const { state, reload } = useRequest(load);
	return (
		<>
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
			{state.status === "ready" && <WorktreeForm client={client} saved={state.value} computerName={computerName} />}
		</>
	);
}

function WorktreeForm({
	client,
	saved,
	computerName,
}: {
	client: CompanionClient;
	saved: GitFlowSettingsReply;
	computerName: string | undefined;
}): ReactNode {
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
					aria-label="Branch name prefix"
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
					aria-label="Worktree folder"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<span className="sh-field-hint">
					Absolute path on {computerName ?? "the computer"}; empty keeps the default. Now: {current.worktreesDir}.
					Worktrees made earlier stay where they are.
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
					aria-label="Worktree setup script"
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
				<ScriptApproval
					key={project.root}
					project={project}
					kind="setup"
					busy={busy}
					onTrust={hash => void request({ trust: { root: project.root, hash } })}
				/>
			))}
			{current.settleCleanup !== undefined && (
				<>
					<label className="sh-field">
						<span className="sh-field-label">When a worktree session settles, run</span>
						<textarea
							className="sh-input sh-input-mono sh-review-textarea"
							rows={2}
							value={draft.settleScript ?? ""}
							onChange={e => set({ settleScript: e.currentTarget.value })}
							placeholder="cargo clean"
							aria-label="Worktree settle command"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
						<span className="sh-field-hint">
							Empty: nothing runs. Runs in the session's worktree, never in the main checkout or a plain folder,
							each time the session settles from any device or an auto-settle rule, even while a dev server still
							runs there. It never delays the settle and stops after 5 minutes. A worktree a sandboxed session
							worked in is skipped. A repository's own <code>.omp/worktree-settle</code> runs instead of this
							only after you approve it here.
						</span>
					</label>
					{current.settleCleanup.projects.map(project => (
						<ScriptApproval
							key={project.root}
							project={project}
							kind="settle"
							busy={busy}
							onTrust={hash => void request({ trust: { root: project.root, hash, kind: "settle" } })}
						/>
					))}
					{current.settleCleanup.results.length > 0 && (
						<div className="sh-field" role="group" aria-label="Worktree cleanup results">
							<span className="sh-field-label">Latest cleanup per worktree</span>
							{current.settleCleanup.results.map(result => (
								<SettleResultRow key={result.path} result={result} />
							))}
						</div>
					)}
				</>
			)}
			<div className="sh-field">
				<span className="sh-field-label">Remove worktrees</span>
				<div className="sh-segmented" role="radiogroup" aria-label="Worktree cleanup">
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
							aria-label="Days unused"
						/>
						days
					</label>
				)}
				<span className="sh-field-hint">
					{draft.cleanup.mode === "off"
						? `${computerName ?? "The computer"} keeps every worktree until you remove it.`
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
					aria-label="Commit text model"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<span className="sh-field-hint">
					A model id or role (<code>@smol</code>, the cheap one, by default){" "}
					{computerName ? `${computerName}'s` : "the computer's"} omp uses to write the text offered before
					committing and opening a pull request.
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

const SCRIPT_KINDS = {
	setup: {
		label: "Repository setup script",
		aria: "Setup script of",
		ran: "Approved: it runs in each new worktree of this repository.",
		gone: "The repository no longer has a setup script.",
		unapproved:
			"It is code from the repository and was not run. Read it, then approve it to run in new worktrees of this repository.",
	},
	settle: {
		label: "Repository settle script",
		aria: "Settle script of",
		ran: "Approved: it runs in a worktree of this repository when its session settles.",
		gone: "The repository no longer has a settle script.",
		unapproved:
			"It is code from the repository and was not run. Read it, then approve it to run when a worktree session of this repository settles.",
	},
} as const;

/** A repository's own script, shown for review: it runs only once the user approved exactly this content. */
function ScriptApproval({
	project,
	kind,
	busy,
	onTrust,
}: {
	project: WorktreeSetupStatus;
	kind: keyof typeof SCRIPT_KINDS;
	busy: boolean;
	onTrust: (hash: string | null) => void;
}): ReactNode {
	const text = SCRIPT_KINDS[kind];
	return (
		<div className="sh-field" role="group" aria-label={`${text.aria} ${project.root}`}>
			<span className="sh-field-label">
				{text.label} · {project.root}
			</span>
			{project.script !== null && (
				<pre className="sh-review-cmd sh-review-script" tabIndex={0}>
					{project.script}
				</pre>
			)}
			<span className="sh-field-hint">
				{project.trusted
					? text.ran
					: project.script === null
						? text.gone
						: project.approved
							? "Changed since you approved it, so it does not run. Read it again before approving."
							: text.unapproved}
			</span>
			<div className="sh-review-confirm-actions">
				{project.approved && (
					<button type="button" className="sh-btn" disabled={busy} onClick={() => onTrust(null)}>
						Withdraw approval
					</button>
				)}
				{!project.trusted && project.hash !== null && (
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						disabled={busy}
						onClick={() => onTrust(project.hash)}
					>
						Approve this script
					</button>
				)}
			</div>
		</div>
	);
}

function duration(ms: number): string {
	if (ms < 1_000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
	return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

/** The latest settle cleanup in one worktree: how it ended, when, and the end of its output. */
function SettleResultRow({ result }: { result: SettleCleanupResult }): ReactNode {
	const outcome =
		result.status === "ok"
			? "Done"
			: result.status === "timeout"
				? "Timed out"
				: result.status === "skipped"
					? "Skipped"
					: result.code === null
						? "Failed"
						: `Failed (exit ${result.code})`;
	return (
		<div className="sh-settle-result" role="group" aria-label={`Cleanup of ${result.path}`}>
			<div className="sh-settle-head">
				<span className={`sh-settle-status sh-settle-${result.status}`}>{outcome}</span>
				<span className="sh-settle-name">{result.branch || result.path}</span>
			</div>
			<span className="sh-field-hint">
				{result.path} · {new Date(result.startedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
				{result.status === "skipped" ? "" : ` · ${duration(result.durationMs)}`}
				{result.source === "project" ? " · .omp/worktree-settle" : ""}
			</span>
			{result.output !== "" && (
				<pre className="sh-review-cmd sh-review-script" tabIndex={0}>
					{result.output}
				</pre>
			)}
		</div>
	);
}
