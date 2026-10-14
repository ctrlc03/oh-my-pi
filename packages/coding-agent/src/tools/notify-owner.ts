import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import {
	MAX_DIGEST_BODY_CHARS,
	MAX_NOTIFY_BODY_CHARS,
	MAX_NOTIFY_OPTION_CHARS,
	MAX_NOTIFY_OPTIONS,
	MAX_NOTIFY_TITLE_CHARS,
	MAX_PROPOSAL_TEXT_CHARS,
	type NotifyOwnerInput,
} from "@oh-my-pi/pi-wire/personal-ipc";
import {
	PersonalCompanionRefusedError,
	PersonalCompanionUnavailableError,
	type PersonalCompanion,
} from "../personal/ipc-client";
import {
	cfgPersonalEnabled,
	cfgPersonalNotifyMaxOpenQuestions,
	cfgPersonalNotifyMaxPerHour,
	cfgPersonalRunKind,
} from "../personal/settings";
import notifyOwnerDescription from "../prompts/tools/notify-owner.md" with { type: "text" };
import type { ToolSession } from ".";

const DIGEST_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const notifyOwnerSchema = type({
	title: type("string").describe("one line the owner sees first (a push notification title)"),
	body: type("string").describe("the message: what happened or what you need, plainly"),
	kind: type.enumerated("info", "question", "proposal", "digest"),
	"options?": type("string[]").describe("question: quick replies the owner can tap; free text is always allowed"),
	"proposal?": type({
		op: type.enumerated("add", "replace", "remove"),
		"section?": type("string").describe("add: the About-you heading to add under"),
		"target?": type("string").describe("replace/remove: the existing About-you line"),
		"text?": type("string").describe("add/replace: the one line to write (no list marker)"),
		rationale: type("string").describe("why: the evidence, in a sentence"),
		"evidence?": type("string[]").describe("ids of the memories this rests on"),
	}).describe("proposal: the single About-you change you suggest"),
	"digest?": type({
		day: type("string").describe("YYYY-MM-DD the digest covers"),
		"learned?": type("string[]").describe("ids of the memories it names as learned"),
	}).describe("digest: what the review covers"),
	"push?": type("boolean").describe("send a push notification (default: yes, except for a digest)"),
});

/** Parameters accepted by the `notify_owner` tool. */
export type NotifyOwnerParams = typeof notifyOwnerSchema.infer;

/** Structured details attached to `notify_owner` results. */
export interface NotifyOwnerToolDetails {
	kind: NotifyOwnerParams["kind"];
	itemId?: string;
	pushed?: boolean;
}

function tooLong(what: string, max: number): ToolError {
	return new ToolError(`${what} is over ${max} characters: shorten it.`);
}

/** The reasons a call cannot go out as given; thrown before anything is sent. */
function validate(params: NotifyOwnerParams, runKind: "live" | "review"): void {
	if (params.title.trim() === "") throw new ToolError("title is required.");
	if (params.body.trim() === "") throw new ToolError("body is required.");
	if (params.title.length > MAX_NOTIFY_TITLE_CHARS) throw tooLong("title", MAX_NOTIFY_TITLE_CHARS);
	const maxBody = params.kind === "digest" ? MAX_DIGEST_BODY_CHARS : MAX_NOTIFY_BODY_CHARS;
	if (params.body.length > maxBody) throw tooLong("body", maxBody);
	if (params.options !== undefined) {
		if (params.kind !== "question") throw new ToolError("options only apply to kind: question.");
		if (params.options.length > MAX_NOTIFY_OPTIONS) throw new ToolError(`at most ${MAX_NOTIFY_OPTIONS} options.`);
		if (params.options.some(option => option.trim() === "" || option.length > MAX_NOTIFY_OPTION_CHARS)) {
			throw new ToolError(`each option is 1 to ${MAX_NOTIFY_OPTION_CHARS} characters.`);
		}
	}
	if (params.kind === "digest") {
		if (runKind !== "review") {
			throw new ToolError("A digest can only be written by the nightly review run, not in this session.");
		}
		if (params.digest === undefined || !DIGEST_DAY_RE.test(params.digest.day)) {
			throw new ToolError("kind: digest needs digest.day as YYYY-MM-DD.");
		}
	} else if (params.digest !== undefined) {
		throw new ToolError("digest only applies to kind: digest.");
	}
	if (params.kind === "proposal") validateProposal(params.proposal);
	else if (params.proposal !== undefined) throw new ToolError("proposal only applies to kind: proposal.");
}

