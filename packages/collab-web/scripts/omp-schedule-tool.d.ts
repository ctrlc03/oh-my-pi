/**
 * Types for omp's `schedule` tool, which the schedule channel test drives (tsconfig `paths` maps
 * `@oh-my-pi/pi-coding-agent/tools/schedule` here). This project type-checks with the browser's DOM lib,
 * and the real module graph only type-checks against the workspace's non-DOM lib. bun still resolves the
 * real module at runtime. Keep in sync with packages/coding-agent/src/tools/schedule.ts.
 */
import type { CompanionSchedules } from "@oh-my-pi/pi-coding-agent/schedule/companion-client";

/** The part of omp's tool session the tool reads when it is given its companion. */
export interface ScheduleToolSession {
	cwd: string;
	getSessionId?: () => string | null;
}

export interface ScheduleToolParams {
	action: "create" | "list" | "delete";
	title?: string;
	prompt?: string;
	cron?: string;
	timezone?: string;
	every_minutes?: number;
	at?: string;
	catch_up?: "skip" | "run-once";
	cwd?: string;
	max_cost_usd?: number;
	resume_current?: boolean;
	id?: string;
}

export class ScheduleTool {
	constructor(session: ScheduleToolSession, companion: CompanionSchedules);
	execute(
		toolCallId: string,
		params: ScheduleToolParams,
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
}
