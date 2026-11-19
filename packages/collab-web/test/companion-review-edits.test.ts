import { describe, expect, it } from "bun:test";
import {
	capText,
	isWeakNote,
	changedLines,
	editExplainsHunk,
	explainHunks,
	fileHunks,
	linesOverlap,
	NOTE_CHARS,
	PROMPT_CHARS,
	type ScanScope,
	type SessionEdit,
	scanSessionEdits,
	textBefore,
	placeInTurns,
	type PromptTurn,
} from "../scripts/companion-review-edits";

const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const toolCall = (id: string, name: string, args: Record<string, unknown>, intent?: string) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
	...(intent ? { intent } : {}),
});

describe("capText", () => {
	it("keeps short text whole", () => {
		expect(capText("  Moved the check up.  ")).toBe("Moved the check up.");
	});

	it("cuts long text at the last sentence end", () => {
		const sentence = "This sentence says something useful about the change. ";
		const cut = capText(sentence.repeat(30), 200);
		expect(cut.length).toBeLessThanOrEqual(200);
		expect(cut.endsWith("change.")).toBe(true);
	});

	it("cuts at a word with an ellipsis when no sentence ends early enough", () => {
		const cut = capText(`${"word ".repeat(400)}end`, 100);
		expect(cut.endsWith("word…")).toBe(true);
		expect(cut.length).toBeLessThanOrEqual(101);
		expect(NOTE_CHARS).toBe(800);
	});
});

describe("textBefore", () => {
	it("takes the text between the previous call and this one", () => {
		const blocks = [text("first"), toolCall("a", "edit", {}), text("second"), toolCall("b", "edit", {})];
		expect(textBefore(blocks, 1)).toBe("first");
		expect(textBefore(blocks, 3)).toBe("second");
	});

	it("gives a call that follows another directly the text before both", () => {
		const blocks = [text("one reason"), toolCall("a", "edit", {}), toolCall("b", "edit", {})];
		expect(textBefore(blocks, 2)).toBe("one reason");
	});

	it("leaves thinking out and is empty without text", () => {
		expect(textBefore([thinking("secret plan"), toolCall("a", "edit", {})], 1)).toBe("");
		expect(textBefore([thinking("secret plan"), text("visible"), toolCall("a", "edit", {})], 2)).toBe("visible");
	});
});

describe("changedLines", () => {
	it("reads omp's edit result lines, trimmed and without blank lines", () => {
		const diff = " 8|keep\n-10|  old one\n+10|  new one\n+11|\n 12|keep\n";
		expect(changedLines(diff)).toEqual({ added: ["new one"], removed: ["old one"] });
	});

	it("reads a git unified diff without its file headers", () => {
		const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-gone\n+here\n";
		expect(changedLines(diff)).toEqual({ added: ["here"], removed: ["gone"] });
	});
});

describe("fileHunks", () => {
	it("lists each hunk by its header with the lines it added and removed", () => {
		const diff = [
			"diff --git a/f.ts b/f.ts",
			"--- a/f.ts",
			"+++ b/f.ts",
			"@@ -1,3 +1,3 @@ function a() {",
			" keep",
			"-  old();",
			"+  fresh();",
			"@@ -20,2 +20 @@",
			"-removed();",
			" tail",
			"",
		].join("\n");
		expect(fileHunks("f.ts", diff)).toEqual([
			{ path: "f.ts", hunk: "@@ -1,3 +1,3 @@", added: ["fresh();"], removed: ["old();"] },
			{ path: "f.ts", hunk: "@@ -20,2 +20 @@", added: [], removed: ["removed();"] },
		]);
	});

	it("has no hunks for a diff without any", () => {
		expect(
			fileHunks("img.png", "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n"),
		).toEqual([]);
	});
});

