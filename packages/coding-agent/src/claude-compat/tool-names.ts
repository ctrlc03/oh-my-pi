/**
 * Claude Code <-> omp tool name and tool-input translation.
 *
 * Claude names (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebFetch`, …) are what hook matchers and
 * permission rules are written against; omp's tools are lower-case and `read` also fetches URLs.
 */

const URL_PATTERN = /^https?:\/\//i;

/** Claude names an omp tool call answers to. The first entry is reported to hooks as `tool_name`. */
const CLAUDE_NAMES_BY_OMP_TOOL: Record<string, readonly string[]> = {
	bash: ["Bash"],
	read: ["Read"],
	edit: ["Edit", "MultiEdit"],
	ast_edit: ["Edit", "MultiEdit"],
	write: ["Write"],
	grep: ["Grep"],
	glob: ["Glob"],
	web_search: ["WebSearch"],
	task: ["Task"],
	todo: ["TodoWrite"],
};

function isUrlRead(ompTool: string, input: Record<string, unknown> | undefined): boolean {
	return ompTool === "read" && typeof input?.path === "string" && URL_PATTERN.test(input.path.trim());
}

/** Claude names for a call, most specific first. A `read` of a URL is Claude's `WebFetch`. */
export function claudeToolNames(ompTool: string, input?: Record<string, unknown>): readonly string[] {
	if (isUrlRead(ompTool, input)) return ["WebFetch"];
	return CLAUDE_NAMES_BY_OMP_TOOL[ompTool] ?? [ompTool];
}

/**
 * Whether a hook `matcher` selects the call. Claude matchers are case-sensitive, anchored regular
 * expressions over the tool name (`Edit|Write`, `Notebook.*`); `*` and the empty matcher select every tool.
 * The omp tool name is accepted too so `mcp__…` matchers and omp-native names keep working.
 */
export function matcherSelectsTool(
	matcher: string | undefined,
	ompTool: string,
	input?: Record<string, unknown>,
): boolean {
	if (matcher === undefined || matcher === "*") return true;
	const names = [...claudeToolNames(ompTool, input), ompTool];
	let pattern: RegExp;
	try {
		pattern = new RegExp(`^(?:${matcher})$`);
	} catch {
		return names.includes(matcher);
	}
	return names.some(name => pattern.test(name));
}

/** `tool_input` as Claude documents it for the mapped tool, with omp's own fields kept alongside. */
export function claudeToolInput(ompTool: string, input: Record<string, unknown>): Record<string, unknown> {
	const target = typeof input.path === "string" ? input.path : undefined;
	if (isUrlRead(ompTool, input)) return { url: target, ...input };
	switch (ompTool) {
		case "read":
		case "write":
		case "edit":
		case "ast_edit":
			return target === undefined ? input : { file_path: target, ...input };
		case "glob":
			return target === undefined ? input : { pattern: target, ...input };
		default:
			return input;
	}
}

/** Claude's Edit and Write rules govern every omp tool that mutates files. */
const FILE_MUTATION_TOOLS: readonly string[] = ["edit", "ast_edit", "write"];

/** omp tool names a bare Claude tool rule (`Bash`, `Edit`, `WebSearch`, `mcp__server__tool`) governs. */
export function ompToolsForClaudeName(name: string): readonly string[] {
	switch (name) {
		case "Bash":
			return ["bash"];
		case "Read":
			return ["read"];
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
		case "Write":
			return FILE_MUTATION_TOOLS;
		case "Grep":
			return ["grep"];
		case "Glob":
			return ["glob"];
		case "WebSearch":
			return ["web_search"];
		case "Task":
			return ["task"];
		case "TodoWrite":
			return ["todo"];
		default:
			return [];
	}
}
