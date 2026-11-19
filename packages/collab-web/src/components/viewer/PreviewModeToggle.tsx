import type { ReactNode } from "react";
import type { PreviewMode } from "../../lib/file-viewer";
import "./viewer.css";

const LABELS: Record<PreviewMode, string> = { source: "Source", preview: "Preview", split: "Split" };

export interface PreviewModeToggleProps {
	mode: PreviewMode;
	/** The modes offered, in order. */
	modes: readonly PreviewMode[];
	onChange(mode: PreviewMode): void;
}

/** The Source / Preview / Split switch of a file that has a rendered form (Markdown, SVG). */
export function PreviewModeToggle({ mode, modes, onChange }: PreviewModeToggleProps): ReactNode {
	return (
		<div className="sh-segmented sh-view-modes" role="radiogroup" aria-label="Show the file as">
			{modes.map(option => (
				<button
					key={option}
					type="button"
					role="radio"
					aria-checked={mode === option}
					className={mode === option ? "sh-segment sh-segment-on" : "sh-segment"}
					onClick={() => onChange(option)}
				>
					{LABELS[option]}
				</button>
			))}
		</div>
	);
}
