import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionClient, GitSnapshot } from "../../../lib/companion";

/** The working tree is read again this often while the explorer shows it. */
export const GIT_POLL_MS = 10_000;

export interface GitStatus {
	git: GitSnapshot | null;
	/** The last read failed (not a repository, computer unreachable); `git` keeps the previous answer. */
	error: string | null;
	loading: boolean;
	refresh(): void;
}

/**
 * The session's working tree: read on mount while `active`, again when `edits` (the agent's edit counter) changes,
 * and every {@link GIT_POLL_MS} while the page is visible. A slower answer never replaces a newer one.
 */
export function useGitStatus(client: CompanionClient, instanceId: string, edits: number, active: boolean): GitStatus {
	const [git, setGit] = useState<GitSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const latest = useRef(0);

	const refresh = useCallback(() => {
		const ticket = ++latest.current;
		setLoading(true);
		client.requestGit(instanceId).then(
			snapshot => {
				if (ticket !== latest.current) return;
				setGit(snapshot);
				setError(null);
				setLoading(false);
			},
			(err: unknown) => {
				if (ticket !== latest.current) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			},
		);
	}, [client, instanceId]);

	// `edits` is a trigger, not an input: a new agent edit reads the tree again.
	useEffect(() => {
		if (active) refresh();
	}, [active, refresh, edits]);

	useEffect(() => {
		if (!active) return;
		const tick = (): void => {
			if (document.visibilityState === "visible") refresh();
		};
		const timer = setInterval(tick, GIT_POLL_MS);
		document.addEventListener("visibilitychange", tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", tick);
		};
	}, [active, refresh]);

	useEffect(
		() => () => {
			// A late answer after unmount must not set state.
			latest.current = -1;
		},
		[],
	);

	return { git, error, loading, refresh };
}
