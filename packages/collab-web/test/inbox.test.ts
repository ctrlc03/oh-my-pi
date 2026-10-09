import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { applyOpenIntent, claimPendingAnswer, sameQuestion, setOpenIntent } from "../src/lib/inbox";
import { encodeBase64Url } from "../src/lib/link";
import { loadPromptQueue, roomIdOf } from "../src/lib/rooms";

const link = (room: string) => `${room}.${encodeBase64Url(new Uint8Array(48).fill(9))}`;
const LINK_A = link("mgAYTZwEnpRQtca0CTgn-Q");
const LINK_B = link("pAirPAirpAirPAirpAir12");
const ROOM_A = roomIdOf(LINK_A) ?? "";

const select = (title: string, ...options: (string | { label: string })[]): CollabUiRequest => ({
	kind: "select",
	reqId: 1,
	title,
	options,
});

describe("pending answer", () => {
	function pend(question: string, option: string): void {
		setOpenIntent("i", { answer: { question, option } });
		applyOpenIntent("i", LINK_A);
	}

	it("answers the ask it was meant for, using the ask's own spelling of the option", () => {
		pend("Which database?", "Postgres");
		const ask = select("Which database? (1/2)", { label: "SQLite" }, { label: "Postgres (Recommended)" }, "Other");
		expect(claimPendingAnswer(ROOM_A, ask)).toBe("Postgres (Recommended)");
	});

	it("is spent by the first ask: a later matching ask is not answered", () => {
		pend("Which database?", "Postgres");
		expect(claimPendingAnswer(ROOM_A, select("Something else entirely?", "Postgres"))).toBeNull();
		expect(claimPendingAnswer(ROOM_A, select("Which database?", "Postgres"))).toBeNull();
	});

	it("is dropped when the question differs, the option is gone, or the ask is not a select", () => {
		pend("Which database?", "Postgres");
		expect(claimPendingAnswer(ROOM_A, select("Deploy now?", "Postgres"))).toBeNull();
		pend("Which database?", "Postgres");
		expect(claimPendingAnswer(ROOM_A, select("Which database?", "SQLite"))).toBeNull();
		pend("Which database?", "Postgres");
		expect(claimPendingAnswer(ROOM_A, { kind: "editor", reqId: 2, title: "Which database?" })).toBeNull();
	});

	it("goes stale", () => {
		setOpenIntent("i", { answer: { question: "Which database?", option: "Postgres" } });
		applyOpenIntent("i", LINK_A, Date.now());
		expect(claimPendingAnswer(ROOM_A, select("Which database?", "Postgres"), Date.now() + 3 * 60_000)).toBeNull();
	});

	it("only applies to the room the session was opened in", () => {
		pend("Which database?", "Postgres");
		expect(claimPendingAnswer(roomIdOf(LINK_B) ?? "", select("Which database?", "Postgres"))).toBeNull();
		expect(claimPendingAnswer(ROOM_A, select("Which database?", "Postgres"))).toBe("Postgres");
	});
});

describe("sameQuestion", () => {
	it("matches the inbox's truncated, suffixed text against the ask title", () => {
		const long =
			"Cardmarket lists the Chinese 1st Anniversary Set cards as plain names so the app cannot tell them apart";
		expect(sameQuestion(`${long}. How should it learn that?`, `${long.slice(0, 120)}… (+2 more)`)).toBe(true);
		expect(sameQuestion("Another question", long)).toBe(false);
		expect(sameQuestion("anything", "")).toBe(false);
	});
});

describe("open intent prompt", () => {
	const store = new Map<string, string>();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

	beforeEach(() => {
		store.clear();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
				removeItem: (key: string) => void store.delete(key),
			},
		});
	});

	afterEach(() => {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else Reflect.deleteProperty(globalThis, "localStorage");
	});

	it("queues the prompt behind what the room already has queued, once", () => {
		const queued = loadPromptQueue(ROOM_A);
		expect(queued).toEqual([]);
		setOpenIntent("i", { prompt: "first" });
		applyOpenIntent("i", LINK_A);
		setOpenIntent("i", { prompt: "second" });
		applyOpenIntent("i", LINK_A);
		applyOpenIntent("i", LINK_A);
		expect(loadPromptQueue(ROOM_A).map(p => p.text)).toEqual(["first", "second"]);
		expect(loadPromptQueue(roomIdOf(LINK_B) ?? "")).toEqual([]);
	});

	it("ignores an intent whose open never happened until much later", () => {
		setOpenIntent("i", { prompt: "stale" }, Date.now() - 11 * 60_000);
		applyOpenIntent("i", LINK_A);
		expect(loadPromptQueue(ROOM_A)).toEqual([]);
	});
});
