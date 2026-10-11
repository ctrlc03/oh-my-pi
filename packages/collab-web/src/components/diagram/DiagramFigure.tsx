import { Code, LoaderCircle, Maximize2, RefreshCw, TriangleAlert } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { openDiagram } from "../../lib/diagram-store";
import type { DiagramKind } from "../../lib/diagrams";
import { READABLE_SCALE } from "../../lib/diagrams";
import { standaloneSvg, svgSize } from "../../lib/svg";
import "./diagram.css";
import { type DiagramState, useDiagram } from "./use-diagram";

export const KIND_LABEL: Record<DiagramKind, string> = { mermaid: "Mermaid", excalidraw: "Excalidraw" };

export interface DiagramFigureViewProps {
	kind: DiagramKind;
	source: string;
	state: DiagramState;
	showSource: boolean;
	onToggleSource(): void;
	onOpen(): void;
	onRetry(): void;
}

/** The source as the plain code block every other fence gets, with its copy button. */
export function SourceBlock({ kind, source }: { kind: DiagramKind; source: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	const copy = (): void => {
		void navigator.clipboard?.writeText(source).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<div className="tr-code">
			<pre>
				<code className={`language-${kind}`}>{source.replace(/\n$/, "")}</code>
			</pre>
			<button
				type="button"
				className="tr-copy"
				aria-label="Copy code"
				onClick={copy}
				data-copied={copied ? "" : undefined}
			/>
		</div>
	);
}

/**
 * The rendering sized for the page: its natural size in pixels, with the numbers the stylesheet sizes it by
 * (shrink to the column but not below the readable zoom; a tall one not past a screen height). A rendering
 * without a `viewBox` keeps the engine's own sizing.
 */
function sizedSvg(kind: DiagramKind, svg: string): { html: string; style: CSSProperties | undefined } {
	const size = svgSize(svg);
	if (size === null) return { html: svg, style: undefined };
	const style = {
		"--dg-w": size.width,
		"--dg-ratio": size.width / size.height,
		"--dg-floor": READABLE_SCALE[kind],
	} as CSSProperties;
	return { html: standaloneSvg(svg, size), style };
}

/**
 * Marks `data-more` on the frame of a scrolling drawing with the sides that have more to see (`start`, `end`,
 * `start end`), so the stylesheet can fade those edges: a cut-off drawing then reads as scrollable.
 */
function useScrollCue(art: unknown): {
	frame: RefObject<HTMLDivElement | null>;
	scroller: RefObject<HTMLDivElement | null>;
} {
	const frame = useRef<HTMLDivElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const node = scroller.current;
		const outer = frame.current;
		if (node === null || outer === null) return;
		const update = (): void => {
			const sides: string[] = [];
			if (node.scrollLeft > 1) sides.push("start");
			if (node.scrollLeft + node.clientWidth < node.scrollWidth - 1) sides.push("end");
			outer.dataset.more = sides.join(" ");
		};
		update();
		node.addEventListener("scroll", update, { passive: true });
		const observer = new ResizeObserver(update);
		observer.observe(node);
		for (const child of node.children) observer.observe(child);
		return () => {
			node.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [art]);
	return { frame, scroller };
}

/** One diagram in a reply: the rendering, or the source with a note when it cannot be shown. */
export function DiagramFigureView({
	kind,
	source,
	state,
	showSource,
	onToggleSource,
	onOpen,
	onRetry,
}: DiagramFigureViewProps): ReactNode {
	const ready = state.status === "ready";
	const art = useMemo(() => (state.status === "ready" ? sizedSvg(kind, state.svg) : null), [kind, state]);
	const cue = useScrollCue(art);
	const failed = state.status === "error" || state.status === "unavailable";
	const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onOpen();
		}
	};
	return (
		<figure className="tr-diagram-fig" data-kind={kind}>
			<div className="tr-diagram-bar">
				<span className="tr-diagram-kind">{KIND_LABEL[kind]}</span>
				<span className="tr-diagram-actions">
					{ready && (
						<>
							<button
								type="button"
								className="tr-diagram-btn"
								onClick={onToggleSource}
								aria-pressed={showSource}
								title={showSource ? "Show the diagram" : "Show the source"}
							>
								<Code size={14} /> <span>Source</span>
							</button>
							<button type="button" className="tr-diagram-btn" onClick={onOpen} title="Open full screen">
								<Maximize2 size={14} /> <span>Open</span>
							</button>
						</>
					)}
					{state.status === "unavailable" && (
						<button type="button" className="tr-diagram-btn" onClick={onRetry}>
							<RefreshCw size={14} /> <span>Retry</span>
						</button>
					)}
				</span>
			</div>
			{state.status === "loading" && (
				<div className="tr-diagram-wait" role="status">
					<LoaderCircle size={14} className="sh-spin" /> Rendering the diagram…
				</div>
			)}
			{art !== null && !showSource && (
				<div className="tr-diagram-frame" ref={cue.frame}>
					<div
						className="tr-diagram-svg"
						ref={cue.scroller}
						role="button"
						tabIndex={0}
						aria-label={`Open the ${KIND_LABEL[kind]} diagram full screen`}
						style={art.style}
						onClick={onOpen}
						onKeyDown={onKey}
						dangerouslySetInnerHTML={{ __html: art.html }}
					/>
				</div>
			)}
			{(showSource || failed) && <SourceBlock kind={kind} source={source} />}
			{failed && (
				<div className="tr-diagram-note" role="note">
					<TriangleAlert size={13} />
					{state.status === "unavailable"
						? `The ${KIND_LABEL[kind]} renderer could not be loaded: ${state.message}`
						: `Could not render this ${KIND_LABEL[kind]} diagram: ${state.message}`}
				</div>
			)}
		</figure>
	);
}

/**
 * A diagram block of a reply. The engines load on first use (Mermaid, Excalidraw); until then, offline, or
 * when the source is not a valid diagram, the plain code block stands in.
 */
export function DiagramFigure({ kind, source }: { kind: DiagramKind; source: string }): ReactNode {
	const { state, retry } = useDiagram(kind, source);
	const [showSource, setShowSource] = useState(false);
	return (
		<DiagramFigureView
			kind={kind}
			source={source}
			state={state}
			showSource={showSource}
			onToggleSource={() => setShowSource(shown => !shown)}
			onOpen={() => openDiagram(kind, source)}
			onRetry={retry}
		/>
	);
}
