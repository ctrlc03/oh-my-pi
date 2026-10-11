import { describe, expect, it } from "bun:test";
import {
	applyClaudePermissions,
	claudeBashSpecifierToPatterns,
	claudePathToGlob,
	evaluateRuntimeRules,
	mapClaudePermissions,
	parseClaudeRule,
} from "@oh-my-pi/pi-coding-agent/claude-compat/permissions";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgBashPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgToolsApproval, cfgToolsPathRules } from "@oh-my-pi/pi-coding-agent/tools/settings";

describe("Claude permission rule parsing", () => {
	it("splits Tool(specifier) and treats bare and wildcard rules as tool-wide", () => {
		expect(parseClaudeRule("Bash(git push:*)")).toEqual({ tool: "Bash", specifier: "git push:*" });
		expect(parseClaudeRule("Read")).toEqual({ tool: "Read", specifier: undefined });
		expect(parseClaudeRule("Edit(*)")).toEqual({ tool: "Edit", specifier: undefined });
		expect(parseClaudeRule("Bash(echo (a))")).toEqual({ tool: "Bash", specifier: "echo (a)" });
	});

	it("expands the :* prefix form to the command and the command with arguments", () => {
		expect(claudeBashSpecifierToPatterns("git push:*")).toEqual(["git push", "git push *"]);
		expect(claudeBashSpecifierToPatterns("npm run test")).toEqual(["npm run test"]);
		expect(claudeBashSpecifierToPatterns("git diff *")).toEqual(["git diff *"]);
	});

	it("translates Claude path specifiers", () => {
		expect(claudePathToGlob("./.env")).toBe(".env");
		expect(claudePathToGlob("/src/**")).toBe("src/**");
		expect(claudePathToGlob("//etc/hosts")).toBe("/etc/hosts");
		expect(claudePathToGlob("~/.ssh/**")).toBe("~/.ssh/**");
		expect(claudePathToGlob("**")).toBe("**");
	});
});

describe("mapClaudePermissions", () => {
	const mapped = mapClaudePermissions({
		deny: ["Bash(git push:*)", "Read(./.env)", "Edit(secrets/**)", "WebFetch(domain:evil.test)", "Write"],
		ask: ["Bash(npm publish)", "WebSearch", "mcp__github__create_issue", "mcp__slack"],
		allow: ["Bash(git status)", "Read(src/**)", "Bash", "Task(explore)", "Nonsense"],
	});

	it("orders bash patterns for first-match: deny before, ask after the user's last deny, allow after", () => {
		expect(mapped.bashBefore).toEqual([
			{ match: "git push", approval: "deny" },
			{ match: "git push *", approval: "deny" },
		]);
		expect(mapped.bashAsk).toEqual([{ match: "npm publish", approval: "prompt" }]);
		expect(mapped.bashAfter).toEqual([{ match: "git status", approval: "allow" }]);
	});

	it("maps path specifiers onto the matching omp file tools", () => {
		expect(mapped.pathRulesBefore).toContainEqual({
			tools: ["read", "grep", "glob", "find", "ast_grep"],
			glob: ".env",
			action: "deny",
		});
		const editRule = mapped.pathRulesBefore.find(rule => rule.glob === "secrets/**");
		expect(new Set(editRule?.tools)).toEqual(new Set(["edit", "write", "ast_edit"]));
		expect(mapped.pathRulesAfter).toHaveLength(1);
		expect(mapped.pathRulesAfter[0]).toMatchObject({ glob: "src/**", action: "allow" });
	});

	it("keeps the strictest bare-tool policy and maps MCP tools by their omp name", () => {
		expect(mapped.toolPolicies.write).toBe("deny");
		expect(mapped.toolPolicies.bash).toBe("allow");
		expect(mapped.toolPolicies.web_search).toBe("prompt");
		expect(mapped.toolPolicies.mcp__github_create_issue).toBe("prompt");
	});

	it("leaves WebFetch and MCP server-wide rules to the runtime and reports the unmappable", () => {
		expect(mapped.runtimeRules).toContainEqual({
			kind: "fetch",
			domain: "evil.test",
			action: "deny",
			source: "WebFetch(domain:evil.test)",
		});
		expect(mapped.runtimeRules.some(rule => rule.kind === "tool-prefix" && rule.prefix === "mcp__slack_")).toBe(true);
		expect(mapped.unsupported.some(entry => entry.includes("Nonsense"))).toBe(true);
		expect(mapped.unsupported.some(entry => entry.includes("Task(explore)"))).toBe(true);
	});
});

