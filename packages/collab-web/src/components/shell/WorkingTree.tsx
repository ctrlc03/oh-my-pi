import { ChevronRight, FileText, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import type { CompanionClient, GitFileChange, GitSnapshot } from "../../lib/companion";
import { relTime, splitPath } from "../../lib/format";
import type { DiffReview, ReviewScope } from "../../lib/review-comments";
import { useRequest } from "../../lib/use-request";
import type { ToolRenderHost } from "../../tool-render";
import { UnifiedDiff } from "./ReviewDiff";

export interface WorkingTreeProps {
	client: CompanionClient;
	instanceId: string;
	host: ToolRenderHost;
	/** null: commenting on diffs is off. */
	review: DiffReview | null;
}

/** Git state of the repository around the session's cwd, read through the companion. */
export function WorkingTree({ client, instanceId, host, review }: WorkingTreeProps): ReactNode {
	const load = useCallback(() => client.requestGit(instanceId), [client, instanceId]);
	const { state, reload } = useRequest(load);

	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Reading the working tree…
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div className="sh-tree-error">
				<div className="sh-connect-error">{state.message}</div>
				<button type="button" className="sh-btn" onClick={reload}>
					<RefreshCw size={14} /> Retry
				</button>
			</div>
		);
	}
	return (
		<GitView
			git={state.value}
			client={client}
			instanceId={instanceId}
			host={host}
			review={review}
			onRefresh={reload}
		/>
	);
}

interface GitViewProps {
	git: GitSnapshot;
	client: CompanionClient;
	instanceId: string;
	host: ToolRenderHost;
	review: DiffReview | null;
	onRefresh(): void;
}

function GitView({ git, client, instanceId, host, review, onRefresh }: GitViewProps): ReactNode {
	const [open, setOpen] = useState<string | null>(git.files.length === 1 ? (git.files[0]?.path ?? null) : null);
	const loadDiff = useCallback((file: string) => client.requestDiff(instanceId, file), [client, instanceId]);
	return (
		<>
			<div className="sh-tree-head">
				<span className="sh-tree-branch">
					<GitBranch size={14} />
					<span className="sh-tree-branch-name">{git.branch ?? "detached HEAD"}</span>
					{git.upstream !== null ? (
						<span className="sh-tree-sync" title={`tracking ${git.upstream}`}>
							{git.ahead === 0 && git.behind === 0 ? (
								"in sync"
							) : (
								<>
									{git.ahead > 0 && <span className="sh-change-add">↑{git.ahead}</span>}
									{git.behind > 0 && <span className="sh-change-del">↓{git.behind}</span>}
								</>
							)}
						</span>
					) : (
						git.branch !== null && <span className="sh-tree-sync">no upstream</span>
					)}
				</span>
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={onRefresh}
					aria-label="refresh working tree"
					title="refresh"
				>
					<RefreshCw size={15} />
				</button>
			</div>
			{git.files.length === 0 ? (
				<div className="sh-companion-empty">Working tree clean.</div>
			) : (
				<ul className="sh-changes">
					{git.files.map(file => (
						<TreeFile
							key={file.path}
							file={file}
							root={git.root}
							loadDiff={loadDiff}
							host={host}
							expanded={open === file.path}
							onToggle={() => setOpen(open === file.path ? null : file.path)}
							scope="tree"
							review={review}
						/>
					))}
				</ul>
			)}
			{git.commits.length > 0 && (
				<section className="sh-switch-section" aria-label="recent commits">
					<h2 className="sh-recents-title">Recent commits</h2>
					<ul className="sh-commits">
						{git.commits.map(commit => (
							<li key={commit.hash} className="sh-commit">
								<span className="sh-commit-subject">{commit.subject}</span>
								<span className="sh-recent-meta">
									<span>{commit.hash.slice(0, 7)}</span>
									<span className="sh-recent-cwd">{commit.author}</span>
									<span>{relTime(commit.time)}</span>
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}

/** Letter, tone and description for a `git status --porcelain` XY code. */
function statusBadge(status: string): { letter: string; tone: string; label: string } {
	if (status === "??") return { letter: "U", tone: "add", label: "untracked" };
	if (status.includes("U") || status === "AA" || status === "DD") {
		return { letter: "!", tone: "del", label: "merge conflict" };
	}
	const code = status[1] !== " " && status[1] !== undefined ? status[1] : (status[0] ?? "M");
	switch (code) {
		case "A":
			return { letter: "A", tone: "add", label: "added" };
		case "D":
			return { letter: "D", tone: "del", label: "deleted" };
		case "R":
			return { letter: "R", tone: "move", label: "renamed" };
		case "C":
			return { letter: "C", tone: "add", label: "copied" };
		default:
			return { letter: "M", tone: "mod", label: "modified" };
	}
}

export interface TreeFileProps {
	file: GitFileChange;
	root: string;
	/** Unified diff of one path; must be stable across renders. */
	loadDiff(path: string): Promise<{ diff: string; truncated: boolean }>;
	host: ToolRenderHost;
	expanded: boolean;
	onToggle(): void;
	scope: ReviewScope;
	/** null: commenting on the diff is off. */
	review: DiffReview | null;
}

/** One changed path: status, counts and, expanded, its lazily loaded diff. */
export function TreeFile({ file, root, loadDiff, host, expanded, onToggle, scope, review }: TreeFileProps): ReactNode {
	const { dir, base } = splitPath(file.path);
	const badge = statusBadge(file.status);
	const deleted = badge.tone === "del" && badge.letter === "D";
	return (
		<li className="sh-change">
			<button
				type="button"
				className="sh-change-head"
				onClick={onToggle}
				aria-expanded={expanded}
				title={`${file.path} · ${badge.label}`}
			>
				<ChevronRight size={14} className={expanded ? "tr-chev tr-chev--open" : "tr-chev"} />
				<span className={`sh-status-badge sh-status-badge-${badge.tone}`} aria-label={badge.label}>
					{badge.letter}
				</span>
				<span className="sh-change-path">
					<span className="sh-change-dir">{dir}</span>
					<span className="sh-change-base">{base}</span>
				</span>
				{file.added === null || file.removed === null ? (
					<span className="sh-tree-sync">binary</span>
				) : (
					<>
						{file.added > 0 && <span className="sh-change-add">+{file.added}</span>}
						{file.removed > 0 && <span className="sh-change-del">−{file.removed}</span>}
					</>
				)}
			</button>
			{expanded && (
				<div className="sh-change-body">
					<FileDiff loadDiff={loadDiff} scope={scope} path={file.path} review={review} />
					{!deleted && host.openFile !== undefined && (
						<button
							type="button"
							className="sh-btn sh-tree-open"
							onClick={() => host.openFile?.(`${root}/${file.path}`)}
						>
							<FileText size={14} /> View file
						</button>
					)}
				</div>
			)}
		</li>
	);
}

function FileDiff({
	loadDiff,
	scope,
	path,
	review,
}: {
	loadDiff(path: string): Promise<{ diff: string; truncated: boolean }>;
	scope: ReviewScope;
	path: string;
	review: DiffReview | null;
}): ReactNode {
	const load = useCallback(() => loadDiff(path), [loadDiff, path]);
	const { state } = useRequest(load);
	if (state.status === "loading") {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Loading diff…
			</div>
		);
	}
	if (state.status === "error") return <div className="sh-connect-error">{state.message}</div>;
	return (
		<>
			<UnifiedDiff diff={state.value.diff} scope={scope} path={path} review={review} />
			{state.value.truncated && <div className="sh-file-note">The diff is longer than the viewer reads.</div>}
		</>
	);
}
