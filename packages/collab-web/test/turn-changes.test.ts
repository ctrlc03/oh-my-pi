import { describe, expect, it } from "bun:test";
import type { SessionEntry, TurnDiffFile } from "@oh-my-pi/pi-wire";
import { parseUnifiedDiff } from "../src/lib/review-comments";
import { lastRow, splitLines } from "../src/lib/split-diff";
import { fileSignature, promptTurns, viewedPaths } from "../src/lib/turn-changes";

const HUNKS = ["@@ -1,4 +1,5 @@", " keep", "-old a", "-old b", "+new a", "+new b", "+new c", " tail"].join("\n");

describe("splitLines", () => {
	it("pairs a removed run with the added run after it, the longer tail left open", () => {
		const rows = parseUnifiedDiff(HUNKS);
		const lines = splitLines(rows);
		expect(lines.map(line => (line.kind === "full" ? "full" : `${line.left ?? "-"}|${line.right ?? "-"}`))).toEqual([
			"full",
			"1|1",
			"2|4",
			"3|5",
			"-|6",
			"7|7",
		]);
		// A comment on any row goes under the display line holding it.
		expect(lastRow(lines[2]!)).toBe(4);
	});

	it("keeps every row exactly once across the sides", () => {
		const rows = parseUnifiedDiff(HUNKS);
		const seen = new Map<number, number>();
		for (const line of splitLines(rows)) {
			const ids = line.kind === "full" ? [line.row] : [line.left, line.right];
			for (const id of new Set(ids)) if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
		}
		expect([...seen.keys()].sort()).toEqual(rows.map((_, i) => i));
		expect([...seen.values()].every(count => count === 1)).toBe(true);
	});
});

const file = (path: string, diff: string): TurnDiffFile => ({ path, status: "modified", added: 1, removed: 0, diff });

describe("viewed marks", () => {
	it("drop when the file's diff changed since it was marked", () => {
		const before = file("a.ts", "@@ -1 +1 @@\n+x\n");
		const after = file("a.ts", "@@ -1 +1,2 @@\n+x\n+y\n");
		const marks = { "a.ts": fileSignature(before) };
		expect([...viewedPaths([before], marks)]).toEqual(["a.ts"]);
		expect([...viewedPaths([after], marks)]).toEqual([]);
	});
});

const user = (id: string, parentId: string | null, text: string): SessionEntry => ({
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	type: "message",
	message: { role: "user", content: text, timestamp: 0 },
});

describe("promptTurns", () => {
	it("numbers each prompt and labels it with its first line", () => {
		const entries = [user("p1", null, "first line\nsecond"), user("p2", "p1", "x".repeat(200))];
		const turns = promptTurns(entries);
		expect(turns.map(t => [t.id, t.turn])).toEqual([
			["p1", 1],
			["p2", 2],
		]);
		expect(turns[0]!.label).toBe("first line");
		expect(turns[1]!.label.length).toBeLessThanOrEqual(60);
	});
});
