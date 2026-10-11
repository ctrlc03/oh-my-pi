/**
 * Contract: a writer's `prompt` may name one of the host's selectable models (and one of that
 * model's thinking levels) to run on for that prompt only. The host refuses models it does not
 * offer and thinking levels the model rejects, never lets a read-only guest prompt, and hands the
 * choice to the session for steers and follow-ups alike. Runs over the in-memory relay with the
 * real CollabHost; the agent session is a double that records what the host asked of it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PromptModelOverride } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function fakeModel(id: string): Model {
	return { provider: "acme", id, name: id.toUpperCase(), contextWindow: 100_000, api: "openai-completions" } as Model;
}

const SESSION_MODEL = fakeModel("small");
const BIG = fakeModel("big");
const CATALOG = [SESSION_MODEL, BIG];
/** Levels differ per model, as for real catalogs: `big` reasons, `small` does not. */
const LEVELS: Record<string, string[]> = { small: [], big: ["off", "auto", "low", "high"] };

interface PromptCall {
	streamingBehavior: unknown;
	queueChipText: unknown;
	modelOverride: PromptModelOverride | undefined;
}

const prompts: PromptCall[] = [];
const promptWaiters: (() => void)[] = [];

function makeCtx(catalog: Model[] = CATALOG): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(),
		session: {
			isStreaming: false,
			isBusyForSnapshot: false,
			isSessionTransitioning: false,
			isCompacting: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "prompt-model",
			model: SESSION_MODEL,
			thinkingLevel: undefined,
			scopedModels: [],
			modelRegistry: { getAvailable: () => catalog },
			slashCommands: [],
			promptTemplates: [],
			customCommands: [],
			extensionRunner: undefined,
			getAvailableEffortSelectors: (model: Model = SESSION_MODEL) => LEVELS[model.id] ?? [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			promptCustomMessage: (_message: unknown, options: PromptCall) => {
				prompts.push({
					streamingBehavior: options.streamingBehavior,
					queueChipText: options.queueChipText,
					modelOverride: options.modelOverride,
				});
				for (const wake of promptWaiters.splice(0)) wake();
				return Promise.resolve(true);
			},
			subscribe: () => () => {},
			emitNotice: () => {},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		skillCommands: new Map(),
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	next<T extends CollabFrame["t"]>(
		type: T,
		match?: (frame: Extract<CollabFrame, { t: T }>) => boolean,
		from?: number,
	): Promise<Extract<CollabFrame, { t: T }>>;
}

async function joinAsGuest(link: string, readOnly: boolean): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken && !readOnly ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const frames: CollabFrame[] = [];
	const waiters: (() => void)[] = [];
	socket.onFrame = frame => {
		frames.push(frame);
		for (const wake of waiters.splice(0)) wake();
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	const next: TestGuest["next"] = async (type, match, from = 0) => {
		for (;;) {
			const found = frames.slice(from).find(frame => frame.t === type && (!match || match(frame as never)));
			if (found) return found as never;
			const woken = Promise.withResolvers<void>();
			waiters.push(woken.resolve);
			await woken.promise;
		}
	};
	return { socket, frames, next };
}

const guestCleanups: (() => void)[] = [];
let host: CollabHost;

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

afterEach(async () => {
	prompts.length = 0;
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function join(readOnly = false, catalog?: Model[]): Promise<TestGuest> {
	host = new CollabHost(makeCtx(catalog));
	await host.start("ws://localhost:8788");
	const guest = await joinAsGuest(host.link, readOnly);
	guestCleanups.push(() => guest.socket.close());
	await guest.next("welcome");
	return guest;
}

async function nextError(guest: TestGuest, from: number): Promise<string> {
	return (await guest.next("error", undefined, from)).message;
}

async function promptsReceived(count: number): Promise<void> {
	while (prompts.length < count) await new Promise<void>(resolve => promptWaiters.push(resolve));
}

describe("collab per-prompt model", () => {
	it("advertises the feature and each model's thinking levels", async () => {
		const guest = await join();
		const welcome = await guest.next("welcome");
		expect(welcome.features).toContain("prompt-model");
		expect(welcome.models?.find(model => model.id === "big")?.thinkingLevels).toEqual(LEVELS.big);
	});

	it("lists every provider's models when one provider has a catalog of hundreds", async () => {
		const bedrock = Array.from(
			{ length: 250 },
			(_, i) => ({ ...fakeModel(`b${String(i).padStart(3, "0")}`), provider: "amazon-bedrock" }) as Model,
		);
		const anthropic = ["claude-opus", "claude-sonnet", "claude-haiku"].map(
			id => ({ ...fakeModel(id), provider: "anthropic" }) as Model,
		);
		const guest = await join(false, [...bedrock, ...anthropic]);
		const welcome = await guest.next("welcome");
		const listed = welcome.models?.filter(model => model.provider === "anthropic").map(model => model.id);
		expect(listed?.sort()).toEqual(["claude-haiku", "claude-opus", "claude-sonnet"]);
	});

	it("hands the chosen model and thinking level to the session, for steers and follow-ups", async () => {
		const guest = await join();
		guest.socket.send({ t: "prompt", text: "now", model: "acme/big", thinking: "high" });
		guest.socket.send({ t: "prompt", text: "later", deliver: "follow-up", model: "acme/big" });
		guest.socket.send({ t: "prompt", text: "plain" });
		await promptsReceived(3);
		expect(prompts).toEqual([
			{
				streamingBehavior: "steer",
				queueChipText: "now",
				modelOverride: { model: BIG, thinkingLevel: Effort.High },
			},
			{ streamingBehavior: "followUp", queueChipText: "later", modelOverride: { model: BIG } },
			{ streamingBehavior: "steer", queueChipText: "plain", modelOverride: undefined },
		]);
	});

	it("refuses unknown models and unaccepted thinking levels without sending the prompt", async () => {
		const guest = await join();
		let from = guest.frames.length;
		guest.socket.send({ t: "prompt", text: "a", model: "acme/nope" });
		expect(await nextError(guest, from)).toContain("unknown model");
		from = guest.frames.length;
		guest.socket.send({ t: "prompt", text: "b", model: "acme/big", thinking: "max" });
		expect(await nextError(guest, from)).toContain("does not accept thinking level");
		guest.socket.send({ t: "prompt", text: "c", thinking: "high" });
		guest.socket.send({ t: "prompt", text: "d", model: 7 } as unknown as CollabFrame);
		// The accepted prompt after the refused ones proves none of them reached the session.
		guest.socket.send({ t: "prompt", text: "ok", model: "acme/big" });
		await promptsReceived(1);
		expect(prompts.map(call => call.queueChipText)).toEqual(["ok"]);
	});

	it("does not let a read-only guest prompt with a model", async () => {
		const guest = await join(true);
		const from = guest.frames.length;
		guest.socket.send({ t: "prompt", text: "sneaky", model: "acme/big" });
		await nextError(guest, from);
		expect(prompts).toEqual([]);
	});
});