describe("applyClaudePermissions", () => {
	it("merges into the runtime layer around the user's rules, idempotently", () => {
		const userBash = { match: "git *", approval: "allow" };
		const settings = Settings.isolated({
			"bash.patterns": [userBash],
			"tools.approval": { bash: "allow", read: "deny" },
		});
		const mapped = mapClaudePermissions({
			deny: ["Bash(git push:*)", "Read(./.env)"],
			ask: ["Bash"],
			allow: ["Bash(git status)", "Read"],
		});
		applyClaudePermissions(settings, mapped);
		applyClaudePermissions(settings, mapped);

		const patterns = cfgBashPatterns.get(settings) as readonly { match: string; approval: string }[];
		expect(patterns.map(rule => `${rule.approval}:${rule.match}`)).toEqual([
			"deny:git push",
			"deny:git push *",
			"allow:git *",
			"allow:git status",
		]);
		expect(cfgToolsPathRules.get(settings)).toEqual([
			{ tools: ["read", "grep", "glob", "find", "ast_grep"], glob: ".env", action: "deny" },
		]);
		// Claude's ask is stricter than the user's allow; the user's deny survives Claude's allow.
		const approval = cfgToolsApproval.get(settings) as Record<string, string>;
		expect(approval.bash).toBe("prompt");
		expect(approval.read).toBe("deny");
	});

	it("keeps Claude ask rules behind the user's deny rules but ahead of the user's allows", () => {
		const userDeny = { match: "git push *", approval: "deny" };
		const userAllow = { match: "git *", approval: "allow" };
		const userPathDeny = { glob: "secrets/**", action: "deny" };
		const settings = Settings.isolated({
			"bash.patterns": [userDeny, userAllow],
			"tools.pathRules": [userPathDeny, { glob: "docs/**", action: "allow" }],
		});
		const mapped = mapClaudePermissions({
			deny: [],
			ask: ["Bash(git push origin main)", "Read(secrets/**)"],
			allow: [],
		});
		applyClaudePermissions(settings, mapped);
		applyClaudePermissions(settings, mapped);

		const patterns = cfgBashPatterns.get(settings) as readonly { match: string; approval: string }[];
		expect(patterns.map(rule => `${rule.approval}:${rule.match}`)).toEqual([
			"deny:git push *",
			"prompt:git push origin main",
			"allow:git *",
		]);
		const pathRules = cfgToolsPathRules.get(settings) as readonly { glob: string; action: string }[];
		expect(pathRules.map(rule => `${rule.action}:${rule.glob}`)).toEqual([
			"deny:secrets/**",
			"prompt:secrets/**",
			"allow:docs/**",
		]);
	});

	it("maps Claude Read rules onto find as well", () => {
		const { pathRulesBefore } = mapClaudePermissions({ deny: ["Read(./.env)", "Grep(./.env)"], ask: [], allow: [] });
		expect(pathRulesBefore[0]?.tools).toContain("find");
		expect(pathRulesBefore[1]?.tools).toContain("find");
	});

	it("changes nothing for an empty rule set", () => {
		const settings = Settings.isolated();
		applyClaudePermissions(settings, mapClaudePermissions({ allow: [], deny: [], ask: [] }));
		expect(cfgBashPatterns.get(settings)).toEqual([]);
		expect(cfgToolsPathRules.get(settings)).toEqual([]);
	});
});

describe("evaluateRuntimeRules", () => {
	const { runtimeRules } = mapClaudePermissions({
		deny: ["WebFetch(domain:evil.test)"],
		ask: ["WebFetch(domain:docs.test)", "mcp__slack"],
		allow: ["WebFetch"],
	});

	it("matches the domain and its subdomains, only on URL reads", () => {
		expect(evaluateRuntimeRules(runtimeRules, "read", { path: "https://evil.test/x" })).toEqual({
			action: "deny",
			rule: "WebFetch(domain:evil.test)",
		});
		expect(evaluateRuntimeRules(runtimeRules, "read", { path: "https://a.evil.test/x" })?.action).toBe("deny");
		expect(evaluateRuntimeRules(runtimeRules, "read", { path: "https://docs.test/x" })?.action).toBe("prompt");
		expect(evaluateRuntimeRules(runtimeRules, "read", { path: "https://other.test/x" })).toBeUndefined();
		expect(evaluateRuntimeRules(runtimeRules, "read", { path: "evil.test/notes.txt" })).toBeUndefined();
		expect(evaluateRuntimeRules(runtimeRules, "bash", { command: "curl https://evil.test" })).toBeUndefined();
	});

	it("matches an MCP server's tools by prefix", () => {
		expect(evaluateRuntimeRules(runtimeRules, "mcp__slack_post", {})?.action).toBe("prompt");
		expect(evaluateRuntimeRules(runtimeRules, "mcp__slackbot_post", {})).toBeUndefined();
	});
});
