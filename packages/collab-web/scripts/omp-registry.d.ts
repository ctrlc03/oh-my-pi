/**
 * Types for the collab discovery registry the companion lists sessions from (tsconfig `paths` maps
 * `@oh-my-pi/pi-coding-agent/collab/registry` here). This project type-checks with the browser's DOM lib,
 * and the real module graph only type-checks against the workspace's non-DOM lib. bun still resolves the
 * real module at runtime. Keep in sync with packages/coding-agent/src/collab/registry.ts.
 */

/** A hosting omp as `omp collab list --json` reports it (the subset the companion reads). */
export interface CollabHostSnapshot {
	instanceId: string;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	startedAt: number;
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	/** `null`: an omp that predates the field. */
	busy: boolean | null;
	access: "view" | "control";
}

/** An interactive omp that is not hosting yet. */
export interface CollabIdleSnapshot {
	instanceId: string;
	pid: number;
	sessionId: string;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	startedAt: number;
	busy: boolean;
}

export interface CollabSessionListing {
	hosts: CollabHostSnapshot[];
	idle: CollabIdleSnapshot[];
}

export function listCollabSessions(): Promise<CollabSessionListing>;
