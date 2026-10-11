import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SettleCleanupResult } from "../src/lib/companion";
import { createWorktree } from "../scripts/companion-gitflow";
import {
	companionWorktree,
	createSettleCleanup,
	loadSettleState,
	parseSettleState,
	type SettleCleanup,
	type SettleState,
	saveSettleState,
} from "../scripts/companion-settle";
import { createSessionOrg, loadOrgFile, type OrgFile, saveOrgFile } from "../scripts/companion-sessionorg";
import { type GitFlowFile, parseGitFlowFile, setupHash } from "../scripts/companion-worktrees";
import { applyOrg, emptyOrg } from "../src/lib/session-org";

let tmp: string;
let repo: string;
let trees: string;

async function run(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(err);
	return out.trim();
}

async function initRepo(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await run(dir, "git", "init", "-q", "-b", "main");
	for (const [key, value] of [
		["user.name", "t"],
		["user.email", "t@t"],
		["commit.gpgsign", "false"],
	] as const) {
		await run(dir, "git", "config", key, value);
	}
	await fs.writeFile(path.join(dir, "a.txt"), "one\n");
	await run(dir, "git", "add", ".");
	await run(dir, "git", "commit", "-q", "-m", "init");
}

beforeEach(async () => {
	tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-settle-")));
	repo = path.join(tmp, "repo");
	trees = path.join(tmp, "trees");
	await initRepo(repo);
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

const flowWith = (settleScript: string, trustedSettles: Record<string, string> = {}): GitFlowFile => {
	const file = parseGitFlowFile(null);
	return { ...file, settings: { ...file.settings, settleScript }, trustedSettles };
};

interface Harness {
	cleanup: SettleCleanup;
	saved: SettleState[];
	unapproved: string[];
	errors: unknown[];
	/** How many times the listing of open sessions was asked for. */
	listings: number;
	flow: { current: GitFlowFile };
	/** The sessions open now, by session id. */
	where: Record<string, { cwd: string; sandboxed: boolean }>;
}

const emptyState = (): SettleState => ({ results: [], sessions: {}, sandboxed: [] });

function harness(flow: GitFlowFile, over: { initial?: SettleState; timeoutMs?: number } = {}): Harness {
	const h: Harness = {
		cleanup: undefined as never,
		saved: [],
		unapproved: [],
		errors: [],
		listings: 0,
		flow: { current: flow },
		where: {},
	};
	h.cleanup = createSettleCleanup({
		initial: over.initial ?? emptyState(),
		save: async state => {
			h.saved.push(state);
		},
		flow: () => h.flow.current,
		dirs: () => [trees],
		listing: async () => {
			h.listings++;
			return Object.entries(h.where).map(([sessionId, session]) => ({ sessionId, ...session }));
		},
		onUnapproved: root => h.unapproved.push(root),
		onError: err => h.errors.push(err),
		timeoutMs: over.timeoutMs,
	});
	return h;
}

const settled = (...ids: string[]) => ids.map((sessionId, i) => ({ sessionId, at: 1_000 + i }));

describe("which folders are cleaned", () => {
	it("recognises only linked worktrees under the worktree folders", async () => {
		const tree = await createWorktree(repo, trees, "wt-a");
		expect(await companionWorktree(tree.path, [trees])).toEqual({ root: repo, path: tree.path, branch: "wt-a" });
		// From a folder inside the tree, the tree is what is cleaned.
		await fs.mkdir(path.join(tree.path, "sub"));
		expect((await companionWorktree(path.join(tree.path, "sub"), [trees]))?.path).toBe(tree.path);

		// The main checkout, a plain folder, a repository elsewhere, and a worktree outside the folders.
		const plain = path.join(tmp, "plain");
		await fs.mkdir(plain);
		const other = path.join(tmp, "other");
		await initRepo(other);
		const outside = path.join(tmp, "outside-trees", "other", "wt");
		await fs.mkdir(path.dirname(outside), { recursive: true });
		await run(other, "git", "worktree", "add", "-q", "-b", "wt-out", outside);
		for (const cwd of [repo, plain, other, outside, path.join(tmp, "missing")])
			expect(await companionWorktree(cwd, [trees])).toBeNull();
	});
});

describe("settle cleanup", () => {
	it("runs the command in the session's worktree and keeps the result", async () => {
		const tree = await createWorktree(repo, trees, "wt-run");
		const h = harness(flowWith("echo cleaned > cleaned.txt; echo done-output"));
		h.where.s1 = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("s1"));

		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).text()).toBe("cleaned\n");
		expect(await Bun.file(path.join(repo, "cleaned.txt")).exists()).toBe(false);
		const [result] = await h.cleanup.results();
		expect(result).toMatchObject({
			path: tree.path,
			branch: "wt-run",
			sessionId: "s1",
			source: "settings",
			status: "ok",
			code: 0,
			output: "done-output",
		});
		expect(h.errors).toEqual([]);
	});

	it("skips the main checkout, plain folders, unknown sessions and an empty command", async () => {
		const tree = await createWorktree(repo, trees, "wt-skip");
		const plain = path.join(tmp, "plain");
		await fs.mkdir(plain);
		const h = harness(flowWith("touch cleaned.txt"));
		h.where.main = { cwd: repo, sandboxed: false };
		h.where.plain = { cwd: plain, sandboxed: false };
		h.where.tree = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("main", "plain", "gone"));
		expect(await Bun.file(path.join(repo, "cleaned.txt")).exists()).toBe(false);
		expect(await Bun.file(path.join(plain, "cleaned.txt")).exists()).toBe(false);

		h.flow.current = flowWith("");
		await h.cleanup.run(settled("tree"));
		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(false);
		expect(await h.cleanup.results()).toEqual([]);
		expect(h.errors).toEqual([]);
	});

	it("runs while a dev server is still running in the folder", async () => {
		const tree = await createWorktree(repo, trees, "wt-dev");
		const server = Bun.spawn(["sleep", "30"], { cwd: tree.path, stdout: "ignore", stderr: "ignore" });
		try {
			const h = harness(flowWith("touch cleaned.txt"));
			h.where.s = { cwd: tree.path, sandboxed: false };
			await h.cleanup.run(settled("s"));
			expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(true);
		} finally {
			server.kill();
		}
	});

	it("records failures and timeouts as the latest result of the worktree", async () => {
		const tree = await createWorktree(repo, trees, "wt-fail");
		const h = harness(flowWith("echo nope >&2; exit 2"), { timeoutMs: 300 });
		h.where.s = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("s"));
		expect((await h.cleanup.results())[0]).toMatchObject({ status: "failed", code: 2, output: "nope" });

		h.flow.current = flowWith("sleep 30");
		await h.cleanup.run(settled("s"));
		const results = await h.cleanup.results();
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ status: "timeout", code: null });

		h.flow.current = flowWith("echo fine");
		await h.cleanup.run(settled("s"));
		expect((await h.cleanup.results())[0]).toMatchObject({ status: "ok", output: "fine" });
		expect(h.errors).toEqual([]);
	});

	it("drops the result of a worktree that is gone, and survives a restart", async () => {
		const tree = await createWorktree(repo, trees, "wt-gone");
		const h = harness(flowWith("echo hi"));
		h.where.s = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("s"));

		const file = path.join(tmp, "settle.json");
		await saveSettleState(file, h.saved.at(-1) as SettleState);
		const restored = harness(flowWith("echo hi"), { initial: await loadSettleState(file) });
		expect(await restored.cleanup.results()).toHaveLength(1);
		await fs.rm(tree.path, { recursive: true });
		expect(await restored.cleanup.results()).toEqual([]);
		expect(
			parseSettleState({
				results: [{ path: 1 }],
				sessions: { ok: "relative", "../x": "/abs" },
				sandboxed: ["relative", 3],
			}),
		).toEqual(emptyState());
		expect(await loadSettleState(path.join(tmp, "missing.json"))).toEqual(emptyState());
	});

	it("runs once for sessions that settle together in one worktree", async () => {
		const tree = await createWorktree(repo, trees, "wt-twin");
		const h = harness(flowWith("echo x >> runs.log; sleep 0.3"));
		h.where.a = { cwd: tree.path, sandboxed: false };
		h.where.b = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("a", "b"));
		expect((await Bun.file(path.join(tree.path, "runs.log")).text()).trim().split("\n")).toHaveLength(1);
	});
});

