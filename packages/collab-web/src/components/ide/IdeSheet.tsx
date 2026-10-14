import type { Extension, Text, TransactionSpec } from "@codemirror/state";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	ChevronDown,
	ChevronRight,
	FileCode,
	Folder,
	LoaderCircle,
	LocateFixed,
	MessageSquarePlus,
	PanelLeft,
	PanelRight,
	PanelRightClose,
	PenLine,
	RefreshCw,
	Save,
	TriangleAlert,
	Swords,
	X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CodemapNode, CompanionClient, FileTree } from "../../lib/companion";
import { FileChangedError } from "../../lib/companion";
import { openDiagramFile } from "../../lib/diagram-store";
import { diagramFileKind } from "../../lib/diagrams";
import { importChunk } from "../../lib/stale-build";
import { useRequest } from "../../lib/use-request";
import { matchesMedia } from "../../lib/zoom";
import { useMedia, WIDE_QUERY } from "../codemap/shared";
import { DownloadButton } from "../shell/DownloadButton";
import { Sheet } from "../shell/Sheet";
import { DockPane } from "../shell/SplitPane";
import type { EditorHooks } from "./editor";
import { baseExtensions, fromDisk, markChanged, selectedLines, tabExtensions, wordAt } from "./editor";
import type { TreeDir } from "./file-tree";
import { ancestors, baseName, buildTree, quickOpen } from "./file-tree";
import { languageFor } from "./languages";
import { diffText } from "./text-diff";
import "./ide.css";

export interface IdeSheetProps {
	client: CompanionClient;
	/** Companion host of the session whose files are edited. */
	instanceId: string;
	/** Open this file (absolute, or relative to the session's cwd) and bring its 1-based line into view. */
	target: { path: string; line?: number } | null;
	/** View-only link: browse and read, never save. */
	readOnly: boolean;
	/** The code map is available: go to definition looks symbols up in it. */
	canDefinition: boolean;
	/** Edits the agent completed so far: a change checks the open files at once instead of at the next poll. */
	edits: number;
	/** Put text in the message box; null for view-only links. */
	onSendToAgent: ((text: string) => void) | null;
	/** Docking the editor beside the transcript is possible: the header offers the toggle. null: it is always a sheet. */
	dock?: { docked: boolean; onDockedChange(docked: boolean): void } | null;
	/** Spar with a design: the file's path relative to the repository (markdown and text files only). null: not offered. */
	onSparDesign?: ((path: string) => void) | null;
	onClose(): void;
}

/** Open files are compared with the disk this often while the sheet is shown. */
const POLL_MS = 2500;
/** `file-versions` answers for this many paths at once. */
const MAX_POLLED = 20;
/** Quick-open rows shown. */
const QUICK_OPEN_ROWS = 40;
/** Files a design is likely to be written in: the header offers sparring with them. */
const DESIGN_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

type Conflict = { kind: "changed"; version: string } | { kind: "gone" };

interface Tab {
	/** Path relative to the tree root (the repository root, or the cwd outside one); the tab's identity. */
	path: string;
	/** The path sent to the companion for this file. */
	request: string;
	/** Version on disk the editor's text started from; a save sends it as `base`. */
	version: string;
	writable: boolean;
	truncated: boolean;
	/** Language name for the status bar, null for plain text. */
	language: string | null;
	dirty: boolean;
	saving: boolean;
	/** The file changed on disk under unsaved edits, or was removed. */
	conflict: Conflict | null;
	/** Lines the last update from disk changed (highlighted until the next edit). */
	changed: number;
}

/**
 * An editor's open files, kept per companion host for the page's lifetime: closing
 * the sheet keeps unsaved edits and each tab's undo history for the next opening.
 */
interface Memory {
	tabs: Tab[];
	active: string | null;
	/** Editor state of every tab but the active one, whose state lives in the view. */
	states: Record<string, EditorState>;
	/** Each tab's text as last read from or written to disk; `dirty` compares against it. */
	disk: Record<string, Text>;
	expanded: Record<string, true>;
	/** Absolute tree root once the tree loaded. */
	root: string | null;
	/** Read by the shared extensions on every event, so restored states reach the mounted sheet. */
	hooks: EditorHooks;
	base: Extension[];
}

