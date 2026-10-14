import { describe, expect, it } from "bun:test";
import {
	detectStack,
	MAX_STACK,
	orderStack,
	parseStackLines,
	type PrSource,
	type StackPr,
} from "../scripts/companion-quiz-stack";

const placeholderBodies = (await Bun.file(
	new URL("./fixtures/quiz/stack-placeholder-bodies.json", import.meta.url),
).json()) as Record<string, string>;
const pr6Body = await Bun.file(new URL("./fixtures/quiz/stack-pr6-body.md", import.meta.url)).text();

function pr(number: number, head: string, base: string, extra: Partial<StackPr> = {}): StackPr {
	return { number, title: `PR ${number}`, head, base, ...extra };
}

/** A fake repository: every lookup is answered from `prs`. */
function fakeSource(prs: readonly StackPr[], failing: readonly number[] = []): PrSource & { views: number[] } {
	const views: number[] = [];
	return {
		views,
		async view(number) {
			views.push(number);
			if (failing.includes(number)) throw new Error("rate limited");
			return prs.find(item => item.number === number) ?? null;
		},
		async byHead(branch) {
			return prs.filter(item => item.head === branch);
		},
		async byBase(branch) {
			return prs.filter(item => item.base === branch);
		},
	};
}

function chain(length: number, first = 1): StackPr[] {
	return Array.from({ length }, (_, i) => pr(first + i, `b${first + i}`, i === 0 ? "main" : `b${first + i - 1}`));
}

const numbers = (stack: readonly { number: number }[]) => stack.map(item => item.number);

describe("parseStackLines", () => {
	it("reads references after a stack word on the same line, separated by arrows or commas", () => {
		expect(parseStackLines("Stack: #1 → #2 → #3")).toEqual([1, 2, 3]);
		expect(parseStackLines("PR stack: #1 > #2 > #3")).toEqual([1, 2, 3]);
		expect(parseStackLines("Part of a stack: #4, #5 and #6")).toEqual([4, 5, 6]);
		expect(parseStackLines("Stacked on #12")).toEqual([12]);
	});

	it("reads a list under a stack heading, also after a blank line", () => {
		const body = "## Stack\n\n- #10 first\n- #11 second\n* **#12** ◀\n1. https://github.com/o/r/pull/13\n";
		expect(parseStackLines(body)).toEqual([10, 11, 12, 13]);
		expect(
			parseStackLines("## Stack\n- [#7](https://github.com/o/r/pull/7)\n- [#8](https://github.com/o/r/pull/8)"),
		).toEqual([7, 8]);
	});

	it("reads a Sapling footer", () => {
		const body = [
			"Do the thing.",
			"",
			"---",
			"[//]: # (BEGIN SAPLING FOOTER)",
			"Stack created with [Sapling](https://sapling-scm.com). Best reviewed with [ReviewStack](https://reviewstack.dev/o/r/pull/5).",
			"* #6",
			"* __->__ #5",
			"* #4",
		].join("\n");
		expect(parseStackLines(body)).toEqual([6, 5, 4]);
	});

	it("reads a Graphite footer that lists the stack above or below its sentence", () => {
		const above =
			"Body\n\n---\n* **#31** 👈\n* **#30**\n* `main`\n\nThis stack of pull requests is managed by [Graphite](https://graphite.dev).";
		expect(parseStackLines(above)).toEqual([31, 30]);
		const below = "Body\n\nThis stack of pull requests is managed by Graphite.\n\n* #21\n* #20\n";
		expect(parseStackLines(below)).toEqual([21, 20]);
	});

	it("reads the real arrow list of a stack and maps 'this PR' to the PR itself", () => {
		expect(parseStackLines(pr6Body, 2249)).toEqual([2243, 2244, 2245, 2241, 2248, 2249]);
		expect(parseStackLines(pr6Body)).toEqual([2243, 2244, 2245, 2241, 2248]);
	});

	it("ignores references outside a stack section and a template that was never filled in", () => {
		expect(parseStackLines("Fixes #12\n\nSee #13 for background.")).toEqual([]);
		expect(parseStackLines("Fixes #12\n\n## Stack\n\n- #20\n- #21\n\nCloses #99")).toEqual([20, 21]);
		expect(parseStackLines("Stack: {stack}\n\n## Checklist\n\n- #5 done")).toEqual([]);
		expect(parseStackLines(placeholderBodies.p1 ?? "")).toEqual([]);
		expect(parseStackLines(placeholderBodies.p4 ?? "")).toEqual([]);
		expect(parseStackLines("Stack 2/5\n\nStack #2 of 5 (fixes #45)")).toEqual([]);
	});

	it("ignores code fences and html comments", () => {
		expect(parseStackLines("<!-- Stack: #1 #2 -->\n```\nStack: #3 #4\n```\n")).toEqual([]);
	});

	it("keeps the first occurrence of a repeated reference and stops at a heading", () => {
		expect(parseStackLines("## Stack\n- #1\n- #2 and #1\n- #3\n## Next\n- #4")).toEqual([1, 2, 3]);
	});

	it("picks the section that names the most pull requests", () => {
		const body = "Stacked on #9\n\n## Stack\n- #1\n- #2\n- #9\n";
		expect(parseStackLines(body)).toEqual([1, 2, 9]);
	});
});

