import { describe, expect, it } from "bun:test";
import type { PersonalAboutVersion, PersonalDiffLine, PersonalMemory } from "@oh-my-pi/pi-wire/personal";
import { aboutSize, aboutVersionBy, aboutVersionDiff } from "../src/lib/personal-about";
import { lineDiff, MAX_DIFF_LINES, textLines } from "../src/lib/personal-diff";
import {
	applyMemory,
	exportFileName,
	filtersKey,
	importancePercent,
	isFiltered,
	MEMORY_PAGE,
	memoryDate,
	memoryQuery,
	mergePage,
	NO_FILTERS,
	recallText,
	toggleOrigin,
} from "../src/lib/personal-memory";

/** The diff as `+text` / `-text` / ` text` lines, to read a result at a glance. */
function show(lines: readonly PersonalDiffLine[]): string[] {
	return lines.map(line => `${line.op === "add" ? "+" : line.op === "del" ? "-" : " "}${line.text}`);
}

/** `before` rebuilt from the diff, and `after`: both must come back out of any diff. */
function sides(lines: readonly PersonalDiffLine[]): { before: string[]; after: string[] } {
	return {
		before: lines.filter(line => line.op !== "add").map(line => line.text),
		after: lines.filter(line => line.op !== "del").map(line => line.text),
	};
}

function memory(id: string, extra: Partial<PersonalMemory> = {}): PersonalMemory {
	return {
		id,
		store: "working",
		content: id,
		createdAt: "2026-03-10T10:00:00.000Z",
		origin: "owner",
		authorId: "owner",
		trustTier: "high",
		importance: 0.5,
		pinned: false,
		invalid: false,
		recallCount: 0,
		...extra,
	};
}

