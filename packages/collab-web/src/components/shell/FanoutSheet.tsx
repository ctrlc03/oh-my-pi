import {
	Check,
	CircleCheck,
	CircleX,
	ExternalLink,
	GitCompareArrows,
	LoaderCircle,
	RefreshCw,
	Trophy,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompanionClient, CompanionHost } from "../../lib/companion";
import {
	type FanoutCompare,
	type FanoutGroup,
	type FanoutKeepResult,
	type FanoutModel,
	type FanoutRunView,
	type FanoutStatus,
	type HostFanout,
	MAX_FANOUT_BUDGET_USD,
	MAX_FANOUT_MODELS,
	MIN_FANOUT_MODELS,
	setPendingReview,
	splitBudget,
	takePendingReview,
} from "../../lib/fanout";
import { fmtCost } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "./Sheet";
import "./fanout.css";

/** Where a composer fan-out runs: the paired computer's repository of the session on screen. */
export interface FanoutTarget {
	client: CompanionClient;
	/** The session's working directory: the worktrees branch from its repository's HEAD. */
	cwd: string;
	canSandbox: boolean;
	/** Join a started session; rejects with a readable message. */
	onOpen(instanceId: string): Promise<void>;
}

const POLL_MS = 6_000;
const MAX_LISTED_MODELS = 60;

const STATUS_LABEL: Record<FanoutStatus, string> = {
	working: "working",
	"needs-input": "needs input",
	idle: "idle",
	offline: "offline",
	ended: "ended",
	failed: "failed to start",
};

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Total budget typed by the user; null for an empty field, NaN for something unusable. */
function parseBudget(text: string): number | null {
	const trimmed = text.trim().replace(/^\$/, "");
	return trimmed === "" ? null : Number(trimmed);
}

export interface FanoutPickerProps {
	client: CompanionClient;
	cwd: string;
	prompt: string;
	/** Offer the sandbox toggle; ignored when `sandboxed` is decided by the caller. */
	canSandbox: boolean;
	/** The caller already decided whether the sessions run sandboxed (the start sheet's own toggle). */
	sandboxed?: boolean;
	/** The group started; every session that could start is hosting. */
	onStarted(group: FanoutGroup): void;
}

