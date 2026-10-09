/**
 * `trace`: one-call "who defines / calls / handles / publishes / emits X"
 * answered from the persistent {@link Codemap} index, with no model involved.
 * The tool contract and model-facing text live here; the index and queries
 * live in `../codemap`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { Codemap, renderSearch, renderTrace } from "../codemap";
import traceDescription from "../prompts/tools/trace.md" with { type: "text" };
import type { ToolSession } from ".";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";
import { toolResult } from "./tool-result";

const traceSchema = type({
	symbol: type("string").describe("identifier to trace, or several search words"),
	"path?": type("string").describe("file or directory to restrict results to"),
	"depth?": type("number").describe("1 (default) to 3; 2+ follows event chains and caller chains"),
});

export type TraceToolInput = typeof traceSchema.infer;

export interface TraceToolDetails {
	symbol: string;
	depth: number;
	mode: "trace" | "search";
	/** Whether the index knows the symbol; false means the text lists search matches instead. */
	found: boolean;
	/** Files the refresh re-parsed and the index's total source files. */
	reparsed: number;
	files: number;
	meta?: OutputMeta;
}

const MAX_DEPTH = 3;

/**
 * The index covers the session cwd; `input` narrows results inside it.
 * @throws ToolError when `input` is outside the cwd or does not exist.
 */
export function resolveCodemapScope(
	cwd: string,
	rawInput: string | undefined,
): { root: string; scope: string | undefined } {
	const root = path.resolve(cwd);
	let scope: string | undefined;
	const input = rawInput === undefined ? "" : normalizePathLikeInput(rawInput);
	if (input.length > 0) {
		const target = resolveToCwd(input, cwd);
		const relative = path.relative(root, target);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new ToolError(`Path is outside the working directory: ${input}`);
		}
		if (!fs.existsSync(target)) throw new ToolError(`Path not found: ${input}`);
		if (relative !== "") scope = relative.split(path.sep).join("/");
	}
	return { root, scope };
}

/** Code-intelligence tool: definitions, callers, handlers, publishers, and emitters of a symbol from the codemap index. */
export class TraceTool implements AgentTool<typeof traceSchema, TraceToolDetails> {
	readonly name = "trace";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Trace";
	readonly summary = "Who defines, calls, handles, publishes, or emits a symbol, from a persistent code index";
	readonly description = traceDescription;
	readonly parameters = traceSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: TraceToolInput,
		signal?: AbortSignal,
	): Promise<AgentToolResult<TraceToolDetails>> {
		const symbol = params.symbol.trim();
		if (symbol.length === 0) throw new ToolError("`symbol` must be a non-empty identifier or search words");
		const depth = Math.min(MAX_DEPTH, Math.max(1, Math.floor(params.depth ?? 1)));
		const cwd = this.session.cwd;

		const { root, scope } = resolveCodemapScope(cwd, params.path);

		const started = performance.now();
		const codemap = await Codemap.open(root, { cwd, scope, signal });
		try {
			const mode = symbol.includes(" ") ? "search" : "trace";
			let found = true;
			let text: string;
			if (mode === "search") {
				const result = codemap.query.search(symbol);
				found = result.hits.length > 0;
				text = renderSearch(result);
			} else {
				const result = codemap.query.trace(symbol, depth);
				found = result.found;
				text = renderTrace(result);
			}
			const { stats } = codemap;
			if (stats.reparsed > 0 || stats.removed > 0) {
				text += `\n\nindex refreshed: ${stats.reparsed} files re-parsed, ${stats.removed} removed, ${stats.files} total · ${formatDuration(performance.now() - started)}`;
			}
			const details: TraceToolDetails = { symbol, depth, mode, found, reparsed: stats.reparsed, files: stats.files };
			const builder = toolResult(details).text(text);
			if (!found) builder.useless();
			return builder.done();
		} finally {
			codemap.close();
		}
	}
}
