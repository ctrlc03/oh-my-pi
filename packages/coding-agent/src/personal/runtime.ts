/**
 * The session side of the Personal agent (docs/personal-agent.md), one per top-level session with
 * `personal.enabled`. It ties together what the pieces of this folder do:
 *
 * - the turn guard ({@link PersonalTurnGuard}): the origin of the turn in progress and the external-turn policy;
 * - for a `live` session, the event receiver, the heartbeat and the `hello` to the companion;
 * - the notify book that limits `notify_owner`.
 *
 * A `review` run (the nightly learning pass) gets the guard and the notify book only: it takes no events and
 * does not beat. `AgentSession` builds one when the setting is on and forwards its events; with the setting off
 * none exists and nothing here runs.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { getBaseConfigRoot, logger } from "@oh-my-pi/pi-utils";
import { PERSONAL_RUN_DIR, type PersonalTurnOrigin } from "@oh-my-pi/pi-wire/personal-ipc";
import type { Settings } from "../config/settings";
import { resolveToolTier } from "../tools/approval";
import { PersonalBeatWriter } from "./beat";
import { type PersonalEventDelivery, type PersonalEventMessage, PersonalEventReceiver } from "./events";
import { PersonalTurnGuard, type TurnMessage } from "./external-turns";
import { type PersonalCompanion, personalCompanion } from "./ipc-client";
import { NotifyBook } from "./notify-book";
import {
	cfgPersonalEnabled,
	cfgPersonalEventsMaxPerHour,
	cfgPersonalEventsMaxPerSourcePerHour,
	cfgPersonalEventsPollSeconds,
	cfgPersonalRunKind,
} from "./settings";

/** `<config root>/run/personal`: the event channel, shared by every profile like `run/pr-watch`. */
export function personalRunDir(): string {
	return path.join(getBaseConfigRoot(), "run", PERSONAL_RUN_DIR);
}

/** After `control exit`, how long the graceful shutdown has before the session is torn down by force. */
const EXIT_GRACE_MS = 60_000;

/** The session's side of the contract: what the runtime needs to read and do. */
export interface PersonalRuntimeHost {
	settings: Settings;
	/** The profile's agent directory (owner key, endpoint file, spend ledger). */
	agentDir: string;
	/** `<config root>/run/personal`. */
	runDir: string;
	/** Subagents never get a runtime. */
	topLevel: boolean;
	sessionId(): string;
	isBusy(): boolean;
	isDisposed(): boolean;
	/** A rolling spend limit has stopped the session. */
	capped(): "day" | "month" | undefined;
	deliveredEventIds(): Iterable<string>;
	deliver(message: PersonalEventMessage, delivery: PersonalEventDelivery): Promise<unknown>;
	/** Ask the host for its normal graceful exit (memory retained and consolidated). */
	requestExit(): void;
	/** Tear the session down and end the process: the fallback when the graceful exit did not happen. */
	forceExit(): Promise<void>;
	subscribeRunState(listener: (state: "running" | "idle") => void): () => void;
	/** The companion's channel; defaults to the one published in `agentDir`. */
	companion?: PersonalCompanion;
	now?: () => number;
}

/** The minimal shape of the agent events the runtime follows. */
export interface PersonalAgentEvent {
	type: string;
	message?: TurnMessage;
	toolName?: string;
	toolCallId?: string;
}

export class PersonalRuntime {
	readonly runKind: "live" | "review";
	readonly guard: PersonalTurnGuard;
	readonly book: NotifyBook;
	readonly companion: PersonalCompanion;
	readonly #host: PersonalRuntimeHost;
	readonly #receiver: PersonalEventReceiver | undefined;
	readonly #beat: PersonalBeatWriter | undefined;
	#pollTimer: ReturnType<typeof setTimeout> | undefined;
	#exitTimer: ReturnType<typeof setTimeout> | undefined;
	#unsubscribe: (() => void) | undefined;
	/** `ask` calls waiting on the owner: the heartbeat's `inputRequired`. An approval prompt is not visible from here; the companion also sees it in the host's registry row. */
	readonly #asking = new Set<string>();
	#disposed = false;

