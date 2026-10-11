/**
 * A collab host for a vendor coding agent (Claude Code, Codex, Cursor, Grok, OpenCode, a custom ACP
 * command): the room, the guests, the transcript and the registry entry are ours, the agent is a child
 * process behind the Agent Client Protocol (`./acp-session.ts`), and `./translate.ts` turns what it says
 * into the entries and events the app already draws for omp.
 *
 * What the host decides, so the agent need not be trusted to:
 * - Tool permission. The agent's own "always allow" options are never offered or sent: a grant "for this
 *   session" is a rule kept here and answered with the agent's one-time allow each time, and `full` access
 *   answers every request with it (recorded in the transcript). The mode can change while the session runs.
 * - Spend. The cost the agent reports is summed; at the cap the turn is cancelled and prompts are refused.
 * - Lifetime. The agent is restarted (reloading its session) when it dies; when it cannot be, the room ends.
 *
 * Mirrors `coding-agent/src/collab/host.ts` where a guest can tell the difference: the same welcome,
 * snapshot, state, entry and event frames, `ui-request` prompts re-posted to a joining writer, and the
 * read-only refusal.
 */

import * as os from "node:os";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	type AgentEvent,
	type AgentSnapshot,
	type AgentRef,
	type CollabFeature,
	type CollabUiRequest,
	type CollabUiRequestDraft,
	type GuestFrame,
	type ImageContent,
	type SessionHeader,
	type SessionPermission,
	type SessionState,
	type WireModel,
} from "@oh-my-pi/pi-wire";
import { publishCollabHost } from "@oh-my-pi/pi-coding-agent/collab/registry";
import type {
	CreateElicitationRequest,
	CreateElicitationResponse,
	PromptResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionUpdate,
} from "@oh-my-pi/pi-utils/acp/protocol";
import type { HostFanout } from "../../src/lib/fanout";
import { isRecord, str } from "../../src/tool-render/util";
import { RequestError } from "@oh-my-pi/pi-utils/acp/transport";
import {
	applyTodoUpdate,
	type CursorQuestion,
	type CursorTodo,
	parseAskQuestion,
	parseCreatePlan,
	parseUpdateTodos,
	planEntries,
	planMarkdown,
} from "./cursor-ext";
import { AcpSession, AgentAuthRequiredError, type SessionSetup } from "./acp-session";
import { type LaunchOpts, type LaunchSpec, launchSpec, vendorModes } from "./agents";
import {
	CheckpointError,
	checkpoint,
	pinRepository,
	previewRestore,
	type RestoreResult,
	redoRestore,
	restoreFiles,
	sessionDiff,
	turnDiff,
} from "./checkpoints";
import { type ForeignIndexRow, readForeignIndex, upsertForeignRow } from "./foreign-index";
import { grantsCover, type SessionGrant } from "./grants";
import { type HelloFrame, RoomHost, type RoomPeer, type WelcomeBody } from "./room-host";
import { type NewEntry, readTranscriptSlice, Transcript } from "./transcript-store";
import {
	type AgentMeta,
	applyMetaUpdate,
	applySetup,
	approvalOutcome,
	choiceKind,
	coalesceOps,
	emptyMeta,
	escalationReason,
	historyDigest,
	planApproval,
	promptBlocks,
	stopMessage,
	toolTargets,
	toolView,
	TurnBuilder,
	type TurnOp,
	wireUsage,
} from "./translate";

/** `message_update` events of a burst are sent as one: the last one wins within this window. */
const OP_FLUSH_MS = 50;
const STATE_DEBOUNCE_MS = 80;
/** A turn that has not ended this long after a cancel ends with the agent process. */
const CANCEL_GRACE_MS = 15_000;
/** Updates that arrive with no turn running (a background task finishing) close their message after this much quiet. */
const AMBIENT_QUIET_MS = 1_500;
const COMMANDS_WAIT_MS = 1_500;
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;
const MAX_TITLE_CHARS = 120;
const MAX_QUEUED = 50;
const MAIN_AGENT_ID = "main";
const ELICITATION_MAX_QUESTIONS = 10;
const APPROVE_PLAN_LABEL = "Approve plan";
const REJECT_PLAN_LABEL = "Reject plan";
const MULTI_DONE_LABEL = "Done";

export interface ForeignHostOptions {
	/** The config root (`~/.omp` or `PI_CONFIG_DIR`): the index, the transcripts and the registry live under it. */
	configDir: string;
	agent: AgentRef;
	cwd: string;
	/** A foreign session id of the index to continue. */
	resume?: string;
	/** The vendor's own model id. */
	model?: string;
	permission: SessionPermission;
	/** Spend cap in USD; absent is no cap. */
	maxCostUsd?: number;
	/** First prompt, sent as soon as the agent is ready. */
	prompt?: string;
	worktree?: boolean;
	fanout?: HostFanout;
	relayUrl?: string;
	localRelayUrl?: string;
	webUrl?: string;
	/** Replaces {@link launchSpec} (tests run a scripted agent). */
	launch?: (id: string, opts: LaunchOpts) => Promise<LaunchSpec>;
	/** Overrides the local registry directory (tests). */
	registryDir?: string;
}

interface QueuedPrompt {
	text: string;
	images?: ImageContent[];
	from: string;
	model?: string;
	thinking?: string;
}

interface PendingUi {
	request: CollabUiRequest;
	resolve(answer: { value: string | undefined; by: string }): void;
}

