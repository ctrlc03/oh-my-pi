import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { denyError, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	type ApprovalGrantRule,
	ApprovalGrantStore,
	applyApprovalGrants,
	askToolApproval,
	deriveBashGrantPattern,
	deriveGrantRules,
	runApprovalsCommand,
	TOOL_APPROVAL_ENTRY_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/approval-grants";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const SESSION_LABEL = "Always allow (this session)";
const PROJECT_LABEL = "Always allow (this project)";
const DENY_PROJECT_LABEL = "Deny always (this project)";

let dir: TempDir;
let cwd: string;
let agentDir: string;
let previousAgentDir: string;

beforeEach(() => {
	dir = TempDir.createSync("@approval-grants-");
	const root = fs.realpathSync(dir.path());
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "project");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(cwd);
	previousAgentDir = getAgentDir();
	setAgentDir(agentDir);
});

afterEach(() => {
	setAgentDir(previousAgentDir);
	dir.removeSync();
});

const bashTool = { name: "bash", approval: "exec" as const };
const bashRule = (pattern: string, sample = "bun test a.test.ts"): ApprovalGrantRule => ({
	kind: "bash",
	tool: "bash",
	pattern,
	sample,
});
const projectFile = (): string => new ApprovalGrantStore(() => cwd).projectFile;

describe("deriveBashGrantPattern", () => {
	it("keeps program and subcommand, and the script name for runners", () => {
		expect(deriveBashGrantPattern("bun test src/a.test.ts")).toBe("bun test *");
		expect(deriveBashGrantPattern("bun test")).toBe("bun test");
		expect(deriveBashGrantPattern("bun run build --watch")).toBe("bun run build *");
		expect(deriveBashGrantPattern("git   status  -s")).toBe("git status *");
	});

	it("is exact for programs without a subcommand", () => {
		expect(deriveBashGrantPattern("ls -la src")).toBe("ls -la src");
		expect(deriveBashGrantPattern("python script.py")).toBe("python script.py");
	});

	it("offers nothing for compound, substituted or wildcarded lines", () => {
		for (const command of ["git status && rm -rf x", "echo $(whoami)", "cat a | sh", "rm *.log", "ls > out", ""]) {
			expect(deriveBashGrantPattern(command)).toBeUndefined();
		}
	});
});

