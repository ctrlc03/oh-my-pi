import type {
	Blueprint,
	BlueprintDiagram,
	BlueprintEdge,
	BlueprintExcerptRef,
	BlueprintNode,
	BlueprintRef,
} from "@oh-my-pi/pi-wire/blueprint";
import { ArrowRight, ExternalLink, Layers, LoaderCircle, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRequest } from "../../lib/use-request";
import type { WidenExcerpt } from "./ExpandableCode";
import { ExpandableCode } from "./ExpandableCode";
import type { ExportedExcerpt } from "./blueprint-model";
import { childOf, edgeEnds, edgeKind, nodeKind, refKey, refLabel, shortCommit } from "./blueprint-model";

/** Where the viewer gets code from: the companion while live, the embedded table in an exported page. */
export interface MapSource {
	/**
	 * Code around each ref, in order; null for a ref the commit does not have. A ref with `from`/`to` asks for that range
	 * of its file; a source that cannot (an exported page) answers the default window, without `total`, and the panel
	 * then offers no "show more".
	 */
	excerpts(refs: BlueprintExcerptRef[]): Promise<(ExportedExcerpt | null)[]>;
	/** Syntax-highlighted markup of an excerpt's lines, when this source can make it; exported excerpts carry theirs. */
	highlight?(excerpt: ExportedExcerpt): Promise<string | undefined>;
	/** What to say of a ref that has no code here; the default says the commit does not have it. */
	absent?: string;
}

/** Opens a cited line in the app's editor: offered only when the map was made from the checkout that is open. */
export interface EditorAccess {
	/** A caution shown with the code: the checkout may differ a little from the map's commit. */
	note?: string;
	open(ref: BlueprintRef): void;
}

export type ExcerptCache = Map<string, ExportedExcerpt | null>;

export interface DetailPanelProps {
	map: Blueprint;
	diagram: BlueprintDiagram;
	node?: BlueprintNode;
	edge?: BlueprintEdge;
	source: MapSource;
	cache: ExcerptCache;
	editor: EditorAccess | null;
	onClose(): void;
	onOpenChild(node: BlueprintNode): void;
}

/** Refs shown before "Show more": an edge that cites a dozen places should not push everything off screen. */
const FIRST_REFS = 4;

