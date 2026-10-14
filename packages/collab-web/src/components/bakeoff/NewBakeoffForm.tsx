import {
	BAKEOFF_MAX_CHALLENGERS,
	BAKEOFF_MAX_CUSTOM_CHARS,
	BAKEOFF_MAX_DOC_CHARS,
	BAKEOFF_MAX_INSTRUCTIONS_CHARS,
	BAKEOFF_MAX_METRICS,
	BAKEOFF_MIN_CHALLENGERS,
	type BakeoffMode,
	splitBakeoffBudget,
} from "@oh-my-pi/pi-wire/bakeoff";
import { Check, ChevronLeft, LoaderCircle, Play, RefreshCw, Star, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useId, useMemo, useState } from "react";
import { fanoutModelLabel, groupModelsByAgent } from "../../lib/agents";
import type { RunTarget } from "../../lib/companion";
import { type ComputerHandle, computerById, saveLastComputer, unavailableReason } from "../../lib/computers";
import type { FanoutModel } from "../../lib/fanout";
import { type RequestState, useRequest } from "../../lib/use-request";
import { parseLimit } from "../quiz/quiz-flow";
import { SubjectPicker, useSubjectPick } from "../shell/SubjectPicker";
import { createBakeoff, getBakeoffJudge } from "./bakeoff-api";
import {
	addCustom,
	type BakeoffFormValues,
	type BenchChoice,
	buildBakeoffCreate,
	BAKEOFF_MAX_COST_USD,
	DEFAULT_LIMIT,
	estimateBakeoffCost,
	estimateText,
	judgeOnByDefault,
	type JudgeView,
	judgeView,
	limitPreview,
	type MetricPick,
	metricCount,
	pickForMode,
	presetsFor,
	removeCustom,
	statesGoal,
	type TargetChoice,
	toggleStar,
	togglePreset,
	withoutForeign,
	customId,
} from "./bakeoff-flow";
import type { BakeoffDocInput, BakeoffTarget } from "./bakeoff-types";

export interface NewBakeoffFormProps {
	computers: readonly ComputerHandle[];
	target: BakeoffTarget;
	onBack(): void;
	onStarted(computerId: string, id: string): void;
	onClose(): void;
}

const EXTRA_CHOICES = [{ value: "doc", label: "A design document" }] as const;
/** Models listed per section of the picker, as the compare sheet lists them. */
const MAX_LISTED_MODELS = 60;
const NO_TARGET = "";

const MODES: { value: BakeoffMode; label: string; hint: string }[] = [
	{ value: "design", label: "Design only", hint: "Each entry writes a better design as a document." },
	{ value: "implementation", label: "Implementation", hint: "Each entry changes the code in its own worktree." },
];

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A model's price as dollars per million tokens, in and out. */
function priceText(model: FanoutModel): string | null {
	return model.cost === undefined ? null : `$${model.cost.input} in, $${model.cost.output} out`;
}

/**
 * The form that confirms what to compare and starts it: the session's changes, a branch, a pull request or a design
 * document, what matters, the challengers and the reviewer, the second opinion, the tests and the spending limit.
 */
