import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type CompanionHost, INITIAL_SNAPSHOT, type PairingLink } from "../src/lib/companion";
import {
	addComputer,
	type Computer,
	type ComputerHandle,
	computerNames,
	defaultComputer,
	findHost,
	loadComputers,
	planOpen,
	pairComputer,
	rememberPairing,
	removeComputer,
	resolveSessionHome,
	unavailableReason,
	unpairComputer,
} from "../src/lib/computers";
import { loadDismissed, saveDismissed } from "../src/lib/inbox";
import { encodeBase64Url } from "../src/lib/link";
import { loadOrg } from "../src/lib/org-storage";
import { loadRooms, rememberRoom } from "../src/lib/rooms";
import { readJson, writeJson } from "../src/lib/storage";

const key = encodeBase64Url(new Uint8Array(32).fill(7));
const link = (room: string) => `wss://relay.example.com/r/${room}.${key}`;
const LAPTOP = link("laptopLaptopLaptop0001");
const MOON = link("moonstoneMoonstone0002");
const LAPTOP_ID = "laptopLaptopLaptop0001";
const MOON_ID = "moonstoneMoonstone0002";

const host = (instanceId: string, sessionId: string): CompanionHost => ({
	instanceId,
	sessionId,
	sessionName: null,
	cwd: "/work",
	model: null,
	startedAt: 0,
	participants: 1,
	busy: false,
	inputRequired: false,
	relayConnected: true,
});

function handle(
	id: string,
	name: string,
	hosts: CompanionHost[],
	snap: Partial<ComputerHandle["snap"]> = {},
): ComputerHandle {
	return {
		id,
		name,
		client: null,
		error: null,
		snap: { ...INITIAL_SNAPSHOT, phase: "live", canStart: true, hosts, ...snap },
	};
}