describe("linesOverlap", () => {
	it("needs half of the smaller side's meaningful lines", () => {
		expect(linesOverlap(["a = 1;", "b = 2;"], ["a = 1;", "c = 3;", "d = 4;"])).toBe(true);
		expect(linesOverlap(["a = 1;", "b = 2;", "c = 3;", "d = 4;"], ["a = 1;"])).toBe(true);
		expect(linesOverlap(["a = 1;", "b = 2;", "c = 3;"], ["a = 1;", "x = 9;", "y = 8;", "z = 7;"])).toBe(false);
	});

	it("does not count a lone closing bracket as an overlap", () => {
		expect(linesOverlap(["}", "return real;"], ["}", "other();"])).toBe(false);
		expect(linesOverlap(["}"], ["}"])).toBe(true);
	});

	it("does not overlap with nothing", () => {
		expect(linesOverlap([], ["x"])).toBe(false);
		expect(linesOverlap(["x"], [])).toBe(false);
	});
});

/** What an edit's text says by default: long enough, and about the code (a trim). */
const TRIM_TEXT =
	"Because the parser must trim its input, the value is trimmed here first so that stray whitespace cannot reach it.";

function edit(partial: Partial<SessionEdit> & { added: string[] }): SessionEdit {
	return {
		sessionId: "s1",
		sessionTitle: "Fix the parser",
		turn: 1,
		turnId: "t1",
		at: 100,
		path: "src/a.ts",
		text: TRIM_TEXT,
		removed: [],
		...partial,
	};
}

const hunk = (added: string[], removed: string[] = [], header = "@@ -1,2 +1,2 @@") => ({
	path: "src/a.ts",
	hunk: header,
	added,
	removed,
});

describe("explainHunks", () => {
	it("quotes the edit whose added lines overlap the hunk's", () => {
		const notes = explainHunks([hunk(["let x = trim(y);"])], [edit({ added: ["let x = trim(y);", "other();"] })]);
		expect(notes).toEqual([
			{
				path: "src/a.ts",
				hunk: "@@ -1,2 +1,2 @@",
				text: TRIM_TEXT,
				source: "session",
				sessionId: "s1",
				sessionTitle: "Fix the parser",
				turn: 1,
				at: 100,
			},
		]);
	});

	it("explains a pure deletion by the lines an edit removed", () => {
		const deletion = hunk([], ["legacyPath();"], "@@ -9,1 +8,0 @@");
		expect(explainHunks([deletion], [edit({ added: ["legacyPath();"], removed: [] })])).toEqual([]);
		const notes = explainHunks(
			[deletion],
			[edit({ added: [], removed: ["legacyPath();"], text: "Dropped dead code." })],
		);
		expect(notes.map(note => note.text)).toEqual(["Dropped dead code."]);
	});

	it("prefers the latest edit and passes over one without words", () => {
		const lines = ["shared line one();", "shared line two();"];
		const edits = [
			edit({ added: lines, at: 100, text: "First attempt." }),
			edit({ added: lines, at: 300, text: "Final version.", turn: 3, intent: "Reworking" }),
			edit({ added: lines, at: 200, text: "Middle." }),
		];
		const [note] = explainHunks([hunk(lines)], edits);
		expect(note).toMatchObject({ text: "Final version.", turn: 3, intent: "Reworking", at: 300 });
		const silent = [...edits, edit({ added: lines, at: 400, text: "" })];
		expect(explainHunks([hunk(lines)], silent)[0]?.text).toBe("Final version.");
	});

	it("lets the edit that wrote most of a hunk speak for it, not a later tweak of one line", () => {
		const lines = ["first line();", "second line();", "third line();", "fourth line();"];
		const edits = [
			edit({
				added: lines,
				at: 100,
				text: `Wrote the whole module here: the first line, the second line, the third line and the fourth line of it.`,
			}),
			edit({
				added: ["second line();"],
				at: 900,
				text: `Renamed the second line of the module, so that it says what the second line really does for the caller.`,
			}),
		];
		expect(explainHunks([hunk(lines)], edits)[0]?.text).toMatch(/^Wrote the whole module/);
		// A small hunk the tweak wrote in full goes to the tweak.
		expect(explainHunks([hunk(["second line();"])], edits)[0]?.text).toMatch(/^Renamed the second line/);
	});

	it("falls back to the intent when the edit had no text", () => {
		const [note] = explainHunks([hunk(["x = 1;"])], [edit({ added: ["x = 1;"], text: "", intent: "Setting x" })]);
		expect(note?.text).toBe("Setting x");
	});

	it("gives nothing to a hunk no edit touches, or one in another file", () => {
		expect(explainHunks([hunk(["a = 1;"])], [edit({ added: ["b = 2;"] })])).toEqual([]);
		expect(editExplainsHunk(hunk(["a = 1;"]), edit({ added: ["a = 1;"], path: "src/other.ts" }))).toBe(false);
	});

	it("caps long text", () => {
		const long = `${"A full sentence about it. ".repeat(80)}`;
		const [note] = explainHunks([hunk(["x = 1;"])], [edit({ added: ["x = 1;"], text: long })]);
		expect(note!.text.length).toBeLessThanOrEqual(NOTE_CHARS);
		expect(note!.text.endsWith(".")).toBe(true);
	});
});

