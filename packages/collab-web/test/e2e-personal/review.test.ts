import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PersonalReviewStatus } from "@oh-my-pi/pi-wire/personal";
import type { GuestClient } from "../../src/lib/client";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { type StubRequest, type StubReply, toolResultsSince } from "../../scripts/e2e-personal-stub";
import { describeE2e, SCENARIO_TIMEOUT_MS } from "./support";

const MARKER = "nightly review of";
const USD_PER_MILLION = 10;

const localDay = (ms: number): string => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Scenario 9: the nightly review. The review runs in the companion's clock, which the test moves day by day (a skip, like a
 * run, spends the day it is for, so every case gets a day of its own); the session and the review run share that clock.
 */
describeE2e("the nightly review", () => {
	let h: PersonalHarness;
	let guest: GuestClient;

	beforeAll(async () => {
		h = await PersonalHarness.start({ usdPerMillionTokens: USD_PER_MILLION });
		// Off until a test turns it on: it is due the moment the clock passes its time, and must not run before the day has a record.
		await h.setUp("Sam, a baker.", {
			review: { enabled: false, time: "00:01", budgetUsd: 0.5 },
			limits: { dayUsd: 0, monthUsd: 0 },
		});
		await h.waitIdle();
		guest = await h.openSession();
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const today = (): string => localDay(h.clockNow());
	const reviewOf = async (): Promise<PersonalReviewStatus> => (await h.status()).review;
	const reviewRows = async (): Promise<Array<Record<string, unknown>>> => {
		const text = await Bun.file(path.join(h.profile, "personal", "reviews.jsonl")).text();
		return text
			.split("\n")
			.filter(line => line.startsWith("{"))
			.map(line => JSON.parse(line) as Record<string, unknown>);
	};

	/** A new day with something in it: the clock moves, the owner says something (the review is off meanwhile). */
	async function newDay(say: string): Promise<void> {
		await h.call({ t: "personal-settings-set", patch: { review: { enabled: false } } });
		await h.advanceToNextDay();
		await h.turn(guest, say);
		await until(
			"the day's retention",
			() => h.memoryRows("SELECT id FROM working_memory WHERE content LIKE ?", `%${say.slice(0, 20)}%`).length > 0,
			{ timeoutMs: 60_000 },
		);
	}

	/** Turn the review on and wait for the attempt for the day that is today (its record appears in `reviews.jsonl`). */
	async function review(): Promise<Record<string, unknown>> {
		const day = today();
		await h.call({ t: "personal-settings-set", patch: { review: { enabled: true } } });
		return await until(`the review of ${day}`, async () => (await reviewRows()).findLast(row => row.day === day), {
			timeoutMs: 240_000,
			everyMs: 1_000,
		});
	}

	/** Script the review run: retain a fact, propose a line, write the digest, finish. `usage` is what its first answer is billed as. */
	function scriptReview(day: string, usage?: StubReply["usage"]): void {
		const mine = (r: StubRequest, results: number): boolean =>
			r.transcript.includes(MARKER) &&
			!r.lastUser.includes("title-request") &&
			toolResultsSince(r, MARKER).length === results;
		const retain: StubReply = {
			tools: [
				{
					name: "retain",
					args: { items: [{ content: "Sam bakes sourdough every Saturday morning.", context: "nightly review" }] },
				},
			],
			usage,
		};
		h.stub.enqueue(retain, r => mine(r, 0));
		h.stub.enqueue(
			{
				tools: [
					{
						name: "notify_owner",
						args: {
							title: "Saturdays?",
							body: "You mention baking on Saturdays.",
							kind: "proposal",
							proposal: {
								op: "add",
								section: "How I like to work",
								text: "Saturday mornings are for baking.",
								rationale: "Mentioned twice this week.",
							},
						},
					},
				],
			},
			r => mine(r, 1),
		);
		h.stub.enqueue(
			{
				tools: [
					{
						name: "notify_owner",
						args: {
							title: "What I learned today",
							body: "Sam bakes sourdough every Saturday morning.",
							kind: "digest",
							digest: { day, learned: [] },
						},
					},
				],
			},
			r => mine(r, 2),
		);
		h.stub.enqueue({ text: "Review done." }, r => mine(r, 3));
	}

	it(
		"reads the day's record and the rejected list, stores a DERIVED fact, proposes a line and writes the digest",
		async () => {
			// A proposal the owner rejected earlier: its text must be in the review's prompt.
			await h.notifyOnPrompt(guest, "REVIEW-PROPOSE", {
				title: "Tabs?",
				body: "You always use tabs.",
				kind: "proposal",
				proposal: {
					op: "add",
					section: "How I like to work",
					text: "Use tabs, never spaces.",
					rationale: "Every file uses tabs.",
				},
			});
			const pending = (await h.call({ t: "personal-proposals" })).proposals.find(
				p => p.text === "Use tabs, never spaces.",
			)!;
			await h.call({ t: "personal-proposal-reject", id: pending.id });
			await h.turn(guest, "I bake sourdough bread every Saturday morning, remember that for me.");
			await until(
				"the turn's retention",
				() => h.memoryRows("SELECT id FROM working_memory WHERE content LIKE '%sourdough%'").length > 0,
				{ timeoutMs: 60_000 },
			);

			scriptReview(today());
			const costBefore = (await h.status()).spend.day.usd;
			const row = await review();
			expect(row).toMatchObject({ ok: true, day: today() });
			const request = h.stub.requests.find(r => r.transcript.includes(MARKER) && r.messages.length <= 3)!;
			expect(request.transcript).toContain(`nightly review of **${today()}**`);
			expect(request.transcript).toContain("sourdough bread every Saturday morning");
			// The list holds the normalised text: lower case, no closing punctuation.
			expect(request.transcript).toContain("use tabs, never spaces");
			expect(request.transcript).toContain("(rejected ");

			const status = await reviewOf();
			expect(status).toMatchObject({ ok: true, proposals: 1 });
			expect(status.digestId).toBeDefined();
			expect(status.costUsd).toBeGreaterThanOrEqual(0);

			const derived = h.memoryRows(
				"SELECT content, trust_tier, author_type FROM working_memory WHERE content LIKE '%every Saturday morning.%' AND trust_tier = 'DERIVED'",
			);
			expect(derived).toHaveLength(1);
			const proposals = (await h.call({ t: "personal-proposals" })).proposals.filter(p => p.status === "pending");
			expect(proposals.map(p => p.text)).toEqual(["Saturday mornings are for baking."]);
			const { digests } = await h.call({ t: "personal-digests" });
			expect(digests).toHaveLength(1);
			expect(digests[0]).toMatchObject({ day: today(), read: false });
			expect(digests[0]!.body).toContain("sourdough");
			expect((await h.status()).counts).toMatchObject({ proposals: 1, digests: 1 });
			// The headless run's spend is in the day's ledger, and the digest carries what it cost.
			expect((await h.status()).spend.day.usd).toBeGreaterThanOrEqual(costBefore);
			// Once a day: more ticks do not start a second run for the same day.
			expect((await reviewRows()).filter(r => r.day === today())).toHaveLength(1);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"stops at its budget: exit 3 is recorded as a budget stop, with no failure alert",
		async () => {
			await newDay("I also bake rye bread on Sundays, a second fact for the review.");
			await h.call({ t: "personal-settings-set", patch: { review: { budgetUsd: 0.001 } } });
			// One answer billed at $10 passes the cap of $0.001: omp stops the run at the next safe point and exits 3.
			scriptReview(today(), { promptTokens: 1_000_000, completionTokens: 0 });
			const alertsBefore = (await h.call({ t: "personal-inbox", includeDone: true })).items.filter(
				item => item.title === "Nightly review failed",
			).length;
			const row = await review();
			expect(row).toMatchObject({ ok: false, error: "budget" });
			const status = await reviewOf();
			expect(status).toMatchObject({ ok: false, error: "budget" });
			expect(status.skipped).toBeUndefined();
			expect(
				(await h.call({ t: "personal-inbox", includeDone: true })).items.filter(
					item => item.title === "Nightly review failed",
				),
			).toHaveLength(alertsBefore);
			h.stub.reset();
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"skips with a reason: spend limit, no login, nothing new",
		async () => {
			// The spend limit: a day that has a record but is at its limit.
			await h.call({ t: "personal-settings-set", patch: { review: { budgetUsd: 0.5 } } });
			await newDay("On Mondays I deliver bread to the school, a third fact.");
			await h.call({ t: "personal-settings-set", patch: { limits: { dayUsd: 0.0001 } } });
			await until("the day to be capped", async () => (await h.status()).spend.day.level === "capped", {
				timeoutMs: 60_000,
				everyMs: 500,
			});
			expect(await review()).toMatchObject({ ok: false, skipped: "spend-limit" });
			expect(await reviewOf()).toMatchObject({ skipped: "spend-limit" });

			// No login: the profile's models.yml is gone.
			await h.call({ t: "personal-settings-set", patch: { limits: { dayUsd: 0 } } });
			await h.call({ t: "personal-settings-set", patch: { review: { enabled: false } } });
			await h.advanceToNextDay();
			const models = path.join(h.agentDir, "models.yml");
			const saved = await Bun.file(models).text();
			await fs.rm(models);
			await until("the login to read as missing", async () => (await h.status()).login.state === "missing", {
				timeoutMs: 60_000,
				everyMs: 500,
			});
			expect(await review()).toMatchObject({ ok: false, skipped: "no-login" });
			await Bun.write(models, saved);
			await until("the login to be back", async () => (await h.status()).login.state === "ready", {
				timeoutMs: 60_000,
				everyMs: 500,
			});

			// Nothing new: a day with no record.
			await h.call({ t: "personal-settings-set", patch: { review: { enabled: false } } });
			await h.advanceToNextDay();
			expect(await review()).toMatchObject({ ok: false, skipped: "nothing-new" });
			expect((await reviewOf()).skipped).toBe("nothing-new");
		},
		SCENARIO_TIMEOUT_MS,
	);
});