describe("lineDiff", () => {
	it("keeps identical text", () => {
		expect(show(lineDiff("a\nb", "a\nb"))).toEqual([" a", " b"]);
	});

	it("shows a changed line as removed then added", () => {
		expect(show(lineDiff("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
	});

	it("shows insertions and deletions in place", () => {
		expect(show(lineDiff("a\nc", "a\nb\nc"))).toEqual([" a", "+b", " c"]);
		expect(show(lineDiff("a\nb\nc", "a\nc"))).toEqual([" a", "-b", " c"]);
	});

	it("diffs against nothing: everything added, or everything removed", () => {
		expect(show(lineDiff("", "a\nb"))).toEqual(["+a", "+b"]);
		expect(show(lineDiff("a\nb", ""))).toEqual(["-a", "-b"]);
		expect(lineDiff("", "")).toEqual([]);
	});

	it("does not count a trailing newline as a line", () => {
		expect(textLines("a\nb\n")).toEqual(["a", "b"]);
		expect(textLines("")).toEqual([]);
		expect(show(lineDiff("a\nb\n", "a\nb"))).toEqual([" a", " b"]);
	});

	it("finds the longest common run, not just the matching ends", () => {
		const diff = lineDiff("x\na\nb\nc\ny", "p\na\nq\nc\nr");
		expect(show(diff)).toEqual(["-x", "+p", " a", "-b", "+q", " c", "-y", "+r"]);
	});

	it("keeps blank lines and repeated lines", () => {
		const before = "# T\n\nitem\nitem\n\nend";
		const after = "# T\n\nitem\n\nend\nmore";
		const { before: b, after: a } = sides(lineDiff(before, after));
		expect(b).toEqual(textLines(before));
		expect(a).toEqual(textLines(after));
	});

	it("rebuilds both sides for a shuffled text", () => {
		const before = Array.from({ length: 40 }, (_, i) => `line ${i}`);
		const after = [...before.slice(20), "new", ...before.slice(0, 10), "tail"];
		const { before: b, after: a } = sides(lineDiff(before.join("\n"), after.join("\n")));
		expect(b).toEqual(before);
		expect(a).toEqual(after);
	});

	it("falls back to remove-all, add-all beyond the size guard", () => {
		const big = MAX_DIFF_LINES + 5;
		const before = Array.from({ length: big }, (_, i) => `a${i}`);
		const after = Array.from({ length: big }, (_, i) => `b${i}`);
		const diff = lineDiff(before.join("\n"), after.join("\n"));
		expect(diff.filter(line => line.op === "keep")).toHaveLength(0);
		expect(diff).toHaveLength(big * 2);
		expect(diff.slice(0, big).every(line => line.op === "del")).toBe(true);
		expect(diff.slice(big).every(line => line.op === "add")).toBe(true);
	});

	it("still keeps a shared head and tail around a guarded middle", () => {
		const big = MAX_DIFF_LINES + 1;
		const middle = (tag: string) => Array.from({ length: big }, (_, i) => `${tag}${i}`);
		const diff = lineDiff(["top", ...middle("a"), "end"].join("\n"), ["top", ...middle("b"), "end"].join("\n"));
		expect(diff[0]).toEqual({ op: "keep", text: "top" });
		expect(diff.at(-1)).toEqual({ op: "keep", text: "end" });
		expect(diff).toHaveLength(2 * big + 2);
	});
});

describe("memory query from filters", () => {
	it("asks for the newest page with no filters", () => {
		expect(memoryQuery(NO_FILTERS, 0)).toEqual({ limit: MEMORY_PAGE, offset: 0 });
	});

	it("trims the keywords and leaves an empty search out", () => {
		expect(memoryQuery({ ...NO_FILTERS, q: "  cat  " }, 30)).toEqual({ q: "cat", limit: MEMORY_PAGE, offset: 30 });
		expect(memoryQuery({ ...NO_FILTERS, q: "   " }, 0).q).toBeUndefined();
	});

	it("carries every filter that is on", () => {
		const filters = { q: "x", origins: ["owner", "external"] as const, pinnedOnly: true, includeInvalid: true };
		expect(memoryQuery(filters, 60, 10)).toEqual({
			q: "x",
			origin: ["owner", "external"],
			pinnedOnly: true,
			includeInvalid: true,
			limit: 10,
			offset: 60,
		});
	});

	it("toggles origins on and off, in the order the chips show them", () => {
		const one = toggleOrigin(NO_FILTERS, "external");
		const two = toggleOrigin(one, "owner");
		expect(two.origins).toEqual(["owner", "external"]);
		expect(toggleOrigin(two, "owner").origins).toEqual(["external"]);
	});

	it("keys the list by what it asks for, not by the page", () => {
		expect(filtersKey({ ...NO_FILTERS, q: " cat " })).toBe(filtersKey({ ...NO_FILTERS, q: "cat" }));
		expect(filtersKey(NO_FILTERS)).not.toBe(filtersKey({ ...NO_FILTERS, pinnedOnly: true }));
		expect(filtersKey({ ...NO_FILTERS, origins: ["agent"] })).not.toBe(
			filtersKey({ ...NO_FILTERS, origins: ["owner"] }),
		);
	});

	it("tells filtered from unfiltered", () => {
		expect(isFiltered(NO_FILTERS)).toBe(false);
		expect(isFiltered({ ...NO_FILTERS, q: "  " })).toBe(false);
		expect(isFiltered({ ...NO_FILTERS, includeInvalid: true })).toBe(true);
	});
});

describe("memory list updates", () => {
	it("appends a page and drops what is already shown", () => {
		const shown = [memory("a"), memory("b")];
		const merged = mergePage(shown, [memory("b"), memory("c")]);
		expect(merged.map(m => m.id)).toEqual(["a", "b", "c"]);
	});

	it("takes the newer copy of a repeated memory without moving it", () => {
		const merged = mergePage([memory("a"), memory("b")], [memory("a", { pinned: true }), memory("c")]);
		expect(merged.map(m => m.id)).toEqual(["a", "b", "c"]);
		expect(merged[0].pinned).toBe(true);
	});

	it("never lists an id twice even when a page repeats itself", () => {
		const merged = mergePage([], [memory("a"), memory("a"), memory("b")]);
		expect(merged.map(m => m.id)).toEqual(["a", "b"]);
	});

	it("replaces a changed memory in place", () => {
		const next = applyMemory([memory("a"), memory("b")], 2, memory("b", { pinned: true }), false);
		expect(next.items.map(m => m.pinned)).toEqual([false, true]);
		expect(next.total).toBe(2);
	});

	it("shows a retracted memory struck through when retracted ones are shown", () => {
		const retracted = memory("b", { invalid: true, invalidBy: "owner" });
		const next = applyMemory([memory("a"), memory("b")], 2, retracted, true);
		expect(next.items[1]).toBe(retracted);
		expect(next.total).toBe(2);
	});

	it("drops a retracted memory while retracted ones are hidden", () => {
		const next = applyMemory(
			[memory("a"), memory("b")],
			2,
			memory("b", { invalid: true, invalidBy: "owner" }),
			false,
		);
		expect(next.items.map(m => m.id)).toEqual(["a"]);
		expect(next.total).toBe(1);
	});

	it("ignores a memory that is not shown", () => {
		const next = applyMemory([memory("a")], 5, memory("z", { pinned: true }), false);
		expect(next.items.map(m => m.id)).toEqual(["a"]);
		expect(next.total).toBe(5);
	});
});

describe("memory wording", () => {
	it("says how often a memory was recalled", () => {
		expect(recallText(0)).toBe("");
		expect(recallText(1)).toBe("recalled once");
		expect(recallText(7)).toBe("recalled 7 times");
	});

	it("turns importance into a clamped percent", () => {
		expect(importancePercent(0.7)).toBe(70);
		expect(importancePercent(3)).toBe(100);
		expect(importancePercent(-1)).toBe(0);
		expect(importancePercent(Number.NaN)).toBe(0);
	});

	it("shows the year only when it is not this one", () => {
		const now = Date.parse("2026-06-15T12:00:00Z");
		expect(memoryDate("2026-03-10T12:00:00Z", now)).not.toContain("2026");
		expect(memoryDate("2025-03-10T12:00:00Z", now)).toContain("2025");
		expect(memoryDate("not a date", now)).toBe("not a date");
	});
});

describe("export file name", () => {
	it("keeps the name the computer suggested", () => {
		expect(exportFileName("personal-memory-2027-01-31.json", "json")).toBe("personal-memory-2027-01-31.json");
		expect(exportFileName("personal-memory-2027-01-31.md", "markdown")).toBe("personal-memory-2027-01-31.md");
	});

	it("adds the extension the format needs", () => {
		expect(exportFileName("memories", "json")).toBe("memories.json");
		expect(exportFileName("memories.json", "markdown")).toBe("memories.json.md");
		expect(exportFileName("MEMORIES.JSON", "json")).toBe("MEMORIES.JSON");
	});

	it("drops folders, control characters and a leading dot", () => {
		expect(exportFileName("../../etc/passwd", "json")).toBe("passwd.json");
		expect(exportFileName("C:\\x\\mem.json", "json")).toBe("mem.json");
		expect(exportFileName(".hidden.json", "json")).toBe("hidden.json");
		expect(exportFileName("a\u0000b\nc.md", "markdown")).toBe("abc.md");
	});

	it("falls back to a fixed name when nothing usable is left", () => {
		expect(exportFileName("", "json")).toBe("personal-memory.json");
		expect(exportFileName("/", "markdown")).toBe("personal-memory.md");
		expect(exportFileName("...", "json")).toBe("personal-memory.json");
	});
});

describe("About you", () => {
	it("counts a token for every four characters, rounding up", () => {
		expect(aboutSize("").tokens).toBe(0);
		expect(aboutSize("abcd").tokens).toBe(1);
		expect(aboutSize("abcde").tokens).toBe(2);
	});

	it("flags a draft over the token budget, and one over the byte limit", () => {
		expect(aboutSize("a".repeat(6000)).over).toBe(false);
		expect(aboutSize("a".repeat(6001)).over).toBe(true);
		expect(aboutSize("a".repeat(16 * 1024)).tooLong).toBe(false);
		expect(aboutSize("a".repeat(16 * 1024 + 1)).tooLong).toBe(true);
		// Bytes, not characters: two-byte characters reach the limit sooner.
		expect(aboutSize("é".repeat(8 * 1024 + 1)).tooLong).toBe(true);
	});

	const versions: PersonalAboutVersion[] = [
		{ rev: 3, at: 3, by: "proposal", proposalId: "prop-1234567890", text: "a\nb\nc" },
		{ rev: 2, at: 2, by: "owner", text: "a\nb" },
		{ rev: 1, at: 1, by: "setup", text: "a" },
	];

	it("names who made a version", () => {
		expect(aboutVersionBy(versions[2])).toBe("Set up");
		expect(aboutVersionBy(versions[1])).toBe("You");
		expect(aboutVersionBy(versions[0])).toBe("Proposal accepted · prop-123");
	});

	it("diffs each version against the one before it, the first against nothing", () => {
		expect(show(aboutVersionDiff(versions, 0) ?? [])).toEqual([" a", " b", "+c"]);
		expect(show(aboutVersionDiff(versions, 1) ?? [])).toEqual([" a", "+b"]);
		expect(show(aboutVersionDiff(versions, 2) ?? [])).toEqual(["+a"]);
	});

	it("has no diff for the oldest listed version when an earlier one exists", () => {
		expect(aboutVersionDiff(versions.slice(0, 2), 1)).toBeNull();
	});
});
