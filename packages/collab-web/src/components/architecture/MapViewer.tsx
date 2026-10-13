import type { Blueprint, BlueprintDiagram, BlueprintEdge, BlueprintNode } from "@oh-my-pi/pi-wire/blueprint";
import { ArrowLeft, ArrowRight, ChevronRight, Component, Info, Layers, Search, TriangleAlert, X } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutRect } from "../../lib/zoom";
import type { Scene, Spot } from "./DiagramCanvas";
import { DiagramCanvas } from "./DiagramCanvas";
import type { EditorAccess, ExcerptCache, MapSource } from "./DetailPanel";
import { DetailPanel } from "./DetailPanel";
import { layoutDiagram } from "./blueprint-layout";
import type { MapLocation, SearchHit } from "./blueprint-model";
import {
	ancestry,
	childOf,
	diagramOf,
	diagramsWithChanges,
	EDGE_KIND_LIST,
	isDiffMap,
	NODE_KIND_LIST,
	onlyChanges,
	rootDiagram,
	createSearch,
	refLabel,
	shortCommit,
	summarizeChanges,
} from "./blueprint-model";

/** How long a pause in typing the search waits before searching. */
const SEARCH_DEBOUNCE_MS = 120;

export interface MapViewerProps {
	map: Blueprint;
	source: MapSource;
	/** Where the viewer is. A location naming a diagram the map lacks shows the root. */
	location: MapLocation;
	/** `push`: a move to another diagram (a history entry in the exported page); selecting within a diagram replaces. */
	onLocation(next: MapLocation, push: boolean): void;
	/** Before the breadcrumb: the way back to the list. */
	leading?: ReactNode;
	/** After the search box: download, close. */
	actions?: ReactNode;
	/** Set when the map was made from the checkout that is open, so a cited line can be opened in the editor. */
	editor: EditorAccess | null;
}

