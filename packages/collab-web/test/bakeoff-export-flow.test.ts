import { afterEach, describe, expect, it } from "bun:test";
import type { Bakeoff, BakeoffEntry, BakeoffResult } from "@oh-my-pi/pi-wire/bakeoff";
import { bakeoffReport } from "../src/components/bakeoff/bakeoff-report";
import {
	canMapEntry,
	canReviewAgain,
	canSparEntry,
	collectPatches,
	combinedPatch,
	combinedPatchFileName,
	leftOutLine,
	patchControls,
	patchFileName,
	patchOrder,
	reportFileName,
} from "../src/components/bakeoff/bakeoff-result-flow";
import { shareMarkdown } from "../src/lib/share";

const entry = (label: string, over: Partial<BakeoffEntry> = {}): BakeoffEntry => ({
	label,
	kind: "challenger",
	model: `secret-prov/model-${label.toLowerCase()}`,
	status: "ready",
	flags: [],
	instanceId: `i-${label.toLowerCase()}`,
	facts: { files: 1, added: 1, removed: 0 },
	...over,
});

const result = (over: Partial<BakeoffResult> = {}): BakeoffResult => ({
	ranking: [
		{ label: "A", rank: 3, score: 0.4, reasons: [], eligible: true, flags: [] },
		{ label: "B", rank: 1, score: 0.9, reasons: ["Best"], eligible: true, flags: [] },
		{ label: "C", rank: 2, score: 0.5, reasons: [], eligible: true, flags: [] },
	],
	verdict: "B wins.",
	findings: [],
	scores: {},
	agreement: "reviewer-only",
	reviewerModel: "prov/rev",
	selfPreference: [],
	unsure: [],
	taken: "B",
	...over,
});

const bakeoff = (over: Partial<Bakeoff> = {}): Bakeoff => ({
	v: 1,
	id: "bk-1",
	title: "Faster Queue — v2!",
	repo: { root: "/work/repo", name: "repo" },
	createdAt: 1,
	mode: "implementation",
	metrics: [{ id: "simplicity", label: "Simplicity", weight: 2 }],
	entries: [
		entry("A", { kind: "original", model: undefined, patch: { ok: true } }),
		entry("B", { patch: { ok: true } }),
		entry("C", { patch: { ok: true } }),
	],
	stage: "done",
	result: result(),
	warnings: [],
	reviewer: "prov/rev",
	writer: "@default",
	judge: "auto",
	costs: { entries: 1, writeups: 0.5, review: 0.4, judge: 0 },
	...over,
});

describe("patchControls", () => {
	it("shows nothing when the companion cannot export patches", () => {
		expect(patchControls(bakeoff(), entry("B", { patch: { ok: true } }), false)).toEqual({
			show: false,
			disabledReason: null,
		});
		expect(patchControls(bakeoff(), entry("B"), false).show).toBe(false);
	});

	it("shows nothing for a design, or before there is a result", () => {
		expect(patchControls(bakeoff({ mode: "design" }), entry("B"), true).show).toBe(false);
		expect(patchControls(bakeoff({ result: undefined }), entry("B"), true).show).toBe(false);
	});

	it("shows enabled controls for an entry the companion says can be exported", () => {
		expect(patchControls(bakeoff(), entry("B", { patch: { ok: true } }), true)).toEqual({
			show: true,
			disabledReason: null,
		});
	});

	it("shows disabled controls with the companion's reason when it cannot", () => {
		const gone = entry("B", { patch: { ok: false, reason: "The code of this entry is no longer kept." } });
		expect(patchControls(bakeoff(), gone, true)).toEqual({
			show: true,
			disabledReason: "The code of this entry is no longer kept.",
		});
	});

	it("leaves the controls enabled when the companion says nothing about the entry", () => {
		expect(patchControls(bakeoff(), entry("B", { patch: undefined }), true)).toEqual({
			show: true,
			disabledReason: null,
		});
	});
});

