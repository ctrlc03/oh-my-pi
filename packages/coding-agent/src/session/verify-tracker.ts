import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import verifyFailurePrompt from "../prompts/system/verify-failure.md" with { type: "text" };
import { createChangedPathMatcher, tailOutput, type VerifyOutcome, type VerifyRunOptions } from "../verify/run";
import {
	cfgVerifyCommand,
	cfgVerifyMaxAttempts,
	cfgVerifyMaxOutputChars,
	cfgVerifyPaths,
	cfgVerifyTimeoutMs,
	cfgVerifyWhen,
} from "../verify/settings";
import type { CustomMessage } from "./messages";

/** `customType` of the hidden message that carries a failed verification back to the agent. */
export const VERIFY_FAILURE_MESSAGE_TYPE = "verify-failure";

/** `source` of the notices that report verification progress. */
export const VERIFY_NOTICE_SOURCE = "verify";

/** Tools whose successful results change files the agent chose to edit. */
const FILE_CHANGING_TOOLS = new Set(["edit", "write", "ast_edit"]);

interface RecordedCall {
	name: string;
	args: unknown;
}

/** Capabilities the verify tracker borrows from its owning session. */
export interface VerifyTrackerHost {
	settings: Settings;
	cwd(): string;
	sessionKey(): string;
	agentKind(): "main" | "sub";
	planModeEnabled(): boolean;
	getEnabledToolNames(): string[];
	/** Files a tool call writes, when the tool can say (see `AgentTool.matcherPaths`). */
	toolWritePaths(toolName: string, args: unknown): readonly string[] | undefined;
	/** Whether the session is at its spend cap, so a failure could not be handed back to the agent. */
	spendCapped(): boolean;
	emitNotice(level: "info" | "warning" | "error", message: string, source: string): void;
	run(commands: readonly string[], options: VerifyRunOptions): Promise<VerifyOutcome>;
}

/**
 * Runs the configured verification command after the agent changed files and turns a failure into a
 * hidden message for the agent. Off unless `verify.command` is set; main-agent sessions with a bash
 * tool only.
 */
export class VerifyTracker {
	readonly #host: VerifyTrackerHost;
	readonly #calls = new Map<string, RecordedCall>();
	readonly #changedPaths = new Set<string>();
	#unknownChange = false;
	#attempts = 0;

	constructor(host: VerifyTrackerHost) {
		this.#host = host;
	}