describe("computers storage", () => {
	const store = new Map<string, string>();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

	beforeEach(() => {
		store.clear();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, value: string) => void store.set(k, value),
				removeItem: (k: string) => void store.delete(k),
			},
		});
	});

	afterEach(() => {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	describe("migration from the single pairing", () => {
		const legacy = { link: LAPTOP, device: { id: "dev1", token: "tok1" }, machine: "MacBook" };

		it("moves the pairing into the list under its room id and removes the old key", () => {
			writeJson("omp.collab.companion", legacy);
			expect(loadComputers()).toEqual([{ id: LAPTOP_ID, ...legacy }]);
			expect(store.has("omp.collab.companion")).toBe(false);
			expect(readJson("omp.collab.computers")).toEqual([{ id: LAPTOP_ID, ...legacy }]);
			// A second launch reads the list and has nothing left to migrate.
			expect(loadComputers()).toEqual([{ id: LAPTOP_ID, ...legacy }]);
		});

		it("hands the data it kept for the one computer to it: rooms, dismissed inbox items, the org document", () => {
			writeJson("omp.collab.companion", legacy);
			rememberRoom({ roomId: "r1", link: LAPTOP, title: "t", cwd: null, readOnly: false, instanceId: "i1" });
			saveDismissed(["i1:ask:5"]);
			writeJson("omp.collab.session-org", { entries: {}, settings: { at: 5, idleDays: 3, settleOnPr: true } });

			loadComputers();

			expect(loadRooms().map(room => room.computerId)).toEqual([LAPTOP_ID]);
			expect(loadDismissed()).toEqual([`${LAPTOP_ID}|i1:ask:5`]);
			expect(loadOrg(LAPTOP_ID).settings.idleDays).toBe(3);
			expect(store.has("omp.collab.session-org")).toBe(false);
		});

		it("keeps a list that already exists and does not duplicate the computer", () => {
			writeJson("omp.collab.computers", [{ id: MOON_ID, link: MOON }]);
			writeJson("omp.collab.companion", legacy);
			expect(loadComputers().map(computer => computer.id)).toEqual([MOON_ID, LAPTOP_ID]);
			writeJson("omp.collab.companion", legacy);
			expect(loadComputers().map(computer => computer.id)).toEqual([MOON_ID, LAPTOP_ID]);
		});

		it("drops a pairing that is not a link", () => {
			writeJson("omp.collab.companion", { link: "not a link" });
			expect(loadComputers()).toEqual([]);
			expect(store.has("omp.collab.companion")).toBe(false);
		});
	});

	it("pairs, updates and removes computers", () => {
		expect(pairComputer({ link: LAPTOP, invite: "inv1" })?.id).toBe(LAPTOP_ID);
		expect(pairComputer({ link: MOON })?.id).toBe(MOON_ID);
		expect(loadComputers().map(computer => computer.id)).toEqual([LAPTOP_ID, MOON_ID]);

		rememberPairing(LAPTOP_ID, { link: LAPTOP, device: { id: "d", token: "t" }, machine: "MacBook" });
		expect(loadComputers()[0]).toEqual({
			id: LAPTOP_ID,
			link: LAPTOP,
			device: { id: "d", token: "t" },
			machine: "MacBook",
		});
		// Credentials a connection learned are not lost to a stale copy of the list: pairing reads it fresh.
		pairComputer({ link: MOON });
		expect(loadComputers()[0]?.device).toEqual({ id: "d", token: "t" });

		expect(unpairComputer(LAPTOP_ID).map(computer => computer.id)).toEqual([MOON_ID]);
		expect(loadComputers().map(computer => computer.id)).toEqual([MOON_ID]);
		unpairComputer(MOON_ID);
		expect(store.has("omp.collab.computers")).toBe(false);
	});

	it("ignores credentials remembered for a computer that was removed meanwhile", () => {
		pairComputer({ link: LAPTOP });
		unpairComputer(LAPTOP_ID);
		rememberPairing(LAPTOP_ID, { link: LAPTOP, device: { id: "d", token: "t" } });
		expect(loadComputers()).toEqual([]);
	});

	it("drops unparsable and repeated entries from a stored list", () => {
		writeJson("omp.collab.computers", [{ link: LAPTOP }, "garbage", { link: "nope" }, { link: LAPTOP }, LAPTOP]);
		expect(loadComputers()).toEqual([{ id: LAPTOP_ID, link: LAPTOP }]);
	});

	it("remembers that a computer is a fresh VM through pairing again and a connection's own updates", () => {
		const fresh = { hostComputerId: MOON_ID, name: "web-1a2b" };
		expect(pairComputer({ link: LAPTOP, invite: "inv" }, fresh)?.list[0]).toEqual({
			id: LAPTOP_ID,
			link: LAPTOP,
			invite: "inv",
			fresh,
		});
		rememberPairing(LAPTOP_ID, { link: LAPTOP, device: { id: "d", token: "t" }, machine: "vm-web-1a2b" });
		expect(loadComputers()[0]).toEqual({
			id: LAPTOP_ID,
			link: LAPTOP,
			device: { id: "d", token: "t" },
			machine: "vm-web-1a2b",
			fresh,
		});
		pairComputer({ link: LAPTOP });
		expect(loadComputers()[0]?.fresh).toEqual(fresh);
	});

	it("drops a fresh mark that is not a host and a name", () => {
		writeJson("omp.collab.computers", [{ link: LAPTOP, fresh: { hostComputerId: MOON_ID } }]);
		expect(loadComputers()).toEqual([{ id: LAPTOP_ID, link: LAPTOP }]);
	});
});

describe("addComputer", () => {
	const known: Computer = {
		id: LAPTOP_ID,
		link: LAPTOP,
		invite: "old",
		device: { id: "d", token: "t" },
		machine: "MacBook",
	};
	const pairing = (partial: Partial<PairingLink> = {}): PairingLink => ({ link: LAPTOP, ...partial });

	it("appends a computer it has not seen and returns its id", () => {
		const added = addComputer([known], { link: MOON, invite: "inv" });
		expect(added?.id).toBe(MOON_ID);
		expect(added?.list.map(computer => computer.id)).toEqual([LAPTOP_ID, MOON_ID]);
		expect(added?.list[1]).toEqual({ id: MOON_ID, link: MOON, invite: "inv" });
	});

	it("pairing again with a new invite replaces the credentials the old one bought", () => {
		const updated = addComputer([known], pairing({ invite: "fresh" }))?.list[0];
		expect(updated).toEqual({ id: LAPTOP_ID, link: LAPTOP, invite: "fresh", machine: "MacBook" });
	});

	it("the room link alone keeps the credentials and the invite", () => {
		expect(addComputer([known], pairing())?.list[0]).toEqual(known);
	});

	it("refuses a link that does not parse", () => {
		expect(addComputer([known], { link: "nope" })).toBeNull();
	});

	it("removes by id", () => {
		const other: Computer = { id: MOON_ID, link: MOON };
		expect(removeComputer([known, other], LAPTOP_ID)).toEqual([other]);
		expect(removeComputer([known], "unknown")).toEqual([known]);
	});
});

