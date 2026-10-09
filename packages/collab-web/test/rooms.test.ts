import { describe, expect, it } from "bun:test";
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
