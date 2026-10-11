import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanionHost } from "../src/lib/companion";
import { createMockForeign } from "../scripts/mock-foreign";
import { createMockStart } from "../scripts/mock-start";

let dir: string;
let repo: string;
const hosts: CompanionHost[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore" });
	const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(err);
}

beforeAll(async () => {
	dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mock-start-")));
	repo = path.join(dir, "repo");
	await fs.mkdir(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "config", "user.name", "mock");
	await git(repo, "config", "user.email", "mock@example.com");
	await git(repo, "config", "commit.gpgsign", "false");
	await Bun.write(path.join(repo, "README.md"), "x\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-q", "-m", "init");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("mock start", () => {
	const mock = () =>
		createMockStart({
			dir,
			foreign: createMockForeign({ hosts }),
			hosts,
			baseFolders: async () => [{ cwd: repo, lastActive: 1, sessions: [] }],
			onChange: () => {},
		});

	it("starts a session without a project in a real scratch folder named after the prompt, and lists the folder", async () => {
		const start = mock();
		const reply = await start.answer({
			t: "start",
			reqId: 1,
			cwd: "",
			scratch: { hint: "convert pngs" },
			prompt: "convert pngs",
		});
		if (reply.t !== "started") throw new Error("not started");
		const host = hosts.find(h => h.instanceId === reply.instanceId);
		expect(host?.cwd).toMatch(new RegExp(`/config/scratch/\\d{4}-\\d{2}-\\d{2}-convert-pngs-[0-9a-f]{6}$`));
		expect((await fs.stat(host?.cwd ?? "")).isDirectory()).toBe(true);
		const folders = await start.answer({ t: "folders", reqId: 2 });
		if (folders.t !== "folders") throw new Error("no folders");
		expect(folders.folders.map(f => f.cwd)).toEqual([host?.cwd ?? "", repo]);
	});

	it("gives each worktree start its own worktree and branch, started at the same time too", async () => {
		const start = mock();
		const replies = await Promise.all(
			[1, 2, 3].map(reqId => start.answer({ t: "start", reqId, cwd: repo, worktree: {} })),
		);
		const cwds = replies.map(reply => {
			if (reply.t !== "started") throw new Error("not started");
			return hosts.find(h => h.instanceId === reply.instanceId)?.cwd;
		});
		expect(new Set(cwds).size).toBe(3);
		for (const cwd of cwds) expect(cwd?.startsWith(path.join(dir, "worktrees"))).toBe(true);
	});

	it("refuses a prompt that cannot be one", async () => {
		await expect(mock().answer({ t: "start", reqId: 1, cwd: repo, prompt: "a\0b" })).rejects.toThrow(
			"invalid prompt",
		);
	});
});
