import { ChevronRight, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { CompanionClient, GitFileChange } from "../../../lib/companion";
import { splitPath } from "../../../lib/format";
import { useAgentLines } from "../../../lib/line-attribution";
import { useRequest } from "../../../lib/use-request";
import { UnifiedDiff } from "../../shell/ReviewDiff";
import { badgeOf, filesIn, GROUP_LABEL, GROUP_ORDER, toTreePath } from "./git-status";
import type { GitStatus } from "./use-git-status";

export interface ChangesViewProps {
	client: CompanionClient;
	instanceId: string;
	status: GitStatus;
	/** Root of the file tree: changed paths are opened relative to it. */
	treeRoot: string | null;
	onOpen(path: string): void;
}

/** The working tree grouped as git groups it: conflicts, staged, changed and untracked files, each with its diff on demand. */
export function ChangesView({ client, instanceId, status, treeRoot, onOpen }: ChangesViewProps): ReactNode {
	const { git, error, loading, refresh } = status;
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const groups = useMemo(
		() =>
			git === null
				? []
				: GROUP_ORDER.map(group => ({ group, files: filesIn(git.files, group) })).filter(g => g.files.length > 0),
		[git],
	);
	const loadDiff = useCallback((path: string) => client.requestDiff(instanceId, path), [client, instanceId]);
	const toggle = (key: string): void =>
		setOpen(previous => {
			const next = new Set(previous);
			if (!next.delete(key)) next.add(key);
			return next;
		});

	return (
		<>
			<div className="sh-ex-tools">
				<span className="sh-ex-branch" title={git?.upstream ? `Tracking ${git.upstream}` : undefined}>
					<GitBranch size={13} />
					<span className="sh-ex-branch-name">
						{git === null ? "Working tree" : (git.branch ?? "detached HEAD")}
					</span>
					{git !== null && git.ahead > 0 && <span className="sh-ex-add">↑{git.ahead}</span>}
					{git !== null && git.behind > 0 && <span className="sh-ex-del">↓{git.behind}</span>}
				</span>
				<button
					type="button"
					className="sh-ex-icon-btn"
					onClick={refresh}
					aria-label="Refresh changes"
					title="Refresh"
				>
					{loading ? <LoaderCircle size={14} className="sh-spin" /> : <RefreshCw size={14} />}
				</button>
			</div>
			<div className="sh-ex-scroll">
				{git === null ? (
					error !== null ? (
						<div className="sh-ex-note sh-ex-note-err" role="alert">
							{error}
							<button type="button" className="sh-btn" onClick={refresh}>
								Retry
							</button>
						</div>
					) : (
						<div className="sh-ex-note">
							<LoaderCircle size={14} className="sh-spin" /> Reading the working tree…
						</div>
					)
				) : groups.length === 0 ? (
					<div className="sh-ex-note">Working tree clean.</div>
				) : (
					groups.map(({ group, files }) => (
						<section key={group} className="sh-ex-group" aria-label={GROUP_LABEL[group]}>
							<h3 className="sh-ex-heading">
								{GROUP_LABEL[group]}
								<span className="sh-ex-count">{files.length}</span>
							</h3>
							<ul className="sh-ex-list">
								{files.map(file => {
									const key = `${group}:${file.path}`;
									return (
										<ChangeRow
											key={key}
											file={file}
											open={open.has(key)}
											onToggle={() => toggle(key)}
											onOpen={() => {
												const path =
													treeRoot === null ? file.path : toTreePath(file.path, git.root, treeRoot);
												if (path !== null) onOpen(path);
											}}
											loadDiff={loadDiff}
											attribution={{ client, instanceId, path: `${git.root}/${file.path}` }}
										/>
									);
								})}
							</ul>
						</section>
					))
				)}
				{git !== null && error !== null && <div className="sh-ex-note sh-ex-note-err">{error}</div>}
			</div>
		</>
	);
}

interface AttributionTarget {
	client: CompanionClient;
	instanceId: string;
	path: string;
}

interface ChangeRowProps {
	file: GitFileChange;
	open: boolean;
	onToggle(): void;
	onOpen(): void;
	loadDiff(path: string): Promise<{ diff: string; truncated: boolean }>;
	/** Where to ask which lines agents wrote: the file's absolute path in the session's worktree. */
	attribution: AttributionTarget;
}

function ChangeRow({ file, open, onToggle, onOpen, loadDiff, attribution }: ChangeRowProps): ReactNode {
	const { dir, base } = splitPath(file.path);
	const badge = badgeOf(file.status);
	// A deleted file has nothing to open; its diff is what there is to see.
	const deleted = badge.letter === "D";
	return (
		<li className="sh-ex-change">
			<div className="sh-ex-change-head">
				<button
					type="button"
					className="sh-ex-icon-btn"
					onClick={onToggle}
					aria-expanded={open}
					aria-label={`${open ? "Hide" : "Show"} the diff of ${file.path}`}
					title="Diff"
				>
					<ChevronRight size={13} className={open ? "tr-chev tr-chev--open" : "tr-chev"} />
				</button>
				<button
					type="button"
					className="sh-ex-row sh-ex-change-open"
					onClick={deleted ? onToggle : onOpen}
					title={`${file.path} · ${badge.label}`}
				>
					<span className="sh-ex-badge" data-tone={badge.tone} title={badge.label}>
						{badge.letter}
					</span>
					<span className="sh-ex-name">{base}</span>
					{dir.length > 0 && <span className="sh-ex-dir">{dir}</span>}
					{file.added === null || file.removed === null ? (
						<span className="sh-ex-counts">binary</span>
					) : (
						<span className="sh-ex-counts">
							{file.added > 0 && <span className="sh-ex-add">+{file.added}</span>}
							{file.removed > 0 && <span className="sh-ex-del">−{file.removed}</span>}
						</span>
					)}
				</button>
			</div>
			{open && <InlineDiff path={file.path} loadDiff={loadDiff} attribution={attribution} />}
		</li>
	);
}

function InlineDiff({
	path,
	loadDiff,
	attribution,
}: {
	path: string;
	loadDiff(path: string): Promise<{ diff: string; truncated: boolean }>;
	attribution: AttributionTarget;
}): ReactNode {
	const load = useCallback(() => loadDiff(path), [loadDiff, path]);
	const { state } = useRequest(load);
	const agentLines = useAgentLines(attribution.client, attribution.instanceId, attribution.path);
	if (state.status === "loading") {
		return (
			<div className="sh-ex-note">
				<LoaderCircle size={14} className="sh-spin" /> Loading diff…
			</div>
		);
	}
	if (state.status === "error") return <div className="sh-ex-note sh-ex-note-err">{state.message}</div>;
	return (
		<div className="sh-ex-diff">
			<UnifiedDiff diff={state.value.diff} scope="tree" path={path} review={null} agentLines={agentLines} />
			{state.value.truncated && <div className="sh-ex-note">The diff is longer than the viewer reads.</div>}
		</div>
	);
}