/** Pick 2–4 models (and an optional total budget), then start the prompt on each in its own worktree. */
export function FanoutPicker({
	client,
	cwd,
	prompt,
	canSandbox,
	sandboxed: decided,
	onStarted,
}: FanoutPickerProps): ReactNode {
	const load = useCallback(() => client.requestFanoutModels(), [client]);
	const { state, reload } = useRequest(load);
	const [picked, setPicked] = useState<string[]>([]);
	const [filter, setFilter] = useState("");
	const [budget, setBudget] = useState("");
	const [chosenSandbox, setChosenSandbox] = useState(false);
	const sandboxed = decided ?? chosenSandbox;
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const shown = useMemo<FanoutModel[]>(() => {
		if (state.status !== "ready") return [];
		const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
		return state.value
			.filter(model => {
				const text = `${model.selector} ${model.name}`.toLowerCase();
				return words.every(word => text.includes(word));
			})
			.slice(0, MAX_LISTED_MODELS);
	}, [state, filter]);

	const toggle = (selector: string): void =>
		setPicked(prev =>
			prev.includes(selector)
				? prev.filter(entry => entry !== selector)
				: prev.length < MAX_FANOUT_MODELS
					? [...prev, selector]
					: prev,
		);

	const total = parseBudget(budget);
	const budgetValid = total === null || (Number.isFinite(total) && total > 0 && total <= MAX_FANOUT_BUDGET_USD);
	const each = total !== null && budgetValid && picked.length > 0 ? splitBudget(total, picked.length) : null;
	const ready =
		prompt.trim() !== "" && picked.length >= MIN_FANOUT_MODELS && budgetValid && (each === null || each >= 0.01);

	const start = async (): Promise<void> => {
		setStarting(true);
		setError(null);
		try {
			onStarted(
				await client.startFanout({
					cwd,
					prompt,
					models: picked,
					budgetUsd: total ?? undefined,
					sandboxed: sandboxed || undefined,
				}),
			);
		} catch (err) {
			setError(errorText(err));
			setStarting(false);
		}
	};

	if (starting) {
		return (
			<div className="sh-start-progress" role="status">
				<LoaderCircle size={22} className="sh-spin" />
				<div className="sh-start-progress-title">
					Starting {picked.length} sessions in {picked.length} worktrees…
				</div>
				<div className="sh-field-hint">
					Each omp boots with the prompt on its own model. This can take up to two minutes.
				</div>
			</div>
		);
	}
	return (
		<div className="sh-fan-picker">
			{error && <div className="sh-connect-error">{error}</div>}
			<div className="sh-field-label">
				Models ({picked.length} of {MIN_FANOUT_MODELS}–{MAX_FANOUT_MODELS})
			</div>
			{picked.length > 0 && (
				<ul className="sh-fan-picked" aria-label="chosen models">
					{picked.map(selector => (
						<li key={selector}>
							<button
								type="button"
								className="sh-chip sh-fan-chip"
								onClick={() => toggle(selector)}
								aria-label={`remove ${selector}`}
							>
								{selector} <X size={11} />
							</button>
						</li>
					))}
				</ul>
			)}
			<input
				className="sh-input sh-input-mono"
				value={filter}
				onChange={e => setFilter(e.currentTarget.value)}
				placeholder="filter models"
				aria-label="filter models"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
			/>
			{state.status === "loading" ? (
				<div className="sh-companion-empty">Loading models…</div>
			) : state.status === "error" ? (
				<div className="sh-companion-offline">
					<span>{state.message}</span>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			) : shown.length === 0 ? (
				<div className="sh-companion-empty">No model matches.</div>
			) : (
				<ul className="sh-fan-models" aria-label="models">
					{shown.map(model => {
						const on = picked.includes(model.selector);
						return (
							<li key={model.selector}>
								<button
									type="button"
									className={on ? "sh-model sh-model-on" : "sh-model"}
									onClick={() => toggle(model.selector)}
									disabled={!on && picked.length >= MAX_FANOUT_MODELS}
									aria-pressed={on}
								>
									<span className="sh-fan-model-name">{model.name}</span>
									<span className="sh-sheet-faint">
										{model.provider}
										{on && <Check size={13} />}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			)}
			<label className="sh-fan-budget">
				<span className="sh-field-label">Total budget in USD (optional)</span>
				<input
					className="sh-input"
					value={budget}
					onChange={e => setBudget(e.currentTarget.value)}
					inputMode="decimal"
					placeholder="no limit"
					aria-label="total budget in USD"
					aria-invalid={!budgetValid || undefined}
				/>
				<span className="sh-field-hint">
					{each !== null
						? `Each session stops at a safe point after ${fmtCost(each)} (omp --max-cost).`
						: "Split evenly: each session gets its share as a spend limit."}
				</span>
			</label>
			{canSandbox && (
				<label className="sh-start-sandbox">
					<input type="checkbox" checked={sandboxed} onChange={e => setChosenSandbox(e.currentTarget.checked)} />
					<span className="sh-start-sandbox-text">
						<span className="sh-start-sandbox-title">Sandboxed</span>
						<span className="sh-field-hint">Reads and edits files only; no commands run.</span>
					</span>
				</label>
			)}
			<button
				type="button"
				className="sh-btn sh-btn-primary sh-start-new"
				onClick={() => void start()}
				disabled={!ready}
			>
				<GitCompareArrows size={16} /> Start {picked.length >= MIN_FANOUT_MODELS ? picked.length : "N"} sessions
			</button>
			{prompt.trim() === "" && (
				<div className="sh-field-hint">Write the prompt first: every session gets the same one.</div>
			)}
			<div className="sh-field-hint">
				Each session works on a new branch in its own git worktree made from the repository's current commit.
				Uncommitted changes in the folder are not carried over.
			</div>
		</div>
	);
}

export interface FanoutSheetProps {
	target: FanoutTarget;
	/** The composer's draft: what every session is asked. */
	prompt: string;
	onClose(): void;
}

/** From the composer: pick the models for the draft, start them, then compare them. */
export function FanoutSheet({ target, prompt, onClose }: FanoutSheetProps): ReactNode {
	const [group, setGroup] = useState<FanoutGroup | null>(null);
	if (group !== null)
		return <FanoutCompareSheet client={target.client} groupId={group.id} onOpen={target.onOpen} onClose={onClose} />;
	return (
		<Sheet label="try on several models" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Try on several models</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			<div className="sh-fan-prompt" title={prompt}>
				{prompt.trim() || "Your message box is empty."}
			</div>
			<FanoutPicker
				client={target.client}
				cwd={target.cwd}
				prompt={prompt}
				canSandbox={target.canSandbox}
				onStarted={setGroup}
			/>
		</Sheet>
	);
}

export interface FanoutCompareSheetProps {
	client: CompanionClient;
	groupId: string;
	/** Join a session; rejects with a readable message. */
	onOpen(instanceId: string): Promise<void>;
	onClose(): void;
}

interface KeepDraft {
	run: FanoutRunView;
	removeOthers: boolean;
	discardDirty: boolean;
}

/** The sessions of one group side by side, and the choice of the one to keep. */
export function FanoutCompareSheet({ client, groupId, onOpen, onClose }: FanoutCompareSheetProps): ReactNode {
	const load = useCallback(() => client.requestFanoutCompare(groupId), [client, groupId]);
	const { state, reload } = useRequest(load);
	// Keep the last answer on screen while it reloads.
	const [compare, setCompare] = useState<FanoutCompare | null>(null);
	useEffect(() => {
		if (state.status === "ready") setCompare(state.value);
	}, [state]);
	const active = compare?.runs.some(run => run.status === "working" || run.status === "needs-input") ?? false;
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(reload, POLL_MS);
		return () => clearInterval(timer);
	}, [active, reload]);

	const [keeping, setKeeping] = useState<KeepDraft | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [kept, setKept] = useState<{ run: FanoutRunView; result: FanoutKeepResult } | null>(null);

	/** Join `run`'s session; its branch review (commit, push, pull request) opens with it. */
	const openWinner = async (run: FanoutRunView): Promise<void> => {
		if (run.instanceId === null) return;
		setPendingReview(run.instanceId);
		try {
			await onOpen(run.instanceId);
			onClose();
		} catch (err) {
			takePendingReview(run.instanceId);
			setError(errorText(err));
			setBusy(false);
			reload();
		}
	};

	const confirmKeep = async (draft: KeepDraft): Promise<void> => {
		if (draft.run.instanceId === null) return;
		setBusy(true);
		setError(null);
		try {
			const result = await client.keepFanoutRun({
				group: groupId,
				keep: draft.run.instanceId,
				removeOthers: draft.removeOthers,
				discardDirty: draft.removeOthers && draft.discardDirty,
			});
			setKeeping(null);
			if (result.skipped.length > 0) {
				setKept({ run: draft.run, result });
				setBusy(false);
				reload();
				return;
			}
			await openWinner(draft.run);
		} catch (err) {
			setError(errorText(err));
			setBusy(false);
		}
	};

	const open = (run: FanoutRunView): void => {
		if (run.instanceId === null) return;
		setBusy(true);
		setError(null);
		onOpen(run.instanceId).then(onClose, (err: unknown) => {
			setError(errorText(err));
			setBusy(false);
		});
	};

	return (
		<Sheet label="compare models" size="wide" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Compare models</div>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={reload}
					disabled={state.status === "loading"}
					aria-label="refresh"
					title="refresh"
				>
					<RefreshCw size={15} className={state.status === "loading" ? "sh-spin" : undefined} />
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{error && <div className="sh-connect-error">{error}</div>}
			{compare === null ? (
				state.status === "error" ? (
					<div className="sh-companion-offline">
						<span>{state.message}</span>
						<button type="button" className="sh-btn" onClick={reload}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				) : (
					<div className="sh-companion-empty">Loading…</div>
				)
			) : keeping !== null ? (
				<KeepPanel
					compare={compare}
					draft={keeping}
					busy={busy}
					onChange={setKeeping}
					onCancel={() => setKeeping(null)}
					onConfirm={() => void confirmKeep(keeping)}
				/>
			) : kept !== null ? (
				<div className="sh-fan-kept" role="status">
					<div>
						Kept <b>{kept.run.model}</b>.{" "}
						{kept.result.removed.length > 0 && `Removed: ${kept.result.removed.join(", ")}. `}
					</div>
					<div className="sh-field-hint">Left in place:</div>
					<ul className="sh-fan-skipped">
						{kept.result.skipped.map(entry => (
							<li key={entry.model}>
								<b>{entry.model}</b>: {entry.reason}
							</li>
						))}
					</ul>
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={() => {
							setBusy(true);
							void openWinner(kept.run);
						}}
						disabled={busy}
					>
						<ExternalLink size={15} /> Open {kept.run.model} and its pull request flow
					</button>
				</div>
			) : (
				<>
					<div className="sh-fan-prompt" title={compare.prompt}>
						{compare.prompt}
					</div>
					{compare.budgetUsd !== null && (
						<div className="sh-field-hint">Group budget {fmtCost(compare.budgetUsd)}, split evenly.</div>
					)}
					<ul className="sh-fan-runs">
						{compare.runs.map(run => (
							<RunRow
								key={run.branch}
								run={run}
								kept={compare.kept !== null && compare.kept === run.instanceId}
								busy={busy}
								onOpen={() => open(run)}
								onKeep={() => setKeeping({ run, removeOthers: false, discardDirty: false })}
							/>
						))}
					</ul>
				</>
			)}
		</Sheet>
	);
}

function RunRow({
	run,
	kept,
	busy,
	onOpen,
	onKeep,
}: {
	run: FanoutRunView;
	kept: boolean;
	busy: boolean;
	onOpen(): void;
	onKeep(): void;
}): ReactNode {
	const live = run.status !== "ended" && run.status !== "failed" && run.instanceId !== null;
	return (
		<li className={`sh-fan-run${kept ? " sh-fan-run-kept" : ""}`}>
			<div className="sh-fan-run-head">
				<span className="sh-fan-model">{run.model}</span>
				<span className={`sh-chip sh-fan-status sh-fan-status-${run.status}`}>{STATUS_LABEL[run.status]}</span>
				{kept && (
					<span className="sh-chip sh-fan-kept-chip">
						<Trophy size={11} /> kept
					</span>
				)}
				{run.gone && run.error === null && <span className="sh-chip">worktree removed</span>}
			</div>
			{run.error !== null ? (
				<div className="sh-fan-error">{run.error}</div>
			) : (
				<div className="sh-fan-stats">
					<span title="spend so far">
						{run.costUsd === null ? "$–" : fmtCost(run.costUsd)}
						{run.maxCostUsd !== null && <span className="sh-sheet-faint"> / {fmtCost(run.maxCostUsd)}</span>}
					</span>
					{run.files !== null && (
						<span title="changed files against the base branch">
							{run.files} file{run.files === 1 ? "" : "s"}{" "}
							<span className="sh-fan-added">+{run.added ?? 0}</span>{" "}
							<span className="sh-fan-removed">−{run.removed ?? 0}</span>
						</span>
					)}
					{run.dirty && <span className="sh-chip">uncommitted</span>}
					{run.verify !== null && (
						<span
							className={`sh-fan-verify ${run.verify.ok ? "sh-fan-verify-ok" : "sh-fan-verify-fail"}`}
							title={run.verify.command}
						>
							{run.verify.ok ? <CircleCheck size={13} /> : <CircleX size={13} />}
							{run.verify.ok ? "passes" : "fails"}: {run.verify.command}
						</span>
					)}
					{run.pr !== null && (
						<a className="sh-fan-pr" href={run.pr.url} target="_blank" rel="noreferrer">
							PR #{run.pr.number}
						</a>
					)}
				</div>
			)}
			<div className="sh-fan-branch" title={run.path}>
				{run.branch}
			</div>
			{run.error === null && !run.gone && (
				<div className="sh-fan-actions">
					<button type="button" className="sh-btn" onClick={onOpen} disabled={busy || !live}>
						<ExternalLink size={14} /> Open
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={onKeep}
						disabled={busy || !live}
						title={live ? undefined : "its session has ended"}
					>
						<Trophy size={14} /> Keep this one
					</button>
				</div>
			)}
		</li>
	);
}

function KeepPanel({
	compare,
	draft,
	busy,
	onChange,
	onCancel,
	onConfirm,
}: {
	compare: FanoutCompare;
	draft: KeepDraft;
	busy: boolean;
	onChange(draft: KeepDraft): void;
	onCancel(): void;
	onConfirm(): void;
}): ReactNode {
	const others = compare.runs.filter(run => run !== draft.run && run.instanceId !== null && !run.gone);
	const dirty = others.filter(run => run.dirty);
	return (
		<div className="sh-fan-keep">
			<div>
				Keep <b>{draft.run.model}</b> on branch <code>{draft.run.branch}</code>? Its session opens with the branch
				review, where you commit, push and open the pull request.
			</div>
			{others.length > 0 && (
				<label className="sh-start-sandbox">
					<input
						type="checkbox"
						checked={draft.removeOthers}
						onChange={e => onChange({ ...draft, removeOthers: e.currentTarget.checked, discardDirty: false })}
					/>
					<span className="sh-start-sandbox-text">
						<span className="sh-start-sandbox-title">Remove the other worktrees</span>
						<span className="sh-field-hint">
							Ends their sessions and deletes their folders; their branches stay.{" "}
							{others.map(run => run.model).join(", ")}
						</span>
					</span>
				</label>
			)}
			{draft.removeOthers && dirty.length > 0 && (
				<label className="sh-start-sandbox sh-fan-danger">
					<input
						type="checkbox"
						checked={draft.discardDirty}
						onChange={e => onChange({ ...draft, discardDirty: e.currentTarget.checked })}
					/>
					<span className="sh-start-sandbox-text">
						<span className="sh-start-sandbox-title">Discard their uncommitted changes</span>
						<span className="sh-field-hint">
							{dirty.map(run => run.model).join(", ")} {dirty.length === 1 ? "has" : "have"} uncommitted work
							that cannot be recovered. Without this, those worktrees stay.
						</span>
					</span>
				</label>
			)}
			<div className="sh-fan-actions">
				<button type="button" className="sh-btn" onClick={onCancel} disabled={busy}>
					Cancel
				</button>
				<button type="button" className="sh-btn sh-btn-primary" onClick={onConfirm} disabled={busy}>
					{busy ? <LoaderCircle size={14} className="sh-spin" /> : <Trophy size={14} />} Keep and open pull request
					flow
				</button>
			</div>
		</div>
	);
}

/** Composer pill: opens the model picker for the current draft. */
export function FanoutPill({
	prompt,
	target,
	disabled,
}: {
	prompt: string;
	target: FanoutTarget;
	disabled: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const label = "try this message on several models, each in its own worktree";
	return (
		<>
			<button
				type="button"
				className="sh-pill sh-pill-icon"
				onClick={() => setOpen(true)}
				disabled={disabled}
				aria-haspopup="dialog"
				aria-label={label}
				title={label}
			>
				<GitCompareArrows size={13} aria-hidden />
			</button>
			{open && <FanoutSheet target={target} prompt={prompt} onClose={() => setOpen(false)} />}
		</>
	);
}

/** On a session row: the model a best-of-N comparison runs it on. */
export function FanoutChip({ fanout }: { fanout: HostFanout }): ReactNode {
	return (
		<span className="sh-chip sh-fan-row-chip" title="started by a model comparison">
			<GitCompareArrows size={11} /> {fanout.model}
		</span>
	);
}

/** One button per best-of-N group that has a listed session, each opening that group's compare sheet. */
export function FanoutGroups({
	hosts,
	client,
	onOpen,
}: {
	hosts: readonly CompanionHost[];
	client: CompanionClient;
	onOpen(instanceId: string): Promise<void>;
}): ReactNode {
	const [open, setOpen] = useState<string | null>(null);
	const groups = useMemo(() => {
		const byGroup = new Map<string, string[]>();
		for (const host of hosts) {
			if (host.fanout)
				byGroup.set(host.fanout.group, [...(byGroup.get(host.fanout.group) ?? []), host.fanout.model]);
		}
		return [...byGroup];
	}, [hosts]);
	return (
		<>
			{groups.length > 0 && (
				<section className="sh-fan-groups" aria-label="model comparisons">
					{groups.map(([id, models]) => (
						<button
							key={id}
							type="button"
							className="sh-btn sh-fan-group-btn"
							onClick={() => setOpen(id)}
							title={models.join(", ")}
						>
							<GitCompareArrows size={14} />
							<span className="sh-fan-group-name">Compare {models.join(" · ")}</span>
						</button>
					))}
				</section>
			)}
			{open !== null && (
				<FanoutCompareSheet client={client} groupId={open} onOpen={onOpen} onClose={() => setOpen(null)} />
			)}
		</>
	);
}