describe("file names", () => {
	it("slugs the title to ASCII words and never carries a model name", () => {
		const subject = bakeoff({ title: "Faster Queue — Ünïcode v2!" });
		expect(reportFileName(subject)).toBe("faster-queue-unicode-v2-bake-off.md");
		expect(patchFileName(subject, subject.entries[1]!)).toBe("faster-queue-unicode-v2-entry-b.patch");
		expect(combinedPatchFileName(subject)).toBe("faster-queue-unicode-v2-patches.patch");
		for (const name of [
			reportFileName(subject),
			patchFileName(subject, subject.entries[1]!),
			combinedPatchFileName(subject),
		]) {
			expect(name).not.toContain("secret");
			expect(name).not.toContain("model");
			expect(name).toMatch(/^[a-z0-9.-]+$/);
		}
	});

	it("has a plain name for a title with no letters", () => {
		const subject = bakeoff({ title: "???" });
		expect(reportFileName(subject)).toBe("bake-off.md");
		expect(patchFileName(subject, entry("C"))).toBe("bake-off-entry-c.patch");
		expect(combinedPatchFileName(subject)).toBe("bake-off-patches.patch");
	});

	it("keeps a long title to a sane length", () => {
		expect(reportFileName(bakeoff({ title: "word ".repeat(40) })).length).toBeLessThanOrEqual(
			60 + "-bake-off.md".length,
		);
	});
});

describe("the combined patch", () => {
	const patches = new Map([
		["A", "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-1\n+a\n"],
		["B", "diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-1\n+b\n"],
		["C", "diff --git a/c b/c\n--- a/c\n+++ b/c\n@@ -1 +1 @@\n-1\n+c\n"],
	]);

	it("lists the winner first, then the ranking, then entries the ranking leaves out", () => {
		expect(patchOrder(bakeoff()).map(item => item.label)).toEqual(["B", "C", "A"]);
		const subject = bakeoff({
			entries: [...bakeoff().entries, entry("E"), entry("D")],
			result: result(),
		});
		expect(patchOrder(subject).map(item => item.label)).toEqual(["B", "C", "A", "D", "E"]);
	});

	it("states the entries are alternatives, then separates each entry's patch", () => {
		const text = combinedPatch(bakeoff(), patches);
		const lines = text.split("\n");
		expect(lines[0]).toContain("ALTERNATIVES");
		expect(lines[1]).toContain("git apply");
		expect(lines[2]).toBe("# Entries in this file: B, C, A");
		const separators = lines.filter(line => line.startsWith("# ===== "));
		expect(separators).toEqual([
			"# ===== Entry B (rank 1, taken) =====",
			"# ===== Entry C (rank 2) =====",
			"# ===== Entry A (rank 3) =====",
		]);
		// each patch sits after its own separator and before the next
		const at = (needle: string): number => text.indexOf(needle);
		expect(at("# ===== Entry B")).toBeLessThan(at("+b\n"));
		expect(at("+b\n")).toBeLessThan(at("# ===== Entry C"));
		expect(at("+c\n")).toBeLessThan(at("# ===== Entry A"));
		expect(text).toContain(patches.get("B")!.trimEnd());
	});

	it("keeps every diff intact so git apply can read the part after a separator", () => {
		const text = combinedPatch(bakeoff(), patches);
		for (const patch of patches.values()) expect(text).toContain(patch);
	});

	it("names entries by label only, marks ties and unranked entries, and says when an entry changes nothing", () => {
		const subject = bakeoff({
			entries: [...bakeoff().entries, entry("D")],
			result: result({
				ranking: [
					{ label: "B", rank: 1, score: 0.9, reasons: [], eligible: true, flags: [] },
					{ label: "C", rank: 1, score: 0.9, reasons: [], eligible: true, flags: [] },
					{ label: "A", rank: 3, score: 0.4, reasons: [], eligible: true, flags: [] },
				],
				taken: undefined,
			}),
		});
		const text = combinedPatch(
			subject,
			new Map([
				["B", patches.get("B")!],
				["C", ""],
				["D", patches.get("A")!],
			]),
		);
		expect(text).toContain("# ===== Entry B (rank =1) =====");
		expect(text).toContain("# ===== Entry C (rank =1) =====\n\n# (this entry changes nothing)");
		expect(text).toContain("# ===== Entry D (not ranked) =====");
		expect(text).not.toContain("secret");
		expect(text).not.toContain("model");
		expect(text).not.toContain("Entry A");
	});

	it("leaves out the entries it was not given", () => {
		const text = combinedPatch(bakeoff(), new Map([["C", patches.get("C")!]]));
		expect(text).toContain("# Entries in this file: C");
		expect(text).not.toContain("Entry B");
	});
});

