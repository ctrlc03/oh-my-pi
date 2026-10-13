import type { BlueprintCreate, BlueprintRefsAnswer } from "@oh-my-pi/pi-wire/blueprint";
import { ChevronLeft, LoaderCircle, Play, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompanionClient } from "../../lib/companion";
import { shortenPath } from "../../lib/format";
import { useRequest } from "../../lib/use-request";
import { createBlueprint, getBlueprintRefs } from "./blueprint-api";

export type MapMode = "branch" | "pr" | "worktree";

/** What the form starts with: from a pull request's sheet, or from "map what changed". */
export interface NewMapPreset {
	mode?: MapMode;
	/** Folder (any folder of the repository). */
	cwd?: string;
	branch?: string;
	pr?: { number: number; title: string };
	/** `@default`, `HEAD`, or a branch. */
	base?: string;
}

export interface NewMapFormProps {
	client: CompanionClient;
	/** The session's folder; null from the start screen, where any recent folder can be picked. */
	cwd: string | null;
	preset?: NewMapPreset;
	onBack(): void;
	onStarted(id: string): void;
	onClose(): void;
}

const MODES: { value: MapMode; label: string }[] = [
	{ value: "branch", label: "A branch" },
	{ value: "pr", label: "A pull request" },
	{ value: "worktree", label: "Uncommitted work" },
];

const DEFAULT_LIMIT_USD = "2";
const FILTER_DEBOUNCE_MS = 250;
const NO_REFS: BlueprintRefsAnswer = { branches: [] };