export function NewBakeoffForm({ computers, target, onBack, onStarted, onClose }: NewBakeoffFormProps): ReactNode {
	const ids = useId();
	const computer = computerById(computers, target.computerId);
	const client = computer?.client ?? null;
	const startsOnDoc = target.subject.kind === "doc";
	const pick = useSubjectPick<"doc">({
		client,
		cwd: target.cwd,
		sessionId: target.sessionId,
		subject: target.subject.kind === "doc" ? { kind: "changes" } : target.subject,
		extra: ["doc"],
		startOn: startsOnDoc ? "doc" : undefined,
	});
	const { choice } = pick;
	const [attach, setAttach] = useState(target.doc !== undefined && !startsOnDoc);
	const [source, setSource] = useState<BakeoffDocInput["source"]>(target.doc?.source ?? "paste");
	const [name, setName] = useState(target.doc?.source === "paste" ? target.doc.name : "");
	const [text, setText] = useState(target.doc?.source === "paste" ? target.doc.text : "");
	const [path, setPath] = useState(target.doc?.source === "file" ? target.doc.path : "");
	const [useConversation, setUseConversation] = useState(true);
	const [chosenMode, setChosenMode] = useState<BakeoffMode>(target.mode ?? "design");
	const [start, setStart] = useState<"original" | "base">("original");
	const [goal, setGoal] = useState(target.goal ?? "");
	const [metricPick, setMetricPick] = useState<MetricPick>({ presets: ["simplicity"], customs: [], starred: null });
	const [customText, setCustomText] = useState("");
	const [instructions, setInstructions] = useState(target.instructions ?? "");
	const [challengers, setChallengers] = useState<string[]>([]);
	const [reviewer, setReviewer] = useState("");
	const [judgeUse, setJudgeUse] = useState<boolean | null>(null);
	const [judgeAdvisory, setJudgeAdvisory] = useState(false);
	const [testId, setTestId] = useState(NO_TARGET);
	const [benchId, setBenchId] = useState(NO_TARGET);
	const [better, setBetter] = useState<"lower" | "higher">("lower");
	const [valueRegex, setValueRegex] = useState("");
	const [limit, setLimit] = useState(DEFAULT_LIMIT);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The models the computer can run, as the compare sheet lists them (prices included when it has them).
	const modelsRequest = useRequest(
		useCallback(async () => (client === null ? [] : await client.requestFanoutModels()), [client]),
	);
	const judgeRequest = useRequest(
		useCallback(async () => {
			if (client === null) throw new Error("This computer is not connected.");
			return await getBakeoffJudge(client, target.cwd);
		}, [client, target.cwd]),
	);
	const judgeState = judgeRequest.state;
	const judge: JudgeView =
		judgeState.status === "ready"
			? judgeView(judgeState.value)
			: judgeState.status === "error"
				? { kind: "unreachable", message: `The judge model could not be checked: ${judgeState.message}` }
				: judgeView(null);

	const wantsDoc = choice === "doc" || attach;
	const overLimit = text.length > BAKEOFF_MAX_DOC_CHARS;
	const conversationOffered = target.sessionId !== null && (choice === "changes" || choice === "doc");

	// An implementation needs a change to start from and a computer that can start the sessions.
	const implementationReason =
		computer === null
			? "This computer is not connected."
			: (unavailableReason(computer, "fanout") ??
				unavailableReason(computer, "start") ??
				(choice === "doc" ? "An implementation needs a change to start from, not a design alone." : null));
	const mode: BakeoffMode = implementationReason === null ? chosenMode : "design";
	const implementation = mode === "implementation";
	const subject =
		choice === "doc" ? ({ kind: "doc" } as const) : (pick.picked ?? { kind: "pr" as const, number: 0, title: "" });
	const doc: BakeoffDocInput | null = !wantsDoc ? null : source === "file" ? { source, path } : { source, name, text };
	const metrics = pickForMode(metricPick, mode);
	const models = mode === "design" ? withoutForeign(challengers) : challengers;

	// The repository's own run targets: the session's host lists them.
	const canPickRuns = target.instanceId !== null && computer?.snap.canRun === true;
	const runTargets = useRequest(
		useCallback(async (): Promise<RunTarget[]> => {
			if (client === null || target.instanceId === null || !implementation || !canPickRuns) return [];
			return await client.requestRunTargets(target.instanceId);
		}, [client, target.instanceId, implementation, canPickRuns]),
	);
	const listedRuns = runTargets.state.status === "ready" ? runTargets.state.value : [];
	const testTarget = listedRuns.find(item => item.id === testId);
	const benchTarget = listedRuns.find(item => item.id === benchId);
	const testChoice: TargetChoice | null =
		testTarget === undefined
			? null
			: { target: testTarget.id, ...(testTarget.detail === undefined ? {} : { detail: testTarget.detail }) };
	const benchChoice: BenchChoice | null =
		benchTarget === undefined
			? null
			: {
					target: benchTarget.id,
					...(benchTarget.detail === undefined ? {} : { detail: benchTarget.detail }),
					better,
					valueRegex,
				};

	const values: BakeoffFormValues = {
		cwd: target.cwd,
		subject,
		sessionId: target.sessionId,
		useConversation,
		doc,
		mode,
		start,
		goal,
		metrics,
		instructions,
		models,
		reviewer,
		judge,
		judgeUse,
		judgeAdvisory,
		test: implementation ? testChoice : null,
		bench: implementation ? benchChoice : null,
		limit,
	};

	const modelList = modelsRequest.state.status === "ready" ? modelsRequest.state.value : [];
	const priceOf = (selector: string) => modelList.find(model => model.selector === selector)?.cost;
	const limitValue = parseLimit(limit);
	const estimate = estimateText(
		estimateBakeoffCost({ mode, challengers: models.map(priceOf), reviewer: priceOf(reviewer) }),
		limitValue,
	);
	const preview =
		limitValue === null || limitValue > BAKEOFF_MAX_COST_USD
			? null
			: limitPreview(limit, splitBakeoffBudget(limitValue, mode));
	const goalStated = statesGoal(values);

	const toggleChallenger = (selector: string): void =>
		setChallengers(prev =>
			prev.includes(selector)
				? prev.filter(item => item !== selector)
				: prev.length < BAKEOFF_MAX_CHALLENGERS
					? [...prev, selector]
					: prev,
		);

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		if (client === null) return setError("This computer is not connected.");
		if (choice !== "doc" && pick.picked === null) return setError("Pick a pull request.");
		const made = buildBakeoffCreate(values);
		if ("error" in made) return setError(made.error);
		setStarting(true);
		setError(null);
		try {
			const id = await createBakeoff(client, made.request);
			saveLastComputer(target.computerId);
			onStarted(target.computerId, id);
		} catch (err) {
			setError(errorText(err));
			setStarting(false);
		}
	};

	const addCustomText = (): void => {
		if (customText.trim() === "" || metricCount(metrics) >= BAKEOFF_MAX_METRICS) return;
		setMetricPick(addCustom(metricPick, customText));
		setCustomText("");
	};

	return (
		<form className="bo-form" onSubmit={e => void submit(e)}>
			<div className="sh-sheet-head">
				<button type="button" className="sh-btn sh-gh-back" onClick={onBack}>
					<ChevronLeft size={16} /> Bake-off
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<h2 className="bo-form-title">New bake-off</h2>
			<div className="bo-form-body">
				<SubjectPicker
					pick={pick}
					label="What to start from"
					summaryLabel="What the challengers will try to beat"
					used="compared"
					extraChoices={EXTRA_CHOICES}
					stacks={false}
					onChoose={() => setError(null)}
				/>
				{choice !== "doc" && (
					<label className="bo-form-check">
						<input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} />
						<span>
							Attach a design
							<span className="sh-field-hint"> (the document says what this change should do)</span>
						</span>
					</label>
				)}
				{wantsDoc && (
					<div className="sh-field">
						<span className="sh-field-label" id={`${ids}-doc`}>
							{choice === "doc" ? "The design" : "The design to attach"}
						</span>
						<div className="sh-segmented" role="radiogroup" aria-labelledby={`${ids}-doc`}>
							<button
								type="button"
								role="radio"
								aria-checked={source === "paste"}
								className={source === "paste" ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => setSource("paste")}
							>
								Paste text
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={source === "file"}
								className={source === "file" ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => setSource("file")}
							>
								File in the repository
							</button>
						</div>
						{source === "paste" ? (
							<>
								<input
									className="sh-input"
									type="text"
									aria-label="Name of the design"
									placeholder="Name (optional)"
									value={name}
									onChange={e => setName(e.target.value)}
								/>
								<textarea
									className="sh-input bo-form-doc"
									rows={8}
									aria-label="Design text"
									placeholder="Paste the design"
									spellCheck={false}
									value={text}
									onChange={e => setText(e.target.value)}
								/>
								<span className={overLimit ? "sh-field-hint bo-form-over" : "sh-field-hint"}>
									{text.length.toLocaleString("en-US")} / {BAKEOFF_MAX_DOC_CHARS.toLocaleString("en-US")}{" "}
									characters
								</span>
							</>
						) : (
							<>
								<input
									className="sh-input bo-form-path"
									type="text"
									aria-label="Path of the design"
									autoCapitalize="none"
									autoCorrect="off"
									spellCheck={false}
									placeholder="docs/design.md"
									value={path}
									onChange={e => setPath(e.target.value)}
								/>
								<span className="sh-field-hint">A file of this repository, read as the original has it.</span>
							</>
						)}
					</div>
				)}
				{conversationOffered && (
					<label className="bo-form-check">
						<input
							type="checkbox"
							checked={useConversation}
							onChange={e => setUseConversation(e.target.checked)}
						/>
						<span>
							Include why it was done
							<span className="sh-field-hint"> (uses this session's conversation)</span>
						</span>
					</label>
				)}

				<div className="sh-field">
					<span className="sh-field-label" id={`${ids}-mode`}>
						What each challenger produces
					</span>
					<div className="sh-segmented" role="radiogroup" aria-labelledby={`${ids}-mode`}>
						{MODES.map(item => {
							const blocked = item.value === "implementation" && implementationReason !== null;
							return (
								<button
									key={item.value}
									type="button"
									role="radio"
									aria-checked={mode === item.value}
									disabled={blocked}
									className={mode === item.value ? "sh-segment sh-segment-on" : "sh-segment"}
									onClick={() => setChosenMode(item.value)}
								>
									{item.label}
								</button>
							);
						})}
					</div>
					<span className="sh-field-hint">{MODES.find(item => item.value === mode)!.hint}</span>
					{implementationReason !== null && (
						<span className="sh-field-hint bo-form-why">Implementation is off: {implementationReason}</span>
					)}
				</div>

				{implementation && (
					<div className="sh-field">
						<span className="sh-field-label" id={`${ids}-start`}>
							Where the challengers start
						</span>
						<div className="sh-radios" role="radiogroup" aria-labelledby={`${ids}-start`}>
							<label className="sh-radio">
								<input
									type="radio"
									name={`${ids}-start`}
									checked={start === "original"}
									onChange={() => setStart("original")}
								/>
								<span>
									The original's code
									<span className="sh-field-hint"> (each one improves on it)</span>
								</span>
							</label>
							<label className="sh-radio">
								<input
									type="radio"
									name={`${ids}-start`}
									checked={start === "base"}
									onChange={() => setStart("base")}
								/>
								<span>
									The base (starting fresh)
									<span className="sh-field-hint"> (each one solves it on its own)</span>
								</span>
							</label>
						</div>
					</div>
				)}
				{implementation && start === "base" && (
					<label className="sh-field">
						<span className="sh-field-label">What should it solve?</span>
						<textarea
							className="sh-input bo-form-text"
							rows={3}
							placeholder="The problem, in a few sentences"
							value={goal}
							onChange={e => setGoal(e.target.value)}
						/>
						<span className="sh-field-hint">
							{goalStated
								? "Optional: the pull request, design or conversation already says."
								: "Needed: nothing else says what the problem is."}
						</span>
					</label>
				)}

				<div className="sh-field">
					<span className="sh-field-label" id={`${ids}-matters`}>
						What matters ({metricCount(metrics)} of {BAKEOFF_MAX_METRICS})
					</span>
					<ul className="bo-matters" aria-labelledby={`${ids}-matters`}>
						{presetsFor(mode).map(preset => {
							const on = metrics.presets.includes(preset.id);
							const starred = metrics.starred === preset.id;
							return (
								<li key={preset.id} className="bo-matters-row" data-on={on}>
									<label className="bo-form-check bo-matters-label">
										<input
											type="checkbox"
											checked={on}
											disabled={!on && metricCount(metrics) >= BAKEOFF_MAX_METRICS}
											onChange={() => setMetricPick(togglePreset(metrics, preset.id))}
										/>
										<span>
											{preset.label}
											<span className="sh-field-hint"> {preset.hint}</span>
										</span>
									</label>
									{on && (
										<button
											type="button"
											className="sh-btn sh-btn-icon bo-matters-star"
											aria-pressed={starred}
											aria-label={`Mark ${preset.label.toLowerCase()} as most important`}
											onClick={() => setMetricPick(toggleStar(metrics, preset.id))}
										>
											<Star size={15} fill={starred ? "currentColor" : "none"} />
										</button>
									)}
								</li>
							);
						})}
						{metrics.customs.map((custom, at) => {
							const key = customId(at);
							const starred = metrics.starred === key;
							return (
								<li key={`${key}:${custom}`} className="bo-matters-row" data-on="true">
									<span className="bo-matters-custom">{custom}</span>
									<button
										type="button"
										className="sh-btn sh-btn-icon bo-matters-star"
										aria-pressed={starred}
										aria-label="Mark this as most important"
										onClick={() => setMetricPick(toggleStar(metrics, key))}
									>
										<Star size={15} fill={starred ? "currentColor" : "none"} />
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon"
										aria-label="Remove this"
										onClick={() => setMetricPick(removeCustom(metrics, at))}
									>
										<X size={15} />
									</button>
								</li>
							);
						})}
					</ul>
					<div className="bo-matters-add">
						<input
							className="sh-input"
							type="text"
							aria-label="Something else that matters"
							placeholder="Something else that matters, in your own words"
							value={customText}
							maxLength={BAKEOFF_MAX_CUSTOM_CHARS}
							disabled={metricCount(metrics) >= BAKEOFF_MAX_METRICS}
							onChange={e => setCustomText(e.target.value)}
							onKeyDown={e => {
								if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
								e.preventDefault();
								addCustomText();
							}}
						/>
						<button
							type="button"
							className="sh-btn"
							disabled={customText.trim() === "" || metricCount(metrics) >= BAKEOFF_MAX_METRICS}
							onClick={addCustomText}
						>
							Add
						</button>
					</div>
					<span className="sh-field-hint">The star marks the one that counts most.</span>
				</div>

				<label className="sh-field">
					<span className="sh-field-label">Extra instructions (optional)</span>
					<textarea
						className="sh-input bo-form-text"
						rows={3}
						placeholder="Anything every challenger should know"
						value={instructions}
						maxLength={BAKEOFF_MAX_INSTRUCTIONS_CHARS}
						onChange={e => setInstructions(e.target.value)}
					/>
				</label>

				<ModelChoice
					label={`Challengers (${models.length} chosen, pick ${BAKEOFF_MIN_CHALLENGERS}–${BAKEOFF_MAX_CHALLENGERS})`}
					hint={
						mode === "design"
							? "Each writes a better design. Models from omp's own list."
							: "Each changes the code in its own worktree. Another vendor's agent can be one."
					}
					request={modelsRequest.state}
					reload={modelsRequest.reload}
					selected={models}
					max={BAKEOFF_MAX_CHALLENGERS}
					ompOnly={mode === "design"}
					onToggle={toggleChallenger}
				/>
				<ModelChoice
					label="Reviewer"
					hint="Reads every entry without knowing who wrote it."
					request={modelsRequest.state}
					reload={modelsRequest.reload}
					selected={reviewer === "" ? [] : [reviewer]}
					max={1}
					ompOnly
					onToggle={selector => setReviewer(prev => (prev === selector ? "" : selector))}
				/>

				<div className="sh-field bo-judge">
					<span className="sh-field-label">Second opinion</span>
					{judge.kind === "checking" && (
						<span className="sh-field-hint">
							<LoaderCircle size={12} className="sh-spin" /> Checking the judge model…
						</span>
					)}
					{judge.kind === "usable" && (
						<label className="bo-form-check">
							<input
								type="checkbox"
								checked={judgeUse ?? judgeOnByDefault(judge)}
								onChange={e => setJudgeUse(e.target.checked)}
							/>
							<span>
								Use the judge model
								<span className="sh-field-hint"> ({judge.label})</span>
							</span>
						</label>
					)}
					{judge.kind === "unreachable" && (
						<>
							<label className="bo-form-check">
								<input type="checkbox" checked={false} disabled readOnly />
								<span>Use the judge model</span>
							</label>
							<span className="sh-field-hint bo-form-why" role="status">
								{judge.message}
							</span>
							<button type="button" className="sh-btn bo-judge-retry" onClick={judgeRequest.reload}>
								<RefreshCw size={14} /> Check again
							</button>
						</>
					)}
					{judge.kind === "fallback" && (
						<>
							<label className="bo-form-check">
								<input
									type="checkbox"
									checked={judgeAdvisory}
									onChange={e => setJudgeAdvisory(e.target.checked)}
								/>
								<span>
									Use it anyway (advisory)
									<span className="sh-field-hint">
										{" "}
										No judge model is set, so this would use {judge.label ?? "a general model"}
										{judge.price === null ? "." : `, which costs ${judge.price}.`}
									</span>
								</span>
							</label>
						</>
					)}
					{judge.kind === "none" && (
						<>
							<label className="bo-form-check">
								<input type="checkbox" checked={false} disabled readOnly />
								<span>Use the judge model</span>
							</label>
							<span className="sh-field-hint">{judge.message}</span>
						</>
					)}
				</div>

				{implementation && (
					<div className="sh-field">
						<span className="sh-field-label">Tests and speed</span>
						{target.instanceId === null ? (
							<span className="sh-field-hint">Open this from a session to pick tests.</span>
						) : !canPickRuns ? (
							<span className="sh-field-hint">This computer cannot list the repository's commands.</span>
						) : runTargets.state.status === "loading" ? (
							<span className="sh-field-hint">
								<LoaderCircle size={12} className="sh-spin" /> Looking for the repository's commands…
							</span>
						) : runTargets.state.status === "error" ? (
							<span className="sh-field-hint bo-form-why">
								{runTargets.state.message}{" "}
								<button type="button" className="sh-btn" onClick={runTargets.reload}>
									<RefreshCw size={14} /> Retry
								</button>
							</span>
						) : (
							<>
								<RunPick
									label="Test command"
									value={testId}
									none="No tests"
									targets={listedRuns}
									onChange={setTestId}
									selected={testTarget}
								/>
								<RunPick
									label="Benchmark (optional)"
									value={benchId}
									none="No benchmark"
									targets={listedRuns}
									onChange={setBenchId}
									selected={benchTarget}
								/>
								{benchTarget !== undefined && (
									<>
										<div className="sh-segmented" role="radiogroup" aria-label="Which result is better">
											<button
												type="button"
												role="radio"
												aria-checked={better === "lower"}
												className={better === "lower" ? "sh-segment sh-segment-on" : "sh-segment"}
												onClick={() => setBetter("lower")}
											>
												Lower is better
											</button>
											<button
												type="button"
												role="radio"
												aria-checked={better === "higher"}
												className={better === "higher" ? "sh-segment sh-segment-on" : "sh-segment"}
												onClick={() => setBetter("higher")}
											>
												Higher is better
											</button>
										</div>
										<input
											className="sh-input bo-form-path"
											type="text"
											aria-label="Pattern for the benchmark's number"
											autoCapitalize="none"
											autoCorrect="off"
											spellCheck={false}
											placeholder="Pattern for the number it prints (optional)"
											value={valueRegex}
											onChange={e => setValueRegex(e.target.value)}
										/>
										<span className="sh-field-hint">
											Leave the pattern empty to compare how long the benchmark takes.
										</span>
									</>
								)}
							</>
						)}
					</div>
				)}

				<label className="sh-field">
					<span className="sh-field-label">Spending limit (USD)</span>
					<input
						className="sh-input bo-form-limit"
						type="number"
						inputMode="decimal"
						min="0.1"
						max={BAKEOFF_MAX_COST_USD}
						step="any"
						value={limit}
						onChange={e => setLimit(e.target.value)}
					/>
					<span className="sh-field-hint">The bake-off stops when it has spent this much.</span>
					{preview !== null && <span className="sh-field-hint">{preview}</span>}
					{estimate !== null && <span className="sh-field-hint">{estimate}</span>}
				</label>
			</div>
			{error !== null && (
				<div className="sh-connect-error" role="alert">
					{error}
				</div>
			)}
			<div className="bo-form-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={starting || client === null}>
					{starting ? <LoaderCircle size={14} className="sh-spin" /> : <Play size={14} />} Start the bake-off
				</button>
			</div>
		</form>
	);
}

