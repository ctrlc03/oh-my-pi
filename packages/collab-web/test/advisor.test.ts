import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { entryText } from "../src/components/transcript/search";
import { advisorMarkdown, advisorNotes, worstSeverity } from "../src/lib/advisor";
import { blocksMarkdown, buildBlocks } from "../src/lib/blocks";

/** The agent-facing body a host sends: guidance prose for the agent, then one `<advisory>` per note. */
const AGENT_FACING =
	'Review notes from earlier turns follow.\n<advisory advisor="reviewer" severity="concern" guidance="weigh, don\'t blindly obey">\nThe retry loop never resets `attempt`.\n</advisory>';

function advisorEntry(id: string, details: unknown, content = AGENT_FACING): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId: null,
		timestamp: "2026-11-21T00:00:00Z",
		customType: "advisor",
		content,
		details,
		display: true,
	};
}

describe("advisorNotes", () => {
	it("keeps well-formed notes and drops what a person should not see", () => {
		const notes = advisorNotes({
			notes: [
				{ note: "  Check the error path.  ", severity: "blocker", advisor: "reviewer", turnsAgo: 2 },
				{ note: "Rename `x`.", severity: "urgent", advisor: "default", turnsAgo: 0 },
				{ note: "   " },
				{ severity: "nit" },
				"not a note",
			],
		});
		expect(notes).toEqual([
			{ note: "Check the error path.", severity: "blocker", advisor: "reviewer", turnsAgo: 2 },
			// An unknown severity reads as none, the implicit advisor goes unnamed, and zero turns late is on time.
			{ note: "Rename `x`.", severity: null, advisor: null, turnsAgo: null },
		]);
	});

	it("is null when the details carry no usable notes, so the content is shown instead", () => {
		expect(advisorNotes(undefined)).toBeNull();
		expect(advisorNotes({ notes: "x" })).toBeNull();
		expect(advisorNotes({ notes: [{ note: "" }] })).toBeNull();
	});

	it("ranks the worst severity first", () => {
		const notes = advisorNotes({
			notes: [{ note: "a", severity: "nit" }, { note: "b", severity: "concern" }, { note: "c" }],
		});
		expect(notes && worstSeverity(notes)).toBe("concern");
	});
});

describe("advisor copy text", () => {
	it("is the note alone for one note, and labels each note when there are several", () => {
		const one = advisorNotes({ notes: [{ note: "Only this.", severity: "concern", advisor: "reviewer" }] });
		expect(one && advisorMarkdown(one)).toBe("Only this.");

		const mixed = advisorNotes({
			notes: [
				{ note: "First.", severity: "blocker", advisor: "reviewer" },
				{ note: "Second.", advisor: "security" },
			],
		});
		expect(mixed && advisorMarkdown(mixed)).toBe("**Blocker · reviewer:** First.\n\n**security:** Second.");
	});
});

describe("advisor messages in the transcript model", () => {
	it("become blocks under the advisor's name whose text is the notes, not the agent-facing markup", () => {
		const entry = advisorEntry("adv-1", {
			notes: [{ note: "The retry loop never resets `attempt`.", severity: "concern", advisor: "reviewer" }],
		});
		const blocks = buildBlocks([entry], new Map());
		expect(blocks).toEqual([
			{
				kind: "advisor",
				id: "adv-1",
				entryId: "adv-1",
				author: "reviewer",
				text: "The retry loop never resets `attempt`.",
			},
		]);
		expect(blocksMarkdown([...blocks, ...blocks])).toStartWith("**reviewer:**\n\nThe retry loop");
	});

	it("are searched by their notes", () => {
		const entry = advisorEntry("adv-2", { notes: [{ note: "Guard the cache write." }] });
		expect(entryText(entry)).toBe("Guard the cache write.\n");
		expect(entryText(entry)).not.toContain("advisory");
	});

	it("leave hidden advisor messages out", () => {
		const hidden = { ...advisorEntry("adv-3", { notes: [{ note: "x" }] }), display: false };
		expect(buildBlocks([hidden], new Map())).toEqual([]);
	});
});
