/**
 * Contract: a writer's welcome lists the slash commands it may run, and a prompt
 * naming one runs through the host's command machinery with the guest as author,
 * while host-only commands are refused and unknown `/text` stays an ordinary
 * prompt. Runs over the in-memory relay with the real CollabHost, the real
 * builtin registry and the real template/skill expansion; only the agent session
 * and interactive context are doubles.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandShellExpansion } from "@oh-my-pi/pi-coding-agent/config/command-shell";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TurnUndoError } from "@oh-my-pi/pi-coding-agent/session/turn-undo";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface PromptCall {
	content: unknown;
	from: unknown;
	streamingBehavior: unknown;
	queueChipText: unknown;
}

interface Harness {
	ctx: InteractiveModeContext;
	prompts: PromptCall[];
	notices: string[];
	planCalls: (string | undefined)[];
	retries: number;
	/** Text the host's own input path (`session.prompt`) received: it runs extension commands, so a guest's text must never reach it. */
	hostInputs: string[];
	state: {
		planModeEnabled: boolean;
		retryResult: boolean;
		goalModeEnabled: boolean;
		busy: boolean;
		streaming: boolean;
		undoRefusal: string | undefined;
	};
	modelSwitches: string[];
	thinkingLevels: string[];
	compactions: (string | undefined)[];
	/** Session-replacing handlers the host ran, by command name. */
	switches: string[];
	/** Turn undo and redo calls the session double received, in order. */
	turns: string[];
	/** Resolves once `ready()` holds; re-checked each time the session double records something. */
	until(ready: () => boolean): Promise<void>;
}

let skillDir: string;
let workDir: string;
let sessionCounter = 0;

const CATALOG = [
	{ provider: "acme", id: "small", name: "Small", contextWindow: 100_000 },
	{ provider: "acme", id: "big", name: "Big", contextWindow: 1_000_000 },
];

interface HostOptions {
	/** A session on disk, for the commands that replace it; in memory by default. */
	manager?: SessionManager;
	autoStart?: "off" | "view" | "control";
}

