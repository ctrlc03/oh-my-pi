import { LoaderCircle, RefreshCw } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useEffect, useState } from "react";

let loaded: Promise<ComponentType> | undefined;

/** The Personal agent's screens load the first time they are shown and are shared after that; a failed fetch is retried next time. */
function fetchPersonalSettings(): Promise<ComponentType> {
	loaded ??= import("../personal/PersonalSettings").then(
		module => module.default,
		(error: unknown) => {
			loaded = undefined;
			throw error;
		},
	);
	return loaded;
}

/** Settings → Personal agent. Its code stays out of the app's entry chunk: a spinner (or the error and Retry) stands in while it loads. */
export function PersonalSection(): ReactNode {
	// Held in an object: a bare component function would be taken for a state updater.
	const [ready, setReady] = useState<{ Screen: ComponentType } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let stale = false;
		setError(null);
		fetchPersonalSettings().then(
			Screen => {
				if (!stale) setReady({ Screen });
			},
			(err: unknown) => {
				if (!stale) setError(err instanceof Error ? err.message : String(err));
			},
		);
		return () => {
			stale = true;
		};
	}, [attempt]);

	if (ready !== null) return <ready.Screen />;
	if (error === null) {
		return (
			<div className="sh-companion-empty sh-file-status" role="status">
				<LoaderCircle size={14} className="sh-spin" /> Loading Personal agent…
			</div>
		);
	}
	return (
		<div className="sh-tree-error">
			<div className="sh-connect-error">Could not load Personal agent: {error}</div>
			<button type="button" className="sh-btn" onClick={() => setAttempt(n => n + 1)}>
				<RefreshCw size={14} /> Retry
			</button>
		</div>
	);
}
