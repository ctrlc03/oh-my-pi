/**
 * `flow`: one-call "how does A lead to B" across Solidity, Rust, and Noir,
 * walked over the persistent {@link Codemap} graph and pruned by the session's
 * judge. The tool contract and model-facing text live here; the walk lives in
 * `../codemap/flow`.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { Codemap, type FlowStats, renderFlow, runFlow } from "../codemap";
import { sessionResolveContext } from "../internal-urls/context";
import { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { hasNativeJudge, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import flowDescription from "../prompts/tools/flow.md" with { type: "text" };
import type { ToolSession } from ".";
import { toolResult } from "./tool-result";
import { resolveCodemapScope } from "./trace";

const flowSchema = type({
	question: type("string").describe("the flow to trace, as a question or a 'from A to B' description"),
	"from?": type("string").describe(
		"symbol to start from (`name` or `Owner::name`) instead of discovering entry points",
	),
	"path?": type("string").describe("file or directory to restrict the walk to"),
	"hops?": type("number").describe("edges to follow from the entry points; default 5, at most 8"),
});

export type FlowToolInput = typeof flowSchema.infer;

export interface FlowToolDetails {
	question: string;
	from?: string;
	mode: "judged" | "structural";
	steps: number;
	alsoConsider: number;
	stats: FlowStats;
	/** Files the index refresh re-parsed and the index's total source files. */
	reparsed: number;
	files: number;
	meta?: OutputMeta;
}

/** Wall-clock budget for one `flow` call: entry search, then one judged batch per hop. */
const FLOW_TIMEOUT_MS = 90_000;

/** Flow tool: entry points, cross-language edges, and judge-pruned steps for a multi-step question. */
export class FlowTool implements AgentTool<typeof flowSchema, FlowToolDetails> {
	readonly name = "flow";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Flow";
	readonly summary = "Trace a multi-step flow across Solidity, Rust, and Noir from a question, in one call";
	readonly description = flowDescription;
	readonly parameters = flowSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: FlowToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FlowToolDetails>,
	): Promise<AgentToolResult<FlowToolDetails>> {
		const question = params.question.trim();
		if (question.length === 0) throw new ToolError("`question` must describe the flow to trace");
		const from = params.from?.trim() || undefined;
		const cwd = this.session.cwd;
		const { root, scope } = resolveCodemapScope(cwd, params.path);

		const { settings, modelRegistry: registry } = this.session;
		// Probabilities need a calibrated native judge; a prompted model would only add noise, so walk structurally.
		const judge =
			registry && hasNativeJudge(settings, registry)
				? resolveJudge({
						settings,
						registry,
						sessionId: this.session.getSessionId?.() ?? undefined,
						purpose: "flow",
						onUsage: journalJudgmentUsage(this.session.sessionManager),
						telemetry: this.session.getTelemetry?.(),
						cache: sharedJudgmentCache(),
					})
				: undefined;
		const filesystem = new InternalUrlFilesystem({
			context: sessionResolveContext(this.session, { signal }),
			tier: this.approval,
		});
		const timeout = AbortSignal.timeout(FLOW_TIMEOUT_MS);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

		const started = performance.now();
		const codemap = await Codemap.open(root, { cwd, scope, signal: combined });
		try {
			const result = await runFlow(codemap, {
				question,
				from,
				hops: params.hops,
				judge,
				searchRoot: scope === undefined ? root : path.join(root, scope),
				filesystem,
				signal: combined,
				onProgress: message => onUpdate?.({ content: [{ type: "text", text: message }] }),
			});
			let text = renderFlow(result);
			const { stats } = codemap;
			if (stats.reparsed > 0 || stats.removed > 0) {
				text += `\n\nindex refreshed: ${stats.reparsed} files re-parsed, ${stats.removed} removed, ${stats.files} total · ${formatDuration(performance.now() - started)}`;
			}
			const details: FlowToolDetails = {
				question,
				from,
				mode: result.mode,
				steps: result.steps.length,
				alsoConsider: result.alsoConsider.length,
				stats: result.stats,
				reparsed: stats.reparsed,
				files: stats.files,
			};
			const builder = toolResult(details).text(text);
			if (result.steps.length === 0) builder.useless();
			return builder.done();
		} catch (error) {
			if (timeout.aborted && !signal?.aborted)
				throw new ToolError(`flow timed out after ${formatDuration(FLOW_TIMEOUT_MS)}`);
			throw error;
		} finally {
			codemap.close();
		}
	}
}