function makeHost(options: HostOptions = {}): Harness {
	const manager = options.manager ?? SessionManager.inMemory();
	const prompts: PromptCall[] = [];
	const waiters: (() => void)[] = [];
	const notices: string[] = [];
	const state = {
		planModeEnabled: false,
		retryResult: true,
		goalModeEnabled: false,
		busy: false,
		streaming: false,
		undoRefusal: undefined as string | undefined,
	};
	const hostInputs: string[] = [];
	const harness = {
		prompts,
		notices,
		planCalls: [] as (string | undefined)[],
		retries: 0,
		hostInputs,
		state,
		modelSwitches: [] as string[],
		thinkingLevels: [] as string[],
		compactions: [] as (string | undefined)[],
		switches: [] as string[],
		turns: [] as string[],
	} as Harness;
	harness.until = async ready => {
		while (!ready()) await new Promise<void>(resolve => waiters.push(resolve));
	};
	const wake = () => {
		for (const resolve of waiters.splice(0)) resolve();
	};
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: manager,
		collabController: { autoStartMode: options.autoStart ?? "off" },
		skillCommands: new Map([
			[
				"skill:demo",
				{ name: "demo", description: "Demo skill", filePath: path.join(skillDir, "SKILL.md"), baseDir: skillDir },
			],
		]),
		get planModeEnabled() {
			return state.planModeEnabled;
		},
		get goalModeEnabled() {
			return state.goalModeEnabled;
		},
		// Like the real one: entering plan mode submits the argument as the host's own input.
		handlePlanModeCommand: (arg: string | undefined) => {
			harness.planCalls.push(arg);
			state.planModeEnabled = true;
			if (arg) hostInputs.push(arg);
			wake();
			return Promise.resolve(false);
		},
		session: {
			get isStreaming() {
				return state.streaming;
			},
			get isBusyForSnapshot() {
				return state.busy;
			},
			isSessionTransitioning: false,
			isCompacting: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "slash",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => ["off", "low", "high"],
			scopedModels: [],
			modelRegistry: { getAvailable: () => CATALOG },
			getContextUsage: () => ({ tokens: 10 }),
			resolveTemporaryModelThinkingLevel: () => undefined,
			setModelTemporary: (model: { provider: string; id: string }) => {
				harness.modelSwitches.push(`${model.provider}/${model.id}`);
				wake();
				return Promise.resolve();
			},
			setThinkingLevel: (level: string) => {
				harness.thinkingLevels.push(level);
				wake();
			},
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			// The turn undo itself is covered against a real session; here only the host's routing is.
			turnUndo: {
				redoDepth: 0,
				undo: () => {
					harness.turns.push("undo");
					wake();
					if (state.undoRefusal) return Promise.reject(new TurnUndoError(state.undoRefusal));
					return Promise.resolve({
						editorText: "second",
						files: { plan: { revert: 1, remove: 0, recreate: 0 }, skipped: 0 },
						redoDepth: 1,
					});
				},
				redo: () => {
					harness.turns.push("redo");
					wake();
					if (state.undoRefusal) return Promise.reject(new TurnUndoError(state.undoRefusal));
					return Promise.resolve({ staleDraft: "second", redoDepth: 0 });
				},
			},
			slashCommands: [
				{
					name: "review",
					description: "Review files",
					argumentHint: "<paths>",
					content: "Review these: $ARGUMENTS",
					source: "test",
				},
				// A file command a builtin shadows is never reachable, so it must not be listed.
				{ name: "model", description: "shadowed", content: "x", source: "test" },
			],
			promptTemplates: [
				{ name: "fix-tests", description: "Fix the failing tests", content: "Fix tests in $1", source: "(user)" },
				// An extension command wins over a template of the same name.
				{ name: "ext-wins", description: "shadowed", content: "x", source: "(user)" },
			],
			customCommands: [],
			createCommandShell: () =>
				new CommandShellExpansion({
					mode: "user",
					cwd: os.tmpdir(),
					timeoutMs: 10_000,
					sessionKey: "host-slash-test",
				}),
			resolveCommandShell: (shell: CommandShellExpansion, text: string) => shell.resolve(text),
			extensionRunner: {
				getCommand: (name: string) => (name === "ext-wins" || name === "ext-only" ? {} : undefined),
			},
			retry: () => {
				harness.retries++;
				wake();
				return Promise.resolve(state.retryResult);
			},
			prompt: (text: string) => {
				hostInputs.push(text);
				return Promise.resolve();
			},
			promptCustomMessage: (
				message: { content: unknown; details?: { from?: unknown } },
				options: { streamingBehavior: unknown; queueChipText: unknown },
			) => {
				prompts.push({
					content: message.content,
					from: message.details?.from,
					streamingBehavior: options.streamingBehavior,
					queueChipText: options.queueChipText,
				});
				wake();
				return Promise.resolve(true);
			},
			subscribe: () => () => {},
			emitNotice: (_level: string, message: string) => {
				notices.push(message);
				wake();
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		handleCompactCommand: (instructions?: string) => {
			harness.compactions.push(instructions);
			wake();
			return Promise.resolve("ok");
		},
		updateEditorBorderColor: () => {},
		// The real ones refuse on the host terminal; these switch the session like they do when they run.
		handleClearCommand: async () => {
			harness.switches.push("new");
			await manager.newSession();
			wake();
		},
		handleForkCommand: async () => {
			harness.switches.push("fork");
			await manager.fork();
			wake();
		},
		handleResumeSession: async (sessionPath: string) => {
			harness.switches.push("resume");
			await manager.setSessionFile(sessionPath);
			wake();
		},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	harness.ctx = ctx;
	return harness;
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	next<T extends CollabFrame["t"]>(type: T): Promise<Extract<CollabFrame, { t: T }>>;
	/** Resolves when another frame arrives. */
	nextFrame(): Promise<void>;
}

async function joinAsGuest(link: string, readOnly = false): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken && !readOnly ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
	const frames: CollabFrame[] = [];
	const waiters: (() => void)[] = [];
	socket.onFrame = frame => {
		frames.push(frame);
		for (const wake of waiters.splice(0)) wake();
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	const next: TestGuest["next"] = async type => {
		for (;;) {
			const found = frames.find(frame => frame.t === type);
			if (found) return found as never;
			const woken = Promise.withResolvers<void>();
			waiters.push(woken.resolve);
			await woken.promise;
		}
	};
	const nextFrame = () => new Promise<void>(resolve => waiters.push(resolve));
	return { socket, frames, next, nextFrame };
}

const guestCleanups: (() => void)[] = [];
let harness: Harness;
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-skill-"));
	workDir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-session-"));
	await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nSKILL BODY\n");
});
afterAll(async () => {
	uninstallInMemoryRelay();
	await fs.rm(skillDir, { recursive: true, force: true });
	await fs.rm(workDir, { recursive: true, force: true });
});
afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function startAndJoin(readOnly = false, options: HostOptions = {}): Promise<TestGuest> {
	harness = makeHost(options);
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8788");
	const guest = await joinAsGuest(host.link, readOnly);
	guestCleanups.push(() => guest.socket.close());
	await guest.next("welcome");
	return guest;
}