interface RunningTurn {
	builder: TurnBuilder;
	/** No prompt of ours started it: the agent said something on its own. */
	ambient: boolean;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function newSessionId(agentId: string): string {
	const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${agentId.replaceAll(":", "-")}-${hex}`;
}

/** The turn number a prompt entry carries in its details, or null for an entry that is not one of ours. */
function turnOf(entry: { type: string; customType?: string; details?: unknown } | undefined): number | null {
	if (entry?.type !== "custom_message" || entry.customType !== COLLAB_PROMPT_MESSAGE_TYPE) return null;
	return isRecord(entry.details) && typeof entry.details.turn === "number" ? entry.details.turn : null;
}

export class ForeignHost {
	readonly #o: ForeignHostOptions;
	/** Resolves with the process exit code once the host has shut down. */
	readonly done: Promise<number>;
	readonly #finish: (code: number) => void;
	#sessionId = "";
	#transcript!: Transcript;
	#room!: RoomHost;
	#acp: AcpSession | null = null;
	#meta: AgentMeta = emptyMeta();
	#nativeId: string | null = null;
	#adapterVersion: string | null = null;
	#createdAt = Date.now();
	#startedAt = 0;
	#permission: SessionPermission;
	#rules: SessionGrant[] = [];
	#row!: ForeignIndexRow;
	#busy = false;
	#aborting = false;
	#turn: RunningTurn | null = null;
	#ambientTimer: Timer | undefined;
	#cancelTimer: Timer | undefined;
	#queue: QueuedPrompt[] = [];
	#nextTurn = 1;
	#gitOk = false;
	#snapshotWarned = false;
	/** Why the repository was refused at start, said at the first prompt (nobody is in the room yet). */
	#snapshotRefusal: string | null = null;
	/** The next prompt starts the agent over (a rewind, or a session it could not reload): it is given a digest of what came before. */
	#needsDigest = false;
	/** A fresh agent session is due before the next prompt. */
	#resetPending = false;
	#replaying = false;
	#recovering = false;
	#stopping = false;
	#crashes: number[] = [];
	#spent = 0;
	#tokens = 0;
	#lastReportedCost: number | null = null;
	#capped = false;
	#opBuffer: TurnOp[] = [];
	#opTimer: Timer | undefined;
	#stateTimer: Timer | undefined;
	#lastStateJson = "";
	#lastAgentsJson = "";
	#nextReqId = 1;
	#nextAsk = 1;
	#cursorTodos: CursorTodo[] = [];
	readonly #pendingUi = new Map<number, PendingUi>();
	#publication: { close(): Promise<void> } | null = null;

	constructor(options: ForeignHostOptions) {
		this.#o = options;
		this.#permission = options.permission;
		const done = Promise.withResolvers<number>();
		this.done = done.promise;
		this.#finish = done.resolve;
	}

	/** The room's links, for the process that launched the host. */
	get links(): { control: string; view: string; web: string; webView: string } {
		return {
			control: this.#room.link,
			view: this.#room.viewLink,
			web: this.#room.webLink,
			webView: this.#room.webViewLink,
		};
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	// ── start ────────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		const o = this.#o;
		const rowModel = await this.#openTranscript();
		this.#nextTurn = this.#maxTurn() + 1;
		this.#gitOk = await this.#probeSnapshots();
		await this.#startAgent();
		if (o.model !== undefined && rowModel !== o.model)
			await this.#selectModel(o.model).catch(err =>
				this.#notice("warning", `could not select ${o.model}: ${errorText(err)}`),
			);
		this.#room = new RoomHost({
			relayUrl: o.relayUrl,
			localRelayUrl: o.localRelayUrl,
			webUrl: o.webUrl,
			label: "foreign-host",
			handlers: {
				onHello: (peer, hello) => this.#onHello(peer, hello),
				onFrame: (frame, peer) => void this.#onFrame(frame, peer),
				onPeerLeft: () => this.#scheduleState(),
				onReset: () => this.#scheduleState(),
				onClosed: (reason, willReconnect) => {
					if (!willReconnect && !this.#stopping) void this.stop(`the relay ended the room: ${reason}`, 1);
				},
				onOpen: () => this.#scheduleState(),
				onLocalRelay: () => this.#scheduleState(),
			},
		});
		await this.#room.start();
		await this.#room.opened;
		this.#startedAt = Date.now();
		await this.#publish();
		await this.#persist({});
		if (o.prompt !== undefined && o.prompt.trim() !== "") this.#submit({ text: o.prompt.trim(), from: "host" });
	}

	/** The transcript: a new one, or the one `resume` names. Returns the model the index recorded. */
	async #openTranscript(): Promise<string | null> {
		const o = this.#o;
		if (o.resume !== undefined) {
			const row = (await readForeignIndex(o.configDir)).sessions[o.resume];
			if (row === undefined) throw new Error(`no such session: ${o.resume}`);
			if (row.agent !== o.agent.id)
				throw new Error(`session ${o.resume} belongs to ${row.agent}, not ${o.agent.id}`);
			const transcript = await Transcript.open(o.configDir, o.resume);
			if (transcript === null) throw new Error(`the transcript of ${o.resume} is missing`);
			this.#transcript = transcript;
			this.#sessionId = o.resume;
			this.#nativeId = row.nativeId;
			this.#createdAt = row.createdAt;
			this.#spent = row.costUsd ?? 0;
			this.#row = row;
			return row.model;
		}
		this.#sessionId = newSessionId(o.agent.id);
		const header: SessionHeader = {
			type: "session",
			id: this.#sessionId,
			cwd: o.cwd,
			timestamp: new Date().toISOString(),
		};
		this.#transcript = await Transcript.create(o.configDir, header);
		this.#row = {
			agent: o.agent.id,
			nativeId: null,
			cwd: o.cwd,
			title: null,
			model: null,
			createdAt: this.#createdAt,
			lastActive: this.#createdAt,
			permission: this.#permission,
			worktree: o.worktree === true,
			adapterVersion: null,
			...(o.fanout ? { fanout: o.fanout } : {}),
		};
		await upsertForeignRow(o.configDir, this.#sessionId, this.#row, this.#row);
		return null;
	}

	#maxTurn(): number {
		let max = 0;
		for (const entry of this.#transcript.all) {
			const turn = turnOf(entry.type === "custom_message" ? entry : undefined);
			if (turn !== null && turn > max) max = turn;
		}
		return max;
	}

	/**
	 * Whether the working directory is in a git repository whose files can be snapshot (feature `turn-diff`). The
	 * repository is pinned first, before the agent exists, so nothing it writes later can stand in for it; one
	 * that cannot be trusted turns the feature off and is said at the first prompt.
	 */
	async #probeSnapshots(): Promise<boolean> {
		try {
			if (!(await pinRepository(this.#o.cwd))) return false;
			return (await checkpoint(this.#o.cwd, this.#sessionId, this.#nextTurn)) !== null;
		} catch (err) {
			if (err instanceof CheckpointError) this.#snapshotRefusal = errorText(err);
			return false;
		}
	}

	async #launch(): Promise<LaunchSpec> {
		const o = this.#o;
		const launch = o.launch ?? launchSpec;
		return launch(o.agent.id, {
			configDir: o.configDir,
			cwd: o.cwd,
			permission: this.#permission,
			model: o.model,
		});
	}

	/**
	 * Spawn the agent and give it a session: the stored one when it can be reloaded (its history replay is
	 * dropped, the transcript already has it), else a new one that is told what came before on its next prompt.
	 */
	async #startAgent(): Promise<void> {
		const spec = await this.#launch();
		const acp = await AcpSession.start(spec, {
			onUpdate: update => this.#onUpdate(update),
			onPermission: request => this.#onPermission(request),
			onElicitation: request => this.#onElicitation(request),
			onExtension: (method, params, notification) => this.#onExtension(method, params, notification),
			onExit: reason => void this.#onAgentExit(acp, reason),
		});
		this.#adapterVersion = acp.info.agentInfo?.version ?? null;
		try {
			const setup = await this.#openAgentSession(acp);
			this.#adoptSetup(setup);
			await this.#applyVendorMode(acp, setup);
		} catch (err) {
			await acp.close();
			if (err instanceof AgentAuthRequiredError) {
				throw new Error(
					`${this.#o.agent.name} is not signed in: sign in with its own login, then start the session again`,
				);
			}
			throw err;
		}
		this.#acp = acp;
		this.#resetPending = false;
		if (this.#meta.commands.length === 0) {
			for (let waited = 0; waited < COMMANDS_WAIT_MS && this.#meta.commands.length === 0; waited += 100)
				await Bun.sleep(100);
		}
	}

	async #openAgentSession(acp: AcpSession): Promise<SessionSetup> {
		const cwd = this.#o.cwd;
		const stored = this.#nativeId;
		this.#replaying = true;
		try {
			if (stored !== null && acp.canLoad) {
				try {
					return await acp.loadSession(stored, cwd);
				} catch (err) {
					if (err instanceof AgentAuthRequiredError) throw err;
					this.#notice(
						"warning",
						`${this.#o.agent.name} could not reload its session (${errorText(err)}); starting a new one`,
					);
				}
			}
			const setup = await acp.newSession(cwd);
			if (stored !== null || this.#transcript.renderablePath.length > 0) this.#needsDigest = true;
			return setup;
		} finally {
			this.#replaying = false;
		}
	}

	#adoptSetup(setup: SessionSetup): void {
		this.#nativeId = setup.sessionId;
		this.#meta = applySetup(this.#meta, this.#o.agent.id, {
			configOptions: setup.configOptions,
			models: setup.models,
		});
	}

	/**
	 * Put the agent in its ask-first mode when it has one, so `supervised` means what it says whatever the user's
	 * own settings. An agent that cannot be confirmed in that mode is not used: a session that looks supervised
	 * but is not would run tools with nobody asked.
	 */
	async #applyVendorMode(acp: AcpSession, setup: SessionSetup): Promise<void> {
		const wanted = vendorModes(this.#o.agent.id).supervised;
		if (this.#permission !== "supervised" || wanted === null) return;
		const modes = setup.modes;
		if (modes?.currentModeId === wanted) return;
		if (modes === null || !modes.availableModes.some(mode => mode.id === wanted)) {
			throw new Error(`${this.#o.agent.name} offers no ${wanted} mode, so it cannot be kept asking first`);
		}
		try {
			await acp.setMode(wanted);
		} catch (err) {
			throw new Error(`could not switch ${this.#o.agent.name} to its ask-first mode: ${errorText(err)}`);
		}
	}

	async #publish(): Promise<void> {
		this.#publication = await publishCollabHost(
			{
				snapshot: () => ({
					instanceId: this.#sessionId.toLowerCase(),
					generation: 1,
					pid: process.pid,
					sessionId: this.#sessionId,
					sessionName: this.#transcript.header.title ?? null,
					cwd: this.#o.cwd,
					model:
						this.#meta.currentModel === null ? null : { provider: this.#o.agent.id, id: this.#meta.currentModel },
					startedAt: this.#startedAt,
					participants: 1 + this.#room.peers.size,
					relayConnected: this.#room.connected,
					inputRequired: this.#pendingUi.size > 0,
					busy: this.#busy,
					agent: this.#o.agent,
					access: "control",
				}),
				link: access => (access === "control" ? this.#room.webLink : this.#room.webViewLink),
			},
			{ instanceId: this.#sessionId.toLowerCase(), ...(this.#o.registryDir ? { dir: this.#o.registryDir } : {}) },
		);
	}

	// ── index and notices ────────────────────────────────────────────────────

	async #persist(patch: Partial<ForeignIndexRow>): Promise<void> {
		const fields: Partial<ForeignIndexRow> = {
			nativeId: this.#nativeId,
			title: this.#transcript.header.title ?? null,
			model: this.#meta.currentModel,
			lastActive: Date.now(),
			permission: this.#permission,
			adapterVersion: this.#adapterVersion,
			costUsd: this.#spent,
			...patch,
		};
		this.#row = { ...this.#row, ...fields };
		try {
			// Only the host's own fields are written; the whole row is the fallback for an index that lost it,
			// so the session stays listed and resumable.
			await upsertForeignRow(this.#o.configDir, this.#sessionId, fields, this.#row);
		} catch (err) {
			console.error(`foreign-host: could not update the session index: ${errorText(err)}`);
		}
	}

	#event(event: AgentEvent): void {
		this.#room.send({ t: "event", event });
	}

	#notice(level: "info" | "warning" | "error", message: string): void {
		if (this.#room === undefined) {
			console.error(`foreign-host: ${message}`);
			return;
		}
		this.#event({ type: "notice", level, message, source: this.#o.agent.id });
	}

	#append(entry: NewEntry): void {
		const stored = this.#transcript.append(entry);
		if (stored.type !== "custom" && stored.type !== "title_change") this.#room.send({ t: "entry", entry: stored });
	}

	// ── turn output ──────────────────────────────────────────────────────────

	/** Queue turn output; bursts of partial messages go out as one frame, anything else at once. */
	#queueOps(ops: TurnOp[]): void {
		if (ops.length === 0) return;
		this.#opBuffer.push(...ops);
		const urgent = ops.some(
			op => op.type === "message" || (op.event.type !== "message_update" && op.event.type !== "message_start"),
		);
		if (urgent) this.#flushOps();
		else this.#opTimer ??= setTimeout(() => this.#flushOps(), OP_FLUSH_MS);
	}

	#flushOps(): void {
		clearTimeout(this.#opTimer);
		this.#opTimer = undefined;
		const ops = coalesceOps(this.#opBuffer);
		this.#opBuffer = [];
		for (const op of ops) {
			if (op.type === "event") this.#event(op.event);
			else this.#append({ type: "message", message: op.message });
		}
	}

	#ensureTurn(): TurnBuilder {
		if (this.#turn === null) {
			this.#turn = { builder: this.#newBuilder(), ambient: true };
		}
		if (this.#turn.ambient) {
			clearTimeout(this.#ambientTimer);
			this.#ambientTimer = setTimeout(() => this.#endAmbient(), AMBIENT_QUIET_MS);
		}
		return this.#turn.builder;
	}

	#endAmbient(): void {
		const turn = this.#turn;
		if (turn === null || !turn.ambient) return;
		this.#queueOps(turn.builder.finish("end_turn", null));
		this.#flushOps();
		this.#turn = null;
	}

	#newBuilder(): TurnBuilder {
		return new TurnBuilder({
			model: () => this.#meta.currentModel ?? this.#o.agent.name,
			provider: this.#o.agent.id,
		});
	}

	// ── the agent's notifications ────────────────────────────────────────────

	/** Synchronous, in arrival order: the connection hands updates over one by one and relies on it. */
	#onUpdate(update: SessionUpdate): void {
		if (update.sessionUpdate === "usage_update") this.#accumulateCost(update);
		const before = this.#meta;
		this.#meta = applyMetaUpdate(before, this.#o.agent.id, update);
		if (this.#meta !== before) this.#metaChanged(before);
		if (this.#replaying || this.#stopping) return;
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
			case "agent_thought_chunk":
			case "tool_call":
			case "tool_call_update":
			case "plan":
				this.#queueOps(this.#ensureTurn().update(update));
				return;
			default:
		}
	}

	/** Sum the cumulative cost the agent reports into the session's spend, whatever resets the agent's own count. */
	#accumulateCost(update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>): void {
		const cost = update.cost;
		if (!cost || cost.currency.toUpperCase() !== "USD" || !Number.isFinite(cost.amount)) return;
		const last = this.#lastReportedCost;
		if (!this.#replaying) this.#spent += last === null || cost.amount < last ? cost.amount : cost.amount - last;
		this.#lastReportedCost = cost.amount;
		this.#checkCap();
	}

	#metaChanged(before: AgentMeta): void {
		const title = this.#meta.title;
		if (title !== null && title !== before.title && title !== this.#transcript.header.title && !this.#replaying) {
			this.#transcript.rename(title.slice(0, MAX_TITLE_CHARS));
			void this.#persist({});
		}
		this.#scheduleState();
	}

	#checkCap(): void {
		const cap = this.#o.maxCostUsd;
		if (cap === undefined || this.#capped || this.#spent < cap) return;
		this.#capped = true;
		this.#notice(
			"warning",
			`the spend cap of $${cap.toFixed(2)} is reached; ${this.#o.agent.name} was stopped and prompts are refused until the cap is raised`,
		);
		const cleared = this.#queue.length;
		this.#queue = [];
		if (cleared > 0)
			this.#notice("info", `${cleared} queued ${cleared === 1 ? "message was" : "messages were"} dropped`);
		if (this.#busy) void this.#abort();
		this.#scheduleState();
	}

	// ── permission and questions ─────────────────────────────────────────────

	/** Ask the writers; the first answer wins and the others' prompts are withdrawn. */
	#ask(draft: CollabUiRequestDraft): Promise<{ value: string | undefined; by: string }> {
		const reqId = this.#nextReqId++;
		const request: CollabUiRequest = { ...draft, reqId };
		const { promise, resolve } = Promise.withResolvers<{ value: string | undefined; by: string }>();
		this.#pendingUi.set(reqId, {
			request,
			resolve: answer => {
				this.#pendingUi.delete(reqId);
				this.#room.sendWriters({ t: "ui-request-end", reqId });
				this.#scheduleState();
				resolve(answer);
			},
		});
		this.#room.sendWriters({ t: "ui-request", request });
		this.#scheduleState();
		return promise;
	}

	/** Dismiss every open prompt, as the agent's turn is over. */
	#cancelPrompts(): void {
		for (const pending of this.#pendingUi.values()) pending.resolve({ value: undefined, by: "host" });
	}

	#recordApproval(
		tool: string,
		toolCallId: string,
		approved: boolean,
		by: string,
		choice: string,
		reason?: string,
	): void {
		this.#flushOps();
		this.#transcript.append({
			type: "custom",
			customType: "tool-approval",
			data: { toolCallId, tool, approved, by, choice, ...(reason === undefined ? {} : { reason }) },
		});
	}

	async #onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse["outcome"]> {
		if (this.#replaying || this.#stopping) return { outcome: "cancelled" };
		const builder = this.#ensureTurn();
		const id = request.toolCall.toolCallId;
		this.#queueOps(builder.ensureAnnounced(id, request.toolCall));
		const state = builder.tool(id);
		if (state === undefined) return { outcome: "cancelled" };
		const view = toolView(state);
		const targets = toolTargets(state);
		const escalation = escalationReason(state.title, state.rawInput, request.toolCall.rawInput);
		const plan = planApproval(request, view, { cwd: this.#o.cwd, targets, escalation });
		const granted =
			escalation === null && grantsCover(this.#rules, { name: view.name, args: view.args, targets }, this.#o.cwd);
		if (this.#permission === "full" || granted) {
			const by = this.#permission === "full" ? "full-access" : "grant";
			if (plan.allowOnce === null) {
				this.#recordApproval(view.name, id, false, by, "deny", "the agent offered no one-time approval");
				this.#notice("warning", `${view.name} was refused: ${this.#o.agent.name} offers no one-time approval`);
				return approvalOutcome(plan, "deny");
			}
			this.#recordApproval(view.name, id, true, by, by === "grant" ? "grant" : "once");
			return approvalOutcome(plan, "once");
		}
		const answer = await this.#ask({
			kind: "select",
			title: plan.title,
			options: plan.options,
			approval: plan.approval,
		});
		const kind = choiceKind(plan, answer.value);
		if (kind === "session") this.#rules.push(...plan.grants);
		const approved = kind === "once" || kind === "session";
		this.#recordApproval(view.name, id, approved, answer.by, kind);
		return approvalOutcome(plan, kind);
	}

	/**
	 * A form the agent asks the user to fill. It shows as an `ask` card (so inboxes and pending-question
	 * badges see it) and as one prompt per field to the writers; URL-mode requests are declined.
	 */
	async #onElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
		if (request.mode !== "form" || !request.requestedSchema || this.#replaying || this.#stopping)
			return { action: "decline" };
		const fields = Object.entries(request.requestedSchema.properties).slice(0, ELICITATION_MAX_QUESTIONS);
		const required = new Set(request.requestedSchema.required ?? []);
		const questions = fields.map(([key, schema]) => {
			const title = typeof schema.title === "string" && schema.title !== request.message ? schema.title : null;
			const single = fields.length === 1;
			const text = single
				? title === null
					? request.message
					: `${request.message}\n${title}`
				: `${request.message}: ${title ?? key}`;
			const options = fieldOptions(schema);
			return { id: key, question: text, options: options.map(label => ({ label })), multi: false };
		});
		const builder = this.#ensureTurn();
		const callId = `ask-${this.#nextAsk++}`;
		this.#queueOps(builder.beginSynthetic(callId, { name: "ask", args: { questions } }));
		const content: Record<string, string | number | boolean | string[]> = {};
		const lines: string[] = [];
		let cancelled = false;
		for (const [key, schema] of fields) {
			const question = questions.find(candidate => candidate.id === key);
			if (question === undefined) continue;
			const options = fieldOptions(schema);
			const answer = await this.#ask(
				options.length > 0
					? { kind: "select", title: question.question, options }
					: {
							kind: "editor",
							title: question.question,
							prefill: typeof schema.default === "string" ? schema.default : undefined,
						},
			);
			if (answer.value === undefined) {
				cancelled = true;
				break;
			}
			const typed = typedAnswer(schema, answer.value);
			if (typed === null) {
				if (required.has(key)) {
					cancelled = true;
					break;
				}
				continue;
			}
			content[key] = typed;
			lines.push(`${key}: ${Array.isArray(typed) ? typed.join(", ") : String(typed)}`);
		}
		const text = cancelled ? "The question was dismissed." : lines.join("\n") || "No answer.";
		this.#queueOps(builder.endSynthetic(callId, "ask", { content: [{ type: "text", text }], isError: cancelled }));
		return cancelled ? { action: "cancel" } : { action: "accept", content };
	}

	// ── vendor extensions (Cursor) ───────────────────────────────────────────

	/** `cursor/…` requests and notifications; anything not understood resolves `undefined` after a notice. */
	async #onExtension(method: string, params: unknown, notification: boolean): Promise<unknown> {
		const name = this.#o.agent.name;
		switch (method) {
			case "cursor/ask_question":
				return this.#onCursorAsk(params);
			case "cursor/create_plan":
				return this.#onCursorPlan(params);
			case "cursor/update_todos": {
				const update = parseUpdateTodos(params);
				if (update === null) throw RequestError.invalidParams(undefined, "malformed cursor/update_todos request");
				this.#cursorTodos = applyTodoUpdate(this.#cursorTodos, update.todos, update.merge);
				this.#showTodos();
				return notification ? undefined : { outcome: { outcome: "accepted", todos: this.#cursorTodos } };
			}
			case "cursor/task": {
				const description = isRecord(params) ? str(params.description) : undefined;
				this.#notice("info", `${name} finished a subagent task${description ? `: ${description}` : ""}`);
				return notification ? undefined : {};
			}
			case "cursor/generate_image":
				this.#notice("info", `${name} generated an image, which this view cannot show`);
				return notification ? undefined : {};
			default:
				if (!notification)
					this.#notice("warning", `${name} asked for ${method.slice(0, 80)}, which is not supported here`);
				return undefined;
		}
	}

	/** The todo list the agent keeps, shown as the plan card. */
	#showTodos(): void {
		if (this.#replaying || this.#stopping) return;
		this.#queueOps(this.#ensureTurn().update({ sessionUpdate: "plan", entries: planEntries(this.#cursorTodos) }));
	}

	/** Multiple-choice questions: an `ask` card, and one prompt per question to the writers. */
	async #onCursorAsk(params: unknown): Promise<unknown> {
		const ask = parseAskQuestion(params);
		if (ask === null) throw RequestError.invalidParams(undefined, "malformed cursor/ask_question request");
		if (this.#replaying || this.#stopping) return { outcome: { outcome: "cancelled" } };
		const builder = this.#ensureTurn();
		const callId = `ask-${this.#nextAsk++}`;
		const questions = ask.questions.map(question => ({
			id: question.id,
			question: question.prompt,
			options: question.options.map(option => ({ label: option.label })),
			multi: question.multi,
		}));
		this.#queueOps(builder.beginSynthetic(callId, { name: "ask", args: { questions } }));
		const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
		const lines: string[] = [];
		let cancelled = false;
		for (const question of ask.questions) {
			const picked = await this.#pickOptions(question);
			if (picked === null) {
				cancelled = true;
				break;
			}
			answers.push({ questionId: question.id, selectedOptionIds: picked.map(option => option.id) });
			lines.push(`${question.prompt}: ${picked.map(option => option.label).join(", ")}`);
		}
		const text = cancelled ? "The question was dismissed." : lines.join("\n");
		this.#queueOps(builder.endSynthetic(callId, "ask", { content: [{ type: "text", text }], isError: cancelled }));
		return { outcome: cancelled ? { outcome: "cancelled" } : { outcome: "answered", answers } };
	}

	/** The options a guest picks for one question; null when it is dismissed. Several are picked one at a time, then "Done". */
	async #pickOptions(question: CursorQuestion): Promise<CursorQuestion["options"] | null> {
		const remaining = [...question.options];
		const picked: CursorQuestion["options"] = [];
		const title = question.multi ? `${question.prompt} (choose any number)` : question.prompt;
		for (;;) {
			const labels = remaining.map(option => option.label);
			const more = question.multi && picked.length > 0;
			const answer = await this.#ask({
				kind: "select",
				title,
				options: more ? [...labels, MULTI_DONE_LABEL] : labels,
			});
			if (answer.value === undefined) return null;
			if (more && answer.value === MULTI_DONE_LABEL) return picked;
			const at = remaining.findIndex(option => option.label === answer.value);
			if (at < 0) continue;
			picked.push(...remaining.splice(at, 1));
			if (!question.multi || remaining.length === 0) return picked;
		}
	}

	/** A plan to approve: its text and todos are shown, then the writers accept or reject it (full access accepts). */
	async #onCursorPlan(params: unknown): Promise<unknown> {
		const plan = parseCreatePlan(params);
		if (plan === null) throw RequestError.invalidParams(undefined, "malformed cursor/create_plan request");
		if (this.#replaying || this.#stopping) return { outcome: { outcome: "cancelled" } };
		this.#queueOps(
			this.#ensureTurn().update({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: planMarkdown(plan) },
			}),
		);
		this.#cursorTodos = plan.todos;
		this.#showTodos();
		if (this.#permission === "full") {
			this.#recordApproval("plan", plan.toolCallId, true, "full-access", "once");
			return { outcome: { outcome: "accepted" } };
		}
		const answer = await this.#ask({
			kind: "select",
			title: plan.name === undefined ? "Approve this plan?" : `Approve the plan "${plan.name}"?`,
			options: [APPROVE_PLAN_LABEL, REJECT_PLAN_LABEL],
		});
		if (answer.value === undefined) return { outcome: { outcome: "cancelled" } };
		const approved = answer.value === APPROVE_PLAN_LABEL;
		this.#recordApproval("plan", plan.toolCallId, approved, answer.by, approved ? "once" : "deny");
		return {
			outcome: approved ? { outcome: "accepted" } : { outcome: "rejected", reason: `rejected by ${answer.by}` },
		};
	}

	// ── agent lifetime ───────────────────────────────────────────────────────

	async #onAgentExit(acp: AcpSession, reason: string): Promise<void> {
		if (this.#stopping || this.#acp !== acp) return;
		this.#acp = null;
		const now = Date.now();
		this.#crashes = [...this.#crashes.filter(at => now - at < CRASH_WINDOW_MS), now];
		this.#notice("error", `${this.#o.agent.name} stopped: ${reason}`);
		this.#cancelPrompts();
		if (this.#crashes.length > MAX_CRASHES) {
			await this.stop(`${this.#o.agent.name} keeps stopping: ${reason}`, 1);
			return;
		}
		// A turn in progress ends on its own (its prompt fails) and recovers afterwards.
		if (!this.#busy) await this.#recover();
	}

	async #recover(): Promise<void> {
		if (this.#recovering || this.#stopping || this.#acp !== null) return;
		this.#recovering = true;
		try {
			await this.#startAgent();
			this.#notice("info", `${this.#o.agent.name} was restarted`);
		} catch (err) {
			await this.stop(`${this.#o.agent.name} cannot be restarted: ${errorText(err)}`, 1);
		} finally {
			this.#recovering = false;
			this.#scheduleState();
		}
	}

	/** The running agent, started again first when it is gone or a fresh session is due. */
	async #ensureAgent(): Promise<AcpSession> {
		if (this.#acp === null) {
			await this.#startAgent();
		} else if (this.#resetPending) {
			const setup = await this.#acp.newSession(this.#o.cwd);
			this.#adoptSetup(setup);
			await this.#applyVendorMode(this.#acp, setup);
			this.#resetPending = false;
		}
		if (this.#acp === null) throw new Error(`${this.#o.agent.name} is not running`);
		return this.#acp;
	}

	// ── prompts ──────────────────────────────────────────────────────────────

	#submit(item: QueuedPrompt): string | null {
		if (this.#stopping) return "the session is ending";
		if (this.#capped) return `the spend cap of $${(this.#o.maxCostUsd ?? 0).toFixed(2)} is reached`;
		if (this.#busy || this.#recovering) {
			if (this.#queue.length >= MAX_QUEUED) return "too many queued messages";
			this.#queue.push(item);
			this.#scheduleState();
			return null;
		}
		void this.#runTurn(item);
		return null;
	}

	async #runTurn(item: QueuedPrompt): Promise<void> {
		this.#endAmbient();
		this.#busy = true;
		this.#aborting = false;
		this.#scheduleState(true);
		const turnNumber = this.#nextTurn++;
		if (this.#gitOk) {
			await checkpoint(this.#o.cwd, this.#sessionId, turnNumber).catch(err => {
				if (!this.#snapshotWarned)
					this.#notice("warning", `file snapshots are off for this session: ${errorText(err)}`);
				this.#snapshotWarned = true;
			});
		} else if (this.#snapshotRefusal !== null && !this.#snapshotWarned) {
			this.#snapshotWarned = true;
			this.#notice("warning", `file snapshots are off for this session: ${this.#snapshotRefusal}`);
		}
		const images = item.images ?? [];
		this.#append({
			type: "custom_message",
			customType: COLLAB_PROMPT_MESSAGE_TYPE,
			content: images.length > 0 ? [{ type: "text", text: item.text }, ...images] : item.text,
			details: { from: item.from, turn: turnNumber },
			display: true,
		});
		this.#event({ type: "agent_start" });
		this.#event({ type: "turn_start" });
		const builder = this.#newBuilder();
		this.#turn = { builder, ambient: false };
		const spentBefore = this.#spent;
		let response: PromptResponse | null = null;
		let failure: string | null = null;
		let restore: (() => Promise<void>) | null = null;
		try {
			const acp = await this.#ensureAgent();
			restore = await this.#overrides(item);
			let text = item.text;
			if (this.#needsDigest) {
				const digest = historyDigest(this.#transcript.renderablePath.slice(0, -1));
				if (digest !== "") text = `${digest}\n\n${item.text}`;
				this.#needsDigest = false;
			}
			if (images.length > 0 && !acp.canImage)
				this.#notice("warning", `${this.#o.agent.name} does not take images; the prompt went without them`);
			response = await acp.prompt(promptBlocks(text, images, acp.canImage));
		} catch (err) {
			failure = errorText(err);
		}
		clearTimeout(this.#cancelTimer);
		this.#flushOps();
		const usage = wireUsage(response?.usage, Math.max(0, this.#spent - spentBefore));
		this.#tokens += usage.input + usage.output + usage.cacheWrite;
		const stop = response?.stopReason ?? (this.#aborting ? "cancelled" : "refusal");
		const message = failure ?? (response ? stopMessage(response.stopReason) : null) ?? undefined;
		this.#queueOps(builder.finish(stop, usage, message));
		this.#flushOps();
		if (failure !== null) this.#notice("error", failure);
		this.#cancelPrompts();
		this.#turn = null;
		this.#event({ type: "turn_end" });
		this.#event({ type: "agent_end" });
		this.#busy = false;
		this.#aborting = false;
		if (restore !== null)
			await restore().catch(err => this.#notice("warning", `could not restore the model: ${errorText(err)}`));
		await this.#transcript
			.flush()
			.catch(err => this.#notice("error", `could not write the transcript: ${errorText(err)}`));
		await this.#persist({});
		this.#scheduleState(true);
		if (this.#acp === null && !this.#stopping) await this.#recover();
		const next = this.#queue.shift();
		if (next !== undefined && !this.#capped && !this.#stopping) void this.#runTurn(next);
	}

	/** Run one prompt on another model or thinking level (`prompt-model`); the returned function puts the session's own back. */
	async #overrides(item: QueuedPrompt): Promise<(() => Promise<void>) | null> {
		const modelBefore = this.#meta.currentModel;
		const levelBefore = this.#meta.thinkingLevel;
		let changed = false;
		if (item.model !== undefined) {
			const id = this.#vendorModelId(item.model);
			if (id !== null && id !== modelBefore) {
				await this.#selectModel(id);
				changed = true;
			}
		}
		const levelChanged =
			item.thinking !== undefined &&
			item.thinking !== levelBefore &&
			this.#meta.thinkingLevels.includes(item.thinking);
		if (levelChanged && item.thinking !== undefined) await this.#selectThinking(item.thinking);
		if (!changed && !levelChanged) return null;
		return async () => {
			if (changed && modelBefore !== null) await this.#selectModel(modelBefore);
			if (levelChanged && levelBefore !== null) await this.#selectThinking(levelBefore);
		};
	}

	async #abort(): Promise<void> {
		const acp = this.#acp;
		if (!this.#busy || this.#aborting || acp === null) return;
		this.#aborting = true;
		this.#cancelPrompts();
		this.#scheduleState(true);
		await acp.cancel().catch(() => undefined);
		// An agent that ignores the cancel is ended; the next prompt starts it again.
		this.#cancelTimer = setTimeout(() => void acp.close(), CANCEL_GRACE_MS);
	}

	// ── model, thinking, permission ──────────────────────────────────────────

	/** `provider/id` of a model the guests were offered → the vendor's model id; null when it is not ours. */
	#vendorModelId(selector: string): string | null {
		const prefix = `${this.#o.agent.id}/`;
		const id = selector.startsWith(prefix) ? selector.slice(prefix.length) : selector;
		return this.#meta.models.some(model => model.id === id) ? id : null;
	}

	async #selectModel(id: string): Promise<void> {
		const acp = this.#acp;
		const via = this.#meta.modelVia;
		if (acp === null || via === null) throw new Error(`${this.#o.agent.name} does not offer a choice of model`);
		if (!this.#meta.models.some(model => model.id === id))
			throw new Error(`${this.#o.agent.name} has no model ${id}`);
		if (via.kind === "config") {
			const options = await acp.setConfigOption(via.configId, id);
			this.#meta = applySetup(this.#meta, this.#o.agent.id, { configOptions: options });
		} else {
			await acp.setModel(id);
		}
		this.#meta = { ...this.#meta, currentModel: id };
		this.#scheduleState();
	}

	async #selectThinking(level: string): Promise<void> {
		const acp = this.#acp;
		const configId = this.#meta.thinkingConfigId;
		if (acp === null || configId === null) throw new Error(`${this.#o.agent.name} does not offer thinking levels`);
		const options = await acp.setConfigOption(configId, level);
		this.#meta = applySetup(this.#meta, this.#o.agent.id, { configOptions: options });
		this.#meta = { ...this.#meta, thinkingLevel: level };
		this.#scheduleState();
	}

	async #setPermission(mode: SessionPermission): Promise<void> {
		if (mode === this.#permission) return;
		if (mode === "supervised") {
			// Supervised is reported only once the vendor has confirmed its ask-first mode; a refusal keeps full access
			// (which says so honestly) instead of showing a prompt-first session that is not.
			const wanted = vendorModes(this.#o.agent.id).supervised;
			if (this.#acp !== null && wanted !== null) {
				try {
					await this.#acp.setMode(wanted);
				} catch (err) {
					this.#notice(
						"error",
						`${this.#o.agent.name} would not switch to its ask-first mode (${errorText(err)}), so the session stays in full access`,
					);
					return;
				}
			}
		}
		this.#permission = mode;
		this.#notice(
			"info",
			mode === "full"
				? "full access: every tool call is approved without asking"
				: "supervised: tool calls ask first",
		);
		await this.#persist({});
		this.#scheduleState(true);
	}

	// ── guests ───────────────────────────────────────────────────────────────

	#features(): CollabFeature[] {
		const features: CollabFeature[] = ["follow-up", "approval-grants", "permission-mode", "rewind"];
		if (this.#meta.commands.length > 0) features.push("commands");
		if (this.#meta.models.length > 1 && this.#meta.modelVia !== null) features.push("prompt-model");
		if (this.#o.maxCostUsd !== undefined) features.push("spend-cap");
		if (this.#gitOk) features.push("turn-diff", "rewind-files");
		return features;
	}

	#models(): WireModel[] {
		const levels = this.#meta.thinkingLevels;
		return this.#meta.models.map(model => ({ ...model, ...(levels.length > 0 ? { thinkingLevels: levels } : {}) }));
	}

	#agents(): AgentSnapshot[] {
		return [
			{
				id: MAIN_AGENT_ID,
				displayName: this.#o.agent.name,
				kind: "main",
				status: this.#busy ? "running" : "idle",
				hasSessionFile: true,
				createdAt: this.#createdAt,
				lastActivity: Date.now(),
			},
		];
	}

	#state(): SessionState {
		const meta = this.#meta;
		const model = meta.models.find(candidate => candidate.id === meta.currentModel);
		const state: SessionState = {
			isStreaming: this.#busy,
			queuedMessageCount: this.#queue.length,
			cwd: this.#o.cwd,
			participants: [
				{ name: os.userInfo().username, role: "host" },
				...[...this.#room.peers.values()].map(peer => ({
					name: peer.name,
					role: "guest" as const,
					...(peer.writer ? {} : { readOnly: true as const }),
				})),
			],
			followUps: this.#queue.map(item => item.text),
			permission: this.#permission,
		};
		if (this.#transcript.header.title) state.sessionName = this.#transcript.header.title;
		if (meta.currentModel !== null) {
			state.model = model ?? {
				id: meta.currentModel,
				name: meta.currentModel,
				provider: this.#o.agent.id,
				contextWindow: null,
			};
		}
		if (meta.thinkingLevel !== null) state.thinkingLevel = meta.thinkingLevel;
		if (meta.thinkingLevels.length > 0) state.thinkingLevels = meta.thinkingLevels;
		if (meta.contextUsed !== null && meta.contextSize !== null && meta.contextSize > 0) {
			state.contextUsage = {
				tokens: meta.contextUsed,
				contextWindow: meta.contextSize,
				percent: (meta.contextUsed / meta.contextSize) * 100,
			};
		}
		if (this.#aborting) state.isAborting = true;
		if (this.#o.maxCostUsd !== undefined) {
			state.spend = {
				costUsd: this.#spent,
				tokens: this.#tokens,
				maxCostUsd: this.#o.maxCostUsd,
				capped: this.#capped,
			};
		}
		return state;
	}

	#scheduleState(now = false): void {
		if (this.#room === undefined) return;
		if (now) {
			clearTimeout(this.#stateTimer);
			this.#stateTimer = undefined;
			this.#sendState();
			return;
		}
		this.#stateTimer ??= setTimeout(() => {
			this.#stateTimer = undefined;
			this.#sendState();
		}, STATE_DEBOUNCE_MS);
	}

	#sendState(): void {
		if (this.#stopping) return;
		const state = this.#state();
		const json = JSON.stringify(state);
		if (json !== this.#lastStateJson) {
			this.#lastStateJson = json;
			this.#room.send({ t: "state", state });
		}
		const agents = this.#agents();
		const agentsJson = JSON.stringify(agents.map(agent => agent.status));
		if (agentsJson !== this.#lastAgentsJson) {
			this.#lastAgentsJson = agentsJson;
			this.#room.send({ t: "agents", agents });
		}
	}

	#welcome(): WelcomeBody {
		return {
			header: this.#transcript.header,
			state: this.#state(),
			agents: this.#agents(),
			models: this.#models(),
			commands: this.#meta.commands,
			features: this.#features(),
			agent: this.#o.agent,
		};
	}

	#onHello(peer: RoomPeer, hello: HelloFrame): void {
		this.#room.sendWelcome(peer, hello, this.#welcome(), this.#transcript.renderablePath);
		if (peer.writer)
			for (const pending of this.#pendingUi.values())
				this.#room.send({ t: "ui-request", request: pending.request }, peer.id);
		console.log(`foreign-host: ${peer.name} joined (peer ${peer.id})${peer.writer ? "" : " read-only"}`);
		this.#scheduleState(true);
	}

	async #onFrame(frame: Exclude<GuestFrame, HelloFrame>, peer: RoomPeer): Promise<void> {
		try {
			await this.#dispatch(frame, peer);
		} catch (err) {
			this.#room.send({ t: "error", message: errorText(err) }, peer.id);
		}
	}

	async #dispatch(frame: Exclude<GuestFrame, HelloFrame>, peer: RoomPeer): Promise<void> {
		if (frame.t === "fetch-transcript") {
			await this.#fetchTranscript(frame.reqId, frame.agentId, frame.fromByte, peer);
			return;
		}
		if (!peer.writer) {
			this.#room.send({ t: "error", message: "read-only link: this guest cannot control the session" }, peer.id);
			return;
		}
		switch (frame.t) {
			case "prompt": {
				const text = frame.text.trim();
				if (text === "" && (frame.images?.length ?? 0) === 0) return;
				const refusal = this.#submit({
					text,
					images: frame.images,
					from: peer.name,
					model: frame.model,
					thinking: frame.thinking,
				});
				if (refusal !== null) this.#room.send({ t: "error", message: refusal }, peer.id);
				return;
			}
			case "ui-response":
				this.#pendingUi.get(frame.reqId)?.resolve({ value: frame.value, by: peer.name });
				return;
			case "abort":
				this.#queue = [];
				await this.#abort();
				return;
			case "agent-cmd":
				this.#room.send({ t: "error", message: `${this.#o.agent.name} has no subagents to ${frame.cmd}` }, peer.id);
				return;
			case "session-cmd":
				await this.#sessionCommand(frame, peer);
				return;
		}
	}

	async #fetchTranscript(reqId: number, agentId: string, fromByte: number, peer: RoomPeer): Promise<void> {
		if (agentId !== MAIN_AGENT_ID) {
			this.#room.send(
				{ t: "transcript", reqId, text: "", newSize: fromByte, error: "no transcript available" },
				peer.id,
			);
			return;
		}
		try {
			await this.#transcript.flush();
			const slice = await readTranscriptSlice(this.#transcript.path, fromByte);
			this.#room.send(
				{
					t: "transcript",
					reqId,
					text: slice.text,
					newSize: slice.newSize,
					...(slice.error ? { error: slice.error } : {}),
				},
				peer.id,
			);
		} catch (err) {
			this.#room.send({ t: "transcript", reqId, text: "", newSize: fromByte, error: errorText(err) }, peer.id);
		}
	}

	async #sessionCommand(frame: Extract<GuestFrame, { t: "session-cmd" }>, peer: RoomPeer): Promise<void> {
		const arg = frame.arg ?? "";
		switch (frame.cmd) {
			case "model": {
				if (this.#busy) throw new Error("wait for the turn to finish before switching the model");
				const id = this.#vendorModelId(arg);
				if (id === null) throw new Error(`${this.#o.agent.name} has no model ${arg}`);
				await this.#selectModel(id);
				this.#append({ type: "model_change", model: `${this.#o.agent.id}/${id}` });
				await this.#persist({});
				return;
			}
			case "thinking": {
				if (this.#busy) throw new Error("wait for the turn to finish before changing the thinking level");
				if (!this.#meta.thinkingLevels.includes(arg))
					throw new Error(`${this.#o.agent.name} has no thinking level ${arg}`);
				await this.#selectThinking(arg);
				this.#append({ type: "thinking_level_change", thinkingLevel: arg });
				this.#event({ type: "thinking_level_changed", thinkingLevel: arg });
				return;
			}
			case "rename": {
				const title = arg.trim().slice(0, MAX_TITLE_CHARS);
				if (title === "") throw new Error("a session name cannot be empty");
				this.#transcript.rename(title);
				await this.#persist({});
				this.#scheduleState(true);
				return;
			}
			case "permission": {
				if (arg !== "supervised" && arg !== "full") throw new Error("permission must be supervised or full");
				await this.#setPermission(arg);
				return;
			}
			case "unqueue": {
				const at = this.#queue.findIndex(item => item.text === arg);
				if (at >= 0) this.#queue.splice(at, 1);
				this.#scheduleState(true);
				return;
			}
			case "rewind":
				await this.#rewind(arg, frame.restoreFiles === true, peer);
				return;
			case "rewind-preview": {
				const turn = this.#promptTurn(arg);
				const plan = this.#gitOk ? await previewRestore(this.#o.cwd, this.#sessionId, turn) : null;
				this.#room.send({ t: "rewind-preview", entryId: arg, files: plan }, peer.id);
				return;
			}
			case "redo-files": {
				if (!this.#gitOk) throw new Error("file snapshots are not available");
				if (this.#busy) throw new Error("wait for the turn to finish before restoring files");
				const result = await redoRestore(this.#o.cwd, this.#sessionId);
				if (result === null) throw new Error("file snapshots are not available");
				this.#room.send(
					{ t: "files-restored", kind: "redo", plan: result.plan, skipped: result.skipped, canRedo: true },
					peer.id,
				);
				return;
			}
			case "turn-diff": {
				const turn = this.#promptTurn(arg);
				const reply = this.#gitOk
					? await turnDiff(this.#o.cwd, this.#sessionId, turn, { latestTurn: this.#nextTurn - 1 })
					: null;
				this.#room.send(
					{
						t: "turn-diff",
						scope: "turn",
						entryId: arg,
						...(reply ?? { files: null, reason: "file snapshots are not available for this session" }),
					},
					peer.id,
				);
				return;
			}
			case "session-diff": {
				const reply = this.#gitOk
					? await sessionDiff(this.#o.cwd, this.#sessionId, { latestTurn: this.#nextTurn - 1 })
					: null;
				this.#room.send(
					{
						t: "turn-diff",
						scope: "session",
						entryId: null,
						...(reply ?? { files: null, reason: "file snapshots are not available for this session" }),
					},
					peer.id,
				);
				return;
			}
			default:
				throw new Error(`${frame.cmd} is not available with ${this.#o.agent.name}`);
		}
	}

	/** The turn number of a prompt entry on the active path. */
	#promptTurn(entryId: string): number {
		const entry = this.#transcript.get(entryId);
		const turn = turnOf(entry?.type === "custom_message" ? entry : undefined);
		if (turn === null || !this.#transcript.onPath(entryId)) throw new Error("that is not a prompt of this session");
		return turn;
	}

	/**
	 * Move the session to just before a prompt. The agent cannot drop turns from its own memory, so it starts
	 * a new session and is given a digest of the conversation that is left; files go back only when asked.
	 */
	async #rewind(entryId: string, withFiles: boolean, peer: RoomPeer): Promise<void> {
		if (this.#busy || this.#recovering) throw new Error("wait for the turn to finish, or stop it, before rewinding");
		const turn = this.#promptTurn(entryId);
		let restored: RestoreResult | null = null;
		if (withFiles) {
			if (!this.#gitOk) throw new Error("file snapshots are not available");
			restored = await restoreFiles(this.#o.cwd, this.#sessionId, turn);
		}
		this.#transcript.rewindBefore(entryId);
		this.#queue = [];
		this.#resetPending = true;
		this.#needsDigest = true;
		this.#room.send({ t: "branch", keep: this.#transcript.renderablePath.at(-1)?.id ?? null, entries: [] });
		if (restored !== null) {
			this.#room.send(
				{ t: "files-restored", kind: "restore", plan: restored.plan, skipped: restored.skipped, canRedo: true },
				peer.id,
			);
		}
		this.#notice(
			"info",
			`rewound; ${this.#o.agent.name} starts a new session and is given a digest of the conversation that is left`,
		);
		await this.#persist({});
		this.#scheduleState(true);
	}

	// ── end ──────────────────────────────────────────────────────────────────

	/** End the session: tell the guests, stop the agent, withdraw from the registry, write the index. Idempotent. */
	async stop(reason: string, code = 0): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		clearTimeout(this.#opTimer);
		clearTimeout(this.#stateTimer);
		clearTimeout(this.#ambientTimer);
		clearTimeout(this.#cancelTimer);
		this.#cancelPrompts();
		await this.#acp?.close().catch(() => undefined);
		this.#acp = null;
		const started = this.#transcript !== undefined;
		if (started) await this.#transcript.flush().catch(() => undefined);
		await this.#room?.close(reason).catch(() => undefined);
		await this.#publication?.close().catch(() => undefined);
		if (started) await this.#persist({});
		this.#finish(code);
	}
}

/** Choices a form field offers: an enum, a `oneOf` of constants, or Yes/No for a boolean. */
function fieldOptions(schema: Record<string, unknown>): string[] {
	if (Array.isArray(schema.enum)) return schema.enum.filter((value): value is string => typeof value === "string");
	if (Array.isArray(schema.oneOf)) {
		return schema.oneOf.flatMap(option =>
			isRecord(option) && typeof option.const === "string" ? [option.const] : [],
		);
	}
	return schema.type === "boolean" ? ["Yes", "No"] : [];
}

/** A field's answer in the type its schema asks for; null for an empty answer or one that does not parse. */
function typedAnswer(schema: Record<string, unknown>, value: string): string | number | boolean | string[] | null {
	const text = value.trim();
	if (text === "") return null;
	switch (schema.type) {
		case "boolean":
			return text.toLowerCase() === "yes" || text.toLowerCase() === "true";
		case "number":
		case "integer": {
			const parsed = Number(text);
			return Number.isFinite(parsed) ? parsed : null;
		}
		case "array":
			return text
				.split(",")
				.map(item => item.trim())
				.filter(item => item !== "");
		default:
			return text;
	}
}
