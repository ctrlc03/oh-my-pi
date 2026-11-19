import {
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	Folder,
	FolderOpen,
	LoaderCircle,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { FileTree } from "../../../lib/companion";
import { setPathDrag } from "../../../lib/drop";
import { ancestors, baseName, buildTree, quickOpen, type TreeDir } from "../file-tree";
import type { TreeStatus } from "./git-status";

/**
 * Props that make a row draggable into the message box, where it becomes an `@path` mention. A row stays a button, so a
 * plain click still opens or toggles it; only a real drag starts one.
 */
function dragProps(path: string, dir: boolean): Pick<HTMLAttributes<HTMLElement>, "draggable" | "onDragStart"> {
	return { draggable: true, onDragStart: event => setPathDrag(event.dataTransfer, { path, dir }) };
}

/** Rows the filter lists. */
const FILTER_ROWS = 200;

export interface FilesViewProps {
	tree: FileTree | null;
	treeError: string | null;
	onReloadTree(): void;
	activePath: string | null;
	expanded: ReadonlySet<string>;
	onToggleDir(path: string): void;
	onOpen(path: string): void;
	/** null until the working tree has been read (or when it cannot be): no decorations. */
	status: TreeStatus | null;
}

/** The repository's folders and files, with git decorations; a filter box flattens it to the files that match. */
export function FilesView({
	tree,
	treeError,
	onReloadTree,
	activePath,
	expanded,
	onToggleDir,
	onOpen,
	status,
}: FilesViewProps): ReactNode {
	const [filter, setFilter] = useState("");
	const [cursor, setCursor] = useState(0);
	const list = useRef<HTMLDivElement>(null);
	const root = useMemo(() => (tree === null ? null : buildTree(tree.files)), [tree]);
	const matches = useMemo(
		() => (tree === null || filter.trim().length === 0 ? null : quickOpen(filter, tree.files, FILTER_ROWS)),
		[tree, filter],
	);

	// Reveal the active file: open the folders around it that are shut, then bring its row into view. The folders
	// are opened once per file, so closing one afterwards sticks.
	const reveal = useRef<string | null>(null);
	const latest = useRef({ expanded, onToggleDir });
	latest.current = { expanded, onToggleDir };
	useEffect(() => {
		if (activePath === null) return;
		reveal.current = activePath;
		for (const dir of ancestors(activePath)) {
			if (!latest.current.expanded.has(dir)) latest.current.onToggleDir(dir);
		}
	}, [activePath]);
	useEffect(() => {
		if (reveal.current === null || reveal.current !== activePath) return;
		const row = list.current?.querySelector('[data-active="true"]');
		if (row === null || row === undefined) return;
		row.scrollIntoView({ block: "nearest" });
		reveal.current = null;
	});

	useEffect(() => {
		list.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
	}, [cursor, matches]);

	const onFilterKey = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Escape" && filter.length > 0) {
			event.preventDefault();
			setFilter("");
		} else if (matches !== null && matches.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setCursor(Math.min(cursor + 1, matches.length - 1));
			} else if (event.key === "ArrowUp") {
				event.preventDefault();
				setCursor(Math.max(cursor - 1, 0));
			} else if (event.key === "Enter") {
				event.preventDefault();
				const path = matches[Math.min(cursor, matches.length - 1)];
				if (path !== undefined) onOpen(path);
			}
		}
	};

	return (
		<>
			<div className="sh-ex-tools">
				<label className="sh-ex-filter">
					<Search size={13} aria-hidden="true" />
					<input
						type="text"
						className="sh-ex-input"
						value={filter}
						onChange={event => {
							setFilter(event.target.value);
							setCursor(0);
						}}
						onKeyDown={onFilterKey}
						placeholder="Filter files"
						aria-label="Filter files"
						spellCheck={false}
						autoComplete="off"
						autoCapitalize="off"
					/>
					{filter.length > 0 && (
						<button
							type="button"
							className="sh-ex-icon-btn"
							onClick={() => setFilter("")}
							aria-label="Clear filter"
						>
							<X size={13} />
						</button>
					)}
				</label>
				<button
					type="button"
					className="sh-ex-icon-btn"
					onClick={() => {
						// Copied first: a toggle may replace or change the set while it is walked.
						for (const dir of Array.from(expanded)) onToggleDir(dir);
					}}
					disabled={expanded.size === 0}
					aria-label="Collapse all folders"
					title="Collapse all"
				>
					<ChevronsDownUp size={14} />
				</button>
				<button
					type="button"
					className="sh-ex-icon-btn"
					onClick={onReloadTree}
					aria-label="Reload files"
					title="Reload files"
				>
					<RefreshCw size={14} />
				</button>
			</div>
			<div className="sh-ex-scroll" ref={list}>
				{tree === null || root === null ? (
					treeError !== null ? (
						<div className="sh-ex-note sh-ex-note-err" role="alert">
							{treeError}
							<button type="button" className="sh-btn" onClick={onReloadTree}>
								Retry
							</button>
						</div>
					) : (
						<div className="sh-ex-note">
							<LoaderCircle size={14} className="sh-spin" /> Reading files…
						</div>
					)
				) : matches !== null ? (
					matches.length === 0 ? (
						<div className="sh-ex-note">No files match “{filter.trim()}”.</div>
					) : (
						<ul className="sh-ex-list" role="listbox" aria-label="Matching files">
							{matches.map((path, i) => {
								const badge = status?.files.get(path);
								const at = path.lastIndexOf("/");
								return (
									<li key={path} role="option" aria-selected={i === cursor}>
										<button
											type="button"
											className="sh-ex-row"
											data-active={path === activePath ? "true" : undefined}
											data-cursor={i === cursor ? "true" : undefined}
											style={{ paddingInlineStart: 8 }}
											onClick={() => onOpen(path)}
											{...dragProps(path, false)}
											title={path}
										>
											<span className="sh-ex-name" data-tone={badge?.tone}>
												{baseName(path)}
											</span>
											{at > 0 && <span className="sh-ex-dir">{path.slice(0, at)}</span>}
											{badge !== undefined && (
												<span className="sh-ex-badge" data-tone={badge.tone} title={badge.label}>
													{badge.letter}
												</span>
											)}
										</button>
									</li>
								);
							})}
						</ul>
					)
				) : (
					<>
						<Branch
							dir={root}
							depth={0}
							expanded={expanded}
							activePath={activePath}
							status={status}
							onToggle={onToggleDir}
							onOpen={onOpen}
						/>
						{tree.files.length === 0 && <div className="sh-ex-note">This folder has no files.</div>}
						{tree.truncated && (
							<div className="sh-ex-note">
								Only the first {tree.files.length.toLocaleString()} files are listed. Filter or search to find
								the rest.
							</div>
						)}
					</>
				)}
			</div>
		</>
	);
}

