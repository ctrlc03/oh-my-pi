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
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
	state: { planModeEnabled: boolean; retryResult: boolean; goalModeEnabled: boolean };
	/** Resolves once `ready()` holds; re-checked each time the session double records something. */
	until(ready: () => boolean): Promise<void>;
}

let skillDir: string;

function makeHost(): Harness {
	const manager = SessionManager.inMemory();
	const prompts: PromptCall[] = [];
	const waiters: (() => void)[] = [];
	const notices: string[] = [];
	const state = { planModeEnabled: false, retryResult: true, goalModeEnabled: false };
	const hostInputs: string[] = [];
	const harness = {
		prompts,
		notices,
		planCalls: [] as (string | undefined)[],
		retries: 0,
		hostInputs,
		state,
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
			isStreaming: false,
			isBusyForSnapshot: false,
			isSessionTransitioning: false,
			isCompacting: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "slash",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
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
	await Bun.write(path.join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nSKILL BODY\n");
});
afterAll(async () => {
	uninstallInMemoryRelay();
	await fs.rm(skillDir, { recursive: true, force: true });
});
afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function startAndJoin(readOnly = false): Promise<TestGuest> {
	harness = makeHost();
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
		expect(names).toEqual(["plan", "retry", "review", "fix-tests", "skill:demo"]);
		expect(commands.find(command => command.name === "review")).toEqual({
			name: "review",
			description: "Review files",
			args: "<paths>",
		});
		expect(commands.find(command => command.name === "plan")?.args).toBe("[prompt]");
		// Builtins that exit, sign in or change settings; shadowed entries; extension commands.
		for (const hidden of ["exit", "quit", "login", "settings", "model", "ext-wins", "ext-only"]) {
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
		guest.socket.send({ t: "prompt", text: "/model gpt-5" });
		expect(await errorAt(guest, 1)).toBe("/model can only be run on the host");
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