describe("repository settle script", () => {
	it("runs once approved, is reported while not, and never runs for a sandboxed session", async () => {
		const script = "echo project-script > project.txt\n";
		await fs.mkdir(path.join(repo, ".omp"));
		await fs.writeFile(path.join(repo, ".omp", "worktree-settle"), script);
		await run(repo, "git", "add", ".");
		await run(repo, "git", "commit", "-q", "-m", "settle script");
		const tree = await createWorktree(repo, trees, "wt-project");

		const h = harness(flowWith(""));
		h.where.s = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("s"));
		expect(h.unapproved).toEqual([repo]);
		expect(await h.cleanup.results()).toEqual([]);
		expect(await Bun.file(path.join(tree.path, "project.txt")).exists()).toBe(false);

		h.flow.current = flowWith("", { [repo]: setupHash(script) });
		await h.cleanup.run(settled("s"));
		expect(await Bun.file(path.join(tree.path, "project.txt")).text()).toBe("project-script\n");
		expect((await h.cleanup.results())[0]).toMatchObject({ source: "project", status: "ok" });

		// A sandboxed session worked here: its agent can write the file's neighbours, so nothing runs, repository script included.
		await fs.rm(path.join(tree.path, "project.txt"));
		await h.cleanup.recordSandboxed(tree.path);
		await h.cleanup.run(settled("s"));
		expect(await Bun.file(path.join(tree.path, "project.txt")).exists()).toBe(false);
		expect((await h.cleanup.results())[0]).toMatchObject({ source: "project", status: "skipped" });
	});
});

