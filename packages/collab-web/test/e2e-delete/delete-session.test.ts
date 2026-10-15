import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GuestClient } from "../../src/lib/client";
import type { CompanionHost } from "../../src/lib/companion";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { stubModelsYml } from "../../scripts/e2e-personal-stub";
import { SCENARIO_TIMEOUT_MS, describeE2e } from "../e2e-personal/support";

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${args.join(" ")}: ${err}`);
	return out.trim();
}

const exists = async (target: string): Promise<boolean> => (await fs.lstat(target).catch(() => null)) !== null;

/**
 * Deleting sessions, end to end: the real companion, real omp sessions in tmux (one started by the companion in a
 * worktree, one in the repository, one started by hand in a terminal) and a scripted model, in a temp home. The device is
 * the app's own `CompanionClient`. Run with `bun run e2e:delete`.
 */
describeE2e("deleting sessions", () => {
	let h: PersonalHarness;
	let repo: string;
	let sessions: string;
	let trash: string;

	/** Every transcript under the sessions folder whose text holds `marker`. */
	const transcripts = async (marker: string): Promise<string[]> => {
		const found: string[] = [];
		for await (const file of new Bun.Glob("**/*.jsonl").scan(sessions)) {
			const full = path.join(sessions, file);
			if ((await Bun.file(full).text()).includes(marker)) found.push(full);
		}
		return found;
	};

	/** Start a session through the companion and have a scripted turn with it, so omp has written its transcript. */
	const startWithTurn = async (
		folder: string,
		marker: string,
		options: { worktree?: { branch: string } } = {},
	): Promise<{ host: CompanionHost; guest: GuestClient }> => {
		const instanceId = await h.client.startSession(folder, options);
		const host = await until(
			`the host row of ${marker}`,
			() => h.client.getSnapshot().hosts.find(candidate => candidate.instanceId === instanceId),
			{ timeoutMs: 120_000 },
		);
		const guest = await h.openSession(host);
		h.stub.enqueue(
			{ text: `Reply to ${marker}.` },
			request => request.transcript.includes(marker) && !request.lastUser.includes("title-request"),
		);
		const after = h.stub.requests.at(-1)?.n ?? 0;
		guest.sendPrompt(`${marker} say hello`);
		await h.stub.waitForRequest(request => request.transcript.includes(marker), { after });
		await h.settle(guest);
		await until(`omp to write ${marker}`, async () => (await transcripts(`Reply to ${marker}.`)).length > 0, {
			timeoutMs: 30_000,
		});
		return { host, guest };
	};

	/** The omp processes the companion lists, by session id. */
	const listed = (sessionId: string): boolean =>
		[...h.client.getSnapshot().hosts].some(host => host.sessionId === sessionId);

	beforeAll(async () => {
		h = await PersonalHarness.start({
			defaultConfigYaml: "modelRoles:\n  default: stub/stub-model\nstartup:\n  setupWizard: false",
		});
		await Bun.write(path.join(h.configDir, "agent", "models.yml"), stubModelsYml(h.stub));
		sessions = path.join(h.configDir, "agent", "sessions");
		trash = path.join(h.configDir, "agent", "collab-trash");
		repo = path.join(h.home, "proj");
		await fs.mkdir(repo);
		await run(repo, "git", "init", "-q", "-b", "main");
		for (const [key, value] of [
			["user.name", "t"],
			["user.email", "t@t"],
			["commit.gpgsign", "false"],
		] as const)
			await run(repo, "git", "config", key, value);
		await Bun.write(path.join(repo, "README.md"), "one\n");
		await run(repo, "git", "add", ".");
		await run(repo, "git", "commit", "-q", "-m", "init");
		await until("the companion to advertise deleting sessions", () => h.client.getSnapshot().canDeleteSessions, {
			timeoutMs: 60_000,
		});
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	it(
		"ends a running session, moves it to the trash, hides it everywhere and brings it back with Undo",
		async () => {
			const { host } = await startWithTurn(repo, "DEL-RUN");
			const sessionId = host.sessionId;
			const [file] = await transcripts("Reply to DEL-RUN.");
			expect(file).toBeDefined();
			const folder = file!.slice(0, -".jsonl".length);
			expect(await h.client.requestSessions().then(rows => rows.some(row => row.sessionId === sessionId))).toBe(
				true,
			);

			expect(await h.client.planSessionDelete([sessionId, "no-such-session"])).toEqual([
				{ sessionId, running: true },
				{ sessionId: "no-such-session", refused: expect.stringContaining("not found") },
			]);
			const [result] = await h.client.deleteSessions([sessionId]);
			if (result?.status !== "deleted") throw new Error(`not deleted: ${JSON.stringify(result)}`);

			// Ended, and its files are in the trash instead of where omp keeps them.
			await until("the session to leave the listing", () => !listed(sessionId), { timeoutMs: 30_000 });
			expect(await exists(file!)).toBe(false);
			expect(await exists(folder)).toBe(false);
			expect(await Bun.file(path.join(trash, result.trashId, "transcript.jsonl")).text()).toContain("DEL-RUN");
			expect((await fs.stat(trash)).mode & 0o777).toBe(0o700);
			// Gone from All sessions and from searching the history.
			expect(await h.client.requestSessions().then(rows => rows.some(row => row.sessionId === sessionId))).toBe(
				false,
			);
			expect((await h.client.searchSessions("DEL-RUN")).results).toEqual([]);

			// Undo.
			expect(await h.client.restoreSession(result.trashId)).toBe(sessionId);
			expect(await exists(file!)).toBe(true);
			expect(await exists(path.join(trash, result.trashId))).toBe(false);
			expect(await h.client.requestSessions().then(rows => rows.some(row => row.sessionId === sessionId))).toBe(
				true,
			);
			expect((await h.client.searchSessions("DEL-RUN")).results.length).toBeGreaterThan(0);
			// A second Undo has nothing to restore.
			await expect(h.client.restoreSession(result.trashId)).rejects.toThrow(/no longer in the trash/);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"removes the worktree it made when asked and keeps one with changes, with the reason",
		async () => {
			const { host } = await startWithTurn(repo, "DEL-TREE", { worktree: { branch: "del-tree" } });
			const sessionId = host.sessionId;
			// macOS reaches the temp folder through a link (/var is /private/var): compare real paths.
			const tree = await fs.realpath(host.cwd);
			expect(tree).toStartWith(await fs.realpath(path.join(h.configDir, "worktrees")));
			const [plan] = await h.client.planSessionDelete([sessionId]);
			expect(plan).toMatchObject({ sessionId, running: true });
			expect(await fs.realpath(plan!.worktree!)).toBe(tree);

			// With uncommitted changes the worktree stays; the session is deleted all the same.
			await Bun.write(path.join(tree, "README.md"), "changed\n");
			const [kept] = await h.client.deleteSessions([sessionId], { removeWorktree: true });
			expect(kept).toMatchObject({ status: "worktreeKept", reason: "The worktree has uncommitted changes." });
			expect(await Bun.file(path.join(tree, "README.md")).text()).toBe("changed\n");
			expect(await transcripts("Reply to DEL-TREE.")).toEqual([]);

			// Undo brings the session back; with the change gone, the worktree is removed with the session.
			if (kept?.status !== "worktreeKept") throw new Error("not kept");
			expect(await h.client.restoreSession(kept.trashId)).toBe(sessionId);
			await run(tree, "git", "checkout", "--", "README.md");
			const [gone] = await h.client.deleteSessions([sessionId], { removeWorktree: true });
			expect(gone).toMatchObject({ status: "deleted", worktree: "removed" });
			expect(await exists(tree)).toBe(false);
			expect(await run(repo, "git", "branch", "--list", "del-tree")).toContain("del-tree");
			expect(await run(repo, "git", "worktree", "list")).not.toContain("del-tree");
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"refuses a session started by hand in a terminal, and leaves it running",
		async () => {
			h.stub.enqueue(
				{ text: "Reply to DEL-HAND." },
				request => request.transcript.includes("DEL-HAND") && !request.lastUser.includes("title-request"),
			);
			// A terminal's omp: in a tmux session the companion did not make.
			const script = path.join(h.binDir, "by-hand.sh");
			const env = PersonalHarness.envFor(h.home, h.binDir);
			await Bun.write(
				script,
				`#!/bin/sh\n${Object.entries(env)
					.map(([key, value]) => `export ${key}='${value}'`)
					.join("\n")}\ncd '${repo}'\nexec omp 'DEL-HAND say hello'\n`,
			);
			await fs.chmod(script, 0o755);
			expect((await h.tmux("new-session", "-d", "-s", "by-hand", script)).code).toBe(0);
			await until(
				"the terminal's omp to write its transcript",
				async () => (await transcripts("Reply to DEL-HAND.")).length > 0,
				{
					timeoutMs: 120_000,
				},
			);
			const [file] = await transcripts("Reply to DEL-HAND.");
			const sessionId = path.basename(file!, ".jsonl").split("_").slice(1).join("_");
			await until(
				"the companion to list it",
				async () =>
					(await h.client.requestSessions()).some(row => row.sessionId === sessionId && row.live !== undefined),
				{
					timeoutMs: 60_000,
				},
			);

			const reason = "It is running in a terminal. End it there first.";
			expect(await h.client.planSessionDelete([sessionId])).toEqual([{ sessionId, refused: reason }]);
			expect(await h.client.deleteSessions([sessionId])).toEqual([{ sessionId, status: "refused", reason }]);
			expect(await exists(file!)).toBe(true);
			expect((await h.tmux("has-session", "-t", "by-hand")).code).toBe(0);
			await h.tmux("kill-session", "-t", "by-hand");
		},
		SCENARIO_TIMEOUT_MS,
	);
});
