import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionsSidebar } from "../src/components/shell/SessionsSidebar";
import { type CompanionHost, type CompanionSnapshot, INITIAL_SNAPSHOT } from "../src/lib/companion";
import type { ComputerHandle } from "../src/lib/computers";
import type { RecentRoom } from "../src/lib/rooms";
import { applyOrg, emptyOrg, matchRooms, type OrgDoc, roomOrgKey, sessionOrgKey } from "../src/lib/session-org";
import type { SessionOrgControl, SessionOrgs } from "../src/lib/use-session-org";

const NOW = 1_800_000_000_000;

function host(over: Partial<CompanionHost> = {}): CompanionHost {
	return {
		instanceId: "inst-1",
		sessionId: "s-1",
		sessionName: "docs-pass",
		cwd: "/work/docs-pass",
		model: null,
		startedAt: NOW,
		participants: 1,
		busy: false,
		inputRequired: false,
		relayConnected: true,
		...over,
	};
}

function room(over: Partial<RecentRoom> = {}): RecentRoom {
	return {
		roomId: "room-1",
		link: "ws://127.0.0.1:1/r/room-1.key",
		title: "relay audit",
		cwd: "/work/relay",
		readOnly: false,
		lastSeen: NOW,
		...over,
	};
}

function computer(id: string, hosts: CompanionHost[]): ComputerHandle {
	const snap: CompanionSnapshot = { ...INITIAL_SNAPSHOT, phase: "live", machine: "mac", hosts };
	return { id, name: id, client: null, snap, error: null };
}

function control(doc: OrgDoc): SessionOrgControl {
	return {
		doc,
		now: NOW,
		synced: false,
		act: () => {},
		edit: () => ({}),
		restore: () => {},
		extras: true,
		canEndOnSettle: false,
		setSettings: () => {},
	};
}

/** The sidebar as markup, one document for every owner. */
function sidebar(opts: {
	computers: ComputerHandle[];
	rooms: RecentRoom[];
	doc: OrgDoc;
	currentSessionId?: string | null;
	currentRoomId?: string | null;
}): string {
	const orgs: SessionOrgs = { of: () => control(opts.doc) };
	return renderToStaticMarkup(
		<SessionsSidebar
			computers={opts.computers}
			rooms={opts.rooms}
			orgs={orgs}
			currentSessionId={opts.currentSessionId ?? null}
			currentRoomId={opts.currentRoomId ?? null}
			onOpenHost={() => Promise.resolve()}
			onOpenLink={() => {}}
			onOpenUsage={null}
			onOpenSessions={null}
			onClose={() => {}}
		/>,
	);
}

/** Names of the rows of one section, in order; a `*` marks the one flagged as on screen. */
function rowsOf(markup: string, section: "pinned" | "active"): string[] {
	const block = new RegExp(`<section[^>]*data-org-section="${section}"[^>]*>(.*?)</section>`, "s").exec(markup);
	if (block === null) return [];
	return [...block[1].matchAll(/<li\b.*?<\/li>/gs)].map(row => {
		const name = /class="sh-recent-name">([^<]*)</.exec(row[0])?.[1] ?? "?";
		return row[0].includes("aria-current") ? `${name}*` : name;
	});
}

