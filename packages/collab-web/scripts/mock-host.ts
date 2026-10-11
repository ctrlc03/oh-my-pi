/**
 * Offline mock collab host: starts the local relay, opens a room as host, and
 * serves the canned fixture session to any collab-web guest that joins.
 *
 *   bun scripts/mock-host.ts [--port 7466] [--local-relay [PORT]]
 *
 * Prints a full join link (guests may prompt and run session controls) and a
 * view link (read-only). Replays a scripted streaming turn on every guest
 * prompt, ticks subagent progress on the bus every 2s, answers
 * fetch-transcript with byte slices of the fixture JSONL, and handles
 * `session-cmd` (model / thinking switches, compact, rename) — exactly the frames a
 * real `omp /collab` host emits.
 *
 * `--local-relay` also serves the room on a second loopback relay (default: the port after
 * `--port`) and puts it in the links as `?local=`, the way omp does with `collab.localRelayUrl`:
 * a guest on this computer joins through it and falls back to the main relay when it is down.
 * Type `local off` / `local on` on stdin to stop and restart that relay and watch the fallback.
 */

import type {
	AgentSnapshot,
	ContextItemRow,
	HostFrame,
	ImageContent,
	RewindFilesPlan,
	SessionCommand,
	SessionEntry,
	SessionState,
	TextContent,
	WireFrame,
	WireModel,
} from "@oh-my-pi/pi-wire";
import { generateRoomKey, importRoomKey, open, seal } from "../src/lib/codec";
import {
	COLLAB_PROTO,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	unpackEnvelope,
} from "../src/lib/link";
import {
	fixtureAgents,
	fixtureCommands,
	fixtureEntries,
	fixtureHeader,
	fixtureHostOnlyCommands,
	fixtureResumeChoices,
	fixtureModel,
	fixtureModels,
	fixtureProfiles,
	fixtureThinkingLevels,
	HOST_DISPLAY_NAME,
	makeProbeProgress,
	makeScriptedTurn,
	type ScriptedStep,
	subagentTranscriptJsonl,
} from "./fixture";
import { type LocalRelay, startLocalRelay } from "./local-relay";

const DEFAULT_PORT = 7466;
/** Local relay peer ids are shifted so both relays share one id space, as omp's host does. */
const LOCAL_PEER_BASE = 0x4000_0000;
const STEP_INTERVAL_MS = 40;
/** What the real host tells guests when a session switch ends their room. */
const MOCK_SESSION_SWITCH_REASON =
	"session switched; prompts not shown in the conversation were not submitted. Rejoin and resend them";
const TICK_INTERVAL_MS = 2_000;
const AGENTS_SNAPSHOT_EVERY = 5;

