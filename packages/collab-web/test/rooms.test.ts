import { describe, expect, it } from "bun:test";
import { extractPairing, formatPairingUrl } from "../src/lib/companion";
import { encodeBase64Url } from "../src/lib/link";
import { extractLink } from "../src/lib/rooms";

const BARE = `mgAYTZwEnpRQtca0CTgn-Q.${encodeBase64Url(new Uint8Array(48).fill(9))}`;
const WEB = `https://ctrlc03.github.io/oh-my-pi/#${BARE}`;

describe("extractLink", () => {
	it("accepts a bare link and a browser deep link as-is", () => {
		expect(extractLink(BARE)).toBe(BARE);
		expect(extractLink(`  ${WEB}\n`)).toBe(WEB);
	});

	it("pulls the link out of the terminal's `omp join` line", () => {
		expect(extractLink(`omp join "${BARE}"`)).toBe(BARE);
	});

	it("pulls the link out of surrounding prose and punctuation", () => {
		expect(extractLink(`join here: <${WEB}>.`)).toBe(WEB);
	});

	it("returns null when nothing parses as a collab link", () => {
		expect(extractLink("")).toBeNull();
		expect(extractLink("https://example.com/#not-a-room")).toBeNull();
	});
});

describe("pairing links", () => {
	const ROOM = `pAirPAirpAirPAirpAir12.${encodeBase64Url(new Uint8Array(32).fill(3))}`;
	const PAIR_URL = `https://ctrlc03.github.io/oh-my-pi/#pair:${ROOM}`;
	const INVITE = "q3JvY2tldC1pbnZpdGUtMTI";

	it("yields the companion room from a URL, a scanned code, or pasted prose", () => {
		expect(extractPairing(PAIR_URL)).toEqual({ link: ROOM });
		expect(extractPairing(`pair:${ROOM}`)).toEqual({ link: ROOM });
		expect(extractPairing(`open ${PAIR_URL}.`)).toEqual({ link: ROOM });
	});

	it("carries the one-time invite the companion put in the pairing URL", () => {
		const url = formatPairingUrl("https://ctrlc03.github.io/oh-my-pi/#stale", ROOM, INVITE);
		expect(url).toBe(`https://ctrlc03.github.io/oh-my-pi/#pair:${ROOM}&invite=${INVITE}`);
		expect(extractPairing(url)).toEqual({ link: ROOM, invite: INVITE });
		expect(extractPairing(`scan this: <${url}>.`)).toEqual({ link: ROOM, invite: INVITE });
	});

	// A mangled invite must not pair as a device that then fails to authenticate with no explanation.
	it("refuses a pairing link whose invite is malformed", () => {
		expect(extractPairing(`pair:${ROOM}&invite=short`)).toBeNull();
		expect(extractPairing(`pair:${ROOM}&invite=`)).toBeNull();
	});

	// Joining the companion room as a session would hang on a welcome that never comes.
	it("is never mistaken for a session link, and a session link never pairs", () => {
		expect(extractLink(PAIR_URL)).toBeNull();
		expect(extractLink(`pair:${ROOM}`)).toBeNull();
		expect(extractLink(formatPairingUrl(PAIR_URL, ROOM, INVITE))).toBeNull();
		expect(extractPairing(WEB)).toBeNull();
		expect(extractPairing(BARE)).toBeNull();
	});
});
