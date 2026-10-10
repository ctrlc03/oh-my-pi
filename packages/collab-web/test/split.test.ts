import { describe, expect, it } from "bun:test";
import { encodeBase64Url } from "../src/lib/link";
import { besideConflict } from "../src/lib/use-split";

const key = encodeBase64Url(new Uint8Array(48).fill(9));
const ROOM_A = `mgAYTZwEnpRQtca0CTgn-Q.${key}`;
const ROOM_B = `0gAYTZwEnpRQtca0CTgn-Q.${key}`;

describe("besideConflict", () => {
	it("refuses the room the main pane shows: two clients on one room would both send its queued prompts", () => {
		expect(besideConflict(ROOM_A, ROOM_A)).not.toBeNull();
		// The same room through a browser deep link of the other form.
		expect(besideConflict(ROOM_A, `https://my.omp.sh/#${ROOM_A}`)).not.toBeNull();
	});

	it("allows another room, and any room while the main pane has none", () => {
		expect(besideConflict(ROOM_A, ROOM_B)).toBeNull();
		expect(besideConflict(null, ROOM_A)).toBeNull();
	});

	it("refuses text that is not a session link", () => {
		expect(besideConflict(ROOM_A, "not a link")).not.toBeNull();
	});
});
