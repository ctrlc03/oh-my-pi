import { afterAll, beforeAll, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GuestClient } from "../../src/lib/client";
import { PersonalHarness, until } from "../../scripts/e2e-personal-harness";
import { describeE2e, realTime, SCENARIO_TIMEOUT_MS } from "./support";

/** $10 per million tokens, so 85,000 tokens cost $0.85. */
const USD_PER_MILLION = 10;

/** Scenario 8: the day limit caps the session, tells the owner at 80% and 100%, leaves events queued, and lifts with the next window. */
describeE2e("the spend limit", () => {
	let h: PersonalHarness;
	let guest: GuestClient;

	beforeAll(async () => {
		h = await PersonalHarness.start({ usdPerMillionTokens: USD_PER_MILLION });
		await h.setUp(undefined, { limits: { dayUsd: 1, monthUsd: 0 } });
		await h.waitIdle();
		guest = await h.openSession();
	}, SCENARIO_TIMEOUT_MS);

	afterAll(async () => {
		await h?.stop();
	});

	const alerts = async (): Promise<string[]> =>
		(await h.call({ t: "personal-inbox", includeDone: true })).items
			.filter(item => item.kind === "alert")
			.map(item => item.title);

	/** A turn that the stub bills as `tokens` prompt tokens. */
	async function spend(marker: string, tokens: number): Promise<void> {
		// `transcript`, not `lastUser`: from the second turn on the last user message is the hidden recall notice.
		h.stub.enqueue(
			{ text: "Done.", usage: { promptTokens: tokens, completionTokens: 0 } },
			r => r.transcript.includes(marker) && !r.lastUser.includes("title-request"),
		);
		await h.turn(guest, marker);
	}

	it(
		"warns the owner once at 80%",
		async () => {
			expect((await h.status()).spend.day).toMatchObject({ limitUsd: 1, level: "ok" });
			const pushes = h.pushes.length;
			await spend("SPEND-ONE", 85_000);
			await until("the day to read as a warning", async () => (await h.status()).spend.day.level === "warning", {
				timeoutMs: 30_000,
				everyMs: 500,
			});
			const day = (await h.status()).spend.day;
			expect(day.usd).toBeGreaterThanOrEqual(0.85);
			expect(day.usd).toBeLessThan(1);
			await until("the warning alert", async () => (await alerts()).some(title => /spend at 80%/.test(title)), {
				timeoutMs: 30_000,
			});
			await until("the push", () => h.pushes.length > pushes, { timeoutMs: 20_000 });
			expect(await alerts()).toHaveLength(1);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"caps at 100%: alerts once more, refuses a prompt with the notice, and leaves an event queued",
		async () => {
			await spend("SPEND-TWO", 20_000);
			await until("the day to be capped", async () => (await h.status()).spend.day.level === "capped", {
				timeoutMs: 30_000,
				everyMs: 500,
			}).catch(async err => {
				const ledger = await Bun.file(path.join(h.agentDir, "spend-ledger.jsonl")).text();
				throw new Error(`${String(err)}; day ${JSON.stringify((await h.status()).spend.day)}; ledger ${ledger}`);
			});
			await until("the cap alert", async () => (await alerts()).some(title => /spend limit reached/.test(title)), {
				timeoutMs: 30_000,
			});
			expect(await alerts()).toHaveLength(2);

			const before = h.stub.requests.at(-1)?.n ?? 0;
			guest.sendPrompt("SPEND-REFUSED please do something");
			// The host answers a refused prompt with an error frame, which the app shows as a notice.
			await until(
				"the session to refuse the prompt",
				() => guest.getSnapshot().notices.some(n => /prompt failed.*spend limit reached/i.test(n.message)),
				{ timeoutMs: 30_000 },
			);
			expect(h.stub.requests.filter(r => r.n > before && r.transcript.includes("SPEND-REFUSED"))).toEqual([]);

			const posted = await h.postEvent({
				source: "script",
				id: "queued-1",
				title: "Queued",
				body: "QUEUED-WHILE-CAPPED",
			});
			expect(posted.status).toBe(200);
			// The session reads its inbox only while it may spend: the file stays where it is and nothing reaches the model.
			await realTime(8_000);
			expect((await fs.readdir(h.inboxDir)).length).toBeGreaterThanOrEqual(1);
			expect(h.stub.requests.filter(r => r.n > before && r.transcript.includes("QUEUED-WHILE-CAPPED"))).toEqual([]);
			expect(await alerts()).toHaveLength(2);
		},
		SCENARIO_TIMEOUT_MS,
	);

	it(
		"lifts the cap when the next window starts, and delivers what was queued",
		async () => {
			const before = h.stub.requests.at(-1)?.n ?? 0;
			await h.advanceToNextDay();
			await until("the new day to read as ok", async () => (await h.status()).spend.day.level === "ok", {
				timeoutMs: 60_000,
				everyMs: 500,
			});
			expect((await h.status()).spend.day.usd).toBe(0);
			const delivered = await h.stub
				.waitForRequest(r => r.transcript.includes("QUEUED-WHILE-CAPPED") && r.n > before, {
					after: before,
					timeoutMs: 120_000,
				})
				.catch(async err => {
					const { events } = await h.call({ t: "personal-events" });
					throw new Error(
						`${String(err)}; inbox ${JSON.stringify(await fs.readdir(h.inboxDir))}; events ${JSON.stringify(events)}; status ${JSON.stringify((await h.status()).spend)}`,
					);
				});
			expect(delivered.transcript).toContain("<<<UNTRUSTED");
			await h.settle(guest);
			// And a prompt is taken again.
			await h.turn(guest, "SPEND-AFTER-WINDOW hello again");
			// A new window starts the alerts over: nothing new yet, the old ones stay in the inbox.
			expect(await alerts()).toHaveLength(2);
		},
		SCENARIO_TIMEOUT_MS,
	);
});
