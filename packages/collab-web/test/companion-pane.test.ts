import { describe, expect, it } from "bun:test";
import { capText, findPane, parsePanes, parseParents } from "../scripts/companion-pane";

const panes = parsePanes(
	["100 omp-1a2b3c4d:0.0 120 40", "200 main:0.0 80 24", "201 my work:1.2 200 50", "garbage line"].join("\n"),
);

describe("parsePanes", () => {
	it("reads pid, target and size, including session names with spaces", () => {
		expect(panes).toEqual([
			{ pid: 100, target: "omp-1a2b3c4d:0.0", cols: 120, rows: 40 },
			{ pid: 200, target: "main:0.0", cols: 80, rows: 24 },
			{ pid: 201, target: "my work:1.2", cols: 200, rows: 50 },
		]);
	});
});

describe("findPane", () => {
	// 100 (pane shell) → 110 (sandbox-exec) → 120 (omp);  200 (pane shell) → 210 (zsh) → 220 (omp);  300 is not in tmux.
	const parents = parseParents(
		[
			"  1     0",
			" 100     1",
			" 110   100",
			" 120   110",
			" 200     1",
			" 210   200",
			" 220   210",
			" 300     1",
			" 310   300",
		].join("\n"),
	);

	it("finds the pane through the process ancestry", () => {
		expect(findPane(120, panes, parents)?.target).toBe("omp-1a2b3c4d:0.0");
		expect(findPane(220, panes, parents)?.target).toBe("main:0.0");
		expect(findPane(100, panes, parents)?.target).toBe("omp-1a2b3c4d:0.0");
	});

	it("is null for a process outside every pane, or whose ancestry is unknown", () => {
		expect(findPane(310, panes, parents)).toBeNull();
		expect(findPane(999, panes, parents)).toBeNull();
	});

	it("stops on a parent loop", () => {
		expect(
			findPane(
				5,
				panes,
				new Map([
					[5, 6],
					[6, 5],
				]),
			),
		).toBeNull();
	});
});

describe("capText", () => {
	it("keeps the newest whole lines within the limit", () => {
		expect(capText("aaaa\nbbbb\ncccc", 100)).toBe("aaaa\nbbbb\ncccc");
		expect(capText("aaaa\nbbbb\ncccc", 9)).toBe("cccc");
		expect(capText("aaaa\nbbbb\ncccc", 10)).toBe("bbbb\ncccc");
	});
});