interface BranchProps {
	dir: TreeDir;
	depth: number;
	expanded: ReadonlySet<string>;
	activePath: string | null;
	status: TreeStatus | null;
	onToggle(path: string): void;
	onOpen(path: string): void;
}

const Branch = memo(function Branch({
	dir,
	depth,
	expanded,
	activePath,
	status,
	onToggle,
	onOpen,
}: BranchProps): ReactNode {
	return (
		<ul className="sh-ex-list" role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "Files" : undefined}>
			{dir.dirs.map(child => {
				const open = expanded.has(child.path);
				return (
					<li key={child.path} role="treeitem" aria-expanded={open}>
						<button
							type="button"
							className="sh-ex-row"
							style={{ paddingInlineStart: 6 + depth * 12 }}
							onClick={() => onToggle(child.path)}
							{...dragProps(child.path, true)}
							title={child.path}
						>
							{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
							{open ? (
								<FolderOpen size={13} className="sh-ex-folder" />
							) : (
								<Folder size={13} className="sh-ex-folder" />
							)}
							<span className="sh-ex-name">{child.name}</span>
							{status?.folders.has(child.path) === true && (
								<span className="sh-ex-dot" role="img" aria-label="Contains changes" title="Contains changes" />
							)}
						</button>
						{open && (
							<Branch
								dir={child}
								depth={depth + 1}
								expanded={expanded}
								activePath={activePath}
								status={status}
								onToggle={onToggle}
								onOpen={onOpen}
							/>
						)}
					</li>
				);
			})}
			{dir.files.map(path => {
				const badge = status?.files.get(path);
				return (
					<li key={path} role="treeitem" aria-selected={path === activePath}>
						<button
							type="button"
							className="sh-ex-row"
							data-active={path === activePath ? "true" : undefined}
							style={{ paddingInlineStart: 6 + depth * 12 + 17 }}
							onClick={() => onOpen(path)}
							{...dragProps(path, false)}
							title={path}
						>
							<span className="sh-ex-name" data-tone={badge?.tone}>
								{baseName(path)}
							</span>
							{badge !== undefined && (
								<span className="sh-ex-badge" data-tone={badge.tone} title={badge.label}>
									{badge.letter}
								</span>
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
});
