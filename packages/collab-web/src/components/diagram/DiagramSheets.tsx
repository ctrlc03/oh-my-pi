import type { ReactNode } from "react";
import type { CompanionClient } from "../../lib/companion";
import type { DiagramRequest } from "../../lib/diagram-store";
import { CanvasSheet } from "./CanvasSheet";
import { DiagramFileSheet } from "./DiagramFileSheet";
import { DiagramViewer } from "./DiagramViewer";

/** The paired computer's file access for diagram files of the session's repository. */
export interface DiagramFiles {
	client: CompanionClient;
	instanceId: string;
	/** This device may change files there: the editor is available and the link is not view-only. */
	canWrite: boolean;
}

export interface DiagramSheetsProps {
	request: DiagramRequest;
	/** Puts files and a note into the message box; null when this guest cannot send. */
	onAttach: ((files: File[], note: string) => void) | null;
	files: DiagramFiles | null;
	onClose(): void;
}

/** The sheet for one diagram request: the viewer, the canvas, or a repository file. */
export function DiagramSheets({ request, onAttach, files, onClose }: DiagramSheetsProps): ReactNode {
	switch (request.t) {
		case "view":
			return <DiagramViewer kind={request.kind} source={request.source} onClose={onClose} />;
		case "canvas":
			return (
				<CanvasSheet
					title={request.title}
					name={request.name}
					source={request.source}
					onAttach={onAttach}
					onClose={onClose}
				/>
			);
		case "file":
			return files === null ? null : (
				<DiagramFileSheet
					client={files.client}
					instanceId={files.instanceId}
					path={request.path}
					canWrite={files.canWrite}
					onAttach={onAttach}
					onClose={onClose}
				/>
			);
	}
}
