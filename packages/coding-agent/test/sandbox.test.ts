import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { buildBwrapArgs, planBwrap } from "@oh-my-pi/pi-coding-agent/sandbox/bubblewrap";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { globToRegexSource } from "@oh-my-pi/pi-coding-agent/sandbox/glob-regex";
import {
	resolveSandboxPolicy,
	SECRET_HOME_PATHS,
	type SandboxPathMatcher,
} from "@oh-my-pi/pi-coding-agent/sandbox/policy";
import {
	__setSandboxBackendForTests,
	prepareSandboxRun,
	SandboxUnavailableError,
	sandboxEscalationDecision,
} from "@oh-my-pi/pi-coding-agent/sandbox/run";
import {
	effectiveSandboxAutoEscalate,
	effectiveSandboxFailOpen,
	effectiveSandboxMode,
	effectiveSandboxNetwork,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { buildSeatbeltProfile } from "@oh-my-pi/pi-coding-agent/sandbox/seatbelt";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const SHELL = { shell: "/bin/bash", args: ["-c"] };
const HAS_SEATBELT = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

function sandboxSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated({ "sandbox.mode": "workspace-write", ...overrides });
}

describe("sandbox policy", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sandbox-policy-")));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("is off by default", () => {
		expect(resolveSandboxPolicy({ settings: Settings.isolated(), cwd: dir })).toBeUndefined();
	});

	it("limits writes to the workspace, temp dirs and caches, and protects git hooks and harness config", () => {
		fs.mkdirSync(path.join(dir, ".git"));
		const policy = resolveSandboxPolicy({ settings: sandboxSettings(), cwd: dir });
		expect(policy?.writableRoots).toContain(dir);
		expect(policy?.writableRoots).toContain(path.join(dir, ".git"));
		expect(policy?.writableRoots).toContain(path.join(os.homedir(), ".cache"));
		expect(policy?.writableRoots).not.toContain(os.homedir());
		expect(policy?.readOnly).toContainEqual({ subpath: path.join(dir, ".git", "hooks") });
		expect(policy?.readOnly).toContainEqual({ subpath: path.join(dir, ".omp") });
		for (const secret of SECRET_HOME_PATHS) {
			expect(policy?.denyAccess).toContainEqual({ subpath: path.join(os.homedir(), secret) });
		}
		expect(policy?.network).toBe(false);
	});

	it("allows temp writes only in read-only mode", () => {
		const policy = resolveSandboxPolicy({ settings: sandboxSettings({ "sandbox.mode": "read-only" }), cwd: dir });
		expect(policy?.writableRoots).not.toContain(dir);
		expect(policy?.writableRoots).toContain(fs.realpathSync(os.tmpdir()));
	});

	it("adds extra workspace roots and the worktree git dirs", () => {
		const extra = path.join(dir, "extra");
		const main = path.join(dir, "main");
		const worktree = path.join(dir, "wt");
		const gitDir = path.join(main, ".git", "worktrees", "wt");
		fs.mkdirSync(extra);
		fs.mkdirSync(gitDir, { recursive: true });
		fs.mkdirSync(worktree);
		fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
		fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
		const policy = resolveSandboxPolicy({
			settings: sandboxSettings(),
			cwd: worktree,
			additionalDirectories: [extra],
		});
		expect(policy?.writableRoots).toContain(extra);
		expect(policy?.writableRoots).toContain(gitDir);
		expect(policy?.writableRoots).toContain(path.join(main, ".git"));
		expect(policy?.readOnly).toContainEqual({ subpath: path.join(main, ".git", "hooks") });
	});

	it("turns tools.pathRules deny rules into path matchers", () => {
		const policy = resolveSandboxPolicy({
			settings: sandboxSettings({
				"tools.pathRules": [
					{ glob: ".env*", action: "deny" },
					{ glob: "secrets/**", action: "deny", tools: ["write"] },
					{ glob: "docs/**", action: "allow" },
				],
			}),
			cwd: dir,
		});
		const regexes = (matchers: readonly SandboxPathMatcher[] | undefined) =>
			(matchers ?? []).flatMap(matcher => ("regex" in matcher ? [new RegExp(matcher.regex)] : []));
		expect(regexes(policy?.denyAccess).some(re => re.test(path.join(dir, "app", ".env.local")))).toBe(true);
		expect(regexes(policy?.denyAccess).some(re => re.test(path.join(dir, "app", "main.ts")))).toBe(false);
		expect(regexes(policy?.denyWrite).some(re => re.test(path.join(dir, "secrets", "key.pem")))).toBe(true);
		expect(regexes(policy?.denyWrite).some(re => re.test(path.join(dir, "other", "key.pem")))).toBe(false);
	});

	it("converts globs to anchored-friendly regex sources", () => {
		expect(new RegExp(`^${globToRegexSource("a/**/b.{ts,js}")}$`).test("a/x/y/b.js")).toBe(true);
		expect(new RegExp(`^${globToRegexSource("a/**/b.{ts,js}")}$`).test("a/b.ts")).toBe(true);
		expect(new RegExp(`^${globToRegexSource("a/*.ts")}$`).test("a/x/b.ts")).toBe(false);
		expect(new RegExp(`^${globToRegexSource("f?.[!a]")}$`).test("fx.b")).toBe(true);
	});

	it("renders bubblewrap args that mask secrets and drop the network", () => {
		const secret = path.join(dir, "secret");
		fs.mkdirSync(secret);
		const policy = {
			mode: "workspace-write" as const,
			network: false,
			writableRoots: [dir],
			projectRoots: [dir],
			readOnly: [],
			denyAccess: [{ subpath: secret }],
			denyWrite: [],
		};
		const args = buildBwrapArgs(policy);
		expect(args).toContain("--unshare-net");
		expect(args).toContain("--unshare-pid");
		expect(args).toContain("--new-session");
		expect(buildBwrapArgs(policy, { tty: true })).not.toContain("--new-session");
		expect(args.join(" ")).toContain(`--bind ${dir} ${dir}`);
		expect(args.join(" ")).toContain(`--tmpfs ${secret}`);
		expect(buildBwrapArgs({ ...policy, network: true })).not.toContain("--unshare-net");
	});

	it("mounts over protected paths that do not exist yet and protects nested git dirs", () => {
		const nested = path.join(dir, "vendor", "x", ".git");
		fs.mkdirSync(path.join(nested, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(nested, "config"), "");
		const module = path.join(nested, "modules", "dep");
		fs.mkdirSync(module, { recursive: true });
		fs.writeFileSync(path.join(module, "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(path.join(module, "config"), "");
		const plan = planBwrap({
			mode: "workspace-write",
			network: false,
			writableRoots: [dir],
			projectRoots: [dir],
			readOnly: [{ subpath: path.join(dir, ".omp") }, { subpath: path.join(dir, ".mcp.json") }],
			denyAccess: [],
			denyWrite: [],
		});
		const text = plan.args.join(" ");
		expect(text).toContain(`--tmpfs ${dir}/.omp --remount-ro ${dir}/.omp`);
		expect(text).toContain(`--ro-bind /dev/null ${dir}/.mcp.json`);
		expect(plan.syntheticDirs).toContain(path.join(dir, ".omp"));
		expect(plan.syntheticFiles).toContain(path.join(dir, ".mcp.json"));
		expect(text).toContain(`--bind ${nested} ${nested}`);
		expect(text).toContain(`--ro-bind ${nested}/hooks ${nested}/hooks`);
		expect(text).toContain(`--bind ${module} ${module}`);
		expect(text).toContain(`--ro-bind ${module}/config ${module}/config`);
	});

	it("makes the agent dir read-only in every mode, even for a cwd inside it", () => {
		const agentDir = getAgentDir();
		for (const mode of ["workspace-write", "read-only"] as const) {
			const policy = resolveSandboxPolicy({
				settings: sandboxSettings({ "sandbox.mode": mode }),
				cwd: path.join(agentDir, "project"),
			});
			expect(policy?.readOnly).toContainEqual({ subpath: agentDir });
		}
	});

	it("hides the companion's schedule IPC token", () => {
		const policy = resolveSandboxPolicy({ settings: sandboxSettings(), cwd: dir });
		expect(policy?.denyAccess).toContainEqual({ subpath: path.join(getAgentDir(), "collab-companion-ipc.json") });
	});

	it("does not make the home directory (or an ancestor) writable", () => {
		for (const cwd of [os.homedir(), path.dirname(os.homedir())]) {
			const policy = resolveSandboxPolicy({ settings: sandboxSettings(), cwd });
			const home = fs.realpathSync(os.homedir());
			expect(policy?.writableRoots).not.toContain(cwd);
			expect(policy?.writableRoots).not.toContain(home);
			expect(policy?.projectRoots).toEqual([]);
		}
	});
});

describe("sandbox settings from a project layer", () => {
	async function load(user: string | undefined, project: string): Promise<Settings> {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sandbox-layers-")));
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "repo");
		if (user) await Bun.write(path.join(agentDir, "config.yml"), user);
		await Bun.write(path.join(cwd, ".omp/config.yml"), project);
		return Settings.loadIsolated({ cwd, agentDir });
	}

	it("ignores a repository that tries to loosen the sandbox", async () => {
		const settings = await load(
			"sandbox:\n  mode: workspace-write\n",
			"sandbox:\n  mode: off\n  network: on\n  failOpen: true\n  autoEscalate: true\n",
		);
		expect(effectiveSandboxMode(settings)).toBe("workspace-write");
		expect(effectiveSandboxNetwork(settings)).toBe("off");
		expect(effectiveSandboxFailOpen(settings)).toBe(false);
		expect(effectiveSandboxAutoEscalate(settings)).toBe(false);
	});

	it("lets a repository tighten it", async () => {
		expect(effectiveSandboxMode(await load(undefined, "sandbox:\n  mode: read-only\n"))).toBe("read-only");
		expect(
			effectiveSandboxMode(await load("sandbox:\n  mode: workspace-write\n", "sandbox:\n  mode: read-only\n")),
		).toBe("read-only");
	});

	it("keeps user-level opt-ins", async () => {
		const settings = await load("sandbox:\n  network: on\n  autoEscalate: true\n", "sandbox:\n  network: on\n");
		expect(effectiveSandboxNetwork(settings)).toBe("on");
		expect(effectiveSandboxAutoEscalate(settings)).toBe(true);
	});
});

