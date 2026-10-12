import type { ReactNode } from "react";
import { PANES, type PaneId } from "../../lib/pane-size";
import type { PaneLayout } from "../../lib/use-pane-layout";
import "./splitter.css";

export interface SplitterProps {
	pane: PaneId;
	layout: PaneLayout;
}

/**
 * The divider between a docked pane and the transcript: dragged with a pointer or finger, or moved with the
 * arrow keys. It takes no room of its own: it sits in the gap the pane already leaves (`data-edge` says
 * which side of the gap), with a hit area wider than the visible line.
 */
export function Splitter({ pane, layout }: SplitterProps): ReactNode {
	const spec = PANES[pane];
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={spec.label}
			tabIndex={0}
			className="sh-splitter"
			data-edge={spec.edge}
			data-pane-splitter={pane}
			{...layout.splitterProps(pane)}
		/>
	);
}
