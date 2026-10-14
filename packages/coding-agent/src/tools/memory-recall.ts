import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { formatCurrentTime, formatMemories } from "../hindsight/content";
import { cfgMnemopiProvenance } from "../mnemopi/settings";
import { fenceUntrusted, untrustedPreamble } from "../personal/fence";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryRecallSchemaBase = type({
	query: type("string").describe("natural language search query"),
});

/** Offered only under `mnemopi.provenance`, where memories from outside content exist and stay out of plain recall. */
const memoryRecallSchemaWithExternal = type({
	query: type("string").describe("natural language search query"),
	"include_external?": type("boolean").describe(
		"also return memories that came from outside content (web pages, email, events); they arrive fenced as untrusted data",
	),
});

type MemoryRecallSchema = typeof memoryRecallSchemaBase | typeof memoryRecallSchemaWithExternal;

export type MemoryRecallParams = typeof memoryRecallSchemaWithExternal.infer;

export class MemoryRecallTool implements AgentTool<MemoryRecallSchema> {
	readonly name = "recall";
	readonly approval = "read" as const;
	readonly label = "Recall";
	/** Memories from outside content exist only under `mnemopi.provenance`; the tool offers them only there. */
	get #offersExternal(): boolean {
		return (
			cfgMemoryBackend.get(this.session.settings) === "mnemopi" && cfgMnemopiProvenance.get(this.session.settings)
		);
	}
	get description(): string {
		return prompt.render(recallDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
			externalMemory: this.#offersExternal,
		});
	}
	get parameters(): MemoryRecallSchema {
		return this.#offersExternal ? memoryRecallSchemaWithExternal : memoryRecallSchemaBase;
	}
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search memory for relevant prior context";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryRecallTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new MemoryRecallTool(session);
	}

	async execute(_id: string, params: MemoryRecallParams, signal?: AbortSignal): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const backend = cfgMemoryBackend.get(this.session.settings);
			if (backend === "mnemopi") {
				const state = this.session.getMnemopiSessionState?.();
				if (!state) {
					throw new Error("Mnemopi backend is not initialised for this session.");
				}
				try {
					const results = await state.recallResultsScoped(params.query);
					const external = params.include_external
						? await state.recallResultsScoped(params.query, { externalOnly: true })
						: [];
					if (results.length === 0 && external.length === 0) {
						return {
							content: [{ type: "text", text: "No relevant memories found." }],
							details: {},
							useless: true,
						};
					}
					const sections: string[] = [];
					if (results.length > 0) {
						sections.push(
							`Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${state.formatScopedRecallWithIds(results)}`,
						);
					}
					if (external.length > 0) {
						const fenced = fenceUntrusted(
							"memory from outside content",
							state.formatScopedRecallWithIds(external),
						);
						sections.push(
							`${external.length} ${external.length === 1 ? "memory" : "memories"} came from outside content, not from the owner or you:\n${untrustedPreamble(fenced.nonce)}\n${fenced.block}`,
						);
					}
					return {
						content: [{ type: "text", text: sections.join("\n\n") }],
						details: {},
					};
				} catch (err) {
					logger.warn("recall failed", { backend: "mnemopi", bank: state.config.bank, error: String(err) });
					throw err instanceof Error ? err : new Error(String(err));
				}
			}

			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}

			try {
				const response = await state.client.recall(state.bankId, params.query, {
					budget: state.config.recallBudget,
					maxTokens: state.config.recallMaxTokens,
					types: state.config.recallTypes.length > 0 ? state.config.recallTypes : undefined,
					tags: state.recallTags,
					tagsMatch: state.recallTagsMatch,
				});
				const results = response.results ?? [];
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
						details: {},
						useless: true,
					};
				}
				const formatted = formatMemories(results);
				return {
					content: [
						{
							type: "text",
							text: `Found ${results.length} relevant ${results.length === 1 ? "memory" : "memories"} (as of ${formatCurrentTime()} UTC):\n\n${formatted}`,
						},
					],
					details: {},
				};
			} catch (err) {
				logger.warn("recall failed", { bankId: state.bankId, error: String(err) });
				throw err instanceof Error ? err : new Error(String(err));
			}
		});
	}
}
