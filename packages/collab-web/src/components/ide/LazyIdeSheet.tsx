import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sheet } from "../shell/Sheet";
import { DockPane } from "../shell/SplitPane";
import type { IdeSheetProps } from "./IdeSheet";

type IdeSheetComponent = ComponentType<IdeSheetProps>;

let loaded: Promise<IdeSheetComponent> | undefined;

/** The editor sheet, fetched on first use and shared after that. A failed fetch is retried next time. */
function loadIdeSheet(): Promise<IdeSheetComponent> {
	// CodeMirror is large and only needed once the editor opens: keep it out of the entry bundle.
	loaded ??= import("./IdeSheet").then(
		module => module.IdeSheet,
		(error: unknown) => {
			loaded = undefined;
			throw error;
		},
	);
	return loaded;
}

/** `IdeSheet`, loaded when first shown; the sheet frame with a spinner stands in meanwhile. */
export function LazyIdeSheet(props: IdeSheetProps): ReactNode {
	// Held in an object: a bare component function would be taken for a state updater.
	const [loadedSheet, setLoadedSheet] = useState<{ Sheet: IdeSheetComponent } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let stale = false;
		setError(null);
		loadIdeSheet().then(
			next => {
				if (!stale) setLoadedSheet({ Sheet: next });
			},
			(err: unknown) => {
				if (!stale) setError(err instanceof Error ? err.message : String(err));
			},
		);
		return () => {
			stale = true;
		};
	}, [attempt]);

	if (loadedSheet !== null) return <loadedSheet.Sheet {...props} />;
	const placeholder = (
		<>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Editor</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={props.onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{error === null ? (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading the editor…
				</div>
			) : (
				<div className="sh-tree-error">
					<div className="sh-connect-error">Could not load the editor: {error}</div>
					<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
		</>
	);
	if (props.dock?.docked === true) return <DockPane label="editor">{placeholder}</DockPane>;
	return (
		<Sheet label="editor" size="full" onClose={props.onClose}>
			{placeholder}
		</Sheet>
	);
}