function validateProposal(proposal: NotifyOwnerParams["proposal"]): void {
	if (proposal === undefined) throw new ToolError("kind: proposal needs the proposal object.");
	for (const [name, value] of [
		["text", proposal.text],
		["target", proposal.target],
		["rationale", proposal.rationale],
	] as const) {
		if (value !== undefined && value.length > MAX_PROPOSAL_TEXT_CHARS)
			throw tooLong(`proposal.${name}`, MAX_PROPOSAL_TEXT_CHARS);
		if (name !== "rationale" && value !== undefined && /[\r\n]/.test(value)) {
			throw new ToolError(`proposal.${name} is one line; propose one line at a time.`);
		}
	}
	if (proposal.rationale.trim() === "")
		throw new ToolError("proposal.rationale is required: say what the proposal rests on.");
	if (proposal.op === "add" && (!proposal.section?.trim() || !proposal.text?.trim())) {
		throw new ToolError("proposal op add needs section and text.");
	}
	if (proposal.op === "replace" && (!proposal.target?.trim() || !proposal.text?.trim())) {
		throw new ToolError("proposal op replace needs target and text.");
	}
	if (proposal.op === "remove" && !proposal.target?.trim()) throw new ToolError("proposal op remove needs target.");
}

/**
 * Tell the owner something through the companion: an inbox item and, unless it is quiet, a push to their
 * devices. The Personal agent's only way to reach the owner unprompted. Limited per hour and by open
 * questions; the companion refuses a proposal the owner already rejected, and its message is the tool's error.
 */
export class NotifyOwnerTool implements AgentTool<typeof notifyOwnerSchema, NotifyOwnerToolDetails> {
	readonly name = "notify_owner";
	readonly approval = "read" as const;
	readonly label = "Notify owner";
	readonly summary = "Tell the owner something, ask them a question, or propose a change to About you";
	readonly description = prompt.render(notifyOwnerDescription, {
		titleChars: MAX_NOTIFY_TITLE_CHARS,
		bodyChars: MAX_NOTIFY_BODY_CHARS,
		optionCount: MAX_NOTIFY_OPTIONS,
		optionChars: MAX_NOTIFY_OPTION_CHARS,
		proposalChars: MAX_PROPOSAL_TEXT_CHARS,
	});
	readonly parameters = notifyOwnerSchema;
	readonly strict = true;

	constructor(
		private readonly session: ToolSession,
		private readonly companion?: PersonalCompanion,
	) {}

	/**
	 * Create the tool for top-level sessions of a Personal agent. The runtime itself is not there yet while the tools are built
	 * (the session that owns it is built after them), so only the accessor is checked; `execute` reads the runtime.
	 */
	static createIf(session: ToolSession): NotifyOwnerTool | null {
		return cfgPersonalEnabled.get(session.settings) && (session.taskDepth ?? 0) === 0 && session.getPersonal
			? new NotifyOwnerTool(session)
			: null;
	}

	async execute(
		_toolCallId: string,
		params: NotifyOwnerParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<NotifyOwnerToolDetails>> {
		const personal = this.session.getPersonal?.();
		const sessionId = this.session.getSessionId?.();
		if (!personal || !sessionId) throw new ToolError("This session is not a Personal agent session.");
		const runKind = cfgPersonalRunKind.get(this.session.settings);
		validate(params, runKind);
		const refusal = personal.book.refusal(params.kind, {
			maxPerHour: cfgPersonalNotifyMaxPerHour.get(this.session.settings),
			maxOpenQuestions: cfgPersonalNotifyMaxOpenQuestions.get(this.session.settings),
		});
		if (refusal) throw new ToolError(refusal);
		const item: NotifyOwnerInput = {
			title: params.title,
			body: params.body,
			kind: params.kind,
			...(params.options ? { options: params.options } : {}),
			...(params.proposal ? { proposal: params.proposal } : {}),
			...(params.digest ? { digest: params.digest } : {}),
			...(params.push !== undefined ? { push: params.push } : {}),
		};
		try {
			const companion = this.companion ?? personal.companion;
			const sent = await companion.notify({ sessionId, runKind, origin: personal.currentOrigin(), item }, signal);
			personal.book.record(params.kind, sent.itemId);
			const details: NotifyOwnerToolDetails = { kind: params.kind, itemId: sent.itemId, pushed: sent.pushed };
			return {
				content: [{ type: "text", text: describeSent(params, sent.itemId, sent.pushed) }],
				details,
			};
		} catch (err) {
			if (err instanceof PersonalCompanionUnavailableError || err instanceof PersonalCompanionRefusedError) {
				throw new ToolError(err.message);
			}
			throw err;
		}
	}
}

function describeSent(params: NotifyOwnerParams, itemId: string, pushed: boolean): string {
	const delivery = pushed ? "pushed to their devices and in their inbox" : "in their inbox (no push)";
	switch (params.kind) {
		case "question":
			return `Question sent (${delivery}, item ${itemId}). Do not wait for the answer: carry on without it. It arrives later as an owner event with the answer.`;
		case "proposal":
			return `Proposal sent (${delivery}, item ${itemId}). Nothing in About you changes unless the owner accepts it; do not propose it again.`;
		case "digest":
			return `Digest recorded (${delivery}, item ${itemId}).`;
		default:
			return `Sent (${delivery}, item ${itemId}).`;
	}
}