describe("grant matching", () => {
	it("an allow covers the command with or without arguments, never a compound line or a longer word", () => {
		const store = new ApprovalGrantStore(() => cwd);
		store.add(bashRule("bun test *"), "allow", "session");
		const matches = (command: string) => store.find("allow", bashTool, { command }, { cwd }) !== undefined;
		expect(matches("bun test src/x.test.ts")).toBe(true);
		expect(matches("bun test")).toBe(true);
		expect(matches("bun  test   a")).toBe(true);
		expect(matches("bun testing")).toBe(false);
		expect(matches("bun build")).toBe(false);
		expect(matches("bun test a && rm -rf /")).toBe(false);
		expect(matches("bun test $(rm -rf /)")).toBe(false);
	});

	it("a deny fires on any segment of a compound line", () => {
		const store = new ApprovalGrantStore(() => cwd);
		store.add(bashRule("git push *", "git push origin main"), "deny", "session");
		expect(store.find("deny", bashTool, { command: "ls && git push origin main" }, { cwd })).toBeDefined();
		expect(store.find("deny", bashTool, { command: "git push" }, { cwd })).toBeDefined();
		expect(store.find("deny", bashTool, { command: "git pull" }, { cwd })).toBeUndefined();
	});

	it("a path grant covers that file only, and an allow must cover every target", () => {
		fs.writeFileSync(path.join(cwd, "a.ts"), "");
		fs.writeFileSync(path.join(cwd, "b.ts"), "");
		const edit = {
			name: "edit",
			approvalTargets: (args: unknown) =>
				typeof args === "object" && args !== null && "targets" in args && Array.isArray(args.targets)
					? args.targets
					: undefined,
		};
		const [rule] = deriveGrantRules(edit, { targets: ["a.ts"] }, cwd);
		if (!rule) throw new Error("expected a path rule");
		expect(rule).toMatchObject({ kind: "path", tool: "edit", pattern: path.join(cwd, "a.ts") });
		const store = new ApprovalGrantStore(() => cwd);
		store.add(rule, "allow", "session");
		const covers = (targets: string[]) => store.find("allow", edit, { targets }, { cwd }) !== undefined;
		expect(covers(["a.ts"])).toBe(true);
		expect(covers([path.join(cwd, "a.ts")])).toBe(true);
		expect(covers(["b.ts"])).toBe(false);
		expect(covers(["a.ts", "b.ts"])).toBe(false);
		// The grant belongs to the tool it was given for.
		expect(
			store.find("allow", { name: "write", approvalTargets: edit.approvalTargets }, { targets: ["a.ts"] }, { cwd }),
		).toBeUndefined();
	});

	it("a glob grant does not follow a symlink out of its directory", () => {
		const outside = TempDir.createSync("@approval-grants-outside-");
		try {
			const secret = path.join(fs.realpathSync(outside.path()), "secret.txt");
			fs.writeFileSync(secret, "");
			fs.mkdirSync(path.join(cwd, "proj"));
			fs.symlinkSync(secret, path.join(cwd, "proj", "link.txt"));
			fs.writeFileSync(path.join(cwd, "proj", "plain.txt"), "");
			const write = { name: "write" };
			const store = new ApprovalGrantStore(() => cwd);
			store.add({ kind: "path", tool: "write", pattern: `${path.join(cwd, "proj")}/**` }, "allow", "session");
			expect(store.find("allow", write, { path: "proj/plain.txt" }, { cwd })).toBeDefined();
			expect(store.find("allow", write, { path: "proj/link.txt" }, { cwd })).toBeUndefined();
		} finally {
			outside.removeSync();
		}
	});

	it("offers no path rule for internal URLs, unknown targets or glob characters", () => {
		const write = { name: "write" };
		expect(deriveGrantRules(write, { path: "xd://knowledge_search" }, cwd)).toEqual([]);
		expect(deriveGrantRules(write, {}, cwd)).toEqual([]);
		expect(deriveGrantRules(write, { path: "src/[id].ts" }, cwd)).toEqual([]);
		expect(deriveGrantRules({ name: "ast_edit" }, {}, cwd)).toEqual([
			{ kind: "tool", tool: "ast_edit", pattern: "*" },
		]);
	});
});

