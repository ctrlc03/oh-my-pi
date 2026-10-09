import { ArrowLeft, ChevronRight, LoaderCircle, RefreshCw, Search, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	CodemapFlowDirection,
	CodemapFocus,
	CodemapNode,
	CodemapView,
	CompanionClient,
} from "../../lib/companion";
import { useRequest } from "../../lib/use-request";
import { Sheet } from "../shell/Sheet";
import { FileSessions } from "./FileSessions";
import { FlowGraph } from "./FlowGraph";
import { FocusGraph } from "./FocusGraph";
import { ForceMap } from "./ForceMap";
import { focusOf, NodeRow, sameFocus, useMedia, WIDE_QUERY } from "./shared";

const SEARCH_DEBOUNCE_MS = 250;

type FolderTab = "map" | "links";
type SymbolTab = "neighbours" | "flow";

const FOLDER_TABS: { value: FolderTab; label: string }[] = [
	{ value: "map", label: "Map" },
	{ value: "links", label: "Links" },
];
const SYMBOL_TABS: { value: SymbolTab; label: string }[] = [
	{ value: "neighbours", label: "Neighbours" },
	{ value: "flow", label: "Flow" },
];

export interface CodemapSheetProps {
	client: CompanionClient;
	/** Companion host of the session whose repository is mapped. */
	instanceId: string;
	/** Start on this file instead of the repository root: absolute, or relative to the repository root. */
	initialFile?: string;
	/** The companion can start omp, so ended sessions in "sessions that changed this file" can be resumed. */
	canStart: boolean;
	/** Session on screen: marked and not openable. */
	currentSessionId: string | null;
	/** Fetch a link for a hosting session and join it; rejects with a readable message. */
	onOpenHost(instanceId: string): Promise<void>;
	onOpenLink(link: string): void;
	/** Show a file, scrolled to `line` when given. */
	onOpenFile(path: string, line?: number): void;
	onClose(): void;
}

/**
 * Browsable code map of the session's repository: folders and files by dependency, a symbol's
 * callers and callees, and cross-language flow walks. Every click re-centres on the clicked node.
 */
