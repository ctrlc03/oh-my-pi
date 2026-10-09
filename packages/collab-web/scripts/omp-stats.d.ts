/**
 * Types for the omp-stats functions the companion calls (tsconfig `paths` maps the
 * `@oh-my-pi/omp-stats/{aggregator,rollup,trace}` subpaths here). This project type-checks with the
 * browser's DOM lib, and the real modules pull in pi-ai, which only type-checks against the workspace's
 * non-DOM lib. bun still resolves the real modules at runtime. Keep in sync with packages/stats/src.
 */
import type { DashboardStats, SessionSummary } from "@oh-my-pi/omp-stats/shared-types";

export function getDashboardStats(range?: string | null): Promise<DashboardStats>;
export function syncAllSessions(): Promise<{ processed: number; files: number }>;
export function refreshRollups(): Promise<void>;
export function listSessionSummaries(limit?: number, q?: string): Promise<SessionSummary[]>;
