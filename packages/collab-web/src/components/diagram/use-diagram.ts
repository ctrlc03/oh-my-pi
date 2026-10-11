import { useEffect, useState } from "react";
import { cachedDiagram, type DiagramSvg, renderDiagram } from "../../lib/diagram-svg";
import type { DiagramKind } from "../../lib/diagrams";
import { useSystemTheme } from "../../lib/theme";

/** Where a diagram's rendering stands. `unavailable`: the renderer itself could not be fetched. */
export type DiagramState =
	| { status: "loading" }
	| { status: "ready"; svg: string }
	| { status: "error"; message: string }
	| { status: "unavailable"; message: string };

function stateOf(result: DiagramSvg | undefined): DiagramState {
	if (result === undefined) return { status: "loading" };
	return result.ok ? { status: "ready", svg: result.svg } : { status: "error", message: result.error };
}

/**
 * The rendering of `source` in the app's current theme, and a function that tries again after the renderer
 * failed to load. Re-renders when the theme switches, keeping the old rendering up until the new one is ready.
 */
export function useDiagram(kind: DiagramKind, source: string): { state: DiagramState; retry(): void } {
	const theme = useSystemTheme();
	const [state, setState] = useState<DiagramState>(() => stateOf(cachedDiagram(kind, theme, source)));
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const hit = cachedDiagram(kind, theme, source);
		if (hit !== undefined) {
			setState(stateOf(hit));
			return;
		}
		let stale = false;
		setState(prev => (prev.status === "ready" ? prev : { status: "loading" }));
		renderDiagram(kind, theme, source).then(
			result => {
				if (!stale) setState(stateOf(result));
			},
			(error: unknown) => {
				if (!stale)
					setState({ status: "unavailable", message: error instanceof Error ? error.message : String(error) });
			},
		);
		return () => {
			stale = true;
		};
	}, [kind, theme, source, attempt]);
	return { state, retry: () => setAttempt(n => n + 1) };
}
