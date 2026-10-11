import type { ReactNode } from "react";
import { closeAllDiagrams, closeDiagram, useDiagramStack } from "../../lib/diagram-store";
import type { DiagramFiles } from "./DiagramSheets";
import { LazyDiagramSheets } from "./LazyDiagramSheets";

export interface DiagramHostProps {
	/** Puts files and a note into the message box; null when this guest cannot send. */
	onAttach: ((files: File[], note: string) => void) | null;
	/** The paired computer's file access for repository diagram files; null without one. */
	files: DiagramFiles | null;
}

/**
 * Renders whatever diagram requests are open (viewer, canvas, repository file), stacked like sheets. Mounted
 * once by the app; the sheets themselves load on first use.
 */
export function DiagramHost({ onAttach, files }: DiagramHostProps): ReactNode {
	const stack = useDiagramStack();
	if (stack.length === 0) return null;
	const attach =
		onAttach === null
			? null
			: (attached: File[], note: string): void => {
					onAttach(attached, note);
					closeAllDiagrams();
				};
	return stack.map(({ id, request }) => (
		<LazyDiagramSheets key={id} request={request} onAttach={attach} files={files} onClose={closeDiagram} />
	));
}