/** Notices announcing a command a guest ran (joins are announced too). */
function ran(): string[] {
	return harness.notices.filter(notice => notice.includes(" ran /"));
}

/** The message of the `index`th `error` frame the guest received, waiting for it. */
async function errorAt(guest: TestGuest, index: number): Promise<string> {
	for (;;) {
		const found = guest.frames.filter(frame => frame.t === "error")[index];
		if (found?.t === "error") return found.message;
		await guest.nextFrame();
	}
}

describe("collab slash command list", () => {
	it("lists what a writer may run and nothing a guest must not", async () => {
		const guest = await startAndJoin();
		const welcome = await guest.next("welcome");
		expect(welcome.features).toContain("commands");
		const commands = welcome.commands ?? [];
		const names = commands.map(command => command.name);
		expect(names).toEqual([
			"plan",
			"model",
			"effort",
			"undo",
			"redo",
			"compact",
			"retry",
			"rename",
			"review",
			"fix-tests",
			"skill:demo",
		]);
		expect(commands.find(command => command.name === "review")).toEqual({
			name: "review",
			description: "Review files",
			args: "<paths>",
		});
		expect(commands.find(command => command.name === "plan")?.args).toBe("[prompt]");
		// Builtins that exit, sign in or change settings; shadowed entries; extension commands.
		for (const hidden of ["exit", "quit", "login", "settings", "ext-wins", "ext-only"]) {
			expect(names).not.toContain(hidden);
		}
	});

	it("sends no list to a read-only link", async () => {
		const guest = await startAndJoin(true);
		expect((await guest.next("welcome")).commands).toBeUndefined();
	});
});

