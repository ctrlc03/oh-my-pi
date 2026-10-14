import { LoaderCircle } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { importChunk } from "../../lib/stale-build";
import { LoadFailure } from "../shell/LoadFailure";
import { Sheet } from "../shell/Sheet";
import { DiagramHead } from "./DiagramHead";
import type { DiagramSheetsProps } from "./DiagramSheets";

type DiagramSheetsComponent = ComponentType<DiagramSheetsProps>;

let loaded: Promise<DiagramSheetsComponent> | undefined;

/** The diagram sheets, fetched on first use and shared after that. A failed fetch is retried next time. */
function loadDiagramSheets(): Promise<DiagramSheetsComponent> {
	// Dynamic: the viewer, canvas and file sheets stay out of the entry bundle until a diagram is opened.
	loaded ??= importChunk(() => import("./DiagramSheets")).then(
		module => module.DiagramSheets,
		(error: unknown) => {
			loaded = undefined;
			throw error;
		},
	);
	return loaded;
}

/** `DiagramSheets`, loaded when first shown; the sheet frame with a spinner stands in meanwhile. */
export function LazyDiagramSheets(props: DiagramSheetsProps): ReactNode {
	// Held in an object: a bare component function would be taken for a state updater.
	const [loadedSheet, setLoadedSheet] = useState<{ Sheet: DiagramSheetsComponent } | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let stale = false;
		setError(null);
		loadDiagramSheets().then(
			next => {
				if (!stale) setLoadedSheet({ Sheet: next });
			},
			(err: unknown) => {
				if (!stale) setError(err instanceof Error ? err : new Error(String(err)));
			},
		);
		return () => {
			stale = true;
		};
	}, [attempt]);

	if (loadedSheet !== null) return <loadedSheet.Sheet {...props} />;
	return (
		<Sheet label="diagram" size="full" onClose={props.onClose}>
			<DiagramHead title="Diagram" onClose={props.onClose} />
			{error === null ? (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading…
				</div>
			) : (
				<LoadFailure what="the diagram tools" error={error} onRetry={() => setAttempt(n => n + 1)} />
			)}
		</Sheet>
	);
}