describe("orderStack", () => {
	it("puts a PR after the one whose head is its base, whatever the given order", () => {
		const ordered = orderStack([pr(3, "c", "b"), pr(1, "a", "main"), pr(2, "b", "a")]);
		expect(numbers(ordered)).toEqual([1, 2, 3]);
	});

	it("keeps the given order of PRs that are not chained and drops duplicates", () => {
		const ordered = orderStack([pr(5, "x", "main"), pr(2, "y", "main"), pr(5, "x", "main")]);
		expect(numbers(ordered)).toEqual([5, 2]);
	});

	it("does not throw on a cycle and keeps every PR", () => {
		const ordered = orderStack([pr(1, "a", "b"), pr(2, "b", "a"), pr(3, "c", "b")]);
		expect(numbers(ordered).sort()).toEqual([1, 2, 3]);
		expect(numbers(orderStack([pr(1, "a", "a")]))).toEqual([1]);
	});

	it("caps at the most parts a quiz has", () => {
		expect(orderStack(chain(12))).toHaveLength(MAX_STACK);
		expect(MAX_STACK).toBe(8);
	});
});

describe("detectStack by branches", () => {
	const prs = chain(5);

	it("walks down and up from the middle", async () => {
		const result = await detectStack(3, fakeSource(prs));
		expect(result.source).toBe("branches");
		expect(numbers(result.stack)).toEqual([1, 2, 3, 4, 5]);
	});

	it("walks down from the top and up from the bottom", async () => {
		expect(numbers((await detectStack(5, fakeSource(prs))).stack)).toEqual([1, 2, 3, 4, 5]);
		expect(numbers((await detectStack(1, fakeSource(prs))).stack)).toEqual([1, 2, 3, 4, 5]);
	});

	it("maps to the wire shape without the body", async () => {
		const source = fakeSource([pr(1, "a", "main", { url: "https://x/pull/1", body: "text" }), pr(2, "b", "a")]);
		const { stack } = await detectStack(2, source);
		expect(stack[0]).toEqual({ number: 1, title: "PR 1", head: "a", base: "main", url: "https://x/pull/1" });
		expect(stack[1]).toEqual({ number: 2, title: "PR 2", head: "b", base: "a" });
	});

	it("stops at the default branch, whatever its name", async () => {
		const prs = [pr(1, "a", "develop"), pr(2, "b", "a"), pr(3, "develop", "release")];
		expect(numbers((await detectStack(2, fakeSource(prs), { defaultBranch: "develop" })).stack)).toEqual([1, 2]);
		expect(numbers((await detectStack(2, fakeSource(prs))).stack)).toEqual([3, 1, 2]);
	});

	it("ends a chain with a gap at the gap", async () => {
		const gapped = [pr(1, "a", "main"), pr(2, "b", "a"), pr(4, "d", "c"), pr(5, "e", "d")];
		expect(numbers((await detectStack(2, fakeSource(gapped))).stack)).toEqual([1, 2]);
		expect(numbers((await detectStack(4, fakeSource(gapped))).stack)).toEqual([4, 5]);
	});

	it("stops on a cycle", async () => {
		const cyclic = [pr(1, "a", "b"), pr(2, "b", "c"), pr(3, "c", "a")];
		const result = await detectStack(1, fakeSource(cyclic));
		expect(result.source).toBe("branches");
		expect(numbers(result.stack).sort()).toEqual([1, 2, 3]);
	});

	it("takes the lowest number when two PRs sit on the same base", async () => {
		const forked = [pr(1, "a", "main"), pr(3, "c", "a"), pr(2, "b", "a"), pr(4, "d", "b")];
		expect(numbers((await detectStack(1, fakeSource(forked))).stack)).toEqual([1, 2, 4]);
		expect(numbers((await detectStack(4, fakeSource(forked))).stack)).toEqual([1, 2, 4]);
	});

	it("takes the lowest number when two PRs share a head", async () => {
		const shared = [pr(7, "a", "main"), pr(6, "a", "main"), pr(8, "b", "a")];
		expect(numbers((await detectStack(8, fakeSource(shared))).stack)).toEqual([6, 8]);
	});

	it("caps a long stack and keeps the seed in the window", async () => {
		const long = chain(12);
		const fromBottom = await detectStack(2, fakeSource(long));
		expect(numbers(fromBottom.stack)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		const fromTop = await detectStack(12, fakeSource(long));
		expect(numbers(fromTop.stack)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
		expect(numbers((await detectStack(9, fakeSource(long))).stack)).toContain(9);
		expect((await detectStack(9, fakeSource(long))).stack).toHaveLength(MAX_STACK);
	});

	it("shortens the chain when a lookup fails", async () => {
		const source: PrSource = {
			...fakeSource(prs),
			async byBase() {
				throw new Error("offline");
			},
		};
		expect(numbers((await detectStack(3, source)).stack)).toEqual([1, 2, 3]);
	});
});

describe("detectStack by body", () => {
	const listing = (list: string) => `Summary\n\n## Stack\n\n${list}\n\n## Checklist\n- [x] done`;

	it("resolves the listed PRs and orders them by their branches", async () => {
		// Branch walking finds nothing for these (the bases point at branches no open PR has), so the body decides.
		const prs = [
			pr(10, "feat-a", "main"),
			pr(11, "feat-b", "feat-a"),
			pr(12, "feat-c", "feat-b", { body: listing("- #12 ◀\n- #11\n- #10") }),
		];
		const noBranches: PrSource = { ...fakeSource(prs), byHead: async () => [], byBase: async () => [] };
		const result = await detectStack(12, noBranches);
		expect(result.source).toBe("body");
		expect(numbers(result.stack)).toEqual([10, 11, 12]);
	});

	it("keeps the listed order for PRs that are not chained and appends the seed when it is not listed", async () => {
		const prs = [pr(1, "x", "main"), pr(2, "y", "main"), pr(3, "z", "main", { body: "Stacked on #1, #2" })];
		const noBranches: PrSource = { ...fakeSource(prs), byHead: async () => [], byBase: async () => [] };
		const result = await detectStack(3, noBranches);
		expect(result.source).toBe("body");
		expect(numbers(result.stack)).toEqual([1, 2, 3]);
	});

	it("skips listed PRs that do not resolve", async () => {
		const prs = [pr(1, "x", "main"), pr(3, "z", "main", { body: listing("- #1\n- #2\n- #3\n- #4") })];
		const source = fakeSource(prs, [4]);
		const noBranches: PrSource = { ...source, byHead: async () => [], byBase: async () => [] };
		expect(numbers((await detectStack(3, noBranches)).stack)).toEqual([1, 3]);
	});

	it("is none when the listed PRs do not resolve", async () => {
		const prs = [pr(3, "z", "main", { body: listing("- #1\n- #3") })];
		const result = await detectStack(3, fakeSource(prs));
		expect(result.source).toBe("none");
		expect(numbers(result.stack)).toEqual([3]);
	});

	it("caps the listed stack and keeps the seed", async () => {
		const prs = chain(11).map(item => ({ ...item, base: "elsewhere" }));
		const seed = { ...prs[10], body: listing(prs.map(item => `- #${item.number}`).join("\n")) } as StackPr;
		const source: PrSource = {
			...fakeSource([...prs.slice(0, 10), seed]),
			byHead: async () => [],
			byBase: async () => [],
		};
		const result = await detectStack(11, source);
		expect(result.stack).toHaveLength(MAX_STACK);
		expect(numbers(result.stack)).toContain(11);
	});

	it("ignores a Fixes reference", async () => {
		const prs = [pr(1, "x", "main"), pr(2, "y", "main", { body: "Fixes #1" })];
		const noBranches: PrSource = { ...fakeSource(prs), byHead: async () => [], byBase: async () => [] };
		expect((await detectStack(2, noBranches)).source).toBe("none");
	});

	it("prefers the branch chain to the body", async () => {
		const prs = [pr(1, "a", "main"), pr(2, "b", "a", { body: "Stack: #2 → #7" })];
		const source = fakeSource(prs);
		expect((await detectStack(2, source)).source).toBe("branches");
		expect(source.views).toEqual([2]);
	});
});

describe("detectStack alone", () => {
	it("is none for a PR that is not stacked", async () => {
		const result = await detectStack(9, fakeSource([pr(9, "solo", "main", { body: "Just a change." })]));
		expect(result).toEqual({ stack: [{ number: 9, title: "PR 9", head: "solo", base: "main" }], source: "none" });
	});

	it("throws with the reason when the seed cannot be read", async () => {
		await expect(detectStack(9, fakeSource([], [9]))).rejects.toThrow("Could not read pull request #9: rate limited");
		await expect(detectStack(9, fakeSource([]))).rejects.toThrow("Could not read pull request #9");
	});
});
