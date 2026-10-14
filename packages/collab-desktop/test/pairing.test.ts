import { describe, expect, it } from "bun:test";
import { needsPairing, parseLocalLink, roomIdFromState } from "../src/main/pairing";

const ROOM = "abcDEF123456_-xyz";
const entry = (extra: object) => ({ link: `ws://127.0.0.1:7467/r/${ROOM}#key`, ...extra });

describe("roomIdFromState", () => {
	it("reads the room id", () => {
		expect(roomIdFromState(JSON.stringify({ roomId: ROOM }))).toBe(ROOM);
	});
	it("is null for anything unusable", () => {
		expect(roomIdFromState(null)).toBeNull();
		expect(roomIdFromState("{")).toBeNull();
		expect(roomIdFromState(JSON.stringify({ roomId: "../x" }))).toBeNull();
		expect(roomIdFromState("[]")).toBeNull();
	});
});

describe("needsPairing", () => {
	it("pairs when nothing is stored or the record is unreadable", () => {
		expect(needsPairing(null, ROOM)).toBe(true);
		expect(needsPairing("not json", ROOM)).toBe(true);
		expect(needsPairing("{}", ROOM)).toBe(true);
		expect(needsPairing("[]", ROOM)).toBe(true);
	});

	it("does not pair again once this computer has credentials", () => {
		expect(needsPairing(JSON.stringify([entry({ device: { id: "d", token: "t" } })]), ROOM)).toBe(false);
	});

	it("does not pair again while an invite is on its way to becoming credentials", () => {
		expect(needsPairing(JSON.stringify([entry({ invite: "abc" })]), ROOM)).toBe(false);
	});

	it("pairs when the stored computer is another one, or a rotated room", () => {
		const other = { link: "ws://x/r/zzzzzzzzzzzz#k", device: { id: "d", token: "t" } };
		expect(needsPairing(JSON.stringify([other]), ROOM)).toBe(true);
	});

	it("pairs when the entry has neither credentials nor an invite", () => {
		expect(needsPairing(JSON.stringify([entry({})]), ROOM)).toBe(true);
	});

	it("accepts any paired computer when the room id is unknown", () => {
		expect(needsPairing(JSON.stringify([{ link: "ws://x/r/q", device: { id: "d", token: "t" } }]), null)).toBe(false);
	});
});

describe("parseLocalLink", () => {
	const origin = "http://127.0.0.1:7467";
	it("finds the link in the companion's output", () => {
		const out = `opened nothing\nhttp://127.0.0.1:7467/#pair:wss://r/x#k&invite=abc\n`;
		expect(parseLocalLink(out, origin)).toBe("http://127.0.0.1:7467/#pair:wss://r/x#k&invite=abc");
	});
	it("refuses a link to any other origin", () => {
		expect(parseLocalLink("https://evil.example/#pair:x", origin)).toBeNull();
		expect(parseLocalLink("http://127.0.0.1:7468/#pair:x", origin)).toBeNull();
		expect(parseLocalLink("http://127.0.0.1:7467/ no pairing", origin)).toBeNull();
		expect(parseLocalLink("", origin)).toBeNull();
	});
});