export function MapViewer({ map, source, location, onLocation, leading, actions, editor }: MapViewerProps): ReactNode {
	const root = rootDiagram(map);
	const currentId = diagramOf(map, location.diagram)?.id ?? root?.id ?? "";
	const diagram = diagramOf(map, currentId);
	const diff = isDiffMap(map);
	const summary = useMemo(() => summarizeChanges(map), [map]);
	const withChanges = useMemo(() => diagramsWithChanges(map), [map]);
	const [onlyChanged, setOnlyChanged] = useState(false);
	const filtering = diff && onlyChanged;
	const cache = useRef<ExcerptCache>(new Map());
	const [infoOpen, setInfoOpen] = useState(false);
	const [spot, setSpot] = useState<Spot | null>(null);
	const spotTick = useRef(0);
	const search = useRef<HTMLInputElement>(null);
	const body = useRef<HTMLDivElement>(null);
	/** How far the details sheet reaches up from the bottom of the canvas (a phone; 0 beside it on a wide screen). */
	const [coveredBottom, setCoveredBottom] = useState(0);

	// Layout is the one costly step: each diagram's is kept until the map or the filter changes.
	const getScene = useMemo(() => {
		const made = new Map<string, Scene | null>();
		const build = (id: string): Scene | null => {
			const base = diagramOf(map, id);
			if (base === undefined) return null;
			if (!filtering) return { diagram: base, layout: layoutDiagram(base), context: new Set(), empty: false };
			const only = onlyChanges(base, withChanges);
			if (only === null) {
				const nothing: BlueprintDiagram = { ...base, nodes: [], edges: [] };
				return { diagram: nothing, layout: layoutDiagram(nothing), context: new Set(), empty: true };
			}
			return { diagram: only.diagram, layout: layoutDiagram(only.diagram), context: only.context, empty: false };
		};
		return (id: string): Scene | null => {
			if (!made.has(id)) made.set(id, build(id));
			return made.get(id) ?? null;
		};
	}, [map, filtering, withChanges]);

	const chain = useMemo(() => ancestry(map, currentId), [map, currentId]);
	const parent = chain.length > 1 ? chain[chain.length - 2] : undefined;
	const selectedNode = diagram?.nodes.find(node => node.id === location.node);
	const selectedEdge = diagram?.edges.find(edge => edge.id === location.edge);
	const hasSelection = selectedNode !== undefined || selectedEdge !== undefined;
	const selectionKey = selectedNode?.id ?? selectedEdge?.id;

	// On a narrow screen the details sheet lies over the lower part of the canvas: tell the canvas how much, so it
	// keeps the selection and the fitted diagram in the part still showing.
	useEffect(() => {
		const host = body.current;
		const sheet = host?.querySelector<HTMLElement>(".ar-panel");
		const canvas = host?.querySelector<HTMLElement>(".ar-canvas");
		if (!sheet || !canvas) {
			setCoveredBottom(0);
			return;
		}
		const measure = (): void => {
			const over = layoutRect(sheet.getBoundingClientRect());
			const under = layoutRect(canvas.getBoundingClientRect());
			// Beside the canvas (it shrank to make room) the sheet covers nothing; across its width it covers its height.
			setCoveredBottom(over.width >= under.width - 1 ? Math.max(0, under.bottom - over.top) : 0);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(sheet);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [selectionKey]);

	const go = useCallback((id: string): void => onLocation({ diagram: id }, true), [onLocation]);
	const activateNode = useCallback(
		(node: BlueprintNode): void => {
			if (diagram === undefined) return;
			if (childOf(map, node) !== undefined && node.child !== undefined) go(node.child);
			else onLocation({ diagram: diagram.id, node: node.id }, false);
		},
		[diagram, map, go, onLocation],
	);
	const showNode = useCallback(
		(node: BlueprintNode): void => {
			if (diagram !== undefined) onLocation({ diagram: diagram.id, node: node.id }, false);
		},
		[diagram, onLocation],
	);
	const showEdge = useCallback(
		(edge: BlueprintEdge): void => {
			if (diagram !== undefined) onLocation({ diagram: diagram.id, edge: edge.id }, false);
		},
		[diagram, onLocation],
	);
	const clearSelection = useCallback((): void => {
		if (diagram !== undefined && hasSelection) onLocation({ diagram: diagram.id }, false);
	}, [diagram, hasSelection, onLocation]);

	const pick = useCallback(
		(hit: SearchHit): void => {
			spotTick.current += 1;
			if (hit.kind === "edge") onLocation({ diagram: hit.diagram, edge: hit.id }, hit.diagram !== currentId);
			else onLocation({ diagram: hit.diagram }, hit.diagram !== currentId);
			setSpot({
				diagram: hit.diagram,
				node: hit.kind === "node" ? hit.id : undefined,
				edge: hit.kind === "edge" ? hit.id : undefined,
				tick: spotTick.current,
			});
		},
		[currentId, onLocation],
	);

	// Escape peels one layer: the search list, the info panel, the open details, then up a diagram. At the root with
	// nothing open it is left alone, so the sheet around the viewer can take it.
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "/" && !(e.target instanceof HTMLInputElement)) {
			e.preventDefault();
			search.current?.focus();
			return;
		}
		if (e.key !== "Escape") return;
		if (infoOpen) setInfoOpen(false);
		else if (hasSelection) clearSelection();
		else if (parent !== undefined) go(parent.id);
		else return;
		e.preventDefault();
	};

	if (root === undefined || diagram === undefined) {
		return (
			<div className="ar-viewer">
				<div className="ar-empty-map">This map has no diagrams.</div>
			</div>
		);
	}

	return (
		<div className="ar-viewer" onKeyDown={onKeyDown}>
			<div className="ar-bar">
				<div className="ar-bar-main">
					{leading}
					<button
						type="button"
						className="ar-btn ar-btn-icon"
						onClick={() => parent && go(parent.id)}
						disabled={parent === undefined}
						aria-label="Back to the parent diagram"
					>
						<ArrowLeft size={16} />
					</button>
					<Breadcrumb chain={chain} onGo={go} />
				</div>
				<div className="ar-bar-tools">
					<SearchBox map={map} inputRef={search} onPick={pick} />
					<button
						type="button"
						className={infoOpen ? "ar-btn ar-btn-icon ar-btn-on" : "ar-btn ar-btn-icon"}
						onClick={() => setInfoOpen(open => !open)}
						aria-label="About this map"
						aria-expanded={infoOpen}
					>
						{map.warnings.length > 0 ? <TriangleAlert size={16} /> : <Info size={16} />}
						{map.warnings.length > 0 && <span className="ar-count">{map.warnings.length}</span>}
					</button>
					{actions}
				</div>
			</div>
			{diff && (
				<div className="ar-diffbar">
					<ul className="ar-legend" aria-label="What changed">
						{(["added", "modified", "removed"] as const).map(kind => (
							<li key={kind} className={`ar-legend-item ar-change-${kind}`}>
								<span className="ar-swatch" aria-hidden />
								{kind === "modified" ? "Changed" : kind === "added" ? "Added" : "Removed"}
								<span className="ar-legend-count">{summary.nodes[kind] + summary.edges[kind]}</span>
							</li>
						))}
					</ul>
					<label className="ar-check">
						<input type="checkbox" checked={onlyChanged} onChange={e => setOnlyChanged(e.target.checked)} />
						Show only changes
					</label>
				</div>
			)}
			<div className="ar-body" ref={body}>
				<DiagramCanvas
					key={filtering ? "changes" : "all"}
					map={map}
					current={currentId}
					getScene={getScene}
					insideChanges={withChanges}
					selectedNode={selectedNode?.id}
					selectedEdge={selectedEdge?.id}
					coveredBottom={coveredBottom}
					spot={spot}
					onActivateNode={activateNode}
					onDetailsNode={showNode}
					onSelectEdge={showEdge}
					onClearSelection={clearSelection}
					autoFocus
				/>
				{(selectedNode !== undefined || selectedEdge !== undefined) && (
					<DetailPanel
						key={selectedNode?.id ?? selectedEdge?.id}
						map={map}
						diagram={diagram}
						node={selectedNode}
						edge={selectedEdge}
						source={source}
						cache={cache.current}
						editor={editor}
						onClose={clearSelection}
						onOpenChild={node => node.child !== undefined && go(node.child)}
					/>
				)}
				{infoOpen && <InfoPanel map={map} onClose={() => setInfoOpen(false)} />}
			</div>
		</div>
	);
}