export function CodemapSheet({
	client,
	instanceId,
	initialFile,
	canStart,
	currentSessionId,
	onOpenHost,
	onOpenLink,
	onOpenFile,
	onClose,
}: CodemapSheetProps): ReactNode {
	const wide = useMedia(WIDE_QUERY);
	const [focus, setFocus] = useState<CodemapFocus>(
		initialFile === undefined ? { kind: "dir", path: "" } : { kind: "file", path: initialFile },
	);
	const [trail, setTrail] = useState<CodemapFocus[]>([]);
	const [folderTab, setFolderTab] = useState<FolderTab>("map");
	const [symbolTab, setSymbolTab] = useState<SymbolTab>("neighbours");
	const [flowDirection, setFlowDirection] = useState<CodemapFlowDirection>("down");
	const [query, setQuery] = useState("");
	const [searched, setSearched] = useState("");

	// The walk is only asked for while the Flow tab is showing.
	const flow = focus.kind === "symbol" && symbolTab === "flow" ? flowDirection : undefined;
	const load = useCallback(() => client.requestCodemap(instanceId, focus, flow), [client, instanceId, focus, flow]);
	const { state, reload } = useRequest(load);
	// Keep the previous view on screen (dimmed) while the next one loads.
	const shown = useRef<CodemapView | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const view = shown.current;
	const loading = state.status === "loading";

	useEffect(() => {
		const timer = setTimeout(() => setSearched(query.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);

	const go = useCallback(
		(next: CodemapFocus): void => {
			if (sameFocus(next, focus)) return;
			setTrail(t => [...t, focus]);
			setFocus(next);
			setQuery("");
		},
		[focus],
	);
	const goNode = useCallback((node: CodemapNode): void => go(focusOf(node)), [go]);
	const back = (): void => {
		const previous = trail[trail.length - 1];
		if (!previous) return;
		setTrail(trail.slice(0, -1));
		setFocus(previous);
	};

	const crumbs = useRef<HTMLElement>(null);
	// Keep the deepest crumb in sight on narrow screens.
	useLayoutEffect(() => {
		if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth;
	}, [view]);

	const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key !== "Escape" || query === "") return;
		// Clear the query first; only an empty field lets Escape close the sheet.
		e.stopPropagation();
		setQuery("");
	};

	const searching = query.trim() !== "";
	const showMap = view?.focus.kind === "dir" && wide && folderTab === "map" && view.map !== undefined;

	return (
		<Sheet label="code map" size="full" onClose={onClose}>
			<div className="sh-sheet-head sh-cm-head">
				<button
					type="button"
					className="sh-btn sh-btn-icon"
					onClick={back}
					disabled={trail.length === 0}
					aria-label="back"
					title="back"
				>
					<ArrowLeft size={16} />
				</button>
				<div className="sh-sheet-title sh-cm-title">Code map</div>
				<label className="sh-cm-search">
					<Search size={14} aria-hidden />
					<input
						className="sh-input"
						type="search"
						value={query}
						onChange={e => setQuery(e.target.value)}
						onKeyDown={onSearchKey}
						placeholder="Find a file or symbol"
						enterKeyHint="search"
						aria-label="search the code map"
					/>
				</label>
				<span className="sh-stats-head-actions sh-cm-actions">
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
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{view && !searching && (
				<nav className="sh-cm-crumbs" ref={crumbs} aria-label="location">
					{view.crumbs.map(crumb => (
						<span key={crumb.path} className="sh-cm-crumb">
							<button type="button" className="sh-cm-crumb-btn" onClick={() => goNode(crumb)}>
								{crumb.label}
							</button>
							<ChevronRight size={12} aria-hidden />
						</span>
					))}
					<span className="sh-cm-crumb-here" aria-current="location">
						{view.focus.kind === "dir" && view.focus.path === "" ? view.repo : view.focus.label}
					</span>
				</nav>
			)}
			{view?.focus.kind === "dir" && wide && !searching && (
				<Tabs<FolderTab> label="folder view" value={folderTab} options={FOLDER_TABS} onChange={setFolderTab} />
			)}
			{view?.focus.kind === "symbol" && !searching && (
				<Tabs<SymbolTab> label="symbol view" value={symbolTab} options={SYMBOL_TABS} onChange={setSymbolTab} />
			)}
			{state.status === "error" && (
				<div className="sh-tree-error">
					<div className="sh-connect-error">{state.message}</div>
					<button type="button" className="sh-btn" onClick={reload}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
			{searching ? (
				<div className="sh-cm-body">
					<SearchResults client={client} instanceId={instanceId} q={searched} onPick={goNode} />
				</div>
			) : view === null ? (
				state.status === "loading" && (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Indexing the repository… the first map can take a
						minute on large repos.
					</div>
				)
			) : (
				<div className={`${showMap ? "sh-cm-body sh-cm-body-fill" : "sh-cm-body"}${loading ? " sh-cm-stale" : ""}`}>
					{showMap && view.map ? (
						<ForceMap key={view.focus.path} map={view.map} onFocus={goNode} />
					) : symbolTab === "flow" && view.focus.kind === "symbol" ? (
						view.flow ? (
							<FlowGraph
								steps={view.flow}
								direction={flowDirection}
								onDirection={setFlowDirection}
								onFocus={goNode}
							/>
						) : (
							<div className="sh-companion-empty sh-file-status">
								<LoaderCircle size={14} className="sh-spin" /> Walking the flow…
							</div>
						)
					) : (
						<FocusGraph view={view} onFocus={goNode} onOpenFile={onOpenFile} />
					)}
					{view.focus.kind === "file" && (
						<FileSessions
							key={view.focus.path}
							client={client}
							instanceId={instanceId}
							path={view.focus.path}
							canStart={canStart}
							currentSessionId={currentSessionId}
							onOpenHost={onOpenHost}
							onOpenLink={onOpenLink}
						/>
					)}
				</div>
			)}
			{view && (
				<div className="sh-cm-foot">
					{view.index.files} files · {view.index.symbols} symbols
				</div>
			)}
		</Sheet>
	);
}

interface TabsProps<T extends string> {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange(value: T): void;
}

function Tabs<T extends string>({ label, value, options, onChange }: TabsProps<T>): ReactNode {
	return (
		<div className="sh-segmented sh-cm-tabs" role="radiogroup" aria-label={label}>
			{options.map(o => (
				<button
					key={o.value}
					type="button"
					role="radio"
					aria-checked={value === o.value}
					className={value === o.value ? "sh-segment sh-segment-on" : "sh-segment"}
					onClick={() => onChange(o.value)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

interface SearchResultsProps {
	client: CompanionClient;
	instanceId: string;
	/** Debounced query. */
	q: string;
	onPick(node: CodemapNode): void;
}

function SearchResults({ client, instanceId, q, onPick }: SearchResultsProps): ReactNode {
	const load = useCallback(
		() => (q === "" ? Promise.resolve([]) : client.searchCodemap(instanceId, q)),
		[client, instanceId, q],
	);
	const { state } = useRequest(load);
	const shown = useRef<CodemapNode[] | null>(null);
	if (state.status === "ready") shown.current = state.value;
	const hits = shown.current;
	if (state.status === "error") return <div className="sh-connect-error">{state.message}</div>;
	if (hits === null) {
		return (
			<div className="sh-companion-empty sh-file-status">
				<LoaderCircle size={14} className="sh-spin" /> Searching…
			</div>
		);
	}
	return (
		<div className={state.status === "loading" ? "sh-cm-stale" : undefined}>
			{hits.length === 0 && q !== "" ? (
				<div className="sh-companion-empty">No file or symbol matches “{q}”.</div>
			) : (
				<ul className="sh-cm-list">
					{hits.map(hit => (
						<li key={`${hit.kind}:${hit.path}:${hit.label}:${hit.line ?? 0}`}>
							<NodeRow node={hit} onPick={onPick} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
