import { describe, expect, it } from "bun:test";
import type { AgentProgress, SubagentLifecyclePayload, SubagentProgressPayload } from "@oh-my-pi/pi-wire";
import { currentSubagents } from "../src/lib/subagents";

function payload(
	id: string,
	index: number,
	batch: string,
	status: AgentProgress["status"],
	extra: Partial<AgentProgress> = {},
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		task: `do ${id}\nwith details`,
		parentToolCallId: batch,
		progress: {
			index,
			id,
			agent: id,
			status,
			task: `do ${id}`,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 0,
			tokens: 0,
			cost: 0,
			durationMs: 1000,
			...extra,
		},
	};
}

function progressMap(...items: SubagentProgressPayload[]): Map<string, SubagentProgressPayload> {
	return new Map(items.map(item => [item.progress.id, item]));
}

const noLifecycle = new Map<string, SubagentLifecyclePayload>();

describe("currentSubagents", () => {
	it("shows only task calls with work left, in spawn order", () => {
		const work = currentSubagents(
			progressMap(
				payload("Old", 0, "call-1", "completed"),
				payload("B", 1, "call-2", "completed"),
				payload("A", 0, "call-2", "running", { lastIntent: "Reading the relay" }),
				payload("C", 2, "call-2", "pending"),
			),
			noLifecycle,
		);
		expect(work?.rows.map(row => [row.id, row.status, row.activity])).toEqual([
			["A", "running", "Reading the relay"],
			["B", "completed", null],
			["C", "pending", null],
		]);
		expect(work?.rows[0]?.label).toBe("do A");
		expect([work?.active, work?.done]).toEqual([2, 1]);
	});

	it("keeps the latest finished run readable once nothing is active", () => {
		const work = currentSubagents(
			progressMap(payload("Old", 0, "call-1", "completed"), payload("New", 0, "call-2", "failed")),
			noLifecycle,
		);
		expect(work?.rows.map(row => row.id)).toEqual(["New"]);
		expect([work?.active, work?.done]).toEqual([0, 0]);
	});

	it("lets a terminal lifecycle frame override a stale running tick", () => {
		const lifecycle = new Map<string, SubagentLifecyclePayload>([
			["A", { id: "A", agent: "task", status: "completed", index: 0 }],
		]);
		const work = currentSubagents(progressMap(payload("A", 0, "call-1", "running")), lifecycle);
		expect(work?.rows[0]?.status).toBe("completed");
		expect(work?.active).toBe(0);
	});

	it("is null before any subagent reports", () => {
		expect(currentSubagents(new Map(), noLifecycle)).toBeNull();
	});
});