// ── scanning a session ───────────────────────────────────────────────────────

const scope: ScanScope = {
	sessionId: "s1",
	sessionTitle: "Fix the parser",
	cwd: "/work/repo",
	realCwd: "/work/repo",
	roots: ["/work/repo", "/work/wt"],
	files: new Map([
		["src/a.ts", "src/a.ts"],
		["old/b.ts", "new/b.ts"],
	]),
};

const message = (entry: unknown) => JSON.stringify(entry);
const prompt = (id: string, content = "do it") =>
	message({ type: "message", id, message: { role: "user", content: [text(content)] } });
const assistant = (id: string, content: unknown[], timestamp = "2026-10-01T10:00:05.000Z") =>
	message({ type: "message", id, timestamp, message: { role: "assistant", content } });
const result = (toolCallId: string, details: unknown, isError = false) =>
	message({ type: "message", message: { role: "toolResult", toolCallId, isError, details } });

describe("scanSessionEdits", () => {
	it("pairs each successful edit with the text before its call, its intent, turn and time", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [
				thinking("hidden reasoning"),
				text("I will trim the input first."),
				toolCall("c1", "edit", { path: "src/a.ts" }, "Trimming input"),
			]),
			result("c1", { diff: " 1|ctx\n-2|raw(y);\n+2|  trim(y);\n" }),
			prompt("p2"),
			assistant("m2", [text("Second turn change."), toolCall("c2", "edit", { path: "src/a.ts" })]),
			result("c2", { diff: "+5|second();\n" }),
		];
		const edits = await scanSessionEdits(lines, scope);
		expect(edits).toEqual([
			{
				sessionId: "s1",
				sessionTitle: "Fix the parser",
				turn: 1,
				turnId: "p1",
				at: Date.parse("2026-10-01T10:00:05.000Z"),
				path: "src/a.ts",
				text: "I will trim the input first.",
				intent: "Trimming input",
				prompt: "do it",
				added: ["trim(y);"],
				removed: ["raw(y);"],
				changes: [{ oldStart: 2, removed: 1, newStart: 2, added: ["  trim(y);"] }],
			},
			expect.objectContaining({ turn: 2, turnId: "p2", text: "Second turn change.", added: ["second();"] }),
		]);
		expect(JSON.stringify(edits)).not.toContain("hidden reasoning");
	});

	it("records the turn's prompt words, the model, the line changes of an edit and a whole-file write", async () => {
		const longPrompt = `Please ${"refactor the parser and then rename every helper ".repeat(6)}`;
		const lines = [
			message({ type: "message", id: "p1", message: { role: "user", content: longPrompt } }),
			message({
				type: "message",
				id: "m1",
				message: {
					role: "assistant",
					model: "claude-opus-4-5",
					content: [toolCall("c1", "write", { path: "src/a.ts", content: "one\ntwo\n" })],
				},
			}),
			result("c1", {}),
		];
		const [written] = await scanSessionEdits(lines, scope);
		expect(written).toMatchObject({
			model: "claude-opus-4-5",
			rewrite: true,
			changes: [{ oldStart: 1, removed: 0, newStart: 1, added: ["one", "two"] }],
		});
		expect(written?.prompt?.startsWith("Please refactor the parser")).toBe(true);
		expect(written?.prompt?.endsWith("…")).toBe(true);
		expect(written?.prompt?.length).toBeLessThanOrEqual(PROMPT_CHARS + 1);
	});

	it("uses the latest assistant text of the turn when the call's own message has none", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [text("Plan: rename the helper."), toolCall("r", "read", { path: "src/a.ts" })]),
			assistant("m2", [toolCall("c1", "edit", { path: "src/a.ts" })]),
			result("c1", { diff: "+1|renamed();\n" }),
		];
		expect((await scanSessionEdits(lines, scope))[0]?.text).toBe("Plan: rename the helper.");
	});

	it("skips failed edits, edits of other files and calls that are not edits", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [
				text("t"),
				toolCall("c1", "edit", { path: "src/a.ts" }),
				toolCall("c2", "edit", { path: "src/zzz.ts" }),
				toolCall("c3", "read", { path: "src/a.ts" }),
			]),
			result("c1", { diff: "+1|x();\n" }, true),
			result("c2", { diff: "+1|y();\n" }),
			result("c3", {}),
		];
		expect(await scanSessionEdits(lines, scope)).toEqual([]);
	});

	it("maps a path in another checkout of the repository and a renamed file's old name", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [
				text("In the worktree."),
				toolCall("c1", "edit", { path: "/work/wt/src/a.ts" }),
				toolCall("c2", "edit", { path: "old/b.ts" }),
			]),
			result("c1", { diff: "+1|wt();\n" }),
			result("c2", { diff: "+1|renamed();\n" }),
		];
		const edits = await scanSessionEdits(lines, scope);
		expect(edits.map(e => e.path)).toEqual(["src/a.ts", "new/b.ts"]);
	});

	it("reads the per-file results of a multi-file call, and the input when the result has no diff", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [
				text("Two files."),
				toolCall("c1", "apply_patch", { input: "*** Update File: src/a.ts\n*** Update File: src/zzz.ts" }),
				toolCall("c2", "edit", { input: "[src/a.ts#1A2B]\nPUT >1:\n+added_by_input();\n" }),
			]),
			result("c1", {
				perFileResults: [
					{ path: "src/a.ts", diff: "+1|first();\n" },
					{ path: "src/zzz.ts", diff: "+1|other();\n" },
				],
			}),
			result("c2", {}),
		];
		const edits = await scanSessionEdits(lines, scope);
		expect(edits.map(e => e.added)).toEqual([["first();"], ["added_by_input();"]]);
	});

	it("counts a write as adding its whole content", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [
				text("New file."),
				toolCall("c1", "write", { path: "src/a.ts", content: "one();\n\ntwo();\n" }),
			]),
			result("c1", {}),
		];
		expect((await scanSessionEdits(lines, scope))[0]?.added).toEqual(["one();", "two();"]);
	});

	it("counts an ast_edit only when a resolve applied it, with the ast_edit call's words", async () => {
		const staged = {
			fileReplacements: [{ path: "src/a.ts", count: 1 }],
			displayContent: "## a.ts (1 replacement)\n-3│oldApi(x);\n+3│newApi(x);",
		};
		const applied = [
			prompt("p1"),
			assistant("m1", [text("Migrating the API."), toolCall("c1", "ast_edit", { ops: [] }, "Migrating")]),
			result("c1", staged),
			assistant("m2", [text("Looks right."), toolCall("c2", "resolve", { action: "apply" })]),
			result("c2", { action: "apply" }),
		];
		const [edit] = await scanSessionEdits(applied, scope);
		expect(edit).toMatchObject({
			text: "Migrating the API.",
			intent: "Migrating",
			added: ["newApi(x);"],
			removed: ["oldApi(x);"],
		});
		const discarded = [
			...applied.slice(0, 3),
			assistant("m2", [toolCall("c2", "resolve", { action: "discard" })]),
			result("c2", { action: "discard" }),
		];
		expect(await scanSessionEdits(discarded, scope)).toEqual([]);
	});

	it("sees through a device dispatch `write xd://<tool>`", async () => {
		const lines = [
			prompt("p1"),
			assistant("m1", [text("Via device."), toolCall("c1", "write", { path: "xd://edit", content: "{}" })]),
			result("c1", {
				xdev: { mode: "execute", tool: "edit", args: { path: "src/a.ts" }, inner: { diff: "+1|dev();\n" } },
			}),
		];
		expect((await scanSessionEdits(lines, scope))[0]).toMatchObject({ text: "Via device.", added: ["dev();"] });
	});
});