describe("collab slash command dispatch", () => {
	it("expands a file command and a prompt template as the guest's prompt, queueing the typed text", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/review a.ts b.ts" });
		guest.socket.send({ t: "prompt", text: "/fix-tests src/x.test.ts", deliver: "follow-up" });
		await harness.until(() => harness.prompts.length >= 2);
		expect(harness.prompts).toEqual([
			{
				content: "Review these: a.ts b.ts",
				from: "guest",
				streamingBehavior: "steer",
				queueChipText: "/review a.ts b.ts",
			},
			{
				content: "Fix tests in src/x.test.ts",
				from: "guest",
				streamingBehavior: "followUp",
				queueChipText: "/fix-tests src/x.test.ts",
			},
		]);
	});

	it("loads a skill for /skill:<name> and refuses an unknown one", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/skill:demo tighten it" });
		await harness.until(() => harness.prompts.length >= 1);
		const content = String(harness.prompts[0]?.content);
		expect(content).toContain("SKILL BODY");
		expect(content).toContain("tighten it");
		expect(harness.prompts[0]?.from).toBe("guest");

		guest.socket.send({ t: "prompt", text: "/skill:ghost" });
		expect(await errorAt(guest, 0)).toBe("/skill:ghost is not a skill on this host");
		expect(harness.prompts).toHaveLength(1);
	});

	it("refuses host-only commands with a targeted error and runs none of them", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/exit" });
		expect(await errorAt(guest, 0)).toBe("/exit can only be run on the host");
		guest.socket.send({ t: "prompt", text: "/login github" });
		expect(await errorAt(guest, 1)).toBe("/login can only be run on the host");
		guest.socket.send({ t: "prompt", text: "/ext-only now" });
		expect(await errorAt(guest, 2)).toBe("/ext-only is a host command and can only be run on the host");
		guest.socket.send({ t: "prompt", text: "/ext-wins now" });
		expect(await errorAt(guest, 3)).toBe("/ext-wins is a host command and can only be run on the host");
		expect(harness.prompts).toEqual([]);
		expect(harness.planCalls).toEqual([]);
	});

	it("sends text that names no host command as an ordinary prompt", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/tmp/build is full" });
		guest.socket.send({ t: "prompt", text: "plain words" });
		await harness.until(() => harness.prompts.length >= 2);
		expect(harness.prompts.map(p => [p.content, p.queueChipText])).toEqual([
			["/tmp/build is full", "/tmp/build is full"],
			["plain words", "plain words"],
		]);
	});

	it("enters plan mode without arguments and sends what follows as the guest's own prompt", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/plan add a retry button" });
		await harness.until(() => harness.prompts.length >= 1);
		expect(harness.planCalls).toEqual([undefined]);
		expect(ran()).toEqual(["guest ran /plan"]);
		expect(harness.prompts.map(p => [p.content, p.from, p.queueChipText])).toEqual([
			["add a retry button", "guest", "add a retry button"],
		]);
		expect(harness.hostInputs).toEqual([]);
	});

	it("never lets /plan carry a host-only command into the host's own input", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/plan /ext-only prod" });
		expect(await errorAt(guest, 0)).toBe("/ext-only is a host command and can only be run on the host");
		guest.socket.send({ t: "prompt", text: "/plan /exit" });
		expect(await errorAt(guest, 1)).toBe(
			"/plan: plan mode is already on or paused; change it from the host terminal",
		);
		expect(harness.hostInputs).toEqual([]);
		expect(harness.prompts).toEqual([]);
	});

	it("keeps the images of /plan <prompt> and refuses images with nothing to send them with", async () => {
		const guest = await startAndJoin();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		guest.socket.send({ t: "prompt", text: "/plan look at this", images: [image] });
		await harness.until(() => harness.prompts.length >= 1);
		expect(harness.prompts[0]?.content).toEqual([{ type: "text", text: "look at this" }, image]);

		harness.state.planModeEnabled = false;
		guest.socket.send({ t: "prompt", text: "/plan", images: [image] });
		expect(await errorAt(guest, 0)).toBe("/plan: images cannot be sent with this command");
		guest.socket.send({ t: "prompt", text: "/retry", images: [image] });
		expect(await errorAt(guest, 1)).toBe("/retry: images cannot be sent with this command");
		expect(harness.retries).toBe(0);
	});

	it("tells the guest, and not the room, when plan mode cannot start", async () => {
		const guest = await startAndJoin();
		harness.state.planModeEnabled = true;
		guest.socket.send({ t: "prompt", text: "/plan" });
		expect(await errorAt(guest, 0)).toBe(
			"/plan: plan mode is already on or paused; change it from the host terminal",
		);
		harness.state.planModeEnabled = false;
		harness.state.goalModeEnabled = true;
		guest.socket.send({ t: "prompt", text: "/plan do it" });
		expect(await errorAt(guest, 1)).toBe("/plan: exit goal or vibe mode on the host first");
		expect(harness.planCalls).toEqual([]);
		expect(ran()).toEqual([]);
	});

	it("runs /retry, refuses its arguments, and reports when there is nothing to retry", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/retry" });
		await harness.until(() => harness.notices.includes("guest ran /retry"));
		guest.socket.send({ t: "prompt", text: "/retry harder" });
		expect(await errorAt(guest, 0)).toBe("/retry takes no arguments");
		expect(harness.retries).toBe(1);

		harness.state.retryResult = false;
		guest.socket.send({ t: "prompt", text: "/retry" });
		expect(await errorAt(guest, 1)).toBe("/retry: nothing to retry");
		expect(ran()).toEqual(["guest ran /retry"]);
	});

	it("keeps prompts in the order sent when an earlier slash prompt needs async work", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/skill:demo first" });
		guest.socket.send({ t: "prompt", text: "second" });
		await harness.until(() => harness.prompts.length >= 2);
		expect(String(harness.prompts[0]?.content)).toContain("SKILL BODY");
		expect(harness.prompts[1]?.content).toBe("second");
	});

	it("refuses commands from a read-only link", async () => {
		const guest = await startAndJoin(true);
		guest.socket.send({ t: "prompt", text: "/plan do it" });
		await errorAt(guest, 0);
		expect(harness.planCalls).toEqual([]);
		expect(harness.prompts).toEqual([]);
	});
});