describe("sandboxed sessions", () => {
	it("never cleans a worktree a sandboxed session was started in, for good, also after a restart", async () => {
		const tree = await createWorktree(repo, trees, "wt-taint");
		const h = harness(flowWith("echo ran >> runs.log"));
		await h.cleanup.recordSession("s", tree.path);
		await h.cleanup.run(settled("s"));
		expect(await Bun.file(path.join(tree.path, "runs.log")).text()).toBe("ran\n");

		// A sandboxed session is started in the same tree (a resume or a start with that folder).
		await h.cleanup.recordSandboxed(tree.path);
		await h.cleanup.run(settled("s"));
		expect(await Bun.file(path.join(tree.path, "runs.log")).text()).toBe("ran\n");
		expect((await h.cleanup.results())[0]).toMatchObject({
			status: "skipped",
			code: null,
			output: "skipped: a sandboxed session worked here",
		});

		// Recording the plain session again does not lift it, and neither does a restart.
		await h.cleanup.recordSession("s", tree.path);
		const restarted = harness(flowWith("echo ran >> runs.log"), { initial: h.saved.at(-1) as SettleState });
		await restarted.cleanup.run(settled("s"));
		expect(await Bun.file(path.join(tree.path, "runs.log")).text()).toBe("ran\n");
		expect((await restarted.cleanup.results())[0]?.status).toBe("skipped");
	});

	it("also covers a sandboxed folder inside or above the worktree, and nothing else", async () => {
		const other = path.join(tmp, "other");
		await initRepo(other);
		const inside = await createWorktree(repo, trees, "wt-inside");
		const sibling = await createWorktree(repo, trees, "wt-sibling");
		const apart = await createWorktree(other, trees, "wt-apart");
		await fs.mkdir(path.join(inside.path, "sub"));
		const plain = path.join(tmp, "plain");
		await fs.mkdir(plain);
		const cleaned = async (tree: { path: string }) => Bun.file(path.join(tree.path, "cleaned.txt")).exists();
		const settleAll = async (h: Harness) => {
			for (const [id, tree] of [
				["i", inside],
				["s", sibling],
				["a", apart],
			] as const) {
				await h.cleanup.recordSession(id, tree.path);
				await h.cleanup.run(settled(id));
			}
		};

		// Inside the worktree: only that worktree.
		const within = harness(flowWith("touch cleaned.txt"));
		await within.cleanup.recordSandboxed(path.join(inside.path, "sub"));
		// Not near any worktree folder (the main checkout, a plain folder): nothing to remember.
		await within.cleanup.recordSandboxed(repo);
		await within.cleanup.recordSandboxed(plain);
		expect(within.saved.at(-1)?.sandboxed).toEqual([path.join(inside.path, "sub")]);
		await settleAll(within);
		expect([await cleaned(inside), await cleaned(sibling), await cleaned(apart)]).toEqual([false, true, true]);
		await Promise.all([sibling, apart].map(tree => fs.rm(path.join(tree.path, "cleaned.txt"))));

		// Above the worktrees: all of that repository's, not another repository's.
		const above = harness(flowWith("touch cleaned.txt"));
		await above.cleanup.recordSandboxed(path.dirname(inside.path));
		await settleAll(above);
		expect([await cleaned(inside), await cleaned(sibling), await cleaned(apart)]).toEqual([false, false, true]);
	});

	it("leaves a worktree alone while a listed sandboxed session works in or above it", async () => {
		const tree = await createWorktree(repo, trees, "wt-live");
		const other = await createWorktree(repo, trees, "wt-other");
		const h = harness(flowWith("touch cleaned.txt"));
		await h.cleanup.recordSession("ended", tree.path);
		await h.cleanup.recordSession("far", other.path);
		// Started outside this companion, so only the listing knows it is sandboxed.
		h.where.sandboxed = { cwd: path.join(tree.path), sandboxed: true };
		await h.cleanup.run(settled("ended", "far"));
		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(false);
		expect((await h.cleanup.results()).find(r => r.path === tree.path)).toMatchObject({ status: "skipped" });
		expect(await Bun.file(path.join(other.path, "cleaned.txt")).exists()).toBe(true);

		// The sandboxed session ended: it no longer stands in the way (a start made through this companion would still).
		delete h.where.sandboxed;
		await h.cleanup.run(settled("ended"));
		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(true);
	});

	it("records nothing when there would have been nothing to run", async () => {
		const tree = await createWorktree(repo, trees, "wt-quiet");
		const h = harness(flowWith(""));
		await h.cleanup.recordSandboxed(tree.path);
		await h.cleanup.recordSession("s", tree.path);
		await h.cleanup.run(settled("s"));
		expect(await h.cleanup.results()).toEqual([]);
	});
});