const memories: Record<string, Memory> = {};

function memoryFor(instanceId: string): Memory {
	if (Object.hasOwn(memories, instanceId)) return memories[instanceId]!;
	const memory: Memory = {
		tabs: [],
		active: null,
		states: {},
		disk: {},
		expanded: {},
		root: null,
		hooks: { definition() {}, changed() {} },
		base: [],
	};
	memory.base = baseExtensions(() => memory.hooks);
	memories[instanceId] = memory;
	return memory;
}

/** The path the companion is sent for a file the tree, the code map or a tab names root-relative. */
function absolutePath(mem: Memory, rel: string): string {
	return mem.root === null ? rel : `${mem.root}/${rel}`;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The unqualified name of a code map symbol label (`Pool::insert` → `insert`). */
function lastSegment(label: string): string {
	return label.split(/::|\.|#/).pop() ?? label;
}

/** A fence that `text` cannot close early. */
function fenceFor(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The editor: the session folder's files in a tree, open files in tabs, saving
 * through the companion. A save is refused when the file changed on disk since it
 * was read; files the agent edits reload in clean tabs with the changed lines marked.
 */
export function IdeSheet({
	client,
	instanceId,
	target,
	readOnly,
	canDefinition,
	edits,
	onSendToAgent,
	dock,
	onSparDesign,
	onClose,
}: IdeSheetProps): ReactNode {
	const mem = memoryFor(instanceId);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const host = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const docked = dock?.docked === true;
	// A docked pane is narrower than the window: the file list overlays the editor as on narrow screens.
	const viewportWide = useMedia(WIDE_QUERY);
	const wide = viewportWide && !docked;
	const [treeOpen, setTreeOpen] = useState(() => mem.tabs.length === 0 || wide);
	const [expanded, setExpanded] = useState(mem.expanded);
	const [opening, setOpening] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
	const [definition, setDefinition] = useState<{ word: string; hits: CodemapNode[] | null; error?: string } | null>(
		null,
	);

	const loadTree = useCallback(() => client.requestTree(instanceId), [client, instanceId]);
	const { state: treeState, reload: reloadTree } = useRequest<FileTree>(loadTree);
	const tree = treeState.status === "ready" ? treeState.value : null;
	if (tree !== null) mem.root = tree.root;
	const rootDir = useMemo(() => (tree === null ? null : buildTree(tree.files)), [tree]);

	const notify = useCallback((text: string) => setNotice(text), []);
	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		mem.expanded = expanded;
	}, [mem, expanded]);

	const findTab = (path: string): Tab | undefined => mem.tabs.find(tab => tab.path === path);
	const patchTab = (path: string, patch: Partial<Tab>): void => {
		if (findTab(path) === undefined) return;
		mem.tabs = mem.tabs.map(tab => (tab.path === path ? { ...tab, ...patch } : tab));
		rerender();
	};
	const stateOf = (path: string): EditorState => {
		const view = viewRef.current;
		return path === mem.active && view !== null ? view.state : mem.states[path]!;
	};
	const applyTo = (path: string, spec: TransactionSpec): void => {
		const view = viewRef.current;
		if (path === mem.active && view !== null) view.dispatch(spec);
		else mem.states[path] = mem.states[path]!.update(spec).state;
	};

	const syncCursor = (view: EditorView): void => {
		const { head, from, to } = view.state.selection.main;
		const line = view.state.doc.lineAt(head);
		setCursor({ line: line.number, col: head - line.from + 1, selected: to - from });
	};

	const activate = (path: string, line?: number): void => {
		const view = viewRef.current;
		if (view === null || findTab(path) === undefined) return;
		if (mem.active !== path) {
			if (mem.active !== null && findTab(mem.active) !== undefined) mem.states[mem.active] = view.state;
			view.setState(mem.states[path]!);
			mem.active = path;
			setExpanded(prev => {
				const next = { ...prev };
				for (const dir of ancestors(path)) next[dir] = true;
				return next;
			});
			rerender();
		}
		if (line !== undefined) {
			const doc = view.state.doc;
			const at = doc.line(Math.min(Math.max(line, 1), doc.lines)).from;
			view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
		}
		syncCursor(view);
		if (!matchesMedia(WIDE_QUERY)) setTreeOpen(false);
	};

	const openFile = async (request: string, line?: number): Promise<void> => {
		const known = mem.tabs.find(tab => tab.request === request || absolutePath(mem, tab.path) === request);
		if (known !== undefined) {
			activate(known.path, line);
			return;
		}
		setOpening(request);
		try {
			const entry = languageFor(request);
			const [file, language] = await Promise.all([
				client.requestFile(instanceId, request),
				entry === null ? null : importChunk(() => entry.load()).catch(() => null),
			]);
			if (file.text === null) {
				notify(`${file.path} is a binary file`);
				return;
			}
			if (findTab(file.path) === undefined) {
				const writable = file.writable && !readOnly;
				const state = EditorState.create({
					doc: file.text,
					extensions: [mem.base, tabExtensions(language, writable, file.text.includes("\r\n"))],
				});
				mem.states[file.path] = state;
				mem.disk[file.path] = state.doc;
				mem.tabs = [
					...mem.tabs,
					{
						path: file.path,
						request: mem.root === null ? request : absolutePath(mem, file.path),
						version: file.version,
						writable,
						truncated: file.truncated,
						language: entry?.name ?? null,
						dirty: false,
						saving: false,
						conflict: null,
						changed: 0,
					},
				];
			}
			activate(file.path, line);
		} catch (err) {
			notify(`Could not open ${baseName(request)}: ${messageOf(err)}`);
		} finally {
			setOpening(current => (current === request ? null : current));
		}
	};

	const closeTab = (path: string): void => {
		const tab = findTab(path);
		if (tab === undefined) return;
		if (tab.dirty && !confirm(`Discard unsaved changes to ${baseName(path)}?`)) return;
		const index = mem.tabs.indexOf(tab);
		mem.tabs = mem.tabs.filter(t => t !== tab);
		delete mem.states[path];
		delete mem.disk[path];
		if (mem.active === path) {
			const next = mem.tabs[Math.min(index, mem.tabs.length - 1)];
			mem.active = null;
			if (next !== undefined) activate(next.path);
			else viewRef.current?.setState(EditorState.create({ extensions: mem.base }));
		}
		rerender();
	};

	/** Bring the disk's text into a tab. `marked`: highlight the lines it changed (an agent's edit). */
	const reloadFromDisk = async (path: string, marked: boolean): Promise<void> => {
		const tab = findTab(path);
		if (tab === undefined) return;
		const file = await client.requestFile(instanceId, tab.request);
		const now = findTab(path);
		if (now === undefined) return;
		if (file.text === null) {
			patchTab(path, { conflict: { kind: "gone" } });
			return;
		}
		const { edits: changes, changedLines } = diffText(stateOf(path).doc.toString(), file.text.replace(/\r\n/g, "\n"));
		applyTo(path, {
			changes,
			effects: markChanged.of(marked ? changedLines : []),
			// An agent's edit to a clean file is not the user's to undo; discarded edits are.
			annotations: [fromDisk.of(true), Transaction.addToHistory.of(now.dirty)],
		});
		mem.disk[path] = stateOf(path).doc;
		patchTab(path, {
			version: file.version,
			dirty: false,
			conflict: null,
			truncated: file.truncated,
			changed: marked ? changedLines.length : 0,
		});
	};

	/** Write the tab's text. `base`: overwrite the disk version the user chose to replace. */
	const save = async (path: string | null, base?: string): Promise<void> => {
		const tab = path === null ? undefined : findTab(path);
		if (path === null || tab === undefined || !tab.writable || tab.saving) return;
		if (!tab.dirty && base === undefined) return;
		const state = stateOf(path);
		patchTab(path, { saving: true });
		try {
			const version = await client.writeFile(instanceId, tab.request, state.sliceDoc(), base ?? tab.version);
			mem.disk[path] = state.doc;
			if (findTab(path) !== undefined) {
				patchTab(path, { version, saving: false, conflict: null, dirty: !stateOf(path).doc.eq(state.doc) });
				notify(`Saved ${baseName(path)}`);
			}
		} catch (err) {
			if (err instanceof FileChangedError) {
				patchTab(path, {
					saving: false,
					conflict: err.version === null ? { kind: "gone" } : { kind: "changed", version: err.version },
				});
			} else {
				patchTab(path, { saving: false });
				notify(`Could not save ${baseName(path)}: ${messageOf(err)}`);
			}
		}
	};

	const definitionAt = async (pos: number): Promise<void> => {
		if (mem.active === null) return;
		if (!canDefinition) {
			notify("Go to definition needs the code map on the paired computer");
			return;
		}
		const word = wordAt(stateOf(mem.active), pos);
		if (word === null) return;
		setDefinition({ word, hits: null });
		try {
			const hits = (await client.searchCodemap(instanceId, word)).filter(
				hit => hit.kind === "symbol" && hit.line !== undefined,
			);
			const exact = hits.filter(hit => lastSegment(hit.label) === word);
			const picks = exact.length > 0 ? exact : hits;
			if (picks.length === 1) {
				setDefinition(null);
				void openFile(absolutePath(mem, picks[0]!.path), picks[0]!.line);
			} else {
				setDefinition({ word, hits: picks });
			}
		} catch (err) {
			setDefinition({ word, hits: [], error: messageOf(err) });
		}
	};

	const sendSelection = (): void => {
		if (onSendToAgent === null || mem.active === null) return;
		const { from, to, text } = selectedLines(stateOf(mem.active));
		const fence = fenceFor(text);
		const ext = mem.active.slice(mem.active.lastIndexOf(".") + 1);
		const lines = from === to ? `${from}` : `${from}-${to}`;
		onSendToAgent(`\`${mem.active}:${lines}\`\n${fence}${ext}\n${text}\n${fence}\n`);
		// Docked, the editor stays beside the message box the text just went to.
		if (!docked) onClose();
	};

	// The extensions call through `mem.hooks`: point it at this render's closures.
	useLayoutEffect(() => {
		mem.hooks = {
			definition: pos => void definitionAt(pos),
			changed: view => {
				const path = mem.active;
				if (path === null) return;
				const tab = findTab(path);
				const dirty = !view.state.doc.eq(mem.disk[path]!);
				if (tab !== undefined && (tab.dirty !== dirty || (tab.changed > 0 && dirty))) {
					patchTab(path, dirty ? { dirty, changed: 0 } : { dirty });
				}
				syncCursor(view);
			},
		};
	});

	// One view for the sheet's lifetime; tabs swap their states in and out of it.
	useLayoutEffect(() => {
		const parent = host.current;
		if (parent === null) return;
		const active = mem.active === null ? undefined : mem.states[mem.active];
		const view = new EditorView({ parent, state: active ?? EditorState.create({ extensions: mem.base }) });
		viewRef.current = view;
		if (mem.active !== null) syncCursor(view);
		return () => {
			if (mem.active !== null) mem.states[mem.active] = view.state;
			view.destroy();
			viewRef.current = null;
		};
	}, [mem]);

	const openRef = useRef(openFile);
	openRef.current = openFile;
	// Open the requested file, now and whenever the app asks for another.
	useEffect(() => {
		if (target !== null) void openRef.current(target.path, target.line);
	}, [target]);

	// Notice files changed on disk: an agent's edit reloads a clean tab and marks a dirty one.
	const checking = useRef(false);
	const check = async (): Promise<void> => {
		if (checking.current) return;
		const tabs = mem.tabs.filter(tab => !tab.saving).slice(0, MAX_POLLED);
		if (tabs.length === 0) return;
		checking.current = true;
		try {
			const versions = await client.requestFileVersions(
				instanceId,
				tabs.map(tab => tab.request),
			);
			for (const [i, asked] of tabs.entries()) {
				const tab = findTab(asked.path);
				const version = versions[i];
				// Saved or reloaded meanwhile: this answer is about an older version.
				if (tab === undefined || tab.saving || tab.version !== asked.version || version === tab.version) continue;
				if (version === null || version === undefined) {
					if (tab.conflict?.kind !== "gone") patchTab(tab.path, { conflict: { kind: "gone" } });
				} else if (tab.dirty) {
					if (tab.conflict?.kind !== "changed" || tab.conflict.version !== version) {
						patchTab(tab.path, { conflict: { kind: "changed", version } });
					}
				} else {
					await reloadFromDisk(tab.path, true);
				}
			}
		} catch {
			// Offline or companion restarting: the next poll tries again.
		} finally {
			checking.current = false;
		}
	};
	const checkRef = useRef(check);
	checkRef.current = check;
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void checkRef.current();
		}, POLL_MS);
		return () => clearInterval(timer);
	}, []);
	const seenEdits = useRef(edits);
	useEffect(() => {
		if (edits === seenEdits.current) return;
		seenEdits.current = edits;
		void checkRef.current();
	}, [edits]);

	const quickInput = useRef<HTMLInputElement>(null);
	const onSheetKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
		const key = e.key.toLowerCase();
		if (key === "p") {
			e.preventDefault();
			quickInput.current?.focus();
		} else if (key === "s") {
			e.preventDefault();
			void save(mem.active);
		}
	};

	const active = mem.active === null ? undefined : findTab(mem.active);
	const dirtyPaths = useMemo(() => {
		const out: Record<string, true> = {};
		for (const tab of mem.tabs) if (tab.dirty) out[tab.path] = true;
		return out;
		// `mem.tabs` is replaced, never mutated: its identity tracks the dirty set.
	}, [mem.tabs]);
	const toggleDir = useCallback((path: string) => {
		setExpanded(prev => {
			const next = { ...prev };
			if (next[path]) delete next[path];
			else next[path] = true;
			return next;
		});
	}, []);
	const openFromTree = useCallback((rel: string) => void openRef.current(absolutePath(mem, rel)), [mem]);

	const frame = (
		<div className="sh-ide" onKeyDown={onSheetKey}>
			<div className="sh-sheet-head sh-ide-head">
				<button
					type="button"
					className={treeOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={() => setTreeOpen(open => !open)}
					aria-label={treeOpen ? "Hide files" : "Show files"}
					aria-pressed={treeOpen}
					title="Files"
				>
					<PanelLeft size={16} />
				</button>
				<QuickOpen inputRef={quickInput} files={tree?.files ?? null} onOpen={openFromTree} />
				<span className="sh-ide-actions">
					{canDefinition && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => {
								const view = viewRef.current;
								if (view !== null) void definitionAt(view.state.selection.main.head);
							}}
							disabled={active === undefined}
							aria-label="Go to definition"
							title="Go to definition (F12, or Cmd/Ctrl+click)"
						>
							<LocateFixed size={16} />
						</button>
					)}
					{onSendToAgent !== null && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={sendSelection}
							disabled={active === undefined}
							aria-label="Ask the agent about the selection"
							title="Ask the agent about the selection"
						>
							<MessageSquarePlus size={16} />
						</button>
					)}
					{onSparDesign != null && active !== undefined && DESIGN_FILE.test(active.path) && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => onSparDesign(active.path)}
							aria-label="Spar with this design"
						>
							<Swords size={14} />
							<span>Spar</span>
						</button>
					)}
					{active !== undefined && (
						<DownloadButton client={client} instanceId={instanceId} path={active.request} />
					)}
					{active !== undefined && diagramFileKind(active.request) !== null && (
						<button
							type="button"
							className="sh-btn"
							onClick={() => openDiagramFile(active.request)}
							title="Open the saved file in the canvas"
						>
							<PenLine size={14} />
							<span>Canvas</span>
						</button>
					)}
					{active?.writable === true && (
						<button
							type="button"
							className="sh-btn sh-ide-save"
							onClick={() => void save(active.path)}
							disabled={!active.dirty || active.saving}
							title="Save (Cmd/Ctrl+S)"
						>
							{active.saving ? <LoaderCircle size={14} className="sh-spin" /> : <Save size={14} />}
							<span>Save</span>
						</button>
					)}
					{dock != null && (
						<button
							type="button"
							className={docked ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
							onClick={() => dock.onDockedChange(!docked)}
							aria-pressed={docked}
							aria-label={docked ? "Show as a sheet" : "Open beside the transcript"}
							title={docked ? "Show as a sheet" : "Open beside the transcript"}
						>
							{docked ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
						</button>
					)}
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			<div className="sh-ide-body" data-tree={treeOpen ? "open" : "closed"} data-wide={wide ? "true" : "false"}>
				{treeOpen && (
					<aside className="sh-ide-tree" aria-label="Files">
						{treeState.status === "loading" && (
							<div className="sh-companion-empty sh-file-status">
								<LoaderCircle size={14} className="sh-spin" /> Listing files…
							</div>
						)}
						{treeState.status === "error" && (
							<div className="sh-tree-error">
								<div className="sh-connect-error">{treeState.message}</div>
								<button type="button" className="sh-btn" onClick={reloadTree}>
									<RefreshCw size={14} /> Retry
								</button>
							</div>
						)}
						{rootDir !== null && (
							<TreeView
								dir={rootDir}
								depth={0}
								expanded={expanded}
								active={mem.active}
								dirty={dirtyPaths}
								onToggle={toggleDir}
								onOpen={openFromTree}
							/>
						)}
						{tree?.truncated === true && (
							<div className="sh-file-note">Only the first {tree.files.length} files are listed.</div>
						)}
					</aside>
				)}
				<section className="sh-ide-main">
					<div className="sh-ide-tabs" role="tablist">
						{mem.tabs.map(tab => (
							<div
								key={tab.path}
								className={tab.path === mem.active ? "sh-ide-tab sh-ide-tab-on" : "sh-ide-tab"}
								title={tab.path}
							>
								<button
									type="button"
									role="tab"
									aria-selected={tab.path === mem.active}
									className="sh-ide-tab-name"
									onClick={() => activate(tab.path)}
								>
									{baseName(tab.path)}
									{tab.conflict !== null && <TriangleAlert size={12} className="sh-ide-tab-warn" />}
								</button>
								<button
									type="button"
									className="sh-ide-tab-close"
									onClick={() => closeTab(tab.path)}
									aria-label={`Close ${baseName(tab.path)}`}
									data-dirty={tab.dirty ? "true" : "false"}
								>
									<span className="sh-ide-dot" aria-hidden />
									<X size={12} />
								</button>
							</div>
						))}
						{opening !== null && (
							<span className="sh-ide-tab sh-ide-tab-opening">
								<LoaderCircle size={12} className="sh-spin" /> {baseName(opening)}
							</span>
						)}
					</div>
					{active?.conflict != null && (
						<ConflictBar
							tab={active}
							onReload={() =>
								void reloadFromDisk(active.path, true).catch((err: unknown) =>
									notify(`Could not reload: ${messageOf(err)}`),
								)
							}
							onOverwrite={() => {
								if (active.conflict?.kind === "changed") void save(active.path, active.conflict.version);
							}}
							onClose={() => closeTab(active.path)}
						/>
					)}
					{active?.truncated === true && (
						<div className="sh-file-note sh-ide-bar">
							Showing the start of the file only: it is larger than the editor reads, so it is read-only.
						</div>
					)}
					<div ref={host} className="sh-ide-editor" hidden={active === undefined} />
					{active === undefined && (
						<div className="sh-ide-empty">
							<FileCode size={28} />
							<div>Pick a file from the list, or press Cmd/Ctrl+P to find one.</div>
						</div>
					)}
					{definition !== null && (
						<DefinitionList
							definition={definition}
							onPick={hit => {
								setDefinition(null);
								void openFile(absolutePath(mem, hit.path), hit.line);
							}}
							onClose={() => setDefinition(null)}
						/>
					)}
					<div className="sh-ide-status">
						{active === undefined ? (
							<span>{tree === null ? "" : `${tree.files.length} files`}</span>
						) : (
							<>
								<span className="sh-ide-status-path" title={active.path}>
									{active.path}
								</span>
								{active.changed > 0 && (
									<span className="sh-ide-status-changed">
										{active.changed} line{active.changed === 1 ? "" : "s"} changed on disk
									</span>
								)}
								{!active.writable && <span>Read-only</span>}
								<span>{active.language ?? "Plain text"}</span>
								<span>
									Ln {cursor.line}, Col {cursor.col}
									{cursor.selected > 0 ? ` (${cursor.selected} selected)` : ""}
								</span>
							</>
						)}
						{notice !== null && (
							<span className="sh-ide-notice" role="status">
								{notice}
							</span>
						)}
					</div>
				</section>
			</div>
		</div>
	);
	return docked ? (
		<DockPane label="editor">{frame}</DockPane>
	) : (
		<Sheet label="editor" size="full" onClose={onClose}>
			{frame}
		</Sheet>
	);
}

