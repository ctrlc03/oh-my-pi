/**
 * Contract: a browser guest that joined a long session from its newest turns
 * knows how much earlier history is missing, pages it in ahead of the entries
 * it holds when asked, and never saves a replica that lacks the session's start.
 * A host that cut the snapshot for a guest is the only reason entries are
 * missing, so a welcome without `truncated` leaves nothing to load.
 */
import { describe, expect, it, vi } from "bun:test";
import type {
	AgentSnapshot,
	CollabFeature,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
} from "@oh-my-pi/pi-wire";
import { GuestClient } from "../src/lib/client";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";
import type { ReplicaStore } from "../src/lib/replica-cache";
import { sessionMarkdown } from "../src/lib/export";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};
const AGENTS: AgentSnapshot[] = [];

function prompt(index: number): SessionEntry {
	return {
		type: "message",
		id: `e${index}`,
		parentId: index === 0 ? null : `e${index - 1}`,
		timestamp: "2026-06-12T00:00:01Z",
		message: { role: "user", content: `prompt ${index}`, timestamp: index },
	};
}

const ids = (client: GuestClient): string[] => client.getSnapshot().entries.map(entry => entry.id);

function welcome(entryCount: number, extra: Partial<Extract<HostFrame, { t: "welcome" }>> = {}): HostFrame {
	const features: CollabFeature[] = ["history-paging"];
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: AGENTS,
		entryCount,
		features,
		...extra,
	};
}

function history(reqId: number, entries: SessionEntry[], remaining: number, error?: string): HostFrame {
	return { t: "history", reqId, entries, remaining, error };
}

/** A guest holding e4 and e5 of a six-entry session whose first four entries the host kept back. */
function truncatedClient(store: ReplicaStore | null = null): GuestClient {
	const client = new GuestClient(LINK, "tester", store);
	client.applyFrameForTest(welcome(2, { truncated: { omitted: 4, firstOmittedId: "e0" } }));
	client.applyFrameForTest({ t: "snapshot-chunk", entries: [prompt(4), prompt(5)], final: true });
	return client;
}

describe("GuestClient history paging", () => {
	it("reports how many earlier entries a truncated welcome left out", () => {
		const client = truncatedClient();
		const snap = client.getSnapshot();
		expect(snap.phase).toBe("live");
		expect(snap.earlier).toBe(4);
		expect(ids(client)).toEqual(["e4", "e5"]);
	});

	it("has nothing to load after a whole-session welcome", async () => {
		const client = new GuestClient(LINK, "tester", null);
		client.applyFrameForTest(welcome(2));
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [prompt(0), prompt(1)], final: true });
		expect(client.getSnapshot().earlier).toBeNull();
		expect(await client.loadEarlier()).toBe(0);
	});

	it("prepends pages in session order and ends at the host's terminator", async () => {
		const client = truncatedClient();
		const load = client.loadEarlier();
		// The first request names the entry the replica starts with.
		client.applyFrameForTest(history(1, [prompt(2), prompt(3)], 2));
		await Promise.resolve();
		// The next page ends where the previous one began.
		client.applyFrameForTest(history(2, [prompt(0), prompt(1)], 0));
		expect(await load).toBe(4);
		expect(ids(client)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]);
		expect(client.getSnapshot().earlier).toBeNull();
		expect(client.getSnapshot().loadingEarlier).toBe(false);
	});

	it("keeps what a failed page left unloaded and counts it down", async () => {
		vi.useFakeTimers();
		try {
			const client = truncatedClient();
			const load = client.loadEarlier();
			client.applyFrameForTest(history(1, [prompt(2), prompt(3)], 2));
			await Promise.resolve();
			// The host never answers the second page.
			vi.advanceTimersByTime(20_000);
			expect(await load).toBe(2);
			expect(ids(client)).toEqual(["e2", "e3", "e4", "e5"]);
			expect(client.getSnapshot().earlier).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never saves a replica that lacks the session's start", async () => {
		vi.useFakeTimers();
		try {
			const saved: unknown[] = [];
			const store: ReplicaStore = {
				load: () => Promise.resolve(null),
				replace: (_room, _header, entries) => {
					saved.push(entries.length);
					return Promise.resolve();
				},
				append: (_room, _header, _from, entries) => {
					saved.push(entries.length);
					return Promise.resolve();
				},
				move: () => Promise.resolve(),
				forget: () => Promise.resolve(),
			};
			const client = truncatedClient(store);
			client.persist();
			expect(saved).toEqual([]);

			// Once every page is in, the whole transcript is what a reopened app resumes from.
			const load = client.loadEarlier({ all: true });
			client.applyFrameForTest(history(1, [prompt(0), prompt(1), prompt(2), prompt(3)], 0));
			await load;
			client.persist();
			expect(saved).toEqual([6]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("says in an export that earlier entries were left out", () => {
		const entries = [prompt(4), prompt(5)];
		expect(sessionMarkdown(entries, { title: "Long" })).not.toContain("Partial export");
		expect(sessionMarkdown(entries, { title: "Long", omitted: 4 })).toContain("Partial export: the first 4 entries");
	});
});