describe("which sessions are located", () => {
	it("cleans an ended session only where the companion recorded it, and an open one where it is listed", async () => {
		const tree = await createWorktree(repo, trees, "wt-where");
		const plain = path.join(tmp, "plain");
		await fs.mkdir(plain);
		const h = harness(flowWith("touch cleaned.txt"));
		// Neither recorded nor listed: nothing to go on (a session file is never consulted).
		await h.cleanup.run(settled("ended"));
		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(false);

		await h.cleanup.recordSession("ended", tree.path);
		await h.cleanup.run(settled("ended"));
		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(true);

		// A session in a folder that is not a companion worktree is not remembered at all.
		await h.cleanup.recordSession("plain", plain);
		await h.cleanup.recordSession("main", repo);
		expect(Object.keys(h.saved.at(-1)?.sessions ?? {})).toEqual(["ended"]);

		// Open sessions are found through the listing; what the companion recorded wins over what is listed.
		await fs.rm(path.join(tree.path, "cleaned.txt"));
		h.where.open = { cwd: tree.path, sandboxed: false };
		await h.cleanup.run(settled("open"));
		expect(await Bun.file(path.join(tree.path, "cleaned.txt")).exists()).toBe(true);
		const elsewhere = await createWorktree(repo, trees, "wt-elsewhere");
		h.where.ended = { cwd: elsewhere.path, sandboxed: false };
		await h.cleanup.run(settled("ended"));
		expect(await Bun.file(path.join(elsewhere.path, "cleaned.txt")).exists()).toBe(false);
	});

	it("takes one listing for a whole batch and runs a few commands at a time", async () => {
		const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
		const h = harness(
			flowWith(
				'd=$(dirname "$PWD"); touch "$d/up-$$"; ls "$d" | grep -c "^up-" >> "$d/seen.log"; sleep 0.25; rm "$d/up-$$"',
			),
		);
		for (const id of ids) {
			const tree = await createWorktree(repo, trees, `wt-${id}`);
			await h.cleanup.recordSession(id, tree.path);
		}
		await h.cleanup.run(settled(...ids));
		expect(h.listings).toBe(1);
		const seen = (await Bun.file(path.join(trees, "repo", "seen.log")).text()).trim().split("\n").map(Number);
		expect(seen).toHaveLength(8);
		expect(Math.max(...seen)).toBeLessThanOrEqual(3);
		expect(Math.max(...seen)).toBeGreaterThan(1);
		expect(h.errors).toEqual([]);

		// Nothing settled: no listing.
		await h.cleanup.run([]);
		expect(h.listings).toBe(1);
	});
});

