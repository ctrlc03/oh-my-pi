import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderList } from "../src/components/shell/StartSessionSheet";
import { shortenPath } from "../src/lib/format";
import { EMPTY_SLUG, MAX_SLUG_CHARS, scratchFolderName, scratchLabel, scratchSlug } from "../src/lib/scratch";
import {
	folderLabel,
	isProjectless,
	NO_PROJECT,
	nextDraft,
	newSessionTarget,
	promptTitle,
	type StartDraft,
	startOptions,
} from "../src/lib/start-session";

describe("scratchSlug", () => {
	it("keeps the first words, lowercase, joined by dashes", () => {
		expect(scratchSlug("Convert the PNGs in ./assets to WebP, please!")).toBe("convert-the-pngs-in-assets-to");
	});

	it("reads punctuation, emoji and whitespace as breaks, so a name never holds a path separator or dot", () => {
		expect(scratchSlug("  ../../etc/passwd \n\t rm -rf *  ")).toBe("etc-passwd-rm-rf");
		expect(scratchSlug("fix 🐛 in a/b\\c:d")).toBe("fix-in-a-b-c-d");
	});

	it("keeps letters and digits of any script", () => {
		expect(scratchSlug("Réseau 日本語 テスト 2026")).toBe("réseau-日本語-テスト-2026");
		expect(scratchSlug("ПРИВЕТ мир")).toBe("привет-мир");
	});

	it("composes combining marks and folds compatibility forms, so the same text always names the same folder", () => {
		expect(scratchSlug("cafe\u0301")).toBe(scratchSlug("caf\u00e9"));
		expect(scratchSlug("ｆｕｌｌｗｉｄｔｈ")).toBe("fullwidth");
	});

	it("falls back to `session` when no word is left", () => {
		for (const prompt of [undefined, "", "   \n", "🙂🙂", "!!! ???", "\u200b\u200d"])
			expect(scratchSlug(prompt)).toBe(EMPTY_SLUG);
	});

	it("caps the words and the length, cutting only a first word that is too long", () => {
		expect(scratchSlug("one two three four five six seven eight")).toBe("one-two-three-four-five-six");
		const long = scratchSlug(`${"a".repeat(30)} ${"b".repeat(30)}`);
		expect(long).toBe("a".repeat(30));
		expect(scratchSlug("x".repeat(500))).toBe("x".repeat(MAX_SLUG_CHARS));
	});

	it("counts code points, never splitting a surrogate pair", () => {
		const slug = scratchSlug("𠮷".repeat(100));
		expect(Array.from(slug)).toHaveLength(MAX_SLUG_CHARS);
		expect(slug).toBe("𠮷".repeat(MAX_SLUG_CHARS));
		// Far below a file name's 255 bytes even in four-byte characters, with date and id.
		expect(
			new TextEncoder().encode(scratchFolderName(new Date(2026, 9, 11), "𠮷".repeat(100), "abc123")).length,
		).toBeLessThan(255);
	});

	it("only reads the start of a very long prompt", () => {
		expect(scratchSlug(`${" ".repeat(10_000)}late words`)).toBe(EMPTY_SLUG);
	});
});

describe("scratchFolderName and scratchLabel", () => {
	const day = new Date(2026, 0, 5, 23, 59);

	it("names a folder <local date>-<slug>-<id>", () => {
		expect(scratchFolderName(day, "convert pngs", "a1b2c3")).toBe("2026-01-05-convert-pngs-a1b2c3");
		expect(scratchFolderName(day, undefined, "a1b2c3")).toBe("2026-01-05-session-a1b2c3");
	});

	it("labels what it named, from any parent, and nothing else", () => {
		const name = scratchFolderName(day, "convert pngs", "a1b2c3");
		expect(scratchLabel(`/Users/me/.omp/scratch/${name}`)).toBe("Scratch · convert pngs");
		expect(scratchLabel(`/Users/me/.omp/scratch/${name}/`)).toBe("Scratch · convert pngs");
		expect(scratchLabel("/Users/me/.omp/scratch/2026-01-05-session-a1b2c3")).toBe("Scratch · session");
		expect(scratchLabel("/Users/me/work/2026-01-05-convert-pngs-a1b2c3")).toBeNull();
		expect(scratchLabel("/Users/me/.omp/scratch/notes")).toBeNull();
		expect(scratchLabel("/Users/me/.omp/scratch/2026-01-05-convert-pngs-zzzzzz")).toBeNull();
		expect(scratchLabel("")).toBeNull();
	});

	it("reads back every slug it can produce", () => {
		for (const prompt of ["a", "日本語 テスト", "x".repeat(99), "1 2 3", "--", undefined]) {
			const slug = scratchSlug(prompt);
			expect(scratchLabel(`/h/.omp/scratch/${scratchFolderName(day, prompt, "0123ab")}`)).toBe(
				`Scratch · ${slug.replaceAll("-", " ")}`,
			);
		}
	});

	it("reads in the lists as the label rather than the long path", () => {
		expect(shortenPath("/Users/me/.omp/scratch/2026-01-05-convert-pngs-a1b2c3")).toBe("Scratch · convert pngs");
		expect(shortenPath("/Users/me/code/app")).toBe("~/code/app");
	});
});