function parsePort(argv: string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		console.error(`mock-host: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

function parseLocalRelayPort(argv: string[], mainPort: number): number | null {
	const at = argv.indexOf("--local-relay");
	if (at < 0) return null;
	const next = argv[at + 1];
	if (next === undefined || next.startsWith("--")) return mainPort + 1;
	const localPort = Number(next);
	if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
		console.error(`mock-host: invalid --local-relay ${next}`);
		process.exit(1);
	}
	return localPort;
}

const argv = Bun.argv.slice(2);
const port = parsePort(argv);
const localPort = parseLocalRelayPort(argv, port);
/** `--max-cost <usd>`: report a spend cap in the state; the mock "spends" one cent per entry, so a low cap shows the capped banner. */
const maxCostAt = argv.indexOf("--max-cost");
const mockMaxCostUsd = maxCostAt >= 0 ? Number(argv[maxCostAt + 1]) : Number.NaN;
const relay = startLocalRelay(port);
let localRelay: LocalRelay | null =
	localPort === null ? null : startLocalRelay(localPort, { refuseMissingRooms: true });
const roomId = generateRoomId();
const rawKey = generateRoomKey();
const key = await importRoomKey(rawKey);
const writeToken = crypto.getRandomValues(new Uint8Array(16));
const writeTokenText = encodeBase64Url(writeToken);
const link = formatCollabLink(relay.url, roomId, rawKey, writeToken, localRelay?.url);
const viewLink = formatCollabLink(relay.url, roomId, rawKey, undefined, localRelay?.url);

// ── mutable session state ────────────────────────────────────────────────────

const entries: SessionEntry[] = [...fixtureEntries];
const agents: AgentSnapshot[] = fixtureAgents.map(agent => ({ ...agent }));
const peers = new Map<number, string>();
/** Peers that joined without the write token: their mutating frames are refused, like a real host. */
const readOnlyPeers = new Set<number>();
const transcriptBytes = new TextEncoder().encode(subagentTranscriptJsonl);
const transcriptDecoder = new TextDecoder();

let currentModel: WireModel = fixtureModel;
let thinkingLevel = "medium";
let profile = fixtureProfiles[0]?.name ?? "build";
let lastEntryId: string | null = entries[entries.length - 1]?.id ?? null;
let streaming = false;
/** Whether the last mock file restore can still be undone with `redo-files`. */
let fileRestoreRedoable = false;
/** Turns `/undo` removed from the mock's single active path, newest undo last; `redo` puts them back until the path moves on. */
const undoneTurns: UndoneTurn[] = [];
let queuedPrompts = 0;
/** The per-prompt model (id) of each queued prompt, oldest first; `undefined` = the session's model. */
let queuedModels: (string | undefined)[] = [];
/** Model id the running scripted turn answers on when its prompt chose one. */
let replayModel: string | undefined;
/** Follow-up prompts held until the running replay ends, oldest first. */
let followUps: { text: string; images: ImageContent[] | undefined; from: string; model?: string }[] = [];
let turnSeq = 0;
let liveEntrySeq = 0;
let replayQueue: ScriptedStep[] = [];
let replayTimer: Timer | null = null;
let tick = 0;
let shuttingDown = false;
let sessionName = fixtureHeader.title;

// ── sealed transport (order-preserving, mirrors relay-client) ────────────────

const ws = new WebSocket(`${relay.url}/r/${roomId}?role=host`);
ws.binaryType = "arraybuffer";
/** Host socket on the local relay; null while it is down or not requested. */
let localWs: WebSocket | null = null;

let sendChain: Promise<void> = Promise.resolve();
let recvChain: Promise<void> = Promise.resolve();

/** Seal and send a frame; peerId 0 broadcasts to both relays, N targets that guest on its relay. */
function sendFrame(frame: HostFrame, targetPeer = 0): void {
	sendChain = sendChain
		.then(async () => {
			const sealed = await seal(key, frame);
			if (targetPeer === 0) {
				for (const socket of [ws, localWs]) {
					if (socket?.readyState === WebSocket.OPEN) socket.send(packEnvelope(0, sealed));
				}
				return;
			}
			const socket = targetPeer >= LOCAL_PEER_BASE ? localWs : ws;
			if (socket?.readyState !== WebSocket.OPEN) return;
			socket.send(packEnvelope(targetPeer >= LOCAL_PEER_BASE ? targetPeer - LOCAL_PEER_BASE : targetPeer, sealed));
		})
		.catch((err: unknown) => {
			console.error("mock-host: send failed:", err);
		});
}

function buildState(): SessionState {
	const participants: SessionState["participants"] = [{ name: HOST_DISPLAY_NAME, role: "host" }];
	for (const name of peers.values()) participants.push({ name, role: "guest" });
	const tokens = 51_000 + entries.length * 120;
	return {
		isStreaming: streaming,
		queuedMessageCount: queuedPrompts + followUps.length,
		followUps: followUps.map(followUp => followUp.text),
		redoTurns: liveRedoSteps().length,
		sessionName,
		cwd: fixtureHeader.cwd,
		model: currentModel,
		thinkingLevel,
		profile,
		thinkingLevels: fixtureThinkingLevels[`${currentModel.provider}/${currentModel.id}`] ?? ["off"],
		contextUsage: {
			tokens,
			contextWindow: currentModel.contextWindow,
			percent:
				currentModel.contextWindow !== null && currentModel.contextWindow > 0
					? (tokens / currentModel.contextWindow) * 100
					: null,
		},
		participants,
		spend: Number.isFinite(mockMaxCostUsd)
			? {
					costUsd: entries.length * 0.01,
					tokens,
					maxCostUsd: mockMaxCostUsd,
					capped: entries.length * 0.01 >= mockMaxCostUsd,
				}
			: undefined,
	};
}

function broadcastState(): void {
	sendFrame({ t: "state", state: buildState() });
}

function appendEntry(entry: SessionEntry): void {
	entries.push(entry);
	lastEntryId = entry.id;
	sendFrame({ t: "entry", entry });
}

function notice(level: "info" | "warning" | "error", message: string): void {
	sendFrame({ t: "event", event: { type: "notice", level, message, source: "collab" } });
}

// ── scripted turn replay ─────────────────────────────────────────────────────

function startReplay(model?: string): void {
	turnSeq++;
	replayModel = model;
	replayQueue = makeScriptedTurn(turnSeq, lastEntryId);
	scheduleStep();
}

function scheduleStep(): void {
	replayTimer = setTimeout(() => {
		replayTimer = null;
		const step = replayQueue.shift();
		if (step) applyStep(step);
		if (replayQueue.length > 0) {
			scheduleStep();
			return;
		}
		if (queuedPrompts > 0) {
			queuedPrompts--;
			startReplay(queuedModels.shift());
			return;
		}
		const next = followUps.shift();
		if (next !== undefined) {
			appendPromptEntry(next.text, next.images, next.from);
			startReplay(next.model);
		}
	}, STEP_INTERVAL_MS);
}

/** A scripted step with its assistant messages attributed to `model`, as a per-prompt model choice does on the real host. */
function onModel(step: ScriptedStep, model: string | undefined): ScriptedStep {
	if (model === undefined) return step;
	if (step.kind === "entry" && step.entry.type === "message" && step.entry.message.role === "assistant") {
		return { kind: "entry", entry: { ...step.entry, message: { ...step.entry.message, model } } };
	}
	if (
		step.kind === "event" &&
		(step.event.type === "message_start" ||
			step.event.type === "message_update" ||
			step.event.type === "message_end") &&
		step.event.message.role === "assistant"
	) {
		return { kind: "event", event: { ...step.event, message: { ...step.event.message, model } } };
	}
	return step;
}

function applyStep(rawStep: ScriptedStep): void {
	const step = onModel(rawStep, replayModel);
	switch (step.kind) {
		case "event":
			sendFrame({ t: "event", event: step.event });
			break;
		case "entry":
			appendEntry(step.entry);
			break;
		case "state":
			streaming = step.streaming;
			broadcastState();
			break;
	}
}

function cancelReplay(): void {
	if (replayTimer !== null) {
		clearTimeout(replayTimer);
		replayTimer = null;
	}
	replayQueue = [];
}

// ── guest frame handling ─────────────────────────────────────────────────────

function peerName(fromPeer: number): string {
	return peers.get(fromPeer) ?? `guest-${fromPeer}`;
}

function handleHello(name: string, proto: number, token: string | undefined, fromPeer: number): void {
	if (proto !== COLLAB_PROTO) {
		sendFrame(
			{ t: "error", message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}` },
			fromPeer,
		);
		return;
	}
	const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
	peers.set(fromPeer, cleanName);
	const writer = token === writeTokenText;
	if (writer) readOnlyPeers.delete(fromPeer);
	else readOnlyPeers.add(fromPeer);
	sendFrame(
		{
			t: "welcome",
			proto: COLLAB_PROTO,
			header: fixtureHeader,
			state: buildState(),
			agents: agents.map(agent => ({ ...agent })),
			entryCount: entries.length,
			readOnly: writer ? undefined : true,
			models: writer
				? fixtureModels.map(model => ({
						...model,
						thinkingLevels: fixtureThinkingLevels[`${model.provider}/${model.id}`] ?? ["off"],
					}))
				: undefined,
			profiles: writer ? fixtureProfiles.map(candidate => ({ ...candidate })) : undefined,
			features: [
				"follow-up",
				"rewind",
				"commands",
				"rewind-files",
				"prompt-model",
				"context-items",
				"spend-cap",
				"undo",
				"profiles",
			],
			commands: writer ? fixtureCommands : undefined,
		},
		fromPeer,
	);
	sendFrame({ t: "snapshot-chunk", entries: [...entries], final: true }, fromPeer);
	console.log(`mock-host: ${cleanName} joined (peer ${fromPeer})${writer ? "" : " read-only"}`);
	broadcastState();
}

