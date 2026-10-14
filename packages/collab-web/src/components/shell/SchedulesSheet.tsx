import {
	CalendarClock,
	ChevronLeft,
	GitBranch,
	Laptop,
	LoaderCircle,
	Pencil,
	Play,
	Plus,
	RefreshCw,
	ShieldCheck,
	Trash2,
	X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, RecentFolder } from "../../lib/companion";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import { relTime, shortenPath } from "../../lib/format";
import { hostKey } from "../../lib/inbox";
import {
	type CatchUpPolicy,
	describeWhen,
	formatRunTime,
	MAX_SCHEDULE_COST_USD,
	MAX_SCHEDULE_PROMPT_CHARS,
	MAX_SCHEDULE_TITLE_CHARS,
	type Schedule,
	type ScheduleInput,
} from "@oh-my-pi/pi-wire/schedule";
import { untilWords } from "../../lib/schedules";
import { useComputerRequests } from "../../lib/use-computer-requests";
import { useRequest } from "../../lib/use-request";
import { ComputerPicker, useStartComputer } from "./ComputerPicker";
import { QuickReplies } from "./QuickReplies";
import { blankWhenDraft, ScheduleWhenEditor, type WhenDraft, whenDraftOf, whenOf } from "./ScheduleWhenEditor";
import { Sheet } from "./Sheet";
import "./schedules.css";