describe("sessions sidebar: the session on screen stays where the user put it", () => {
	const pinned = (key: string): OrgDoc => applyOrg(emptyOrg(), key, { type: "pin" }, NOW);

	it("a pinned room stays in Pinned while it is open, and is shown as the current one", () => {
		const rooms = [room({ computerId: "mac", instanceId: "gone" })];
		const doc = pinned(roomOrgKey("room-1"));
		const open = sidebar({ computers: [computer("mac", [host()])], rooms, doc, currentRoomId: "room-1" });
		const elsewhere = sidebar({ computers: [computer("mac", [host()])], rooms, doc, currentSessionId: "s-1" });
		expect(rowsOf(open, "pinned")).toEqual(["relay audit*"]);
		expect(rowsOf(elsewhere, "pinned")).toEqual(["relay audit"]);
	});

	it("a pinned room that no computer lists stays in Pinned while it is open too", () => {
		const rooms = [room()];
		const doc = pinned(roomOrgKey("room-1"));
		expect(rowsOf(sidebar({ computers: [], rooms, doc, currentRoomId: "room-1" }), "pinned")).toEqual([
			"relay audit*",
		]);
		expect(rowsOf(sidebar({ computers: [], rooms, doc, currentRoomId: null }), "pinned")).toEqual(["relay audit"]);
	});

	it("a pinned room keeps its place among the pinned whichever session is open", () => {
		let doc = applyOrg(emptyOrg(), "s-1", { type: "pin" }, NOW);
		doc = applyOrg(doc, roomOrgKey("room-1"), { type: "pin" }, NOW + 1);
		const computers = [computer("mac", [host()])];
		const rooms = [room({ computerId: "mac" })];
		const order = (over: { currentSessionId?: string; currentRoomId?: string }): string[] =>
			rowsOf(sidebar({ computers, rooms, doc, ...over }), "pinned").map(name => name.replace("*", ""));
		expect(order({ currentRoomId: "room-1" })).toEqual(["docs-pass", "relay audit"]);
		expect(order({ currentSessionId: "s-1" })).toEqual(["docs-pass", "relay audit"]);
		expect(order({})).toEqual(["docs-pass", "relay audit"]);
	});

	it("a room of a listed session is that session's row, never a second one, open or not", () => {
		const computers = [computer("mac", [host()])];
		const rooms = [room({ computerId: "mac", instanceId: "inst-1" })];
		const cases: [{ currentSessionId?: string; currentRoomId?: string }, string[]][] = [
			[{}, ["docs-pass"]],
			[{ currentRoomId: "room-1" }, ["docs-pass*"]],
			[{ currentSessionId: "s-1" }, ["docs-pass*"]],
		];
		for (const [over, expected] of cases) {
			expect(rowsOf(sidebar({ computers, rooms, doc: emptyOrg(), ...over }), "active")).toEqual(expected);
		}
	});

	it("a room pinned before its session was listed keeps its pin on the session's row", () => {
		const computers = [computer("mac", [host()])];
		const rooms = [room({ computerId: "mac", instanceId: "inst-1" })];
		const doc = pinned(roomOrgKey("room-1"));
		expect(rowsOf(sidebar({ computers, rooms, doc, currentRoomId: "room-1" }), "pinned")).toEqual(["docs-pass*"]);
		expect(rowsOf(sidebar({ computers, rooms, doc, currentRoomId: "room-1" }), "active")).toEqual([]);
		expect(rowsOf(sidebar({ computers, rooms, doc }), "pinned")).toEqual(["docs-pass"]);
	});

	it("the pin of an older room of the session carries over when a newer room of it was remembered since", () => {
		const computers = [computer("mac", [host()])];
		const rooms = [
			room({ roomId: "room-2", computerId: "mac", instanceId: "inst-1", lastSeen: NOW + 1 }),
			room({ roomId: "room-1", computerId: "mac", instanceId: "inst-1" }),
		];
		const doc = pinned(roomOrgKey("room-1"));
		expect(rowsOf(sidebar({ computers, rooms, doc, currentRoomId: "room-2" }), "pinned")).toEqual(["docs-pass*"]);
		expect(rowsOf(sidebar({ computers, rooms, doc, currentRoomId: "room-2" }), "active")).toEqual([]);
	});
});

describe("matching rooms to listed sessions", () => {
	const listed = [{ instanceId: "inst-1", sessionId: "s-1" }];

	it("a room of a listed process is a twin; any other room stands alone, the one on screen included", () => {
		const twin = room({ roomId: "a", instanceId: "inst-1" });
		const other = room({ roomId: "b", instanceId: "inst-2" });
		const none = room({ roomId: "c" });
		const { alone, twins } = matchRooms([twin, other, none], listed);
		expect(alone).toEqual([other, none]);
		expect(twins.get("s-1")).toEqual([twin]);
	});

	it("a process with several rooms (the older ones stale) is listed once: none of them is a row of its own", () => {
		const newest = room({ roomId: "new", instanceId: "inst-1" });
		const stale = room({ roomId: "old", instanceId: "inst-1" });
		const { alone, twins } = matchRooms([newest, stale], listed);
		expect(alone).toEqual([]);
		expect(twins.get("s-1")).toEqual([newest, stale]);
	});

	it("a session organised under its own id keeps it; a room's entry is adopted only when it has none", () => {
		const twin = room({ roomId: "a", instanceId: "inst-1" });
		const stale = room({ roomId: "b", instanceId: "inst-1" });
		const roomKey = roomOrgKey("b");
		const byRoom = applyOrg(emptyOrg(), roomKey, { type: "pin" }, NOW);
		expect(sessionOrgKey(emptyOrg(), "s-1", [twin])).toBe("s-1");
		expect(sessionOrgKey(byRoom, "s-1")).toBe("s-1");
		expect(sessionOrgKey(byRoom, "s-1", [twin])).toBe("s-1");
		expect(sessionOrgKey(byRoom, "s-1", [twin, stale])).toBe(roomKey);
		expect(
			sessionOrgKey(applyOrg(byRoom, "s-1", { type: "snooze", until: NOW + 1000 }, NOW), "s-1", [twin, stale]),
		).toBe("s-1");
		const byRule = applyOrg(emptyOrg(), roomKey, { type: "settle", reason: "idle" }, NOW);
		expect(sessionOrgKey(byRule, "s-1", [twin, stale])).toBe("s-1");
	});
});
