import {
	FileCode,
	ListTree,
	LoaderCircle,
	LocateFixed,
	MessageSquarePlus,
	PanelLeft,
	PenLine,
	Save,
	Swords,
	TriangleAlert,
	X,
} from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CodemapNode, CompanionClient, FileTree } from "../../lib/companion";
import { FileChangedError } from "../../lib/companion";
import { openDiagramFile } from "../../lib/diagram-store";
import { diagramFileKind } from "../../lib/diagrams";
import {
	fontShortcut,
	FONT_MAX,
	FONT_MIN,
	formatFontSize,
	headTierFor,
	minimapShown,
	resetEditorLayout,
	stepFontSize,
	updateEditorLayout,
	useEditorLayout,
} from "../../lib/editor-layout";
import type { EditorEnginePref } from "../../lib/editor-prefs";
import { useEditorEnginePref, useEditorThemePref } from "../../lib/editor-prefs";
import { editorThemeVars } from "../../lib/editor-themes";
import type { PreviewKind, PreviewMode, ViewerKind } from "../../lib/file-viewer";
import { defaultPreviewMode, PREVIEW_MODES, previewKind, viewerKind } from "../../lib/file-viewer";
import { attributionMarks, type FileAttribution } from "../../lib/line-attribution";
import type { LspDiagnostic, LspLocation, LspQuery } from "../../lib/repo-intel";
import { useRequest } from "../../lib/use-request";
import { usePanePlacement } from "../../lib/workspace";
import { matchesMedia } from "../../lib/zoom";
import { useMedia, WIDE_QUERY } from "../codemap/shared";
import { DownloadButton } from "../shell/DownloadButton";
import { Sheet, SheetPlacementButton } from "../shell/Sheet";
import { FileViewer } from "../viewer/FileViewer";
import { MarkdownPreview } from "../viewer/MarkdownPreview";
import { PreviewModeToggle } from "../viewer/PreviewModeToggle";
import { SvgPreview } from "../viewer/SvgPreview";
import { LayoutMenu, type MenuAction } from "./LayoutMenu";
import type { EditorDoc, EditorEngine, EditorView, EditorViewHooks, EngineName, HoverAnswer, Pos } from "./backend";
import { chooseEngine, loadEngine, readyEngine } from "./backend";
import { chooseDefinitionTarget, countDiagnostics, unavailableNote } from "./backend/lsp-map";
import type { DefinitionRow, DefinitionState } from "./DefinitionList";
import { DefinitionList } from "./DefinitionList";
import type { ExplorerSidebarHandle } from "./ExplorerSidebar";
import { ExplorerSidebar } from "./ExplorerSidebar";
import { ancestors, baseName, quickOpen } from "./file-tree";
import { explorerFits, loadWidth, memoryFor as explorerMemory, type SearchForm } from "./explorer/explorer-state";
import { useFileSearch } from "./explorer/use-file-search";
import { BottomPanel, type PanelTab } from "./panel/BottomPanel";
import { ProblemsView } from "./panel/ProblemsView";
import { ReferencesResults } from "./panel/ReferencesResults";
import { SearchResults } from "./panel/SearchResults";
import { problemRows } from "./problems";
import { FALLBACK_FONT_SIZE, useEditorMetrics } from "./use-editor-metrics";
import "./ide.css";

export interface IdeSheetProps {
	client: CompanionClient;
	/** Companion host of the session whose files are edited. */
	instanceId: string;
	/** Open this file (absolute, or relative to the session's cwd) and bring its 1-based line into view. */
	target: { path: string; line?: number } | null;
	/** View-only link: browse and read, never save. */
	readOnly: boolean;
	/** The code map is available: go to definition looks symbols up in it when no language server answers. */
	canDefinition: boolean;
	/** The companion runs language servers: hover, go to definition, find references and problems. */
	canLsp: boolean;
	/** The companion searches file contents: the explorer's Search view. */
	canSearch: boolean;
	/** Edits the agent completed so far: a change checks the open files at once instead of at the next poll. */
	edits: number;
	/** Put text in the message box; null for view-only links. */
	onSendToAgent: ((text: string) => void) | null;
	/** The explorer view to open on (Search also focuses its query box); absent: the last one, or Files. */
	initialView?: "files" | "search";
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
/** Problems are asked for this long after the last edit. */
const DIAGNOSTICS_DEBOUNCE_MS = 800;
/** The Source and Preview halves of a split sit side by side from this width of the code area; narrower, one above the other. */
const SPLIT_STACK_WIDTH = 720;
/** The preview of a file being typed in is made again this long after the last keystroke. */
const PREVIEW_DEBOUNCE_MS = 250;
/** Which lines agents wrote is asked for this long after the file last changed on disk (reading the sessions is not free). */
const ATTRIBUTION_DEBOUNCE_MS = 600;

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
	/** The language server that answered for this file, and what it found; null before it has. */
	server: string | null;
	diagnostics: readonly LspDiagnostic[] | null;
	/** Said once in the status bar when no language server handles the file. */
	lspNote: string | null;
	/** How the file is shown: text in the editor, or an image or PDF in a viewer that takes the editor's place (no document). */
	kind: ViewerKind;
	/** Bytes on disk, when the file was opened or last reloaded: the viewers' size limits. */
	size: number;
	/** The text has a rendered form (Markdown, SVG) that Source / Preview / Split switches to. */
	preview: PreviewKind | null;
	mode: PreviewMode;
}

/**
 * An editor's open files, kept per companion host for the page's lifetime: closing
 * the sheet keeps unsaved edits and each tab's undo history for the next opening.
 */
