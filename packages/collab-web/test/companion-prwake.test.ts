import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PrApi } from "@oh-my-pi/pi-wire/pr-watch";
import { createPrWake, PR_WAKE_IDLE_MS, PR_WAKE_SESSION_STALE_MS, type PrWakeAlert } from "../scripts/companion-prwake";

let dir: string;
let now: number;
let merged = false;
let calls = 0;

const api: PrApi = async endpoint => {
	calls++;
	if (/\/pulls\/7$/.test(endpoint))
		return {
			status: 200,
			body: {
				state: merged ? "closed" : "open",
				merged,
				mergeable: true,
				title: "Add widgets",
				html_url: "https://github.com/acme/app/pull/7",
				head: { sha: "aaa" },
				base: { ref: "main" },
			},
		};
	if (/check-runs/.test(endpoint)) return { status: 200, body: { check_runs: [] } };
	if (/\/status/.test(endpoint)) return { status: 200, body: { statuses: [] } };
	if (/branches/.test(endpoint)) return { status: 200, body: {} };
	return { status: 200, body: [] };
};

async function publish(sessionId: string, prs: { repo: string; number: number }[], age = 0): Promise<void> {
	const file = path.join(dir, "watches", `${sessionId}.json`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(
		file,
		JSON.stringify({
			sessionId,
			cwd: "/tmp",
			self: "me",
			updatedAt: now,
			prs: prs.map(pr => ({ ...pr, since: new Date(now).toISOString() })),
		}),
	);
	const mtime = new Date(now - age);
	await fs.utimes(file, mtime, mtime);
}

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-wake-"));
	now = Date.now();
	merged = false;
	calls = 0;
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function wake(alerts: PrWakeAlert[] = [], canRead = true): { tick(): Promise<void> } {
	return createPrWake({
		dir,
		now: () => now,
		canRead: () => canRead,
		api: () => api,
		alert: alert => alerts.push(alert),
		onError: err => {
			throw err;
		},
	});
}

describe("createPrWake", () => {
	it("leaves each session's watched pull request in its inbox and a heartbeat", async () => {
		await publish("s1", [{ repo: "acme/app", number: 7 }]);
		await wake().tick();
		const files = await fs.readdir(path.join(dir, "inbox", "s1"));
		expect(files).toHaveLength(1);
		const reading = JSON.parse(await Bun.file(path.join(dir, "inbox", "s1", files[0]!)).text()) as {
			key: string;
			snapshot: { title: string; headSha: string };
		};
		expect(reading).toMatchObject({ key: "acme/app#7", snapshot: { title: "Add widgets", headSha: "aaa" } });
		const beat = JSON.parse(await Bun.file(path.join(dir, "companion.json")).text()) as { at: number };
		expect(beat.at).toBe(now);
	});

	it("writes no heartbeat when gh cannot read, so sessions poll themselves", async () => {
		await publish("s1", [{ repo: "acme/app", number: 7 }]);
		await wake([], false).tick();
		expect(calls).toBe(0);
		expect(await Bun.file(path.join(dir, "companion.json")).exists()).toBe(false);
	});

	it("polls on a clock per pull request, and skips sessions that stopped refreshing their watches", async () => {
		await publish("s1", [{ repo: "acme/app", number: 7 }]);
		await publish("gone", [{ repo: "acme/app", number: 7 }], PR_WAKE_SESSION_STALE_MS + 1_000);
		const poller = wake();
		await poller.tick();
		const first = calls;
		expect(await fs.readdir(path.join(dir, "inbox"))).toEqual(["s1"]);
		await poller.tick();
		expect(calls).toBe(first);
		now += PR_WAKE_IDLE_MS;
		await poller.tick();
		expect(calls).toBeGreaterThan(first);
	});

	it("pushes when a watched pull request merges", async () => {
		await publish("s1", [{ repo: "acme/app", number: 7 }]);
		const alerts: PrWakeAlert[] = [];
		const poller = wake(alerts);
		await poller.tick();
		expect(alerts).toEqual([]);
		merged = true;
		now += PR_WAKE_IDLE_MS;
		await poller.tick();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ body: "Merged", url: "https://github.com/acme/app/pull/7" });
		now += PR_WAKE_IDLE_MS;
		await poller.tick();
		expect(alerts).toHaveLength(1);
	});
});