describe("computerNames", () => {
	it("tells computers that share a machine name apart, in pairing order", () => {
		expect(
			computerNames([
				{ id: "a", machine: "MacBook-Pro" },
				{ id: "b", machine: "moonstone" },
				{ id: "c", machine: "MacBook-Pro" },
				{ id: "d", machine: null },
				{ id: "e", machine: "  " },
			]),
		).toEqual({ a: "MacBook-Pro", b: "moonstone", c: "MacBook-Pro (2)", d: "Computer", e: "Computer (2)" });
	});
});

describe("session home with colliding instance ids", () => {
	// Both computers run an omp process under instance "abc12345" (ids are only unique per machine).
	const laptop = handle(LAPTOP_ID, "laptop", [host("abc12345", "session-on-laptop")]);
	const moon = handle(MOON_ID, "moonstone", [host("abc12345", "session-on-moonstone")]);
	const both = [laptop, moon];

	it("finds the computer by the session on screen, whatever the instance id is", () => {
		expect(resolveSessionHome(both, "session-on-moonstone", null, null)).toEqual({
			computer: moon,
			hostId: "abc12345",
			instanceId: "abc12345",
		});
		expect(resolveSessionHome(both, "session-on-laptop", null, null).computer).toBe(laptop);
	});

	it("uses the computer the session was opened from when the session is not listed yet", () => {
		const home = resolveSessionHome(both, null, { computerId: MOON_ID, instanceId: "abc12345" }, null);
		expect(home).toEqual({ computer: moon, hostId: null, instanceId: "abc12345" });
	});

	it("prefers what was opened this launch over what was stored", () => {
		const home = resolveSessionHome(
			both,
			null,
			{ computerId: LAPTOP_ID, instanceId: "abc12345" },
			{ computerId: MOON_ID, instanceId: "abc12345" },
		);
		expect(home.computer).toBe(laptop);
	});

	it("does not guess between two computers that list the same instance id", () => {
		expect(resolveSessionHome(both, null, { instanceId: "abc12345" }, null)).toEqual({
			computer: null,
			hostId: null,
			instanceId: null,
		});
	});

	it("takes the one computer that lists an instance id nobody else does", () => {
		const alone = handle(MOON_ID, "moonstone", [host("only-here", "s")]);
		expect(resolveSessionHome([laptop, alone], null, { instanceId: "only-here" }, null).computer).toBe(alone);
	});

	it("keeps a stored room on its computer while that computer is offline", () => {
		const offline = handle(MOON_ID, "moonstone", [], { phase: "offline" });
		const home = resolveSessionHome([laptop, offline], "elsewhere", null, {
			computerId: MOON_ID,
			instanceId: "abc12345",
		});
		expect(home).toEqual({ computer: offline, hostId: null, instanceId: "abc12345" });
	});

	it("does not attach a room to a computer that has been removed", () => {
		const home = resolveSessionHome([laptop], null, null, { computerId: MOON_ID, instanceId: "abc12345" });
		expect(home).toEqual({ computer: null, hostId: null, instanceId: null });
	});

	it("with a single computer, a session it does not list is still its own", () => {
		expect(resolveSessionHome([laptop], null, null, { instanceId: "gone" })).toEqual({
			computer: laptop,
			hostId: null,
			instanceId: "gone",
		});
	});

	it("looks an instance id up across computers", () => {
		expect(findHost(both, "abc12345")).toEqual({ found: "ambiguous" });
		expect(findHost(both, "missing")).toEqual({ found: "none" });
		const unique = handle(MOON_ID, "moonstone", [host("solo", "s")]);
		expect(findHost([laptop, unique], "solo")).toEqual({ found: "host", computer: unique });
	});
});

