import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFileSessions, repoRelativeFocus } from "../scripts/companion-file-sessions";

let tmp: string;
let repo: string;
let sessionsDir: string;

const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (id: string, isError = false) => ({
	type: "message",
	message: { role: "toolResult", toolCallId: id, isError },
});

let seq = 0;
/** One session file in `sessionsDir` whose header says it ran in `cwd`. */
async function session(id: string, cwd: string, entries: unknown[], title = id): Promise<void> {
	const header = { type: "session", version: 3, id, timestamp: "2026-10-01T10:00:00.000Z", cwd, title };
	const dir = path.join(sessionsDir, "folder");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `2026-10-01T10-00-00-000Z_${id}.jsonl`);
	await fs.writeFile(file, [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
	// Later sessions are newer.
	const at = new Date(Date.UTC(2026, 9, 1, 10, 0, ++seq));
	await fs.utimes(file, at, at);
}

beforeAll(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "file-sessions-")));
	repo = path.join(tmp, "repo");
	sessionsDir = path.join(tmp, "sessions");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await fs.writeFile(path.join(repo, "src/app.ts"), "x");
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("findFileSessions", () => {
	it("finds sessions with a successful edit or write on the file, newest first, and ignores the rest", async () => {
		const target = path.join(repo, "src/app.ts");
		await session("old-hashline", repo, [call("a", "edit", { input: `[${target}#1A2B]\nPUT >1:\n+x` }), result("a")]);
		await session("failed-edit", repo, [call("b", "edit", { path: target, edits: [] }), result("b", true)]);
		await session("wrote", repo, [call("c", "write", { path: "src/app.ts", content: "y" }), result("c")]);
		await session("other-file", repo, [call("d", "edit", { path: path.join(repo, "src/other.ts") }), result("d")]);
		await session("only-read", repo, [call("e", "read", { path: target }), result("e")]);
		await session("elsewhere", tmp, [call("f", "write", { path: target, content: "z" }), result("f")]);
		await session("sub-cwd", path.join(repo, "src"), [
			call("g", "write", { path: "app.ts", content: "z" }),
			result("g"),
		]);
		await session("apply-patch", repo, [
			call("h", "apply_patch", { input: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-x\n+y\n*** End Patch" }),
			result("h"),
		]);

		const found = await findFileSessions({ sessionsDir, cwd: repo, path: "src/app.ts" });
		// "elsewhere" ran outside the repository, so even an absolute path in its calls does not count.
		expect(found.map(s => s.sessionId)).toEqual(["apply-patch", "sub-cwd", "wrote", "old-hashline"]);
		expect(found[0]).toMatchObject({
			folder: repo,
			title: "apply-patch",
			startedAt: Date.parse("2026-10-01T10:00:00.000Z"),
		});
	});

	it("accepts an absolute path and rejects one outside the repository", async () => {
		const absolute = await findFileSessions({ sessionsDir, cwd: repo, path: path.join(repo, "src/app.ts") });
		expect(absolute.length).toBe(4);
		await expect(findFileSessions({ sessionsDir, cwd: repo, path: path.join(tmp, "x.ts") })).rejects.toThrow(
			"outside the repository",
		);
		await expect(findFileSessions({ sessionsDir, cwd: repo, path: repo })).rejects.toThrow("not a file");
	});
});

describe("findFileSessions with vendor agent sessions", () => {
	it("scans the agents' transcripts beside omp's sessions", async () => {
		const agentDir = path.join(tmp, "two", "agent");
		const ompDir = path.join(agentDir, "sessions", "folder");
		const foreignDir = path.join(agentDir, "collab-foreign", "sessions");
		const project = path.join(tmp, "two", "project");
		await fs.mkdir(ompDir, { recursive: true });
		await fs.mkdir(foreignDir, { recursive: true });
		await fs.mkdir(project, { recursive: true });
		const write = async (file: string, id: string, entries: unknown[], second: number) => {
			const header = { type: "session", version: 3, id, timestamp: "2026-10-01T10:00:00.000Z", cwd: project };
			await fs.writeFile(file, [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
			const at = new Date(Date.UTC(2026, 9, 2, 10, 0, second));
			await fs.utimes(file, at, at);
		};
		const edit = [call("a", "edit", { path: "main.ts" }), result("a")];
		await write(path.join(ompDir, "2026-10-01T10-00-00-000Z_omp-one.jsonl"), "omp-one", edit, 1);
		await write(path.join(foreignDir, "claude-0123456789abcdef.jsonl"), "claude-0123456789abcdef", edit, 2);
		await write(path.join(foreignDir, "codex-fedcba9876543210.jsonl"), "codex-fedcba9876543210", [], 3);

		const found = await findFileSessions({
			sessionsDir: path.join(agentDir, "sessions"),
			cwd: project,
			path: "main.ts",
		});
		expect(found.map(s => s.sessionId)).toEqual(["claude-0123456789abcdef", "omp-one"]);
	});
});

describe("repoRelativeFocus", () => {
	it("turns absolute paths into repository-relative ones and leaves others for validation", async () => {
		expect(await repoRelativeFocus(repo, { kind: "file", path: path.join(repo, "src/app.ts") })).toEqual({
			kind: "file",
			path: "src/app.ts",
		});
		expect(await repoRelativeFocus(repo, { kind: "file", path: path.join(repo, "src") })).toEqual({
			kind: "dir",
			path: "src",
		});
		expect(await repoRelativeFocus(repo, { kind: "file", path: "src/app.ts" })).toEqual({
			kind: "file",
			path: "src/app.ts",
		});
		expect(await repoRelativeFocus(repo, null)).toBeNull();
	});
});
