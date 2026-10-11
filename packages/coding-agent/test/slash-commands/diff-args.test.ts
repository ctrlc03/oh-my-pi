import { describe, expect, it } from "bun:test";
import { parseDiffArgs } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/turn-diff-report";

describe("/diff arguments", () => {
	it("defaults to the latest turn and accepts turn, turn <n> and session", () => {
		expect(parseDiffArgs("")).toEqual({ scope: "turn", turn: undefined });
		expect(parseDiffArgs("turn")).toEqual({ scope: "turn", turn: undefined });
		expect(parseDiffArgs(" TURN 3 ")).toEqual({ scope: "turn", turn: 3 });
		expect(parseDiffArgs("session")).toEqual({ scope: "session" });
	});

	it("refuses anything else, including turn numbers below 1 or not whole", () => {
		for (const args of ["turn 0", "turn 1.5", "turn x", "turn 1 2", "session now", "files"]) {
			expect(parseDiffArgs(args)).toHaveProperty("error");
		}
	});
});
