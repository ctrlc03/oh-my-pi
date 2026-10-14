import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	describeWhen,
	formatRunTime,
	MAX_SCHEDULE_PROMPT_CHARS,
	nextRuns,
	parseScheduleWhen,
	type Schedule,
	type ScheduleInput,
	type ScheduleWhen,
} from "@oh-my-pi/pi-wire/schedule";
import scheduleDescription from "../prompts/tools/schedule.md" with { type: "text" };
import {
	CompanionRefusedError,
	CompanionUnavailableError,
	type CompanionSchedules,
	companionSchedules,
} from "../schedule/companion-client";
import { cfgPersonalEnabled } from "../personal/settings";
import { cfgScheduleEnabled } from "../schedule/settings";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { resolveToCwd } from "./path-utils";
import { toolResult } from "./tool-result";

const scheduleSchema = type({
	action: type.enumerated("create", "list", "delete"),
	"title?": type("string").describe("short name shown in the app (default: start of the prompt)"),
	"prompt?": type("string").describe("create: what the agent is asked to do each time; it runs unattended"),
	"cron?": type("string").describe(
		"create: 5-field cron (minute hour day-of-month month day-of-week) or @daily-style macro",
	),
	"timezone?": type("string").describe(
		"create, with cron: IANA zone such as Europe/Berlin (default: this computer's)",
	),
	"every_minutes?": type("number").describe("create: repeat every N minutes (at least 5)"),
	"at?": type("string").describe("create: run once at this date-time, ISO 8601 (local time unless it has an offset)"),
	"catch_up?": type
		.enumerated("skip", "run-once")
		.describe("create: if the computer was off at the time: skip (default) or run once when back"),
	"cwd?": type("string").describe("create: folder to run in (default: this session's)"),
	"max_cost_usd?": type("number").describe("create: stop each run once it has spent this many USD"),
	"resume_current?": type("boolean").describe(
		"create: continue this session instead of starting a new one (only works once it has ended)",
	),
	"id?": type("string").describe("delete: schedule id from list"),
});

/** Parameters accepted by the `schedule` tool. */
export type ScheduleParams = typeof scheduleSchema.infer;

/** Structured details attached to `schedule` tool results. */
export interface ScheduleToolDetails {
	action: ScheduleParams["action"];
	schedule?: Schedule;
	meta?: OutputMeta;
}

/** Added to the tool description in a Personal session, where a schedule comes back to the live session instead of starting a process. */
const PERSONAL_SCHEDULE_NOTE =
	"In this session a schedule does not start a new run: when it is due, your prompt comes back to you in this live session as an event from an agent-made schedule, which counts as outside content (its turn is restricted). Use it for reminders and checks, not for work that needs your full trust.";

const NEXT_RUNS_SHOWN = 3;
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type Built = { input: ScheduleInput } | { error: string };

