/**
 * The command gate of high-stakes sessions against a real throwaway git repository and a temp agent directory
 * holding the state file the companion would publish: a covered tree may publish, an uncovered one is refused with
 * the shared refusal text, `--no-verify` is refused even when covered, and the refusal reaches the tools'
 * approval and `resolveApproval` as a tool-owned deny that no mode, grant or policy lifts.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import {
	formatStakesState,
	STAKES_REFUSAL_ASK,
	STAKES_REFUSAL_LEAD,
	STAKES_STATE_DIR,
	type StakesState,
	stakesStateKey,
} from "@oh-my-pi/pi-wire/stakes";
import { Settings } from "../src/config/settings";
import { highStakesDecision } from "../src/high-stakes/gate";
import { headTree, readCheckoutStakes, resolveCheckout } from "../src/high-stakes/state";
import type { ToolSession } from "../src/tools";
import { denyError, resolveApproval } from "../src/tools/approval";
import { BashTool } from "../src/tools/bash";
import { EvalTool } from "../src/tools/eval";
import { GithubTool } from "../src/tools/gh";
import { DebugTool } from "../src/tools/debug";

let root: string;
let agentDir: string;
let repo: string;
let other: string;

function git(cwd: string, ...args: string[]): string {
	const run = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
		},
	);
	if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
	return run.stdout.toString().trim();
}

function makeRepo(name: string): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, `${name}-`)));
	git(dir, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "one");
	return dir;
}

function commit(dir: string, text: string): void {
	fs.writeFileSync(path.join(dir, "a.txt"), text);
	git(dir, "commit", "-q", "-am", text.trim());
}

/** Publish the state file for `checkout` the way the companion does. */
function publish(checkout: string, state: Partial<StakesState> = {}): void {
	fs.mkdirSync(path.join(agentDir, STAKES_STATE_DIR), { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(checkout)),
		formatStakesState({ rev: 1, on: true, checkout, passMark: 90, by: "", at: 1, trees: [], ...state }),
	);
}

function covered(checkout: string): string[] {
	const tree = headTree(checkout);
	if (tree === null) throw new Error("no HEAD tree");
	return [tree];
}

function denied(decision: ToolApprovalDecision | undefined): string {
	if (decision === undefined || typeof decision === "string") throw new Error("expected a deny decision");
	expect(decision.policy).toBe("deny");
	expect(decision.override).toBe(true);
	expect(decision.tier).toBe("exec");
	return decision.reason ?? "";
}

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-stakes-gate-")));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	repo = makeRepo("repo");
	other = makeRepo("other");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("state reader", () => {
	it("finds the checkout from a subfolder and reads what the companion published", () => {
		fs.mkdirSync(path.join(repo, "sub"));
		expect(resolveCheckout(path.join(repo, "sub"))).toBe(repo);
		expect(readCheckoutStakes(path.join(repo, "sub"), agentDir)).toBeNull();
		publish(repo, { by: "phone", trees: ["a".repeat(40)] });
		const read = readCheckoutStakes(path.join(repo, "sub"), agentDir);
		expect(read?.checkout).toBe(repo);
		expect(read?.state.on).toBe(true);
		expect(read?.state.by).toBe("phone");
		expect(read?.state.trees).toEqual(["a".repeat(40)]);
	});

	it("reads no state outside a checkout, and a foreign file as none", () => {
		expect(resolveCheckout(root)).toBeNull();
		expect(readCheckoutStakes(root, agentDir)).toBeNull();
		fs.mkdirSync(path.join(agentDir, STAKES_STATE_DIR));
		fs.writeFileSync(path.join(agentDir, STAKES_STATE_DIR, stakesStateKey(repo)), "not a state file\n");
		expect(readCheckoutStakes(repo, agentDir)).toBeNull();
	});

	it("gives the tree of HEAD, and none before the first commit", () => {
		expect(headTree(repo)).toMatch(/^[0-9a-f]{40}$/);
		const empty = fs.realpathSync(fs.mkdtempSync(path.join(root, "empty-")));
		git(empty, "init", "-q", "-b", "main");
		expect(headTree(empty)).toBeNull();
	});
});

