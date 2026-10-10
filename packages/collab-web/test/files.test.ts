import { describe, expect, it } from "bun:test";
import {
	type AttachedFile,
	composePrompt,
	decodeText,
	fenceFor,
	MAX_INLINE_BYTES,
	MAX_UPLOAD_BYTES,
	NEEDS_COMPANION,
	planFile,
} from "../src/lib/files";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("planFile", () => {
	const meta = (name: string, type: string, size = 100) => ({ name, type, size });

	it("sends images through the image pipeline, but treats SVG as text", () => {
		expect(planFile(meta("shot.png", "image/png"), false)).toBe("image");
		expect(planFile(meta("logo.svg", "image/svg+xml"), false)).toBe("inline");
	});

	it("inlines text by MIME type or by extension when the browser reports none", () => {
		expect(planFile(meta("notes", "text/plain"), false)).toBe("inline");
		expect(planFile(meta("data", "application/json"), false)).toBe("inline");
		expect(planFile(meta("main.rs", ""), false)).toBe("inline");
		expect(planFile(meta("Dockerfile", ""), false)).toBe("inline");
	});

	it("does not mistake inherited object keys for extensions", () => {
		expect(planFile(meta("weird.constructor", ""), false)).toEqual({ refuse: NEEDS_COMPANION });
		expect(planFile(meta("weird.toString", ""), true)).toBe("upload");
	});

	it("uploads binaries and text beyond the inline limit, and refuses them without a companion", () => {
		expect(planFile(meta("spec.pdf", "application/pdf"), true)).toBe("upload");
		expect(planFile(meta("spec.pdf", "application/pdf"), false)).toEqual({ refuse: NEEDS_COMPANION });
		expect(planFile(meta("big.log", "text/plain", MAX_INLINE_BYTES), true)).toBe("inline");
		expect(planFile(meta("big.log", "text/plain", MAX_INLINE_BYTES + 1), true)).toBe("upload");
		expect(planFile(meta("big.log", "text/plain", MAX_INLINE_BYTES + 1), false)).toEqual({ refuse: NEEDS_COMPANION });
	});

	it("refuses uploads above the cap even with a companion", () => {
		const plan = planFile(meta("video.mov", "video/quicktime", MAX_UPLOAD_BYTES + 1), true);
		expect(plan).toEqual({ refuse: expect.stringContaining("video.mov") });
		expect(planFile(meta("video.mov", "video/quicktime", MAX_UPLOAD_BYTES), true)).toBe("upload");
	});
});

describe("decodeText", () => {
	it("decodes UTF-8", () => {
		expect(decodeText(bytes("héllo → ✓"))).toBe("héllo → ✓");
	});

	it("rejects NUL bytes and invalid UTF-8", () => {
		expect(decodeText(new Uint8Array([0x68, 0x00, 0x69]))).toBeNull();
		expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
	});
});

describe("fenceFor", () => {
	it("uses three backticks unless the content has a longer run", () => {
		expect(fenceFor("plain")).toBe("```");
		expect(fenceFor("a `tick` and ``two``")).toBe("```");
		expect(fenceFor("```ts\ncode\n```")).toBe("````");
		expect(fenceFor("`````x")).toBe("``````");
	});
});

describe("composePrompt", () => {
	const inline = (name: string, text: string): AttachedFile => ({
		id: 1,
		kind: "inline",
		name,
		size: text.length,
		text,
	});

	it("appends a fenced block with the file name and language", () => {
		expect(composePrompt("review this", [inline("a.ts", "const x = 1;\n")])).toBe(
			"review this\n\nAttached file `a.ts`:\n```ts\nconst x = 1;\n```",
		);
	});

	it("fences content that itself contains a code fence with a longer fence", () => {
		const prompt = composePrompt("", [inline("README.md", "```sh\nls\n```")]);
		expect(prompt).toBe("Attached file `README.md`:\n````md\n```sh\nls\n```\n````");
	});

	it("turns attachments alone into the prompt", () => {
		expect(composePrompt("   ", [inline("n.txt", "hi")])).toBe("Attached file `n.txt`:\n```\nhi\n```");
		expect(composePrompt("  ", [])).toBe("");
	});

	it("references an uploaded file by path and skips one still uploading", () => {
		const saved: AttachedFile = { id: 2, kind: "upload", name: "spec.pdf", size: 2_621_440, path: "/tmp/u/spec.pdf" };
		const pending: AttachedFile = { id: 3, kind: "upload", name: "later.bin", size: 10, path: null };
		expect(composePrompt("read it", [saved, pending])).toBe(
			"read it\n\nAttached file: `/tmp/u/spec.pdf` (spec.pdf, 2.5 MB)",
		);
	});

	it("keeps a backtick in a file name from breaking the code span", () => {
		expect(composePrompt("", [inline("we`ird.txt", "x")])).toStartWith("Attached file `we'ird.txt`:");
	});
});