	/** Remembers the tool calls of a settled assistant message so their results can name the files they changed. */
	onAssistantMessage(message: AssistantMessage): void {
		if (!this.#configured()) return;
		for (const block of message.content) {
			if (block.type === "toolCall" && FILE_CHANGING_TOOLS.has(block.name)) {
				this.#calls.set(block.id, { name: block.name, args: block.arguments });
			}
		}
	}

	/** Marks the files of a successful file-changing tool call as changed. */
	onToolResult(toolCallId: string, toolName: string, isError: boolean): void {
		const call = this.#calls.get(toolCallId);
		this.#calls.delete(toolCallId);
		if (isError || !FILE_CHANGING_TOOLS.has(toolName) || !this.#configured()) return;
		const paths = this.#host.toolWritePaths(toolName, call?.args);
		if (!paths || paths.length === 0) {
			this.#unknownChange = true;
			return;
		}
		for (const changedPath of paths) this.#changedPaths.add(changedPath);
	}

	/** A new user-initiated prompt starts a fresh budget of automatic fix rounds; the tracker's own follow-up does not. */
	onPromptStart(isVerifyFollowUp: boolean): void {
		if (!isVerifyFollowUp) this.#attempts = 0;
	}

	/** Forgets all per-session state (new or switched session). */
	reset(): void {
		this.#calls.clear();
		this.#changedPaths.clear();
		this.#unknownChange = false;
		this.#attempts = 0;
	}

	/**
	 * Verifies after a turn that changed files while the run continues, for `verify.when: "after-edit"`.
	 * @returns the failure message to steer into the running agent, if any.
	 */
	verifyAfterEdit(signal: AbortSignal): Promise<CustomMessage | undefined> {
		if (cfgVerifyWhen.get(this.#host.settings) !== "after-edit") return Promise.resolve(undefined);
		return this.verify(signal);
	}

	#commands(): string[] {
		return cfgVerifyCommand
			.get(this.#host.settings)
			.map(command => (typeof command === "string" ? command.trim() : ""))
			.filter(command => command.length > 0);
	}

	#configured(): boolean {
		return this.#commands().length > 0 && this.#host.agentKind() === "main";
	}

	#hasQualifyingChange(): boolean {
		if (this.#unknownChange) return true;
		if (this.#changedPaths.size === 0) return false;
		const globs = cfgVerifyPaths.get(this.#host.settings).filter(glob => typeof glob === "string" && glob !== "");
		const matches = createChangedPathMatcher(globs, this.#host.cwd());
		for (const changedPath of this.#changedPaths) if (matches(changedPath)) return true;
		return false;
	}

	/**
	 * Verifies once the agent stopped, whatever `verify.when` says, so edits not yet checked still are.
	 * Pending changes are forgotten only once the command passed or failed: a skipped, cancelled, aborted or
	 * unrunnable check leaves them for the next one.
	 * @returns the failure message to hand the agent as a follow-up turn, or undefined when verification
	 * was skipped (including while the session is spend-capped), passed, was cancelled, or exhausted its fix rounds.
	 */
	async verify(signal: AbortSignal): Promise<CustomMessage | undefined> {
		const commands = this.#commands();
		if (commands.length === 0 || signal.aborted || !this.#hasQualifyingChange()) return undefined;
		if (this.#host.planModeEnabled() || !this.#host.getEnabledToolNames().includes("bash")) {
			logger.debug("Verify: skipped, session cannot run shell commands or is planning");
			return undefined;
		}
		if (this.#host.spendCapped()) {
			logger.debug("Verify: skipped, session is at its spend cap");
			return undefined;
		}

		const settings = this.#host.settings;
		const label = commands.join(" && ");
		this.#host.emitNotice("info", `running ${label}`, VERIFY_NOTICE_SOURCE);
		let outcome: VerifyOutcome;
		try {
			outcome = await this.#host.run(commands, {
				cwd: this.#host.cwd(),
				sessionKey: this.#host.sessionKey(),
				timeoutMs: Math.max(0, Math.floor(cfgVerifyTimeoutMs.get(settings))),
				signal,
			});
		} catch (error) {
			if (signal.aborted) return undefined;
			const reason = error instanceof Error ? error.message : String(error);
			logger.warn("Verify: command could not run", { error: reason });
			this.#host.emitNotice("error", `could not run ${label}: ${reason}`, VERIFY_NOTICE_SOURCE);
			return undefined;
		}
		if (signal.aborted || outcome.kind === "cancelled") return undefined;
		this.#changedPaths.clear();
		this.#unknownChange = false;
		if (outcome.kind === "passed") {
			this.#attempts = 0;
			this.#host.emitNotice("info", "passed", VERIFY_NOTICE_SOURCE);
			return undefined;
		}

		const status = outcome.timedOut
			? `timed out after ${Math.floor(cfgVerifyTimeoutMs.get(settings))} ms`
			: outcome.exitCode === undefined
				? "failed to run"
				: `exit code ${outcome.exitCode}`;
		const maxAttempts = Math.max(0, Math.floor(cfgVerifyMaxAttempts.get(settings)));
		if (this.#attempts >= maxAttempts) {
			this.#host.emitNotice(
				"error",
				`\`${outcome.command}\` failed (${status}); stopping after ${this.#attempts} automatic fix attempt${this.#attempts === 1 ? "" : "s"}`,
				VERIFY_NOTICE_SOURCE,
			);
			return undefined;
		}
		this.#attempts++;
		this.#host.emitNotice(
			"warning",
			`\`${outcome.command}\` failed (${status}); sending the output to the agent (attempt ${this.#attempts}/${maxAttempts})`,
			VERIFY_NOTICE_SOURCE,
		);
		const tail = tailOutput(outcome.output, Math.max(0, Math.floor(cfgVerifyMaxOutputChars.get(settings))));
		return {
			role: "custom",
			customType: VERIFY_FAILURE_MESSAGE_TYPE,
			content: prompt.render(verifyFailurePrompt, {
				command: outcome.command,
				status,
				attempt: this.#attempts,
				maxAttempts,
				output: tail.text,
				outputChars: tail.text.length,
				truncatedChars: tail.truncatedChars,
			}),
			display: false,
			details: { command: outcome.command, exitCode: outcome.exitCode, timedOut: outcome.timedOut },
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}

/** Paths a tool call writes: what the tool reports, else `write`'s `path`; undefined when unknown. */
export function writePathsOfCall(
	toolName: string,
	args: unknown,
	reported: readonly string[] | undefined,
): readonly string[] | undefined {
	if (reported && reported.length > 0) return reported;
	if (toolName === "write" && isRecord(args) && typeof args.path === "string") return [args.path];
	return undefined;
}