describe("highStakesDecision", () => {
	it("allows a push whose HEAD tree is covered", () => {
		publish(repo, { trees: covered(repo) });
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push origin main" })).toBeUndefined();
		expect(highStakesDecision({ cwd: repo, agentDir, command: "gh pr create -f" })).toBeUndefined();
	});

	it("refuses a push nothing covers yet, with the shared refusal text", () => {
		publish(repo);
		const reason = denied(highStakesDecision({ cwd: repo, agentDir, command: "git push origin main" }));
		expect(reason).toStartWith(STAKES_REFUSAL_LEAD);
		expect(reason).toEndWith(STAKES_REFUSAL_ASK);
		expect(reason).toContain("`git push`");
		expect(reason).toContain("nothing covers HEAD yet");
	});

	it("refuses once the tree moved past the covered one", () => {
		publish(repo, { trees: covered(repo) });
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
		commit(repo, "two\n");
		const reason = denied(highStakesDecision({ cwd: repo, agentDir, command: "git push" }));
		expect(reason).toStartWith(STAKES_REFUSAL_LEAD);
		expect(reason).toContain("changes since the last passed quiz are not covered");
		expect(reason).toEndWith(STAKES_REFUSAL_ASK);
	});

	it("allows a tree covered earlier again when the content comes back", () => {
		const first = covered(repo);
		commit(repo, "two\n");
		publish(repo, { trees: [...covered(repo), ...first] });
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
		commit(repo, "one\n");
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
	});

	it("names what was refused for each kind of publish", () => {
		publish(repo);
		expect(denied(highStakesDecision({ cwd: repo, agentDir, command: "gh pr merge 3" }))).toContain("`gh pr merge`");
		expect(
			denied(highStakesDecision({ cwd: repo, agentDir, command: "gh api -X PUT repos/o/r/pulls/3/merge" })),
		).toContain("gh api PUT repos/o/r/pulls/3/merge");
		expect(denied(highStakesDecision({ cwd: repo, agentDir, githubOp: "pr_create" }))).toContain(
			"creating a pull request",
		);
		expect(denied(highStakesDecision({ cwd: repo, agentDir, githubOp: "pr_push" }))).toContain("pushing a branch");
	});

	it("allows everything while the mode is off, or nothing is published", () => {
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
		publish(repo, { on: false });
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push --no-verify" })).toBeUndefined();
		fs.rmSync(path.join(agentDir, STAKES_STATE_DIR), { recursive: true });
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
	});

	it("allows a push when the published file is for another checkout", () => {
		publish(other);
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
	});

	it("allows a push outside any checkout", () => {
		publish(repo);
		expect(highStakesDecision({ cwd: root, agentDir, command: "git push" })).toBeUndefined();
	});

	it("refuses --no-verify and hook overrides even when the tree is covered", () => {
		publish(repo, { trees: covered(repo) });
		for (const command of [
			"git push --no-verify",
			"git push -f --no-verify origin x",
			"git -c core.hooksPath=/dev/null push",
			"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push",
			"git config core.hooksPath /dev/null",
			"export GIT_CONFIG_COUNT=1",
		]) {
			const reason = denied(highStakesDecision({ cwd: repo, agentDir, command }));
			expect(reason).toStartWith(STAKES_REFUSAL_LEAD);
			expect(reason).toContain("skip the pre-push check");
			expect(reason).toEndWith(STAKES_REFUSAL_ASK);
		}
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git commit --no-verify -m x" })).toBeUndefined();
	});

	it("leaves everything that does not publish alone, covered or not", () => {
		publish(repo);
		for (const command of [
			"git status",
			"git commit -m 'git push later'",
			"git fetch && git pull",
			"git tag v1",
			"git switch -c x",
			"git log --grep=push",
			"gh pr view 3",
			"gh pr list",
			"gh api repos/o/r/pulls",
			"echo git push",
			"ls",
		]) {
			expect(highStakesDecision({ cwd: repo, agentDir, command })).toBeUndefined();
		}
	});

	it("checks the checkout a command names with -C, cd or the tool's own folder", () => {
		publish(repo, { trees: covered(repo) });
		publish(other);
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
		denied(highStakesDecision({ cwd: repo, agentDir, command: `git -C ${other} push` }));
		denied(highStakesDecision({ cwd: repo, agentDir, command: `cd ${other} && git push` }));
		denied(highStakesDecision({ cwd: repo, agentDir, command: "git push", commandCwd: other }));
		denied(highStakesDecision({ cwd: repo, agentDir, command: `bash -c 'git -C ${other} push'` }));
		fs.mkdirSync(path.join(other, "sub"));
		denied(highStakesDecision({ cwd: other, agentDir, command: "cd sub && git push" }));
		denied(highStakesDecision({ cwd: repo, agentDir, command: `cd ${path.relative(repo, other)} && git push` }));
	});

	it("checks the session's checkout too when the command names another", () => {
		publish(repo);
		publish(other, { trees: covered(other) });
		denied(highStakesDecision({ cwd: repo, agentDir, command: `git -C ${other} push` }));
	});

	it("follows an alias from the repository's own git config", () => {
		publish(repo);
		git(repo, "config", "alias.ship", "push origin HEAD");
		git(repo, "config", "alias.shout", "!git push");
		git(repo, "config", "alias.s", "status");
		denied(highStakesDecision({ cwd: repo, agentDir, command: "git ship" }));
		denied(highStakesDecision({ cwd: repo, agentDir, command: "git shout" }));
		denied(highStakesDecision({ cwd: repo, agentDir, command: "git -c alias.go=ship go" }));
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git s" })).toBeUndefined();
		expect(highStakesDecision({ cwd: repo, agentDir, command: "git unknown" })).toBeUndefined();
	});

	it("gates the source of an eval cell the same way", () => {
		publish(repo);
		const reason = denied(
			highStakesDecision({
				cwd: repo,
				agentDir,
				script: 'import subprocess\nsubprocess.run(["git", "-C", d, "push"])',
			}),
		);
		expect(reason).toStartWith(STAKES_REFUSAL_LEAD);
		denied(
			highStakesDecision({
				cwd: repo,
				agentDir,
				script: 'await fetch("https://api.github.com/repos/o/r/pulls", {method: "POST"})',
			}),
		);
		expect(highStakesDecision({ cwd: repo, agentDir, script: "print(1 + 1)" })).toBeUndefined();
		publish(repo, { trees: covered(repo) });
		expect(highStakesDecision({ cwd: repo, agentDir, script: 'subprocess.run(["git", "push"])' })).toBeUndefined();
		denied(highStakesDecision({ cwd: repo, agentDir, script: 'subprocess.run(["git", "push", "--no-verify"])' }));
	});

	it("does no git work when the agent directory holds no published state", () => {
		const spawn = spyOn(Bun, "spawnSync");
		try {
			expect(highStakesDecision({ cwd: repo, agentDir, command: "git push" })).toBeUndefined();
			expect(highStakesDecision({ cwd: repo, agentDir, command: "git p" })).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	it("runs git only for a command that publishes", () => {
		publish(repo);
		const spawn = spyOn(Bun, "spawnSync");
		try {
			expect(
				highStakesDecision({ cwd: repo, agentDir, command: "git status && ls && echo git push" }),
			).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
			denied(highStakesDecision({ cwd: repo, agentDir, command: "git push" }));
			expect(spawn).toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});
});

function session(cwd: string): ToolSession {
	const settings = Settings.isolated({
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"astGrep.enabled": false,
		"astEdit.enabled": false,
		"grep.enabled": false,
		"glob.enabled": false,
	});
	spyOn(settings, "getAgentDir").mockReturnValue(agentDir);
	spyOn(settings, "getShellConfig").mockReturnValue({ shell: "/bin/bash", args: ["-c"], env: {}, prefix: undefined });
	return { cwd, settings } as unknown as ToolSession;
}

describe("tool approvals", () => {
	it("bash: a refused push is a tool-owned deny that yolo, user policy and escalation do not lift", () => {
		publish(repo);
		const bash = new BashTool(session(repo));
		const decision = bash.approval({ command: "git push origin main" });
		denied(decision);
		for (const mode of ["always-ask", "write", "yolo"] as const) {
			const resolved = resolveApproval(bash, { command: "git push origin main" }, mode, { bash: "allow" });
			expect(resolved.policy).toBe("deny");
			expect(resolved.source).toBe("tool");
			expect(resolved.reason).toStartWith(STAKES_REFUSAL_LEAD);
			expect(denyError(resolved, "bash").message).toStartWith(
				`Tool "bash" is blocked by tool policy.\nReason: ${STAKES_REFUSAL_LEAD}`,
			);
		}
		for (const escalate of ["network", "full"]) {
			const escalated = bash.approval({ command: "git push", escalate, justification: "publish" });
			denied(escalated);
		}
	});

	it("bash: a deny wins over a pattern that allows the command", () => {
		publish(repo);
		const allowAll = new BashTool(
			(() => {
				const base = session(repo);
				const settings = Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bash.patterns": [{ match: "git push *", approval: "allow" }],
				});
				spyOn(settings, "getAgentDir").mockReturnValue(agentDir);
				spyOn(settings, "getShellConfig").mockReturnValue({
					shell: "/bin/bash",
					args: ["-c"],
					env: {},
					prefix: undefined,
				});
				return { ...base, settings } as unknown as ToolSession;
			})(),
		);
		denied(allowAll.approval({ command: "git push origin main" }));
	});

	it("bash: covered, off or unrelated commands go on to the usual approval", () => {
		const bash = new BashTool(session(repo));
		publish(repo, { trees: covered(repo) });
		expect(bash.approval({ command: "git push origin main" })).toBe("exec");
		expect(resolveApproval(bash, { command: "git push origin main" }, "yolo").policy).toBe("allow");
		publish(repo);
		expect(bash.approval({ command: "git status" })).toBe("exec");
		expect(resolveApproval(bash, { command: "git status" }, "yolo").policy).toBe("allow");
		publish(repo, { on: false });
		expect(bash.approval({ command: "git push" })).toBe("exec");
	});

	it("bash: the tool's cwd argument counts", () => {
		publish(repo, { trees: covered(repo) });
		publish(other);
		const bash = new BashTool(session(repo));
		expect(bash.approval({ command: "git push" })).toBe("exec");
		denied(bash.approval({ command: "git push", cwd: other }));
		expect(bash.approval({ command: "git push", cwd: "skill://x" })).toBe("exec");
	});

	it("eval: a cell that pushes is refused, other cells keep the usual decision", () => {
		publish(repo);
		const evalTool = new EvalTool(session(repo));
		const reason = denied(
			evalTool.approval({ language: "py", code: 'import subprocess\nsubprocess.run(["git", "push"])' }),
		);
		expect(reason).toStartWith(STAKES_REFUSAL_LEAD);
		const resolved = resolveApproval(evalTool, { language: "js", code: "await Bun.$`git push`" }, "yolo");
		expect(resolved.policy).toBe("deny");
		expect(evalTool.approval({ language: "py", code: "print(1)" })).toBe("exec");
		expect(evalTool.approval()).toBe("exec");
		publish(repo, { trees: covered(repo) });
		expect(evalTool.approval({ language: "py", code: 'subprocess.run(["git", "push"])' })).toBe("exec");
	});

	it("github: creating a pull request and pushing a branch are refused, reading is not", () => {
		publish(repo);
		const github = new GithubTool(session(repo));
		for (const op of ["pr_create", "pr_push"]) {
			const reason = denied(github.approval({ op }));
			expect(reason).toStartWith(STAKES_REFUSAL_LEAD);
			expect(resolveApproval(github, { op }, "yolo", { github: "allow" }).policy).toBe("deny");
		}
		expect(github.approval({ op: "pr_checkout" })).toBe("exec");
		expect(github.approval({ op: "search_prs" })).toBe("read");
		publish(repo, { trees: covered(repo) });
		expect(github.approval({ op: "pr_create" })).toBe("exec");
		expect(github.approval({ op: "pr_push" })).toBe("exec");
	});

	it("debug: a launched program or a debugger shell command that pushes is refused", () => {
		publish(repo);
		const debug = new DebugTool(session(repo));
		denied(debug.approval({ action: "launch", program: "git", args: ["push", "origin", "main"] }));
		denied(debug.approval({ action: "evaluate", expression: "shell git push", context: "repl" }));
		denied(debug.approval({ action: "evaluate", expression: "!gh pr create -f", context: "repl" }));
		expect(debug.approval({ action: "launch", program: "./app", args: ["--flag"] })).toBe("exec");
		expect(debug.approval({ action: "evaluate", expression: "info registers", context: "repl" })).toBe("exec");
		expect(debug.approval({ action: "threads" })).toBe("read");
		publish(repo, { trees: covered(repo) });
		expect(debug.approval({ action: "launch", program: "git", args: ["push"] })).toBe("exec");
	});
});