interface RunPickProps {
	label: string;
	value: string;
	none: string;
	targets: readonly RunTarget[];
	selected: RunTarget | undefined;
	onChange(id: string): void;
}

/** One of the repository's commands, with what it runs shown before it is chosen to run. */
function RunPick({ label, value, none, targets, selected, onChange }: RunPickProps): ReactNode {
	return (
		<div className="bo-pick">
			<select className="sh-input" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
				<option value={NO_TARGET}>{none}</option>
				{targets.map(item => (
					<option key={item.id} value={item.id}>
						{item.command}
					</option>
				))}
			</select>
			{selected !== undefined && (
				<div className="bo-pick-detail">
					<code>{selected.command}</code>
					{selected.detail !== undefined && <pre>{selected.detail}</pre>}
				</div>
			)}
		</div>
	);
}

interface ModelChoiceProps {
	label: string;
	hint: string;
	request: RequestState<FanoutModel[]>;
	reload(): void;
	selected: readonly string[];
	max: number;
	/** Offer only omp's own models. */
	ompOnly: boolean;
	onToggle(selector: string): void;
}

/** Models of the compare sheet's list to pick from: a filter over them grouped by the agent that runs them. */
function ModelChoice({ label, hint, request, reload, selected, max, ompOnly, onToggle }: ModelChoiceProps): ReactNode {
	const [filter, setFilter] = useState("");
	const all = request.status === "ready" ? request.value : [];
	const groups = useMemo(() => {
		const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
		const matching = all.filter(model => {
			if (ompOnly && model.agent !== undefined) return false;
			const haystack = `${model.selector} ${model.name} ${model.agent?.name ?? ""}`.toLowerCase();
			return words.every(word => haystack.includes(word));
		});
		return groupModelsByAgent(matching).map(group => ({
			...group,
			models: group.models.slice(0, MAX_LISTED_MODELS),
		}));
	}, [all, filter, ompOnly]);
	const names = useMemo(() => new Map(all.map(model => [model.selector, fanoutModelLabel(model)])), [all]);
	const full = selected.length >= max;
	return (
		<div className="sh-field">
			<span className="sh-field-label">{label}</span>
			{selected.length > 0 && (
				<ul className="bo-model-chosen" aria-label="Chosen models">
					{selected.map(selector => (
						<li key={selector}>
							<button
								type="button"
								className="sh-chip bo-model-chip"
								onClick={() => onToggle(selector)}
								aria-label={`Remove ${names.get(selector) ?? selector}`}
							>
								{names.get(selector) ?? selector} <X size={11} />
							</button>
						</li>
					))}
				</ul>
			)}
			<input
				className="sh-input"
				value={filter}
				onChange={e => setFilter(e.currentTarget.value)}
				placeholder="Filter models"
				aria-label="Filter models"
				autoCapitalize="off"
				autoCorrect="off"
				spellCheck={false}
			/>
			{request.status === "loading" ? (
				<div className="sh-companion-empty">Loading models…</div>
			) : request.status === "error" ? (
				<div className="sh-companion-offline">
					<span>{request.message}</span>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			) : groups.length === 0 ? (
				<div className="sh-companion-empty">No model matches.</div>
			) : (
				<ul className="bo-model-list" aria-label="Models">
					{groups.flatMap(group => [
						groups.length > 1 && (
							<li key={`agent:${group.agent.id}`} className="bo-model-agent">
								{group.agent.name}
							</li>
						),
						...group.models.map(model => {
							const on = selected.includes(model.selector);
							const price = priceText(model);
							return (
								<li key={model.selector}>
									<button
										type="button"
										className={on ? "sh-model sh-model-on" : "sh-model"}
										onClick={() => onToggle(model.selector)}
										// A one-model choice swaps; a longer one stops at its ceiling.
										disabled={!on && full && max > 1}
										aria-pressed={on}
									>
										<span className="bo-model-name">{model.name}</span>
										<span className="sh-sheet-faint">
											{model.provider}
											{price !== null && ` · ${price}`}
											{on && <Check size={13} />}
										</span>
									</button>
								</li>
							);
						}),
					])}
				</ul>
			)}
			<span className="sh-field-hint">{hint} Prices, where listed, are dollars per million tokens.</span>
		</div>
	);
}
