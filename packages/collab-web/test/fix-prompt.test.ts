import { describe, expect, it } from "bun:test";
import { fixPrompt } from "../src/lib/fix-prompt";

const pr = { title: "Add widgets", url: "https://github.com/acme/app/pull/7", branch: "widgets" };
const base = { number: 7, pr, moreFailures: 0, sessionBranch: "widgets" };

describe("fixPrompt", () => {
	it("names the pull request, fences each log, and ends with the instruction", () => {
		const text = fixPrompt({
			...base,
			failures: [
				{ check: "CI / lint", url: "https://github.com/acme/app/actions/runs/1/job/2", log: "error: unused" },
				{ check: "codecov/patch", url: "", log: "" },
			],
		});
		expect(text).toContain("Checks failed on pull request #7: Add widgets");
		expect(text).toContain("CI / lint (https://github.com/acme/app/actions/runs/1/job/2)\n```\nerror: unused\n```");
		expect(text).toContain("codecov/patch\n(no log available; see the link)");
		expect(text.endsWith("Fix the failing checks on widgets; run the failing tests locally before pushing.")).toBe(
			true,
		);
	});

	it("fences a log that itself contains code fences with a longer fence", () => {
		const text = fixPrompt({ ...base, failures: [{ check: "t", url: "", log: "```ts\nx\n```" }] });
		expect(text).toContain("````\n```ts\nx\n```\n````");
	});

	it("tells the agent to check out the branch unless the session is already on it", () => {
		const failures = [{ check: "t", url: "", log: "boom" }];
		expect(fixPrompt({ ...base, failures })).not.toContain("Check out");
		expect(fixPrompt({ ...base, failures, sessionBranch: "main" })).toContain(
			"Check out widgets first (this session is on main), for example with `gh pr checkout 7`.",
		);
		expect(fixPrompt({ ...base, failures, sessionBranch: null })).toContain("Check out widgets first, for example");
	});

	it("says how many failing checks were left out", () => {
		const failures = [{ check: "t", url: "", log: "boom" }];
		expect(fixPrompt({ ...base, failures, moreFailures: 1 })).toContain("1 more failing check is not shown.");
		expect(fixPrompt({ ...base, failures, moreFailures: 3 })).toContain("3 more failing checks are not shown.");
	});
});
