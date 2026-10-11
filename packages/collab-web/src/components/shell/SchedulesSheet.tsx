import {
	CalendarClock,
	ChevronLeft,
	GitBranch,
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
import { useCallback, useRef, useState } from "react";
import type { CompanionClient, RecentFolder } from "../../lib/companion";
import { relTime, shortenPath } from "../../lib/format";
import {
	describeWhen,
	MAX_SCHEDULE_COST_USD,
	MAX_SCHEDULE_PROMPT_CHARS,
	MAX_SCHEDULE_TITLE_CHARS,
	type Schedule,
	type ScheduleInput,
	type ScheduleWhen,
	untilWords,
	weekdayLabel,
} from "../../lib/schedules";
import { useRequest } from "../../lib/use-request";
import { QuickReplies } from "./QuickReplies";
import { Sheet } from "./Sheet";
import "./schedules.css";

/** Weekdays in the order the editor lists them (Monday first); values are `Date#getDay` numbers. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export interface SchedulesSheetProps {
	client: CompanionClient;
	/** The companion can start sandboxed sessions: offer the toggle. */
	canSandbox: boolean;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onClose(): void;
}

/** The form's state: `at` is a `datetime-local` value, `time` an `HH:MM` value. */
interface Draft {
	id?: string;
	title: string;
	prompt: string;
	cwd: string;
	mode: "new" | "resume";
	sessionId: string;
	worktree: boolean;
	sandboxed: boolean;
	maxCost: string;
	kind: ScheduleWhen["kind"];
	at: string;
	time: string;
	days: number[];
	enabled: boolean;
}

function folderName(cwd: string): string {
	return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

/** A `datetime-local` value (local time, minutes) for `ms`. */
function toLocalInput(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function blankDraft(): Draft {
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	tomorrow.setHours(9, 0, 0, 0);
	return {
		title: "",
		prompt: "",
		cwd: "",
		mode: "new",
		sessionId: "",
		worktree: false,
		sandboxed: false,
		maxCost: "",
		kind: "daily",
		at: toLocalInput(tomorrow.getTime()),
		time: "09:00",
		days: [1, 2, 3, 4, 5],
		enabled: true,
	};
}

function draftOf(schedule: Schedule): Draft {
	const { when } = schedule;
	return {
		...blankDraft(),
		id: schedule.id,
		title: schedule.title,
		prompt: schedule.prompt,
		cwd: schedule.cwd,
		mode: schedule.mode,
		sessionId: schedule.sessionId ?? "",
		worktree: schedule.worktree === true,
		sandboxed: schedule.sandboxed === true,
		maxCost: schedule.maxCostUsd === undefined ? "" : String(schedule.maxCostUsd),
		kind: when.kind,
		...(when.kind === "once" ? { at: toLocalInput(when.at) } : { time: when.time, days: when.days }),
		enabled: schedule.enabled,
	};
}

/** What the companion is sent for `draft`, or what is missing; the companion validates again. */
function inputOf(draft: Draft): { input: ScheduleInput } | { error: string } {
	if (draft.prompt.trim() === "") return { error: "Write the prompt to run." };
	if (draft.cwd === "") return { error: "Pick a folder." };
	if (draft.mode === "resume" && draft.sessionId === "") return { error: "Pick the session to resume." };
	let when: ScheduleWhen;
	if (draft.kind === "once") {
		const at = new Date(draft.at).getTime();
		if (!Number.isFinite(at)) return { error: "Pick a date and time." };
		when = { kind: "once", at };
	} else {
		if (draft.time === "") return { error: "Pick a time." };
		if (draft.days.length === 0) return { error: "Pick at least one weekday." };
		when = { kind: "daily", time: draft.time, days: draft.days };
	}
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
			enabled: draft.enabled,
		},
	};
}

function inputFromSchedule(schedule: Schedule, enabled: boolean): ScheduleInput {
	const { lastRun: _lastRun, nextRun: _nextRun, ...rest } = schedule;
	return { ...rest, enabled };
}

