import { describe, expect, it } from "bun:test";
import {
	claudeToolInput,
	claudeToolNames,
	matcherSelectsTool,
	ompToolsForClaudeName,
} from "@oh-my-pi/pi-coding-agent/claude-compat/tool-names";

describe("Claude tool-name mapping", () => {
	it("selects omp tools by Claude matcher names", () => {
		expect(matcherSelectsTool("Bash", "bash")).toBe(true);
		expect(matcherSelectsTool("Read", "read", { path: "src/a.ts" })).toBe(true);
		expect(matcherSelectsTool("Grep", "grep")).toBe(true);
		expect(matcherSelectsTool("Glob", "glob")).toBe(true);
		expect(matcherSelectsTool("Write", "write")).toBe(true);
		expect(matcherSelectsTool("Edit", "edit")).toBe(true);
		expect(matcherSelectsTool("Bash", "read", { path: "x" })).toBe(false);
	});

	it("treats a URL read as WebFetch, not Read", () => {
		const input = { path: "https://example.com/doc" };
		expect(claudeToolNames("read", input)).toEqual(["WebFetch"]);
		expect(matcherSelectsTool("WebFetch", "read", input)).toBe(true);
		expect(matcherSelectsTool("Read", "read", input)).toBe(false);
	});

	it("anchors regex matchers and honors the match-all forms", () => {
		expect(matcherSelectsTool("Edit|Write", "write")).toBe(true);
		expect(matcherSelectsTool("Edit|Write", "bash")).toBe(false);
		expect(matcherSelectsTool("Bas", "bash")).toBe(false);
		expect(matcherSelectsTool("mcp__.*", "mcp__github_search")).toBe(true);
		expect(matcherSelectsTool("*", "anything")).toBe(true);
		expect(matcherSelectsTool(undefined, "anything")).toBe(true);
	});

	it("is case-sensitive like Claude and survives an invalid regex", () => {
		expect(matcherSelectsTool("bash", "read")).toBe(false);
		expect(matcherSelectsTool("(", "bash")).toBe(false);
	});

	it("exposes Claude's documented tool_input fields next to omp's", () => {
		expect(claudeToolInput("bash", { command: "ls" })).toEqual({ command: "ls" });
		expect(claudeToolInput("write", { path: "a.txt", content: "x" })).toMatchObject({
			file_path: "a.txt",
			content: "x",
		});
		expect(claudeToolInput("read", { path: "https://e.com" })).toMatchObject({ url: "https://e.com" });
	});

	it("maps a bare Edit or Write rule onto every file-mutating omp tool", () => {
		expect([...ompToolsForClaudeName("Edit")].sort()).toEqual(["ast_edit", "edit", "write"]);
		expect([...ompToolsForClaudeName("Write")].sort()).toEqual(["ast_edit", "edit", "write"]);
		expect(ompToolsForClaudeName("WebSearch")).toEqual(["web_search"]);
	});
});
