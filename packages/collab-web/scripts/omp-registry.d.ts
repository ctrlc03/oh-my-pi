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

/** Access a link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabAccess = "view" | "control";

/** One resolved capability: a browser URL for `access`, bound to the room `generation` it was issued for. */
export interface CollabResolvedLink {
	instanceId: string;
	generation: number;
	access: CollabAccess;
	url: string;
}

/** Stable failure codes of {@link resolveCollabHostLink} and {@link startCollabSession}. */
export type CollabLinkErrorCode =
	| "not_found"
	| "ambiguous"
	| "stale_generation"
	| "access_unavailable"
	| "unreachable"
	| "not_startable"
	| "start_failed";

export class CollabLinkError extends Error {
	readonly code: CollabLinkErrorCode;
}

export function listCollabSessions(): Promise<CollabSessionListing>;

/** The host named by an instance id (or pid): one link, bound to the generation observed while listing. */
export function resolveCollabHostLink(selector: string, access: CollabAccess): Promise<CollabResolvedLink>;

/** Makes an idle omp host (as `/collab` does) and returns its link; a host already hosting hands out its link. */
export function startCollabSession(selector: string, access: CollabAccess): Promise<CollabResolvedLink>;