/** Refuses a read-only peer's mutating frame with an `error` frame, as a real host does. */
function refuseReadOnly(fromPeer: number): boolean {
	if (!readOnlyPeers.has(fromPeer)) return false;
	sendFrame({ t: "error", message: "read-only link: this guest cannot control the session" }, fromPeer);
	return true;
}

/** The file changes a rewind to before `entries[at]` would undo: the mock invents them from the dropped turns. */
function mockFilePlan(at: number): RewindFilesPlan {
	const dropped = entries.slice(Math.max(at, 0));
	return {
		revert: dropped.filter(entry => entry.type === "message" && entry.message.role === "assistant").length,
		remove: dropped.filter(entry => entry.type === "message" && entry.message.role === "user").length,
		recreate: 0,
	};
}

interface UndoneTurn {
	removed: SessionEntry[];
	leafAfter: string | null;
	draft: string;
}

function isPromptEntry(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user";
	return entry.type === "custom_message" && entry.customType === "collab-prompt";
}

/** The text and images of a prompt entry, as `/undo` hands them back to the message box. */
function promptDraft(entry: SessionEntry): { text: string; images: ImageContent[] } {
	let content: string | readonly (TextContent | ImageContent)[] = "";
	if (entry.type === "custom_message") content = entry.content;
	else if (entry.type === "message" && entry.message.role === "user") content = entry.message.content;
	if (typeof content === "string") return { text: content, images: [] };
	return {
		text: content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n"),
		images: content.flatMap(block => (block.type === "image" ? [block] : [])),
	};
}