export interface SchedulesSheetProps {
	computers: readonly ComputerHandle[];
	/** Fetch a link for a hosting session of `computerId` and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	onClose(): void;
}

/** The connection to a computer's companion, which the lists of schedules are read through. */
function clientOf(computer: ComputerHandle): CompanionClient {
	if (computer.client === null) throw new Error(`${computer.name} is not reachable`);
	return computer.client;
}

/** The form's state; the timetable part lives with its editor. */
interface Draft {
	id?: string;
	/** The computer an existing schedule lives on; null for a new one, which takes the computer picked in the editor. */
	computerId: string | null;
	title: string;
	prompt: string;
	cwd: string;
	mode: "new" | "resume";
	sessionId: string;
	worktree: boolean;
	sandboxed: boolean;
	maxCost: string;
	when: WhenDraft;
	catchUp: CatchUpPolicy;
	/** Kept as stored: an agent-made schedule stays marked after the user edits it. */
	createdBy?: "agent";
	enabled: boolean;
}

function folderName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

function blankDraft(): Draft {
	return {
		computerId: null,
		title: "",
		prompt: "",
		cwd: "",
		mode: "new",
		sessionId: "",
		worktree: false,
		sandboxed: false,
		maxCost: "",
		when: blankWhenDraft(),
		catchUp: "skip",
		enabled: true,
	};
}

function draftOf(schedule: Schedule, computerId: string): Draft {
	return {
		...blankDraft(),
		id: schedule.id,
		computerId,
		title: schedule.title,
		prompt: schedule.prompt,
		cwd: schedule.cwd,
		mode: schedule.mode,
		sessionId: schedule.sessionId ?? "",
		worktree: schedule.worktree === true,
		sandboxed: schedule.sandboxed === true,
		maxCost: schedule.maxCostUsd === undefined ? "" : String(schedule.maxCostUsd),
		when: whenDraftOf(schedule.when),
		catchUp: schedule.catchUp ?? "skip",
		createdBy: schedule.createdBy,
		enabled: schedule.enabled,
	};
}

/** What the companion is sent for `draft`, or what is missing; the companion validates again. */
function inputOf(draft: Draft): { input: ScheduleInput } | { error: string } {
	if (draft.prompt.trim() === "") return { error: "Write the prompt to run." };
	if (draft.cwd === "") return { error: "Pick a folder." };
	if (draft.mode === "resume" && draft.sessionId === "") return { error: "Pick the session to resume." };
	const built = whenOf(draft.when);
	if ("error" in built) return built;
	const when = built.when;
	const maxCostText = draft.maxCost.trim().replace(/^\$/, "");
	const maxCostUsd = maxCostText === "" ? undefined : Number(maxCostText);
	if (
		draft.mode === "new" &&
		maxCostUsd !== undefined &&
		!(Number.isFinite(maxCostUsd) && maxCostUsd > 0 && maxCostUsd <= MAX_SCHEDULE_COST_USD)
	)
		return { error: "Enter a spend limit in dollars, or leave it empty." };
	return {
		input: {
			id: draft.id,
			title: draft.title.trim(),
			prompt: draft.prompt,
			cwd: draft.cwd,
			mode: draft.mode,
			sessionId: draft.mode === "resume" ? draft.sessionId : undefined,
			worktree: draft.mode === "new" && draft.worktree ? true : undefined,
			sandboxed: draft.sandboxed ? true : undefined,
			maxCostUsd: draft.mode === "new" ? maxCostUsd : undefined,
			when,
			catchUp: draft.catchUp === "run-once" ? "run-once" : undefined,
			createdBy: draft.createdBy,
			enabled: draft.enabled,
		},
	};
}

function inputFromSchedule(schedule: Schedule, enabled: boolean): ScheduleInput {
	const { lastRun: _lastRun, nextRun: _nextRun, ...rest } = schedule;
	return { ...rest, enabled };
}

/** Prompts the computer runs on a timetable: each starts a hosted omp session that begins working at once. */
export function SchedulesSheet({ computers, onOpenHost, onClose }: SchedulesSheetProps): ReactNode {
	const { entries, loading, reload } = useComputerRequests(computers, "schedule", client => client.requestSchedules());
	const [draft, setDraft] = useState<Draft | null>(null);
	const [pickedId, setPickedId] = useStartComputer(computers, "schedule", null);
	const [confirming, setConfirming] = useState<{ key: string; action: "run" | "delete" } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const several = computers.length > 1;
	// An existing schedule stays on its computer; a new one goes where it was picked.
	const editing =
		draft === null ? null : computerById(computers, draft.id === undefined ? pickedId : draft.computerId);

	const rows = entries.flatMap(({ computer, state }) =>
		state?.status === "ready" ? state.value.map(schedule => ({ computer, schedule })) : [],
	);
	const answered = entries.some(entry => entry.state?.status === "ready");

	const act = async (key: string, work: () => Promise<unknown>): Promise<void> => {
		setBusy(key);
		setError(null);
		setConfirming(null);
		try {
			await work();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
			reload();
		}
	};

	const save = async (computer: ComputerHandle, input: ScheduleInput): Promise<void> => {
		setBusy("save");
		setError(null);
		try {
			await clientOf(computer).saveSchedule(input);
			saveLastComputer(computer.id);
			setDraft(null);
			reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const open = async (computer: ComputerHandle, instanceId: string): Promise<void> => {
		setBusy(hostKey(computer.id, instanceId));
		setError(null);
		try {
			await onOpenHost(computer.id, instanceId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
		}
	};

	/** Another computer for a new schedule: what the old one listed or could do no longer applies. */
	const pickComputer = (id: string): void => {
		setPickedId(id);
		if (draft === null) return;
		const next = computerById(computers, id);
		setDraft({
			...draft,
			cwd: "",
			sessionId: "",
			sandboxed: draft.sandboxed && (next?.snap.canSandbox ?? false),
			...(next?.snap.canScheduleCron === true ? {} : { when: blankWhenDraft(), catchUp: "skip" as const }),
		});
	};

	return (
		<Sheet label="schedules" onClose={onClose}>
			<div className="sh-sheet-head">
				{draft !== null && busy !== "save" ? (
					<button type="button" className="sh-btn sh-btn-icon" onClick={() => setDraft(null)} aria-label="Back">
						<ChevronLeft size={16} />
					</button>
				) : null}
				<div className="sh-sheet-title">
					{draft === null ? "Schedules" : draft.id ? "Edit schedule" : "New schedule"}
				</div>
				<span className="sh-sched-head-actions">
					{draft === null && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={reload}
							disabled={loading}
							aria-label="Refresh"
							title="Refresh"
						>
							{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
						</button>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			{draft !== null ? (
				<ScheduleEditor
					computers={computers}
					computer={editing}
					draft={draft}
					busy={busy === "save"}
					onChange={setDraft}
					onComputer={pickComputer}
					onSave={input => {
						if (editing === null) setError("No computer can run a schedule right now.");
						else void save(editing, input);
					}}
				/>
			) : (
				<>
					<p className="sh-field-hint sh-sched-note">
						Each run starts omp on {several ? "its" : "this"} computer with your prompt, as a session you can open
						from here. Runs use your omp and cost money; they never start once today's spend limit (Usage → Spend
						alerts) is reached. A run missed while the computer was off follows its catch-up setting (by default
						it still starts if it is under an hour late).
					</p>
					{!answered ? (
						loading ? (
							<div className="sh-companion-empty sh-file-status">
								<LoaderCircle size={14} className="sh-spin" /> Reading schedules…
							</div>
						) : null
					) : rows.length === 0 ? (
						<div className="sh-companion-empty">No schedules yet.</div>
					) : (
						<ul className="sh-sched-list" aria-label="Schedules">
							{rows.map(({ computer, schedule }) => {
								const key = hostKey(computer.id, schedule.id);
								return (
									<ScheduleRow
										key={key}
										schedule={schedule}
										computerName={several ? computer.name : null}
										working={busy === key}
										disabled={busy !== null}
										confirming={confirming?.key === key ? confirming.action : null}
										onConfirm={action => setConfirming(action === null ? null : { key, action })}
										onToggle={() =>
											void act(key, () =>
												clientOf(computer).saveSchedule(inputFromSchedule(schedule, !schedule.enabled)),
											)
										}
										onRun={() => void act(key, () => clientOf(computer).runScheduleNow(schedule.id))}
										onDelete={() => void act(key, () => clientOf(computer).deleteSchedule(schedule.id))}
										onEdit={() => {
											setError(null);
											setDraft(draftOf(schedule, computer.id));
										}}
										onOpen={instanceId => open(computer, instanceId)}
									/>
								);
							})}
						</ul>
					)}
					<button
						type="button"
						className="sh-btn sh-card-action"
						onClick={() => setDraft(blankDraft())}
						disabled={busy !== null}
					>
						<Plus size={15} /> New schedule
					</button>
				</>
			)}
			{error && <div className="sh-connect-error">{error}</div>}
			{entries.map(({ computer, state }) =>
				state?.status === "error" ? (
					<div key={computer.id} className="sh-connect-error">
						{several ? `${computer.name}: ` : ""}
						{state.message}
					</div>
				) : null,
			)}
			{several &&
				entries.map(({ computer, reason }) =>
					reason !== null && computer.snap.phase !== "live" ? (
						<div key={computer.id} className="sh-field-hint">
							{computer.name}: {reason}
						</div>
					) : null,
				)}
		</Sheet>
	);
}

interface ScheduleRowProps {
	schedule: Schedule;
	/** The computer's name, shown when there are several. */
	computerName: string | null;
	/** A request of this schedule is in flight. */
	working: boolean;
	/** Some request is in flight. */
	disabled: boolean;
	confirming: "run" | "delete" | null;
	onConfirm(action: "run" | "delete" | null): void;
	onToggle(): void;
	onRun(): void;
	onDelete(): void;
	onEdit(): void;
	onOpen(instanceId: string): Promise<void>;
}

/** What the latest trigger did, in words. */
function lastResult(schedule: Schedule): { text: string; tone: "ok" | "skip" | "err" } | null {
	const run = schedule.lastRun;
	if (!run) return null;
	if (run.error?.startsWith("skipped")) return { text: `${run.error} · ${relTime(run.at)}`, tone: "skip" };
	if (run.error) return { text: `failed: ${run.error} · ${relTime(run.at)}`, tone: "err" };
	if (run.instanceId) {
		const caughtUp = run.missedAt === undefined ? "" : ` (caught up; was due ${formatRunTime(run.missedAt)})`;
		return { text: `started${caughtUp} ${relTime(run.at)}`, tone: "ok" };
	}
	return { text: `starting… ${relTime(run.at)}`, tone: "skip" };
}

function ScheduleRow({
	schedule,
	computerName,
	working,
	disabled,
	confirming,
	onConfirm,
	onToggle,
	onRun,
	onDelete,
	onEdit,
	onOpen,
}: ScheduleRowProps): ReactNode {
	const result = lastResult(schedule);
	const next =
		schedule.nextRun !== null && schedule.enabled
			? `next ${untilWords(schedule.nextRun, Date.now())}`
			: schedule.when.kind === "once" && schedule.lastRun
				? "done"
				: "off";
	return (
		<li className="sh-sched">
			<div className="sh-sched-head">
				<div className="sh-sched-info">
					<span className="sh-recent-title">
						<span className="sh-recent-name">{schedule.title}</span>
						{schedule.sandboxed && <span className="sh-chip">sandboxed</span>}
						{schedule.worktree && <span className="sh-chip">worktree</span>}
						{schedule.maxCostUsd !== undefined && <span className="sh-chip">limit ${schedule.maxCostUsd}</span>}
						{schedule.mode === "resume" && <span className="sh-chip">resume</span>}
						{schedule.catchUp === "run-once" && <span className="sh-chip">catches up</span>}
						{schedule.createdBy === "agent" && <span className="sh-chip">made by agent</span>}
					</span>
					<span className="sh-recent-meta">
						<span>{describeWhen(schedule.when)}</span>
						<span>{next}</span>
					</span>
					<span className="sh-recent-meta">
						{computerName !== null && (
							<span className="sh-sched-computer">
								<Laptop size={12} /> {computerName}
							</span>
						)}
						<span className="sh-recent-cwd" title={schedule.cwd}>
							{shortenPath(schedule.cwd)}
						</span>
					</span>
					{result && <span className={`sh-sched-result sh-sched-result-${result.tone}`}>{result.text}</span>}
				</div>
				<button
					type="button"
					className={schedule.enabled ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={onToggle}
					disabled={disabled}
					aria-pressed={schedule.enabled}
					aria-label={`${schedule.enabled ? "Turn off" : "Turn on"} ${schedule.title}`}
					title={schedule.enabled ? "Turn off" : "Turn on"}
				>
					<CalendarClock size={15} />
				</button>
			</div>
			{confirming === null ? (
				<div className="sh-sched-actions">
					<button type="button" className="sh-btn" onClick={() => onConfirm("run")} disabled={disabled}>
						{working ? <LoaderCircle size={14} className="sh-spin" /> : <Play size={14} />} Run now
					</button>
					{schedule.lastRun?.instanceId !== undefined && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => void onOpen(schedule.lastRun?.instanceId ?? "")}
							disabled={disabled}
						>
							Open last run
						</button>
					)}
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={onEdit}
						disabled={disabled}
						aria-label={`Edit ${schedule.title}`}
						title="Edit"
					>
						<Pencil size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => onConfirm("delete")}
						disabled={disabled}
						aria-label={`Delete ${schedule.title}`}
						title="Delete"
					>
						<Trash2 size={15} />
					</button>
				</div>
			) : (
				<div className="sh-sched-confirm" role="group" aria-label="Confirm">
					<span className="sh-field-hint">
						{confirming === "run"
							? `Starts omp in ${schedule.mode === "resume" ? "the chosen session of " : ""}${folderName(schedule.cwd)} now${schedule.sandboxed ? ", sandboxed" : ""} and sends the prompt. It costs money.`
							: `Delete "${schedule.title}"? Sessions it already started stay.`}
					</span>
					<span className="sh-sched-confirm-actions">
						<button
							type="button"
							className={confirming === "run" ? "sh-btn sh-btn-primary" : "sh-btn sh-sched-delete"}
							onClick={confirming === "run" ? onRun : onDelete}
						>
							{confirming === "run" ? "Run now" : "Delete"}
						</button>
						<button type="button" className="sh-btn" onClick={() => onConfirm(null)}>
							Cancel
						</button>
					</span>
				</div>
			)}
		</li>
	);
}

interface ScheduleEditorProps {
	computers: readonly ComputerHandle[];
	/** The computer the schedule is saved to; null when none can take one. */
	computer: ComputerHandle | null;
	draft: Draft;
	busy: boolean;
	onChange(draft: Draft): void;
	/** A new schedule's computer was picked. */
	onComputer(id: string): void;
	onSave(input: ScheduleInput): void;
}

function ScheduleEditor({
	computers,
	computer,
	draft,
	busy,
	onChange,
	onComputer,
	onSave,
}: ScheduleEditorProps): ReactNode {
	const client = computer?.client ?? null;
	const canSandbox = computer?.snap.canSandbox ?? false;
	const canCron = computer?.snap.canScheduleCron ?? false;
	const loadFolders = useCallback(
		() => (client === null ? Promise.resolve<RecentFolder[]>([]) : client.requestFolders()),
		[client],
	);
	const { state: folders } = useRequest(loadFolders);
	const [problem, setProblem] = useState<string | null>(null);
	const set = (patch: Partial<Draft>): void => {
		setProblem(null);
		onChange({ ...draft, ...patch });
	};

	const recent: RecentFolder[] = folders.status === "ready" ? folders.value : [];
	// An edited schedule's folder stays selectable even when no session ran there lately.
	const options =
		recent.some(f => f.cwd === draft.cwd) || draft.cwd === ""
			? recent
			: [{ cwd: draft.cwd, lastActive: 0, sessions: [] }, ...recent];
	const sessions = options.find(f => f.cwd === draft.cwd)?.sessions ?? [];

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const built = inputOf(draft);
		if ("error" in built) setProblem(built.error);
		else onSave(built.input);
	};

	return (
		<form className="sh-sched-form" onSubmit={submit}>
			{draft.id === undefined ? (
				<ComputerPicker
					computers={computers}
					feature="schedule"
					value={computer?.id ?? null}
					onChange={onComputer}
				/>
			) : (
				computers.length > 1 &&
				computer !== null && (
					<div className="sh-sched-field">
						<span className="sh-field-label">Computer</span>
						<span className="sh-field-hint">{computer.name}</span>
					</div>
				)
			)}
			<label className="sh-sched-field">
				<span className="sh-field-label">Title</span>
				<input
					className="sh-input"
					value={draft.title}
					onChange={e => set({ title: e.currentTarget.value })}
					maxLength={MAX_SCHEDULE_TITLE_CHARS}
					placeholder="Defaults to the start of the prompt"
					autoComplete="off"
				/>
			</label>
			<label className="sh-sched-field">
				<span className="sh-field-label">Prompt</span>
				<textarea
					className="sh-input sh-start-prompt-input"
					value={draft.prompt}
					onChange={e => set({ prompt: e.currentTarget.value })}
					maxLength={MAX_SCHEDULE_PROMPT_CHARS}
					placeholder="What omp should work on"
					rows={4}
					spellCheck={false}
				/>
			</label>
			<QuickReplies
				disabled={false}
				onPick={text => set({ prompt: draft.prompt ? `${draft.prompt}\n${text}` : text })}
			/>
			<label className="sh-sched-field">
				<span className="sh-field-label">Folder</span>
				{folders.status === "loading" ? (
					<span className="sh-field-hint">
						<LoaderCircle size={12} className="sh-spin" /> Loading folders…
					</span>
				) : (
					<select
						className="sh-input"
						value={draft.cwd}
						onChange={e => set({ cwd: e.currentTarget.value, sessionId: "" })}
					>
						<option value="">Pick a folder…</option>
						{options.map(folder => (
							<option key={folder.cwd} value={folder.cwd}>
								{shortenPath(folder.cwd)}
							</option>
						))}
					</select>
				)}
				{folders.status === "error" && <span className="sh-field-hint">{folders.message}</span>}
			</label>
			<div className="sh-sched-field">
				<span className="sh-field-label">Session</span>
				<div className="sh-segmented" role="radiogroup" aria-label="Session">
					{(["new", "resume"] as const).map(mode => (
						<button
							key={mode}
							type="button"
							role="radio"
							aria-checked={draft.mode === mode}
							className={draft.mode === mode ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => set({ mode, worktree: mode === "new" ? draft.worktree : false })}
						>
							{mode === "new" ? "New session" : "Resume one"}
						</button>
					))}
				</div>
				{draft.mode === "resume" &&
					(sessions.length === 0 ? (
						<span className="sh-field-hint">
							{draft.cwd === "" ? "Pick a folder first." : "No recent sessions in this folder."}
						</span>
					) : (
						<select
							className="sh-input"
							value={draft.sessionId}
							onChange={e => set({ sessionId: e.currentTarget.value })}
							aria-label="Session to resume"
						>
							<option value="">Pick a session…</option>
							{sessions.map(session => (
								<option key={session.id} value={session.id}>
									{session.title ?? "Untitled session"} · {relTime(session.lastActive)}
								</option>
							))}
						</select>
					))}
			</div>
			<ScheduleWhenEditor draft={draft.when} canCron={canCron} onChange={when => set({ when })} />
			{canCron && (
				<div className="sh-sched-field">
					<span className="sh-field-label">If the computer was off at the time</span>
					<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-label="Missed runs">
						{(["skip", "run-once"] as const).map(policy => (
							<button
								key={policy}
								type="button"
								role="radio"
								aria-checked={draft.catchUp === policy}
								className={draft.catchUp === policy ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => set({ catchUp: policy })}
							>
								{policy === "skip" ? "Skip it" : "Run once when back"}
							</button>
						))}
					</div>
					<span className="sh-field-hint">
						{draft.catchUp === "skip"
							? "A run under an hour late still starts; anything later is only recorded as missed."
							: "However late, one run starts when the companion is back, whatever number of runs were missed."}
					</span>
				</div>
			)}
			{canSandbox && (
				<label className="sh-start-sandbox">
					<input
						type="checkbox"
						checked={draft.sandboxed}
						onChange={e => set({ sandboxed: e.currentTarget.checked })}
					/>
					<span className="sh-start-sandbox-text">
						<span className="sh-start-sandbox-title">
							<ShieldCheck size={14} /> Sandboxed
						</span>
						<span className="sh-field-hint">
							Reads and edits files only; changes stay in this folder. No commands run.
						</span>
					</span>
				</label>
			)}
			{draft.mode === "new" && (
				<label className="sh-start-sandbox">
					<input
						type="checkbox"
						checked={draft.worktree}
						onChange={e => set({ worktree: e.currentTarget.checked })}
					/>
					<span className="sh-start-sandbox-text">
						<span className="sh-start-sandbox-title">
							<GitBranch size={14} /> New git worktree
						</span>
						<span className="sh-field-hint">
							Each run works on a fresh branch in its own checkout, so this folder stays untouched.
						</span>
					</span>
				</label>
			)}
			{draft.mode === "new" && (
				<label className="sh-sched-field">
					<span className="sh-field-label">Spend limit per run</span>
					<input
						className="sh-input"
						value={draft.maxCost}
						onChange={e => set({ maxCost: e.currentTarget.value })}
						placeholder="No limit"
						inputMode="decimal"
						autoComplete="off"
					/>
					<span className="sh-field-hint">
						US dollars. The run stops at a safe point once it has spent this much, then refuses new prompts.
					</span>
				</label>
			)}
			<label className="sh-start-sandbox">
				<input type="checkbox" checked={draft.enabled} onChange={e => set({ enabled: e.currentTarget.checked })} />
				<span className="sh-start-sandbox-text">
					<span className="sh-start-sandbox-title">Enabled</span>
					<span className="sh-field-hint">Off keeps the schedule but never runs it.</span>
				</span>
			</label>
			<p className="sh-field-hint">
				Runs use the computer's omp and cost money. They respect the daily spend limit and never start while it is
				reached.
			</p>
			{problem && <div className="sh-connect-error">{problem}</div>}
			<button type="submit" className="sh-btn sh-btn-primary" disabled={busy}>
				{busy ? <LoaderCircle size={15} className="sh-spin" /> : <CalendarClock size={15} />} Save schedule
			</button>
		</form>
	);
}

export interface SchedulesEntryProps {
	computers: readonly ComputerHandle[];
	/** Fetch a link for a hosting session of `computerId` and join it; rejects with a readable message. */
	onOpenHost(computerId: string, instanceId: string): Promise<void>;
	/** `card`: labelled button in the start screen's action row; `icon`: sidebar footer button. */
	variant: "card" | "icon";
}

/** The button that opens the schedules sheet; absent unless some computer runs schedules. */
export function SchedulesEntry({ computers, onOpenHost, variant }: SchedulesEntryProps): ReactNode {
	const [open, setOpen] = useState(false);
	if (!computers.some(computer => computer.snap.canSchedule)) return null;
	return (
		<>
			<button
				type="button"
				className={variant === "card" ? "sh-btn sh-card-action" : "sh-btn sh-btn-icon"}
				onClick={() => setOpen(true)}
				aria-label="Schedules"
				title="Schedules"
			>
				<CalendarClock size={15} />
				{variant === "card" && " Schedules"}
			</button>
			{open && <SchedulesSheet computers={computers} onOpenHost={onOpenHost} onClose={() => setOpen(false)} />}
		</>
	);
}
