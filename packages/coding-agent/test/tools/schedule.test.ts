import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Schedule, ScheduleInput } from "@oh-my-pi/pi-wire/schedule";
import { Settings } from "../../src/config/settings";
import { type CompanionSchedules, companionSchedules } from "../../src/schedule/companion-client";
import type { ToolSession } from "../../src/tools";
import { type ApprovalMode, formatApprovalPrompt, resolveApproval } from "../../src/tools/approval";
import { ScheduleTool } from "../../src/tools/schedule";

const MODES: ApprovalMode[] = ["always-ask", "write", "yolo"];
const weekdayTests = { action: "create", prompt: "Run the tests and report failures", cron: "0 9 * * 1-5" } as const;

describe("schedule tool", () => {
	let dir: string;
	let created: ScheduleInput[];
	let deleted: string[];
	let stored: Schedule[];

	const session = (settings = Settings.isolated({ "schedule.enabled": true }), taskDepth = 0): ToolSession =>
		({ cwd: dir, settings, taskDepth, getSessionId: () => "sess-1" }) as unknown as ToolSession;

	const fake: CompanionSchedules = {
		list: async () => stored,
		create: async input => {
			created.push(input);
			const schedule: Schedule = {
				...input,
				id: "sched-1",
				createdBy: "agent",
				nextRun: Date.UTC(2099, 0, 1),
				lastRun: undefined,
			};
			stored = [schedule];
			return schedule;
		},
		remove: async id => {
			deleted.push(id);
		},
	};

	const tool = () => new ScheduleTool(session(), fake);
	const textOf = (result: { content: Array<{ type: string; text?: string }> }) => result.content[0]?.text ?? "";

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-schedule-tool-"));
		created = [];
		deleted = [];
		stored = [];
	});
	afterEach(() => fs.rm(dir, { recursive: true, force: true }));

	describe("approval", () => {
		it("prompts for every creation whatever the mode, and whatever the user allowed", () => {
			const t = tool();
			for (const mode of MODES) {
				expect(resolveApproval(t, weekdayTests, mode, {})).toMatchObject({ policy: "prompt", tier: "exec" });
				expect(resolveApproval(t, weekdayTests, mode, { schedule: "allow" }).policy).toBe("prompt");
			}
			expect(resolveApproval(t, weekdayTests, "yolo", { schedule: "deny" }).policy).toBe("deny");
		});

		it("lets listing through, and asks nothing about a request that cannot be created anyway", () => {
			const t = tool();
			expect(resolveApproval(t, { action: "list" }, "always-ask", {}).policy).toBe("allow");
			expect(resolveApproval(t, { action: "create", prompt: "x" }, "always-ask", {}).policy).toBe("allow");
			expect(resolveApproval(t, { action: "delete", id: "a" }, "always-ask", {})).toMatchObject({
				policy: "prompt",
				tier: "write",
			});
		});

		it("shows the cron in words and the next three run times in its zone", () => {
			const text = formatApprovalPrompt(
				tool(),
				{ ...weekdayTests, timezone: "Europe/Berlin", catch_up: "run-once", max_cost_usd: 2 },
				"reason",
			);
			expect(text).toContain("Allow tool: schedule");
			expect(text).toContain("At 09:00 on weekdays (Europe/Berlin)");
			expect(text).toContain("Cron: 0 9 * * 1-5 (Europe/Berlin)");
			const nextRunsLine = text.split("\n").find(line => line.startsWith("Next runs: "));
			expect(nextRunsLine?.slice("Next runs: ".length).split("; ")).toHaveLength(3);
			expect(nextRunsLine).toMatch(/CES?T/);
			expect(text).toContain("If missed: run once when back");
			expect(text).toContain("$2");
			expect(text).toContain(`Folder: ${dir}`);
		});
	});

	describe("create", () => {
		it("sends the companion a cron schedule for the session's folder and tells the agent when it runs", async () => {
			const result = await tool().execute("c1", {
				...weekdayTests,
				title: "Weekday tests",
				timezone: "Europe/Berlin",
			});
			expect(created).toEqual([
				{
					title: "Weekday tests",
					prompt: "Run the tests and report failures",
					cwd: dir,
					mode: "new",
					sessionId: undefined,
					maxCostUsd: undefined,
					when: { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Berlin" },
					catchUp: undefined,
					enabled: true,
				},
			]);
			expect(textOf(result)).toContain("sched-1");
			expect(textOf(result)).toContain("weekdays");
		});

		it("takes an interval, a one-off date, a folder, a catch-up policy and a resume of this session", async () => {
			await tool().execute("c1", {
				action: "create",
				prompt: "p",
				every_minutes: 30,
				catch_up: "run-once",
				cwd: "sub",
			});
			expect(created[0]).toMatchObject({
				when: { kind: "interval", everyMin: 30 },
				catchUp: "run-once",
				cwd: path.join(dir, "sub"),
			});
			await tool().execute("c2", {
				action: "create",
				prompt: "p",
				at: "2099-01-02T08:00:00+02:00",
				resume_current: true,
			});
			expect(created[1]).toMatchObject({
				when: { kind: "once", at: Date.UTC(2099, 0, 2, 6) },
				mode: "resume",
				sessionId: "sess-1",
			});
		});

		it("explains what is wrong instead of sending the companion a bad schedule", async () => {
			const bad: Array<[Record<string, unknown>, string]> = [
				[{ action: "create", cron: "0 9 * * 1-5" }, "prompt is required"],
				[{ action: "create", prompt: "p" }, "exactly one of"],
				[{ action: "create", prompt: "p", cron: "0 9 * * *", every_minutes: 10 }, "exactly one of"],
				[{ action: "create", prompt: "p", cron: "* * * * *" }, "shortest allowed"],
				[{ action: "create", prompt: "p", cron: "0 9 * * *", timezone: "Mars/Base" }, "time zone"],
				[{ action: "create", prompt: "p", every_minutes: 3 }, "interval"],
				[{ action: "create", prompt: "p", every_minutes: 10, timezone: "UTC" }, "only applies to cron"],
				[{ action: "create", prompt: "p", at: "2001-01-01T00:00:00Z" }, "already passed"],
				[{ action: "create", prompt: "p", at: "soon" }, "ISO 8601"],
				[
					{ action: "create", prompt: "p", cron: "0 9 * * *", resume_current: true, max_cost_usd: 1 },
					"new session",
				],
			];
			for (const [params, message] of bad) {
				await expect(tool().execute("c", params as never)).rejects.toThrow(message);
			}
			expect(created).toEqual([]);
		});
	});

	describe("list and delete", () => {
		it("lists what the companion holds and deletes by id", async () => {
			const t = tool();
			expect(textOf(await t.execute("l0", { action: "list" }))).toBe("No schedules.");
			await t.execute("c", weekdayTests);
			const listed = textOf(await t.execute("l1", { action: "list" }));
			expect(listed).toContain("sched-1");
			expect(listed).toContain("made by an agent");
			await t.execute("d", { action: "delete", id: "sched-1" });
			expect(deleted).toEqual(["sched-1"]);
			await expect(t.execute("d2", { action: "delete" })).rejects.toThrow("id is required");
		});
	});

	describe("without a companion", () => {
		it("says scheduling needs the companion, for every action", async () => {
			const t = new ScheduleTool(session(), companionSchedules(dir));
			for (const params of [{ action: "list" }, weekdayTests, { action: "delete", id: "a" }] as const) {
				await expect(t.execute("c", params as never)).rejects.toThrow("needs the omp collab companion");
			}
		});
	});

	describe("availability", () => {
		it("is off unless enabled, and not offered to subagents", () => {
			expect(ScheduleTool.createIf(session(Settings.isolated({})))).toBeNull();
			expect(ScheduleTool.createIf(session())).toBeInstanceOf(ScheduleTool);
			expect(ScheduleTool.createIf(session(Settings.isolated({ "schedule.enabled": true }), 1))).toBeNull();
		});
	});
});