/** The redo steps still valid: all dropped once the active path moved on from where the newest undo left it. */
function liveRedoSteps(): UndoneTurn[] {
	if (undoneTurns.at(-1)?.leafAfter !== lastEntryId) undoneTurns.length = 0;
	return undoneTurns;
}

/** What the mock reports as filling the context; pruning an item drops its row and the tokens it held. */
const CONTEXT_WINDOW = 200_000;
let contextUsed = 100_000;
let contextItems: ContextItemRow[] = (
	[
		["sys:0", "systemPrompt", "System prompt", 9_200, false],
		["tr:mock-bash", "toolResult", "bash bun test", 14_800, true],
		["file:/repo/src/app.tsx", "file", "src/app.tsx (3 reads)", 7_400, true],
		["tool:bash", "toolSchema", "tool schema: bash", 2_100, false],
		["img:mock-shot", "attachment", "attachment (user message)", 1_600, true],
	] as const
)
	.map(([id, kind, label, tokens, prunable]) => ({
		id,
		kind,
		label,
		tokens,
		share: tokens / contextUsed,
		prunable,
	}))
	.sort((a, b) => b.tokens - a.tokens);

function sendContextItems(fromPeer: number, pruned?: { entries: number; tokensFreed: number }): void {
	sendFrame(
		{
			t: "context-items",
			items: contextItems,
			usedTokens: contextUsed,
			contextWindow: CONTEXT_WINDOW,
			...(pruned ? { pruned } : {}),
		},
		fromPeer,
	);
}

