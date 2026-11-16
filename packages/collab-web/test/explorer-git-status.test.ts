import { describe, expect, it } from "bun:test";
import {
	type BadgeTone,
	badgeOf,
	changedFolders,
	filesIn,
	groupsOf,
	type GitGroup,
	toTreePath,
	treeStatus,
} from "../src/components/ide/explorer/git-status";
import type { GitFileChange } from "../src/lib/companion";

const change = (path: string, status: string): GitFileChange => ({ path, status, added: 1, removed: 0 });

describe("groupsOf", () => {
	const cases: [string, string[]][] = [
		[" M", ["changed"]],
		["M ", ["staged"]],
		["MM", ["staged", "changed"]],
		["A ", ["staged"]],
		["AM", ["staged", "changed"]],
		[" D", ["changed"]],
		["D ", ["staged"]],
		["R ", ["staged"]],
		["RM", ["staged", "changed"]],
		["??", ["untracked"]],
		["UU", ["conflict"]],
		["AA", ["conflict"]],
		["DD", ["conflict"]],
		["DU", ["conflict"]],
		["!!", []],
	];
	for (const [status, groups] of cases) {
		it(`maps ${JSON.stringify(status)} to ${groups.join("+") || "nothing"}`, () => {
			expect(groupsOf(status)).toEqual(groups as GitGroup[]);
		});
	}
});

describe("badgeOf", () => {
	const cases: [string, string, BadgeTone][] = [
		[" M", "M", "mod"],
		["M ", "M", "mod"],
		["MM", "M", "mod"],
		["A ", "A", "add"],
		["AM", "M", "mod"],
		[" D", "D", "del"],
		["D ", "D", "del"],
		["R ", "R", "move"],
		["C ", "C", "add"],
		["??", "U", "add"],
		["UU", "!", "del"],
		["AA", "!", "del"],
	];
	for (const [status, letter, tone] of cases) {
		it(`shows ${JSON.stringify(status)} as ${letter}`, () => {
			const badge = badgeOf(status);
			expect(badge.letter).toBe(letter);
			expect(badge.tone).toBe(tone);
		});
	}
});

describe("filesIn", () => {
	it("lists a file in every group it is in, keeping the snapshot's order", () => {
		const files = [change("a", "MM"), change("b", " M"), change("c", "??"), change("d", "A "), change("e", "UU")];
		expect(filesIn(files, "staged").map(f => f.path)).toEqual(["a", "d"]);
		expect(filesIn(files, "changed").map(f => f.path)).toEqual(["a", "b"]);
		expect(filesIn(files, "untracked").map(f => f.path)).toEqual(["c"]);
		expect(filesIn(files, "conflict").map(f => f.path)).toEqual(["e"]);
	});
});

describe("changedFolders", () => {
	it("marks every folder above a changed file, and no others", () => {
		const folders = changedFolders(["src/ui/a.ts", "docs/readme.md", "top.txt"]);
		expect([...folders].sort()).toEqual(["docs", "src", "src/ui"]);
		expect(folders.has("src/other")).toBe(false);
	});

	it("is empty for files at the root, and for no files", () => {
		expect(changedFolders(["top.txt"]).size).toBe(0);
		expect(changedFolders([]).size).toBe(0);
	});
});

describe("toTreePath", () => {
	it("is the path itself when the tree is rooted at the repository", () => {
		expect(toTreePath("src/a.ts", "/repo", "/repo")).toBe("src/a.ts");
	});

	it("is relative to a subfolder the tree is rooted at, and null outside it", () => {
		expect(toTreePath("pkg/web/src/a.ts", "/repo", "/repo/pkg/web")).toBe("src/a.ts");
		expect(toTreePath("pkg/api/a.ts", "/repo", "/repo/pkg/web")).toBeNull();
		expect(toTreePath("a.ts", "/repo", "/elsewhere")).toBeNull();
	});
});

describe("treeStatus", () => {
	it("decorates files and their folders by tree path", () => {
		const status = treeStatus(
			[
				change("src/ui/a.ts", " M"),
				change("src/new.ts", "??"),
				change("ignored.log", "!!"),
				change("gone/x.ts", " D"),
			],
			"/repo",
			"/repo",
		);
		expect(status.files.get("src/ui/a.ts")?.letter).toBe("M");
		expect(status.files.get("src/new.ts")?.letter).toBe("U");
		expect(status.files.has("ignored.log")).toBe(false);
		expect([...status.folders].sort()).toEqual(["gone", "src", "src/ui"]);
	});

	it("drops changes outside a subfolder tree", () => {
		const status = treeStatus([change("pkg/web/a.ts", " M"), change("pkg/api/b.ts", " M")], "/repo", "/repo/pkg/web");
		expect([...status.files.keys()]).toEqual(["a.ts"]);
		expect(status.folders.size).toBe(0);
	});
});