describe("collab guest session controls as slash commands", () => {
	it("refuses the bare forms that would open a selector, and keeps the argument hint", async () => {
		const guest = await startAndJoin();
		const names = ["model", "effort", "rename", "resume"];
		const hints = ["<provider/id>", "<level>", "<title>", "<session>"];
		for (const name of names) guest.socket.send({ t: "prompt", text: `/${name}` });
		for (const [index, name] of names.entries()) {
			const message = await errorAt(guest, index);
			expect(message).toStartWith(`/${name} needs an argument`);
			expect(message).toContain(hints[index] ?? "");
		}
		expect(harness.modelSwitches).toEqual([]);
		expect(harness.thinkingLevels).toEqual([]);
		expect(ran()).toEqual([]);
	});

	it("switches the model for this session only, and announces it once", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/model acme/big" });
		await harness.until(() => ran().length === 1);
		expect(harness.modelSwitches).toEqual(["acme/big"]);
		expect(ran()).toEqual(["guest ran /model"]);

		guest.socket.send({ t: "prompt", text: "/model acme/ghost" });
		expect(await errorAt(guest, 0)).toStartWith("/model: unknown model");
		expect(harness.modelSwitches).toEqual(["acme/big"]);
		expect(ran()).toEqual(["guest ran /model"]);
	});

	it("does not switch the model while the host is answering", async () => {
		const guest = await startAndJoin();
		harness.state.streaming = true;
		guest.socket.send({ t: "prompt", text: "/model acme/big" });
		expect(await errorAt(guest, 0)).toStartWith("/model: ");
		expect(harness.modelSwitches).toEqual([]);
		expect(ran()).toEqual([]);
	});

	it("sets the thinking level case-insensitively and refuses one the model lacks", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/effort HIGH" });
		await harness.until(() => ran().length === 1);
		expect(harness.thinkingLevels).toEqual(["high"]);
		expect(ran()).toEqual(["guest ran /effort"]);

		guest.socket.send({ t: "prompt", text: "/effort turbo" });
		expect(await errorAt(guest, 0)).toStartWith("/effort: ");
		expect(harness.thinkingLevels).toEqual(["high"]);
		expect(ran()).toEqual(["guest ran /effort"]);
	});

	it("compacts with the instructions given, and not with nothing to compact", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/compact" });
		expect(await errorAt(guest, 0)).toStartWith("/compact: ");
		expect(harness.compactions).toEqual([]);
		expect(ran()).toEqual([]);

		const manager = harness.ctx.sessionManager;
		manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "two", timestamp: 2 });
		guest.socket.send({ t: "prompt", text: "/compact keep the failing tests" });
		await harness.until(() => ran().length === 1);
		expect(harness.compactions).toEqual(["keep the failing tests"]);
		expect(ran()).toEqual(["guest ran /compact"]);
	});

	it("renames the session as the guest asked and announces it once", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/rename   Release notes " });
		await harness.until(() => ran().length === 1);
		expect(harness.ctx.sessionManager.getSessionName()).toBe("Release notes");
		expect(ran()).toEqual(["guest ran /rename"]);
	});

	it("refuses every control from a read-only link", async () => {
		const guest = await startAndJoin(true);
		for (const text of ["/model acme/big", "/effort high", "/compact", "/rename x"]) {
			guest.socket.send({ t: "prompt", text });
		}
		await errorAt(guest, 3);
		expect(harness.modelSwitches).toEqual([]);
		expect(harness.thinkingLevels).toEqual([]);
		expect(harness.compactions).toEqual([]);
		expect(ran()).toEqual([]);
	});
});