function handleSessionCmd(cmd: SessionCommand, arg: string | undefined, fromPeer: number, restoreFiles = false): void {
	const who = peerName(fromPeer);
	switch (cmd) {
		case "model": {
			const next = fixtureModels.find(model => `${model.provider}/${model.id}` === arg);
			if (!next) {
				sendFrame({ t: "error", message: `unknown model: ${arg ?? "(none)"}` }, fromPeer);
				return;
			}
			currentModel = next;
			const levels = fixtureThinkingLevels[`${next.provider}/${next.id}`] ?? ["off"];
			if (!levels.includes(thinkingLevel))
				thinkingLevel = levels.includes("medium") ? "medium" : (levels[0] ?? "off");
			liveEntrySeq++;
			appendEntry({
				id: `live-${liveEntrySeq}`,
				parentId: lastEntryId,
				timestamp: new Date().toISOString(),
				type: "model_change",
				model: `${next.provider}/${next.id}`,
			});
			notice("info", `${who} switched model to ${next.name}`);
			broadcastState();
			break;
		}
		case "thinking": {
			const levels = fixtureThinkingLevels[`${currentModel.provider}/${currentModel.id}`] ?? ["off"];
			if (arg === undefined || !levels.includes(arg)) {
				sendFrame(
					{ t: "error", message: `${currentModel.name} does not accept thinking level ${arg ?? "(none)"}` },
					fromPeer,
				);
				return;
			}
			thinkingLevel = arg;
			liveEntrySeq++;
			appendEntry({
				id: `live-${liveEntrySeq}`,
				parentId: lastEntryId,
				timestamp: new Date().toISOString(),
				type: "thinking_level_change",
				thinkingLevel: arg,
			});
			notice("info", `${who} set thinking to ${arg}`);
			broadcastState();
			break;
		}
		case "profile": {
			const next = fixtureProfiles.find(candidate => candidate.name === arg);
			if (!next) {
				sendFrame({ t: "error", message: `unknown profile: ${arg ?? "(none)"}` }, fromPeer);
				return;
			}
			profile = next.name;
			notice("info", `${who} switched profile to ${next.name}`);
			broadcastState();
			break;
		}
		case "compact":
			notice("info", arg ? `${who} compacted the context (${arg})` : `${who} compacted the context`);
			break;
		case "rename": {
			const name = arg?.trim();
			if (!name) {
				sendFrame({ t: "error", message: "rename: session name cannot be empty" }, fromPeer);
				return;
			}
			sessionName = name;
			notice("info", `${who} renamed the session to "${name}"`);
			broadcastState();
			break;
		}
		case "unqueue": {
			const at = followUps.findIndex(followUp => followUp.text === arg);
			if (at < 0) {
				sendFrame({ t: "error", message: "unqueue: no queued follow-up with that text" }, fromPeer);
				return;
			}
			followUps.splice(at, 1);
			broadcastState();
			break;
		}
		case "rewind": {
			if (streaming || isReplaying()) {
				sendFrame({ t: "error", message: "rewind: wait for the agent to finish its turn" }, fromPeer);
				return;
			}
			const at = entries.findIndex(entry => entry.id === arg);
			const target = entries[at];
			const isPrompt =
				target !== undefined &&
				((target.type === "message" && target.message.role === "user") ||
					(target.type === "custom_message" && target.customType === "collab-prompt"));
			if (!isPrompt) {
				sendFrame({ t: "error", message: "rewind: that entry is not a prompt on the active path" }, fromPeer);
				return;
			}
			// The mock keeps only the active path, so the abandoned turns are simply dropped.
			const plan = mockFilePlan(at);
			entries.length = at;
			lastEntryId = entries[at - 1]?.id ?? null;
			sendFrame({ t: "branch", keep: lastEntryId, entries: [] });
			if (restoreFiles) {
				fileRestoreRedoable = true;
				sendFrame({ t: "files-restored", kind: "restore", plan, skipped: 0, canRedo: true }, fromPeer);
				notice("info", `${who} rewound the session to before a prompt and restored its files`);
			} else notice("info", `${who} rewound the session to before a prompt`);
			broadcastState();
			break;
		}
		case "undo": {
			if (streaming || isReplaying()) {
				sendFrame({ t: "error", message: "undo: wait for the agent to finish its turn" }, fromPeer);
				return;
			}
			const steps = liveRedoSteps();
			const at = entries.findLastIndex(isPromptEntry);
			if (at < 0) {
				sendFrame({ t: "error", message: "undo: nothing to undo" }, fromPeer);
				return;
			}
			const plan = mockFilePlan(at);
			const removed = entries.splice(at);
			const draft = promptDraft(removed[0]);
			lastEntryId = entries.at(-1)?.id ?? null;
			steps.push({ removed, leafAfter: lastEntryId, draft: draft.text });
			sendFrame({ t: "branch", keep: lastEntryId, entries: [] });
			const changed = plan.revert + plan.remove + plan.recreate > 0;
			sendFrame(
				{
					t: "turn-undone",
					kind: "undo",
					text: draft.text,
					images: draft.images.length > 0 ? draft.images : undefined,
					files: changed ? plan : undefined,
					skipped: changed ? 0 : undefined,
				},
				fromPeer,
			);
			notice("info", `${who} undid the last turn`);
			broadcastState();
			break;
		}
		case "redo": {
			if (streaming || isReplaying()) {
				sendFrame({ t: "error", message: "redo: wait for the agent to finish its turn" }, fromPeer);
				return;
			}
			const step = liveRedoSteps().pop();
			if (!step) {
				sendFrame({ t: "error", message: "redo: nothing to redo" }, fromPeer);
				return;
			}
			sendFrame({ t: "branch", keep: lastEntryId, entries: step.removed });
			entries.push(...step.removed);
			lastEntryId = entries.at(-1)?.id ?? null;
			sendFrame({ t: "turn-undone", kind: "redo", staleText: step.draft }, fromPeer);
			notice("info", `${who} redid the turn`);
			broadcastState();
			break;
		}
		case "context-items":
			sendContextItems(fromPeer);
			break;
		case "context-prune": {
			const item = contextItems.find(candidate => candidate.id === arg);
			if (!item?.prunable) {
				sendFrame({ t: "error", message: "context-prune: that item cannot be pruned" }, fromPeer);
				return;
			}
			contextItems = contextItems.filter(candidate => candidate !== item);
			contextUsed -= item.tokens;
			sendContextItems(fromPeer, { entries: 1, tokensFreed: item.tokens });
			notice("info", `${who} pruned ${item.label} from the context`);
			break;
		}
		case "rewind-preview": {
			const at = entries.findIndex(entry => entry.id === arg);
			sendFrame({ t: "rewind-preview", entryId: arg ?? "", files: at < 0 ? null : mockFilePlan(at) }, fromPeer);
			break;
		}
		case "redo-files": {
			if (streaming || isReplaying()) {
				sendFrame({ t: "error", message: "redo-files: wait for the agent to finish its turn" }, fromPeer);
				return;
			}
			if (!fileRestoreRedoable) {
				sendFrame({ t: "error", message: "redo-files: there is no file restore to undo" }, fromPeer);
				return;
			}
			fileRestoreRedoable = false;
			sendFrame(
				{
					t: "files-restored",
					kind: "redo",
					plan: { revert: 2, remove: 0, recreate: 1 },
					skipped: 0,
					canRedo: false,
				},
				fromPeer,
			);
			notice("info", `${who} undid the file restore`);
			break;
		}
	}
}

