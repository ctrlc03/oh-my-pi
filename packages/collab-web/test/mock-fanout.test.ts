import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanionHost } from "../src/lib/companion";
import { createMockFanout, type MockFanout } from "../scripts/mock-fanout";

let dir: string;
let hosts: CompanionHost[];
let mock: MockFanout;

beforeAll(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mock-fanout-")));
	hosts = [];
	mock = await createMockFanout({ dir, hosts, onChange: () => {} });
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("mock fan-out", () => {
	it("starts a group in real worktrees, lists it as a group of hosts and compares real changed files", async () => {
		const folders = await mock.answer({ t: "folders", reqId: 1 });
		const cwd = folders.t === "folders" ? folders.folders[0]!.cwd : "";
		const started = await mock.answer({
			t: "fanout-start",
			reqId: 2,
			request: { cwd, prompt: "p", models: ["anthropic/claude-haiku-4-5", "openai/gpt-5"], budgetUsd: 1 },
		});
		if (started.t !== "fanout-started") throw new Error("not started");
		expect(hosts).toHaveLength(2);
		expect(
			mock
				.annotate(hosts)
				.map(h => h.fanout?.model)
				.sort(),
		).toEqual(["anthropic/claude-haiku-4-5", "openai/gpt-5"]);

		const compared = await mock.answer({ t: "fanout-compare", reqId: 3, group: started.group.id });
		if (compared.t !== "fanout-compare") throw new Error("not compared");
		expect(compared.compare.runs.map(r => r.status)).toEqual(["working", "working"]);
		expect(compared.compare.runs.every(r => (r.files ?? 0) > 0 && r.dirty && r.costUsd !== null)).toBe(true);

		// The generated files are uncommitted: keeping one and removing the other needs the discard confirmation.
		const keep = hosts.find(h => h.model === "anthropic/claude-haiku-4-5")!.instanceId;
		const refused = await mock.answer({
			t: "fanout-keep",
			reqId: 4,
			request: { group: started.group.id, keep, removeOthers: true, discardDirty: false },
		});
		if (refused.t !== "fanout-kept") throw new Error("not kept");
		expect(refused.result.removed).toEqual([]);
		expect(refused.result.skipped).toHaveLength(1);
		expect(hosts).toHaveLength(2);

		const removed = await mock.answer({
			t: "fanout-keep",
			reqId: 5,
			request: { group: started.group.id, keep, removeOthers: true, discardDirty: true },
		});
		if (removed.t !== "fanout-kept") throw new Error("not kept");
		expect(removed.result.removed).toEqual(["openai/gpt-5"]);
		expect(hosts.map(h => h.instanceId)).toEqual([keep]);
	});
});