describe("applyApprovalGrants precedence", () => {
	const session = { cwd };
	const grantedStore = (effect: "allow" | "deny" = "allow"): ApprovalGrantStore => {
		const store = new ApprovalGrantStore(() => cwd);
		store.add({ kind: "tool", tool: "bash", pattern: "*" }, effect, "session");
		return store;
	};

	it("an allow grant answers a prompt the approval mode raised", () => {
		const resolved = resolveApproval(bashTool, { command: "x" }, "always-ask");
		expect(resolved).toMatchObject({ policy: "prompt", source: "mode" });
		expect(applyApprovalGrants(grantedStore(), bashTool, { command: "x" }, resolved, session)).toMatchObject({
			policy: "allow",
			source: "grant",
		});
	});

	it("never overrides an explicit user deny, a tool deny, an explicit prompt or a rule-raised prompt", () => {
		const store = grantedStore();
		const args = { command: "x" };
		const userDeny = resolveApproval(bashTool, args, "always-ask", { bash: "deny" });
		expect(applyApprovalGrants(store, bashTool, args, userDeny, session)).toMatchObject({
			policy: "deny",
			source: "user",
		});
		const toolDeny = resolveApproval(
			{ name: "bash", approval: { tier: "exec", policy: "deny", reason: "Blocked by bash pattern: x" } },
			args,
			"always-ask",
		);
		const denied = applyApprovalGrants(store, bashTool, args, toolDeny, session);
		expect(denied).toMatchObject({ policy: "deny", source: "tool" });
		expect(denyError(denied, "bash").message).toContain("Blocked by bash pattern: x");
		const userPrompt = resolveApproval(bashTool, args, "always-ask", { bash: "prompt" });
		expect(applyApprovalGrants(store, bashTool, args, userPrompt, session).policy).toBe("prompt");
		const ruleRaised = resolveApproval(
			{
				name: "bash",
				approval: { tier: "exec", override: true, policy: "prompt", reason: "Critical pattern detected" },
			},
			args,
			"always-ask",
		);
		expect(applyApprovalGrants(store, bashTool, args, ruleRaised, session).policy).toBe("prompt");
	});

	it("a deny grant refuses a call the mode would run or prompt", () => {
		const store = grantedStore("deny");
		for (const mode of ["yolo", "always-ask"] as const) {
			const resolved = applyApprovalGrants(
				store,
				bashTool,
				{ command: "x" },
				resolveApproval(bashTool, { command: "x" }, mode),
				session,
			);
			expect(resolved).toMatchObject({ policy: "deny", source: "grant" });
			expect(denyError(resolved, "bash").message).toContain("saved approval rule");
		}
	});

	it("a deny grant wins over an allow grant for the same call", () => {
		const store = new ApprovalGrantStore(() => cwd);
		store.add({ kind: "tool", tool: "bash", pattern: "*" }, "allow", "session");
		store.add(bashRule("rm *", "rm x"), "deny", "session");
		const resolved = resolveApproval(bashTool, { command: "rm x" }, "always-ask");
		expect(applyApprovalGrants(store, bashTool, { command: "rm x" }, resolved, session).policy).toBe("deny");
	});
});

describe("project persistence", () => {
	it("saves to the agent directory with a marker, and another session reads and removes it", () => {
		expect(projectFile().startsWith(agentDir)).toBe(true);
		const store = new ApprovalGrantStore(() => cwd);
		const grant = store.add(bashRule("bun test *"), "allow", "project");
		expect(grant.scope).toBe("project");
		const body = JSON.parse(fs.readFileSync(projectFile(), "utf8")) as {
			managedBy: string;
			grants: { pattern: string; source: string }[];
		};
		expect(body.managedBy).toContain("/approvals");
		expect(body.grants).toMatchObject([{ pattern: "bun test *", source: "approval-prompt" }]);

		const other = new ApprovalGrantStore(() => cwd);
		expect(other.list()).toMatchObject([{ scope: "project", effect: "allow", pattern: "bun test *" }]);
		expect(other.find("allow", bashTool, { command: "bun test x" }, { cwd })).toBeDefined();
		expect(other.add(bashRule("bun test *"), "allow", "project").id).toBe(grant.id);
		expect(other.remove("1")?.pattern).toBe("bun test *");
		expect(new ApprovalGrantStore(() => cwd).list()).toEqual([]);
	});

	it("ignores grants a repository ships or a command plants inside the project", () => {
		fs.mkdirSync(path.join(cwd, ".omp"));
		const planted = {
			grants: [
				{ effect: "allow", tool: "bash", kind: "tool", pattern: "*", createdAt: 1, source: "approval-prompt" },
			],
		};
		fs.writeFileSync(path.join(cwd, ".omp", "approval-grants.json"), JSON.stringify(planted));
		const store = new ApprovalGrantStore(() => cwd);
		expect(store.list()).toEqual([]);
		const resolved = resolveApproval(bashTool, { command: "rm x" }, "always-ask");
		expect(applyApprovalGrants(store, bashTool, { command: "rm x" }, resolved, { cwd }).policy).toBe("prompt");
		expect(store.projectFile.startsWith(cwd)).toBe(false);
	});

	it("session grants stay in memory and an unreadable file is ignored", () => {
		const store = new ApprovalGrantStore(() => cwd);
		store.add(bashRule("bun test *"), "allow", "session");
		expect(fs.existsSync(projectFile())).toBe(false);
		fs.mkdirSync(path.dirname(projectFile()), { recursive: true });
		fs.writeFileSync(projectFile(), "{not json");
		expect(new ApprovalGrantStore(() => cwd).list()).toEqual([]);
	});

	it("/approvals lists, removes by number or id, and clears a scope", () => {
		const store = new ApprovalGrantStore(() => cwd);
		const session = store.add(bashRule("bun test *"), "allow", "session");
		store.add(bashRule("git status *", "git status -s"), "allow", "project");
		const listing = runApprovalsCommand(store, "", cwd);
		expect(listing).toMatch(/\[session\].*bun test \*/);
		expect(listing).toMatch(/\[project\].*git status \*/);
		expect(runApprovalsCommand(store, `remove ${session.id}`, cwd)).toContain("Removed session allow rule");
		expect(runApprovalsCommand(store, "remove 9", cwd)).toContain("No saved approval");
		expect(runApprovalsCommand(store, "clear nope", cwd)).toContain("Usage");
		expect(runApprovalsCommand(store, "clear project", cwd)).toContain("Removed 1");
		expect(store.list()).toEqual([]);
	});
});

