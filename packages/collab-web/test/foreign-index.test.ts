import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ForeignIndexRow,
	foreignIndexPath,
	readForeignIndex,
	readForeignIndexStrict,
	updateForeignIndex,
	upsertForeignRow,
} from "../scripts/foreign/foreign-index";

let dir = "";

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "foreign-index-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const row = (overrides: Partial<ForeignIndexRow> = {}): ForeignIndexRow => ({
	agent: "claude",
	nativeId: null,
	cwd: "/work/app",
	title: null,
	model: null,
	createdAt: 1,
	lastActive: 1,
	permission: "supervised",
	worktree: false,
	adapterVersion: null,
	...overrides,
});

describe("foreign index", () => {
	it("is empty when the file is missing or corrupt", async () => {
		expect(await readForeignIndex(dir)).toEqual({ version: 1, sessions: {} });
		await fs.mkdir(path.dirname(foreignIndexPath(dir)), { recursive: true });
		await fs.writeFile(foreignIndexPath(dir), "{not json");
		expect(await readForeignIndex(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("writes a row owner-only and reads it back", async () => {
		await upsertForeignRow(dir, "claude-aaaa", row({ title: "Fix bug", costUsd: 0.5 }));
		const index = await readForeignIndex(dir);
		expect(index.sessions["claude-aaaa"]).toEqual(row({ title: "Fix bug", costUsd: 0.5 }));
		const stat = await fs.stat(foreignIndexPath(dir));
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("patches an existing row and refuses a patch for a row that does not exist", async () => {
		await upsertForeignRow(dir, "claude-aaaa", row());
		await upsertForeignRow(dir, "claude-aaaa", { nativeId: "native-1", lastActive: 9 });
		expect((await readForeignIndex(dir)).sessions["claude-aaaa"]).toMatchObject({
			agent: "claude",
			nativeId: "native-1",
			lastActive: 9,
		});
		await expect(upsertForeignRow(dir, "claude-bbbb", { lastActive: 2 })).rejects.toThrow("incomplete index row");
	});

	it("keeps every host's row when many write at once", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `codex-${String(i).padStart(4, "0")}`);
		await Promise.all(ids.map((id, i) => upsertForeignRow(dir, id, row({ agent: "codex", createdAt: i }))));
		const sessions = (await readForeignIndex(dir)).sessions;
		expect(Object.keys(sessions).sort()).toEqual(ids);
		expect(await fs.readdir(path.dirname(foreignIndexPath(dir)))).toEqual(["collab-foreign.json"]);
	});

	it("drops a row it cannot read and keeps the others", async () => {
		await fs.mkdir(path.dirname(foreignIndexPath(dir)), { recursive: true });
		await fs.writeFile(
			foreignIndexPath(dir),
			JSON.stringify({
				version: 1,
				sessions: {
					good: row({ fanout: { group: "g", model: "m", agent: { id: "claude", name: "Claude Code" } } }),
					bad: { agent: 3 },
				},
			}),
		);
		const sessions = (await readForeignIndex(dir)).sessions;
		expect(Object.keys(sessions)).toEqual(["good"]);
		expect(sessions.good?.fanout).toEqual({ group: "g", model: "m", agent: { id: "claude", name: "Claude Code" } });
	});

	it("deletes a row through update", async () => {
		await upsertForeignRow(dir, "claude-aaaa", row());
		await updateForeignIndex(dir, sessions => {
			delete sessions["claude-aaaa"];
		});
		expect((await readForeignIndex(dir)).sessions).toEqual({});
	});

	it("breaks a lock a dead process left behind", async () => {
		const lock = `${foreignIndexPath(dir)}.lock`;
		await fs.mkdir(lock, { recursive: true });
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(lock, old, old);
		await upsertForeignRow(dir, "claude-aaaa", row());
		expect(Object.keys((await readForeignIndex(dir)).sessions)).toEqual(["claude-aaaa"]);
	});
});

describe("foreign index: strict read, lock and lost rows", () => {
	const lockOf = () => `${foreignIndexPath(dir)}.lock`;

	it("tells a missing file from a broken one", async () => {
		expect(await readForeignIndexStrict(dir)).toEqual({ version: 1, sessions: {} });
		await fs.mkdir(path.dirname(foreignIndexPath(dir)), { recursive: true });
		await fs.writeFile(foreignIndexPath(dir), "{not json");
		await expect(readForeignIndexStrict(dir)).rejects.toThrow();
		await fs.writeFile(foreignIndexPath(dir), "[]");
		await expect(readForeignIndexStrict(dir)).rejects.toThrow("not an index");
		await fs.rm(foreignIndexPath(dir));
		await fs.mkdir(foreignIndexPath(dir));
		await expect(readForeignIndexStrict(dir)).rejects.toThrow();
		expect(await readForeignIndex(dir)).toEqual({ version: 1, sessions: {} });
	});

	it("breaks a lock whose owner process is dead", async () => {
		await fs.mkdir(lockOf(), { recursive: true });
		const gone = Bun.spawn(["true"]);
		await gone.exited;
		await fs.writeFile(path.join(lockOf(), "owner"), JSON.stringify({ pid: gone.pid, token: "dead" }));
		await upsertForeignRow(dir, "claude-aaaa", row());
		expect(Object.keys((await readForeignIndex(dir)).sessions)).toEqual(["claude-aaaa"]);
	});

	it("does not break a lock whose owner is alive, however old it is", async () => {
		await fs.mkdir(lockOf(), { recursive: true });
		await fs.writeFile(path.join(lockOf(), "owner"), JSON.stringify({ pid: process.pid, token: "alive" }));
		const old = new Date(Date.now() - 60_000);
		await fs.utimes(lockOf(), old, old);
		const waiting = upsertForeignRow(dir, "claude-aaaa", row());
		// A real wait on purpose: the claim is that the writer is still blocked after the lock's stale age, and
		// no fake clock reaches the filesystem's mtime or the writer's own deadline loop.
		const outcome = await Promise.race([waiting.then(() => "wrote"), Bun.sleep(300).then(() => "waiting")]);
		expect(outcome).toBe("waiting");
		await fs.rm(lockOf(), { recursive: true });
		await waiting;
		expect(Object.keys((await readForeignIndex(dir)).sessions)).toEqual(["claude-aaaa"]);
	});

	it("keeps every row when many writers race", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `claude-${i.toString().padStart(4, "0")}`);
		await Promise.all(ids.map(id => upsertForeignRow(dir, id, row())));
		expect(Object.keys((await readForeignIndex(dir)).sessions).sort()).toEqual(ids);
		await expect(fs.stat(lockOf())).rejects.toThrow();
	});

	it("puts a lost row back whole when an update finds it gone", async () => {
		const whole = row({ title: "Mine", worktree: true, fanout: { group: "g", model: "m" } });
		await upsertForeignRow(dir, "claude-aaaa", whole, whole);
		await fs.rm(foreignIndexPath(dir));
		await upsertForeignRow(dir, "claude-aaaa", { lastActive: 99 }, whole);
		expect((await readForeignIndex(dir)).sessions["claude-aaaa"]).toEqual({ ...whole, lastActive: 99 });
		await expect(upsertForeignRow(dir, "claude-bbbb", { lastActive: 1 })).rejects.toThrow("incomplete index row");
	});

	it("keeps a damaged index aside and starts again instead of failing", async () => {
		await fs.mkdir(path.dirname(foreignIndexPath(dir)), { recursive: true });
		await fs.writeFile(foreignIndexPath(dir), "{not json");
		await upsertForeignRow(dir, "claude-aaaa", row());
		expect(Object.keys((await readForeignIndexStrict(dir)).sessions)).toEqual(["claude-aaaa"]);
		const aside = (await fs.readdir(path.dirname(foreignIndexPath(dir)))).filter(name => name.includes(".damaged-"));
		expect(aside).toHaveLength(1);
	});
});
