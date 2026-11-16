import { Files, GitBranch, ListTree, Search } from "lucide-react";
import type { KeyboardEvent, PointerEvent, ReactNode, Ref } from "react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { CompanionClient, FileTree } from "../../lib/companion";
import type { LspLocation } from "../../lib/repo-intel";
import { toLayout } from "../../lib/zoom";
import { ChangesView } from "./explorer/ChangesView";
import {
	clampWidth,
	DEFAULT_WIDTH,
	type ExplorerView,
	KEY_STEP,
	KEY_STEP_SHIFT,
	loadWidth,
	MAX_WIDTH,
	memoryFor,
	MIN_WIDTH,
	type SearchForm,
	saveWidth,
} from "./explorer/explorer-state";
import { FilesView } from "./explorer/FilesView";
import { treeStatus } from "./explorer/git-status";
import { ReferencesView } from "./explorer/ReferencesView";
import { SearchView } from "./explorer/SearchView";
import { useGitStatus } from "./explorer/use-git-status";
import "./explorer.css";

export interface ExplorerSidebarProps {
	client: CompanionClient;
	instanceId: string;
	tree: FileTree | null;
	treeError: string | null;
	onReloadTree(): void;
	/** Root-relative path of the active tab. */
	activePath: string | null;
	/** Folders that are open (the editor keeps them per computer). */
	expanded: Set<string>;
	onToggleDir(path: string): void;
	/** The companion answers `file-search`. */
	canSearch: boolean;
	/** The app's agent-edit counter: the git status is read again when it changes. */
	edits: number;
	/** Root-relative path. */
	onOpen(path: string, line?: number, character?: number): void;
	/** The editor's last find-references answer; the References view is offered while it is set. */
	references: { title: string; locations: LspLocation[] } | null;
	onClearReferences(): void;
	/** Over the editor (phones, a narrow dock) instead of beside it: no divider, and its width follows the editor's. */
	overlay?: boolean;
	/** The view to start on; "search" also focuses the query box. */
	initialView?: "files" | "search";
	ref?: Ref<ExplorerSidebarHandle>;
}

export interface ExplorerSidebarHandle {
	/** Show the Search view and put the cursor in its query box. */
	focusSearch(): void;
}

const VIEWS: { id: ExplorerView; label: string; icon: typeof Files }[] = [
	{ id: "files", label: "Files", icon: Files },
	{ id: "changes", label: "Changes", icon: GitBranch },
	{ id: "search", label: "Search", icon: Search },
	{ id: "references", label: "Refs", icon: ListTree },
];

/** Most the divider may take: the editor keeps at least this much of the row. */
const EDITOR_MIN = 280;

/**
 * The explorer beside the editor: a view switcher (Files, Changes, Search, and References while the editor has a
 * result) and the view itself. Resizable between 200 and 600px by its right edge, remembered on this device.
 */
