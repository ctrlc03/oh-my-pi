import {
	ChevronLeft,
	CircleCheck,
	FolderOpen,
	FolderPlus,
	GitBranch,
	GitCompareArrows,
	LoaderCircle,
	Plus,
	RefreshCw,
	ShieldAlert,
	ShieldCheck,
	X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionAgent, CompanionClient, ForeignPermission, RecentFolder } from "../../lib/companion";
import { type ComputerHandle, computerById, saveLastComputer } from "../../lib/computers";
import { relTime, shortenPath } from "../../lib/format";
import { setOpenIntent } from "../../lib/inbox";
import { type Combo, formatCombo, IS_MAC, matchCombo } from "../../lib/shortcuts";
import {
	folderLabel,
	isProjectless,
	NO_PROJECT,
	nextDraft,
	newSessionTarget,
	promptTitle,
	type StartDraft,
	type StartTarget,
	startOptions,
} from "../../lib/start-session";
import { type RequestState, useRequest } from "../../lib/use-request";
import { useOpenElsewhere } from "./OpenElsewhere";
import { QuickReplies } from "./QuickReplies";
import type { FanoutGroup } from "../../lib/fanout";
import { AgentChip } from "./AgentChip";
import { AgentPicker } from "./AgentPicker";
import { AgentsSheet } from "./AgentsSheet";
import { ComputerPicker, useStartComputer } from "./ComputerPicker";
import { FanoutCompareSheet, FanoutPicker } from "./FanoutSheet";
import { Sheet } from "./Sheet";

export interface StartSessionSheetProps {
	/** Every paired computer: the sheet starts on the one picked here (a choice only with two or more). */
	computers: readonly ComputerHandle[];
	/** The computer of the session on screen, offered first; null when none is open. */
	currentComputerId: string | null;
	/** Join the started host of `computerId`; rejects with a readable message. */
	onOpen(computerId: string, instanceId: string): Promise<void>;
	/** Open on this folder with this first message already written (a design to carry out); the person can still edit both. */
	initial?: { cwd: string; prompt: string };
	onClose(): void;
}

/** Starts the session and keeps the sheet open on a new draft. */
const START_AND_NEW: Combo = { key: "Enter", mod: true };
/** Sessions started in the background that the sheet keeps showing. */
const MAX_RUNS = 3;

/** The folder row of a session without a project. */
const NO_PROJECT_FOLDER: RecentFolder = { cwd: NO_PROJECT, lastActive: 0, sessions: [] };

/** A session started without leaving the sheet. */
interface BackgroundRun {
	key: number;
	/** The computer it runs on. */
	computerId: string;
	/** The prompt's first words, else the folder. */
	title: string;
	/** What it runs in: folder (when the title is the prompt), sandbox, worktree. */
	detail: string;
	/** Set once the session hosts. */
	instanceId?: string;
}

/** A started best-of-N group, with the computer that runs it. */
interface StartedGroup {
	group: FanoutGroup;
	client: CompanionClient;
	computerId: string;
}