function Breadcrumb({ chain, onGo }: { chain: BlueprintDiagram[]; onGo(id: string): void }): ReactNode {
	const nav = useRef<HTMLElement>(null);
	// Keep the deepest crumb in sight on narrow screens.
	const last = chain[chain.length - 1]?.id;
	useEffect(() => {
		if (nav.current) nav.current.scrollLeft = nav.current.scrollWidth;
	}, [last]);
	return (
		<nav ref={nav} className="ar-crumbs" aria-label="Diagram path">
			{chain.map((item, i) => (
				<span key={item.id} className="ar-crumb">
					{i > 0 && <ChevronRight size={13} aria-hidden />}
					{i === chain.length - 1 ? (
						<span className="ar-crumb-here" aria-current="page">
							{item.title}
						</span>
					) : (
						<button type="button" className="ar-crumb-btn" onClick={() => onGo(item.id)}>
							{item.title}
						</button>
					)}
				</span>
			))}
		</nav>
	);
}

function SearchBox({
	map,
	inputRef,
	onPick,
}: {
	map: Blueprint;
	inputRef: RefObject<HTMLInputElement | null>;
	onPick(hit: SearchHit): void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	// The index is built on the first query and each keystroke waits a moment: a large map has some 20 000 entries.
	const search = useMemo(() => {
		let built: ((query: string) => SearchHit[]) | undefined;
		return (text: string): SearchHit[] => (built ??= createSearch(map))(text);
	}, [map]);
	const [applied, setApplied] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setApplied(query), query === "" ? 0 : SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);
	const hits = useMemo(() => search(applied), [search, applied]);
	useEffect(() => setActive(0), [applied]);
	const choose = (hit: SearchHit): void => {
		onPick(hit);
		setQuery("");
	};
	const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (hits.length === 0) return;
			e.preventDefault();
			setActive(i => (i + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
		} else if (e.key === "Enter") {
			const hit = hits[active];
			if (hit) {
				e.preventDefault();
				choose(hit);
			}
		} else if (e.key === "Escape") {
			// Clear the query first; an empty field lets Escape go on to peel the viewer.
			if (query !== "") {
				e.preventDefault();
				e.stopPropagation();
				setQuery("");
			} else {
				e.currentTarget.blur();
			}
		}
	};
	const listId = "ar-search-list";
	return (
		<div className="ar-search">
			<Search size={14} aria-hidden />
			<input
				ref={inputRef}
				className="ar-input"
				type="search"
				placeholder="Search diagrams and nodes"
				aria-label="Search the map"
				role="combobox"
				aria-expanded={query !== ""}
				aria-controls={listId}
				aria-activedescendant={hits.length > 0 ? `ar-hit-${active}` : undefined}
				autoComplete="off"
				value={query}
				onChange={e => setQuery(e.target.value)}
				onKeyDown={onKey}
			/>
			{query.trim() !== "" && (
				<ul id={listId} className="ar-hits" role="listbox" aria-label="Search results">
					{hits.length === 0 && <li className="ar-hit-none">Nothing matches.</li>}
					{hits.map((hit, i) => (
						<li
							key={`${hit.kind}:${hit.diagram}:${hit.id ?? ""}`}
							id={`ar-hit-${i}`}
							role="option"
							aria-selected={i === active}
							className={i === active ? "ar-hit ar-hit-on" : "ar-hit"}
							onMouseDown={e => e.preventDefault()}
							onClick={() => choose(hit)}
						>
							{hit.kind === "diagram" ? (
								<Layers size={14} aria-hidden />
							) : hit.kind === "edge" ? (
								<ArrowRight size={14} aria-hidden />
							) : (
								<Component size={14} aria-hidden />
							)}
							<span className="ar-hit-text">
								<span className="ar-hit-title">{hit.title}</span>
								<span className="ar-hit-sub">{hit.sub}</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function InfoPanel({ map, onClose }: { map: Blueprint; onClose(): void }): ReactNode {
	const diagrams = Object.keys(map.diagrams).length;
	const kinds = useMemo(() => {
		const nodes = new Set<string>();
		const edges = new Set<string>();
		for (const diagram of Object.values(map.diagrams)) {
			for (const node of diagram.nodes) nodes.add(node.kind);
			for (const edge of diagram.edges) edges.add(edge.kind ?? "call");
		}
		return {
			nodes: NODE_KIND_LIST.filter(kind => nodes.has(kind)),
			edges: EDGE_KIND_LIST.filter(kind => edges.has(kind)),
		};
	}, [map]);
	return (
		<aside className="ar-info" aria-label="About this map">
			<div className="ar-panel-head">
				<div className="ar-panel-titles">
					<h2 className="ar-panel-title">{map.title}</h2>
					<div className="ar-panel-ends">{map.repo.github ?? map.repo.name}</div>
				</div>
				<button type="button" className="ar-btn ar-btn-icon" onClick={onClose} aria-label="Close map information">
					<X size={16} />
				</button>
			</div>
			<div className="ar-panel-body">
				<dl className="ar-facts">
					<dt>Commit</dt>
					<dd>
						<code>{shortCommit(map.head.commit)}</code>
						{map.head.ref !== undefined && ` · ${refLabel(map.head.ref)}`}
						{map.head.subject !== undefined && <span className="ar-fact-sub">{map.head.subject}</span>}
					</dd>
					{map.base !== undefined && (
						<>
							<dt>Compared with</dt>
							<dd>
								<code>{shortCommit(map.base.commit)}</code>
								{map.base.ref !== undefined && ` · ${refLabel(map.base.ref)}`}
							</dd>
						</>
					)}
					<dt>Made</dt>
					<dd>{new Date(map.createdAt).toLocaleString()}</dd>
					<dt>Diagrams</dt>
					<dd>{diagrams}</dd>
					{map.model !== undefined && (
						<>
							<dt>Written by</dt>
							<dd>{map.model}</dd>
						</>
					)}
					{map.costUsd !== undefined && (
						<>
							<dt>Cost</dt>
							<dd>${map.costUsd.toFixed(2)}</dd>
						</>
					)}
				</dl>
				<h3 className="ar-panel-heading">Key</h3>
				<ul className="ar-key">
					{kinds.nodes.map(kind => (
						<li key={`n-${kind}`} className="ar-key-item">
							<span className={`ar-key-node ar-kind-${kind}`} aria-hidden />
							{kind}
						</li>
					))}
					{kinds.edges.map(kind => (
						<li key={`e-${kind}`} className="ar-key-item">
							<svg className={`ar-key-edge ar-edge-${kind}`} width="28" height="8" aria-hidden>
								<path className="ar-edge-line" d="M 1 4 L 27 4" />
							</svg>
							{kind}
						</li>
					))}
				</ul>
				<h3 className="ar-panel-heading">Warnings</h3>
				{map.warnings.length === 0 ? (
					<p className="ar-panel-note">The build had nothing to report.</p>
				) : (
					<ul className="ar-warnings">
						{[...new Set(map.warnings)].map(warning => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				)}
			</div>
		</aside>
	);
}
