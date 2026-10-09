import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sheet } from "../shell/Sheet";
import type { CodemapSheetProps } from "./CodemapSheet";

type CodemapSheetComponent = ComponentType<CodemapSheetProps>;

let loaded: Promise<CodemapSheetComponent> | undefined;

/** The code map sheet, fetched on first use and shared after that. A failed fetch is retried next time. */
function loadCodemapSheet(): Promise<CodemapSheetComponent> {
	// The code map screens and their force layout (d3-force) are large and only needed once the map is opened:
	// keep them out of the entry bundle.
	loaded ??= import("./CodemapSheet").then(
		module => module.CodemapSheet,
		(error: unknown) => {
			loaded = undefined;
			throw error;
		},
	);
	return loaded;
}

/** `CodemapSheet`, loaded when first shown; the sheet frame with a spinner stands in meanwhile. */
export function LazyCodemapSheet(props: CodemapSheetProps): ReactNode {
	// Held in an object: a bare component function would be taken for a state updater.
	const [loadedSheet, setLoadedSheet] = useState<{ Sheet: CodemapSheetComponent } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let stale = false;
		setError(null);
		loadCodemapSheet().then(
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
	return (
		<Sheet label="code map" size="wide" onClose={props.onClose}>
			<div className="sh-sheet-head">
				<div className="sh-sheet-title">Code map</div>
				<button type="button" className="sh-btn sh-btn-icon" onClick={props.onClose} aria-label="close">
					<X size={16} />
				</button>
			</div>
			{error === null ? (
				<div className="sh-companion-empty sh-file-status">
					<LoaderCircle size={14} className="sh-spin" /> Loading the code map…
				</div>
			) : (
				<div className="sh-tree-error">
					<div className="sh-connect-error">Could not load the code map: {error}</div>
					<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
						<RefreshCw size={14} /> Retry
					</button>
				</div>
			)}
		</Sheet>
	);
}