describe("opening a session from a notification", () => {
	const laptop = handle(LAPTOP_ID, "laptop", [host("abc12345", "s1")]);
	const moon = handle(MOON_ID, "moonstone", [host("abc12345", "s2"), host("only-moon", "s3")]);

	it("opens on the computer the push came from, even when another lists the same instance id", () => {
		expect(planOpen([laptop, moon], "abc12345", MOON_ID)).toEqual({ kind: "open", computer: moon });
		expect(planOpen([laptop, moon], "abc12345", LAPTOP_ID)).toEqual({ kind: "open", computer: laptop });
	});

	it("refuses a push without a computer when two list its session, but opens an unambiguous one", () => {
		expect(planOpen([laptop, moon], "abc12345", null).kind).toBe("error");
		expect(planOpen([laptop, moon], "only-moon", null)).toEqual({ kind: "open", computer: moon });
	});

	it("waits for the named computer to answer, and only for it", () => {
		const connecting = handle(MOON_ID, "moonstone", [], { phase: "connecting" });
		expect(planOpen([laptop, connecting], "abc12345", MOON_ID)).toEqual({ kind: "wait" });
		// The laptop answered and lists it, but the push said moonstone: do not open the laptop's.
		expect(planOpen([laptop, connecting], "abc12345", MOON_ID).kind).not.toBe("open");
	});

	it("without a computer, waits while any could still list the session", () => {
		const connecting = handle(MOON_ID, "moonstone", [], { phase: "connecting" });
		expect(planOpen([laptop, connecting], "only-moon", null)).toEqual({ kind: "wait" });
		expect(planOpen([laptop, connecting], "abc12345", null)).toEqual({ kind: "open", computer: laptop });
	});

	it("says so when the computer is unreachable, unpaired, or no longer shares the session", () => {
		const offline = handle(MOON_ID, "moonstone", [], { phase: "offline" });
		expect(planOpen([laptop, offline], "only-moon", MOON_ID)).toEqual({
			kind: "error",
			message: "moonstone is not reachable.",
		});
		expect(planOpen([laptop], "only-moon", MOON_ID).kind).toBe("error");
		expect(planOpen([laptop, moon], "closed", MOON_ID)).toEqual({
			kind: "error",
			message: "That session is no longer sharing.",
		});
		expect(planOpen([laptop, moon], "closed", null).kind).toBe("error");
	});
});

describe("the computer a new session starts on", () => {
	const laptop = handle(LAPTOP_ID, "laptop", []);
	const moon = handle(MOON_ID, "moonstone", []);

	it("prefers the computer on screen, then the one used last, then the first that can", () => {
		expect(defaultComputer([laptop, moon], "start", MOON_ID, LAPTOP_ID)).toBe(moon);
		expect(defaultComputer([laptop, moon], "start", null, MOON_ID)).toBe(moon);
		expect(defaultComputer([laptop, moon], "start", null, null)).toBe(laptop);
	});

	it("skips a computer that is offline or lacks the feature", () => {
		const offline = handle(LAPTOP_ID, "laptop", [], { phase: "offline", error: "Not reachable" });
		const old = handle(MOON_ID, "moonstone", [], { canStart: true, canSchedule: false });
		expect(defaultComputer([offline, moon], "start", LAPTOP_ID, LAPTOP_ID)).toBe(moon);
		expect(defaultComputer([old, laptop], "schedule", MOON_ID, null)).toBeNull();
		expect(defaultComputer([], "start", null, null)).toBeNull();
	});

	it("says why a computer cannot be picked", () => {
		expect(unavailableReason(laptop, "start")).toBeNull();
		expect(unavailableReason(handle("x", "x", [], { phase: "connecting" }), "start")).toBe("Connecting…");
		expect(unavailableReason(handle("x", "x", [], { canSchedule: false }), "schedule")).toContain("schedules");
	});
});
