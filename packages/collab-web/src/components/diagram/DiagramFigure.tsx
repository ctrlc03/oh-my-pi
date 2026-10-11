import { Code, LoaderCircle, Maximize2, RefreshCw, TriangleAlert } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useState } from "react";
import { openDiagram } from "../../lib/diagram-store";
import type { DiagramKind } from "../../lib/diagrams";
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
				aria-label="copy code"
				onClick={copy}
				data-copied={copied ? "" : undefined}
			/>
		</div>
	);
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
								title={showSource ? "show the diagram" : "show the source"}
							>
								<Code size={13} /> <span className="tr-diagram-btn-label">Source</span>
							</button>
							<button type="button" className="tr-diagram-btn" onClick={onOpen} title="open full screen">
								<Maximize2 size={13} /> <span className="tr-diagram-btn-label">Open</span>
							</button>
						</>
					)}
					{state.status === "unavailable" && (
						<button type="button" className="tr-diagram-btn" onClick={onRetry}>
							<RefreshCw size={13} /> <span className="tr-diagram-btn-label">Retry</span>
						</button>
					)}
				</span>
			</div>
			{state.status === "loading" && (
				<div className="tr-diagram-wait" role="status">
					<LoaderCircle size={14} className="sh-spin" /> Rendering the diagram…
				</div>
			)}
			{state.status === "ready" && !showSource && (
				<div
					className="tr-diagram-svg"
					role="button"
					tabIndex={0}
					aria-label={`open the ${KIND_LABEL[kind]} diagram full screen`}
					onClick={onOpen}
					onKeyDown={onKey}
					dangerouslySetInnerHTML={{ __html: state.svg }}
				/>
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