type AnyMock = Mock<(...args: never[]) => unknown>;

interface FakeUi {
	ui: Pick<ExtensionUIContext, "select" | "approve" | "editor" | "notify">;
	select: AnyMock;
	editor: AnyMock;
	notify: AnyMock;
}

/** A UI whose select answers `label` as `source`, and whose editor answers `edited`. */
function fakeUi(label: string | undefined, source: "local" | "remote", edited?: string): FakeUi {
	const select = vi.fn(async (_title: string, _options: unknown[], dialog?: ExtensionUIDialogOptions) => {
		dialog?.onAnswer?.(source);
		return label;
	});
	const editor = vi.fn(async () => edited);
	const notify = vi.fn();
	return { ui: { select, editor, notify } as FakeUi["ui"], select, editor, notify };
}

describe("askToolApproval", () => {
	const ask = (
		fake: FakeUi,
		store: ApprovalGrantStore | undefined,
		guestsCanSaveProject = false,
		rules = [bashRule("bun test *")],
	) =>
		askToolApproval({
			ui: fake.ui,
			prompt: { full: "Allow tool: bash", compact: "Allow tool: bash" },
			tool: "bash",
			rules,
			store,
			guestsCanSaveProject,
			session: { cwd },
		});

	it("is the plain Approve / Deny prompt without grantable rules", async () => {
		const fake = fakeUi("Approve", "local");
		const outcome = await ask(fake, new ApprovalGrantStore(() => cwd), false, []);
		expect(outcome).toMatchObject({ approved: true, by: "tui", choice: "once", saved: [] });
		expect(fake.select).toHaveBeenCalledWith(expect.any(String), ["Approve", "Deny"], expect.anything());
		expect((await ask(fakeUi(undefined, "local"), undefined)).approved).toBe(false);
	});

	it("uses the host's approval dialog for the plain prompt and reports who answered", async () => {
		const fake = fakeUi(undefined, "local");
		const approve = vi.fn(async (_prompt: unknown, dialog?: ExtensionUIDialogOptions) => {
			dialog?.onAnswer?.("remote");
			return "once" as const;
		});
		const outcome = await askToolApproval({
			ui: { ...fake.ui, approve } as FakeUi["ui"],
			prompt: { full: "Allow tool: bash\nCommand: a\nb", compact: "Allow tool: bash\nCommand: a … +1 line" },
			tool: "bash",
			rules: [],
			store: undefined,
			guestsCanSaveProject: false,
			session: { cwd },
		});
		expect(outcome).toMatchObject({ approved: true, by: "guest", choice: "once", saved: [] });
		expect(approve.mock.calls[0]?.[0]).toEqual({
			full: "Allow tool: bash\nCommand: a\nb",
			compact: "Allow tool: bash\nCommand: a … +1 line",
		});
		expect(fake.select).not.toHaveBeenCalled();
	});

	it("saves a session rule with the pattern the user edited", async () => {
		const store = new ApprovalGrantStore(() => cwd);
		const fake = fakeUi(SESSION_LABEL, "local", "bun test a.test.ts");
		const outcome = await ask(fake, store);
		expect(outcome).toMatchObject({ approved: true, choice: "session" });
		expect(fake.editor).toHaveBeenCalledWith(expect.any(String), "bun test *");
		expect(store.list()).toMatchObject([{ scope: "session", effect: "allow", pattern: "bun test a.test.ts" }]);
		expect(fs.existsSync(projectFile())).toBe(false);
	});

	it("applies the call once and saves nothing when the edit is cancelled or no longer matches the command", async () => {
		for (const edited of [undefined, "git status *", "*"]) {
			const store = new ApprovalGrantStore(() => cwd);
			const fake = fakeUi(SESSION_LABEL, "local", edited);
			expect(await ask(fake, store)).toMatchObject({ approved: true, choice: "once", saved: [] });
			expect(store.list()).toEqual([]);
			expect(fake.notify).toHaveBeenCalledWith(expect.stringContaining("not saved"), "warning");
		}
	});

	it("refuses a guest's project rule unless the host allows it, but honors its session rule", async () => {
		const refused = new ApprovalGrantStore(() => cwd);
		const fake = fakeUi(PROJECT_LABEL, "remote");
		expect(await ask(fake, refused, false)).toMatchObject({ approved: true, by: "guest", choice: "once", saved: [] });
		expect(refused.list()).toEqual([]);
		expect(fs.existsSync(projectFile())).toBe(false);
		expect(fake.notify).toHaveBeenCalledWith(expect.stringContaining("guestsCanSaveApprovals"), "warning");

		const deniedAlways = await ask(fakeUi(DENY_PROJECT_LABEL, "remote"), refused, false);
		expect(deniedAlways).toMatchObject({ approved: false, by: "guest", choice: "deny", saved: [] });
		expect(fs.existsSync(projectFile())).toBe(false);

		const sessionFake = fakeUi(SESSION_LABEL, "remote");
		expect(await ask(sessionFake, refused, false)).toMatchObject({ approved: true, choice: "session" });
		expect(sessionFake.editor).not.toHaveBeenCalled();
		expect(refused.list()).toMatchObject([{ scope: "session", pattern: "bun test *" }]);

		const allowed = new ApprovalGrantStore(() => cwd);
		expect(await ask(fakeUi(PROJECT_LABEL, "remote"), allowed, true)).toMatchObject({ choice: "project" });
		expect(JSON.parse(fs.readFileSync(projectFile(), "utf8")).grants).toHaveLength(1);
	});

	it("saves a deny-always rule that then refuses the call", async () => {
		const store = new ApprovalGrantStore(() => cwd);
		const outcome = await ask(fakeUi(DENY_PROJECT_LABEL, "local", "bun test *"), store);
		expect(outcome).toMatchObject({ approved: false, choice: "deny-project" });
		const resolved = resolveApproval(bashTool, { command: "bun test x" }, "yolo");
		expect(applyApprovalGrants(store, bashTool, { command: "bun test x" }, resolved, { cwd }).policy).toBe("deny");
	});

	it("falls back to a session rule when the project file cannot be written", async () => {
		fs.writeFileSync(path.join(agentDir, "approval-grants"), "a file where the directory should be");
		const store = new ApprovalGrantStore(() => cwd);
		const fake = fakeUi(PROJECT_LABEL, "local", "bun test *");
		const outcome = await ask(fake, store);
		expect(outcome.saved).toMatchObject([{ scope: "session" }]);
		expect(fake.notify).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "warning");
	});
});