export function ExplorerSidebar({
	client,
	instanceId,
	tree,
	treeError,
	onReloadTree,
	activePath,
	expanded,
	onToggleDir,
	canSearch,
	edits,
	onOpen,
	references,
	onClearReferences,
	overlay = false,
	initialView,
	ref,
}: ExplorerSidebarProps): ReactNode {
	const memory = memoryFor(instanceId);
	const [view, setViewState] = useState<ExplorerView>(
		initialView ?? (references !== null ? "references" : memory.view === "references" ? "files" : memory.view),
	);
	const [form, setFormState] = useState<SearchForm>(memory.search);
	const [focusTick, setFocusTick] = useState(initialView === "search" ? 1 : 0);
	const searchInput = useRef<HTMLInputElement>(null);

	const setView = useCallback(
		(next: ExplorerView) => {
			setViewState(next);
			if (next !== "references") memory.view = next;
		},
		[memory],
	);
	const setForm = useCallback(
		(next: SearchForm) => {
			memory.search = next;
			setFormState(next);
		},
		[memory],
	);

	useImperativeHandle(
		ref,
		() => ({
			focusSearch() {
				setView("search");
				setFocusTick(tick => tick + 1);
			},
		}),
		[setView],
	);

	// A new find-references result comes forward; clearing it returns to the view the user was on.
	const shownReferences = useRef(false);
	useEffect(() => {
		if (references !== null) {
			shownReferences.current = true;
			setViewState("references");
		} else if (shownReferences.current) {
			shownReferences.current = false;
			setViewState(current => (current === "references" ? memory.view : current));
		}
	}, [references, memory]);

	useEffect(() => {
		if (view !== "search" || focusTick === 0) return;
		searchInput.current?.focus();
		searchInput.current?.select();
	}, [view, focusTick]);

	const gitActive = view === "files" || view === "changes";
	const status = useGitStatus(client, instanceId, edits, gitActive);
	const decorations = useMemo(
		() => (status.git === null || tree === null ? null : treeStatus(status.git.files, status.git.root, tree.root)),
		[status.git, tree],
	);
	const changeCount = status.git === null ? 0 : status.git.files.filter(file => file.status !== "!!").length;

	const open = useCallback(
		(path: string, line?: number, character?: number) => onOpen(path, line, character),
		[onOpen],
	);

	const [width, setWidth] = useState(loadWidth);
	const root = useRef<HTMLElement>(null);
	const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
	/** Widest the divider may go: the editor keeps its room. */
	const maxWidth = (): number => {
		const row = root.current?.parentElement;
		return row === null || row === undefined ? MAX_WIDTH : Math.min(MAX_WIDTH, row.clientWidth - EDITOR_MIN);
	};
	const paint = (px: number): void => root.current?.style.setProperty("width", `${px}px`);
	const commit = (px: number): void => {
		const next = clampWidth(px, maxWidth());
		paint(next);
		setWidth(next);
		saveWidth(next);
	};
	const onResizeDown = (event: PointerEvent<HTMLElement>): void => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
		event.currentTarget.setAttribute("data-dragging", "");
	};
	const onResizeMove = (event: PointerEvent<HTMLElement>): void => {
		const current = drag.current;
		if (current === null || current.pointerId !== event.pointerId) return;
		current.width = clampWidth(current.startWidth + toLayout(event.clientX - current.startX), maxWidth());
		paint(current.width);
	};
	const onResizeEnd = (event: PointerEvent<HTMLElement>): void => {
		const current = drag.current;
		if (current === null || current.pointerId !== event.pointerId) return;
		drag.current = null;
		event.currentTarget.removeAttribute("data-dragging");
		commit(current.width);
	};
	const onResizeKey = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const step = event.shiftKey ? KEY_STEP_SHIFT : KEY_STEP;
		if (event.key === "ArrowLeft") commit(width - step);
		else if (event.key === "ArrowRight") commit(width + step);
		else if (event.key === "Home") commit(MIN_WIDTH);
		else if (event.key === "End") commit(maxWidth());
		else if (event.key === "Enter") commit(DEFAULT_WIDTH);
		else return;
		event.preventDefault();
	};

	const views = VIEWS.filter(entry => entry.id !== "references" || references !== null);
	return (
		<aside
			ref={root}
			className="sh-explorer"
			data-overlay={overlay ? "true" : undefined}
			style={overlay ? undefined : { width }}
			aria-label="Explorer"
		>
			<nav className="sh-ex-rail" aria-label="Explorer views">
				{views.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						className="sh-ex-view"
						aria-pressed={view === id}
						aria-label={id === "changes" && changeCount > 0 ? `${label}, ${changeCount} changed` : label}
						title={id === "search" ? "Search in files (Cmd/Ctrl+Shift+F)" : label}
						onClick={() => setView(id)}
					>
						<span className="sh-ex-view-icon">
							<Icon size={17} />
							{id === "changes" && changeCount > 0 && (
								<span className="sh-ex-view-count" aria-hidden="true">
									{changeCount > 99 ? "99+" : changeCount}
								</span>
							)}
						</span>
						<span className="sh-ex-view-label">{label}</span>
					</button>
				))}
			</nav>
			<div className="sh-ex-body">
				{view === "files" && (
					<FilesView
						tree={tree}
						treeError={treeError}
						onReloadTree={onReloadTree}
						activePath={activePath}
						expanded={expanded}
						onToggleDir={onToggleDir}
						onOpen={path => open(path)}
						status={decorations}
					/>
				)}
				{view === "changes" && (
					<ChangesView
						client={client}
						instanceId={instanceId}
						status={status}
						treeRoot={tree?.root ?? null}
						onOpen={path => open(path)}
					/>
				)}
				{view === "search" && (
					<SearchView
						client={client}
						instanceId={instanceId}
						canSearch={canSearch}
						form={form}
						onForm={setForm}
						inputRef={searchInput}
						onOpen={open}
					/>
				)}
				{view === "references" && references !== null && (
					<ReferencesView references={references} onOpen={open} onClear={onClearReferences} />
				)}
			</div>
			{!overlay && (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Explorer width"
					aria-valuemin={MIN_WIDTH}
					aria-valuemax={MAX_WIDTH}
					aria-valuenow={width}
					tabIndex={0}
					className="sh-ex-resize"
					onPointerDown={onResizeDown}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onPointerCancel={onResizeEnd}
					onKeyDown={onResizeKey}
					onDoubleClick={() => commit(DEFAULT_WIDTH)}
				/>
			)}
		</aside>
	);
}