/** The form that starts a map: which repository, what to map, what to compare with, and how much to spend. */
export function NewMapForm({ client, cwd, preset, onBack, onStarted, onClose }: NewMapFormProps): ReactNode {
	const [repo, setRepo] = useState(cwd ?? preset?.cwd ?? "");
	const [mode, setMode] = useState<MapMode>(preset?.mode ?? "branch");
	const [branch, setBranch] = useState<string | null>(preset?.branch ?? null);
	const [pr, setPr] = useState<number | null>(preset?.pr?.number ?? null);
	const [compare, setCompare] = useState(preset?.base ?? (preset?.mode === "worktree" ? "@default" : ""));
	const [limit, setLimit] = useState(DEFAULT_LIMIT_USD);
	const [filter, setFilter] = useState("");
	const [query, setQuery] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => setQuery(filter.trim()), FILTER_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [filter]);

	const folders = useRequest(useCallback(() => client.requestFolders(), [client]));
	const repos = useMemo(() => {
		const list: string[] = [];
		const add = (path: string | null | undefined): void => {
			if (path !== null && path !== undefined && path !== "" && !list.includes(path)) list.push(path);
		};
		add(cwd);
		add(preset?.cwd);
		if (folders.state.status === "ready") for (const folder of folders.state.value) add(folder.cwd);
		return list;
	}, [cwd, preset?.cwd, folders.state]);
	useEffect(() => {
		if (repo === "" && repos.length > 0) setRepo(repos[0]!);
	}, [repo, repos]);

	const load = useCallback(
		(): Promise<BlueprintRefsAnswer> =>
			repo === "" ? Promise.resolve(NO_REFS) : getBlueprintRefs(client, repo, query || undefined),
		[client, repo, query],
	);
	const refs = useRequest(load);
	const answer = refs.state.status === "ready" ? refs.state.value : NO_REFS;
	const refsLoading = refs.state.status === "loading";
	// The picked branch defaults to the checked-out one once the list is known.
	const effectiveBranch = branch ?? answer.current ?? null;
	const prs = useMemo(() => {
		const list = answer.prs ?? [];
		const given = preset?.pr;
		if (given === undefined || list.some(item => item.number === given.number)) return list;
		return [{ number: given.number, title: given.title, head: "", base: "" }, ...list];
	}, [answer.prs, preset?.pr]);

	const compareChoices = useMemo(
		() => answer.branches.filter(name => name !== effectiveBranch),
		[answer.branches, effectiveBranch],
	);

	const submit = async (e: FormEvent): Promise<void> => {
		e.preventDefault();
		const maxCostUsd = Number(limit);
		if (repo === "") return setError("Pick the repository to map.");
		if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) return setError("The cost limit must be more than $0.");
		if (mode === "pr" && pr === null) return setError("Pick a pull request.");
		const request: BlueprintCreate = { cwd: repo, maxCostUsd };
		if (mode === "branch" && branch !== null) request.ref = branch;
		else if (mode === "pr") request.ref = `pr/${pr}`;
		else if (mode === "worktree") request.ref = "@worktree";
		if (compare !== "") request.base = compare;
		setStarting(true);
		setError(null);
		try {
			onStarted(await createBlueprint(client, request));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStarting(false);
		}
	};

	return (
		<form className="ar-form" onSubmit={e => void submit(e)}>
			<div className="sh-sheet-head">
				<button type="button" className="sh-btn sh-gh-back" onClick={onBack}>
					<ChevronLeft size={16} /> Maps
				</button>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
					<X size={16} />
				</button>
			</div>
			<h2 className="ar-form-title">New architecture map</h2>
			<div className="ar-form-body">
				{repos.length !== 1 && (
					<label className="sh-field">
						<span className="sh-field-label">Repository</span>
						<select className="sh-input" value={repo} onChange={e => setRepo(e.target.value)}>
							{repo === "" && <option value="">Choose a folder…</option>}
							{repos.map(path => (
								<option key={path} value={path}>
									{shortenPath(path)}
								</option>
							))}
						</select>
						<span className="sh-field-hint">Any folder of a git repository on this computer.</span>
					</label>
				)}
				{repos.length === 1 && (
					<div className="sh-field">
						<span className="sh-field-label">Repository</span>
						<code className="ar-fixed">{shortenPath(repos[0]!)}</code>
					</div>
				)}
				<div className="sh-field">
					<span className="sh-field-label" id="ar-what">
						What to map
					</span>
					<div className="sh-segmented sh-segmented-wrap" role="radiogroup" aria-labelledby="ar-what">
						{MODES.map(item => (
							<button
								key={item.value}
								type="button"
								role="radio"
								aria-checked={mode === item.value}
								className={mode === item.value ? "sh-segment sh-segment-on" : "sh-segment"}
								onClick={() => {
									setMode(item.value);
									if (item.value === "worktree" && compare === "") setCompare("@default");
								}}
							>
								{item.label}
							</button>
						))}
					</div>
				</div>
				{mode !== "worktree" && (
					<div className="sh-field">
						<input
							className="sh-input"
							type="search"
							placeholder={mode === "branch" ? "Filter branches" : "Filter pull requests"}
							aria-label={mode === "branch" ? "Filter branches" : "Filter pull requests"}
							value={filter}
							onChange={e => setFilter(e.target.value)}
						/>
					</div>
				)}
				{mode === "branch" && (
					<div className="sh-field">
						<span className="sh-field-label">Branch</span>
						{refs.state.status === "error" ? (
							<div className="sh-connect-error">{refs.state.message}</div>
						) : (
							<select
								className="sh-input"
								size={Math.min(8, Math.max(3, answer.branches.length))}
								value={effectiveBranch ?? ""}
								onChange={e => setBranch(e.target.value)}
								aria-label="Branch"
								disabled={repo === ""}
							>
								{answer.branches.map(name => (
									<option key={name} value={name}>
										{name}
										{name === answer.current ? " (checked out)" : ""}
									</option>
								))}
							</select>
						)}
						{refsLoading && (
							<span className="sh-field-hint">
								<LoaderCircle size={12} className="sh-spin" /> Reading the repository…
							</span>
						)}
					</div>
				)}
				{mode === "pr" && (
					<div className="sh-field">
						<span className="sh-field-label">Pull request</span>
						{refs.state.status === "error" ? (
							<div className="sh-connect-error">{refs.state.message}</div>
						) : prs.length === 0 && !refsLoading ? (
							<span className="sh-field-hint">No open pull requests found for this repository.</span>
						) : (
							<ul className="ar-prs" role="radiogroup" aria-label="Pull request">
								{prs.map(item => (
									<li key={item.number}>
										<button
											type="button"
											role="radio"
											aria-checked={pr === item.number}
											className={pr === item.number ? "ar-pr ar-pr-on" : "ar-pr"}
											onClick={() => setPr(item.number)}
										>
											<span className="ar-pr-title">
												#{item.number} {item.title}
											</span>
											{item.head !== "" && (
												<span className="ar-pr-branches">
													{item.head} → {item.base}
												</span>
											)}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				{mode === "worktree" && (
					<p className="ar-form-note">
						Maps the folder as it is now, including changes not committed yet. The checkout is not touched.
					</p>
				)}
				<label className="sh-field">
					<span className="sh-field-label">Compare with</span>
					<select className="sh-input" value={compare} onChange={e => setCompare(e.target.value)}>
						<option value="">
							{mode === "pr" ? "The pull request's base branch" : "Nothing: map the whole repository"}
						</option>
						<option value="@default">The default branch (changes since it)</option>
						{mode === "worktree" && <option value="HEAD">The last commit (uncommitted changes only)</option>}
						{compareChoices.map(name => (
							<option key={name} value={name}>
								{name}
							</option>
						))}
					</select>
					<span className="sh-field-hint">
						{compare === "" && mode !== "pr"
							? "A whole-repository map. Compare to see what a branch changed: added, changed and removed parts are marked."
							: "A changes map: parts added, changed and removed are marked, and “Show only changes” hides the rest."}
					</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">Cost limit (USD)</span>
					<input
						className="sh-input ar-limit"
						type="number"
						inputMode="decimal"
						min="0.1"
						step="any"
						value={limit}
						onChange={e => setLimit(e.target.value)}
					/>
					<span className="sh-field-hint">
						An agent writes the top diagrams and stops at this cost. The diagrams below them come from the code
						index and cost nothing.
					</span>
				</label>
			</div>
			{error !== null && (
				<div className="sh-connect-error" role="alert">
					{error}
				</div>
			)}
			<div className="ar-form-actions">
				<button type="submit" className="sh-btn sh-btn-primary" disabled={starting || repo === ""}>
					{starting ? <LoaderCircle size={14} className="sh-spin" /> : <Play size={14} />} Start
				</button>
			</div>
		</form>
	);
}