describe("placeInTurns", () => {
	const turns: PromptTurn[] = [
		{ id: "p1", turn: 1, at: 100 },
		{ id: "p2", turn: 2, at: 500 },
	];
	const made = (at: number) => edit({ added: ["x();"], at, turn: 1, turnId: "own" });

	it("puts a subagent's edit in the turn that was running when it was made", () => {
		const placed = placeInTurns([made(120), made(499), made(500), made(9_000)], turns);
		expect(placed.map(item => [item.turn, item.turnId])).toEqual([
			[1, "p1"],
			[1, "p1"],
			[2, "p2"],
			[2, "p2"],
		]);
	});

	it("puts an edit from before every prompt in the first turn, and leaves them alone when there are no turns", () => {
		expect(placeInTurns([made(5)], turns)[0]).toMatchObject({ turn: 1, turnId: "p1" });
		expect(placeInTurns([made(5)], [])[0]).toMatchObject({ turn: 1, turnId: "own" });
	});
});

describe("isWeakNote", () => {
	const code = hunk(["const trimmed = input.trim();", "return parseQuery(trimmed);"], [], "@@ -3 +3,2 @@");
	const good =
		"The input is trimmed before it is parsed, so trailing whitespace in a query cannot change what the parser matches.";

	it("lets a long quote that is about the change stand", () => {
		expect(isWeakNote(good, "Trimming input", code)).toBe(false);
	});

	it("is weak when the quote is only the edit's intent label", () => {
		expect(isWeakNote("Trimming  Input", "trimming input", code)).toBe(true);
	});

	it("is weak under twelve words, and not at twelve", () => {
		const twelve = "Trim the input before parse so whitespace cannot break it again today";
		expect(twelve.split(" ")).toHaveLength(12);
		expect(isWeakNote(twelve, undefined, code)).toBe(false);
		expect(isWeakNote(twelve.split(" ").slice(1).join(" "), undefined, code)).toBe(true);
		expect(isWeakNote("Cwd is ~/.omp; use absolute path.", undefined, code)).toBe(true);
	});

	it("is weak when no word of it is in the hunk's path or code", () => {
		const elsewhere =
			"Now the shared contract that every one of the parallel workers will build against has to be written down first.";
		expect(isWeakNote(elsewhere, undefined, code)).toBe(true);
		// Words in the path count, camelCase and plurals are told apart from neither.
		const named = hunk(["x();"], [], "@@ -1 +1 @@");
		named.path = "src/server/contractWriters.ts";
		expect(isWeakNote(elsewhere, undefined, named)).toBe(false);
	});
});

describe("explainHunks and weak quotes", () => {
	it("marks a note weak when nothing the session said about the hunk is better", () => {
		const [note] = explainHunks(
			[hunk(["let x = trim(y);"])],
			[edit({ added: ["let x = trim(y);"], text: "Trim it.", intent: "Trimming" })],
		);
		expect(note).toMatchObject({ text: "Trim it.", weak: true });
	});

	it("prefers a quote that is about the change over a weak one that wrote more of it", () => {
		const lines = ["let x = trim(y);", "let z = trim(w);"];
		const [note] = explainHunks(
			[hunk(lines)],
			[
				edit({ added: lines, at: 900, text: "", intent: "Writing" }),
				edit({ added: [lines[0]!], at: 100, text: TRIM_TEXT }),
			],
		);
		expect(note?.text).toBe(TRIM_TEXT);
		expect(note?.weak).toBeUndefined();
	});

	it("says a strong note is not weak", () => {
		const [note] = explainHunks([hunk(["let x = trim(y);"])], [edit({ added: ["let x = trim(y);"] })]);
		expect("weak" in note!).toBe(false);
	});
});
