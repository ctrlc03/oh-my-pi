import { describe, expect, it } from "bun:test";
import type { PrAlertSettings } from "../src/lib/companion";
import {
	createPrWatch,
	PR_IDLE_CHECK_MS,
	PR_PENDING_CHECK_MS,
	type PrAlert,
	type PrChecks,
	type PrSnapshot,
	type PrWatchState,
	parsePrs,
	pushTopic,
} from "../scripts/companion-prwatch";

const T0 = Date.UTC(2026, 9, 10, 9);
const iso = (ms: number): string => new Date(ms).toISOString();

function pr(over: Partial<PrSnapshot> & { checks?: PrChecks } = {}): PrSnapshot {
	return {
		repo: "acme/app",
		number: 7,
		title: "Add widgets",
		url: "https://github.com/acme/app/pull/7",
		author: "me",
		checks: "pass",
		failing: null,
		reviews: [],
		comments: [],
		...over,
	};
}

function harness(opts: { settings?: PrAlertSettings; state?: PrWatchState; wanted?: boolean } = {}) {
	let now = T0;
	let state: PrWatchState = opts.state ?? {};
	let settings = opts.settings ?? { checks: true, reviews: true };
	let prs: Record<string, PrSnapshot[] | Error> = { "/repo": [pr()] };
	let roots = ["/repo"];
	const alerts: PrAlert[] = [];
	const log: string[] = [];
	const errors: unknown[] = [];
	let reads = 0;
	const watch = createPrWatch({
		now: () => now,
		state: () => state,
		settings: () => settings,
		save: async next => {
			log.push("save");
			state = next;
		},
		wanted: () => opts.wanted ?? true,
		listRepos: async () => roots,
		readPrs: async root => {
			reads++;
			const found = prs[root];
			if (found instanceof Error) throw found;
			return found ?? [];
		},
		alert: alert => {
			log.push("alert");
			alerts.push(alert);
		},
		onError: err => errors.push(err),
	});
	return {
		watch,
		alerts,
		log,
		errors,
		reads: () => reads,
		state: () => state,
		advance: (ms: number) => {
			now += ms;
		},
		show: (root: string, next: PrSnapshot[] | Error) => {
			prs = { ...prs, [root]: next };
		},
		setRoots: (next: string[]) => {
			roots = next;
		},
		setSettings: (next: PrAlertSettings) => {
			settings = next;
		},
	};
}

