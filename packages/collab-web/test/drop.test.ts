import { describe, expect, it } from "bun:test";
import { dragKindOf, insertMention, mentionOf, parsePathDrag, PATH_DRAG_MIME } from "../src/lib/drop";

describe("dragKindOf", () => {
	it("tells Explorer rows from files, and rows win", () => {
		expect(dragKindOf(["Files"])).toBe("files");
		expect(dragKindOf([PATH_DRAG_MIME])).toBe("path");
		expect(dragKindOf(["Files", PATH_DRAG_MIME])).toBe("path");
	});

	it("takes nothing else: dragged text and links stay the browser's", () => {
		expect(dragKindOf(["text/plain", "text/uri-list"])).toBeNull();
		expect(dragKindOf([])).toBeNull();
	});
});

describe("parsePathDrag", () => {
	it("reads what a row wrote", () => {
		expect(parsePathDrag(JSON.stringify({ path: "src/app.ts", dir: false }))).toEqual({
			path: "src/app.ts",
			dir: false,
		});
		expect(parsePathDrag(JSON.stringify({ path: "src", dir: true }))).toEqual({ path: "src", dir: true });
	});

	it("refuses anything that is not a path payload", () => {
		expect(parsePathDrag("")).toBeNull();
		expect(parsePathDrag("not json")).toBeNull();
		expect(parsePathDrag("null")).toBeNull();
		expect(parsePathDrag(JSON.stringify({ path: "", dir: false }))).toBeNull();
		expect(parsePathDrag(JSON.stringify({ path: "a.ts" }))).toBeNull();
		expect(parsePathDrag(JSON.stringify({ path: 3, dir: false }))).toBeNull();
	});
});

describe("mentionOf", () => {
	it("writes a plain path as @path", () => {
		expect(mentionOf("src/app.ts")).toBe("@src/app.ts");
		expect(mentionOf("packages/collab-web/src")).toBe("@packages/collab-web/src");
	});

	it("quotes what the agent's mention reader would cut or trim", () => {
		expect(mentionOf("my docs/read me.md")).toBe('@"my docs/read me.md"');
		expect(mentionOf("users/@me/a.ts")).toBe('@"users/@me/a.ts"');
		expect(mentionOf("notes.")).toBe('@"notes."');
		expect(mentionOf("(draft)/a.md")).toBe('@"(draft)/a.md"');
	});

	it("uses the quote the path does not contain", () => {
		expect(mentionOf('say "hi".txt')).toBe(`@'say "hi".txt'`);
	});
});

describe("insertMention", () => {
	it("ends a mention that closes the draft with a space, ready for the next word", () => {
		expect(insertMention("look at", "src/a.ts", 7, 7)).toEqual({ text: "look at @src/a.ts ", caret: 18 });
		expect(insertMention("", "src/a.ts", 0, 0)).toEqual({ text: "@src/a.ts ", caret: 10 });
	});

	it("splices into the middle of a draft, set apart from the words around it", () => {
		const next = insertMention("fix now", "src/a.ts", 3, 3);
		expect(next.text).toBe("fix @src/a.ts now");
		expect(next.text.slice(next.caret)).toBe(" now");
	});

	it("replaces a selection", () => {
		expect(insertMention("read THIS please", "b.md", 5, 9).text).toBe("read @b.md please");
	});
});