describe("collab undo and redo", () => {
	it("advertises the undo feature and lists /undo and /redo without arguments", async () => {
		const guest = await startAndJoin();
		const welcome = await guest.next("welcome");
		expect(welcome.features).toContain("undo");
		expect(welcome.commands?.map(command => command.name)).toEqual(expect.arrayContaining(["undo", "redo"]));

		guest.socket.send({ t: "prompt", text: "/undo everything" });
		expect(await errorAt(guest, 0)).toBe("/undo takes no arguments");
		expect(harness.turns).toEqual([]);
	});

	it("runs /undo and /redo for the guest, answers with the prompt to edit, and announces each once", async () => {
		const guest = await startAndJoin();
		guest.socket.send({ t: "prompt", text: "/undo" });
		await harness.until(() => ran().length === 1);
		expect(await guest.next("turn-undone")).toEqual({
			t: "turn-undone",
			kind: "undo",
			text: "second",
			files: { revert: 1, remove: 0, recreate: 0 },
			skipped: 0,
		});
		expect(ran()).toEqual(["guest ran /undo"]);

		guest.socket.send({ t: "session-cmd", cmd: "redo" });
		await harness.until(() => harness.notices.includes("guest redid the turn"));
		expect(harness.turns).toEqual(["undo", "redo"]);
		while (guest.frames.filter(frame => frame.t === "turn-undone").length < 2) await guest.nextFrame();
		expect(guest.frames.filter(frame => frame.t === "turn-undone").at(-1)).toEqual({
			t: "turn-undone",
			kind: "redo",
			staleText: "second",
		});
	});

	it("reports a refusal as an error and moves nothing", async () => {
		const guest = await startAndJoin();
		harness.state.undoRefusal = "nothing to undo";
		guest.socket.send({ t: "session-cmd", cmd: "undo" });
		expect(await errorAt(guest, 0)).toBe("undo: nothing to undo");
		guest.socket.send({ t: "prompt", text: "/redo" });
		expect(await errorAt(guest, 1)).toBe("/redo: nothing to undo");
		expect(guest.frames.some(frame => frame.t === "turn-undone")).toBe(false);
		expect(ran()).toEqual([]);
	});

	it("refuses both from a read-only link", async () => {
		const guest = await startAndJoin(true);
		guest.socket.send({ t: "session-cmd", cmd: "undo" });
		guest.socket.send({ t: "session-cmd", cmd: "redo" });
		await errorAt(guest, 1);
		expect(harness.turns).toEqual([]);
	});
});

/** A session on disk in its own folder, as the host's `/resume` and `/fork` need. */
async function onDiskSession(): Promise<{ manager: SessionManager; dir: string }> {
	const dir = path.join(workDir, `sessions-${++sessionCounter}`);
	await fs.mkdir(dir, { recursive: true });
	const manager = SessionManager.create(workDir, dir);
	await manager.ensureOnDisk();
	return { manager, dir };
}