function ConflictBar({
	tab,
	onReload,
	onOverwrite,
	onClose,
}: {
	tab: Tab;
	onReload(): void;
	onOverwrite(): void;
	onClose(): void;
}): ReactNode {
	if (tab.conflict?.kind === "gone") {
		return (
			<div className="sh-ide-conflict sh-ide-bar" role="alert">
				<TriangleAlert size={14} />
				<span>This file was deleted or is no longer text on the computer.</span>
				<button type="button" className="sh-btn" onClick={onClose}>
					Close tab
				</button>
			</div>
		);
	}
	return (
		<div className="sh-ide-conflict sh-ide-bar" role="alert">
			<TriangleAlert size={14} />
			<span>{tab.dirty ? "Changed on disk while you were editing." : "Changed on disk since you opened it."}</span>
			<button type="button" className="sh-btn" onClick={onReload}>
				{tab.dirty ? "Discard mine" : "Reload"}
			</button>
			{tab.writable && (
				<button type="button" className="sh-btn" onClick={onOverwrite} disabled={tab.saving}>
					Keep mine
				</button>
			)}
		</div>
	);
}

function DefinitionList({
	definition,
	onPick,
	onClose,
}: {
	definition: { word: string; hits: CodemapNode[] | null; error?: string };
	onPick(hit: CodemapNode): void;
	onClose(): void;
}): ReactNode {
	const { word, hits, error } = definition;
	return (
		<div className="sh-ide-defs" role="dialog" aria-label={`Definitions of ${word}`}>
			<div className="sh-ide-defs-head">
				<span>
					Definitions of <code>{word}</code>
				</span>
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close definitions">
					<X size={14} />
				</button>
			</div>
			{hits === null && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Looking it up…
				</div>
			)}
			{error !== undefined && <div className="sh-connect-error">{error}</div>}
			{hits !== null && error === undefined && hits.length === 0 && (
				<div className="sh-file-note">No definition of {word} in the code map.</div>
			)}
			{hits !== null && hits.length > 0 && (
				<ul className="sh-ide-defs-list">
					{hits.map(hit => (
						<li key={`${hit.path}:${hit.line}:${hit.label}`}>
							<button type="button" className="sh-ide-def" onClick={() => onPick(hit)}>
								<span className="sh-ide-def-label">{hit.label}</span>
								<span className="sh-ide-def-where">
									{hit.path}:{hit.line}
								</span>
								{hit.signature !== undefined && <code className="sh-ide-def-sig">{hit.signature}</code>}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Fuzzy file finder over the tree's paths. */
function QuickOpen({
	inputRef,
	files,
	onOpen,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	files: string[] | null;
	onOpen(path: string): void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const results = useMemo(
		() => (files === null || query.trim() === "" ? [] : quickOpen(query.trim(), files, QUICK_OPEN_ROWS)),
		[files, query],
	);
	const pick = (path: string): void => {
		setQuery("");
		onOpen(path);
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const step = e.key === "ArrowDown" ? 1 : -1;
			setIndex(i => (results.length === 0 ? 0 : (i + step + results.length) % results.length));
		} else if (e.key === "Enter") {
			const path = results[index];
			if (path !== undefined) pick(path);
		} else if (e.key === "Escape" && query !== "") {
			// Clear the query first; only an empty field lets Escape close the sheet.
			e.stopPropagation();
			setQuery("");
		}
	};
	return (
		<div className="sh-ide-quick">
			<input
				ref={inputRef}
				className="sh-input"
				type="search"
				value={query}
				placeholder={files === null ? "Listing files…" : "Go to file"}
				disabled={files === null}
				onChange={e => {
					setQuery(e.target.value);
					setIndex(0);
				}}
				onKeyDown={onKey}
				aria-label="Go to file"
				autoComplete="off"
				spellCheck={false}
			/>
			{results.length > 0 && (
				<ul className="sh-ide-quick-list" role="listbox">
					{results.map((path, i) => (
						<li key={path} role="option" aria-selected={i === index}>
							<button
								type="button"
								className={i === index ? "sh-ide-quick-row sh-ide-quick-row-on" : "sh-ide-quick-row"}
								onMouseDown={e => e.preventDefault()}
								onClick={() => pick(path)}
							>
								<span className="sh-ide-quick-name">{baseName(path)}</span>
								<span className="sh-ide-quick-dir">{path.slice(0, path.length - baseName(path).length)}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

interface TreeViewProps {
	dir: TreeDir;
	depth: number;
	expanded: Record<string, true>;
	active: string | null;
	dirty: Record<string, true>;
	onToggle(path: string): void;
	onOpen(path: string): void;
}

/** One folder's entries; folders render their children only while expanded. */
const TreeView = memo(function TreeView({
	dir,
	depth,
	expanded,
	active,
	dirty,
	onToggle,
	onOpen,
}: TreeViewProps): ReactNode {
	return (
		<ul className="sh-ide-tree-list" role={depth === 0 ? "tree" : "group"}>
			{dir.dirs.map(child => {
				const open = expanded[child.path] === true;
				return (
					<li key={child.path} role="treeitem" aria-expanded={open}>
						<button
							type="button"
							className="sh-ide-tree-row"
							style={{ paddingInlineStart: 6 + depth * 12 }}
							onClick={() => onToggle(child.path)}
						>
							{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
							<Folder size={13} className="sh-ide-tree-folder" />
							<span className="sh-ide-tree-name">{child.name}</span>
						</button>
						{open && (
							<TreeView
								dir={child}
								depth={depth + 1}
								expanded={expanded}
								active={active}
								dirty={dirty}
								onToggle={onToggle}
								onOpen={onOpen}
							/>
						)}
					</li>
				);
			})}
			{dir.files.map(path => (
				<li key={path} role="treeitem" aria-selected={path === active}>
					<button
						type="button"
						className={path === active ? "sh-ide-tree-row sh-ide-tree-row-on" : "sh-ide-tree-row"}
						style={{ paddingInlineStart: 6 + depth * 12 + 17 }}
						onClick={() => onOpen(path)}
						title={path}
					>
						<span className="sh-ide-tree-name">{baseName(path)}</span>
						{dirty[path] === true && <span className="sh-ide-dot sh-ide-dot-on" aria-label="Unsaved" />}
					</button>
				</li>
			))}
		</ul>
	);
});