/** How the mock follows the real host's slash spellings of the session controls and the session-replacing commands. */
const MOCK_SLASH_COMMANDS: Record<
	string,
	{ cmd?: SessionCommand; takes: "none" | "optional" | "required"; hint?: string }
> = {
	model: { cmd: "model", takes: "required", hint: "<provider/id>" },
	switch: { cmd: "model", takes: "required", hint: "<provider/id>" },
	effort: { cmd: "thinking", takes: "required", hint: "<level>" },
	compact: { cmd: "compact", takes: "optional" },
	rename: { cmd: "rename", takes: "required", hint: "<title>" },
	undo: { cmd: "undo", takes: "none" },
	redo: { cmd: "redo", takes: "none" },
	new: { takes: "none" },
	fork: { takes: "none" },
	resume: { takes: "required", hint: "<session>" },
};

/**
 * Run a session-control or session-replacing slash command like the real host: the bare
 * selector form is refused with a hint, controls go through `handleSessionCmd`, and a
 * session switch ends this room (`bye`), which is where a guest without a paired
 * computer ends up. Resolves whether `name` was one of those commands.
 */
function runMockSlashCommand(name: string, args: string, fromPeer: number): boolean {
	if (!Object.hasOwn(MOCK_SLASH_COMMANDS, name)) return false;
	const spec = MOCK_SLASH_COMMANDS[name];
	const refuse = (message: string): boolean => {
		sendFrame({ t: "error", message }, fromPeer);
		return true;
	};
	if (spec.takes === "none" && args) return refuse(`/${name} takes no arguments`);
	if (spec.takes === "required" && !args) return refuse(`/${name} needs an argument: /${name} ${spec.hint}`);
	if (spec.cmd) {
		handleSessionCmd(spec.cmd, name === "effort" ? args.toLowerCase() : args || undefined, fromPeer);
		return true;
	}
	if (streaming || isReplaying()) {
		return refuse(`/${name}: wait for the current response or command to finish (stop it first if needed)`);
	}
	if (name === "resume" && !fixtureResumeChoices.some(choice => choice.value === args)) {
		return refuse(`/resume: no session matching "${args}" in this folder`);
	}
	notice("info", `${peerName(fromPeer)} ran /${name}`);
	sendFrame({ t: "bye", reason: MOCK_SESSION_SWITCH_REASON });
	return true;
}

function appendPromptEntry(text: string, images: ImageContent[] | undefined, from: string): void {
	liveEntrySeq++;
	appendEntry({
		id: `live-${liveEntrySeq}`,
		parentId: lastEntryId,
		timestamp: new Date().toISOString(),
		type: "custom_message",
		customType: "collab-prompt",
		content: images && images.length > 0 ? [{ type: "text", text }, ...images] : text,
		details: { from },
		display: true,
	});
}

