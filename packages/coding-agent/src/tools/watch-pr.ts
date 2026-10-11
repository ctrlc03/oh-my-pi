import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { WirePrWatch } from "@oh-my-pi/pi-wire/pr-watch";
import watchPrDescription from "../prompts/tools/watch-pr.md" with { type: "text" };
import { cfgPrWatchEnabled } from "../pr-watch/settings";
import { github } from "../utils/github";
import type { ToolSession } from ".";

const watchPrSchema = type({
	action: "'watch' | 'unwatch' | 'list'",
	"pr?": type("string").describe(
		"pull request URL, owner/repo#N, #N or N; omit for the current branch's pull request (watch only)",
	),
});

export type WatchPrParams = typeof watchPrSchema.infer;

/** One line of what a watched pull request is doing. */
export function describeWatchedPr(pr: WirePrWatch): string {
	const parts: string[] = [pr.state];
	if (pr.state === "open") {
		parts.push(`checks ${pr.checks}`);
		if (pr.conflict) parts.push("merge conflict");
		if (pr.review) parts.push(pr.review === "approved" ? "approved" : "changes requested");
	}
	if (pr.error) parts.push(`last poll failed: ${pr.error}`);
	return `${pr.key}${pr.title ? ` "${pr.title}"` : ""}: ${parts.join(", ")}`;
}

/** Registers pull requests with the session's watcher (`pr-watch/manager.ts`), which wakes the agent when one needs it. */
export class WatchPrTool implements AgentTool<typeof watchPrSchema> {
	readonly name = "watch_pr";
	readonly approval = (args: unknown) => {
		const action = typeof args === "object" && args !== null && "action" in args ? args.action : undefined;
		return action === "list" ? ("read" as const) : ("write" as const);
	};
	readonly label = "Watch PR";
	readonly description = watchPrDescription;
	readonly parameters = watchPrSchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Watch a pull request and wake the session when its checks fail or someone reviews";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WatchPrTool | null {
		if (!cfgPrWatchEnabled.get(session.settings) || !session.getPrWatch || (session.taskDepth ?? 0) > 0) return null;
		if (!github.available()) return null;
		return new WatchPrTool(session);
	}

	async execute(_id: string, params: WatchPrParams): Promise<AgentToolResult> {
		const watcher = this.session.getPrWatch?.();
		if (!watcher) throw new ToolError("PR watching is not available in this session.");
		if (params.action === "list") {
			const watched = watcher.list();
			return text(
				watched.length === 0 ? "No pull requests are watched." : watched.map(describeWatchedPr).join("\n"),
			);
		}
		if (params.action === "unwatch") {
			if (!params.pr) throw new ToolError("unwatch needs `pr`.");
			if (!watcher.unwatch(params.pr)) throw new ToolError(`${params.pr} is not one of the watched pull requests.`);
			return text(`Stopped watching ${params.pr}.`);
		}
		const { pr, watching } = await watcher.watch(params.pr);
		if (!watching) return text(`${describeWatchedPr(pr)}. Nothing to watch.`);
		return text(
			`Watching ${describeWatchedPr(pr)}. End your turn after pushing: you are woken if required checks fail, someone else reviews or comments, or a conflict appears.`,
		);
	}
}

function text(message: string): AgentToolResult {
	return { content: [{ type: "text", text: message }] };
}
