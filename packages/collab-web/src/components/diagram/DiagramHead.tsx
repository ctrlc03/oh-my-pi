import { X } from "lucide-react";
import type { ReactNode } from "react";
import "./diagram.css";

export interface DiagramHeadProps {
	title: string;
	/** The full path, when `title` is a file name: it is the tooltip and the title is set as a path. */
	titleHint?: string;
	/** The sheet's buttons: `sh-btn sh-diagram-action` with an icon and a `sh-diagram-action-label`. */
	children?: ReactNode;
	onClose(): void;
}

/**
 * The head shared by the diagram sheets: the title and the close button on one row, the actions beside them
 * (below them on a phone, where all of them do not fit next to a title).
 */
export function DiagramHead({ title, titleHint, children, onClose }: DiagramHeadProps): ReactNode {
	return (
		<div className="sh-sheet-head sh-diagram-head">
			<div className={titleHint === undefined ? "sh-sheet-title" : "sh-sheet-title sh-file-path"} title={titleHint}>
				{title}
			</div>
			{children !== undefined && <span className="sh-diagram-actions">{children}</span>}
			<button type="button" className="sh-btn sh-btn-icon sh-diagram-close" onClick={onClose} aria-label="Close">
				<X size={16} />
			</button>
		</div>
	);
}