function isReplaying(): boolean {
	return replayTimer !== null || replayQueue.length > 0;
}

function handlePrompt(
	text: string,
	images: ImageContent[] | undefined,
	deliver: "follow-up" | undefined,
	fromPeer: number,
	promptModel?: string,
	promptThinking?: string,
): void {
	if (refuseReadOnly(fromPeer)) return;
	// Like the real host: only the listed commands run for a guest; other builtins stay on the host.
	const typed = /^\/(\S+)/.exec(text)?.[1];
	if (typed !== undefined && Object.hasOwn(fixtureHostOnlyCommands, typed)) {
		sendFrame({ t: "error", message: `/${typed} can only be run on the host` }, fromPeer);
		return;
	}
	const slash = /^\/(\S+)(?:\s+([\s\S]*\S))?\s*$/.exec(text);
	if (slash && runMockSlashCommand(slash[1] ?? "", slash[2] ?? "", fromPeer)) return;
	// Like the real host: a chosen model must be one the welcome offered, its thinking level one that model accepts.
	let chosenModel: string | undefined;
	if (promptModel !== undefined) {
		const picked = fixtureModels.find(model => `${model.provider}/${model.id}` === promptModel);
		if (!picked) {
			sendFrame({ t: "error", message: `prompt not sent: unknown model "${promptModel}"` }, fromPeer);
			return;
		}
		const levels = fixtureThinkingLevels[promptModel] ?? ["off"];
		if (promptThinking !== undefined && !levels.includes(promptThinking)) {
			sendFrame(
				{
					t: "error",
					message: `prompt not sent: ${promptModel} does not accept thinking level "${promptThinking}"`,
				},
				fromPeer,
			);
			return;
		}
		chosenModel = picked.id;
	} else if (promptThinking !== undefined) {
		sendFrame({ t: "error", message: "prompt not sent: a thinking level needs a model to apply to" }, fromPeer);
		return;
	}
	if (deliver === "follow-up" && isReplaying()) {
		// Like the real host: no transcript entry until the turn that carries it starts.
		followUps.push({ text, images, from: peerName(fromPeer), model: chosenModel });
		broadcastState();
		return;
	}
	appendPromptEntry(text, images, peerName(fromPeer));
	if (isReplaying()) {
		queuedPrompts++;
		queuedModels.push(chosenModel);
		broadcastState();
		return;
	}
	startReplay(chosenModel);
}

function handleAbort(fromPeer: number): void {
	if (refuseReadOnly(fromPeer)) return;
	const wasReplaying = replayTimer !== null || replayQueue.length > 0;
	cancelReplay();
	queuedPrompts = 0;
	queuedModels = [];
	followUps = [];
	notice("info", `${peerName(fromPeer)} interrupted`);
	if (wasReplaying) sendFrame({ t: "event", event: { type: "agent_end" } });
	streaming = false;
	broadcastState();
}

function handleAgentCmd(cmd: string, agentId: string, fromPeer: number): void {
	notice("info", `${peerName(fromPeer)} sent agent-cmd ${cmd} → ${agentId}`);
}

function handleFetchTranscript(reqId: number, fromByte: number, fromPeer: number): void {
	const total = transcriptBytes.byteLength;
	const start = Math.max(0, Math.min(fromByte, total));
	const text = start >= total ? "" : transcriptDecoder.decode(transcriptBytes.subarray(start));
	// We always serve to EOF, so the next offset base is the full size.
	sendFrame({ t: "transcript", reqId, text, newSize: total }, fromPeer);
}

function handleFrame(frame: WireFrame, fromPeer: number): void {
	switch (frame.t) {
		case "hello":
			handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
			break;
		case "prompt":
			handlePrompt(frame.text, frame.images, frame.deliver, fromPeer, frame.model, frame.thinking);
			break;
		case "abort":
			handleAbort(fromPeer);
			break;
		case "session-cmd":
			if (!refuseReadOnly(fromPeer)) handleSessionCmd(frame.cmd, frame.arg, fromPeer, frame.restoreFiles === true);
			break;
		case "agent-cmd":
			handleAgentCmd(frame.cmd, frame.agentId, fromPeer);
			break;
		case "fetch-transcript":
			handleFetchTranscript(frame.reqId, frame.fromByte, fromPeer);
			break;
		default:
			// Host-frame echoes or unknown types: ignore.
			break;
	}
}

