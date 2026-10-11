/**
 * Collab usage limits end to end over the in-memory relay: a writer's welcome carries the feature and the
 * account windows, `session-cmd` `usage-limits` re-reads them, a turn that fails on the account limit shows as
 * `state.limited`, and `resume-at-reset` / `resume-cancel` arm and disarm the host's timer.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage, UsageReport } from "@oh-my-pi/pi-ai";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const HOUR = 3_600_000;

let reports: UsageReport[] = [];
let fetches = 0;
let listener: ((event: unknown) => void) | undefined;

function makeReport(usedFraction: number, resetsAt: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { email: "dev@example.test" },
		limits: [
			{
				id: "5h",
				label: "5 Hour",
				scope: { provider: "anthropic" },
				window: { id: "5h", label: "5 Hour", resetsAt },
				amount: { unit: "percent", usedFraction },
			},
		],
	};
}

function makeCtx(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-limits",
			getCwd: () => "/tmp",
			getEntries: () => [],
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-limits", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
			getSessionName: () => "test",
		},
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			sessionName: "test",
			scopedModels: [],
			model: { provider: "anthropic", id: "claude", name: "Claude" },
			modelRegistry: { getError: () => undefined, getAvailable: () => [], getAll: () => [] },
			getAvailableEffortSelectors: () => [],
			getQueuedMessages: () => ({ steering: [], followUp: [] }),
			getContextUsage: () => ({ tokens: 0 }),
			getSpendCap: () => ({ level: "off" }),
			fetchUsageReports: () => {
				fetches++;
				return Promise.resolve(reports);
			},
			subscribe: (fn: (event: unknown) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
			emitNotice: () => {},
		},
		updateEditorBorderColor: () => {},
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
	/** Frames received and not yet consumed by `next`. */
	pending(): CollabFrame[];
	/** The next frame matching `pick` (frames before it are dropped). */
	next<T extends CollabFrame["t"]>(
		type: T,
		pick?: (frame: Extract<CollabFrame, { t: T }>) => boolean,
	): Promise<Extract<CollabFrame, { t: T }>>;
}

async function joinAsGuest(link: string, name: string): Promise<TestGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const seen: CollabFrame[] = [];
	const waiters: (() => void)[] = [];
	socket.onFrame = frame => {
		seen.push(frame);
		for (const waiter of waiters.splice(0)) waiter();
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name, writeToken });
	socket.connect();
	return {
		socket,
		pending: () => seen,
		async next(type, pick = () => true) {
			for (;;) {
				const index = seen.findIndex(frame => frame.t === type && pick(frame as never));
				if (index >= 0) return seen.splice(index, 1)[0] as never;
				await new Promise<void>(resolve => waiters.push(resolve));
			}
		},
	};
}

const cleanups: (() => void)[] = [];
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeCtx());
	await host.start("ws://localhost:8787");
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	reports = [];
	fetches = 0;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

async function join(link: string, name: string) {
	const guest = await joinAsGuest(link, name);
	cleanups.push(() => guest.socket.close());
	return guest;
}

function limitFailure(retryMs: number): AssistantMessage {
	return {
		role: "assistant",
		stopReason: "error",
		provider: "anthropic",
		errorStatus: 429,
		errorMessage: `The usage limit has been reached retry-after-ms=${retryMs}`,
	} as unknown as AssistantMessage;
}

describe("collab usage limits", () => {
	it("advertises the feature and gives a writer the account windows, a viewer none", async () => {
		const resetsAt = Date.now() + 2 * HOUR;
		reports = [makeReport(0.62, resetsAt)];
		const writer = await join(host.link, "writer");
		const welcome = await writer.next("welcome");
		expect(welcome.features).toContain("usage-limits");
		const frame = await writer.next("usage-limits");
		expect(frame.windows).toEqual([
			{
				provider: "anthropic",
				account: "dev@example.test",
				windowId: "5h",
				label: "5 Hour",
				usedFraction: 0.62,
				resetsAt,
				status: "ok",
			},
		]);
		const viewer = await join(host.viewLink, "viewer");
		expect((await viewer.next("welcome")).features).toContain("usage-limits");
		// The refusal arrives after any usage-limits frame the host would have pushed, so none came.
		viewer.socket.send({ t: "session-cmd", cmd: "usage-limits" });
		expect((await viewer.next("error")).message).toContain("read-only");
		expect(viewer.pending().some(frame => frame.t === "usage-limits")).toBe(false);
	});

	it("re-reads the providers for `usage-limits refresh` and answers from its cache otherwise", async () => {
		const writer = await join(host.link, "writer-refresh");
		await writer.next("usage-limits");
		reports = [makeReport(0.1, Date.now() + HOUR)];
		writer.socket.send({ t: "session-cmd", cmd: "usage-limits", arg: "refresh" });
		expect((await writer.next("usage-limits")).windows[0]?.usedFraction).toBe(0.1);
		const before = fetches;
		reports = [makeReport(0.9, Date.now() + HOUR)];
		writer.socket.send({ t: "session-cmd", cmd: "usage-limits" });
		expect((await writer.next("usage-limits")).windows[0]?.usedFraction).toBe(0.1);
		expect(fetches).toBe(before);
		writer.socket.send({ t: "session-cmd", cmd: "usage-limits", arg: "refresh" });
		expect((await writer.next("usage-limits")).windows[0]?.usedFraction).toBe(0.9);
		expect(fetches).toBe(before + 1);
	});

	it("shows a failed turn as limited, arms and cancels the resume, and refuses a viewer", async () => {
		const writer = await join(host.link, "writer-limited");
		await writer.next("welcome");
		const until = Date.now() + 2 * HOUR;
		reports = [makeReport(1, until)];
		listener?.({ type: "message_end", message: limitFailure(2 * HOUR) });
		const limited = await writer.next("state", frame => frame.state.limited !== undefined);
		expect(limited.state.limited?.kind).toBe("blocked");
		expect(limited.state.limited?.provider).toBe("anthropic");
		expect(limited.state.limited?.until).toBeGreaterThan(Date.now() + HOUR);
		expect(limited.state.limited?.resumeAt).toBeUndefined();

		writer.socket.send({ t: "session-cmd", cmd: "resume-at-reset" });
		const armed = await writer.next("state", frame => frame.state.limited?.resumeAt !== undefined);
		expect(armed.state.limited?.resumeAt).toBeGreaterThan(armed.state.limited?.until ?? Number.POSITIVE_INFINITY);

		writer.socket.send({ t: "session-cmd", cmd: "resume-cancel" });
		const cancelled = await writer.next(
			"state",
			frame => frame.state.limited !== undefined && frame.state.limited.resumeAt === undefined,
		);
		expect(cancelled.state.limited?.kind).toBe("blocked");
		writer.socket.send({ t: "session-cmd", cmd: "resume-cancel" });
		expect((await writer.next("error")).message).toContain("no resume is scheduled");

		const viewer = await join(host.viewLink, "viewer-resume");
		await viewer.next("welcome");
		viewer.socket.send({ t: "session-cmd", cmd: "resume-at-reset" });
		expect((await viewer.next("error")).message).toContain("read-only");

		// The session works again: no longer limited.
		listener?.({ type: "message_end", message: { role: "assistant", stopReason: "stop", provider: "anthropic" } });
		await writer.next("state", frame => frame.state.limited === undefined);
	});

	it("refuses to arm a resume while the session is not limited", async () => {
		const writer = await join(host.link, "writer-unlimited");
		await writer.next("welcome");
		writer.socket.send({ t: "session-cmd", cmd: "resume-at-reset" });
		expect((await writer.next("error")).message).toContain("not limited");
	});
});
