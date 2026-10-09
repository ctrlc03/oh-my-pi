import { useCallback, useEffect, useState } from "react";

export type RequestState<T> =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; value: T };

/**
 * Runs `load` on mount and whenever it changes (memoize it with `useCallback`),
 * and again on `reload()`. A superseded request's answer is dropped.
 */
export function useRequest<T>(load: () => Promise<T>): { state: RequestState<T>; reload(): void } {
	const [state, setState] = useState<RequestState<T>>({ status: "loading" });
	const [tick, setTick] = useState(0);

	useEffect(() => {
		let stale = false;
		setState({ status: "loading" });
		load().then(
			value => {
				if (!stale) setState({ status: "ready", value });
			},
			(err: unknown) => {
				if (!stale) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
			},
		);
		return () => {
			stale = true;
		};
	}, [load, tick]);

	const reload = useCallback(() => setTick(n => n + 1), []);
	return { state, reload };
}