describe("from a settle to a cleanup", () => {
	function wire(initial: OrgFile, command: string) {
		const clock = { now: 10_000 };
		const cleanup = harness(flowWith(command));
		const runs: Promise<void>[] = [];
		const saved: OrgFile[] = [];
		const org = createSessionOrg({
			now: () => clock.now,
			initial,
			save: async file => {
				saved.push(file);
			},
			readPrDone: async () => null,
			prAvailable: () => false,
			onChange: () => {},
			onSettled: sessions => {
				runs.push(cleanup.cleanup.run(sessions));
			},
			onError: err => {
				throw err;
			},
		});
		return { org, clock, cleanup, runs, saved };
	}

	it("runs once per transition, never blocks the settle, and not again after a repeat sync or restart", async () => {
		const tree = await createWorktree(repo, trees, "wt-flow");
		const log = path.join(tree.path, "runs.log");
		const w = wire({ doc: emptyOrg(), rev: 0, activity: {}, settled: {} }, "echo x >> runs.log; sleep 0.4");
		w.cleanup.where.s = { cwd: tree.path, sandboxed: false };
		const runsLog = async () =>
			(await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split("\n").length : 0;

		const settledDoc = applyOrg(emptyOrg(), "s", { type: "settle" }, 20_000);
		const started = Date.now();
		await w.org.sync(settledDoc);
		// The sync answered while the command was still running.
		expect(Date.now() - started).toBeLessThan(300);
		await Promise.all(w.runs);
		expect(await runsLog()).toBe(1);

		// The same document again, then a restart from the persisted file, then the same document once more.
		await w.org.sync(settledDoc);
		const file = path.join(tmp, "org.json");
		await saveOrgFile(file, w.saved.at(-1) as OrgFile);
		const restarted = wire(await loadOrgFile(file), "echo x >> runs.log");
		restarted.cleanup.where.s = { cwd: tree.path, sandboxed: false };
		await restarted.org.sync(settledDoc);
		await restarted.org.tick([]);
		await Promise.all([...w.runs, ...restarted.runs]);
		expect(await runsLog()).toBe(1);

		// Un-settle and settle again: a new transition.
		const undone = applyOrg(settledDoc, "s", { type: "unsettle" }, 30_000);
		await restarted.org.sync(undone);
		await restarted.org.sync(applyOrg(undone, "s", { type: "settle" }, 40_000));
		await Promise.all(restarted.runs);
		expect(await runsLog()).toBe(2);
	});
});