/** Side panel (bottom sheet on phones) with what a node or an edge is, and the code behind it. */
export function DetailPanel({
	map,
	diagram,
	node,
	edge,
	source,
	cache,
	editor,
	onClose,
	onOpenChild,
}: DetailPanelProps): ReactNode {
	const refs = node?.refs ?? edge?.refs;
	const list = useMemo(() => refs ?? [], [refs]);
	const [all, setAll] = useState(false);
	useEffect(() => setAll(false), [node?.id, edge?.id]);
	// Only what is on screen is read: an arrow between two folders can cite hundreds of places.
	const shownRefs = useMemo(() => (all ? list : list.slice(0, FIRST_REFS)), [all, list]);
	const load = useCallback(async (): Promise<(ExportedExcerpt | null)[]> => {
		const missing = shownRefs.filter(ref => !cache.has(refKey(ref)));
		if (missing.length > 0) {
			const got = await source.excerpts(missing);
			missing.forEach((ref, i) => cache.set(refKey(ref), got[i] ?? null));
		}
		return shownRefs.map(ref => cache.get(refKey(ref)) ?? null);
	}, [shownRefs, cache, source]);
	const { state, reload } = useRequest(load);

	const title = node?.label ?? edge?.label ?? "";
	const kind = node !== undefined ? nodeKind(node.kind) : edgeKind(edge?.kind);
	const change = node?.change ?? edge?.change;
	const ends = edge !== undefined ? edgeEnds(diagram, edge) : null;
	const child = node !== undefined ? childOf(map, node) : undefined;

	return (
		<aside className="ar-panel" aria-label={`Details of ${title}`}>
			<div className="ar-panel-grip" aria-hidden />
			<div className="ar-panel-head">
				<div className="ar-panel-titles">
					<div className="ar-panel-chips">
						<span
							className={node ? `ar-chip ar-chip-kind ar-kind-${kind}` : `ar-chip ar-chip-edge ar-edge-${kind}`}
						>
							{node ? node.kind : (edge?.kind ?? "call")}
						</span>
						{change !== undefined && (
							<span className={`ar-chip ar-chip-change ar-change-${change}`}>{change}</span>
						)}
					</div>
					<h2 className="ar-panel-title">{title}</h2>
					{ends !== null && (
						<div className="ar-panel-ends">
							<span>{ends.from}</span>
							<ArrowRight size={13} aria-hidden />
							<span>{ends.to}</span>
						</div>
					)}
				</div>
				<button type="button" className="ar-btn ar-btn-icon" onClick={onClose} aria-label="Close details">
					<X size={16} />
				</button>
			</div>
			<div className="ar-panel-body">
				{node?.summary !== undefined && <p className="ar-panel-summary">{node.summary}</p>}
				{node?.path !== undefined && <code className="ar-panel-path">{node.path}</code>}
				{child !== undefined && node !== undefined && (
					<button type="button" className="ar-btn ar-btn-wide" onClick={() => onOpenChild(node)}>
						<Layers size={14} /> Open diagram: {child.title}
					</button>
				)}
				{list.length === 0 ? (
					<p className="ar-panel-note">
						{edge !== undefined ? "This arrow cites no code." : "This node cites no code."}
					</p>
				) : (
					<>
						<h3 className="ar-panel-heading">{list.length === 1 ? "Code" : `Code (${list.length} places)`}</h3>
						{editor === null && (
							<p className="ar-panel-note">
								From commit <code>{shortCommit(map.head.commit)}</code>
								{map.head.ref !== undefined && <> ({refLabel(map.head.ref)})</>}, not necessarily what is
								checked out now.
							</p>
						)}
						{editor?.note !== undefined && <p className="ar-panel-note">{editor.note}</p>}
						{state.status === "loading" && (
							<div className="ar-status">
								<LoaderCircle size={14} className="ar-spin" /> Reading the code…
							</div>
						)}
						{state.status === "error" && (
							<div className="ar-error" role="alert">
								{state.message}
								<button type="button" className="ar-btn" onClick={reload}>
									Retry
								</button>
							</div>
						)}
						{state.status === "ready" &&
							shownRefs.map((ref, i) => (
								<RefBlock
									key={refKey(ref)}
									map={map}
									reference={ref}
									excerpt={state.value[i] ?? null}
									source={source}
									cache={cache}
									editor={editor}
								/>
							))}
						{state.status !== "ready" &&
							shownRefs.map(ref => <RefHeading key={refKey(ref)} reference={ref} map={map} editor={null} />)}
						{list.length > FIRST_REFS && !all && (
							<button type="button" className="ar-btn ar-btn-wide" onClick={() => setAll(true)}>
								Show {list.length - FIRST_REFS} more
							</button>
						)}
					</>
				)}
			</div>
		</aside>
	);
}

function RefHeading({
	reference,
	map,
	editor,
}: {
	reference: BlueprintRef;
	map: Blueprint;
	editor: EditorAccess | null;
}): ReactNode {
	const base = reference.side === "base";
	return (
		<div className="ar-ref-head">
			<span className="ar-ref-where">
				<code className="ar-ref-path">
					{reference.path}:{reference.line}
				</code>
				<code className="ar-ref-token">{reference.token}</code>
				{base && (
					<span className="ar-chip ar-chip-change ar-change-removed">
						base {map.base ? shortCommit(map.base.commit) : ""}
					</span>
				)}
			</span>
			{editor !== null && !base && (
				<button type="button" className="ar-btn ar-btn-small" onClick={() => editor.open(reference)}>
					<ExternalLink size={13} /> Open in editor
				</button>
			)}
		</div>
	);
}

function RefBlock({
	map,
	reference,
	excerpt,
	source,
	cache,
	editor,
}: {
	map: Blueprint;
	reference: BlueprintRef;
	excerpt: ExportedExcerpt | null;
	source: MapSource;
	cache: ExcerptCache;
	editor: EditorAccess | null;
}): ReactNode {
	// A widened excerpt replaces the one read first, so it is still wide when the node is selected again.
	const widen = useCallback<WidenExcerpt>(
		async request => {
			const [found] = await source.excerpts([request]);
			if (found === undefined || found === null) return null;
			cache.set(refKey(request), found);
			return found;
		},
		[source, cache],
	);
	return (
		<section className="ar-ref" aria-label={`${reference.path} line ${reference.line}`}>
			<RefHeading reference={reference} map={map} editor={editor} />
			{excerpt === null ? (
				<p className="ar-panel-note">{source.absent ?? "The code is not available at that commit."}</p>
			) : (
				<ExpandableCode reference={reference} excerpt={excerpt} highlight={source.highlight} widen={widen} />
			)}
		</section>
	);
}