const draft: StartDraft = {
	cwd: "/Users/me/code/app",
	sandboxed: true,
	worktree: true,
	branch: " fix/x ",
	prompt: " do it \n",
	agent: null,
	model: "",
	permission: "supervised",
};

describe("the start draft", () => {
	it("asks for a worktree only in a folder with a repository", () => {
		expect(newSessionTarget(draft)).toEqual({
			cwd: "/Users/me/code/app",
			sandboxed: true,
			worktree: { branch: "fix/x" },
			scratch: undefined,
		});
		expect(newSessionTarget({ ...draft, branch: "" }).worktree).toEqual({ branch: undefined });
		const scratchFolder = "/Users/me/.omp/scratch/2026-01-05-do-it-a1b2c3";
		expect(newSessionTarget({ ...draft, cwd: scratchFolder })).toEqual({
			cwd: scratchFolder,
			sandboxed: true,
			worktree: undefined,
			scratch: undefined,
		});
	});

	it("carries a vendor agent, its model and permission, and none for omp", () => {
		expect(newSessionTarget(draft)).not.toHaveProperty("agent");
		expect(newSessionTarget({ ...draft, agent: "claude", model: "opus", permission: "full" })).toMatchObject({
			agent: "claude",
			model: "opus",
			permission: "full",
		});
		expect(newSessionTarget({ ...draft, agent: "codex" }).model).toBeUndefined();
	});

	it("asks for a scratch folder, named by the prompt, when no project is picked", () => {
		expect(newSessionTarget({ ...draft, cwd: NO_PROJECT })).toEqual({
			cwd: "",
			sandboxed: true,
			worktree: undefined,
			scratch: { hint: "do it" },
		});
		expect(newSessionTarget({ ...draft, cwd: NO_PROJECT, prompt: "  " }).scratch).toEqual({ hint: undefined });
	});

	it("sends only what is set", () => {
		expect(startOptions({ cwd: "/p", sandboxed: false })).toEqual({
			resume: undefined,
			sandboxed: undefined,
			worktree: undefined,
			scratch: undefined,
			prompt: undefined,
			force: undefined,
		});
		const target = newSessionTarget({ ...draft, cwd: NO_PROJECT });
		expect(startOptions(target, { prompt: "do it" })).toMatchObject({
			sandboxed: true,
			scratch: { hint: "do it" },
			prompt: "do it",
		});
	});

	it("keeps the folder and workspace mode for the next draft, and empties what belonged to the session just started", () => {
		expect(nextDraft(draft)).toEqual({ ...draft, prompt: "", branch: "" });
	});

	it("labels folders", () => {
		expect(folderLabel(NO_PROJECT)).toBe("No project");
		expect(folderLabel("/Users/me/code/app")).toBe("app");
		expect(folderLabel("/Users/me/.omp/scratch/2026-01-05-convert-pngs-a1b2c3")).toBe("Scratch · convert pngs");
		expect(isProjectless(NO_PROJECT)).toBe(true);
		expect(isProjectless("/Users/me/code/app")).toBe(false);
	});

	it("titles a session by the first line of its prompt, shortened", () => {
		expect(promptTitle("\n  fix the build \nand more")).toBe("fix the build");
		expect(promptTitle("   ")).toBeNull();
		expect(promptTitle("x".repeat(60))).toBe(`${"x".repeat(47)}…`);
	});
});

describe("the folder list", () => {
	const folders = { status: "ready" as const, value: [{ cwd: "/Users/me/code/app", lastActive: 0, sessions: [] }] };

	it("offers No project when the companion advertises scratch folders", () => {
		const html = renderToStaticMarkup(
			FolderList({ state: folders, canScratch: true, onPick: () => {}, onRetry: () => {} }),
		);
		expect(html).toContain("No project");
		expect(html).toContain("app");
	});

	it("hides it from a companion that does not, which still lists its folders", () => {
		const html = renderToStaticMarkup(
			FolderList({ state: folders, canScratch: false, onPick: () => {}, onRetry: () => {} }),
		);
		expect(html).not.toContain("No project");
		expect(html).toContain("app");
	});

	it("offers it even while the folders load or when there are none", () => {
		for (const state of [{ status: "loading" as const }, { status: "ready" as const, value: [] }]) {
			expect(
				renderToStaticMarkup(FolderList({ state, canScratch: true, onPick: () => {}, onRetry: () => {} })),
			).toContain("No project");
		}
	});
});