	private constructor(host: PersonalRuntimeHost) {
		this.#host = host;
		this.runKind = cfgPersonalRunKind.get(host.settings);
		this.guard = new PersonalTurnGuard(host.settings);
		this.book = new NotifyBook(host.now);
		this.companion = host.companion ?? personalCompanion(host.agentDir);
		if (this.runKind === "live") {
			this.#receiver = new PersonalEventReceiver({
				runDir: host.runDir,
				agentDir: host.agentDir,
				sessionId: () => host.sessionId(),
				isBusy: () => host.isBusy(),
				isDisposed: () => host.isDisposed() || this.#disposed,
				isCapped: () => host.capped() !== undefined,
				deliveredEventIds: () => host.deliveredEventIds(),
				deliver: (message, delivery) => host.deliver(message, delivery),
				exit: () => this.#exit(),
				receipt: (eventId, outcome, detail) =>
					this.companion.receipt({ sessionId: host.sessionId(), eventId, outcome, detail }),
				answered: itemId => this.book.answered(itemId),
				maxPerSourcePerHour: () => cfgPersonalEventsMaxPerSourcePerHour.get(host.settings),
				maxPerHour: () => cfgPersonalEventsMaxPerHour.get(host.settings),
				now: host.now ?? Date.now,
			});
			this.#beat = new PersonalBeatWriter(
				host.runDir,
				{
					sessionId: () => host.sessionId(),
					busy: () => host.isBusy(),
					inputRequired: () => this.#asking.size > 0,
					capped: () => host.capped(),
				},
				host.now,
			);
		}
	}

	/** The runtime for a top-level session with `personal.enabled`; undefined for everything else. */
	static createIf(host: PersonalRuntimeHost): PersonalRuntime | undefined {
		if (!host.topLevel || !cfgPersonalEnabled.get(host.settings)) return undefined;
		return new PersonalRuntime(host);
	}

	/** Begin watching the inbox and beating (live sessions); follow the run state either way. */
	start(): void {
		this.#unsubscribe = this.#host.subscribeRunState(state => {
			if (state !== "idle") return;
			this.guard.onIdle();
			this.#beat?.beat();
			void this.#receiver?.tick();
		});
		if (!this.#receiver || !this.#beat) return;
		this.#beat.start();
		this.companion
			.hello({ sessionId: this.#host.sessionId(), pid: process.pid })
			.catch(error => logger.debug("personal hello not sent", { error: String(error) }));
		this.#schedulePoll(cfgPersonalEventsPollSeconds.get(this.#host.settings) * 1000);
	}

	/** Feed the agent's events in: they tell which message started the turn in progress. */
	onAgentEvent(event: PersonalAgentEvent): void {
		if (event.type === "agent_start") this.guard.onRunStart();
		else if (event.type === "message_start" && event.message) this.guard.onMessageStart(event.message);
		else if (event.type === "message_end" && event.message) this.guard.onMessageEnd(event.message);
		else if (event.toolName === "ask" && event.toolCallId !== undefined) {
			if (event.type === "tool_execution_start") this.#asking.add(event.toolCallId);
			else if (event.type === "tool_execution_end") this.#asking.delete(event.toolCallId);
			else return;
			this.#beat?.beat();
		}
	}

	/** Origin of the turn in progress, for `notify_owner`. */
	currentOrigin(): PersonalTurnOrigin {
		return this.guard.origin;
	}

	/**
	 * Why a tool call is refused in the turn in progress, or undefined. A `write` to `xd://<device>` is judged as the
	 * device it runs (`device` finds it by name): the transport's own tier says nothing about `memory_edit` or `schedule`.
	 */
	refuseToolCall(
		tool: Pick<AgentTool, "name" | "approval">,
		args: unknown,
		device: (name: string) => Pick<AgentTool, "name" | "approval"> | undefined,
	): string | undefined {
		if (!this.guard.tainted) return undefined;
		const target = tool.name === "write" ? xdDeviceCall(args) : undefined;
		const inner = target && device(target.name);
		if (inner) {
			const refusal = this.guard.refusal(inner.name, resolveToolTier(inner, target.args));
			if (refusal !== undefined) return refusal;
		}
		return this.guard.refusal(tool.name, resolveToolTier(tool, args));
	}

	/** Refresh the heartbeat now (state changed). */
	beat(): void {
		this.#beat?.beat();
	}

	/** Look at the inbox in `delayMs`, then again every `personal.events.pollSeconds`. The first look waits a poll interval so the session finishes starting up. */
	#schedulePoll(delayMs: number): void {
		if (this.#disposed) return;
		this.#pollTimer = setTimeout(() => {
			void (this.#receiver?.tick() ?? Promise.resolve()).finally(() =>
				this.#schedulePoll(cfgPersonalEventsPollSeconds.get(this.#host.settings) * 1000),
			);
		}, delayMs);
		this.#pollTimer.unref();
	}

	#exit(): void {
		this.#host.requestExit();
		this.#exitTimer = setTimeout(() => {
			if (this.#host.isDisposed()) return;
			logger.warn("personal control exit did not shut the session down: forcing it");
			void this.#host.forceExit();
		}, EXIT_GRACE_MS);
		this.#exitTimer.unref();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#pollTimer);
		clearTimeout(this.#exitTimer);
		this.#unsubscribe?.();
		this.guard.dispose();
		await this.#beat?.stop();
	}
}

/** The device and JSON arguments of a `write` to `xd://<device>`; undefined for any other write. Unparseable content gives no arguments. */
function xdDeviceCall(args: unknown): { name: string; args: unknown } | undefined {
	const target = parseXdUrl(String((args as { path?: unknown } | null)?.path ?? ""));
	if (!target?.name) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String((args as { content?: unknown }).content ?? ""));
	} catch {
		parsed = {};
	}
	return { name: target.name, args: parsed };
}