interface Memory {
	tabs: Tab[];
	active: string | null;
	/** Each tab's document: its text, undo history and marks. Outlives the view showing it. */
	docs: Record<string, EditorDoc>;
	/** Bumped by every edit to a tab's text, so an answer about older text is not applied. */
	revisions: Record<string, number>;
	/** Tabs whose file no language server handles: nothing more is asked for them. */
	noServer: Record<string, true>;
	/** What the companion last said about which lines agents wrote, by tab; read for the version in `Tab.version`. */
	attribution: Record<string, FileAttribution>;
	expanded: Record<string, true>;
	/** Absolute tree root once the tree loaded. */
	root: string | null;
}

const memories: Record<string, Memory> = {};

function memoryFor(instanceId: string): Memory {
	if (Object.hasOwn(memories, instanceId)) return memories[instanceId]!;
	const memory: Memory = {
		tabs: [],
		active: null,
		docs: {},
		revisions: {},
		noServer: {},
		attribution: {},
		expanded: {},
		root: null,
	};
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

function locationRow(location: LspLocation): DefinitionRow {
	const line = location.range.start.line;
	const where = `${location.path}:${line}`;
	return {
		key: `${where}:${location.range.start.character}`,
		label: location.preview ?? baseName(location.path),
		where,
		open: location.inRepo ? { path: location.path, line, character: location.range.start.character } : null,
	};
}

/**
 * Move the documents `mem` holds to `engine` (the editor setting changed): each is rebuilt from the text on
 * disk with the user's unsaved text applied on top, so dirty tabs stay dirty. Undo history and the marks of
 * lines changed on disk do not carry over.
 */
async function adoptDocs(mem: Memory, engine: EditorEngine, scope: string): Promise<void> {
	for (const tab of mem.tabs) {
		const old = mem.docs[tab.path];
		if (old === undefined || old.engine === engine.name) continue;
		const language = await engine.loadLanguage(tab.request);
		const doc = engine.createDoc({
			path: tab.path,
			scope,
			text: old.cleanText(),
			crlf: old.crlf,
			writable: old.writable,
			language,
			unsaved: old.isDirty() ? old.text() : undefined,
		});
		mem.docs[tab.path] = doc;
		mem.tabs = mem.tabs.map(t => (t.path === tab.path ? { ...t, changed: 0 } : t));
		old.dispose();
	}
}

/** The engine the setting asks for in this browser right now. */
function wantedEngine(pref: EditorEnginePref): EngineName {
	return chooseEngine(pref, {
		finePointer: matchesMedia("(pointer: fine)"),
		wide: matchesMedia(WIDE_QUERY),
	});
}

/**
 * The editor: the session folder's files in the explorer, open files in tabs, saving
 * through the companion. A save is refused when the file changed on disk since it
 * was read; files the agent edits reload in clean tabs with the changed lines marked.
 * The editing surface is Monaco on desktops and CodeMirror elsewhere (see `backend/`).
 */
export function IdeSheet({
	client,
	instanceId,
	target,
	readOnly,
	canDefinition,
	canLsp,
	canSearch,
	edits,
	onSendToAgent,
	initialView,
	onSparDesign,
	onClose,
}: IdeSheetProps): ReactNode {
	const mem = memoryFor(instanceId);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const host = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const hooksRef = useRef<EditorViewHooks | null>(null);
	// Where the editor is shown: a floating sheet, a tab of the main area, or beside the conversation.
	const placement = usePanePlacement("editor");
	const layout = useEditorLayout();
	const viewportWide = useMedia(WIDE_QUERY);
	// The explorer is a column beside the code in every desktop placement; it overlays the code only on a small
	// screen, or when the body would leave the code less than `EDITOR_MIN` beside it.
	const [explorerWidth, setExplorerWidth] = useState(loadWidth);
	const body = useRef<HTMLDivElement>(null);
	const [bodyWidth, setBodyWidth] = useState<number | null>(null);
	useLayoutEffect(() => {
		const element = body.current;
		if (element === null) return;
		const observer = new ResizeObserver(() => setBodyWidth(element.clientWidth));
		observer.observe(element);
		setBodyWidth(element.clientWidth);
		return () => observer.disconnect();
	}, []);
	const overlay = !viewportWide || (bodyWidth !== null && !explorerFits(bodyWidth, explorerWidth));
	const overlayRef = useRef(overlay);
	overlayRef.current = overlay;
	// The font size is a CSS variable of the editing surface: CodeMirror inherits it, Monaco is told it.
	useLayoutEffect(() => {
		const element = host.current;
		if (layout.fontSize === null) element?.style.removeProperty("--sh-ide-font-size");
		else element?.style.setProperty("--sh-ide-font-size", `${layout.fontSize}px`);
	}, [layout.fontSize]);
	const metrics = useEditorMetrics(host, layout.fontSize);
	const [treeOpen, setTreeOpen] = useState(() => mem.tabs.length === 0 || viewportWide || initialView !== undefined);
	// A tab has the room for the explorer beside the editor: show it.
	useEffect(() => {
		if (placement === "tab") setTreeOpen(true);
	}, [placement]);
	const [sidebarView, setSidebarView] = useState(initialView);
	const sidebar = useRef<ExplorerSidebarHandle>(null);
	const [expanded, setExpanded] = useState(mem.expanded);
	const [opening, setOpening] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
	const [definition, setDefinition] = useState<DefinitionState | null>(null);
	const [references, setReferences] = useState<{ title: string; locations: LspLocation[] } | null>(null);
	const [panelTab, setPanelTab] = useState<PanelTab>("problems");
	// Bumped when a tab's text changes (after a pause in typing) so its rendered preview is made again.
	const [previewTick, bumpPreview] = useReducer((n: number) => n + 1, 0);
	const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(previewTimer.current), []);
	/** Open the bottom panel on `tab`. */
	const showPanel = useCallback((tab: PanelTab) => {
		setPanelTab(tab);
		updateEditorLayout({ panelOpen: true });
	}, []);
	// The explorer holds the search's query and options; its matches are listed in the panel.
	const explorer = explorerMemory(instanceId);
	const [searchForm, setSearchFormState] = useState<SearchForm>(explorer.search);
	const setSearchForm = useCallback(
		(next: SearchForm) => {
			explorer.search = next;
			setSearchFormState(next);
		},
		[explorer],
	);
	const search = useFileSearch(client, instanceId, canSearch, searchForm);
	// A search that runs brings its matches forward.
	useEffect(() => {
		if (search.runs > 0) showPanel("search");
	}, [search.runs, showPanel]);

	const pref = useEditorEnginePref();
	const editorTheme = useEditorThemePref();
	const themeStyle = useMemo(() => editorThemeVars(editorTheme) as CSSProperties | null, [editorTheme]);
	const [engine, setEngine] = useState<EditorEngine | null>(() => {
		const ready = readyEngine(wantedEngine(pref));
		return ready !== null && mem.tabs.every(tab => tab.kind !== "text" || mem.docs[tab.path]?.engine === ready.name)
			? ready
			: null;
	});
	const engineRef = useRef(engine);
	engineRef.current = engine;

	const loadTree = useCallback(() => client.requestTree(instanceId), [client, instanceId]);
	const { state: treeState, reload: reloadTree } = useRequest<FileTree>(loadTree);
	const tree = treeState.status === "ready" ? treeState.value : null;
	if (tree !== null) mem.root = tree.root;

	const notify = useCallback((text: string) => setNotice(text), []);
	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);

	useEffect(() => {
		mem.expanded = expanded;
	}, [mem, expanded]);

	// The sidebar reads its starting view when it mounts: once it has, forget the request.
	useEffect(() => {
		if (treeOpen && sidebarView !== undefined) setSidebarView(undefined);
	}, [treeOpen, sidebarView]);

	const findTab = (path: string): Tab | undefined => mem.tabs.find(tab => tab.path === path);
	const patchTab = (path: string, patch: Partial<Tab>): void => {
		if (findTab(path) === undefined) return;
		mem.tabs = mem.tabs.map(tab => (tab.path === path ? { ...tab, ...patch } : tab));
		rerender();
	};
	const activeDoc = (): EditorDoc | null => (mem.active === null ? null : (mem.docs[mem.active] ?? null));

	const syncCursor = (): void => {
		const doc = activeDoc();
		if (doc !== null) setCursor(doc.cursor());
	};

	// ---- the engine: chosen by the setting and the browser, loaded on demand, documents moved to it ----
	useEffect(() => {
		const name = wantedEngine(pref);
		if (engineRef.current?.name === name) return;
		let stale = false;
		// The view goes first: the documents it shows are about to change hands.
		viewRef.current?.destroy();
		viewRef.current = null;
		engineRef.current = null;
		setEngine(null);
		void (async () => {
			let next: EditorEngine;
			try {
				next = await loadEngine(name);
			} catch (err) {
				if (name === "codemirror") throw err;
				notify(`Monaco could not be loaded (${messageOf(err)}); using CodeMirror`);
				next = await loadEngine("codemirror");
			}
			await adoptDocs(mem, next, instanceId);
			if (stale) return;
			engineRef.current = next;
			setEngine(next);
		})().catch((err: unknown) => notify(`Could not start the editor: ${messageOf(err)}`));
		return () => {
			stale = true;
		};
	}, [pref, mem, instanceId, notify]);

	const activate = (path: string, line?: number, character?: number): void => {
		const view = viewRef.current;
		if (view === null || findTab(path) === undefined) return;
		if (mem.active !== path) {
			mem.active = path;
			view.show(mem.docs[path] ?? null);
			setExpanded(prev => {
				const next = { ...prev };
				for (const dir of ancestors(path)) next[dir] = true;
				return next;
			});
			rerender();
		}
		if (line !== undefined && mem.docs[path] !== undefined) view.reveal({ line, character });
		syncCursor();
		if (overlayRef.current) setTreeOpen(false);
	};

	// ---- language server: problems, hover, go to definition, find references ----
	const diagnosticTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const timers = diagnosticTimers.current;
		return () => {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		};
	}, []);

	/** The file has no language server: say so once, and ask nothing more for it. */
	const markNoServer = (path: string): void => {
		if (mem.noServer[path] === true) return;
		mem.noServer[path] = true;
		patchTab(path, { server: null, diagnostics: null, lspNote: unavailableNote(path) });
	};

	const lspQuery = (op: LspQuery["op"], doc: EditorDoc, position: Pos): LspQuery => ({
		op,
		path: doc.path,
		position,
		text: doc.isDirty() ? doc.text() : undefined,
	});

	const refreshProblems = async (path: string): Promise<void> => {
		const doc = mem.docs[path];
		if (!canLsp || doc === undefined || mem.noServer[path] === true || findTab(path) === undefined) return;
		const revision = mem.revisions[path] ?? 0;
		try {
			const result = await client.requestDiagnostics(instanceId, path, doc.isDirty() ? doc.text() : undefined);
			if (mem.docs[path] !== doc) return;
			if (result.kind === "unavailable") {
				markNoServer(path);
				return;
			}
			// No fresh report: keep what is shown. Edited since asking: the next request answers for the new text.
			if (result.diagnostics === null || (mem.revisions[path] ?? 0) !== revision) return;
			doc.setDiagnostics(result.diagnostics);
			patchTab(path, { server: result.server, diagnostics: result.diagnostics, lspNote: null });
		} catch {
			// Offline or the companion is restarting: the next edit or save asks again.
		}
	};
	const scheduleProblems = (path: string, delay: number): void => {
		if (!canLsp) return;
		const timers = diagnosticTimers.current;
		clearTimeout(timers.get(path));
		timers.set(
			path,
			setTimeout(() => {
				timers.delete(path);
				void refreshProblems(path);
			}, delay),
		);
	};

	const hover = async (doc: EditorDoc, position: Pos, signal: AbortSignal): Promise<HoverAnswer | null> => {
		if (mem.noServer[doc.path] === true) return null;
		const result = await client.requestLsp(instanceId, lspQuery("hover", doc, position));
		if (signal.aborted) return null;
		if (result.kind === "unavailable") {
			markNoServer(doc.path);
			return null;
		}
		if (result.kind !== "hover" || result.markdown === null || result.markdown.trim() === "") return null;
		return { markdown: result.markdown, range: result.range };
	};

	const openLocation = (path: string, line: number, character?: number): void =>
		void openFile(absolutePath(mem, path), line, character);

	const definitionAt = async (doc: EditorDoc, position: Pos): Promise<void> => {
		if (!canLsp && !canDefinition) {
			notify("Go to definition needs a language server or the code map on the paired computer");
			return;
		}
		const word = doc.wordAt(position) ?? "";
		if (canLsp && mem.noServer[doc.path] !== true) {
			setDefinition({ word, rows: null, source: "language server" });
			try {
				const result = await client.requestLsp(instanceId, lspQuery("definition", doc, position));
				if (result.kind === "unavailable") markNoServer(doc.path);
				const target = chooseDefinitionTarget(result);
				if (target.kind === "open") {
					setDefinition(null);
					openLocation(target.path, target.line, target.character);
					return;
				}
				if (target.kind === "list") {
					setDefinition({ word, rows: target.locations.map(locationRow), source: "language server" });
					return;
				}
			} catch {
				// The server is not answering: the code map may still know the name.
			}
		}
		if (word === "") {
			setDefinition(null);
			return;
		}
		if (!canDefinition) {
			setDefinition({ word, rows: [], source: "language server" });
			return;
		}
		setDefinition({ word, rows: null, source: "code map" });
		try {
			const hits = (await client.searchCodemap(instanceId, word)).filter(
				hit => hit.kind === "symbol" && hit.line !== undefined,
			);
			const exact = hits.filter(hit => lastSegment(hit.label) === word);
			const picks = exact.length > 0 ? exact : hits;
			if (picks.length === 1) {
				setDefinition(null);
				openLocation(picks[0]!.path, picks[0]!.line!);
			} else {
				setDefinition({ word, rows: picks.map(codemapRow), source: "code map" });
			}
		} catch (err) {
			setDefinition({ word, rows: [], error: messageOf(err), source: "code map" });
		}
	};

	const referencesAt = async (doc: EditorDoc, position: Pos): Promise<void> => {
		if (!canLsp) {
			notify("Find references needs a language server on the paired computer");
			return;
		}
		if (mem.noServer[doc.path] === true) {
			notify(unavailableNote(doc.path));
			return;
		}
		const word = doc.wordAt(position) ?? "symbol";
		try {
			const result = await client.requestLsp(instanceId, lspQuery("references", doc, position));
			if (result.kind === "unavailable") {
				markNoServer(doc.path);
				notify(unavailableNote(doc.path));
			} else if (result.kind === "locations") {
				setReferences({ title: `References to ${word}`, locations: result.locations });
				showPanel("references");
			}
		} catch (err) {
			notify(`Could not find references: ${messageOf(err)}`);
		}
	};

	const openFile = async (request: string, line?: number, character?: number): Promise<void> => {
		const used = engineRef.current;
		if (used === null) {
			notify("The editor is still loading");
			return;
		}
		const known = mem.tabs.find(tab => tab.request === request || absolutePath(mem, tab.path) === request);
		if (known !== undefined) {
			activate(known.path, line, character);
			return;
		}
		setOpening(request);
		try {
			const [file, firstLanguage] = await Promise.all([
				client.requestFile(instanceId, request),
				used.loadLanguage(request),
			]);
			let language = firstLanguage;
			// An SVG that came whole is text with a rendered form; any other image, and a PDF, opens in a viewer.
			const kind = viewerKind(request);
			const wholeSvg = previewKind(file.path) === "svg" && file.text !== null && !file.truncated;
			if (kind !== "text" && !wholeSvg) {
				if (findTab(file.path) === undefined) {
					mem.tabs = [
						...mem.tabs,
						{
							path: file.path,
							request: mem.root === null ? request : absolutePath(mem, file.path),
							version: file.version,
							writable: false,
							truncated: false,
							language: kind === "pdf" ? "PDF" : "Image",
							dirty: false,
							saving: false,
							conflict: null,
							changed: 0,
							server: null,
							diagnostics: null,
							lspNote: null,
							kind,
							size: file.size,
							preview: null,
							mode: "source",
						},
					];
				}
				activate(file.path, line, character);
				return;
			}
			if (file.text === null) {
				notify(`${file.path} is a binary file`);
				return;
			}
			if (findTab(file.path) === undefined) {
				// The setting changed while the file was coming: build the document for the engine now in charge.
				const now = engineRef.current;
				if (now === null) {
					notify("The editor is still loading");
					return;
				}
				if (now !== used) language = await now.loadLanguage(request);
				const writable = file.writable && !readOnly;
				mem.docs[file.path] = now.createDoc({
					path: file.path,
					scope: instanceId,
					text: file.text,
					writable,
					language,
				});
				mem.tabs = [
					...mem.tabs,
					{
						path: file.path,
						request: mem.root === null ? request : absolutePath(mem, file.path),
						version: file.version,
						writable,
						truncated: file.truncated,
						language: language.name,
						dirty: false,
						saving: false,
						conflict: null,
						changed: 0,
						server: null,
						diagnostics: null,
						lspNote: null,
						kind: "text",
						size: file.size,
						preview: previewKind(file.path),
						mode: previewKind(file.path) === null ? "source" : defaultPreviewMode(previewKind(file.path)!),
					},
				];
				scheduleProblems(file.path, 0);
			}
			activate(file.path, line, character);
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
		const doc = mem.docs[path];
		delete mem.docs[path];
		delete mem.revisions[path];
		delete mem.noServer[path];
		delete mem.attribution[path];
		clearTimeout(diagnosticTimers.current.get(path));
		diagnosticTimers.current.delete(path);
		if (mem.active === path) {
			const next = mem.tabs[Math.min(index, mem.tabs.length - 1)];
			mem.active = null;
			if (next !== undefined) activate(next.path);
			else viewRef.current?.show(null);
		}
		doc?.dispose();
		rerender();
	};

	/** Bring the disk's text into a tab. `marked`: highlight the lines it changed (an agent's edit). */
	const reloadFromDisk = async (path: string, marked: boolean): Promise<void> => {
		const tab = findTab(path);
		if (tab === undefined) return;
		const file = await client.requestFile(instanceId, tab.request);
		const now = findTab(path);
		if (now === undefined) return;
		// An image or PDF has no text to merge: the new version makes its viewer fetch the bytes again.
		if (now.kind !== "text") {
			patchTab(path, { version: file.version, size: file.size, conflict: null });
			return;
		}
		const doc = mem.docs[path];
		if (doc === undefined) return;
		if (file.text === null) {
			patchTab(path, { conflict: { kind: "gone" } });
			return;
		}
		// An agent's edit to a clean file is not the user's to undo; discarded edits are.
		const changedLines = doc.applyDisk(file.text, { mark: marked, undoable: now.dirty });
		mem.revisions[path] = (mem.revisions[path] ?? 0) + 1;
		bumpPreview();
		patchTab(path, {
			version: file.version,
			dirty: false,
			conflict: null,
			truncated: file.truncated,
			changed: marked ? changedLines.length : 0,
		});
		if (path === mem.active) syncCursor();
		scheduleProblems(path, 0);
	};

	/** Write the tab's text. `base`: overwrite the disk version the user chose to replace. */
	const save = async (path: string | null, base?: string): Promise<void> => {
		const tab = path === null ? undefined : findTab(path);
		const doc = path === null ? undefined : mem.docs[path];
		if (path === null || tab === undefined || doc === undefined || !tab.writable || tab.saving) return;
		if (!tab.dirty && base === undefined) return;
		const snapshot = doc.snapshot();
		patchTab(path, { saving: true });
		try {
			const version = await client.writeFile(instanceId, tab.request, snapshot.text, base ?? tab.version);
			doc.markClean(snapshot);
			if (findTab(path) !== undefined) {
				patchTab(path, { version, saving: false, conflict: null, dirty: doc.isDirty() });
				notify(`Saved ${baseName(path)}`);
				scheduleProblems(path, 0);
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

	const sendSelection = (): void => {
		const doc = activeDoc();
		if (onSendToAgent === null || mem.active === null || doc === null) return;
		const { from, to, text } = doc.selectedLines();
		const fence = fenceFor(text);
		const ext = mem.active.slice(mem.active.lastIndexOf(".") + 1);
		const lines = from === to ? `${from}` : `${from}-${to}`;
		onSendToAgent(`\`${mem.active}:${lines}\`\n${fence}${ext}\n${text}\n${fence}\n`);
		// Beside the conversation or in a tab, the editor stays next to the message box the text just went to.
		if (placement === "float") onClose();
	};

	const quickInput = useRef<HTMLInputElement>(null);
	const searchFiles = (): void => {
		if (treeOpen) {
			sidebar.current?.focusSearch();
		} else {
			setSidebarView("search");
			setTreeOpen(true);
		}
	};
	const shortcut = (kind: "save" | "quick-open" | "search-files"): void => {
		if (kind === "save") void save(mem.active);
		else if (kind === "quick-open") quickInput.current?.focus();
		else searchFiles();
	};

	// The view calls through `hooksRef`: point it at this render's closures.
	useLayoutEffect(() => {
		hooksRef.current = {
			changed: (doc, text) => {
				const tab = findTab(doc.path);
				if (text) {
					mem.revisions[doc.path] = (mem.revisions[doc.path] ?? 0) + 1;
					scheduleProblems(doc.path, DIAGNOSTICS_DEBOUNCE_MS);
					const dirty = doc.isDirty();
					// Typing clears the lines marked as changed on disk.
					if (tab !== undefined && (tab.dirty !== dirty || tab.changed > 0))
						patchTab(doc.path, { dirty, changed: 0 });
					if (tab !== undefined && tab.mode !== "source") {
						clearTimeout(previewTimer.current);
						previewTimer.current = setTimeout(bumpPreview, PREVIEW_DEBOUNCE_MS);
					}
				}
				if (doc.path === mem.active) syncCursor();
			},
			definition: (doc, position) => void definitionAt(doc, position),
			references: (doc, position) => void referencesAt(doc, position),
			shortcut,
			hover: canLsp ? hover : undefined,
			attribution: (_doc, tip) => notify(tip.replaceAll("\n", " · ")),
		};
	});

	// One view for the engine's lifetime in this sheet; tabs swap their documents in and out of it.
	useLayoutEffect(() => {
		const parent = host.current;
		if (parent === null || engine === null) return;
		const view = engine.createView(parent, () => hooksRef.current!);
		viewRef.current = view;
		const doc = activeDoc();
		view.show(doc);
		if (doc !== null) syncCursor();
		return () => {
			// The engine effect may have torn it down already.
			if (viewRef.current === view) {
				view.destroy();
				viewRef.current = null;
			}
		};
	}, [mem, engine]);

	// The layout's choices and the font size reach the editing surface.
	useEffect(() => {
		if (metrics.fontSize === null) return;
		viewRef.current?.setLayout({
			fontSize: metrics.fontSize,
			lineNumbers: layout.lineNumbers,
			minimap: layout.minimap,
			roomy: placement === "tab",
		});
	}, [engine, metrics.fontSize, layout.lineNumbers, layout.minimap, placement]);

	// A fresh view starts without the problems of the old one: ask again for the file in front.
	useEffect(() => {
		if (engine !== null && canLsp && mem.active !== null) scheduleProblems(mem.active, 0);
	}, [engine, canLsp]);

	// ---- line attribution: a gutter bar on the lines agents wrote ----
	const canAttribution = client.getSnapshot().canAttribution;
	const showAttribution = layout.attribution && canAttribution;
	const showAttributionRef = useRef(showAttribution);
	showAttributionRef.current = showAttribution;

	/** Put the marks the companion answered for `path` on its document, or take them off while the layout hides them. */
	const applyAttribution = (path: string): void => {
		const doc = mem.docs[path];
		const tab = findTab(path);
		if (doc === undefined || tab === undefined) return;
		if (!showAttributionRef.current) {
			doc.setAttribution([]);
			return;
		}
		const found = mem.attribution[path];
		// Lines are numbered in the version the answer is for: another version, or text typed since, has other numbers.
		if (found?.version === tab.version && !doc.isDirty()) doc.setAttribution(attributionMarks(found));
	};
	const attributionPath = mem.active;
	const attributionVersion = mem.tabs.find(tab => tab.path === attributionPath)?.version;
	useEffect(() => {
		if (engine === null) return;
		if (!showAttribution) {
			for (const path of Object.keys(mem.docs)) applyAttribution(path);
			return;
		}
		if (attributionPath === null || attributionVersion === undefined) return;
		const path = attributionPath;
		if (mem.attribution[path]?.version === attributionVersion) {
			applyAttribution(path);
			return;
		}
		const doc = mem.docs[path];
		let stale = false;
		// An agent that edits steadily changes the file every few seconds: ask once it has paused.
		const timer = setTimeout(() => {
			const tab = findTab(path);
			if (tab === undefined) return;
			client.requestAttribution(instanceId, tab.request).then(
				result => {
					if (stale || mem.docs[path] !== doc) return;
					mem.attribution[path] = result;
					applyAttribution(path);
				},
				() => {
					// The bars are decoration: a computer that cannot answer leaves the editor as it was.
				},
			);
		}, ATTRIBUTION_DEBOUNCE_MS);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [engine, showAttribution, attributionPath, attributionVersion]);

	const openRef = useRef(openFile);
	openRef.current = openFile;
	// Open the requested file, now and whenever the app asks for another (once the editor is up).
	const handledTarget = useRef<typeof target>(null);
	useEffect(() => {
		if (engine === null || target === null || handledTarget.current === target) return;
		handledTarget.current = target;
		void openRef.current(target.path, target.line);
	}, [target, engine]);

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

	/** The font size one step from what the editor shows now (the app's own size until a choice is made). */
	const stepFont = (direction: 1 | -1): void =>
		updateEditorLayout({ fontSize: stepFontSize(metrics.fontSize ?? FALLBACK_FONT_SIZE, direction) });

	const onSheetKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isDefaultPrevented()) return;
		// The browser's own zoom keys are taken here only: with the focus in the sheet they size the editor's text.
		const font = fontShortcut(e);
		if (font !== null) {
			e.preventDefault();
			if (font === "reset") updateEditorLayout({ fontSize: null });
			else stepFont(font === "bigger" ? 1 : -1);
			return;
		}
		const key = e.key.toLowerCase();
		if (key === "p" && !e.shiftKey) {
			e.preventDefault();
			shortcut("quick-open");
		} else if (key === "s" && !e.shiftKey) {
			e.preventDefault();
			shortcut("save");
		} else if (key === "f" && e.shiftKey) {
			e.preventDefault();
			shortcut("search-files");
		}
	};

	const active = mem.active === null ? undefined : findTab(mem.active);
	// Markdown and SVG files are drawn beside their source, or instead of it; images and PDFs have no source to show.
	const previewShown =
		active !== undefined && active.kind === "text" && active.preview !== null && active.mode !== "source";
	const editorHidden =
		active === undefined || active.kind !== "text" || (active.preview !== null && active.mode === "preview");
	const previewDoc = previewShown ? (mem.docs[active.path] ?? null) : null;
	// `previewTick` is the change signal: the text is read once per pause in typing, not on every keystroke.
	const previewText = useMemo(() => previewDoc?.text() ?? "", [previewDoc, previewTick]);
	const toRequest = useCallback((rel: string) => absolutePath(mem, rel), [mem]);
	// Side by side needs room: in a narrow editor the two halves stack.
	const codeWidth = bodyWidth === null ? null : bodyWidth - (treeOpen && !overlay ? explorerWidth : 0);
	const stackedSplit = codeWidth !== null && codeWidth < SPLIT_STACK_WIDTH;
	const expandedSet = useMemo(() => new Set(Object.keys(expanded)), [expanded]);
	const toggleDir = useCallback((path: string) => {
		setExpanded(prev => {
			const next = { ...prev };
			if (next[path]) delete next[path];
			else next[path] = true;
			return next;
		});
	}, []);
	const openFromExplorer = useCallback(
		(rel: string, line?: number, character?: number) => void openRef.current(absolutePath(mem, rel), line, character),
		[mem],
	);
	const clearReferences = useCallback(() => setReferences(null), []);
	const openActiveDefinition = (): void => {
		const doc = activeDoc();
		if (doc !== null) void definitionAt(doc, doc.head());
	};
	const findActiveReferences = (): void => {
		const doc = activeDoc();
		if (doc !== null) void referencesAt(doc, doc.head());
	};
	const problems = useMemo(
		() => problemRows(mem.tabs.map(tab => ({ path: tab.path, diagnostics: tab.diagnostics }))),
		[mem.tabs],
	);
	const activeCounts = active?.diagnostics == null ? null : countDiagnostics(active.diagnostics);
	const issues = problems.filter(row => row.severity === "error" || row.severity === "warning").length;
	const panelCounts: Record<PanelTab, number | null> = {
		problems: issues > 0 ? issues : null,
		references: references === null ? null : references.locations.length,
		search: search.state.status === "done" ? search.state.result.matches.length : null,
	};

	// The header answers to the editor's own width (a pane beside the conversation is narrow on a wide screen):
	// what does not fit moves into the Layout menu, and the file finder keeps its room.
	const headTier = headTierFor(bodyWidth);
	const menuActions: MenuAction[] = [];
	if (headTier !== "full") {
		menuActions.push(
			{
				id: "font-up",
				label: "Larger text",
				hint: "Cmd/Ctrl +",
				icon: "A+",
				disabled: metrics.fontSize !== null && metrics.fontSize >= FONT_MAX,
				keepOpen: true,
				onSelect: () => stepFont(1),
			},
			{
				id: "font-down",
				label: "Smaller text",
				hint: "Cmd/Ctrl −",
				icon: "A−",
				disabled: metrics.fontSize !== null && metrics.fontSize <= FONT_MIN,
				keepOpen: true,
				onSelect: () => stepFont(-1),
			},
		);
	}
	if (headTier === "tight") {
		if (canDefinition || canLsp) {
			menuActions.push({
				id: "definition",
				label: "Go to definition",
				hint: "F12",
				icon: <LocateFixed size={14} />,
				disabled: active === undefined,
				onSelect: openActiveDefinition,
			});
		}
		if (canLsp) {
			menuActions.push({
				id: "references",
				label: "Find references",
				hint: "Shift+F12",
				icon: <ListTree size={14} />,
				disabled: active === undefined,
				onSelect: findActiveReferences,
			});
		}
		if (onSendToAgent !== null) {
			menuActions.push({
				id: "ask",
				label: "Ask the agent about the selection",
				icon: <MessageSquarePlus size={14} />,
				disabled: active === undefined,
				onSelect: sendSelection,
			});
		}
		if (onSparDesign != null && active !== undefined && DESIGN_FILE.test(active.path)) {
			menuActions.push({
				id: "spar",
				label: "Spar with this design",
				icon: <Swords size={14} />,
				onSelect: () => onSparDesign(active.path),
			});
		}
		if (active !== undefined && diagramFileKind(active.request) !== null) {
			menuActions.push({
				id: "canvas",
				label: "Open in the canvas",
				icon: <PenLine size={14} />,
				onSelect: () => openDiagramFile(active.request),
			});
		}
	}

	const frame = (
		<div className="sh-ide" data-editor-theme={editorTheme} style={themeStyle ?? undefined} onKeyDown={onSheetKey}>
			<div className="sh-sheet-head sh-ide-head" data-tier={headTier}>
				<button
					type="button"
					className={treeOpen ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
					onClick={() => setTreeOpen(open => !open)}
					aria-label={treeOpen ? "Hide the explorer" : "Show the explorer"}
					aria-pressed={treeOpen}
					title="Explorer"
				>
					<PanelLeft size={16} />
				</button>
				<QuickOpen inputRef={quickInput} files={tree?.files ?? null} onOpen={openFromExplorer} />
				<span className="sh-ide-actions">
					{headTier !== "tight" && (canDefinition || canLsp) && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={openActiveDefinition}
							disabled={active === undefined || active.kind !== "text"}
							aria-label="Go to definition"
							title="Go to definition (F12, or Cmd/Ctrl+click)"
						>
							<LocateFixed size={16} />
						</button>
					)}
					{headTier !== "tight" && canLsp && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={findActiveReferences}
							disabled={active === undefined || active.kind !== "text"}
							aria-label="Find references"
							title="Find references (Shift+F12)"
						>
							<ListTree size={16} />
						</button>
					)}
					{headTier !== "tight" && onSendToAgent !== null && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={sendSelection}
							disabled={active === undefined || active.kind !== "text"}
							aria-label="Ask the agent about the selection"
							title="Ask the agent about the selection"
						>
							<MessageSquarePlus size={16} />
						</button>
					)}
					{headTier !== "tight" &&
						onSparDesign != null &&
						active !== undefined &&
						DESIGN_FILE.test(active.path) && (
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
					{headTier !== "tight" && active !== undefined && (
						<DownloadButton client={client} instanceId={instanceId} path={active.request} />
					)}
					{headTier !== "tight" && active !== undefined && diagramFileKind(active.request) !== null && (
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
					{headTier === "full" && (
						<span className="sh-ide-font" role="group" aria-label="Editor font size">
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => stepFont(-1)}
								disabled={metrics.fontSize !== null && metrics.fontSize <= FONT_MIN}
								aria-label="Smaller text"
								title="Smaller text (Cmd/Ctrl+−)"
							>
								A−
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-icon"
								onClick={() => stepFont(1)}
								disabled={metrics.fontSize !== null && metrics.fontSize >= FONT_MAX}
								aria-label="Larger text"
								title="Larger text (Cmd/Ctrl++)"
							>
								A+
							</button>
						</span>
					)}
					<LayoutMenu
						layout={layout}
						minimapOn={minimapShown(layout.minimap, placement === "tab", metrics.width)}
						hasMinimap={engine?.name === "monaco"}
						hasAttribution={canAttribution}
						actions={menuActions}
						extra={
							headTier === "tight" && active !== undefined ? (
								<DownloadButton
									client={client}
									instanceId={instanceId}
									path={active.request}
									label="Download file"
								/>
							) : null
						}
						onToggle={(id, on) => updateEditorLayout({ [id]: on })}
						onReset={resetEditorLayout}
					/>
					<SheetPlacementButton />
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="Close">
						<X size={16} />
					</button>
				</span>
			</div>
			<div ref={body} className="sh-ide-body">
				{treeOpen && (
					<ExplorerSidebar
						ref={sidebar}
						client={client}
						instanceId={instanceId}
						tree={tree}
						treeError={treeState.status === "error" ? treeState.message : null}
						onReloadTree={reloadTree}
						activePath={mem.active}
						expanded={expandedSet}
						onToggleDir={toggleDir}
						form={searchForm}
						onForm={setSearchForm}
						invalid={search.invalid}
						edits={edits}
						onOpen={openFromExplorer}
						overlay={overlay}
						width={explorerWidth}
						onWidth={setExplorerWidth}
						showRail={layout.rail}
						initialView={sidebarView}
					/>
				)}
				<section className="sh-ide-main">
					{layout.tabs && (
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
					)}
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
					<div className="sh-ide-code">
						{active?.preview != null && (
							<div className="sh-view-bar sh-ide-modebar">
								<PreviewModeToggle
									mode={active.mode}
									modes={PREVIEW_MODES}
									onChange={mode => patchTab(active.path, { mode })}
								/>
							</div>
						)}
						<div className="sh-ide-panes" data-stack={stackedSplit ? "true" : undefined} hidden={active === undefined}>
							<div
								ref={host}
								className="sh-ide-editor"
								data-line-numbers={layout.lineNumbers ? undefined : "off"}
								hidden={editorHidden}
							/>
							{active !== undefined && active.kind !== "text" && (
								<FileViewer
									key={active.path}
									client={client}
									instanceId={instanceId}
									path={active.request}
									version={active.version}
									size={active.size}
									kind={active.kind}
								/>
							)}
							{previewShown && active !== undefined && (
								<div className="sh-ide-preview">
									{active.preview === "svg" ? (
										<SvgPreview key={active.path} text={previewText} name={baseName(active.path)} />
									) : (
										<MarkdownPreview
											key={active.path}
											text={previewText}
											file={active.path}
											client={client}
											instanceId={instanceId}
											toRequest={toRequest}
										/>
									)}
								</div>
							)}
						</div>
						{engine === null && (
							<div className="sh-companion-empty sh-file-status">
								<LoaderCircle size={14} className="sh-spin" /> Loading the editor…
							</div>
						)}
						{active === undefined && engine !== null && (
							<div className="sh-ide-empty">
								<FileCode size={28} />
								<div>Pick a file from the list, or press Cmd/Ctrl+P to find one.</div>
							</div>
						)}
						{definition !== null && (
							<DefinitionList
								definition={definition}
								size={layout.defsSize}
								onSize={size => updateEditorLayout({ defsSize: size })}
								onPick={row => {
									if (row.open === null) return;
									setDefinition(null);
									openLocation(row.open.path, row.open.line, row.open.character);
								}}
								onClose={() => setDefinition(null)}
							/>
						)}
						{!layout.status && notice !== null && (
							<div className="sh-ide-toast" role="status">
								{notice}
							</div>
						)}
					</div>
					<BottomPanel
						tab={panelTab}
						onTab={setPanelTab}
						open={layout.panelOpen}
						onOpenChange={panelOpen => updateEditorLayout({ panelOpen })}
						height={layout.panelHeight}
						onHeight={panelHeight => updateEditorLayout({ panelHeight })}
						counts={panelCounts}
					>
						{panelTab === "problems" && (
							<ProblemsView
								rows={problems}
								emptyNote={
									canLsp
										? "No problems in the open files."
										: "Problems need a language server on the paired computer."
								}
								onOpen={activate}
							/>
						)}
						{panelTab === "references" && (
							<ReferencesResults references={references} onOpen={openFromExplorer} onClear={clearReferences} />
						)}
						{panelTab === "search" && (
							<SearchResults
								search={search}
								canSearch={canSearch}
								query={searchForm.query}
								onOpen={openFromExplorer}
							/>
						)}
					</BottomPanel>
					{layout.status && (
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
									{active.server !== null && activeCounts !== null && (
										<button
											type="button"
											className="sh-ide-status-lsp sh-ide-status-btn"
											title={`Language server: ${active.server}. Show the problems`}
											onClick={() => showPanel("problems")}
										>
											{active.server}
											<span data-severity="error">
												{activeCounts.errors} error{activeCounts.errors === 1 ? "" : "s"}
											</span>
											<span data-severity="warning">
												{activeCounts.warnings} warning{activeCounts.warnings === 1 ? "" : "s"}
											</span>
										</button>
									)}
									{active.lspNote !== null && <span className="sh-ide-status-lsp">{active.lspNote}</span>}
									<span>{active.language ?? "Plain text"}</span>
									{active.kind === "text" && (
										<span>
											Ln {cursor.line}, Col {cursor.col}
											{cursor.selected > 0 ? ` (${cursor.selected} selected)` : ""}
										</span>
									)}
								</>
							)}
							{metrics.fontSize !== null && (
								<span title="Editor font size (A−, A+, Cmd/Ctrl +, −, 0)">
									{formatFontSize(metrics.fontSize)}
								</span>
							)}
							{notice !== null && (
								<span className="sh-ide-notice" role="status">
									{notice}
								</span>
							)}
						</div>
					)}
				</section>
			</div>
		</div>
	);
	return (
		<Sheet label="editor" size="full" pane="editor" onClose={onClose}>
			{frame}
		</Sheet>
	);
}

function codemapRow(hit: CodemapNode): DefinitionRow {
	return {
		key: `${hit.path}:${hit.line}:${hit.label}`,
		label: hit.label,
		where: `${hit.path}:${hit.line}`,
		signature: hit.signature,
		open: { path: hit.path, line: hit.line! },
	};
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
				<span>
					{tab.kind === "text"
						? "This file was deleted or is no longer text on the computer."
						: "This file was deleted from the computer."}
				</span>
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
