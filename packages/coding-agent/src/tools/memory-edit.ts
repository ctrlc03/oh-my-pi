import { type } from "@oh-my-pi/omptype";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { MnemopiMemoryEditResult } from "../mnemopi/state";
import { cfgMnemopiProvenance, cfgMnemopiRetention } from "../mnemopi/settings";
import memoryEditDescription from "../prompts/tools/memory-edit.md" with { type: "text" };
import { sessionMemoryToolRefs } from "../memory-backend/tool-names";
import type { ToolSession } from ".";

import { cfgMemoryBackend } from "../memory-backend/settings";

const memoryEditSchema = type({
	op: type("'update' | 'forget' | 'invalidate'").describe("memory edit operation"),
	id: type("string").describe("memory id from recall output"),
	"content?": type("string").describe("replacement content for update"),
	"importance?": type("number").describe("replacement importance for update (0–1)"),
	"replacement_id?": type("string").describe("replacement memory id for invalidate"),
});

export type MemoryEditParams = typeof memoryEditSchema.infer;

export class MemoryEditTool implements AgentTool<typeof memoryEditSchema> {
	readonly name = "memory_edit";
	readonly approval = "read" as const;
	readonly label = "Memory Edit";
	get description(): string {
		return prompt.render(memoryEditDescription, {
			toolRefs: sessionMemoryToolRefs(this.session),
			permanentRetention: cfgMnemopiRetention.get(this.session.settings) === "permanent",
			provenanceRules: cfgMnemopiProvenance.get(this.session.settings),
		});
	}
	readonly parameters = memoryEditSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Update, forget, or invalidate Mnemopi memories";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): MemoryEditTool | null {
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "mnemopi") return null;
		return new MemoryEditTool(session);
	}

	async execute(_id: string, params: MemoryEditParams): Promise<AgentToolResult> {
		const state = this.session.getMnemopiSessionState?.();
		if (!state) {
			throw new Error("Mnemopi backend is not initialised for this session.");
		}
		if (params.op === "update" && params.content === undefined && params.importance === undefined) {
			throw new Error("memory_edit update requires content or importance.");
		}

		const importance = params.importance === undefined ? undefined : Math.max(0, Math.min(1, params.importance));
		const result = state.editScopedMemory(params.op, params.id, {
			content: params.content,
			importance,
			replacementId: params.replacement_id,
		});
		const location = result.bank ? ` in bank ${result.bank}${result.store ? ` (${result.store})` : ""}` : "";
		const text = editResultText(params, result, location);
		return {
			content: [{ type: "text", text }],
			details: result,
		};
	}
}

/** What the agent is told about an edit: the outcome, or why the row was left as it is. */
function editResultText(params: MemoryEditParams, result: MnemopiMemoryEditResult, location: string): string {
	const id = params.id;
	switch (result.status) {
		case "not_found":
			return `Memory ${id} was not found${location}.`;
		case "not_editable":
			return `Memory ${id} is a read-only fact${location}; it cannot be edited. Read it with memory://${id}.`;
		case "protected":
			return result.reason === "origin"
				? `Memory ${id} was not written by you${location}: it holds the owner's words or text from outside, so it cannot be rewritten. Invalidate it and retain a corrected memory instead.`
				: result.reason === "pinned"
					? `Memory ${id} is pinned by the owner${location}; it stays exactly as it is. Tell the owner if it looks wrong, and leave it to them to unpin it.`
					: `Memory ${id} was retracted by the owner${location}; leave it as it is.`;
		default:
			return result.kept
				? `Memory ${id} forgotten${location}: it is retired from recall, and the row is kept (retention is permanent).`
				: `Memory ${id} ${result.status}${location}.`;
	}
}