describe("sandbox run preparation", () => {
	afterEach(() => __setSandboxBackendForTests(undefined));

	it("passes commands through when the sandbox is off or escalated to full", () => {
		const off = prepareSandboxRun({
			command: "echo hi",
			cwd: os.tmpdir(),
			settings: Settings.isolated(),
			shell: SHELL,
		});
		expect(off).toMatchObject({ command: "echo hi", sandboxed: false });
		const full = prepareSandboxRun({
			command: "echo hi",
			cwd: os.tmpdir(),
			settings: sandboxSettings(),
			escalation: "full",
			shell: SHELL,
		});
		expect(full).toMatchObject({ command: "echo hi", sandboxed: false });
	});

	it("removes the empty placeholders bubblewrap created for protected paths, and only those", () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sandbox-bwrap-")));
		const fake = path.join(root, "fake-bwrap");
		fs.writeFileSync(
			fake,
			`#!/bin/sh\nmkdir "${root}/.omp"\n: > "${root}/.mcp.json"\nmkdir "${root}/.claude"\n: > "${root}/.claude/keep"\nexit 3\n`,
			{ mode: 0o755 },
		);
		try {
			__setSandboxBackendForTests({ kind: "bubblewrap", executable: fake });
			const prepared = prepareSandboxRun({ command: "true", cwd: root, settings: sandboxSettings(), shell: SHELL });
			expect(prepared.sandboxed).toBe(true);
			const result = Bun.spawnSync(["/bin/sh", "-c", prepared.command]);
			expect(result.exitCode).toBe(3);
			expect(fs.existsSync(path.join(root, ".omp"))).toBe(false);
			expect(fs.existsSync(path.join(root, ".mcp.json"))).toBe(false);
			expect(fs.existsSync(path.join(root, ".claude", "keep"))).toBe(true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when the backend is missing, and runs unsandboxed with a notice under sandbox.failOpen", () => {
		__setSandboxBackendForTests(null);
		const request = { command: "echo hi", cwd: os.tmpdir(), shell: SHELL };
		expect(() => prepareSandboxRun({ ...request, settings: sandboxSettings() })).toThrow(SandboxUnavailableError);
		const open = prepareSandboxRun({ ...request, settings: sandboxSettings({ "sandbox.failOpen": true }) });
		expect(open).toMatchObject({ command: "echo hi", sandboxed: false });
		expect(open.notice).toBeTruthy();
	});

	it("keeps network off in the Seatbelt profile unless enabled", () => {
		const base = { settings: sandboxSettings(), cwd: os.tmpdir() };
		const closed = resolveSandboxPolicy(base);
		const open = resolveSandboxPolicy({ ...base, network: true });
		expect(buildSeatbeltProfile(closed!)).not.toContain("network*");
		expect(buildSeatbeltProfile(open!)).toContain("(allow network*)");
	});
});

describe("sandbox escalation approval", () => {
	function bashTool(overrides: Record<string, unknown> = {}): BashTool {
		return new BashTool({
			cwd: os.tmpdir(),
			settings: sandboxSettings({ "async.enabled": false, ...overrides }),
		} as unknown as ToolSession);
	}

	it("forces a prompt even in yolo mode, and refuses an escalation without justification", () => {
		const tool = bashTool();
		const prompted = resolveApproval(
			tool,
			{ command: "curl x", escalate: "network", justification: "fetch" },
			"yolo",
		);
		expect(prompted).toMatchObject({ policy: "prompt" });
		const refused = resolveApproval(tool, { command: "curl x", escalate: "full" }, "yolo");
		expect(refused.policy).toBe("deny");
		expect(resolveApproval(tool, { command: "ls" }, "yolo").policy).toBe("allow");
	});

	it("does not prompt with sandbox.autoEscalate or when the sandbox is off", () => {
		const args = { command: "curl x", escalate: "full", justification: "why" };
		expect(resolveApproval(bashTool({ "sandbox.autoEscalate": true }), args, "yolo").policy).toBe("allow");
		expect(sandboxEscalationDecision(Settings.isolated(), "full", "why")).toBeUndefined();
	});

	it("offers the escalate parameter only while the sandbox is on", () => {
		const props = (tool: BashTool) => Object.keys(tool.parameters.toJsonSchema().properties ?? {});
		expect(props(bashTool())).toContain("escalate");
		expect(props(bashTool({ "sandbox.mode": "off" }))).not.toContain("escalate");
	});
});

describe.skipIf(!HAS_SEATBELT)("sandboxed bash (macOS Seatbelt)", () => {
	let dir: string;
	let outside: string;
	let server: Bun.Server<undefined> | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		// Under $HOME rather than the temp dir, which a sandbox leaves writable.
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".omp-sandbox-bash-")));
		await Settings.init({ inMemory: true, cwd: dir });
		outside = path.join(os.homedir(), `.omp-sandbox-test-${process.pid}-${Date.now()}`);
	});

	afterEach(() => {
		server?.stop(true);
		server = undefined;
		fs.rmSync(outside, { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	function run(command: string, settings: Settings, escalation?: "network" | "full") {
		return executeBash(command, { cwd: dir, timeout: 60_000, sandbox: { settings, escalation } });
	}

	it("builds inside the workspace but cannot write outside it or read secrets", async () => {
		const settings = sandboxSettings();
		await executeBash("git init -q .", { cwd: dir, timeout: 60_000 });
		const inside = await run(
			"echo hi > a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -qm init && git log --oneline",
			settings,
		);
		expect(inside.exitCode).toBe(0);

		const write = await run(`touch ${outside}`, settings);
		expect(write.exitCode).not.toBe(0);
		expect(write.output).toMatch(/not permitted/i);
		expect(write.output).toMatch(/sandbox/i);
		expect(fs.existsSync(outside)).toBe(false);

		const secret = await run("ls ~/.ssh", settings);
		expect(secret.exitCode).not.toBe(0);
		expect(secret.output).toMatch(/not permitted/i);

		const hook = await run("echo x > .git/hooks/pre-commit", settings);
		expect(hook.exitCode).not.toBe(0);
		const harnessConfig = await run("mkdir .omp && echo x > .omp/settings.yml", settings);
		expect(harnessConfig.exitCode).not.toBe(0);
	});

	it("keeps git state from being replaced or reconfigured, nested repos and submodules included", async () => {
		const settings = sandboxSettings();
		await executeBash(
			"git init -q . && git init -q sub && mkdir -p .git/modules/m && : > .git/modules/m/HEAD && : > .git/modules/m/config",
			{ cwd: dir, timeout: 60_000 },
		);
		for (const command of [
			"mv .git .git.bak",
			"echo '[core]' >> .git/config",
			"echo '[core]' >> sub/.git/config",
			"echo '[core]' >> .git/modules/m/config",
			"mv sub/.git sub/.git.bak",
			"git init -q fresh",
		]) {
			const denied = await run(command, settings);
			expect(denied.exitCode).not.toBe(0);
		}
		expect(fs.statSync(path.join(dir, ".git")).isDirectory()).toBe(true);
		expect(fs.existsSync(path.join(dir, ".git.bak"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "sub", ".git", "config"))).toBe(true);
		const commit = await run(
			"echo hi > a.txt && git add a.txt && git -c user.name=t -c user.email=t@t commit -qm init",
			settings,
		);
		expect(commit.exitCode).toBe(0);
	});

	it("cannot write the agent dir or read the companion token, whatever the mode or cwd", async () => {
		const original = getAgentDir();
		const agentDir = path.join(dir, "agent");
		fs.mkdirSync(path.join(agentDir, "proj"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "collab-companion-ipc.json"), '{"token":"secret-token"}');
		setAgentDir(agentDir);
		try {
			for (const mode of ["workspace-write", "read-only"]) {
				const settings = sandboxSettings({ "sandbox.mode": mode });
				const cwd = path.join(agentDir, "proj");
				const options = { cwd, timeout: 60_000, sandbox: { settings } };
				const grant = await executeBash("echo x > grants.json", options);
				expect(grant.exitCode).not.toBe(0);
				const sibling = await executeBash("echo x > ../approval-grants.json", options);
				expect(sibling.exitCode).not.toBe(0);
				const token = await executeBash("cat ../collab-companion-ipc.json", options);
				expect(token.exitCode).not.toBe(0);
				expect(token.output).not.toContain("secret-token");
			}
			expect(fs.existsSync(path.join(agentDir, "approval-grants.json"))).toBe(false);
			expect(fs.existsSync(path.join(agentDir, "proj", "grants.json"))).toBe(false);
		} finally {
			setAgentDir(original);
		}
	});

	it("blocks the network until it is enabled or the command escalates", async () => {
		server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
		const curl = `curl -sS -m 10 http://127.0.0.1:${server.port}/`;
		const blocked = await run(curl, sandboxSettings());
		expect(blocked.exitCode).not.toBe(0);
		expect(blocked.output).not.toContain("pong");
		const open = await run(curl, sandboxSettings({ "sandbox.network": "on" }));
		expect(open.output).toContain("pong");
		const escalated = await run(curl, sandboxSettings(), "network");
		expect(escalated.output).toContain("pong");
	});

	it("keeps read-only mode to temp dirs, and lets a full escalation write anywhere", async () => {
		const readOnly = sandboxSettings({ "sandbox.mode": "read-only" });
		const denied = await run("touch inside.txt", readOnly);
		expect(denied.exitCode).not.toBe(0);
		const temp = await run('f="$(mktemp)" && echo ok > "$f" && rm "$f"', readOnly);
		expect(temp.exitCode).toBe(0);
		const full = await run(`touch ${outside}`, sandboxSettings(), "full");
		expect(full.exitCode).toBe(0);
		expect(fs.existsSync(outside)).toBe(true);
	});

	it("writes additional workspace directories and honors tools.pathRules denies", async () => {
		// Under home, not temp: temp is writable anyway and would not prove the extra root.
		const extra = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".omp-sandbox-extra-")));
		try {
			const settings = sandboxSettings({ "tools.pathRules": [{ glob: "*.pem", action: "deny" }] });
			fs.writeFileSync(path.join(dir, "key.pem"), "secret");
			const read = await run("cat key.pem", settings);
			expect(read.exitCode).not.toBe(0);
			const withExtra = await executeBash(`touch ${path.join(extra, "ok")}`, {
				cwd: dir,
				sandbox: { settings, additionalDirectories: [extra] },
			});
			expect(withExtra.exitCode).toBe(0);
			expect(fs.existsSync(path.join(extra, "ok"))).toBe(true);
		} finally {
			fs.rmSync(extra, { recursive: true, force: true });
		}
	});

	it("refuses to run when the sandbox cannot start", async () => {
		__setSandboxBackendForTests(null);
		try {
			await expect(run("echo hi", sandboxSettings())).rejects.toBeInstanceOf(SandboxUnavailableError);
			const open = await run("echo hi", sandboxSettings({ "sandbox.failOpen": true }));
			expect(open.exitCode).toBe(0);
			expect(open.output).toContain("hi");
		} finally {
			__setSandboxBackendForTests(undefined);
		}
	});

	it("runs the bash tool sandboxed end to end", async () => {
		const settings = sandboxSettings({ "async.enabled": false, "bash.autoBackground.enabled": false });
		const tool = new BashTool({
			cwd: dir,
			settings,
			hasUI: false,
			getSessionFile: () => null,
		} as unknown as ToolSession);
		const ok = await tool.execute("call", { command: "echo built > out.txt && cat out.txt" });
		expect(ok.content.find(c => c.type === "text")?.text).toContain("built");
		const failed = await tool.execute("call", { command: `touch ${outside}` });
		const text = failed.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toMatch(/not permitted/i);
		expect(text).toContain("escalate");
		expect(fs.existsSync(outside)).toBe(false);
	});
});