function handleControl(text: string, base: number): void {
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof msg !== "object" || msg === null) return;
	const control = msg as { t?: unknown; peer?: unknown };
	if (control.t === "peer-left" && typeof control.peer === "number") releasePeer(control.peer + base);
}

function releasePeer(peer: number): void {
	const name = peers.get(peer);
	peers.delete(peer);
	readOnlyPeers.delete(peer);
	if (name) console.log(`mock-host: ${name} left (peer ${peer})`);
	broadcastState();
}

/** Both relays feed one handler; `base` shifts the local relay's peer ids out of the main relay's range. */
function attach(socket: WebSocket, base: number): void {
	socket.onmessage = event => {
		const data: unknown = event.data;
		if (typeof data === "string") {
			handleControl(data, base);
			return;
		}
		if (!(data instanceof ArrayBuffer)) return;
		const envelope = unpackEnvelope(new Uint8Array(data));
		if (!envelope) return;
		recvChain = recvChain
			.then(async () => {
				const frame = await open(key, envelope.payload);
				handleFrame(frame, envelope.peerId + base);
			})
			.catch((err: unknown) => {
				console.error("mock-host: dropping undecryptable frame:", err);
			});
	};
}

function connectLocal(): void {
	if (localRelay === null) return;
	const socket = new WebSocket(`${localRelay.url}/r/${roomId}?role=host`);
	socket.binaryType = "arraybuffer";
	localWs = socket;
	attach(socket, LOCAL_PEER_BASE);
	socket.onopen = () => console.log(`mock-host: serving the room on the local relay ${localRelay?.url}`);
	socket.onclose = () => {
		if (localWs !== socket) return;
		localWs = null;
		console.log("mock-host: local relay is down; guests on it must fall back to the main relay");
		// Deleting the visited entry while iterating a Map is safe.
		for (const peer of peers.keys()) if (peer >= LOCAL_PEER_BASE) releasePeer(peer);
	};
}

ws.onopen = () => {
	console.log("mock collab host ready");
	console.log(`join link: ${link}`);
	console.log(`view link (read-only): ${viewLink}`);
	console.log("paste a link into the collab-web connect screen (bun ./index.html), Ctrl+C stops the host");
	if (localRelay !== null) console.log("type `local off` / `local on` to stop / restart the local relay");
};

attach(ws, 0);

ws.onclose = event => {
	if (shuttingDown) return;
	console.error(`mock-host: relay socket closed (${event.code} ${event.reason || "no reason"})`);
	shutdown(1);
};

connectLocal();

/** `local off` / `local on`: take the local relay away and bring it back on the same port. */
async function readCommands(): Promise<void> {
	if (localPort === null) return;
	for await (const line of console) {
		const command = line.trim();
		if (command === "local off" && localRelay !== null) {
			localRelay.stop();
			localRelay = null;
		} else if (command === "local on" && localRelay === null) {
			localRelay = startLocalRelay(localPort, { refuseMissingRooms: true });
			connectLocal();
		}
	}
}
void readCommands();

// ── progress ticker ──────────────────────────────────────────────────────────

const tickInterval: Timer = setInterval(() => {
	tick++;
	sendFrame({ t: "bus", channel: "task:subagent:progress", data: makeProbeProgress(tick) });
	const now = Date.now();
	for (const agent of agents) {
		if (agent.status === "running") agent.lastActivity = now;
	}
	if (tick % AGENTS_SNAPSHOT_EVERY === 0) {
		sendFrame({ t: "agents", agents: agents.map(agent => ({ ...agent })) });
	}
}, TICK_INTERVAL_MS);

// ── shutdown ─────────────────────────────────────────────────────────────────

function shutdown(code: number): void {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelReplay();
	clearInterval(tickInterval);
	sendFrame({ t: "bye", reason: "mock host shutting down" });
	// Let the bye flush through the send chain before tearing the room down.
	void sendChain.finally(() => {
		try {
			ws.close(1000);
		} catch {
			// already closing
		}
		relay.stop();
		localRelay?.stop();
		process.exit(code);
	});
}

process.on("SIGINT", () => {
	console.log("\nmock-host: shutting down");
	shutdown(0);
});