describe("collectPatches", () => {
	it("fetches one entry at a time in the combined order and skips the ones that cannot be exported", async () => {
		const subject = bakeoff({
			entries: [
				entry("A", {
					kind: "original",
					model: undefined,
					patch: { ok: false, reason: "This entry made no code." },
				}),
				entry("B", { patch: { ok: true } }),
				entry("C", { patch: undefined }),
			],
		});
		const asked: string[] = [];
		let active = 0;
		let overlapped = false;
		const done = await collectPatches(subject, async label => {
			active++;
			overlapped ||= active > 1;
			asked.push(label);
			await Promise.resolve();
			active--;
			return `diff for ${label}\n`;
		});
		expect(asked).toEqual(["B", "C"]);
		expect(overlapped).toBe(false);
		expect(done.included).toEqual(["B", "C"]);
		expect(done.leftOut).toEqual([{ label: "A", reason: "This entry made no code." }]);
		expect(done.patch).toContain("# ===== Entry B (rank 1, taken) =====");
		expect(done.patch).not.toContain("Entry A (");
		expect(leftOutLine(done.leftOut)).toBe("Left out: Entry A (This entry made no code.)");
	});

	it("leaves out an entry the companion refuses, with its message, and carries on", async () => {
		const done = await collectPatches(bakeoff(), async label => {
			if (label === "C") throw new Error("The patch is larger than 5 MB.");
			return `diff ${label}\n`;
		});
		expect(done.included).toEqual(["B", "A"]);
		expect(done.leftOut).toEqual([{ label: "C", reason: "The patch is larger than 5 MB." }]);
		expect(leftOutLine(done.leftOut)).toBe("Left out: Entry C (The patch is larger than 5 MB.)");
	});

	it("gives no file when nothing could be fetched", async () => {
		const done = await collectPatches(bakeoff(), async () => {
			throw new Error("no");
		});
		expect(done.patch).toBeNull();
		expect(done.included).toEqual([]);
		expect(done.leftOut.map(item => item.label)).toEqual(["B", "C", "A"]);
		expect(leftOutLine([])).toBeNull();
	});

	it("exports nothing for a design", async () => {
		let calls = 0;
		const done = await collectPatches(bakeoff({ mode: "design" }), async () => {
			calls++;
			return "x";
		});
		expect(calls).toBe(0);
		expect(done.patch).toBeNull();
		expect(done.leftOut).toEqual([]);
	});
});

describe("a folder bake-off", () => {
	const failed = (over: Partial<Bakeoff> = {}): Bakeoff =>
		bakeoff({
			stage: "review",
			entries: [entry("A", { writeup: undefined }), entry("B"), entry("C")],
			...over,
		});

	it("cannot review again, because the companion cannot read the folder a second time", () => {
		expect(canReviewAgain("failed", failed())).toBe(true);
		expect(canReviewAgain("failed", failed({ folder: true, mode: "design" }))).toBe(false);
	});

	it("cannot map or spar an entry, but a repository's entries can", () => {
		const repository = bakeoff();
		const folder = bakeoff({ mode: "design", folder: true });
		const withPath = entry("B", { path: "/work/b" });
		expect(canMapEntry(repository, withPath)).toBe(true);
		expect(canSparEntry(repository, entry("B"))).toBe(true);
		expect(canMapEntry(folder, withPath)).toBe(false);
		expect(canSparEntry(folder, entry("B"))).toBe(false);
		// a design of a repository can be sparred with but has no worktree to map
		expect(canMapEntry(bakeoff({ mode: "design" }), withPath)).toBe(false);
		expect(canSparEntry(bakeoff({ mode: "design" }), entry("B"))).toBe(true);
		// an entry that failed has nothing to map or spar with
		expect(canSparEntry(repository, entry("B", { status: "failed" }))).toBe(false);
	});
});