/** The schedule `params` ask for, or why they cannot be one. Shared by the approval prompt and execution. */
function buildSchedule(params: Partial<ScheduleParams>, session: ToolSession): Built {
	if (typeof params.prompt !== "string" || params.prompt.trim() === "") return { error: "prompt is required" };
	if (params.prompt.length > MAX_SCHEDULE_PROMPT_CHARS)
		return { error: `prompt is over ${MAX_SCHEDULE_PROMPT_CHARS} characters` };
	const timings = [params.cron, params.every_minutes, params.at].filter(value => value !== undefined);
	if (timings.length !== 1) return { error: "give exactly one of cron, every_minutes, or at" };
	if (params.timezone !== undefined && params.cron === undefined) return { error: "timezone only applies to cron" };
	let when: ScheduleWhen;
	try {
		if (params.cron !== undefined) {
			when = parseScheduleWhen({ kind: "cron", expr: params.cron, tz: params.timezone });
		} else if (params.every_minutes !== undefined) {
			when = parseScheduleWhen({ kind: "interval", everyMin: params.every_minutes });
		} else {
			const at = Date.parse(params.at ?? "");
			if (Number.isNaN(at)) return { error: `cannot read "${params.at}" as a date and time (use ISO 8601)` };
			when = parseScheduleWhen({ kind: "once", at });
		}
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	if (when.kind === "once" && when.at <= Date.now()) return { error: "that date and time has already passed" };
	const sessionId = params.resume_current ? (session.getSessionId?.() ?? undefined) : undefined;
	if (params.resume_current && sessionId === undefined) return { error: "this session has no id to resume yet" };
	if (params.resume_current && params.max_cost_usd !== undefined)
		return { error: "max_cost_usd needs a new session, not a resumed one" };
	return {
		input: {
			title: params.title ?? "",
			prompt: params.prompt,
			cwd: resolveToCwd(params.cwd ?? ".", session.cwd),
			mode: sessionId === undefined ? "new" : "resume",
			sessionId,
			maxCostUsd: params.max_cost_usd,
			when,
			catchUp: params.catch_up,
			enabled: true,
			...(cfgPersonalEnabled.get(session.settings) ? { deliverTo: "personal" as const } : {}),
		},
	};
}

function zoneOf(when: ScheduleWhen): string {
	return when.kind === "cron" && when.tz !== undefined ? when.tz : LOCAL_ZONE;
}

function runTimes(when: ScheduleWhen, runs: number[]): string {
	return runs.map(run => formatRunTime(run, zoneOf(when))).join("; ");
}

function describeSchedule(schedule: Schedule): string {
	const parts = [`${schedule.id}  "${schedule.title}"  ${describeWhen(schedule.when)}`];
	if (schedule.when.kind === "cron") parts.push(`cron: ${schedule.when.expr}`);
	if (!schedule.enabled) parts.push("off");
	else if (schedule.nextRun !== null) parts.push(`next ${formatRunTime(schedule.nextRun, zoneOf(schedule.when))}`);
	if (schedule.catchUp === "run-once") parts.push("catches up");
	parts.push(schedule.createdBy === "agent" ? "made by an agent" : "made in the app");
	return parts.join("  ·  ");
}

/**
 * Create, list and delete the companion's scheduled runs. A schedule starts a prompt later with nobody
 * watching, so creating one always asks the user (whatever the approval mode or `allow` policy), showing
 * the cron in words and the next three run times. Deleting only reaches schedules an agent made.
 */
export class ScheduleTool implements AgentTool<typeof scheduleSchema, ScheduleToolDetails> {
	readonly name = "schedule";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		// Approval runs on the model's raw arguments, before the schema has checked them.
		const params = args as Partial<ScheduleParams>;
		if (params.action === "list") return "read";
		if (params.action === "delete") return "write";
		// An invalid request fails in `execute` with the reason: nothing worth asking the user about.
		if ("error" in buildSchedule(params, this.session)) return "read";
		return {
			tier: "exec",
			policy: "prompt",
			reason: "A schedule starts this prompt later, unattended, on the companion's computer",
		};
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<ScheduleParams>;
		if (params.action === "delete") return [`Delete schedule: ${truncateForPrompt(params.id ?? "(missing)")}`];
		if (params.action !== "create") return [];
		const built = buildSchedule(params, this.session);
		if ("error" in built) return [`Invalid: ${built.error}`];
		const { input } = built;
		const lines = [`Runs: ${describeWhen(input.when)}`];
		if (input.when.kind === "cron") {
			lines.push(`Cron: ${input.when.expr}${input.when.tz === undefined ? "" : ` (${input.when.tz})`}`);
		}
		lines.push(`Next runs: ${runTimes(input.when, nextRuns(input.when, Date.now(), NEXT_RUNS_SHOWN))}`);
		lines.push(`Clock: ${zoneOf(input.when)}`);
		if (input.deliverTo === "personal") {
			lines.push(
				"Delivered to: the Personal agent's session, as an event from an agent-made schedule (treated as outside content)",
			);
		} else {
			lines.push(`Folder: ${truncateForPrompt(input.cwd)}`);
			lines.push(input.mode === "resume" ? "Session: continues this one" : "Session: a new one each run");
		}
		lines.push(`If missed: ${input.catchUp === "run-once" ? "run once when back" : "skip"}`);
		if (input.maxCostUsd !== undefined) lines.push(`Spend limit per run: $${input.maxCostUsd}`);
		lines.push(`Prompt: ${truncateForPrompt(input.prompt)}`);
		return lines;
	};
	readonly label = "Schedule";
	readonly summary = "Schedule prompts to run later on a cron, interval, or once, via the collab companion";
	readonly description: string;
	readonly parameters = scheduleSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(
		private readonly session: ToolSession,
		private readonly companion: CompanionSchedules = companionSchedules(session.settings.getAgentDir()),
	) {
		this.description = prompt.render(scheduleDescription);
		if (cfgPersonalEnabled.get(session.settings)) this.description += `\n\n${PERSONAL_SCHEDULE_NOTE}`;
	}

	/** Create the tool for top-level sessions when `schedule.enabled` is on. */
	static createIf(session: ToolSession): ScheduleTool | null {
		return cfgScheduleEnabled.get(session.settings) && (session.taskDepth ?? 0) === 0
			? new ScheduleTool(session)
			: null;
	}

	async execute(
		_toolCallId: string,
		params: ScheduleParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ScheduleToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ScheduleToolDetails>> {
		const details: ScheduleToolDetails = { action: params.action };
		const result = toolResult(details);
		try {
			switch (params.action) {
				case "list": {
					const schedules = await this.companion.list(signal);
					if (schedules.length === 0) return result.text("No schedules.").done();
					return result.text(schedules.map(describeSchedule).join("\n")).done();
				}
				case "create": {
					const built = buildSchedule(params, this.session);
					if ("error" in built) throw new ToolError(built.error);
					const schedule = await this.companion.create(built.input, signal);
					details.schedule = schedule;
					const upcoming = nextRuns(schedule.when, Date.now(), NEXT_RUNS_SHOWN);
					return result
						.text(
							`Scheduled ${describeSchedule(schedule)}\nNext runs: ${runTimes(schedule.when, upcoming)}\nIt appears in the app's Schedules, marked as made by an agent; delete it with action "delete" and id ${schedule.id}.`,
						)
						.done();
				}
				case "delete": {
					if (params.id === undefined || params.id.trim() === "") throw new ToolError("id is required to delete");
					await this.companion.remove(params.id, signal);
					return result.text(`Deleted schedule ${params.id}.`).done();
				}
			}
		} catch (err) {
			if (err instanceof CompanionUnavailableError) throw new ToolError(err.message);
			if (err instanceof CompanionRefusedError) throw new ToolError(`The companion refused: ${err.message}`);
			throw err;
		}
	}
}
