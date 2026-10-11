import { Check, Code, Copy, Download, FileImage, LoaderCircle, Pencil, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { svgBlob, svgToPngBlob } from "../../lib/diagram-export";
import { openCanvas } from "../../lib/diagram-store";
import type { DiagramKind } from "../../lib/diagrams";
import { saveBlob } from "../../lib/download";
import { parseScene } from "../../lib/excalidraw-scene";
import { standaloneSvg, svgSize } from "../../lib/svg";
import { pageBackground } from "../../lib/theme-tokens";
import { Sheet } from "../shell/Sheet";
import { KIND_LABEL, SourceBlock } from "./DiagramFigure";
import { PanZoom } from "./PanZoom";
import { useDiagram } from "./use-diagram";

/** Size used when a rendering carries no `viewBox`. */
const FALLBACK_SIZE = { width: 800, height: 600 };

export interface DiagramViewerProps {
	kind: DiagramKind;
	source: string;
	onClose(): void;
}

/** A diagram full screen: pan and zoom (pinch on touch), copy the source, save as SVG or PNG, edit on the canvas. */
export function DiagramViewer({ kind, source, onClose }: DiagramViewerProps): ReactNode {
	const { state, retry } = useDiagram(kind, source);
	const [showSource, setShowSource] = useState(false);
	const [copied, setCopied] = useState(false);
	const [busy, setBusy] = useState<"svg" | "png" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const ready = state.status === "ready" ? state.svg : null;
	const size = useMemo(() => (ready === null ? FALLBACK_SIZE : (svgSize(ready) ?? FALLBACK_SIZE)), [ready]);
	const display = useMemo(() => (ready === null ? "" : standaloneSvg(ready, size)), [ready, size]);

	const copy = (): void => {
		void navigator.clipboard?.writeText(source).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	const save = async (format: "svg" | "png"): Promise<void> => {
		if (ready === null || busy !== null) return;
		setBusy(format);
		setProblem(null);
		try {
			const blob = format === "svg" ? svgBlob(ready, size) : await svgToPngBlob(ready, size, pageBackground());
			await saveBlob(blob, `${kind}-diagram.${format}`);
		} catch (error) {
			setProblem(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
		}
	};
	const edit = (): void => {
		if (kind === "mermaid") {
			openCanvas("Edit diagram", "diagram", { kind: "mermaid", source });
			return;
		}
		const parsed = parseScene(source);
		if (parsed.ok) openCanvas("Edit drawing", "drawing", { kind: "scene", scene: parsed.scene });
		else setProblem(parsed.error);
	};

	return (
		<Sheet label={`${KIND_LABEL[kind]} diagram`} size="full" onClose={onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">{KIND_LABEL[kind]} diagram</div>
				<span className="sh-diagram-actions">
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => setShowSource(shown => !shown)}
						aria-pressed={showSource}
						aria-label="toggle source"
						title={showSource ? "show the diagram" : "show the source"}
					>
						<Code size={15} />
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={copy}
						aria-label="copy source"
						title="copy source"
					>
						{copied ? <Check size={15} /> : <Copy size={15} />}
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => void save("svg")}
						disabled={ready === null || busy !== null}
						aria-label="download SVG"
						title="download SVG"
					>
						{busy === "svg" ? <LoaderCircle size={15} className="sh-spin" /> : <Download size={15} />}
					</button>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => void save("png")}
						disabled={ready === null || busy !== null}
						aria-label="download PNG"
						title="download PNG"
					>
						{busy === "png" ? <LoaderCircle size={15} className="sh-spin" /> : <FileImage size={15} />}
					</button>
					<button type="button" className="sh-btn sh-diagram-edit" onClick={edit} title="edit on the canvas">
						<Pencil size={14} /> <span className="sh-btn-label">Edit</span>
					</button>
					<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} aria-label="close">
						<X size={16} />
					</button>
				</span>
			</div>
			{problem !== null && <div className="sh-connect-error">{problem}</div>}
			{state.status === "loading" && (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Rendering the diagram…
				</div>
			)}
			{(state.status === "error" || state.status === "unavailable") && (
				<div className="sh-diagram-fail">
					<div className="sh-connect-error">
						{state.status === "unavailable"
							? `The ${KIND_LABEL[kind]} renderer could not be loaded: ${state.message}`
							: `Could not render this ${KIND_LABEL[kind]} diagram: ${state.message}`}
					</div>
					{state.status === "unavailable" && (
						<button type="button" className="sh-btn" onClick={retry}>
							<RefreshCw size={14} /> Retry
						</button>
					)}
					<SourceBlock kind={kind} source={source} />
				</div>
			)}
			{ready !== null &&
				(showSource ? (
					<div className="sh-diagram-source">
						<SourceBlock kind={kind} source={source} />
					</div>
				) : (
					<PanZoom size={size}>
						<div className="sh-diagram-art" dangerouslySetInnerHTML={{ __html: display }} />
					</PanZoom>
				))}
		</Sheet>
	);
}