describe("the tool wrapper", () => {
	const makeRunner = (fake: FakeUi): ExtensionRunner => {
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			cwd,
			SessionManager.inMemory(cwd),
			{} as ModelRegistry,
		);
		runner.initialize({ appendEntry: () => {} } as never, { isIdle: () => true } as never, undefined, {
			...fake.ui,
			onTerminalInput: () => () => {},
		} as unknown as ExtensionUIContext);
		return runner;
	};
	const bash = {
		name: "bash",
		label: "Bash",
		description: "stub",
		parameters: {} as never,
		approval: "exec" as const,
		execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] })),
	};
	const run = (runner: ExtensionRunner, command: string, settings: Settings, id: string) =>
		(new ExtensionToolWrapper(bash, runner) as ExtensionToolWrapper<any>).execute(
			id,
			{ command },
			undefined,
			undefined,
			{
				sessionManager: SessionManager.inMemory(cwd),
				modelRegistry: {} as ModelRegistry,
				model: undefined,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
				settings,
			},
		);

	it("stops prompting for `bun test …` after Always allow (session), while a configured deny still wins", async () => {
		const fake = fakeUi(SESSION_LABEL, "local", "bun test *");
		const runner = makeRunner(fake);
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });

		await run(runner, "bun test a.test.ts", settings, "c1");
		expect(fake.select).toHaveBeenCalledTimes(1);
		await run(runner, "bun test b.test.ts --bail", settings, "c2");
		await run(runner, "bun test", settings, "c3");
		expect(fake.select).toHaveBeenCalledTimes(1);
		expect(bash.execute).toHaveBeenCalledTimes(3);

		// A different command still prompts.
		await run(runner, "bun build", settings, "c4");
		expect(fake.select).toHaveBeenCalledTimes(2);

		// A configured deny is checked before any grant.
		const denying = Settings.isolated({ "tools.approvalMode": "always-ask", "tools.approval": { bash: "deny" } });
		await expect(run(runner, "bun test a.test.ts", denying, "c5")).rejects.toThrow("blocked by user policy");
		expect(bash.execute).toHaveBeenCalledTimes(4);
	});

	it("a prompt the tool declares still asks in yolo when the call arrives through xd://", async () => {
		const fake = fakeUi("Deny", "local");
		const runner = makeRunner(fake);
		const forced = {
			...bash,
			execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] })),
			approval: { tier: "exec" as const, policy: "prompt" as const, reason: "needs the user" },
		};
		const yolo = Settings.isolated({ "tools.approvalMode": "yolo" });
		const call = (tool: typeof forced) =>
			(new ExtensionToolWrapper(tool, runner) as ExtensionToolWrapper<any>).execute(
				"x1",
				{ command: "x" },
				undefined,
				undefined,
				{
					sessionManager: SessionManager.inMemory(cwd),
					modelRegistry: {} as ModelRegistry,
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: yolo,
					xdevApproved: true,
				},
			);
		await expect(call(forced)).rejects.toThrow();
		expect(fake.select).toHaveBeenCalledTimes(1);
		expect(forced.execute).not.toHaveBeenCalled();

		// A tier-only prompt is still covered by the outer xd:// prompt.
		const tierOnly = { ...forced, approval: "exec" as const };
		await call(tierOnly as unknown as typeof forced);
		expect(fake.select).toHaveBeenCalledTimes(1);
	});

	it("records who decided in a tool-approval session entry", async () => {
		const fake = fakeUi("Allow once", "remote");
		const manager = SessionManager.inMemory(cwd);
		const append = vi.spyOn(manager, "appendCustomEntry");
		const runner = new ExtensionRunner([], new ExtensionRuntime(), cwd, manager, {} as ModelRegistry);
		runner.initialize({ appendEntry: () => {} } as never, { isIdle: () => true } as never, undefined, {
			...fake.ui,
			onTerminalInput: () => () => {},
		} as unknown as ExtensionUIContext);
		const settings = Settings.isolated({ "tools.approvalMode": "always-ask" });
		await run(runner, "ls", settings, "c1");
		expect(append).toHaveBeenCalledWith(
			TOOL_APPROVAL_ENTRY_TYPE,
			expect.objectContaining({ toolCallId: "c1", tool: "bash", approved: true, by: "guest", choice: "once" }),
		);
	});
});