describe("createPrWatch alerts", () => {
	it("only records a pull request on first sight, even one with finished checks, reviews and comments", async () => {
		const h = harness();
		h.show("/repo", [
			pr({
				checks: "fail",
				failing: "ci / test",
				reviews: [{ author: "rev", state: "APPROVED", at: T0 - 1000 }],
				comments: [{ author: "rev", body: "nit", at: T0 - 500 }],
			}),
		]);
		await h.watch.tick();
		expect(h.alerts).toEqual([]);
		expect(Object.keys(h.state())).toEqual(["acme/app#7"]);
	});

	it("alerts once when pending checks pass", async () => {
		const h = harness();
		h.show("/repo", [pr({ checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [pr({ checks: "pass" })]);
		await h.watch.tick();
		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]).toMatchObject({
			title: "acme/app#7 Add widgets",
			body: "Checks passed",
			url: "https://github.com/acme/app/pull/7",
		});
		h.advance(PR_IDLE_CHECK_MS);
		await h.watch.tick();
		expect(h.alerts).toHaveLength(1);
	});

	it("names the first failing check when pending checks fail", async () => {
		const h = harness();
		h.show("/repo", [pr({ checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [pr({ checks: "fail", failing: "ci / lint" })]);
		await h.watch.tick();
		expect(h.alerts.map(a => a.body)).toEqual(["Checks failed: ci / lint"]);
	});

	it("does not alert when checks were already finished before the poll", async () => {
		const h = harness();
		await h.watch.tick();
		h.advance(PR_IDLE_CHECK_MS);
		h.show("/repo", [pr({ checks: "fail", failing: "ci" })]);
		await h.watch.tick();
		expect(h.alerts).toEqual([]);
	});

	it("alerts on new reviews and comments from others, never on the author's own", async () => {
		const h = harness();
		await h.watch.tick();
		h.advance(PR_IDLE_CHECK_MS);
		h.show("/repo", [
			pr({
				reviews: [
					{ author: "alice", state: "CHANGES_REQUESTED", at: T0 + 1000 },
					{ author: "me", state: "COMMENTED", at: T0 + 1500 },
					{ author: "bob", state: "COMMENTED", at: T0 + 2000 },
				],
				comments: [
					{ author: "me", body: "pushed a fix", at: T0 + 2500 },
					{ author: "carol", body: "\n\nLooks good!\nsecond line", at: T0 + 3000 },
				],
			}),
		]);
		await h.watch.tick();
		expect(h.alerts.map(a => a.body)).toEqual([
			"alice requested changes",
			"bob reviewed",
			"carol commented: Looks good!",
		]);
		h.advance(PR_IDLE_CHECK_MS);
		await h.watch.tick();
		expect(h.alerts).toHaveLength(3);
	});

	it("reports an approval as approved", async () => {
		const h = harness();
		await h.watch.tick();
		h.advance(PR_IDLE_CHECK_MS);
		h.show("/repo", [pr({ reviews: [{ author: "alice", state: "APPROVED", at: T0 + 1 }] })]);
		await h.watch.tick();
		expect(h.alerts.map(a => a.body)).toEqual(["alice approved"]);
	});

	it("keeps a distinct tag and a valid Web Push topic per pull request and kind", async () => {
		const h = harness();
		h.show("/repo", [
			pr({ repo: "a-very-long-organisation-name/an-equally-long-repository-name", checks: "pending" }),
		]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [
			pr({
				repo: "a-very-long-organisation-name/an-equally-long-repository-name",
				checks: "pass",
				reviews: [{ author: "alice", state: "APPROVED", at: T0 + 1 }],
			}),
		]);
		await h.watch.tick();
		expect(h.alerts).toHaveLength(2);
		expect(new Set(h.alerts.map(a => a.tag)).size).toBe(2);
		for (const alert of h.alerts) expect(alert.topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
		expect(pushTopic("pr:x#1:checks")).toBe(pushTopic("pr:x#1:checks"));
		expect(pushTopic("pr:x#1:checks")).not.toBe(pushTopic("pr:x#2:checks"));
	});

	it("truncates long titles", async () => {
		const h = harness();
		h.show("/repo", [pr({ title: "x".repeat(300), checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [pr({ title: "x".repeat(300), checks: "pass" })]);
		await h.watch.tick();
		expect(h.alerts[0]?.title.length).toBeLessThanOrEqual(80);
		expect(h.alerts[0]?.title.startsWith("acme/app#7 xxx")).toBe(true);
	});
});

describe("createPrWatch settings", () => {
	it("suppresses the disabled kind but not the other, and does not replay it when re-enabled", async () => {
		const h = harness({ settings: { checks: false, reviews: true } });
		h.show("/repo", [pr({ checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [pr({ checks: "pass", comments: [{ author: "carol", body: "hi", at: T0 + 5 }] })]);
		await h.watch.tick();
		expect(h.alerts.map(a => a.body)).toEqual(["carol commented: hi"]);

		h.setSettings({ checks: true, reviews: false });
		h.advance(PR_IDLE_CHECK_MS);
		h.show("/repo", [
			pr({
				checks: "pass",
				comments: [
					{ author: "carol", body: "hi", at: T0 + 5 },
					{ author: "dan", body: "yo", at: T0 + 9 },
				],
			}),
		]);
		await h.watch.tick();
		h.setSettings({ checks: true, reviews: true });
		h.advance(PR_IDLE_CHECK_MS);
		await h.watch.tick();
		expect(h.alerts).toHaveLength(1);
	});

	it("does not read GitHub at all when both kinds are off", async () => {
		const h = harness({ settings: { checks: false, reviews: false } });
		await h.watch.tick();
		await h.watch.tick(true);
		expect(h.reads()).toBe(0);
	});
});

describe("createPrWatch throttle", () => {
	it("polls every five minutes while nothing is pending", async () => {
		const h = harness();
		await h.watch.tick();
		expect(h.reads()).toBe(1);
		h.advance(PR_IDLE_CHECK_MS - 1);
		await h.watch.tick();
		expect(h.reads()).toBe(1);
		h.advance(1);
		await h.watch.tick();
		expect(h.reads()).toBe(2);
	});

	it("polls every two minutes while a pull request has pending checks", async () => {
		const h = harness();
		h.show("/repo", [pr({ checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS - 1);
		await h.watch.tick();
		expect(h.reads()).toBe(1);
		h.advance(1);
		await h.watch.tick();
		expect(h.reads()).toBe(2);
	});

	it("returns to the slow interval once nothing is pending", async () => {
		const h = harness();
		h.show("/repo", [pr({ checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [pr({ checks: "pass" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		await h.watch.tick();
		expect(h.reads()).toBe(2);
	});

	it("polls immediately when forced", async () => {
		const h = harness();
		await h.watch.tick();
		await h.watch.tick(true);
		expect(h.reads()).toBe(2);
	});

	it("skips, and retries on the next tick, while nobody can receive or gh is unavailable", async () => {
		let wanted = false;
		let reads = 0;
		const watch = createPrWatch({
			now: () => T0,
			state: () => ({}),
			settings: () => ({ checks: true, reviews: true }),
			save: async () => {},
			wanted: async () => wanted,
			listRepos: async () => ["/repo"],
			readPrs: async () => {
				reads++;
				return [];
			},
			alert: () => {},
			onError: () => {},
		});
		await watch.tick();
		expect(reads).toBe(0);
		wanted = true;
		await watch.tick();
		expect(reads).toBe(1);
	});
});

describe("createPrWatch state", () => {
	it("forgets pull requests that are no longer open", async () => {
		const h = harness();
		h.show("/repo", [pr(), pr({ number: 8 })]);
		await h.watch.tick();
		expect(Object.keys(h.state()).sort()).toEqual(["acme/app#7", "acme/app#8"]);
		h.advance(PR_IDLE_CHECK_MS);
		h.show("/repo", [pr()]);
		await h.watch.tick();
		expect(Object.keys(h.state())).toEqual(["acme/app#7"]);
	});

	it("keeps what it knew when a repository cannot be read", async () => {
		const h = harness();
		await h.watch.tick();
		h.advance(PR_IDLE_CHECK_MS);
		h.show("/repo", new Error("rate limited"));
		await h.watch.tick();
		expect(h.errors).toHaveLength(1);
		expect(Object.keys(h.state())).toEqual(["acme/app#7"]);
	});

	it("keeps what it knew when no session has a repository", async () => {
		const h = harness();
		await h.watch.tick();
		h.advance(PR_IDLE_CHECK_MS);
		h.setRoots([]);
		await h.watch.tick();
		expect(Object.keys(h.state())).toEqual(["acme/app#7"]);
	});

	it("merges a pull request seen from two checkouts of the same repository", async () => {
		const h = harness();
		h.setRoots(["/repo", "/repo-worktree"]);
		h.show("/repo-worktree", [pr()]);
		await h.watch.tick();
		expect(Object.keys(h.state())).toEqual(["acme/app#7"]);
	});

	it("saves before it pushes, and does not push when saving fails", async () => {
		const h = harness();
		h.show("/repo", [pr({ checks: "pending" })]);
		await h.watch.tick();
		h.advance(PR_PENDING_CHECK_MS);
		h.show("/repo", [pr({ checks: "pass" })]);
		await h.watch.tick();
		expect(h.log).toEqual(["save", "save", "alert"]);

		const pushed: PrAlert[] = [];
		const failing = createPrWatch({
			now: () => T0,
			state: () => ({ "acme/app#7": { checks: "pending", reviewAt: 0, commentAt: 0 } }),
			settings: () => ({ checks: true, reviews: true }),
			save: async () => {
				throw new Error("disk full");
			},
			wanted: () => true,
			listRepos: async () => ["/repo"],
			readPrs: async () => [pr({ checks: "pass" })],
			alert: alert => pushed.push(alert),
			onError: () => {},
		});
		await failing.tick();
		expect(pushed).toEqual([]);
	});

	it("does not save when nothing changed", async () => {
		const h = harness();
		await h.watch.tick();
		h.advance(PR_IDLE_CHECK_MS);
		await h.watch.tick();
		expect(h.log).toEqual(["save"]);
	});
});

describe("parsePrs", () => {
	it("reads gh output: repository from the URL, rollup, first failing check, review and comment times", () => {
		const [parsed] = parsePrs([
			{
				number: 12,
				title: "Fix it",
				url: "https://github.com/acme/app/pull/12",
				author: { login: "me" },
				statusCheckRollup: [
					{ name: "build", workflowName: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
					{ name: "test", workflowName: "ci", status: "COMPLETED", conclusion: "FAILURE" },
					{ name: "lint", workflowName: "ci", status: "IN_PROGRESS" },
				],
				latestReviews: [{ author: { login: "alice" }, state: "APPROVED", submittedAt: iso(T0) }],
				comments: [{ author: null, body: "hi", createdAt: iso(T0 + 1) }],
			},
		]);
		expect(parsed).toMatchObject({
			repo: "acme/app",
			number: 12,
			author: "me",
			checks: "fail",
			failing: "ci / test",
			reviews: [{ author: "alice", state: "APPROVED", at: T0 }],
			comments: [{ author: "ghost", body: "hi", at: T0 + 1 }],
		});
	});

	it("drops entries it cannot identify and tolerates garbage", () => {
		expect(parsePrs({})).toEqual([]);
		expect(parsePrs([{ number: 1, url: "not a url" }, { url: "https://github.com/a/b/pull/2" }])).toEqual([]);
	});
});
