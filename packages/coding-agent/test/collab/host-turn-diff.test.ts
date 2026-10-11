/**
 * Contract: a writer can ask the host what one prompt changed (`session-cmd` `turn-diff`, `arg` a prompt
 * entry id), what the whole session changed (`session-diff`) and what the session did (`receipts`); each
 * is answered with a targeted frame. `receipts` is always advertised, `turn-diff` only while the session
 * can snapshot files, and a prompt that is not on the active path or has no snapshot is answered with
 * `files: null` and a reason. Runs over the in-memory relay with the real CollabHost; the agent session is
 * a double.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { TurnDiff } from "@oh-my-pi/pi-coding-agent/session/turn-diff";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const ENTRIES = [
	{ id: "u1", type: "message", message: { role: "user", content: "first", timestamp: 0 } },
	{
		id: "a1",
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test" } }],
		},
	},
	{
		id: "r1",
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [],
			isError: true,
			details: { exitCode: 2 },
		},
	},
	{ id: "u2", type: "message", message: { role: "user", content: "second", timestamp: 0 } },
] as unknown as SessionEntry[];

const DIFF: TurnDiff = {
	files: [{ path: "a.ts", status: "modified", added: 1, removed: 1, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
	omitted: 0,
	spansTurns: 1,
};

interface HostHarness {
	ctx: InteractiveModeContext;
	snapshots: { supported: boolean; recordedFor: string[] };
	calls: string[];
}

function makeHost(supported: boolean): HostHarness {
	const harness = { snapshots: { supported, recordedFor: ["u1"] }, calls: [] as string[] };
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			getEntries: () => [],
			getBranch: () => ENTRIES,
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
			getSessionName: () => "diffs",
		},
		session: {
			get sessionManager() {
				return ctx.sessionManager;
			},
			get canRestoreFiles() {
				return harness.snapshots.supported;
			},
			isStreaming: false,
			isCompacting: false,
			isBusyForSnapshot: false,
			isSessionTransitioning: false,
			queuedMessageCount: 0,
			sessionName: "diffs",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			diffFilesSince: (entryId: string, later: readonly string[]) => {
				harness.calls.push(`since ${entryId} -> ${later.join(",")}`);
				return Promise.resolve(harness.snapshots.recordedFor.includes(entryId) ? DIFF : undefined);
			},
			diffFilesSinceStart: (promptIds: readonly string[]) => {
				harness.calls.push(`start ${promptIds.join(",")}`);
				return Promise.resolve({ ...DIFF, spansTurns: promptIds.length });
			},
			getSpendCap: () => ({ level: "off" }),
			subscribe: () => () => {},
			emitNotice: () => {},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 1, contextWindow: 10_000 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
	return { ctx, snapshots: harness.snapshots, calls: harness.calls };
}

interface TestGuest {
	socket: CollabSocket;
	next<T extends CollabFrame["t"]>(type: T): Promise<Extract<CollabFrame, { t: T }>>;
}

async function joinAsGuest(link: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
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
	const next: TestGuest["next"] = async type => {
		for (;;) {
			const found = frames.find(frame => frame.t === type);
			if (found) {
				frames.splice(frames.indexOf(found), 1);
				return found as never;
			}
			const woken = Promise.withResolvers<void>();
			waiters.push(woken.resolve);
			await woken.promise;
		}
	};
	return { socket, next };
}

const guestCleanups: (() => void)[] = [];
let harness: HostHarness;
let host: CollabHost;

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function join(supported: boolean): Promise<{ guest: TestGuest; features: string[] | undefined }> {
	harness = makeHost(supported);
	host = new CollabHost(harness.ctx);
	await host.start("ws://localhost:8789");
	const guest = await joinAsGuest(host.link);
	guestCleanups.push(() => guest.socket.close());
	const welcome = await guest.next("welcome");
	return { guest, features: welcome.features };
}

describe("collab turn diff and receipts", () => {
	it("answers turn-diff for a prompt with the files, and with a reason when it cannot", async () => {
		const { guest, features } = await join(true);
		expect(features).toContain("turn-diff");
		expect(features).toContain("receipts");

		guest.socket.send({ t: "session-cmd", cmd: "turn-diff", arg: "u1" });
		expect(await guest.next("turn-diff")).toEqual({
			t: "turn-diff",
			scope: "turn",
			entryId: "u1",
			files: DIFF.files,
			spansTurns: 1,
		});
		// The prompts after it bound its end.
		expect(harness.calls).toEqual(["since u1 -> u2"]);

		guest.socket.send({ t: "session-cmd", cmd: "turn-diff", arg: "u2" });
		const unrecorded = await guest.next("turn-diff");
		expect(unrecorded.files).toBeNull();
		expect(unrecorded.reason).toContain("no file snapshot");

		guest.socket.send({ t: "session-cmd", cmd: "turn-diff", arg: "a1" });
		expect((await guest.next("turn-diff")).reason).toContain("not a prompt");
	});

	it("answers session-diff with the whole active path's prompts", async () => {
		const { guest } = await join(true);
		guest.socket.send({ t: "session-cmd", cmd: "session-diff" });
		const frame = await guest.next("turn-diff");
		expect(frame).toMatchObject({ scope: "session", entryId: null, spansTurns: 2 });
		expect(harness.calls).toEqual(["start u1,u2"]);
	});

	it("advertises turn-diff only with snapshots, and still serves receipts", async () => {
		const { guest, features } = await join(false);
		expect(features).not.toContain("turn-diff");
		expect(features).toContain("receipts");

		guest.socket.send({ t: "session-cmd", cmd: "turn-diff", arg: "u1" });
		expect((await guest.next("turn-diff")).files).toBeNull();

		guest.socket.send({ t: "session-cmd", cmd: "receipts" });
		const { receipts } = await guest.next("receipts");
		expect(receipts.turns).toBe(2);
		expect(receipts.commands).toEqual([
			{ command: "bun test", exitCode: 2, source: "agent", turn: 1, promptId: "u1" },
		]);
	});
});