/** Prompts the computer runs on a timetable: each starts a hosted omp session that begins working at once. */
export function SchedulesSheet({ client, canSandbox, onOpenHost, onClose }: SchedulesSheetProps): ReactNode {
	const load = useCallback(() => client.requestSchedules(), [client]);
	const { state, reload } = useRequest(load);
	// Keep the last list on screen while it reloads.
	const shown = useRef<Schedule[] | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const list = shown.current;
	const [draft, setDraft] = useState<Draft | null>(null);
	const [confirming, setConfirming] = useState<{ id: string; action: "run" | "delete" } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const act = async (id: string, work: () => Promise<unknown>): Promise<void> => {
		setBusy(id);
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

	const save = async (input: ScheduleInput): Promise<void> => {
		setBusy("save");
		setError(null);
		try {
			await client.saveSchedule(input);
			setDraft(null);
			reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	};

	const open = async (instanceId: string): Promise<void> => {
		setBusy(instanceId);
		setError(null);
		try {
			await onOpenHost(instanceId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(null);
		}
	};

	const loading = state.status === "loading";
	return (
		<Sheet label="schedules" onClose={onClose}>
			<div className="sh-sheet-head">
				{draft !== null && busy !== "save" ? (
					<button type="button" className="sh-btn sh-btn-icon" onClick={() => setDraft(null)} aria-label="back">
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
							aria-label="refresh"
							title="refresh"
						>
							{loading ? <LoaderCircle size={15} className="sh-spin" /> : <RefreshCw size={15} />}
						</button>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{draft !== null ? (
				<ScheduleEditor
					client={client}
					canSandbox={canSandbox}
					draft={draft}
					busy={busy === "save"}
					onChange={setDraft}
					onSave={input => void save(input)}
				/>
			) : (
				<>
					<p className="sh-field-hint sh-sched-note">
						Each run starts omp on this computer with your prompt, as a session you can open from here. Runs use
						your omp and cost money; they never start once today's spend limit (Usage → Spend alerts) is reached.
						A run missed while the computer slept still starts if it is under an hour late.
					</p>
					{list === null ? (
						loading ? (
							<div className="sh-companion-empty sh-file-status">
								<LoaderCircle size={14} className="sh-spin" /> Reading schedules…
							</div>
						) : null
					) : list.length === 0 ? (
						<div className="sh-companion-empty">No schedules yet.</div>
					) : (
						<ul className="sh-sched-list" aria-label="schedules">
							{list.map(schedule => (
								<ScheduleRow
									key={schedule.id}
									schedule={schedule}
									busy={busy}
									confirming={confirming?.id === schedule.id ? confirming.action : null}
									onConfirm={action => setConfirming(action === null ? null : { id: schedule.id, action })}
									onToggle={() =>
										void act(schedule.id, () =>
											client.saveSchedule(inputFromSchedule(schedule, !schedule.enabled)),
										)
									}
									onRun={() => void act(schedule.id, () => client.runScheduleNow(schedule.id))}
									onDelete={() => void act(schedule.id, () => client.deleteSchedule(schedule.id))}
									onEdit={() => setDraft(draftOf(schedule))}
									onOpen={open}
								/>
							))}
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
			{(error ?? (state.status === "error" ? state.message : null)) && (
				<div className="sh-connect-error">{error ?? (state.status === "error" ? state.message : null)}</div>
			)}
		</Sheet>
	);
}

interface ScheduleRowProps {
	schedule: Schedule;
	/** Id of the schedule (or session) with a request in flight. */
	busy: string | null;
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
	if (run.instanceId) return { text: `started ${relTime(run.at)}`, tone: "ok" };
	return { text: `starting… ${relTime(run.at)}`, tone: "skip" };
}

function ScheduleRow({
	schedule,
	busy,
	confirming,
	onConfirm,
	onToggle,
	onRun,
	onDelete,
	onEdit,
	onOpen,
}: ScheduleRowProps): ReactNode {
	const working = busy === schedule.id;
	const disabled = busy !== null;
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
					</span>
					<span className="sh-recent-meta">
						<span>{describeWhen(schedule.when)}</span>
						<span>{next}</span>
					</span>
					<span className="sh-recent-meta">
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
					aria-label={`${schedule.enabled ? "turn off" : "turn on"} ${schedule.title}`}
					title={schedule.enabled ? "turn off" : "turn on"}
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
						aria-label={`edit ${schedule.title}`}
						title="edit"
					>
						<Pencil size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => onConfirm("delete")}
						disabled={disabled}
						aria-label={`delete ${schedule.title}`}
						title="delete"
					>
						<Trash2 size={15} />
					</button>
				</div>
			) : (
				<div className="sh-sched-confirm" role="group" aria-label="confirm">
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
	client: CompanionClient;
	canSandbox: boolean;
	draft: Draft;
	busy: boolean;
	onChange(draft: Draft): void;
	onSave(input: ScheduleInput): void;
}

function ScheduleEditor({ client, canSandbox, draft, busy, onChange, onSave }: ScheduleEditorProps): ReactNode {
	const loadFolders = useCallback(() => client.requestFolders(), [client]);
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

	const toggleDay = (day: number): void =>
		set({ days: draft.days.includes(day) ? draft.days.filter(d => d !== day) : [...draft.days, day] });

	return (
		<form className="sh-sched-form" onSubmit={submit}>
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
				<div className="sh-segmented" role="radiogroup" aria-label="session">
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
							aria-label="session to resume"
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
			<div className="sh-sched-field">
				<span className="sh-field-label">Repeat</span>
				<div className="sh-segmented" role="radiogroup" aria-label="repeat">
					{(["once", "daily"] as const).map(kind => (
						<button
							key={kind}
							type="button"
							role="radio"
							aria-checked={draft.kind === kind}
							className={draft.kind === kind ? "sh-segment sh-segment-on" : "sh-segment"}
							onClick={() => set({ kind })}
						>
							{kind === "once" ? "Once" : "Daily"}
						</button>
					))}
				</div>
				{draft.kind === "once" ? (
					<input
						className="sh-input"
						type="datetime-local"
						value={draft.at}
						onChange={e => set({ at: e.currentTarget.value })}
						aria-label="date and time"
					/>
				) : (
					<>
						<input
							className="sh-input"
							type="time"
							value={draft.time}
							onChange={e => set({ time: e.currentTarget.value })}
							aria-label="time of day"
						/>
						<div className="sh-sched-days" role="group" aria-label="weekdays">
							{DAY_ORDER.map(day => (
								<button
									key={day}
									type="button"
									className={
										draft.days.includes(day) ? "sh-chip sh-sched-day sh-sched-day-on" : "sh-chip sh-sched-day"
									}
									aria-pressed={draft.days.includes(day)}
									onClick={() => toggleDay(day)}
								>
									{weekdayLabel(day)}
								</button>
							))}
						</div>
					</>
				)}
				<span className="sh-field-hint">The computer's local time.</span>
			</div>
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
	client: CompanionClient;
	canSandbox: boolean;
	onOpenHost(instanceId: string): Promise<void>;
	/** `card`: labelled button in the start screen's action row; `icon`: sidebar footer button. */
	variant: "card" | "icon";
}

/** The button that opens the schedules sheet. */
export function SchedulesEntry({ client, canSandbox, onOpenHost, variant }: SchedulesEntryProps): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className={variant === "card" ? "sh-btn sh-card-action" : "sh-btn sh-btn-icon"}
				onClick={() => setOpen(true)}
				aria-label="schedules"
				title="schedules"
			>
				<CalendarClock size={15} />
				{variant === "card" && " Schedules"}
			</button>
			{open && (
				<SchedulesSheet
					client={client}
					canSandbox={canSandbox}
					onOpenHost={onOpenHost}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}
