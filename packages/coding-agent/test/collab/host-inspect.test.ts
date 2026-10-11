/**
 * Contract: a writer can ask the host for the session's per-request trajectory (`session-cmd`
 * `inspect`) and for the request the next turn would send (`preview-request`); each is answered
 * with a targeted frame and advertised as the `inspect` feature. The host asks the session for
 * redacted output, read-only peers are refused, and a preview that fails reaches the guest as an
 * `error`. Runs over the in-memory relay with the real CollabHost; the agent session is a double.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { InspectRow, RequestPreview } from "@oh-my-pi/pi-wire";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_INSPECT_ROWS, COLLAB_PREVIEW_MAX_CHARS } from "@oh-my-pi/pi-coding-agent/collab/inspect";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const ROW: InspectRow = {
	seq: 1,
	entryId: "e1",
	at: 1_700_000_000_000,
	model: "anthropic/claude-test",
	ttftMs: 400,
	durationMs: 2_000,
	input: 10,
	output: 5,
	cacheRead: 90,
	cacheWrite: 0,
	cost: 0.01,
	stopReason: "stop",
	injected: [{ kind: "prompt", label: "Prompt", tokens: 3, text: "hello" }],
};

const PREVIEW: RequestPreview = {
	source: "request",
	model: "anthropic/claude-test",
	tokens: 12,
	messages: 1,
	tools: 0,
	text: "{}",
	truncated: false,
};

interface Calls {
	inspect: { redact?: boolean; limit?: number }[];
	preview: { redact?: boolean; maxChars?: number }[];
	previewError?: string;
}

function makeHost(calls: Calls): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			getEntries: () => [],
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
			getSessionName: () => "inspect",
		},
		session: {
			isStreaming: false,
			isCompacting: false,
			isBusyForSnapshot: false,
			isSessionTransitioning: false,
			queuedMessageCount: 0,
			sessionName: "inspect",
			model: undefined,
			thinkingLevel: undefined,
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			getInspectRows: (options: { redact?: boolean; limit?: number }) => {
				calls.inspect.push(options);
				return { rows: [ROW], total: 250 };
			},
			previewNextRequest: (options: { redact?: boolean; maxChars?: number }) => {
				calls.preview.push(options);
				return calls.previewError ? Promise.reject(new Error(calls.previewError)) : Promise.resolve(PREVIEW);
			},
			getSpendCap: () => ({ level: "off" }),
			subscribe: () => () => {},
			emitNotice: () => {},
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface TestGuest {
	socket: CollabSocket;
	frames: CollabFrame[];
	next<T extends CollabFrame["t"]>(type: T, from?: number): Promise<Extract<CollabFrame, { t: T }>>;
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
	const next: TestGuest["next"] = async (type, from = 0) => {
		for (;;) {
			const found = frames.slice(from).find(frame => frame.t === type);
			if (found) return found as never;
			const woken = Promise.withResolvers<void>();
			waiters.push(woken.resolve);
			await woken.promise;
		}
	};
	return { socket, frames, next };
}

const guestCleanups: (() => void)[] = [];
let calls: Calls;
let host: CollabHost;

beforeAll(installInMemoryRelay);
afterAll(uninstallInMemoryRelay);

afterEach(async () => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
	await host.stop("test done");
});

async function startHost(): Promise<void> {
	calls = { inspect: [], preview: [] };
	host = new CollabHost(makeHost(calls));
	await host.start("ws://localhost:8789");
}

async function join(link: () => string = () => host.link): Promise<TestGuest> {
	const guest = await joinAsGuest(link());
	guestCleanups.push(() => guest.socket.close());
	await guest.next("welcome");
	return guest;
}

describe("collab inspect", () => {
	it("advertises the feature and answers inspect with the session's redacted, capped rows", async () => {
		await startHost();
		const guest = await join();
		expect((await guest.next("welcome")).features).toContain("inspect");

		guest.socket.send({ t: "session-cmd", cmd: "inspect" });
		const frame = await guest.next("inspect");

		expect(frame.rows).toEqual([ROW]);
		expect(frame.total).toBe(250);
		expect(calls.inspect).toEqual([{ redact: true, limit: COLLAB_INSPECT_ROWS }]);
	});

	it("answers preview-request with the built preview, redacted and size-capped", async () => {
		await startHost();
		const guest = await join();

		guest.socket.send({ t: "session-cmd", cmd: "preview-request" });
		const frame = await guest.next("request-preview");

		expect(frame.preview).toEqual(PREVIEW);
		expect(calls.preview).toEqual([{ redact: true, maxChars: COLLAB_PREVIEW_MAX_CHARS }]);
	});

	it("turns a preview failure into the guest's error", async () => {
		await startHost();
		calls.previewError = "No model is selected for this session.";
		const guest = await join();

		guest.socket.send({ t: "session-cmd", cmd: "preview-request" });

		expect((await guest.next("error")).message).toContain("No model is selected");
	});

	it("refuses read-only peers without building anything", async () => {
		await startHost();
		const viewer = await join(() => host.viewLink);

		viewer.socket.send({ t: "session-cmd", cmd: "inspect" });
		expect((await viewer.next("error")).message).toContain("read-only");
		const seen = viewer.frames.length;
		viewer.socket.send({ t: "session-cmd", cmd: "preview-request" });
		expect((await viewer.next("error", seen)).message).toContain("read-only");
		expect(calls.inspect).toEqual([]);
		expect(calls.preview).toEqual([]);
	});
});