describe("the report needs no capability", () => {
	it("is built from the bake-off whether or not the companion can export patches", () => {
		const subject = bakeoff();
		expect(patchControls(subject, subject.entries[1]!, false).show).toBe(false);
		const report = bakeoffReport({ bakeoff: subject, excerpts: new Map() });
		expect(report).toContain("# Faster Queue — v2!");
		expect(report).toContain("Entry B (secret-prov/model-b)");
	});
});

describe("shareMarkdown", () => {
	const navigatorHeld = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	const bridgeHeld = Object.getOwnPropertyDescriptor(globalThis, "ompDesktop");

	afterEach(() => {
		if (navigatorHeld) Object.defineProperty(globalThis, "navigator", navigatorHeld);
		else delete (globalThis as Record<string, unknown>).navigator;
		if (bridgeHeld) Object.defineProperty(globalThis, "ompDesktop", bridgeHeld);
		else delete (globalThis as Record<string, unknown>).ompDesktop;
	});

	const setNavigator = (value: Record<string, unknown>): void => {
		Object.defineProperty(globalThis, "navigator", { configurable: true, value });
	};

	/** The desktop app's save dialog stands in for `<a download>`, which needs a page. */
	const desktopSaves = (): { name: string; text: string }[] => {
		const saved: { name: string; text: string }[] = [];
		Object.defineProperty(globalThis, "ompDesktop", {
			configurable: true,
			value: {
				saveFile: async (name: string, data: Uint8Array) => {
					saved.push({ name, text: new TextDecoder().decode(data) });
					return "saved";
				},
				reportSessions: () => {},
				onOpenSession: () => () => {},
			},
		});
		return saved;
	};

	it("shares the text on a desktop browser, which refuses files it says it can share", async () => {
		const shared: ShareData[] = [];
		setNavigator({
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/130",
			platform: "MacIntel",
			maxTouchPoints: 0,
			canShare: () => true,
			share: async (data: ShareData) => void shared.push(data),
		});
		expect(await shareMarkdown("Faster queue", "# Report\n", "faster-queue-bake-off.md")).toBe("shared");
		expect(shared).toEqual([{ title: "Faster queue", text: "# Report\n" }]);
	});

	it("shares the .md as a file on a phone", async () => {
		const shared: ShareData[] = [];
		setNavigator({
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
			maxTouchPoints: 5,
			canShare: () => true,
			share: async (data: ShareData) => void shared.push(data),
		});
		expect(await shareMarkdown("Faster queue", "# Report\n", "faster-queue-bake-off.md")).toBe("shared");
		expect(shared).toHaveLength(1);
		expect(shared[0]!.text).toBeUndefined();
		expect(shared[0]!.files?.[0]?.name).toBe("faster-queue-bake-off.md");
		expect(await shared[0]!.files?.[0]?.text()).toBe("# Report\n");
	});

	it("takes a dismissed share sheet for a choice, not a failure, and saves nothing", async () => {
		const saved = desktopSaves();
		setNavigator({
			userAgent: "Mozilla/5.0 (Macintosh)",
			share: async () => {
				throw new DOMException("dismissed", "AbortError");
			},
		});
		expect(await shareMarkdown("T", "text", "t.md")).toBe("cancelled");
		expect(saved).toEqual([]);
	});

	it("saves the file when the share is refused", async () => {
		const saved = desktopSaves();
		setNavigator({
			userAgent: "Mozilla/5.0 (Macintosh)",
			share: async () => {
				throw new DOMException("refused", "NotAllowedError");
			},
		});
		expect(await shareMarkdown("T", "# Report\n", "t.md")).toBe("saved");
		expect(saved).toEqual([{ name: "t.md", text: "# Report\n" }]);
	});
});