describe("collab session-replacing slash commands", () => {
	it("lists /new, /resume and /fork only where the host reopens a room for guests to follow", async () => {
		const offGuest = await startAndJoin();
		const offNames = (await offGuest.next("welcome")).commands?.map(command => command.name) ?? [];
		for (const name of ["new", "resume", "fork"]) expect(offNames).not.toContain(name);
		await host.stop("next");

		const { manager, dir } = await onDiskSession();
		const earlier = SessionManager.create(workDir, dir);
		await earlier.setSessionName("Earlier work", "user");
		await earlier.ensureOnDisk();
		const guest = await startAndJoin(false, { manager, autoStart: "control" });
		const commands = (await guest.next("welcome")).commands ?? [];
		for (const name of ["new", "resume", "fork"]) {
			expect(commands.find(command => command.name === name)?.switchesSession).toBe(true);
		}
		const resume = commands.find(command => command.name === "resume");
		expect(resume?.choices?.map(choice => choice.value)).toEqual([earlier.getSessionId()]);
		expect(resume?.choices?.[0]?.label).toBe("Earlier work");
		// An alias of /model listed too would double the entry.
		expect(commands.filter(command => command.name === "model")).toHaveLength(1);
		expect(commands.map(command => command.name)).not.toContain("switch");
	});

	it("starts a new session for /new and tells the host's terminal who asked", async () => {
		const { manager } = await onDiskSession();
		const guest = await startAndJoin(false, { manager, autoStart: "control" });
		const before = manager.getSessionId();
		guest.socket.send({ t: "prompt", text: "/new" });
		await harness.until(() => ran().length === 1);
		expect(manager.getSessionId()).not.toBe(before);
		expect(ran()).toEqual(["guest ran /new"]);
		expect(harness.switches).toEqual(["new"]);
	});

	it("forks a saved session and refuses to fork one that was never saved", async () => {
		const { manager } = await onDiskSession();
		const guest = await startAndJoin(false, { manager, autoStart: "control" });
		const before = manager.getSessionId();
		guest.socket.send({ t: "prompt", text: "/fork" });
		await harness.until(() => ran().length === 1);
		expect(manager.getSessionId()).not.toBe(before);
		expect(ran()).toEqual(["guest ran /fork"]);
		await host.stop("next");

		const unsaved = await startAndJoin(false, { autoStart: "control" });
		unsaved.socket.send({ t: "prompt", text: "/fork" });
		expect(await errorAt(unsaved, 0)).toStartWith("/fork: ");
		expect(harness.switches).toEqual([]);
		expect(ran()).toEqual([]);
	});

	it("resumes a session of the host's folder by id, and refuses an unknown one or the live one", async () => {
		const { manager, dir } = await onDiskSession();
		const other = SessionManager.create(workDir, dir);
		await other.ensureOnDisk();
		const guest = await startAndJoin(false, { manager, autoStart: "control" });
		const live = manager.getSessionId();

		guest.socket.send({ t: "prompt", text: "/resume no-such-session" });
		expect(await errorAt(guest, 0)).toStartWith("/resume: ");
		guest.socket.send({ t: "prompt", text: `/resume ${live}` });
		expect(await errorAt(guest, 1)).toStartWith("/resume: ");
		expect(harness.switches).toEqual([]);

		guest.socket.send({ t: "prompt", text: `/resume ${other.getSessionId()}` });
		await harness.until(() => ran().length === 1);
		expect(manager.getSessionId()).toBe(other.getSessionId());
		expect(ran()).toEqual(["guest ran /resume"]);
	});

	it("does not replace the session when the host would not follow, is busy, or is in a mode", async () => {
		const { manager } = await onDiskSession();
		const before = manager.getSessionId();
		const closed = await startAndJoin(false, { manager, autoStart: "off" });
		closed.socket.send({ t: "prompt", text: "/new" });
		expect(await errorAt(closed, 0)).toStartWith("/new: ");
		await host.stop("next");

		const guest = await startAndJoin(false, { manager, autoStart: "control" });
		harness.state.busy = true;
		guest.socket.send({ t: "prompt", text: "/new" });
		expect(await errorAt(guest, 0)).toStartWith("/new: ");
		harness.state.busy = false;
		harness.state.planModeEnabled = true;
		guest.socket.send({ t: "prompt", text: "/new" });
		expect(await errorAt(guest, 1)).toStartWith("/new: ");
		expect(harness.switches).toEqual([]);
		expect(manager.getSessionId()).toBe(before);
		expect(ran()).toEqual([]);
	});

	it("takes no arguments for /new and /fork, and refuses all three from a read-only link", async () => {
		const { manager } = await onDiskSession();
		const writer = await startAndJoin(false, { manager, autoStart: "control" });
		writer.socket.send({ t: "prompt", text: "/new please" });
		expect(await errorAt(writer, 0)).toBe("/new takes no arguments");
		await host.stop("next");

		const viewer = await startAndJoin(true, { manager, autoStart: "control" });
		const before = manager.getSessionId();
		for (const text of ["/new", "/fork", `/resume ${before}`]) viewer.socket.send({ t: "prompt", text });
		await errorAt(viewer, 2);
		expect(harness.switches).toEqual([]);
		expect(manager.getSessionId()).toBe(before);
		expect(ran()).toEqual([]);
	});
});