/** Pick a folder omp has run in (or none), then start a new session there or resume one. */
export function StartSessionSheet({
	computers,
	currentComputerId,
	onOpen,
	initial,
	onClose,
}: StartSessionSheetProps): ReactNode {
	const [computerId, setComputerId] = useStartComputer(computers, "start", currentComputerId);
	const computer = computerById(computers, computerId);
	const client = computer?.client ?? null;
	/** Where the session runs, in the hints: the computer's name once there is a choice. */
	const where = computers.length > 1 && computer !== null ? computer.name : "your computer";
	const load = useCallback(
		() => (client === null ? Promise.resolve<RecentFolder[]>([]) : client.requestFolders()),
		[client],
	);
	const { state, reload } = useRequest(load);
	const canSandbox = computer?.snap.canSandbox ?? false;
	const canFanout = computer?.snap.canFanout ?? false;
	const canScratch = computer?.snap.canScratch ?? false;
	const canBackgroundStart = computer?.snap.canBackgroundStart ?? false;
	const canForeign = computer?.snap.canForeign ?? false;
	const canHighStakes = computer?.snap.canHighStakes ?? false;
	const loadAgents = useCallback(
		() => (canForeign && client !== null ? client.requestAgents() : Promise.resolve<CompanionAgent[]>([])),
		[client, canForeign],
	);
	const { state: agentsState, reload: reloadAgents } = useRequest(loadAgents);
	const [agent, setAgent] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const [permission, setPermission] = useState<ForeignPermission>("supervised");
	const [managing, setManaging] = useState(false);
	const [folder, setFolder] = useState<RecentFolder | null>(
		initial === undefined ? null : { cwd: initial.cwd, lastActive: 0, sessions: [] },
	);
	const [starting, setStarting] = useState<StartTarget | null>(null);
	const [sandboxed, setSandboxed] = useState(false);
	const [highStakes, setHighStakes] = useState(false);
	const [worktree, setWorktree] = useState(false);
	const [branch, setBranch] = useState("");
	const [prompt, setPrompt] = useState(initial?.prompt ?? "");
	const [error, setError] = useState<string | null>(null);
	const [fan, setFan] = useState(false);
	const [group, setGroup] = useState<StartedGroup | null>(null);
	const [runs, setRuns] = useState<BackgroundRun[]>([]);
	const runKey = useRef(0);
	const openElsewhere = useOpenElsewhere();
	const closedRef = useRef(false);
	useEffect(() => {
		closedRef.current = false;
		return () => {
			closedRef.current = true;
		};
	}, []);
	// The folder, agent and model on screen belong to the computer that listed them: another computer starts afresh.
	const shownComputer = useRef(computerId);
	useEffect(() => {
		if (shownComputer.current === computerId) return;
		shownComputer.current = computerId;
		setFolder(null);
		setAgent(null);
		setModel("");
		setFan(false);
		setError(null);
	}, [computerId]);

	if (computer === null || client === null)
		return (
			<Sheet label="Start a session" onClose={onClose}>
				<div className="sh-sheet-head">
					<div className="sh-sheet-title sh-start-title">Start a session</div>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</div>
				<ComputerPicker computers={computers} feature="start" value={computerId} onChange={setComputerId} />
				<div className="sh-field-hint">No computer can start a session right now.</div>
			</Sheet>
		);

	const agentList = agentsState.status === "ready" ? agentsState.value : [];
	/** The chosen agent as the computer lists it; null for omp (and for one that was removed meanwhile). */
	const chosenAgent = agent === null ? null : (agentList.find(entry => entry.id === agent) ?? null);
	// Other vendors' agents run unsandboxed for now: only omp sessions offer the option.
	const canSandboxHere = agent === null && canSandbox;
	const effectiveSandbox = sandboxed && canSandboxHere;
	// Vendor agents' pushes are not gated: only omp sessions offer the mode, and only in a repository.
	const canStakesHere = agent === null && canHighStakes;
	const effectiveStakes = highStakes && canStakesHere;
	const agentName = (id: string | undefined): string =>
		id === undefined ? "omp" : (agentList.find(entry => entry.id === id)?.name ?? id);

	const draft = (cwd: string): StartDraft => ({
		cwd,
		sandboxed: effectiveSandbox,
		highStakes: effectiveStakes && !isProjectless(cwd),
		worktree,
		branch,
		prompt,
		agent: chosenAgent?.id ?? null,
		model: chosenAgent === null ? "" : model,
		permission,
	});

	const start = async (target: StartTarget, force = false): Promise<void> => {
		setStarting(target);
		setError(null);
		openElsewhere.dismiss();
		try {
			const instanceId = await client.startSession(target.cwd, startOptions(target, { force }));
			saveLastComputer(computer.id);
			const first = prompt.trim();
			// Recorded even if the sheet was closed meanwhile: opening the session later still sends it.
			if (first) setOpenIntent(computer.id, instanceId, { prompt: first });
			// Closed while omp booted: the session still appears in the computer's list.
			if (!closedRef.current) await onOpen(computer.id, instanceId);
		} catch (err) {
			if (closedRef.current) return;
			if (!openElsewhere.intercept(err, () => void start(target, true))) {
				setError(err instanceof Error ? err.message : String(err));
			}
			setStarting(null);
		}
	};

	/** Start a new session from the draft without leaving the sheet, and open the next draft in the same folder and mode. */
	const startAndNew = (current: RecentFolder): void => {
		const d = draft(current.cwd);
		const target = newSessionTarget(d);
		const first = d.prompt.trim();
		const fromPrompt = promptTitle(first);
		const key = ++runKey.current;
		const run: BackgroundRun = {
			key,
			computerId: computer.id,
			title: fromPrompt ?? folderLabel(current.cwd),
			detail: [
				computers.length > 1 ? computer.name : null,
				fromPrompt === null ? null : folderLabel(current.cwd),
				target.agent === undefined ? null : agentName(target.agent),
				target.sandboxed ? "Sandboxed" : null,
				target.highStakes ? "High stakes" : null,
				target.worktree ? "New worktree" : null,
			]
				.filter(Boolean)
				.join(" · "),
		};
		setRuns(prev => [run, ...prev].slice(0, MAX_RUNS));
		setError(null);
		const next = nextDraft(d);
		setPrompt(next.prompt);
		setBranch(next.branch);
		client.startSession(target.cwd, startOptions(target, { prompt: first || undefined })).then(
			instanceId => {
				saveLastComputer(computer.id);
				if (!closedRef.current) setRuns(prev => prev.map(r => (r.key === key ? { ...r, instanceId } : r)));
			},
			(err: unknown) => {
				if (closedRef.current) return;
				setRuns(prev => prev.filter(r => r.key !== key));
				setError(`Could not start ${run.title}: ${err instanceof Error ? err.message : String(err)}`);
				// The typed prompt comes back unless something new was typed meanwhile.
				setPrompt(prev => (prev === "" ? first : prev));
			},
		);
	};

	const openRun = async (runComputerId: string, instanceId: string): Promise<void> => {
		try {
			await onOpen(runComputerId, instanceId);
		} catch (err) {
			if (!closedRef.current) setError(err instanceof Error ? err.message : String(err));
		}
	};

	const onFormKey = (e: KeyboardEvent<HTMLElement>): void => {
		if (folder === null || fan || !canBackgroundStart) return;
		// A held key would start a session per repeat; a composing IME's Enter picks a candidate.
		if (e.repeat || e.nativeEvent.isComposing || !matchCombo(e.nativeEvent, START_AND_NEW, IS_MAC)) return;
		e.preventDefault();
		startAndNew(folder);
	};

	if (group !== null)
		return (
			<FanoutCompareSheet
				client={group.client}
				groupId={group.group.id}
				onOpen={instanceId => onOpen(group.computerId, instanceId)}
				onClose={onClose}
			/>
		);

	const projectless = folder !== null && isProjectless(folder.cwd);

	return (
		<Sheet label="Start a session" onClose={onClose}>
			<div className="sh-sheet-head">
				{folder !== null && starting === null ? (
					<button type="button" className="sh-btn sh-btn-icon" onClick={() => setFolder(null)} aria-label="Back">
						<ChevronLeft size={16} />
					</button>
				) : null}
				<div className="sh-sheet-title sh-start-title">
					{folder === null ? "Start a session" : folderLabel(folder.cwd)}
				</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			{openElsewhere.notice}
			{error && <div className="sh-connect-error">{error}</div>}
			{folder === null && starting === null && (
				<ComputerPicker computers={computers} feature="start" value={computerId} onChange={setComputerId} />
			)}
			{starting === null && runs.length > 0 && (
				<div className="sh-start-runs" role="status">
					{runs.map(run => (
						<div key={run.key} className="sh-start-run">
							{run.instanceId === undefined ? (
								<LoaderCircle size={16} className="sh-spin sh-start-run-icon" />
							) : (
								<CircleCheck size={16} className="sh-start-run-icon sh-start-run-ok" />
							)}
							<span className="sh-start-run-text">
								<span className="sh-start-run-title">{run.title}</span>
								<span className="sh-field-hint">
									{[run.instanceId === undefined ? "Starting…" : "Started", run.detail]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</span>
							{run.instanceId !== undefined && (
								<button
									type="button"
									className="sh-btn sh-start-run-open"
									onClick={() => void openRun(run.computerId, run.instanceId as string)}
								>
									Open
								</button>
							)}
						</div>
					))}
				</div>
			)}
			{starting !== null ? (
				<div className="sh-start-progress" role="status">
					<LoaderCircle size={22} className="sh-spin" />
					<div className="sh-start-progress-title">
						{starting.resume ? "Resuming" : "Starting"} {starting.sandboxed ? "sandboxed " : ""}
						{agentName(starting.agent)} in {starting.scratch ? "a new scratch folder" : folderLabel(starting.cwd)}
						{starting.worktree ? " on a new worktree" : ""}…
					</div>
					<div className="sh-field-hint">
						This can take up to a minute while {agentName(starting.agent)} boots. You can close this; the session
						appears in {where === "your computer" ? "your computer's" : `${where}'s`} list when it is ready.
					</div>
				</div>
			) : folder === null ? (
				<FolderList state={state} canScratch={canScratch} onPick={setFolder} onRetry={reload} />
			) : (
				<div className="sh-start-form" onKeyDown={onFormKey}>
					{folder.cwd === NO_PROJECT && (
						<div className="sh-field-hint">
							The session starts in a fresh folder of its own on {where}, with no git repository. The folder is
							kept when the session ends.
						</div>
					)}
					{canForeign && !fan && (
						<AgentPicker
							agents={agentsState}
							agent={chosenAgent?.id ?? null}
							model={model}
							permission={permission}
							onAgent={id => {
								setAgent(id);
								setModel("");
							}}
							onModel={setModel}
							onPermission={setPermission}
							onRetry={reloadAgents}
							onManage={() => setManaging(true)}
						/>
					)}
					{canSandboxHere && (
						<label className="sh-start-sandbox">
							<input
								type="checkbox"
								checked={effectiveSandbox}
								onChange={e => setSandboxed(e.currentTarget.checked)}
							/>
							<span className="sh-start-sandbox-text">
								<span className="sh-start-sandbox-title">
									<ShieldCheck size={14} /> Sandboxed
								</span>
								<span className="sh-field-hint">
									{chosenAgent === null
										? "Reads and edits files only; changes stay in this folder. No commands run."
										: `Runs ${chosenAgent.name} with its own sandbox, which limits what it can change.`}
								</span>
							</span>
						</label>
					)}
					{canStakesHere && !projectless && !fan && (
						<label className="sh-start-sandbox">
							<input
								type="checkbox"
								checked={effectiveStakes}
								onChange={e => setHighStakes(e.currentTarget.checked)}
							/>
							<span className="sh-start-sandbox-text">
								<span className="sh-start-sandbox-title">
									<ShieldAlert size={14} /> High stakes
								</span>
								<span className="sh-field-hint">Pushes and pull requests need a passed quiz.</span>
							</span>
						</label>
					)}
					{!projectless && (
						<label className="sh-start-sandbox">
							<input type="checkbox" checked={worktree} onChange={e => setWorktree(e.currentTarget.checked)} />
							<span className="sh-start-sandbox-text">
								<span className="sh-start-sandbox-title">
									<GitBranch size={14} /> New git worktree
								</span>
								<span className="sh-field-hint">
									New session only: work on a fresh branch in its own checkout, so this folder stays untouched.
								</span>
							</span>
						</label>
					)}
					{!projectless && worktree && (
						<input
							className="sh-input sh-input-mono"
							value={branch}
							onChange={e => setBranch(e.currentTarget.value)}
							placeholder="Branch name (default: <prefix><date>-<id>)"
							aria-label="Worktree branch name"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
					)}
					<label className="sh-start-prompt">
						<span className="sh-field-label">First prompt{fan ? "" : " (optional)"}</span>
						<textarea
							className="sh-input sh-start-prompt-input"
							value={prompt}
							onChange={e => setPrompt(e.currentTarget.value)}
							placeholder="Sent as soon as the session is up"
							rows={3}
							spellCheck={false}
						/>
					</label>
					<QuickReplies disabled={false} onPick={text => setPrompt(prev => (prev ? `${prev}\n${text}` : text))} />
					{canFanout && !projectless && (
						<label className="sh-start-sandbox">
							<input type="checkbox" checked={fan} onChange={e => setFan(e.currentTarget.checked)} />
							<span className="sh-start-sandbox-text">
								<span className="sh-start-sandbox-title">
									<GitCompareArrows size={14} /> Compare models
								</span>
								<span className="sh-field-hint">
									Run the prompt on 2–4 models at once, each in its own worktree, then keep the best.
								</span>
							</span>
						</label>
					)}
					{fan && !projectless ? (
						<FanoutPicker
							client={client}
							cwd={folder.cwd}
							prompt={prompt}
							canSandbox={false}
							sandboxed={sandboxed}
							onStarted={started => setGroup({ group: started, client, computerId: computer.id })}
						/>
					) : (
						<>
							<div className="sh-start-actions">
								<button
									type="button"
									className="sh-btn sh-btn-primary sh-start-new"
									onClick={() => void start(newSessionTarget(draft(folder.cwd)))}
								>
									<Plus size={16} /> New session
								</button>
								{canBackgroundStart && (
									<button
										type="button"
										className="sh-btn sh-start-new sh-start-more"
										data-shortcut={formatCombo(START_AND_NEW, IS_MAC)}
										onClick={() => startAndNew(folder)}
									>
										Start and new
									</button>
								)}
							</div>
							{canBackgroundStart && (
								<div className="sh-field-hint sh-start-more-hint">
									Start and new starts this session and keeps the sheet open for the next one (
									{formatCombo(START_AND_NEW, IS_MAC)}).
								</div>
							)}
						</>
					)}
					{folder.sessions.length > 0 && (
						<section className="sh-switch-section" aria-label="Resume a session">
							<h2 className="sh-recents-title">Resume a session</h2>
							<ul className="sh-recents-list">
								{folder.sessions.map(session => (
									<li key={session.id} className="sh-recent">
										<button
											type="button"
											className="sh-recent-join"
											onClick={() =>
												void start({
													cwd: folder.cwd,
													resume: session.id,
													sandboxed: session.agent === undefined && sandboxed && canSandbox,
													agent: session.agent?.id,
												})
											}
										>
											<span className="sh-recent-title">
												<span className="sh-recent-name">{session.title ?? "Untitled session"}</span>
												<AgentChip agent={session.agent} />
											</span>
											<span className="sh-recent-meta">
												<span>{relTime(session.lastActive)}</span>
											</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					)}
				</div>
			)}
			{managing && (
				<AgentsSheet
					computers={computers}
					onClose={() => {
						setManaging(false);
						reloadAgents();
					}}
				/>
			)}
		</Sheet>
	);
}

export function FolderList({
	state,
	canScratch,
	onPick,
	onRetry,
}: {
	state: RequestState<RecentFolder[]>;
	/** The companion can start a session without a project. */
	canScratch: boolean;
	onPick(folder: RecentFolder): void;
	onRetry(): void;
}): ReactNode {
	const noProject = canScratch ? (
		<section className="sh-switch-section" aria-label="No project">
			<ul className="sh-recents-list">
				<li className="sh-recent">
					<button type="button" className="sh-recent-join" onClick={() => onPick(NO_PROJECT_FOLDER)}>
						<span className="sh-recent-title">
							<FolderPlus size={14} />
							<span className="sh-recent-name">No project</span>
						</span>
						<span className="sh-recent-meta">
							<span className="sh-recent-cwd">A fresh folder for one-off work</span>
						</span>
					</button>
				</li>
			</ul>
		</section>
	) : null;
	if (state.status === "loading") {
		return (
			<>
				{noProject}
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading folders…
				</div>
			</>
		);
	}
	if (state.status === "error") {
		return (
			<>
				{noProject}
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={onRetry}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			</>
		);
	}
	if (state.value.length === 0) {
		return (
			<>
				{noProject}
				<div className="sh-companion-empty">No folders yet. Run omp once in a project to list it here.</div>
			</>
		);
	}
	return (
		<>
			{noProject}
			<section className="sh-switch-section" aria-label="Folders">
				<h2 className="sh-recents-title">Pick a folder</h2>
				<ul className="sh-recents-list">
					{state.value.map(folder => (
						<li key={folder.cwd} className="sh-recent">
							<button type="button" className="sh-recent-join" onClick={() => onPick(folder)} title={folder.cwd}>
								<span className="sh-recent-title">
									<FolderOpen size={14} />
									<span className="sh-recent-name">{folderLabel(folder.cwd)}</span>
								</span>
								<span className="sh-recent-meta">
									<span className="sh-recent-cwd">
										{isProjectless(folder.cwd) ? "No project" : shortenPath(folder.cwd)}
									</span>
									<span>{relTime(folder.lastActive)}</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			</section>
		</>
	);
}
