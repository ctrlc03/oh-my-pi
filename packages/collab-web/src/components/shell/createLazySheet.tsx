import { LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";

/** What the stand-in sheet says while a sheet's code is fetched. */
export interface LazySheetFrame {
	/** The sheet's accessible label, lower case. */
	label: string;
	/** The title in the stand-in's header. */
	title: string;
	/** The thing being loaded, for the status line: "the code map". */
	noun: string;
}

/**
 * A sheet whose code is fetched the first time it is shown and shared after that; a failed fetch is retried next
 * time. The sheet frame with a spinner (or the error and a Retry) stands in meanwhile.
 */
export function createLazySheet<P extends { onClose(): void }>(
	frame: LazySheetFrame,
	load: () => Promise<ComponentType<P>>,
): ComponentType<P> {
	let loaded: Promise<ComponentType<P>> | undefined;
	const fetchSheet = (): Promise<ComponentType<P>> => {
		loaded ??= load().catch((error: unknown) => {
			loaded = undefined;
			throw error;
		});
		return loaded;
	};

	return function LazySheet(props: P): ReactNode {
		// Held in an object: a bare component function would be taken for a state updater.
		const [ready, setReady] = useState<{ Sheet: ComponentType<P> } | null>(null);
		const [error, setError] = useState<string | null>(null);
		const [attempt, setAttempt] = useState(0);
		useEffect(() => {
			let stale = false;
			setError(null);
			fetchSheet().then(
				next => {
					if (!stale) setReady({ Sheet: next });
				},
				(err: unknown) => {
					if (!stale) setError(err instanceof Error ? err.message : String(err));
				},
			);
			return () => {
				stale = true;
			};
		}, [attempt]);

		if (ready !== null) return <ready.Sheet {...props} />;
		return (
			<Sheet label={frame.label} size="wide" onClose={props.onClose}>
				<div className="sh-sheet-head">
					<div className="sh-sheet-title">{frame.title}</div>
					<button type="button" className="sh-btn sh-btn-icon" onClick={props.onClose} aria-label="Close">
						<X size={16} />
					</button>
				</div>
				{error === null ? (
					<div className="sh-companion-empty sh-file-status">
						<LoaderCircle size={14} className="sh-spin" /> Loading {frame.noun}…
					</div>
				) : (
					<div className="sh-tree-error">
						<div className="sh-connect-error">
							Could not load {frame.noun}: {error}
						</div>
						<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
							<RefreshCw size={14} /> Retry
						</button>
					</div>
				)}
			</Sheet>
		);
	};
}
